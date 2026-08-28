import dotenv from "dotenv";
dotenv.config();

import { GoogleDriveBackupService } from "../services/backup/GoogleDriveBackupService";

async function run() {
  try {
    console.log("Iniciando proceso de respaldo automático a Google Drive...");
    const result = await GoogleDriveBackupService.executeBackup();
    console.log("==================================================");
    console.log("✅ ¡RESPALDO COMPLETO Y EXITOSO EN GOOGLE DRIVE!");
    console.log("ID en Drive:", result.fileId);
    console.log("Archivo:", result.fileName);
    console.log("Tamaño:", (result.sizeBytes / 1024 / 1024).toFixed(2), "MB");
    console.log("Fecha:", result.uploadedAt);
    console.log("==================================================");
    process.exit(0);
  } catch (error) {
    console.error("❌ ERROR CRÍTICO EN EL RESPALDO A GOOGLE DRIVE:", error);
    process.exit(1);
  }
}

run();
