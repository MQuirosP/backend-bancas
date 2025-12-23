/**
 * Controlador para auto-actualización de APK
 * Endpoints para versión y descarga de la aplicación móvil Android
 */

import { Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
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
    // ✅ MEJORADO: Calcular ruta desde __dirname para ser más robusto
    // __dirname apunta a dist/api/v1/controllers/ en producción
    // Necesitamos subir 4 niveles para llegar a la raíz del proyecto
    const projectRoot = path.join(__dirname, '../../../../');
    const latestPath = path.join(projectRoot, 'public', 'latest.json');
    const apkPath = path.join(projectRoot, 'public', 'apk', 'app-release-latest.apk');

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


    // ✅ MEJORADO: buildNumber como número con fallback a versionCode
    // Previene errores si buildNumber es null/undefined y mantiene consistencia
    const buildNumber = latest.buildNumber ?? latest.versionCode ?? 0

    res.json({
      success: true,
      data: {
        version: latest.versionName,
        versionCode: latest.versionCode,
        buildNumber: buildNumber, // ← Número, no string (más consistente con versionCode)
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
 * Parsea el header Range de HTTP
 * Ejemplo: "bytes=0-1023" -> { start: 0, end: 1023 }
 */
const parseRange = (range: string, fileSize: number): { start: number; end: number } | null => {
  const match = range.match(/bytes=(\d+)-(\d*)/);
  if (!match) return null;

  const start = parseInt(match[1], 10);
  const end = match[2] ? parseInt(match[2], 10) : fileSize - 1;

  if (start < 0 || start >= fileSize || end < start || end >= fileSize) {
    return null;
  }

  return { start, end };
};

/**
 * GET /api/v1/app/download
 * Descarga directa del archivo APK más reciente usando streaming
 * ✅ OPTIMIZADO: Usa streams para evitar cargar 77MB en memoria
 * ✅ MEJORADO: Soporte para Range requests (HTTP 206) para descargas resumibles y más rápidas
 */
export const downloadApk = async (req: Request, res: Response): Promise<void> => {
  try {
    // ✅ MEJORADO: Calcular ruta desde __dirname para ser más robusto
    const projectRoot = path.join(__dirname, '../../../../');
    const apkPath = path.join(projectRoot, 'public', 'apk', 'app-release-latest.apk');

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
    const fileSize = stats.size;
    const etag = cachedApkMetadata?.sha256 ? `"${cachedApkMetadata.sha256}"` : null;

    // Headers base
    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    
    // ✅ CRÍTICO: Establecer Content-Disposition ANTES de otros headers para evitar sobrescritura
    // ✅ FIX: Nombre del archivo debe ser exactamente 'app-release-latest.apk'
    const filename = 'app-release-latest.apk';
    const contentDisposition = `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
    
    // ✅ CRÍTICO: Usar writeHead o setHeader múltiples veces para asegurar que se establece
    res.setHeader('Content-Disposition', contentDisposition);
    
    // ✅ FORZAR: Establecer de nuevo después de otros headers para asegurar que no se sobrescribe
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('X-No-Compression', '1'); // Evita compresión adicional (APK ya está comprimido)
    
    // ✅ MEJORADO: Cache-Control con no-cache para forzar validación cuando cambia el nombre
    // Usar no-cache en lugar de immutable para permitir validación del nuevo nombre
    res.setHeader('Cache-Control', 'public, max-age=86400, must-revalidate'); // 24 horas, pero validar cambios
    res.setHeader('X-Content-Type-Options', 'nosniff');
    
    // ✅ FORZAR: Establecer Content-Disposition de nuevo después de todos los headers
    res.setHeader('Content-Disposition', contentDisposition);
    
    // ✅ VERIFICACIÓN: Confirmar que el header se estableció correctamente
    const actualHeader = res.getHeader('Content-Disposition');
    
    // ✅ DEBUG: Log del header que se está enviando (siempre, no solo en debug)
    logger.info({
      layer: 'controller',
      action: 'APK_DOWNLOAD_HEADERS',
      payload: {
        filename,
        contentDisposition,
        actualHeader,
        headersMatch: actualHeader === contentDisposition,
        headersSent: res.headersSent,
        ip: req.ip,
      },
    });
    
    // ✅ WARNING: Si el header no coincide, loguear advertencia
    if (actualHeader !== contentDisposition) {
      logger.warn({
        layer: 'controller',
        action: 'APK_DOWNLOAD_HEADER_MISMATCH',
        payload: {
          expected: contentDisposition,
          actual: actualHeader,
          message: 'Content-Disposition header no coincide con el esperado',
        },
      });
    }

    // ETag para validación de caché
    // ✅ MEJORADO: Incluir nombre del archivo en el ETag para invalidar caché cuando cambia el nombre
    if (etag) {
      // Agregar hash del nombre del archivo al ETag para forzar actualización cuando cambia
      const filenameHash = crypto.createHash('md5').update('app-release-latest.apk').digest('hex').substring(0, 8);
      const enhancedEtag = `${etag}-${filenameHash}`;
      res.setHeader('ETag', enhancedEtag);
      
      // Si el cliente tiene el mismo ETag, retornar 304 Not Modified
      const ifNoneMatch = req.headers['if-none-match'];
      if (ifNoneMatch === enhancedEtag || ifNoneMatch === etag) {
        res.status(304).end();
        return;
      }
    }

    // ✅ NUEVO: Soporte para Range requests (HTTP 206 Partial Content)
    // Permite descargas resumibles y mejor rendimiento en conexiones lentas
    const rangeHeader = req.headers.range;
    
    if (rangeHeader) {
      const range = parseRange(rangeHeader, fileSize);
      
      if (range) {
        const { start, end } = range;
        const chunkSize = end - start + 1;

        res.status(206); // Partial Content
        res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
        res.setHeader('Content-Length', chunkSize.toString());

        // ✅ STREAMING OPTIMIZADO: Buffer más grande para mejor rendimiento
        const stream = fs.createReadStream(apkPath, {
          start,
          end,
          highWaterMark: 256 * 1024 // 256KB chunks (mejor para conexiones rápidas)
        });

        stream.on('error', (err) => {
          logger.error({
            layer: 'controller',
            action: 'STREAM_ERROR',
            payload: {
              error: err.message,
              stack: err.stack,
              path: apkPath,
              range: `${start}-${end}`
            }
          });

          if (!res.headersSent) {
            res.status(500).json({
              success: false,
              message: 'Error al descargar APK'
            });
          }
        });

        req.on('close', () => {
          if (!stream.destroyed) {
            stream.destroy();
          }
        });

        stream.pipe(res);
        return;
      } else {
        // Range inválido, retornar 416 Range Not Satisfiable
        res.status(416);
        res.setHeader('Content-Range', `bytes */${fileSize}`);
        res.end();
        return;
      }
    }

    // Descarga completa (sin Range request)
    res.setHeader('Content-Length', fileSize.toString());

    // ✅ STREAMING OPTIMIZADO: Buffer más grande (256KB vs 64KB) para mejor rendimiento
    // En conexiones rápidas, chunks más grandes reducen overhead de red
    const stream = fs.createReadStream(apkPath, {
      highWaterMark: 256 * 1024 // 256KB chunks (4x más grande que antes)
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
            fileSize: fileSize,
            fileSizeMB: (fileSize / (1024 * 1024)).toFixed(2),
            hasRange: !!rangeHeader
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
