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
   * Sube un archivo a Google Drive usando Resumable Upload (Streams)
   * EVITA OOM (Out Of Memory) al no cargar el dump (500+ MB) en memoria RAM.
   */
  private static async uploadToDriveStream(
    filePath: string,
    fileName: string,
    mimeType: string = "application/octet-stream"
  ): Promise<{ id: string; name: string }> {
    const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
    if (!folderId) {
      throw new Error("Falta la variable de entorno GOOGLE_DRIVE_FOLDER_ID");
    }

    const stats = fs.statSync(filePath);
    const fileSize = stats.size;
    const accessToken = await this.getAccessToken();

    // Paso 1: Iniciar sesión de Resumable Upload con los metadatos JSON
    const metadata = JSON.stringify({
      name: fileName,
      parents: [folderId],
    });

    const sessionUrl = await new Promise<string>((resolve, reject) => {
      const req = https.request(
        "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json; charset=UTF-8",
            "X-Upload-Content-Type": mimeType,
            "X-Upload-Content-Length": fileSize.toString(),
          },
        },
        (res) => {
          if (res.statusCode === 200 && res.headers.location) {
            resolve(res.headers.location);
          } else {
            let resBody = "";
            res.on("data", (chunk) => (resBody += chunk));
            res.on("end", () => {
              reject(new Error(`Error iniciando subida resumable (${res.statusCode}): ${resBody}`));
            });
          }
        }
      );

      req.on("error", reject);
      req.write(metadata);
      req.end();
    });

    // Paso 2: Pipe streaming del archivo directamente desde disco hacia la sesión de Google Drive
    return new Promise((resolve, reject) => {
      const uploadReq = https.request(
        sessionUrl,
        {
          method: "PUT",
          headers: {
            "Content-Length": fileSize.toString(),
            "Content-Type": mimeType,
          },
        },
        (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => {
            try {
              const result = JSON.parse(body);
              if (result.id) {
                resolve(result);
              } else {
                reject(new Error(`Error en subida de archivo (${res.statusCode}): ${body}`));
              }
            } catch (e) {
              reject(e);
            }
          });
        }
      );

      uploadReq.on("error", reject);

      const fileStream = fs.createReadStream(filePath);
      fileStream.on("error", reject);
      fileStream.pipe(uploadReq);
    });
  }

  /**
   * Ejecuta pg_dump asegurando conectividad IPv4 para Render (usando Session Pooler puerto 5432)
   */
  private static runPgDump(outputPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // Priorizar DATABASE_URL (que usa el host IPv4 pooler de Supabase) sobre DIRECT_URL (que es solo IPv6)
      const rawUrl = process.env.DATABASE_URL || process.env.DIRECT_URL;
      if (!rawUrl) {
        return reject(new Error("Ni DATABASE_URL ni DIRECT_URL están configuradas"));
      }

      try {
        const parsedUrl = new URL(rawUrl);

        // Si la URL apunta al puerto de Transaction Pooler (6543), cambiar al puerto 5432 (Session Pooler)
        if (parsedUrl.port === "6543") {
          parsedUrl.port = "5432";
        }

        // Si la URL apunta a db.ref.supabase.co (solo IPv6), cambiar al pooler IPv4
        if (parsedUrl.hostname.startsWith("db.") && parsedUrl.hostname.endsWith(".supabase.co")) {
          const projectRef = parsedUrl.hostname.split(".")[1];
          parsedUrl.hostname = "aws-1-us-east-1.pooler.supabase.com";
          if (!parsedUrl.username.includes(".")) {
            parsedUrl.username = `postgres.${projectRef}`;
          }
        }

        // Remover parámetros incompatibles como pgbouncer=true, connection_limit, etc.
        parsedUrl.search = "?sslmode=require";

        const cleanUrl = parsedUrl.toString();
        const cmd = `pg_dump -Fc "${cleanUrl}" -f "${outputPath}"`;

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
      } catch (err: any) {
        reject(err);
      }
    });
  }

  /**
   * Ejecuta el proceso completo de respaldo a Google Drive usando Streams para RAM cero extra
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

      // Subida por Streams (Resumable Upload) ➔ Consumo de RAM < 10 MB
      const driveFile = await this.uploadToDriveStream(tempPath, fileName);

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
