# CLAUDE.md — Contexto del codebase

Plataforma backend de gestión de bancas de lotería para el mercado costarricense.
Node.js 20 + Express + TypeScript + Prisma + PostgreSQL (Supabase).

---

## Stack principal

| Capa | Tecnología |
|---|---|
| Runtime | Node.js 20.x |
| Framework | Express 4.21.2 |
| Lenguaje | TypeScript 5.9.3 |
| ORM | Prisma 6.18.0 |
| Base de datos | PostgreSQL (Supabase) |
| Cache | Redis (ioredis, opcional) + in-memory por módulo |
| Auth | JWT (access + refresh tokens) |
| Validación | Zod 4 |
| Logging | Pino 10 (estructurado) |
| Matemática monetaria | decimal.js 10 |
| PDF/Reportes | pdfkit, pdfmake, pdf-lib, exceljs |
| Monitoreo | Sentry |

---

## Estructura del proyecto

```
src/
  api/v1/           # Controladores, validators, rutas por recurso
  core/             # prismaClient, logger, auth, AppError
  repositories/     # Acceso a datos (Prisma queries)
  services/         # Lógica de negocio (algunos están en api/v1/services/)
  middlewares/      # Express middleware (auth, error, rate limit, etc.)
  utils/            # Utilidades (fechas, RBAC, caché, paginación)
  jobs/             # Cron jobs (sorteos auto, settlement, monthly closing)
  config/           # Zod env schema, configuración de app
scripts/
  DEPLOY/           # Validadores pre-deploy/migrate
  SORTEOS/          # Scripts de emergencia y backfill de sorteos
  STATEMENTS/       # Diagnóstico y corrección de AccountStatements
  TICKETS/          # Diagnóstico y migración de tickets
prisma/
  schema.prisma     # Modelos, enums, relaciones
  migrations/       # Migraciones históricas
```

---

## Entidades del dominio

**Organización:**
- `Banca` → empresa de loterías (raíz del multi-tenant)
- `Ventana` → sucursal/punto de venta (pertenece a Banca)
- `User` → roles: `ADMIN`, `VENTANA`, `VENDEDOR`

**Juego:**
- `Loteria` → tipo de juego (NICA, MULTI X NICA, etc.)
- `Sorteo` → instancia de un sorteo (`SCHEDULED → OPEN → EVALUATED → CLOSED`)
- `Ticket` → boleto vendido (tiene múltiples `Jugada`)
- `Jugada` → apuesta individual dentro de un ticket (número + monto + multiplicador)

**Financiero:**
- `AccountStatement` → estado de cuenta diario por vendedor/ventana/banca
- `AccountPayment` → movimiento de pago/cobro contra un statement
- `MonthlyClosingBalance` → cierre mensual (snapshot)
- `TicketPayment` → historial de pagos sobre tickets ganadores

**Comisiones y reglas:**
- `LoteriaMultiplier` → multiplicadores base por número/reventado
- `MultiplierOverride` → override de multiplicador a nivel USER o VENTANA
- `RestrictionRule` → reglas de límite de ventas (monto fijo o dinámico)
- `BancaLoteriaSetting` → multiplicadores personalizados por banca

---

## Convenciones de código

### Capas
```
Controller → Service → Repository → Prisma
```
- Los controladores NO tienen lógica de negocio
- Los repositories son la única capa que toca Prisma directamente
- Las transactions se inician en el repository via `withTransactionRetry()`

### Errores
```typescript
// Error operacional (llega al cliente con statusCode)
throw new AppError('Mensaje para el cliente', 404);
throw new AppError('No autorizado', 403, { meta: 'contexto extra' });

// El error middleware mapea errores de Prisma:
// P2002 → 409  P2003 → 400  P2025 → 404
```

### Logging
```typescript
logger.info({
  layer: 'service',        // controller | service | repository | middleware | script
  action: 'TICKET_CREATE',
  userId: req.user.id,
  requestId: req.requestId,
  payload: { ticketNumber },
  meta: { count: 5 },      // para errores: { error: e.message, stack: e.stack }
});
```

### Validación de request
```typescript
// En el router:
router.post('/', protect, validateBody(createTicketSchema), controller.create);

// Zod schema siempre en src/api/v1/validators/
// Mensajes de error en español
```

### Responses
```typescript
// Éxito
res.status(200).json({ status: 'success', data: result });
// Error (lanzar AppError, el middleware lo transforma)
```

---

## Autenticación y autorización

**JWT:**
- Access token: 60m (configurable via `JWT_ACCESS_EXPIRES_IN`)
- Refresh token: 7d, multi-device, almacenado en `RefreshToken` con deviceId/userAgent/IP
- Payload del access token: `{ sub: userId, role, ventanaId?, bancaId? }`
- Redis cache para lookups de `ventanaId` (TTL 5min)

**Guards (middleware):**
```typescript
protect                              // Requiere JWT válido
restrictTo('ADMIN', 'VENTANA')       // Whitelist de roles
restrictToAdminOrSelf                // ADMIN o el propio usuario
restrictToAdminOrVentanaSelf         // ADMIN o VENTANA gestionando su propia ventana
```

