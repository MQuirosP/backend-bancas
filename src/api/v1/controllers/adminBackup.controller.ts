import { Request, Response, NextFunction } from "express";
import { GoogleDriveBackupService } from "../../../services/backup/GoogleDriveBackupService";

export async function triggerGoogleDriveBackup(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const result = await GoogleDriveBackupService.executeBackup();
    res.status(200).json({
      status: "success",
      message: "Respaldo generado y subido a Google Drive exitosamente",
      data: result,
    });
  } catch (error) {
    next(error);
  }
}
