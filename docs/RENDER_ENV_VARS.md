# 🚀 Variables de Entorno para Render (Producción)

## 📋 Variables de Base de Datos

Copiar estas variables EXACTAMENTE como están en el dashboard de Render:

```bash
# Database Connection (Pooler - RECOMENDADO para producción)
DATABASE_URL=postgresql://postgres.xhwxiofujvoaszojcoml:EAnS8hLM4rXZjayd@aws-1-us-east-1.pooler.supabase.com:6543/postgres?pgbouncer=true

# Direct Connection (para migraciones solamente)
DIRECT_URL=postgresql://postgres:EAnS8hLM4rXZjayd@db.xhwxiofujvoaszojcoml.supabase.co:5432/postgres
```

**Nota Importante:**
- `DATABASE_URL` usa el **pooler** (puerto 6543) - mejor para aplicaciones con múltiples conexiones
- `DIRECT_URL` usa **conexión directa** (puerto 5432) - solo para migraciones
- **La contraseña es la misma para ambas**: `EAnS8hLM4rXZjayd`

---

## 🔐 Otras Variables Requeridas

```bash
# Configuración de Entorno
NODE_ENV=production

# Puerto (Render lo asigna automáticamente, pero define default)
PORT=3000

# Supabase
SUPABASE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhod3hpb2Z1anZvYXN6b2pjb21sIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjEzNTQ5OTAsImV4cCI6MjA3NjkzMDk5MH0.5VX6WC4204Ud671YvPq9XLqwLT8yn36Ugjbx2DklkfE

# JWT Secrets (GENERAR NUEVOS para producción)
JWT_ACCESS_SECRET=CAMBIAR-POR-SECRET-SEGURO-MINIMO-32-CARACTERES
JWT_REFRESH_SECRET=CAMBIAR-POR-OTRO-SECRET-SEGURO-MINIMO-32-CARACTERES
JWT_ACCESS_EXPIRES_IN=60m
JWT_REFRESH_EXPIRES_IN=7d

# Logging
LOG_LEVEL=info

# CORS (Cambiar por tu dominio de producción)
CORS_ORIGIN=https://tu-frontend-production.com

# Autenticación
DISABLE_AUTH=false

# Business Logic
SALES_DAILY_MAX=100000
TX_MAX_RETRIES=3
TX_BACKOFF_MIN_MS=250
TX_BACKOFF_MAX_MS=600
MULTIPLIER_BASE_DEFAULT_X=90
```

---

## ⚠️ IMPORTANTE: Generar Secrets de Producción

**NO uses los secrets de desarrollo en producción.** Genera nuevos:

### En Node.js (desde terminal):
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Ejecuta 2 veces para generar:
1. `JWT_ACCESS_SECRET`
2. `JWT_REFRESH_SECRET`

---

## 📝 Checklist de Deployment en Render

- [ ] Todas las variables de entorno configuradas
- [ ] `JWT_ACCESS_SECRET` y `JWT_REFRESH_SECRET` generados (únicos para producción)
- [ ] `CORS_ORIGIN` apunta a tu dominio de producción
- [ ] `NODE_ENV=production`
- [ ] Build command: `npm install && npm run build && npm run prisma:generate`
- [ ] Start command: `npm start`
- [ ] Verificar que el servidor inicia correctamente
- [ ] Probar conexión a base de datos

---

## 🔍 Verificar Conexión (Opcional)

Si quieres probar las conexiones antes de deployar, desde tu máquina local:

```bash
# Test DATABASE_URL
node -e "const {Client}=require('pg');new Client('postgresql://postgres.xhwxiofujvoaszojcoml:EAnS8hLM4rXZjayd@aws-1-us-east-1.pooler.supabase.com:6543/postgres?pgbouncer=true').connect().then(()=>console.log('✅ OK')).catch(e=>console.log('❌',e.message))"

# Test DIRECT_URL
node -e "const {Client}=require('pg');new Client({connectionString:'postgresql://postgres:EAnS8hLM4rXZjayd@db.xhwxiofujvoaszojcoml.supabase.co:5432/postgres',ssl:{rejectUnauthorized:false}}).connect().then(()=>console.log('✅ OK')).catch(e=>console.log('❌',e.message))"
```

Ambas deben mostrar `✅ OK`.

---

**Última actualización:** 2025-11-02