**RBAC en queries — CRÍTICO:**
```typescript
// Siempre usar applyRbacFilters() antes de ejecutar queries con filtros del cliente
// VENDEDOR → fuerza filtro por userId
// VENTANA  → fuerza filtro por ventanaId
// ADMIN    → aplica filtros del cliente tal cual (pero en contexto de su bancaId)
// Nunca confiar en filtros enviados por el cliente sin pasar por RBAC
```

**Contexto de banca (ADMIN multi-banca):**
- Header `X-Active-Banca-Id` para que un ADMIN opere sobre una banca específica
- Endpoint `POST /api/v1/auth/set-active-banca` para cambiar contexto
- El bancaId activo se incluye en el JWT o se resuelve por middleware

---

## Fechas y timezone — MUY IMPORTANTE

**Zona horaria:** Costa Rica = UTC−6 (sin cambio de horario)

**Fuente de verdad: `src/utils/crDateService.ts`**
```typescript
dateUTCToCRString(date)           // Date UTC → 'YYYY-MM-DD' en CR
postgresDateToCRString(pgDate)    // DATE de Postgres → string CR
dateRangeUTCToCRStrings(from, to) // Rango UTC → strings CR
CR_TIMEZONE_OFFSET_HOURS = 6
CR_TIMEZONE_OFFSET_MS = 6 * 3600 * 1000
```

**businessDate (`src/utils/businessDate.ts`):**
```typescript
getBusinessDateCRInfo({ scheduledAt, nowUtc, cutoffHour })
// Devuelve: { businessDate, businessDateISO, prefixYYMMDD }
// Regla: si hay sorteo.scheduledAt, se usa esa fecha en CR
//        si no, se aplica la hora de corte (default 06:00 CR)
//        → ventas ANTES del corte pertenecen al día ANTERIOR
```

**Rangos de fecha (`src/utils/dateRange.ts`):**
```typescript
resolveDateRange({ date: 'today' | 'yesterday' | 'week' | 'month' | 'year' | 'all' })
resolveDateRange({ fromDate: '2026-01-01', toDate: '2026-01-31' })
// Devuelve instantes UTC para usar directamente en queries Prisma
```

**Reglas:**
- La DB almacena timestamps como UTC
- `businessDate` es columna `DATE` (día de calendario en CR)
- NUNCA hacer aritmética de fechas sin usar las utilidades de CR
- Para filtros en queries: siempre usar rangos UTC convertidos desde CR

---

## Transacciones y raw SQL

**Patrón estándar:**
```typescript
// withTransactionRetry en src/repositories/helpers/
// Isolation: Serializable + backoff exponencial (250-600ms, max 3 reintentos)
await withTransactionRetry(async (tx) => {
  await tx.ticket.create({ ... });
  await tx.ticketCounter.update({ ... });
});
```

**Raw SQL (Prisma.$executeRaw / $queryRaw):**
```typescript
// Para listas parametrizadas SIEMPRE usar Prisma.join — NUNCA UNNEST en WHERE
import { Prisma } from '@prisma/client';

const idList = Prisma.join(ids.map(id => Prisma.sql`${id}::uuid`));
await tx.$executeRaw`DELETE FROM "Table" WHERE id IN (${idList})`;

// UNNEST está prohibido en WHERE/DELETE/UPDATE (PostgreSQL 0A000)
// Solo es válido en FROM/SELECT
```

**Conexiones:**
- `DATABASE_URL` (puerto 6543, pgbouncer) → requests web
- `DIRECT_URL` (puerto 5432, session pooler) → migraciones, cron jobs, scripts

---

## Comisiones

**Arquitectura jerárquica:**
```
User → Ventana → Banca (fallback en cascada)
```
- Las políticas se almacenan como JSON en el modelo correspondiente
- `CommissionService` resuelve cuál política aplica al contexto
- `CommissionResolver` calcula los montos a partir de la política
- `CommissionSnapshot` guarda la comisión inmutablemente en la `Jugada`
  - Permite cambiar políticas sin afectar histórico

**Tipos:**
- Comisión de listero: `commissionAmount` en `Jugada`
- Comisión de ventana: `listeroCommissionAmount` en `Jugada`
- Total del ticket: `totalCommission` en `Ticket`

---

## AccountStatements

**Estructura:**
- Un `AccountStatement` por (vendedor | ventana | banca) × día calendario
- Campos clave: `balance` (ventas−premios del día), `totalPaid`, `totalCollected`,
  `remainingBalance` (saldo acumulado real), `accumulatedBalance`

**Fórmula de saldo acumulativo:**
```
remainingBalance(día N) = remainingBalance(día N-1) + balance(N) + totalPaid(N) - totalCollected(N)
```

**Synthetic movement — NO está en DB, se crea en memoria en tiempo de query:**

Cuando se consulta `date=month`, el UI necesita mostrar el saldo arrastrado del mes
anterior como primera línea. Para no cambiar la estructura de la respuesta, ese valor
se inyecta como un movimiento ficticio en el día 1 del mes dentro del map
`movementsByDate`. Nunca se persiste en DB.

