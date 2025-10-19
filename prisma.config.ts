// prisma.config.ts
import path from 'node:path'
import { defineConfig } from 'prisma/config'
import dotenvSafe from 'dotenv-safe'

// Carga .env con validación contra .env.example
dotenvSafe.config({
  example: path.resolve(process.cwd(), '.env.example'),
  allowEmptyValues: false,
})

export default defineConfig({
  schema: path.join('src', 'prisma', 'schema.prisma'),
})
