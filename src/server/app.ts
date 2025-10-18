// src/middlewares/cors.middleware.ts
import cors, { CorsOptionsDelegate } from 'cors'
import type { Request } from 'express'
import { config } from '../config'

const corsOptions: CorsOptionsDelegate<Request> = (req, cb) => {
  const origin = (req.headers.origin || '').replace(/\/+$/, '')

  if (config.cors.allowAll) {
    return cb(null, {
      origin: true, // refleja la Origin recibida
      credentials: true,
      methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
      allowedHeaders: ['Content-Type','Authorization','X-Requested-With'],
      exposedHeaders: ['Content-Length','X-Request-Id'],
      maxAge: 86400,
    })
  }

  const ok = origin && config.cors.origins.includes(origin)
  cb(null, {
    origin: ok ? origin : false,  // false => bloquea si no está permitido
    credentials: true,
    methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
    allowedHeaders: ['Content-Type','Authorization','X-Requested-With'],
    exposedHeaders: ['Content-Length','X-Request-Id'],
    maxAge: 86400,
  })
}

// export nombrado: { corsMiddleware }
export const corsMiddleware = [
  // Asegura caches correctos/CDN
  (_req: any, res: any, next: any) => { res.setHeader('Vary', 'Origin'); next() },

  // Preflight global: responde antes que cualquier otro middleware
  (req: any, res: any, next: any) => {
    if (req.method === 'OPTIONS') {
      return cors(corsOptions)(req, res, () => res.sendStatus(204))
    }
    next()
  },

  // CORS para el resto de métodos
  cors(corsOptions),
]
