import cors, { CorsOptionsDelegate } from 'cors'
import express from 'express'
import { config } from '../config'

const app = express()

// Vary para caches/CDN
app.use((_, res, next) => {
  res.setHeader('Vary', 'Origin')
  next()
})

const corsOptions: CorsOptionsDelegate = (req, cb) => {
  const originHeader = (req.headers.origin || '').replace(/\/+$/, '')

  if (config.cors.allowAll) {
    // Permitir todos los orígenes (útil en dev o si no usas credenciales)
    return cb(null, {
      origin: true, // refleja el origin recibido
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
      exposedHeaders: ['Content-Length', 'X-Request-Id'],
      maxAge: 86400,
    })
  }

  const isAllowed = originHeader && config.cors.origins.includes(originHeader)
  return cb(null, {
    origin: isAllowed ? originHeader : false, // reflejar solo si está permitido
    credentials: true, // si usas cookies/Authorization
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    exposedHeaders: ['Content-Length', 'X-Request-Id'],
    maxAge: 86400,
  })
}

// 1) Responde preflight **antes** que cualquier otro middleware restrictivo
app.options('*', cors(corsOptions))

// 2) Aplica cors al resto
app.use(cors(corsOptions))

// 3) Parsers y rutas
app.use(express.json())
// app.use('/api/v1', routes)
