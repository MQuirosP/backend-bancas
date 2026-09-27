import path from 'path';
import fs from 'fs';
import logger from '../core/logger';

export interface LatestAppConfig {
  versionName: string;
  versionCode: number;
  buildNumber: number;
  minSupportedVersion: string;
  forceUpdate: boolean;
  changelog?: string;
  releasedAt?: string;
}

let cachedConfig: LatestAppConfig | null = null;
let lastCacheTime = 0;
const CACHE_TTL_MS = 60_000; // 60 segundos

/**
 * Lee la configuración de la versión más reciente desde public/latest.json
 * con caché en memoria de 60 segundos.
 */
export function getLatestAppConfig(): LatestAppConfig | null {
  const now = Date.now();
  if (cachedConfig && now - lastCacheTime < CACHE_TTL_MS) {
    return cachedConfig;
  }

  try {
    const latestPath = path.join(process.cwd(), 'public', 'latest.json');
    if (!fs.existsSync(latestPath)) {
      return cachedConfig;
    }

    const content = fs.readFileSync(latestPath, 'utf-8');
    cachedConfig = JSON.parse(content) as LatestAppConfig;
    lastCacheTime = now;
    return cachedConfig;
  } catch (error: any) {
    logger.warn({
      layer: 'utils',
      action: 'READ_LATEST_JSON_WARN',
      payload: { error: error?.message },
    });
    return cachedConfig;
  }
}

/**
 * Retorna la versión mínima obligatoria de la APK.
 * Si forceUpdate es true, la versión requerida es versionName.
 * En caso contrario, retorna minSupportedVersion o versionName como fallback.
 */
export function getRequiredApkVersion(): string {
  const config = getLatestAppConfig();
  if (!config) {
    return '1.0.23'; // Fallback seguro
  }
  if (config.forceUpdate) {
    return config.versionName;
  }
  return config.minSupportedVersion || config.versionName;
}

/**
 * Compara dos versiones semver numéricas (ej. "1.0.23" vs "1.0.15").
 * Retorna true si clientVersion es ESTRICTAMENTE MENOR que minRequiredVersion.
 */
export function isVersionOutdated(clientVersion: string, minRequiredVersion: string): boolean {
  if (!clientVersion) return true;

  const parse = (v: string): number[] =>
    v
      .replace(/^[vV]/, '')
      .split('+')[0]
      .split('-')[0]
      .split('.')
      .map((part) => parseInt(part, 10) || 0);

  const clientParts = parse(clientVersion);
  const minParts = parse(minRequiredVersion);

  const length = Math.max(clientParts.length, minParts.length);
  for (let i = 0; i < length; i++) {
    const c = clientParts[i] ?? 0;
    const m = minParts[i] ?? 0;
    if (c < m) return true;  // cliente es menor -> desactualizado
    if (c > m) return false; // cliente es mayor -> actualizado
  }

  return false; // versiones idénticas -> actualizado
}

/**
 * Determina si una petición HTTP proviene del cliente nativo Android (APK de Vendedores)
 * o de un navegador web / panel administrativo.
 */
export function isNativeAndroidClient(
  req?: { headers?: Record<string, string | string[] | undefined> },
  bodyPlatform?: string
): boolean {
  const rawUserAgent = req?.headers?.['user-agent'];
  const userAgent = Array.isArray(rawUserAgent) ? rawUserAgent.join(' ') : (rawUserAgent || '');

  const rawPlatform = req?.headers?.['x-platform'];
  const headerPlatform = Array.isArray(rawPlatform) ? rawPlatform[0] : (rawPlatform || '');

  const hasAppVersionHeader = Boolean(req?.headers?.['x-app-version']);

  // Si proviene de un navegador web estándar y declara platform: 'web', NO es APK nativo
  if (bodyPlatform === 'web' && !userAgent.includes('okhttp')) {
    return false;
  }

  // Si el User-Agent proviene de OkHttp (Retrofit en Android), ES cliente nativo Android
  if (userAgent.includes('okhttp')) {
    return true;
  }

  // Si declara la cabecera explícita X-Platform: android (enviada por AuthInterceptor)
  if (headerPlatform.toLowerCase() === 'android') {
    return true;
  }

  // Si en el cuerpo de la petición se declara explícitamente android
  if (bodyPlatform?.toLowerCase() === 'android') {
    return true;
  }

  // Si incluye la cabecera X-App-Version de APK móvil
  if (hasAppVersionHeader && !userAgent.toLowerCase().includes('mozilla')) {
    return true;
  }

  return false;
}
