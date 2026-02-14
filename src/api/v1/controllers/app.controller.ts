/**
 * Controlador para auto-actualización de APK
 * Endpoints para versión y descarga de la aplicación móvil Android
 * Soporta builds duales por ABI: armeabi-v7a (gama baja/Sunmi) y arm64-v8a (gama media/alta)
 */

import { Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import logger from '../../../core/logger';

const VALID_ABIS = ['armeabi-v7a', 'arm64-v8a'] as const;
type Abi = typeof VALID_ABIS[number];
const DEFAULT_ABI: Abi = 'armeabi-v7a';

/** Mapea ABI al nombre del archivo APK en public/apk/ */
const getApkFilename = (abi: Abi): string => `app-${abi}-release.apk`;

/** Valida y normaliza el query param ?abi= */
const resolveAbi = (abiParam: string | undefined): Abi => {
  if (abiParam && VALID_ABIS.includes(abiParam as Abi)) {
    return abiParam as Abi;
  }
  return DEFAULT_ABI;
};

/**
 * Caché en memoria para metadatos de APKs por ABI
 * Se invalida automáticamente cuando el archivo cambia (por mtime)
 */
const cachedApkMetadata: Record<string, {
  size: number;
  sha256: string;
  mtime: number;
}> = {};

/**
 * GET /api/v1/app/version?abi=arm64-v8a
 * Retorna información de la versión más reciente de la APK
 * El query param ?abi= determina qué sha256 y fileSize retornar
 */
export const getVersionInfo = async (req: Request, res: Response): Promise<void> => {
  try {
    const projectRoot = path.join(__dirname, '../../../../');
    const latestPath = path.join(projectRoot, 'public', 'latest.json');
    const abi = resolveAbi(req.query.abi as string);
    const apkPath = path.join(projectRoot, 'public', 'apk', getApkFilename(abi));

    if (!fs.existsSync(latestPath)) {
      logger.error({
        layer: 'controller',
        action: 'LATEST_JSON_NOT_FOUND',
        payload: { path: latestPath }
      });
      res.status(500).json({ success: false, message: 'latest.json no encontrado' });
      return;
    }

    const latest = JSON.parse(fs.readFileSync(latestPath, 'utf-8'));

    // Obtener metadatos del APK para el ABI solicitado
    let fileSize: number | null = null;
    let sha256: string | null = null;

    if (fs.existsSync(apkPath)) {
      const stats = fs.statSync(apkPath);
      const cached = cachedApkMetadata[abi];

      if (cached && cached.mtime === stats.mtimeMs) {
        fileSize = cached.size;
        sha256 = cached.sha256;
      } else {
        fileSize = stats.size;
        // SHA256 por ABI desde latest.json, fallback al campo global
        sha256 = latest.downloads?.[abi]?.sha256 || latest.sha256 || null;

        if (sha256) {
          cachedApkMetadata[abi] = { size: fileSize, sha256, mtime: stats.mtimeMs };
        }
      }
    }

    const buildNumber = latest.buildNumber ?? latest.versionCode ?? 0;
    const downloadUrl = `${req.protocol}://${req.get('host')}/api/v1/app/download?abi=${abi}`;

    res.json({
      success: true,
      data: {
        version: latest.versionName,
        versionCode: latest.versionCode,
        buildNumber,
        downloadUrl,
        fileSize,
        changelog: latest.changelog,
        releasedAt: latest.releasedAt,
        minSupportedVersion: latest.minSupportedVersion,
        forceUpdate: latest.forceUpdate,
        sha256
      }
    });

    logger.info({
      layer: 'controller',
      action: 'VERSION_INFO_SENT',
      payload: { version: latest.versionName, versionCode: latest.versionCode, abi, fileSize }
    });

  } catch (error) {
    logger.error({
      layer: 'controller',
      action: 'GET_VERSION_ERROR',
      payload: { error: (error as Error).message, stack: (error as Error).stack }
    });
    res.status(500).json({ success: false, message: 'Error al obtener versión' });
  }
};

/**
 * Parsea el header Range de HTTP
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
 * GET /api/v1/app/download?abi=arm64-v8a
 * Descarga del APK por ABI usando streaming
 * Soporta Range requests (HTTP 206) para descargas resumibles
 */
export const downloadApk = async (req: Request, res: Response): Promise<void> => {
  try {
    const projectRoot = path.join(__dirname, '../../../../');
    const abi = resolveAbi(req.query.abi as string);
    const apkFilename = getApkFilename(abi);
    const apkPath = path.join(projectRoot, 'public', 'apk', apkFilename);

    if (!fs.existsSync(apkPath)) {
      logger.error({
        layer: 'controller',
        action: 'APK_NOT_FOUND',
        payload: { path: apkPath, abi }
      });
      res.status(404).json({
        success: false,
        message: `APK para ${abi} no encontrada. Por favor contacta al administrador.`
      });
      return;
    }

    const stats = fs.statSync(apkPath);
    const fileSize = stats.size;
    const cached = cachedApkMetadata[abi];
    const etag = cached?.sha256 ? `"${cached.sha256}-${abi}"` : null;

    // Headers base
    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    const contentDisposition = `attachment; filename="${apkFilename}"; filename*=UTF-8''${encodeURIComponent(apkFilename)}`;
    res.setHeader('Content-Disposition', contentDisposition);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('X-No-Compression', '1');
    res.setHeader('Cache-Control', 'public, max-age=86400, must-revalidate');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    // ETag
    if (etag) {
      res.setHeader('ETag', etag);
      const ifNoneMatch = req.headers['if-none-match'];
      if (ifNoneMatch === etag) {
        res.status(304).end();
        return;
      }
    }

    // Range requests (HTTP 206)
    const rangeHeader = req.headers.range;

    if (rangeHeader) {
      const range = parseRange(rangeHeader, fileSize);

      if (range) {
        const { start, end } = range;
        const chunkSize = end - start + 1;

        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
        res.setHeader('Content-Length', chunkSize.toString());

        const stream = fs.createReadStream(apkPath, {
          start,
          end,
          highWaterMark: 256 * 1024
        });

        stream.on('error', (err) => {
          logger.error({
            layer: 'controller',
            action: 'STREAM_ERROR',
            payload: { error: err.message, abi, range: `${start}-${end}` }
          });
          if (!res.headersSent) {
            res.status(500).json({ success: false, message: 'Error al descargar APK' });
          }
        });

        req.on('close', () => { if (!stream.destroyed) stream.destroy(); });
        stream.pipe(res);
        return;
      } else {
        res.status(416);
        res.setHeader('Content-Range', `bytes */${fileSize}`);
        res.end();
        return;
      }
    }

    // Descarga completa
    res.setHeader('Content-Length', fileSize.toString());

    const stream = fs.createReadStream(apkPath, {
      highWaterMark: 256 * 1024
    });

    stream.on('error', (err) => {
      logger.error({
        layer: 'controller',
        action: 'STREAM_ERROR',
        payload: { error: err.message, abi }
      });
      if (!res.headersSent) {
        res.status(500).json({ success: false, message: 'Error al descargar APK' });
      }
    });

    stream.on('end', () => {
      if (process.env.NODE_ENV !== 'production') {
        logger.info({
          layer: 'controller',
          action: 'APK_DOWNLOADED_SUCCESS',
          payload: { ip: req.ip, abi, fileSizeMB: (fileSize / (1024 * 1024)).toFixed(2) }
        });
      }
    });

    req.on('close', () => {
      if (!stream.destroyed) {
        stream.destroy();
        logger.warn({
          layer: 'controller',
          action: 'DOWNLOAD_CANCELLED',
          payload: { ip: req.ip, abi }
        });
      }
    });

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
