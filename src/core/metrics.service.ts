import toobusy from 'toobusy-js';
import { activeOperationsService } from './activeOperations.service';

interface MetricSample {
    timestamp: number;
    isError: boolean;
    duration?: number;
}

/**
 * Metrics Service con ventana deslizante (sliding window) de 10s
 */
class MetricsService {
    private dbSamples: MetricSample[] = [];
    private redisSamples: MetricSample[] = [];
    private windowMs = 10000; // 10s

    private cleanOldSamples() {
        const now = Date.now();
        const cutoff = now - this.windowMs;
        this.dbSamples = this.dbSamples.filter(s => s.timestamp > cutoff);
        this.redisSamples = this.redisSamples.filter(s => s.timestamp > cutoff);
    }

    recordDbRequest(isError: boolean, duration?: number) {
        this.dbSamples.push({ timestamp: Date.now(), isError, duration });
        this.cleanOldSamples();
    }

    recordRedisRequest(isError: boolean) {
        this.redisSamples.push({ timestamp: Date.now(), isError });
        this.cleanOldSamples();
    }

    getMetrics() {
        this.cleanOldSamples();
        
        const dbTotal = this.dbSamples.length;
        const dbErrors = this.dbSamples.filter(s => s.isError).length;
        const dbDurations = this.dbSamples.filter(s => s.duration !== undefined).map(s => s.duration!);
        const avgDbDuration = dbDurations.length > 0 
            ? dbDurations.reduce((a, b) => a + b, 0) / dbDurations.length 
            : 0;

        const redisTotal = this.redisSamples.length;
        const redisErrors = this.redisSamples.filter(s => s.isError).length;

        return {
            activeRequests: activeOperationsService.getActiveCount(),
            dbQueryDuration: avgDbDuration,
            eventLoopLag: toobusy.lag(),
            dbErrorRate: dbTotal > 0 ? (dbErrors / dbTotal) : 0,
            redisErrorRate: redisTotal > 0 ? (redisErrors / redisTotal) : 0,
            isTooBusy: toobusy(),
        };
    }

    getDbErrorRate() {
        this.cleanOldSamples();
        const total = this.dbSamples.length;
        if (total < 10) return 0;
        return this.dbSamples.filter(s => s.isError).length / total;
    }

    getRedisErrorRate() {
        this.cleanOldSamples();
        const total = this.redisSamples.length;
        if (total < 10) return 0;
        return this.redisSamples.filter(s => s.isError).length / total;
    }

    getDbWindowTotal() {
        this.cleanOldSamples();
        return this.dbSamples.length;
    }

    getRedisWindowTotal() {
        this.cleanOldSamples();
        return this.redisSamples.length;
    }
}

export const metricsService = new MetricsService();
