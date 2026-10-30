import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import logger from '../core/logger';
import { config } from '../config';

const LOCAL_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost']);

/**
 * Determina si la petición se originó estrictamente de forma local (loopback)
 * dentro del mismo contenedor/servidor, sin haber atravesado el proxy público.
 */
function isLocalRequest(req: Request): boolean {
  const clientIp = req.ip || '';
  const remoteSocket = req.socket?.remoteAddress || '';
  return LOCAL_IPS.has(clientIp) && LOCAL_IPS.has(remoteSocket);
}

/**
 * Middleware hardened de autenticación y aislamiento de red para operaciones privilegiadas (/ops)
 */
export const protectOpsHardened = (req: Request, res: Response, next: NextFunction): void => {
  const clientIp = req.ip || req.socket?.remoteAddress || '';
  const isLocal = isLocalRequest(req);
  const isAllowedRemote = config.ops.allowedIps.length > 0 && config.ops.allowedIps.includes(clientIp);

  // 1. Barrera de Red (Aislamiento de loopback / IP Allowlist)
  if (!isLocal && !isAllowedRemote) {
    logger.warn({
      layer: 'security',
      action: 'OPS_FORBIDDEN_NETWORK_ACCESS',
      payload: {
        ip: clientIp,
        socketRemote: req.socket?.remoteAddress,
        path: req.originalUrl,
        userAgent: req.headers['user-agent']
      }
    });

    res.status(403).json({
      success: false,
      error: 'Acceso denegado: este recurso solo es accesible localmente o desde IPs autorizadas.'
    });
    return;
  }

  // 2. Fail-Closed: Si OPS_SECRET no está definido, las rutas se deshabilitan
  const configuredSecret = config.ops.secret;
  if (!configuredSecret) {
    logger.error({
      layer: 'security',
      action: 'OPS_DISABLED_NO_SECRET',
      payload: {
        message: 'OPS_SECRET no está configurado en el entorno. Endpoints de soporte deshabilitados.',
        path: req.originalUrl
      }
    });

    res.status(503).json({
      success: false,
      error: 'Operaciones de soporte temporalmente deshabilitadas por configuración.'
    });
    return;
  }

  // 3. Verificación de existencia del header
  const secretHeader = req.headers['x-ops-secret'];
  if (!secretHeader || typeof secretHeader !== 'string') {
    logger.warn({
      layer: 'security',
      action: 'OPS_AUTH_MISSING_HEADER',
      payload: { ip: clientIp, path: req.originalUrl }
    });

    res.status(401).json({
      success: false,
      error: 'Acceso no autorizado: credencial X-Ops-Secret requerida.'
    });
    return;
  }

  // 4. Comparación Timing-Safe mediante SHA-256 Digest
  const hashProvided = crypto.createHash('sha256').update(secretHeader).digest();
  const hashExpected = crypto.createHash('sha256').update(configuredSecret).digest();

  if (!crypto.timingSafeEqual(hashProvided, hashExpected)) {
    logger.warn({
      layer: 'security',
      action: 'OPS_AUTH_FAILED_INVALID_SECRET',
      payload: { ip: clientIp, path: req.originalUrl }
    });

    res.status(401).json({
      success: false,
      error: 'Acceso no autorizado a operaciones de soporte.'
    });
    return;
  }

  // 5. Auditoría de acceso concedido
  logger.info({
    layer: 'security',
    action: 'OPS_AUTH_SUCCESS',
    payload: {
      ip: clientIp,
      endpoint: req.originalUrl,
      method: req.method
    }
  });

  next();
};

