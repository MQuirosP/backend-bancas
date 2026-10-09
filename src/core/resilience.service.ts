import CircuitBreaker from 'opossum';
import logger from './logger';
import { config } from '../config';
import { metricsService } from './metrics.service';

/**
 * Errores transitorios de Prisma que activan el Circuit Breaker
 */
const PRISMA_TRANSIENT_ERRORS = ['P1001', 'P1002', 'P1008', 'P1017', 'P2024'];

interface RedisL1CacheEntry {
    value: any;
    expiry: number;
}

/**
 * Timeout de fallo de Redis. En la red privada de Render la latencia típica es < 1ms,
 * pero ante ráfagas concurrentes de I/O / event-loop lag, 150ms previene falsos positivos.
 */
export const REDIS_BREAKER_TIMEOUT_MS = Number(process.env.REDIS_BREAKER_TIMEOUT_MS) || 150;

export class ResilienceService {
    private static prismaBreaker: CircuitBreaker;
    private static redisBreaker: CircuitBreaker;
    private static l1Cache = new Map<string, RedisL1CacheEntry>();
    private static MAX_L1_SIZE = 1000; // Límite de seguridad para evitar fuga de memoria
    private static inflightRedisRequests = new Map<string, Promise<any>>();
    private static initialized = false;

    /**
     * Desaloja la entrada más antigua del L1 cache de resiliencia (política FIFO).
     * Reemplaza el .clear() masivo para evitar que todas las claves queden
     * sin caché simultáneamente (cache stampede).
     */
    private static evictOldestL1Entry(): void {
        const firstKey = this.l1Cache.keys().next().value;
        if (firstKey !== undefined) this.l1Cache.delete(firstKey);
    }

    /**
     * Inicializa los breakers con las configuraciones de hardening
     */
    static init() {
        if (this.initialized) return;

        // Circuit Breaker para Prisma
        this.prismaBreaker = new CircuitBreaker(async (action: any) => action(), {
            timeout: config.hardening.requestTimeoutMs,
            errorThresholdPercentage: 5,
            resetTimeout: config.hardening.prismaCbResetMs,
            rollingCountTimeout: 10000,
            rollingCountBuckets: 10,
            errorFilter: (err: unknown) => {
                // El errorFilter solo decide si el error cuenta para abrir el circuito
                const prismaCode = (err as any)?.code as string | undefined;
                const msg = String((err as any)?.message ?? '').toLowerCase();
                const isTransient = PRISMA_TRANSIENT_ERRORS.includes(prismaCode ?? '')
                    || msg.includes('econnaborted')
                    || msg.includes('not queryable')
                    || msg.includes('connection error')
                    || (err as any)?.name === 'TimeoutError';
                return !isTransient;
            }
        });

        // 3 timeouts consecutivos disparan el breaker
        let consecutiveTimeouts = 0;
        this.prismaBreaker.on('timeout', () => {
            consecutiveTimeouts++;
            if (consecutiveTimeouts >= 3) {
                this.prismaBreaker.open();
                consecutiveTimeouts = 0;
            }
        });

        this.prismaBreaker.on('success', (_res, latency) => {
            consecutiveTimeouts = 0;
            metricsService.recordDbRequest(false, latency);
        });

        this.prismaBreaker.on('failure', (err, latency) => {
            // Solo registramos error en métricas si es un error transitorio
            // Los errores lógicos (P2002, etc.) no son fallos de infraestructura
            const prismaCode = (err as any)?.code as string | undefined;
            const msg = String((err as any)?.message ?? '').toLowerCase();
            const isTransient = PRISMA_TRANSIENT_ERRORS.includes(prismaCode ?? '')
                || msg.includes('econnaborted')
                || msg.includes('not queryable')
                || msg.includes('connection error')
                || (err as any)?.name === 'TimeoutError';
            if (isTransient) {
                metricsService.recordDbRequest(true, latency);
            } else {
                // Si es un error lógico, cuenta como éxito de infraestructura (la DB respondió)
                metricsService.recordDbRequest(false, latency);
            }
        });

        // Circuit Breaker para Redis
        this.redisBreaker = new CircuitBreaker(async (action: any) => action(), {
            timeout: REDIS_BREAKER_TIMEOUT_MS,
            errorThresholdPercentage: 50,
            volumeThreshold: 10,
            resetTimeout: config.hardening.redisCbResetMs,
            rollingCountTimeout: 10000,
            errorFilter: (_err: any) => false // Todos los errores de Redis cuentan para el breaker
        });

        this.redisBreaker.on('success', () => metricsService.recordRedisRequest(false));
        this.redisBreaker.on('failure', () => metricsService.recordRedisRequest(true));

        this.setupLogging(this.prismaBreaker, 'Prisma');
        this.setupLogging(this.redisBreaker, 'Redis');

        // Limpieza periódica del L1 cache: elimina entradas expiradas cada 30s.
        // Previene acumulación indefinida de claves que se escriben pero nunca se vuelven a leer.
        setInterval(() => {
            const now = Date.now();
            for (const [key, entry] of this.l1Cache.entries()) {
                if (entry.expiry <= now) this.l1Cache.delete(key);
            }
        }, 30_000).unref();

        this.initialized = true;
    }