IDs del movimiento sintético según el servicio:
- `sorteo.service.ts` → `previous-month-balance-{vendedorId}`
- `accounts.service.ts` → `previous-month-balance-{dimension}-{entityId}`

Qué hace:
- **SE MUESTRA** en el UI como "Saldo del mes anterior"
- **SE INCLUYE** en el balance acumulado del día 1 (es el punto de partida del mes)
- **SE EXCLUYE** de `totalPaid` y `totalCollected` (diarios y mensuales)
- **SE EXCLUYE** de `totalSales`, `totalPrizes`, etc.

Patrón de exclusión obligatorio al sumar pagos/cobros:
```typescript
// Mínimo (sorteo.service.ts):
.filter(m => m.type === "payment" && !m.isReversed && !m.id?.startsWith('previous-month-balance-'))

// Robusto triple guardia (accounts.calculations.ts):
if (m.id?.startsWith('previous-month-balance-')) return false;
if (m.method === ACCOUNT_PREVIOUS_MONTH_METHOD) return false;
if (m.notes?.includes(ACCOUNT_CARRY_OVER_NOTES)) return false;
```

El bug de feb-2026 fue exactamente esto: el loop mensual en `sorteo.service.ts`
iteraba `movementsByDate` (ya mutado con el sintético) sin el filtro de ID.
Como `type = "payment"`, sumaba el saldo del mes anterior a `monthlyTotalPaid`.
Corregido en líneas ~2344 y ~2441 de `sorteo.service.ts`.

---

## Scripts de mantenimiento

Todos en `scripts/`. Requieren `DATABASE_URL` en el entorno.
Ejecutar con `npx tsx scripts/CARPETA/nombre.ts`.

Cada carpeta tiene su propio `INSTRUCCIONES.md` con uso detallado.

**Reglas de los scripts:**
- Scripts destructivos siempre tienen `--dry-run` (excepto los que lo indican)
- Los que tienen IDs hardcodeados lo dicen explícitamente
- Siempre revisar el INSTRUCCIONES.md antes de ejecutar

---

## Cron jobs

| Job | Descripción |
|---|---|
| `sorteosAuto.job.ts` | Auto abrir/crear/cerrar sorteos según `SorteosAutoConfig` |
| `accountStatementSettlement.job.ts` | Auto liquidar statements según `AccountStatementSettlementConfig` |
| `monthlyClosing.job.ts` | Cierre mensual (snapshot `MonthlyClosingBalance`) |
| `activityLogCleanup.job.ts` | Poda de logs de auditoría antiguos |

Usan `DIRECT_URL` (conexión directa, no pooler).

---

## Variables de entorno clave

```env
DATABASE_URL          # pgbouncer puerto 6543 (requests web)
DIRECT_URL            # session pooler puerto 5432 (migraciones/scripts)
JWT_ACCESS_SECRET     # Secret para access tokens
JWT_REFRESH_SECRET    # Secret para refresh tokens
CACHE_ENABLED         # true/false para Redis
REDIS_URL             # URL de Redis
BUSINESS_CUTOFF_HOUR_CR  # Hora de corte para businessDate (default: 06:00)
SALES_DAILY_MAX       # Límite diario de ventas global
SENTRY_DSN            # Monitoreo en producción
TRUST_PROXY           # Número de proxies (1 en Render/Heroku)
```

Schema de validación completo en `src/config/env.schema.ts`.

---

## Soft deletes

Todos los modelos principales tienen:
```typescript
deletedAt       DateTime?
deletedBy       String?   // userId que hizo el delete
deletedReason   String?
deletedByCascade Boolean?          // fue borrado en cascada
deletedByCascadeFrom String?       // nombre del modelo padre
deletedByCascadeId   String?       // id del registro padre
```
Los queries siempre filtran `deletedAt: null` por defecto.

---

## Gotchas y decisiones importantes

1. **UNNEST en WHERE está prohibido en PostgreSQL** — usar siempre `Prisma.join` con `IN`
2. **decimal.js para todo lo monetario** — nunca operar con `number` en cálculos de dinero
3. **businessDate ≠ createdAt** — el día de negocio puede ser distinto al día UTC del timestamp
4. **El synthetic movement del mes debe excluirse** — ver sección AccountStatements
5. **applyRbacFilters() es obligatorio** — nunca usar filtros del cliente directamente en queries
6. **Scripts destructivos esperan confirmación** — los importantes tienen `setTimeout` de 5s
7. **DIRECT_URL para scripts** — los scripts deben usar la conexión directa (puerto 5432)
8. **Multiplicadores pueden tener override** — siempre resolver via `MultiplierOverride` antes de aplicar base
9. **`isActive` ≠ `status`** — un sorteo puede tener `isActive=false` y `status=SCHEDULED` (estado inconsistente histórico, hay script para corregirlo)
10. **Pagos parciales en tickets** — `TicketPayment` soporta pagos parciales; el campo `remainingAmount` en `Ticket` rastrea cuánto queda
