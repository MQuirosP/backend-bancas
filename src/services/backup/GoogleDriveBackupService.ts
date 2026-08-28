import https from "https";
import fs from "fs";
import path from "path";
import { exec } from "child_process";
import logger from "../../core/logger";
import { getRedisClient, isRedisAvailable } from "../../core/redisClient";

export interface BackupResult {
  fileId: string;
  fileName: string;
  sizeBytes: number;
  uploadedAt: string;
}

const BACKUP_LOCK_KEY = "backup:google_drive:lock";
const LOCK_TTL_SECONDS = 900; // 15 minutos máximo de bloqueo

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
   * Sube un archivo a Google Drive mediante Chunked Multipart Streaming
   * EVITA OOM (RAM < 1 MB) y funciona con el scope estándar de Google Drive API.
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

    const accessToken = await this.getAccessToken();
    const boundary = "------WebKitFormBoundary" + Math.random().toString(36).substring(2);

    const metadata = JSON.stringify({
      name: fileName,
      parents: [folderId],
    });

    const header = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`;
    const footer = `\r\n--${boundary}--`;

    return new Promise((resolve, reject) => {
      const req = https.request(
        "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": `multipart/related; boundary=${boundary}`,
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
                reject(new Error(`Error en subida de Google Drive (${res.statusCode}): ${body}`));
              }
            } catch (e) {
              reject(e);
            }
          });
        }
      );

      req.on("error", reject);

      req.write(header);

      const fileStream = fs.createReadStream(filePath);
      fileStream.on("data", (chunk) => {
        req.write(chunk);
      });

      fileStream.on("end", () => {
        req.end(footer);
      });

      fileStream.on("error", (err) => {
        req.destroy();
        reject(err);
      });
    });
  }

  /**
   * Ejecuta pg_dump con prioridad de CPU baja (nice -n 19 en Linux) y compresión veloz (-Z 1)
   */
  private static runPgDump(outputPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const rawUrl = process.env.DATABASE_URL || process.env.DIRECT_URL;
      if (!rawUrl) {
        return reject(new Error("Ni DATABASE_URL ni DIRECT_URL están configuradas"));
      }

      try {
        const parsedUrl = new URL(rawUrl);

        if (parsedUrl.port === "6543") {
          parsedUrl.port = "5432";
        }

        if (parsedUrl.hostname.startsWith("db.") && parsedUrl.hostname.endsWith(".supabase.co")) {
          const projectRef = parsedUrl.hostname.split(".")[1];
          parsedUrl.hostname = "aws-1-us-east-1.pooler.supabase.com";
          if (!parsedUrl.username.includes(".")) {
            parsedUrl.username = `postgres.${projectRef}`;
          }
        }

        parsedUrl.search = "?sslmode=require";

        const cleanUrl = parsedUrl.toString();
        const baseCmd = `pg_dump -Fc -Z 1 "${cleanUrl}" -f "${outputPath}"`;
        // 🔥 En Linux/Render asignar prioridad mínima de CPU ('nice -n 19') para no impactar el tráfico web
        const cmd = process.platform === "win32" ? baseCmd : `nice -n 19 ${baseCmd}`;

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
   * Adquiere un cerrojo distribuido en Redis (Redlock) para evitar ejecuciones concurrentes en instancias autoscaladas
   */
  private static async acquireLock(): Promise<boolean> {
    if (!isRedisAvailable()) return true; // Si Redis no está disponible, proceder con precaución
    const redis = getRedisClient();
    if (!redis) return true;

    try {
      // SET key value EX 900 NX
      const result = await redis.set(BACKUP_LOCK_KEY, "locked", "EX", LOCK_TTL_SECONDS, "NX");
      return result === "OK";
    } catch {
      return true;
    }
  }

  /**
   * Libera el cerrojo distribuido en Redis
   */
  private static async releaseLock(): Promise<void> {
    if (!isRedisAvailable()) return;
    const redis = getRedisClient();
    if (!redis) return;

    try {
      await redis.del(BACKUP_LOCK_KEY);
    } catch {
      // Ignorar error al liberar lock
    }
  }

  /**
   * Ejecuta el proceso completo de respaldo a Google Drive con cerrojo distribuido en Redis
   */
  public static async executeBackup(): Promise<BackupResult> {
    const lockAcquired = await this.acquireLock();
    if (!lockAcquired) {
      logger.warn({
        layer: "service",
        action: "GOOGLE_DRIVE_BACKUP_LOCK_SKIPPED",
        payload: { message: "Un respaldo a Google Drive ya está en curso en otra instancia. Omitiendo." },
      });
      throw new Error("Un respaldo de base de datos ya está en ejecución en otra instancia.");
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const fileName = `supabase_prod_${timestamp}.dump`;
    const tempPath = path.join(process.cwd(), "tmp", fileName);

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
      await this.releaseLock();
    }
  }
}
