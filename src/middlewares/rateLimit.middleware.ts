import rateLimit from "express-rate-limit";

export const rateLimitMiddleware = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutos
    max: 250, // Limitar a 100 peticiones por IP
    standardHeaders: true, // Retorna información de rate limit en los headers `RateLimit-*`
    legacyHeaders: false, // Deshabilita los headers `X-RateLimit-*`
    message: "Demasiadas peticiones desde esta IP, por favor intenta más tarde."
});