    private static setupLogging(breaker: CircuitBreaker, name: string) {
        breaker.on('open', () => logger.warn({ layer: 'resilience', action: `CB_${name.toUpperCase()}_OPEN` }));
        breaker.on('halfOpen', () => logger.info({ layer: 'resilience', action: `CB_${name.toUpperCase()}_HALF_OPEN` }));
        breaker.on('close', () => logger.info({ layer: 'resilience', action: `CB_${name.toUpperCase()}_CLOSED` }));
    }

    private static ensureInitialized() {
        if (!this.initialized) {
            throw new Error('ResilienceService must be initialized before use. Call init() first.');
        }
    }

    /**
     * Ejecuta una acción de Prisma protegida
     */
    static async runPrisma<T>(action: () => Promise<T>): Promise<T> {
        this.ensureInitialized();
        return this.prismaBreaker.fire(action) as Promise<T>;
    }

    /**
     * Ejecuta una acción de Redis con Anti-Stampede y L1 Fallback
     * @param ttl segundos de memoización local. Con ttl <= 0 NO se lee ni escribe memoria local
     *            (obligatorio para datos de negocio compartidos entre réplicas).
     */
    static async runRedis<T>(key: string, action: () => Promise<T>, ttl: number = 3): Promise<T> {
        this.ensureInitialized();

        const memoize = ttl > 0;

        // 1. Verificar L1 Cache
        const cached = memoize ? this.l1Cache.get(key) : undefined;
        if (cached && cached.expiry > Date.now()) {
            return cached.value;
        }

        // 2. Promise Coalescing (Anti-Stampede)
        if (this.inflightRedisRequests.has(key)) {
            return this.inflightRedisRequests.get(key);
        }

        // 3. Ejecutar a través del Breaker
        const promise = this.redisBreaker.fire(action).then(result => {
            if (memoize && result !== undefined) {
                if (this.l1Cache.size >= this.MAX_L1_SIZE) {
                    this.evictOldestL1Entry(); // Desalojo FIFO: evita cache stampede
                }
                this.l1Cache.set(key, {
                    value: result,
                    expiry: Date.now() + (ttl * 1000)
                });
            }
            this.inflightRedisRequests.delete(key);
            return result;
        }).catch(err => {
            this.inflightRedisRequests.delete(key);
            if (cached) return cached.value;
            throw err;
        });

        this.inflightRedisRequests.set(key, promise);
        return promise as Promise<T>;
    }

    /**
     * Verifica si el breaker de Prisma está abierto
     */
    static isPrismaOpen(): boolean {
        this.ensureInitialized();
        return this.prismaBreaker.opened;
    }

    /**
     * Reporta un error de conexión al circuit breaker de Prisma.
     * Llamar desde withConnectionRetry cuando se detecta P1001/P1017/etc.
     * para que el breaker pueda abrirse durante outages de Supabase.
     */
    static reportPrismaConnectionError(): void {
        if (!this.initialized) return;
        // Fire a rejected promise to feed the failure into the breaker's rolling window
        this.prismaBreaker.fire(() => Promise.reject(new Error('db_unreachable'))).catch(() => {});
    }
}
