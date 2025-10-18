// src/middlewares/cors.middleware.ts
import cors, { CorsOptionsDelegate } from 'cors'
import { Request } from 'express'
import { config } from '../config'

const corsOptions: CorsOptionsDelegate<Request> = (req, cb) => {
  const origin = (req.headers.origin || '').replace(/\/+$/, '')
  const allowAll = config.cors.allowAll
  const ok = origin && config.cors.origins.includes(origin)

  cb(null, {
    origin: allowAll ? true : ok ? origin : false,
    credentials: true,
    methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
    allowedHeaders: ['Content-Type','Authorization','X-Requested-With'],
    exposedHeaders: ['Content-Length','X-Request-Id'],
    maxAge: 86400,
  })
}

export const corsMiddleware = [
  // útil para caches/CDN
  (_: any, res: any, next: any) => { res.setHeader('Vary', 'Origin'); next() },
  // preflight global
  (req: any, res: any, next: any) => {
    if (req.method === 'OPTIONS') {
      return cors(corsOptions)(req, res, () => res.sendStatus(204))
    }
    next()
  },
  // CORS para el resto
  cors(corsOptions),
]
