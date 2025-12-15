/**
 * Controlador para auto-actualización de APK
 * Endpoints para versión y descarga de la aplicación móvil Android
 */

import { Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import logger from '../../../core/logger';

export const getVersionInfo = async (req: Request, res: Response): Promise<void> => {
  try {
    const latestPath = path.join(process.cwd(), 'public', 'latest.json');

    if (!fs.existsSync(latestPath)) {
      logger.error({
        layer: 'controller',
        action: 'LATEST_JSON_NOT_FOUND',
        payload: { path: latestPath }
      });

      res.status(500).json({
        success: false,
        message: 'latest.json no encontrado'
      });
      return;
    }

    const latest = JSON.parse(fs.readFileSync(latestPath, 'utf-8'));

    // Calcula tamaño dinámico del APK
    const apkPath = path.join(process.cwd(), 'public', 'apk', 'app-release-latest.apk');
    let apkSizeMB: number | null = null;
    if (fs.existsSync(apkPath)) {
      const stats = fs.statSync(apkPath);
      apkSizeMB = +(stats.size / (1024 * 1024)).toFixed(2); // MB con 2 decimales
    }

    res.json({
      success: true,
      data: {
        version: latest.versionName,
        versionCode: latest.versionCode,
        buildNumber: latest.buildNumber,
        downloadUrl: '/api/v1/app/download', // siempre el endpoint de descarga
        apkSizeMB, // dinámico, evita NaN
        changelog: latest.changelog,
        releasedAt: latest.releasedAt,
        minSupportedVersion: latest.minSupportedVersion,
        forceUpdate: latest.forceUpdate,
        sha256: latest.sha256 || null
      }
    });

    logger.info({
      layer: 'controller',
      action: 'VERSION_INFO_SENT',
      payload: {
        version: latest.versionName,
        versionCode: latest.versionCode,
        apkSizeMB
      }
    });

  } catch (error) {
    logger.error({
      layer: 'controller',
      action: 'GET_VERSION_ERROR',
      payload: { error: (error as Error).message, stack: (error as Error).stack }
    });

    res.status(500).json({
      success: false,
      message: 'Error al obtener versión'
    });
  }
};

export const downloadApk = async (req: Request, res: Response): Promise<void> => {
  try {
    const apkPath = path.join(process.cwd(), 'public', 'apk', 'app-release-latest.apk');

    if (!fs.existsSync(apkPath)) {
      logger.error({
        layer: 'controller',
        action: 'APK_NOT_FOUND',
        payload: { path: apkPath }
      });

      res.status(404).json({
        success: false,
        message: 'APK no encontrada. Por favor contacta al administrador.'
      });
      return;
    }

    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    res.setHeader('Content-Disposition', 'attachment; filename="bancas-admin.apk"');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    res.download(apkPath, 'bancas-admin.apk', (err) => {
      if (err) {
        logger.error({
          layer: 'controller',
          action: 'DOWNLOAD_ERROR',
          payload: { error: err.message, stack: err.stack }
        });
        if (!res.headersSent) {
          res.status(500).json({ success: false, message: 'Error al descargar APK' });
        }
      } else {
        logger.info({
          layer: 'controller',
          action: 'APK_DOWNLOADED_SUCCESS',
          payload: { ip: req.ip }
        });
      }
    });

  } catch (error) {
    logger.error({
      layer: 'controller',
      action: 'DOWNLOAD_APK_ERROR',
      payload: { error: (error as Error).message, stack: (error as Error).stack }
    });
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: 'Error al procesar descarga' });
    }
  }
};
