import { Request, Response } from "express";
import { GoogleDriveBackupService } from "../../../services/backup/GoogleDriveBackupService";
import logger from "../../../core/logger";

export async function triggerGoogleDriveBackup(
  _req: Request,
  res: Response
): Promise<void> {
  // Responder inmediatamente al cliente HTTP (202 Accepted) para evitar HTTP Timeouts en Render (15s/20s)
  res.status(202).json({
    status: "success",
    message: "Proceso de respaldo a Google Drive iniciado en segundo plano.",
    timestamp: new Date().toISOString(),
  });

  // Ejecutar el respaldo de forma asíncrona en segundo plano
  GoogleDriveBackupService.executeBackup().catch((error) => {
    logger.error({
      layer: "controller",
      action: "ADMIN_TRIGGER_BACKUP_ERROR",
      meta: { error: error instanceof Error ? error.message : String(error) },
    });
  });
}
