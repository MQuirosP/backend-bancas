# 🏦 Banca Management Backend

> **Proyecto backend modular y escalable** para la gestión integral de bancas de lotería.  
> Desarrollado con **TypeScript, Express y Prisma ORM**, bajo arquitectura por capas y trazabilidad completa vía `ActivityLog`.

---

## 🚀 Tecnologías Base

| Componente | Tecnología |
|-----------|------------|
| **Runtime** | Node.js (TypeScript strict) |
| **Framework HTTP** | Express.js |
| **ORM** | Prisma Client (PostgreSQL) |
| **Autenticación** | JWT (Access + Refresh) |
| **Validación** | Zod |
| **Logger** | Pino (`src/core/logger.ts`) + middleware `attachLogger` |
| **Configuración** | dotenv-safe |
| **Rate Limiting** | express-rate-limit |
| **Auditoría** | Modelo `ActivityLog` integrado |

---

## 🧩 Estructura del Proyecto

```bash
src/
├── api/
│   └── v1/
│       ├── controllers/
│       ├── dto/
│       ├── routes/
│       ├── services/
│       └── validators/
├── config/
├── core/
├── middlewares/
├── repositories/
├── server/
├── utils/
└── workers/
```

### Responsabilidades por capa

| Capa | Rol |
|------|-----|
| **Controllers** | Orquestan la petición HTTP y formatean la respuesta |
| **Services** | Lógica de negocio y validaciones de dominio |
| **Repositories** | Acceso a datos con Prisma (sin lógica de dominio) |
| **Middlewares** | Seguridad, validación, logging, rate limit |
| **Core** | Componentes críticos (logger, errores, Prisma, auditoría) |

---

## 🔐 Autenticación

- **Access Token** de corta duración y **Refresh Token** persistente (revocable).
- `RefreshToken` se almacena en DB con `revoked` y `expiresAt`.
- Middleware `protect` para proteger rutas.
- **Flag de desarrollo**: `DISABLE_AUTH=true` permite simular un usuario ADMIN temporalmente.

### Rutas

```http
POST /api/v1/auth/register
POST /api/v1/auth/login
POST /api/v1/auth/refresh
POST /api/v1/auth/logout
GET  /api/v1/auth/me
```

---

## 👤 Roles y Jerarquía

- **Banca** → gestiona límites y configuración global.
- **Ventana** → sucursal/punto de venta, subordinada a Banca.
- **Vendedor** → opera ventas, subordinado a Ventana.

Enum `Role`: `ADMIN`, `VENTANA`, `VENDEDOR`.

---

## 🏢 Bancas & 🪟 Ventanas

- **Banca**: `defaultMinBet` (💰 default **100**) y `globalMaxPerNumber` (🔒 default **5000**).  
  Campos de contacto: `address`, `phone`, `email`.
- **Ventana**: `commissionMarginX` y contacto (`address`, `phone`, `email`).

Soft-delete y trazabilidad en ambos modelos.  
La Banca **no** tiene márgenes propios de venta, **gestiona** los márgenes/comisiones de Ventanas/Vendedores.

---

## 🎲 Loterías & 🧭 Sorteos

- **Lotería** con `rulesJson` y relación 1:N con **Sorteo**.
- **Sorteo** (enum `SorteoStatus`: `SCHEDULED | OPEN | EVALUATED | CLOSED`):  
  - `OPEN` → permite vender Tickets.  
  - `EVALUATED` → registra `winningNumber` y marca jugadas ganadoras (`payout = amount × finalMultiplierX`).  
  - Soft-delete + auditoría (`SORTEO_CREATE`, `SORTEO_CLOSE`, `SORTEO_EVALUATE`, `SYSTEM_ACTION`).

### Rutas Sorteos

```http
# Admin-only (require ADMIN)
POST   /api/v1/sorteos
PUT    /api/v1/sorteos/:id
PATCH  /api/v1/sorteos/:id/open
PATCH  /api/v1/sorteos/:id/close
PATCH  /api/v1/sorteos/:id/evaluate
DELETE /api/v1/sorteos/:id

# Lectura
GET    /api/v1/sorteos
GET    /api/v1/sorteos/:id
```

---

## 🎫 Tickets

- **Ticket pertenece SIEMPRE a un Sorteo** (`sorteoId` requerido al crear).
- **Generador secuencial** con `TicketCounter` atómico (`id="DEFAULT"` + `upsert`).
- `finalMultiplierX` se calcula **en servidor** desde `LoteriaMultiplier.valueX` (no desde cliente).
- Validaciones de negocio en `TicketService.create`:
  - **Mínimo por jugada**: `Banca.defaultMinBet` (default 100).
  - **Límite global por número**: `Banca.globalMaxPerNumber` (default 5000).
  - Se valida dentro de una `prisma.$transaction` para evitar overselling.
