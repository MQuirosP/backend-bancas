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

export class ResilienceService {
    private static prismaBreaker: CircuitBreaker;
    private static redisBreaker: CircuitBreaker;
    private static l1Cache = new Map<string, RedisL1CacheEntry>();
    private static inflightRedisRequests = new Map<string, Promise<any>>();
    private static initialized = false;

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
                return !PRISMA_TRANSIENT_ERRORS.includes(prismaCode ?? '');
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
            const isTransient = PRISMA_TRANSIENT_ERRORS.includes(prismaCode ?? '') || (err as any)?.name === 'TimeoutError';
            if (isTransient) {
                metricsService.recordDbRequest(true, latency);
            } else {
                // Si es un error lógico, cuenta como éxito de infraestructura (la DB respondió)
                metricsService.recordDbRequest(false, latency);
            }
        });

        // Circuit Breaker para Redis
        this.redisBreaker = new CircuitBreaker(async (action: any) => action(), {
            timeout: 2000,
            errorThresholdPercentage: 5,
            resetTimeout: config.hardening.redisCbResetMs,
            rollingCountTimeout: 10000,
            errorFilter: (_err: any) => false // Todos los errores de Redis cuentan para el breaker
        });

        this.redisBreaker.on('success', () => metricsService.recordRedisRequest(false));
        this.redisBreaker.on('failure', () => metricsService.recordRedisRequest(true));

        this.setupLogging(this.prismaBreaker, 'Prisma');
        this.setupLogging(this.redisBreaker, 'Redis');

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
     */
    static async runRedis<T>(key: string, action: () => Promise<T>, ttl: number = 3): Promise<T> {
        this.ensureInitialized();

        // 1. Verificar L1 Cache
        const cached = this.l1Cache.get(key);
        if (cached && cached.expiry > Date.now()) {
            return cached.value;
        }

        // 2. Promise Coalescing (Anti-Stampede)
        if (this.inflightRedisRequests.has(key)) {
            return this.inflightRedisRequests.get(key);
        }

        // 3. Ejecutar a través del Breaker
        const promise = this.redisBreaker.fire(action).then(result => {
            this.l1Cache.set(key, {
                value: result,
                expiry: Date.now() + (ttl * 1000)
            });
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
}
