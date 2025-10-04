import type pino from 'pino';
import 'express-serve-static-core';

declare module 'express-serve-static-core' {
  interface Request {
    /**
     * Request-scoped pino logger (child) attached by attachRequestLogger middleware.
     * Use req.logger?.info({ ... }) or req.logger?.error({ ... }).
     */
    logger?: pino.Logger;
    /**
     * Request id set by requestId.middleware (string UUID).
     */
    requestId?: string;
  }
}
