import https from "https";
import fs from "fs";
import path from "path";
import { exec } from "child_process";
import logger from "../../core/logger";

export interface BackupResult {
  fileId: string;
  fileName: string;
  sizeBytes: number;
  uploadedAt: string;
}

export class GoogleDriveBackupService {
  /**
   * Obtiene un access_token fresco usando las variables de entorno de Google OAuth
   */
  private static async getAccessToken(): Promise<string> {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

    if (!clientId || !clientSecret || !refreshToken) {
      throw new Error(
        "Faltan variables de entorno para Google OAuth (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN)"
      );
    }

    const postData = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }).toString();

    return new Promise((resolve, reject) => {
      const req = https.request(
        "https://oauth2.googleapis.com/token",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "Content-Length": Buffer.byteLength(postData),
          },
        },
        (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => {
            try {
              const data = JSON.parse(body);
              if (data.access_token) {
                resolve(data.access_token);
              } else {
                reject(new Error("Error obteniendo access_token: " + body));
              }
            } catch (e) {
              reject(e);
            }
          });
        }
      );
      req.on("error", reject);
      req.write(postData);
      req.end();
    });
  }

  /**
   * Sube un buffer a la carpeta de Google Drive indicada en process.env.GOOGLE_DRIVE_FOLDER_ID
   */
  private static async uploadToDrive(
    fileName: string,
    fileBuffer: Buffer,
    mimeType: string = "application/octet-stream"
  ): Promise<{ id: string; name: string }> {
    const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
    if (!folderId) {
      throw new Error("Falta la variable de entorno GOOGLE_DRIVE_FOLDER_ID");
    }

    const accessToken = await this.getAccessToken();
    const boundary = "------WebKitFormBoundary" + Math.random().toString(36).substring(2);

    const metadata = JSON.stringify({
      name: fileName,
      parents: [folderId],
    });

    const delimiter = "\r\n--" + boundary + "\r\n";
    const closeDelimiter = "\r\n--" + boundary + "--";

    let body = "";
    body += delimiter + "Content-Type: application/json; charset=UTF-8\r\n\r\n" + metadata;
    body += delimiter + `Content-Type: ${mimeType}\r\n\r\n`;

    const payload = Buffer.concat([
      Buffer.from(body, "utf8"),
      fileBuffer,
      Buffer.from(closeDelimiter, "utf8"),
    ]);

    return new Promise((resolve, reject) => {
      const req = https.request(
        "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": `multipart/related; boundary=${boundary}`,
            "Content-Length": payload.length,
          },
        },
        (res) => {
          let resBody = "";
          res.on("data", (chunk) => (resBody += chunk));
          res.on("end", () => {
            try {
              const result = JSON.parse(resBody);
              if (result.id) {
                resolve(result);
              } else {
                reject(new Error("Error al subir a Google Drive: " + resBody));
              }
            } catch (e) {
              reject(e);
            }
          });
        }
      );
      req.on("error", reject);
      req.write(payload);
      req.end();
    });
  }

  /**
   * Ejecuta pg_dump y genera un archivo de respaldo en formato comprimido (.dump)
   */
  private static runPgDump(outputPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const dbUrl = process.env.DATABASE_URL;
      if (!dbUrl) {
        return reject(new Error("DATABASE_URL no está definida"));
      }

      // Eliminar parámetros query para evitar problemas de compatibilidad en pg_dump
      const cleanUrl = dbUrl.replace(/\?.*$/, "");
      const cmd = `pg_dump -Fc "${cleanUrl}?sslmode=require" -f "${outputPath}"`;

      exec(cmd, (error, _stdout, stderr) => {
        if (error) {
          logger.error({
            layer: "service",
            action: "PG_DUMP_ERROR",
            meta: { stderr, error: error.message },
          });
          return reject(error);
        }
        resolve();
      });
    });
  }

  /**
   * Ejecuta el proceso completo de respaldo a Google Drive
   */
  public static async executeBackup(): Promise<BackupResult> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const fileName = `supabase_prod_${timestamp}.dump`;
    const tempPath = path.join(process.cwd(), "tmp", fileName);

    // Asegurar directorio temporal
    const tmpDir = path.dirname(tempPath);
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }

    try {
      logger.info({
        layer: "service",
        action: "GOOGLE_DRIVE_BACKUP_INIT",
        payload: { fileName },
      });
      await this.runPgDump(tempPath);

      const stats = fs.statSync(tempPath);
      logger.info({
        layer: "service",
        action: "PG_DUMP_COMPLETE",
        payload: { fileName, sizeMB: (stats.size / 1024 / 1024).toFixed(2) },
      });

      const fileBuffer = fs.readFileSync(tempPath);
      const driveFile = await this.uploadToDrive(fileName, fileBuffer);

      logger.info({
        layer: "service",
        action: "GOOGLE_DRIVE_UPLOAD_COMPLETE",
        payload: { fileId: driveFile.id, fileName: driveFile.name },
      });

      return {
        fileId: driveFile.id,
        fileName: driveFile.name,
        sizeBytes: stats.size,
        uploadedAt: new Date().toISOString(),
      };
    } finally {
      if (fs.existsSync(tempPath)) {
        try {
          fs.unlinkSync(tempPath);
        } catch (e) {
          // Ignorar error al eliminar temporal
        }
      }
    }
  }
}
