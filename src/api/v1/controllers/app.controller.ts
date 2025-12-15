/**
 * Controlador para auto-actualización de APK
 * Endpoints para versión y descarga de la aplicación móvil Android
 */

import { Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import logger from '../../../core/logger';

/**
 * GET /api/v1/app/version
 * Retorna información de la versión más reciente de la APK
 */
export const getVersionInfo = async (req: Request, res: Response): Promise<void> => {
  try {
    const latestPath = path.join(process.cwd(), 'public/latest.json');

    if (!fs.existsSync(latestPath)) {
      res.status(500).json({
        success: false,
        message: 'latest.json no encontrado'
      });
      return;
    }

    const latest = JSON.parse(fs.readFileSync(latestPath, 'utf-8'));

    res.json({
      success: true,
      data: {
        version: latest.versionName,
        versionCode: latest.versionCode,
        buildNumber: latest.buildNumber,
        downloadUrl: latest.apkUrl,
        changelog: latest.changelog,
        releasedAt: latest.releasedAt,
        minSupportedVersion: latest.minSupportedVersion,
        forceUpdate: latest.forceUpdate
      }
    });

    logger.info({
      layer: 'controller',
      action: 'VERSION_INFO_SENT',
      payload: {
        version: latest.versionName,
        versionCode: latest.versionCode
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error al obtener versión'
    });
  }
};


/**
 * GET /api/v1/app/download
 * Descarga directa del archivo APK más reciente
 */
export const downloadApk = async (req: Request, res: Response): Promise<void> => {
  try {
    logger.info({
      layer: 'controller',
      action: 'DOWNLOAD_APK_REQUESTED',
      payload: { ip: req.ip, userAgent: req.get('user-agent') }
    });

    const apkPath = path.join(process.cwd(), 'public/apk/app-release-latest.apk');


    // Verificar que el archivo existe
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

    // Configurar headers para descarga
    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    res.setHeader('Content-Disposition', 'attachment; filename="bancas-admin.apk"');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    // Enviar archivo
    res.download(apkPath, 'bancas-admin.apk', (err) => {
      if (err) {
        logger.error({
          layer: 'controller',
          action: 'DOWNLOAD_ERROR',
          payload: {
            error: err.message,
            stack: err.stack
          }
        });

        // Solo enviar respuesta si no se han enviado headers
        if (!res.headersSent) {
          res.status(500).json({
            success: false,
            message: 'Error al descargar APK'
          });
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
      payload: {
        error: (error as Error).message,
        stack: (error as Error).stack
      }
    });

    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        message: 'Error al procesar descarga'
      });
    }
  }
};