- Cancelación con soft-delete y `TICKET_CANCEL` en `ActivityLog`.

### Rutas Tickets

```http
POST   /api/v1/tickets           # requiere { loteriaId, sorteoId, ventanaId, jugadas[] }
GET    /api/v1/tickets/:id
GET    /api/v1/tickets           # paginación offset
PATCH  /api/v1/tickets/:id/cancel
```

---

## 🔢 Multipliers & Restricciones

- **LoteriaMultiplier**: define `valueX` y puede estar limitado por fecha/sorteo.
- **UserMultiplierOverride** *(nuevo módulo)*:
  - Multiplicadores personalizados por usuario y lotería.
  - CRUD con roles `ADMIN` y `VENTANA`.
  - Auditado en `ActivityLog`.
  - Validaciones `Zod` en `multiplierOverride.dto.ts`.
- **RestrictionRule**: topes por banca/ventana/usuario/número.

---

## ⚖️ Concurrencia y transacciones

Sistema transaccional seguro con reintentos automáticos (`withTransactionRetry`):  

- Detecta errores Prisma `P2034` / deadlocks.  
- Registra `RETRY`, `FAIL` y `SUCCESS` en logs transaccionales.  
- Evita overselling bajo carga concurrente alta.

---

## 📦 Paginación

Utilidad de **offset pagination** (`src/utils/pagination.ts`) con metadatos estándar:

```json
{
  "total": 120,
  "page": 2,
  "pageSize": 10,
  "totalPages": 12,
  "hasNextPage": true,
  "hasPrevPage": true
}
```

Uso:

```ts
const { data, meta } = await paginateOffset(prisma.ticket, {
  where: { isDeleted: false },
  pagination: { page: 2, pageSize: 20 },
});
```

---

## 🧾 Auditoría Centralizada

`ActivityService.log` registra acciones relevantes (create/update/close/evaluate/soft-delete) con `details` JSON-safe.

```ts
await ActivityService.log({
  userId,
  action: ActivityType.TICKET_CREATE,
  targetType: 'TICKET',
  targetId: ticket.id,
  details: { ticketNumber: 123, totalAmount: "1500.00" },
});
```

---

## ⚙️ Configuración de entorno (.env)

> ⚠️ Nunca subir un `.env` real al repo. Usa `.env.example` como base.

```bash
# Server
PORT=4000
NODE_ENV=development
CORS_ORIGIN=http://localhost:5173
LOG_LEVEL=info
DISABLE_AUTH=false

# Database
DATABASE_URL=postgresql://user:pass@localhost:5432/bancas

# JWT
JWT_ACCESS_SECRET=your-access-secret
JWT_REFRESH_SECRET=your-refresh-secret
JWT_ACCESS_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=7d

# Rate limit (opcional)
RATE_LIMIT_WINDOW=60000
RATE_LIMIT_MAX=100
```

---

## 🧰 Scripts principales

```bash
# Desarrollo
npm run dev

# Build
npm run build

# Prisma
npx prisma migrate dev
npx prisma generate
npm run prisma:seed

# Deploy migrations
npm run prisma:deploy
```

---

## 🧱 Fases de desarrollo

| Fase | Descripción | Estado |
|------|-------------|--------|
| **1. Usuarios + Auth + Logs** | Validaciones y roles + auditoría | ✅ |
| **2. Tickets + Loterías** | Creación, listado y cancelación | ✅ |
| **3. Sorteos** | Ciclo (create/open/close/evaluate) + auditoría | ✅ |
| **4. Límites y Reglas** | Reglas globales y RestrictionRule | ✅ |
| **5. Overrides/Multipliers** | Multiplicadores por usuario y lotería | ✅ |
| **6. Pruebas + Docs + CI/CD** | Unit tests, Swagger, Docker | 🔜 |

---

## 👨‍💻 Autor

**Mario Quirós P.**  
Desarrollador Backend (Trainee)  
📧 [mquirosp78@gmail.com](mailto:mquirosp78@gmail.com)  
🌐 [github.com/MQuirosP](https://github.com/MQuirosP)

---

## 🧭 Licencia

Este proyecto está bajo la licencia **MIT**.  
Consulta `LICENSE` para más detalles.

---
