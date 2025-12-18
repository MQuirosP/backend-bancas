/**
 * Controlador para auto-actualización de APK
 * Endpoints para versión y descarga de la aplicación móvil Android
 */

import { Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import logger from '../../../core/logger';

/**
 * Caché en memoria para metadatos del APK
 * Se invalida automáticamente cuando el archivo cambia (por mtime)
 */
let cachedApkMetadata: {
  size: number;
  sha256: string;
  mtime: number;
} | null = null;

/**
 * Caché en memoria para latest.json
 * ✅ FIX CRÍTICO: Evita fs.readFileSync en cada request → reduce GC pressure
 * Se invalida automáticamente cuando el archivo cambia (por mtime)
 */
let cachedLatest: any | null = null;
let cachedLatestMtime = 0;

/**
 * GET /api/v1/app/version
 * Retorna información de la versión más reciente de la APK
 */
export const getVersionInfo = async (req: Request, res: Response): Promise<void> => {
  try {
    const latestPath = path.join(process.cwd(), 'public', 'latest.json');
    const apkPath = path.join(process.cwd(), 'public', 'apk', 'app-release-latest.apk');

    // ✅ FIX: Cachear latest.json en memoria - solo recargar si cambió
    // Evita fs.readFileSync + JSON.parse en cada request → reduce GC pressure
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

    const statsJson = fs.statSync(latestPath);

    // Solo recargar si el archivo cambió (o primera vez)
    if (!cachedLatest || cachedLatestMtime !== statsJson.mtimeMs) {
      cachedLatest = JSON.parse(fs.readFileSync(latestPath, 'utf-8'));
      cachedLatestMtime = statsJson.mtimeMs;

      logger.debug({
        layer: 'controller',
        action: 'LATEST_JSON_CACHED',
        payload: { version: cachedLatest.versionName }
      });
    }

    const latest = cachedLatest;

    // Obtener metadatos del APK de forma optimizada
    let fileSize: number | null = null;
    let sha256: string | null = null;

    if (fs.existsSync(apkPath)) {
      const stats = fs.statSync(apkPath);

      // Si el archivo no ha cambiado desde la última consulta, usar caché
      if (cachedApkMetadata && cachedApkMetadata.mtime === stats.mtimeMs) {
        fileSize = cachedApkMetadata.size;
        sha256 = cachedApkMetadata.sha256;
      } else {
        // Archivo cambió o primera vez: usar datos de latest.json (ya tiene SHA256 pre-calculado)
        fileSize = stats.size;
        sha256 = latest.sha256 || null; // Usar SHA256 pre-calculado del JSON

        // Actualizar caché en memoria
        if (sha256) {
          cachedApkMetadata = {
            size: fileSize,
            sha256: sha256,
            mtime: stats.mtimeMs
          };
        }
      }
    }


    res.json({
      success: true,
      data: {
        version: latest.versionName,
        versionCode: latest.versionCode,
        buildNumber: latest.buildNumber.toString(),
        downloadUrl: latest.apkUrl || `${req.protocol}://${req.get('host')}/public/apk/app-release-latest.apk`,
        fileSize, // en bytes
        changelog: latest.changelog,
        releasedAt: latest.releasedAt,
        minSupportedVersion: latest.minSupportedVersion,
        forceUpdate: latest.forceUpdate,
        sha256
      }
    })


    logger.info({
      layer: 'controller',
      action: 'VERSION_INFO_SENT',
      payload: {
        version: latest.versionName,
        versionCode: latest.versionCode,
        fileSize,
        sha256
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

/**
 * GET /api/v1/app/download
 * Descarga directa del archivo APK más reciente usando streaming
 * ✅ OPTIMIZADO: Usa streams para evitar cargar 77MB en memoria
 */
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

    // Obtener tamaño del archivo para Content-Length
    const stats = fs.statSync(apkPath);

    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    res.setHeader('Content-Disposition', 'attachment; filename="bancas-admin.apk"');
    res.setHeader('Content-Length', stats.size.toString());
    res.setHeader('Accept-Ranges', 'bytes');

    // Optimizaciones de descarga:
    // - X-No-Compression: evita que middlewares compriman el APK (ya está comprimido)
    // - Cache-Control: permite cache del cliente por 24h para evitar re-descargas innecesarias
    // - ETag: permite validación de cache usando el SHA256
    res.setHeader('X-No-Compression', '1');
    res.setHeader('Cache-Control', 'public, max-age=86400'); // 24 horas

    // Usar SHA256 del caché si está disponible para ETag
    if (cachedApkMetadata?.sha256) {
      res.setHeader('ETag', `"${cachedApkMetadata.sha256}"`);
    }

    // ✅ STREAMING: Solo usa ~64KB de RAM por descarga (vs 77MB con res.download)
    const stream = fs.createReadStream(apkPath, {
      highWaterMark: 64 * 1024 // 64KB chunks (óptimo para red)
    });

    // Manejar errores del stream
    stream.on('error', (err) => {
      logger.error({
        layer: 'controller',
        action: 'STREAM_ERROR',
        payload: {
          error: err.message,
          stack: err.stack,
          path: apkPath
        }
      });

      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          message: 'Error al descargar APK'
        });
      }
    });

    // ✅ FIX: NO loguear cada descarga en producción → reduce memory pressure
    // En producción cada log = objeto en memoria → con múltiples descargas = OOM
    // Solo loguear en development o usar sampling (1 de cada 100)
    stream.on('end', () => {
      if (process.env.NODE_ENV !== 'production') {
        logger.info({
          layer: 'controller',
          action: 'APK_DOWNLOADED_SUCCESS',
          payload: {
            ip: req.ip,
            fileSize: stats.size,
            fileSizeMB: (stats.size / (1024 * 1024)).toFixed(2)
          }
        });
      }
    });

    // Manejar cancelación de descarga por parte del cliente
    req.on('close', () => {
      if (!stream.destroyed) {
        stream.destroy();
        logger.warn({
          layer: 'controller',
          action: 'DOWNLOAD_CANCELLED',
          payload: {
            ip: req.ip,
            reason: 'Client disconnected'
          }
        });
      }
    });

    // Pipe el stream a la response
    stream.pipe(res);

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
