/**
 * Rutas para auto-actualización de APK
 * Endpoints públicos para descarga y versión de la aplicación móvil
 */

import { Router } from 'express';
import { getVersionInfo, downloadApk } from '../controllers/app.controller';

const router = Router();

/**
 * @route   GET /api/v1/app/version
 * @desc    Obtener información de la versión más reciente de la APK
 * @access  Public
 */
router.get('/version', getVersionInfo);

/**
 * @route   GET /api/v1/app/download
 * @desc    Descargar archivo APK más reciente
 * @access  Public
 */
router.get('/download', downloadApk);

export default router;
