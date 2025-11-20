# 📚 Indexación Profunda del Codebase - Backend Bancas

> **Documento de referencia completa** del sistema backend para gestión de bancas de lotería  
> **Versión del sistema**: v1.2.0  
> **Última actualización**: 2025-01-20

---

## 📋 Tabla de Contenidos

1. [Visión General](#visión-general)
2. [Arquitectura](#arquitectura)
3. [Estructura de Directorios](#estructura-de-directorios)
4. [Stack Tecnológico](#stack-tecnológico)
5. [Modelos de Datos](#modelos-de-datos)
6. [Capas de la Aplicación](#capas-de-la-aplicación)
7. [Endpoints Principales](#endpoints-principales)
8. [Flujos de Negocio](#flujos-de-negocio)
9. [Seguridad y Autenticación](#seguridad-y-autenticación)
10. [Sistemas Especializados](#sistemas-especializados)
11. [Utilidades y Helpers](#utilidades-y-helpers)
12. [Testing](#testing)
13. [Scripts y Herramientas](#scripts-y-herramientas)

---

## 🎯 Visión General

### Propósito
Sistema backend completo para la gestión integral de bancas de lotería, incluyendo:
- Gestión de ventas de tickets
- Administración de sorteos y loterías
- Sistema de comisiones jerárquico
- Control de acceso basado en roles (RBAC)
- Dashboard y analítica de ventas
- Estados de cuenta y pagos
- Auditoría completa de operaciones

### Características Principales
- ✅ Arquitectura por capas (Controller → Service → Repository)
- ✅ Validación estricta con Zod
- ✅ Transacciones seguras con reintentos automáticos
- ✅ Sistema de comisiones con políticas JSON configurables
- ✅ RBAC autoritario (nunca confía en parámetros del cliente)
- ✅ Auditoría completa con ActivityLog
- ✅ Manejo robusto de concurrencia
- ✅ Logging estructurado con Pino

---

## 🏗️ Arquitectura

### Patrón Arquitectónico
**Arquitectura por Capas (Layered Architecture)**

```
┌─────────────────────────────────────┐
│         HTTP Request                 │
└──────────────┬──────────────────────┘
               │
┌──────────────▼──────────────────────┐
│   Middleware Layer                  │
│   - Auth, Validation, CORS, Logging │
└──────────────┬──────────────────────┘
               │
┌──────────────▼──────────────────────┐
│   Controller Layer                  │
│   - HTTP handling, request/response  │
└──────────────┬──────────────────────┘
               │
┌──────────────▼──────────────────────┐
│   Service Layer                     │
│   - Business logic, validations     │
└──────────────┬──────────────────────┘
               │
┌──────────────▼──────────────────────┐
│   Repository Layer                  │
│   - Data access (Prisma)            │
└──────────────┬──────────────────────┘
               │
┌──────────────▼──────────────────────┐
│   Database (PostgreSQL)             │
└──────────────────────────────────────┘
```

### Principios de Diseño
1. **Separación de Responsabilidades**: Cada capa tiene un propósito único
2. **Inmutabilidad**: Snapshots de comisiones y multiplicadores en jugadas
3. **Idempotencia**: Operaciones críticas son idempotentes
4. **Fail-Safe**: Sistema de comisiones no bloquea ventas si hay errores
5. **Auditoría Total**: Todas las operaciones críticas se registran

---

## 📁 Estructura de Directorios

```
backend/
├── src/
│   ├── api/v1/                    # API REST v1
│   │   ├── controllers/           # Manejo HTTP (17 archivos)
│   │   ├── services/             # Lógica de negocio (17 archivos)
│   │   ├── repositories/        # Acceso a datos (11 archivos)
│   │   ├── routes/               # Definición de rutas (23 archivos)
│   │   ├── validators/           # Esquemas Zod (17 archivos)
│   │   ├── dto/                  # Data Transfer Objects (11 archivos)
│   │   ├── types/                # Tipos específicos de API
│   │   └── config/               # Configuración de API
│   │
│   ├── core/                     # Módulos centrales
│   │   ├── logger.ts            # Sistema de logging estructurado
│   │   ├── errors.ts            # Clases de error personalizadas
│   │   ├── prismaClient.ts      # Cliente Prisma singleton
│   │   ├── withTransactionRetry.ts  # Wrapper transaccional
│   │   ├── activity.service.ts  # Servicio de auditoría
│   │   └── types.ts              # Tipos Express extendidos
│   │
│   ├── middlewares/              # Middlewares Express
│   │   ├── auth.middleware.ts    # Autenticación JWT
│   │   ├── validate.middleware.ts # Validación Zod
│   │   ├── roleGuards.middleware.ts # Guards de roles
│   │   ├── rbac.middleware.ts    # RBAC filters
│   │   ├── cors.middleware.ts    # CORS configurable
│   │   ├── rateLimit.middleware.ts # Rate limiting
│   │   ├── error.middleware.ts   # Manejo global de errores
│   │   └── attachLogger.middleware.ts # Logger por request
│   │
│   ├── repositories/             # Capa de acceso a datos
│   │   ├── ticket.repository.ts
│   │   ├── sorteo.repository.ts
│   │   ├── user.repository.ts
│   │   ├── ventana.repository.ts
│   │   ├── banca.repository.ts
│   │   ├── restrictionRule.repository.ts
│   │   └── ...
│   │
│   ├── services/                 # Servicios compartidos
│   │   └── commission/          # Sistema de comisiones
│   │
│   ├── utils/                    # Utilidades
│   │   ├── rbac.ts              # Helpers RBAC
│   │   ├── businessDate.ts      # Fechas comerciales (CR)
│   │   ├── loteriaRules.ts      # Parser de rulesJson
│   │   ├── commissionCache.ts   # Cache de comisiones
│   │   ├── schedule.ts          # Generación de horarios
│   │   └── ...
│   │
│   ├── types/                    # Tipos TypeScript globales
│   │   ├── models.types.ts
│   │   ├── api.types.ts
│   │   └── commission.types.ts
│   │
│   ├── config/                   # Configuración
│   │   ├── index.ts             # Config centralizado
│   │   └── env.schema.ts        # Validación de env vars
│   │
│   ├── server/                   # Servidor Express
│   │   ├── app.ts               # Configuración Express
│   │   └── server.ts            # Inicio del servidor
│   │
│   ├── jobs/                     # Tareas programadas
│   │   └── activityLogCleanup.job.ts
│   │
│   ├── workers/                  # Workers de cola
│   │   └── queue.ts
│   │
│   └── tools/                    # Herramientas CLI
│       └── maintenance/         # Tareas de mantenimiento
│
├── prisma/
│   ├── schema.prisma            # Schema de base de datos
│   ├── migrations/              # Migraciones SQL
│   └── seed.ts                 # Datos iniciales
│
├── tests/                       # Tests unitarios e integración
│   ├── setup.ts
│   ├── tickets/
│   └── sorteos/
│
├── scripts/                     # Scripts de utilidad
│   ├── backfill-*.ts
│   ├── test-*.ts
│   └── ...
│
├── docs/                        # Documentación adicional
├── dist/                        # Build compilado
└── package.json
```

---

## 🛠️ Stack Tecnológico

### Runtime y Lenguaje
- **Node.js**: 20.x
- **TypeScript**: 5.9.3 (strict mode)
- **Compilador**: tsc (CommonJS)

### Framework y HTTP
- **Express.js**: 4.21.2
- **express-async-errors**: Manejo automático de errores async
- **helmet**: Seguridad HTTP
- **morgan**: Logging HTTP (dev)
- **cors**: Configuración CORS

### Base de Datos
- **PostgreSQL**: Base de datos relacional
- **Prisma**: 6.18.0
  - ORM y migraciones
  - Type-safe queries
  - Prisma Studio para administración

### Autenticación y Seguridad
- **jsonwebtoken**: JWT (Access + Refresh tokens)
- **bcryptjs**: Hash de contraseñas
- **express-rate-limit**: Rate limiting
- **dotenv-safe**: Validación de variables de entorno

### Validación
- **Zod**: 4.1.11
  - Validación de esquemas
  - Type inference automático
  - Validación estricta con `.strict()`

### Logging y Monitoreo
- **pino**: 10.0.0 - Logging estructurado
- **pino-pretty**: Formato legible en desarrollo
- **@sentry/node**: Monitoreo de errores (opcional)

### Utilidades
- **decimal.js**: Precisión decimal para cálculos financieros
- **uuid**: Generación de UUIDs
- **exceljs**: Exportación a Excel
- **pdfmake**: Generación de PDFs

### Testing
- **jest**: 30.2.0
- **ts-jest**: Compilador TypeScript para Jest
- **supertest**: Testing de APIs HTTP

### Desarrollo
- **nodemon**: Hot reload
- **ts-node**: Ejecución directa de TypeScript
- **dotenv-cli**: Manejo de múltiples .env
- **eslint**: Linting
- **prettier**: Formateo de código

---

## 🗄️ Modelos de Datos

### Entidades Principales

#### **Banca**
- Entidad raíz del sistema
- Define límites globales (`defaultMinBet`, `globalMaxPerNumber`)
- Política de comisiones (`commissionPolicyJson`)
- Relación 1:N con Ventanas

#### **Ventana**
- Pertenece a una Banca
- Define comisiones (`commissionMarginX`)
- Política de comisiones propia
- Relación 1:N con Usuarios (Vendedores)

#### **User**
- Roles: `ADMIN`, `VENTANA`, `VENDEDOR`
- Autenticación con JWT
- Política de comisiones personalizada
- Soft-delete habilitado

#### **Loteria**
- Configuración de lotería
- `rulesJson`: Reglas configurables (horarios, límites, tipos de apuesta)
- Multiplicadores asociados (`LoteriaMultiplier`)

#### **Sorteo**
- Estado: `SCHEDULED` → `OPEN` → `CLOSED` → `EVALUATED`
- `scheduledAt`: Fecha/hora UTC del sorteo
- `winningNumber`: Número ganador (2 dígitos)
- `extraMultiplierId`: Multiplicador REVENTADO aplicado
- Restricción única: `@@unique([loteriaId, scheduledAt])`

#### **Ticket**
- Número único generado secuencialmente
- `businessDate`: Fecha comercial (CR timezone)
- Estados: `ACTIVE`, `EVALUATED`, `PAID`, `CANCELLED`
- Campos de pago unificados:
  - `totalPayout`: Premios ganados
  - `totalPaid`: Pagado acumulado
  - `remainingAmount`: Pendiente
  - `totalCommission`: Comisiones totales

#### **Jugada**
- Pertenece a un Ticket
- Tipos: `NUMERO`, `REVENTADO`
- **Snapshots inmutables**:
  - `finalMultiplierX`: Multiplicador al momento de venta
  - `commissionPercent`: % de comisión aplicado
  - `commissionAmount`: Monto de comisión
  - `commissionOrigin`: Origen (USER/VENTANA/BANCA)
  - `commissionRuleId`: ID de regla aplicada

#### **RestrictionRule**
- Límites jerárquicos: User (100) > Ventana (10) > Banca (1)
- Campos:
  - `maxAmount`: Límite por número
  - `maxTotal`: Límite total por ticket
  - `salesCutoffMinutes`: Bloqueo por tiempo
  - `salesPercentage`: % de ventas permitido
  - `appliesToDate`, `appliesToHour`: Vigencia temporal

#### **LoteriaMultiplier**
- Multiplicadores configurables
- Tipos: `NUMERO`, `REVENTADO`
- `appliesToSorteoId`: Multiplicador específico por sorteo
- `appliesToDate`: Vigencia temporal

#### **MultiplierOverride**
- Overrides jerárquicos: USER, VENTANA
- `baseMultiplierX`: Multiplicador personalizado
- Clave única: `[scope, userId, ventanaId, loteriaId, multiplierType]`

#### **AccountStatement**
- Estado de cuenta diario
- Dimensiones: `ventana` o `vendedor`
- Campos:
  - `totalSales`: Ventas del día
  - `totalPayouts`: Premios pagados
  - `balance`: Saldo neto
  - `isSettled`: Si está saldado

#### **AccountPayment**
- Pagos/cobros asociados a AccountStatement
- Tipos: `payment`, `collection`
- Métodos: `cash`, `transfer`, `check`
- Soporte para reversión

#### **ActivityLog**
- Auditoría completa del sistema
- Campos: `userId`, `action`, `targetType`, `targetId`, `details`
- Tipos de acción: `TICKET_CREATE`, `SORTEO_EVALUATE`, etc.

### Relaciones Clave

```
Banca (1) ──< (N) Ventana (1) ──< (N) User
                                      │
                                      │ (vendedorId)
                                      ▼
Loteria (1) ──< (N) Sorteo (1) ──< (N) Ticket (1) ──< (N) Jugada
                                      │
                                      │ (ventanaId)
                                      ▼
                                   Ventana
```

---

## 🎭 Capas de la Aplicación

### 1. Controllers (`src/api/v1/controllers/`)

**Responsabilidad**: Manejo de peticiones HTTP, validación de entrada, respuesta HTTP

**Patrón**:
```typescript
async function create(req: AuthenticatedRequest, res: Response) {
  const data = req.body; // Ya validado por middleware
  const result = await service.create(data, req.user);
  return success(res, result);
}
```

**Archivos principales**:
- `ticket.controller.ts`: CRUD de tickets, pagos
- `sorteo.controller.ts`: Gestión de sorteos, evaluación
- `venta.controller.ts`: Endpoints de ventas y resúmenes
- `dashboard.controller.ts`: Dashboard y métricas
- `accounts.controller.ts`: Estados de cuenta
- `auth.controller.ts`: Login, refresh tokens
- `user.controller.ts`: CRUD de usuarios
- `cierre.controller.ts`: Cierres operativos

### 2. Services (`src/api/v1/services/`)

**Responsabilidad**: Lógica de negocio, validaciones de dominio, orquestación

**Características**:
- Validaciones de negocio complejas
- Resolución de comisiones
- Aplicación de reglas de restricción
- Cálculos financieros
- Coordinación entre repositorios

**Archivos principales**:
- `ticket.service.ts`: Creación de tickets, validaciones, comisiones
- `sorteo.service.ts`: Gestión de ciclo de vida de sorteos
- `venta.service.ts`: Agregaciones y resúmenes de ventas
- `dashboard.service.ts`: Cálculo de métricas y KPIs
- `commissions.service.ts`: Gestión de políticas de comisión
- `accounts.service.ts`: Cálculo de estados de cuenta

### 3. Repositories (`src/repositories/`)

**Responsabilidad**: Acceso a datos con Prisma, queries optimizadas, sin lógica de negocio

**Patrón**:
```typescript
async function create(tx: Prisma.TransactionClient, data: CreateData) {
  return await tx.ticket.create({ data });
}
```

**Características**:
- Reciben `TransactionClient` para transacciones
- Queries optimizadas con `select`
- Índices apropiados para performance
- Sin lógica de negocio

**Archivos principales**:
- `ticket.repository.ts`: CRUD de tickets, queries complejas
- `sorteo.repository.ts`: Gestión de sorteos
- `user.repository.ts`: Queries de usuarios
- `restrictionRule.repository.ts`: Resolución jerárquica de reglas

### 4. Middlewares (`src/middlewares/`)

**Responsabilidad**: Cross-cutting concerns (auth, validación, logging, errores)

**Middlewares principales**:

#### `auth.middleware.ts`
- `protect`: Verifica JWT, extrae usuario
- `restrictTo`: Restringe por roles
- `restrictToAdminOrSelf`: Admin o propio usuario
- `restrictToAdminSelfOrVentanaVendor`: Admin, self, o vendedor de ventana

#### `validate.middleware.ts`
- `validateBody`: Valida body con Zod
- `validateQuery`: Valida query params
- `validateParams`: Valida route params
- Emite `AppError` con detalles estructurados

#### `error.middleware.ts`
- Manejo global de errores
- Convierte `AppError` a respuesta HTTP
- Logging de errores no manejados

#### `rbac.middleware.ts` / `utils/rbac.ts`
- `applyRbacFilters`: Aplica filtros según rol
- `validateVentanaUser`: Valida y obtiene ventanaId desde BD si falta en JWT

### 5. Core (`src/core/`)

**Módulos centrales críticos**:

#### `logger.ts`
- Logging estructurado con Pino
- Formato: `{ layer, action, userId, requestId, payload, meta }`
- Niveles: info, warn, error, debug

#### `errors.ts`
- `AppError`: Error operacional con statusCode y meta
- Extiende Error nativo
- Stack trace preservado

#### `prismaClient.ts`
- Cliente Prisma singleton
- Configuración de logging
- Conexión a PostgreSQL

#### `withTransactionRetry.ts`
- Wrapper para transacciones con reintentos
- Maneja deadlocks (P2034), timeouts, conflictos
- Backoff exponencial acotado
- Configurable por operación

#### `activity.service.ts`
- Servicio de auditoría centralizado
- Registra acciones en `ActivityLog`
- Contexto completo (userId, requestId, detalles)

---

## 🛣️ Endpoints Principales

### Autenticación
```
POST   /api/v1/auth/login          # Login (access + refresh tokens)
POST   /api/v1/auth/refresh        # Renovar access token
POST   /api/v1/auth/logout         # Revocar refresh token
```

### Tickets
```
POST   /api/v1/tickets             # Crear ticket
GET    /api/v1/tickets             # Listar (con filtros RBAC)
GET    /api/v1/tickets/:id         # Obtener por ID
POST   /api/v1/tickets/:id/pay     # Registrar pago
POST   /api/v1/tickets/:id/reverse-payment  # Revertir pago
DELETE /api/v1/tickets/:id         # Cancelar (soft-delete)
```

### Sorteos
```
POST   /api/v1/sorteos             # Crear sorteo
GET    /api/v1/sorteos             # Listar (con búsqueda)
GET    /api/v1/sorteos/:id         # Obtener por ID
PATCH  /api/v1/sorteos/:id         # Actualizar (name, scheduledAt, isActive)
PATCH  /api/v1/sorteos/:id/open    # Abrir sorteo (SCHEDULED → OPEN)
PATCH  /api/v1/sorteos/:id/close   # Cerrar sorteo (OPEN → CLOSED)
PATCH  /api/v1/sorteos/:id/evaluate # Evaluar (ganador + REVENTADO)
DELETE /api/v1/sorteos/:id         # Soft-delete
```

### Loterías
```
POST   /api/v1/loterias            # Crear lotería
GET    /api/v1/loterias            # Listar
GET    /api/v1/loterias/:id        # Obtener por ID
PATCH  /api/v1/loterias/:id        # Actualizar
GET    /api/v1/loterias/:id/preview_schedule  # Preview de agenda
POST   /api/v1/loterias/:id/seed_sorteos     # Crear sorteos desde reglas
DELETE /api/v1/loterias/:id        # Soft-delete
```

### Ventas y Analytics
```
GET    /api/v1/ventas/summary      # Resumen de ventas
GET    /api/v1/ventas/breakdown    # Desglose por dimensión
GET    /api/v1/ventas/timeseries   # Series temporales
GET    /api/v1/admin/dashboard      # Dashboard principal
GET    /api/v1/admin/dashboard/timeseries  # Series temporales
GET    /api/v1/admin/dashboard/exposure    # Análisis de exposición
```

### Comisiones
```
PUT    /api/v1/bancas/:id/commission-policy      # Actualizar política (Banca)
GET    /api/v1/bancas/:id/commission-policy      # Obtener política
PUT    /api/v1/ventanas/:id/commission-policy    # Actualizar política (Ventana)
GET    /api/v1/ventanas/:id/commission-policy     # Obtener política
PUT    /api/v1/users/:id/commission-policy       # Actualizar política (Usuario)
GET    /api/v1/users/:id/commission-policy       # Obtener política
```

### Estados de Cuenta
```
GET    /api/v1/accounts/statement   # Estado de cuenta
POST   /api/v1/accounts/payment    # Registrar pago/cobro
POST   /api/v1/accounts/payment/:id/reverse  # Revertir pago
```

### Restricciones
```
POST   /api/v1/restrictions         # Crear (soporta array de números)
GET    /api/v1/restrictions         # Listar
PATCH  /api/v1/restrictions/:id    # Actualizar
DELETE /api/v1/restrictions/:id     # Eliminar
```

### Usuarios
```
POST   /api/v1/users                # Crear usuario
GET    /api/v1/users                # Listar
GET    /api/v1/users/:id            # Obtener por ID
PATCH  /api/v1/users/:id           # Actualizar
DELETE /api/v1/users/:id           # Soft-delete
```

---

## 🔄 Flujos de Negocio

### 1. Creación de Ticket

```
1. Request → Controller
2. Middleware: Auth + Validation
3. Controller → Service.create()
4. Service:
   a. Validar sorteo está OPEN
   b. Resolver base multiplier X (jerarquía)
   c. Resolver sales cutoff (jerarquía)
   d. Validar jugadas contra rulesJson
   e. Resolver comisiones (USER → VENTANA → BANCA)
   f. Obtener número de ticket (secuencial)
   g. Validar límites diarios
5. Repository (en transacción):
   a. Crear ticket
   b. Crear jugadas (con snapshots)
   c. Actualizar contadores
6. ActivityLog.create (async)
7. Response con ticket creado
```

**Transaccionalidad**: Todo en `withTransactionRetry` para evitar overselling

### 2. Evaluación de Sorteo

```
1. PATCH /sorteos/:id/evaluate
2. Validar: sorteo existe, está CLOSED o EVALUATED
3. Validar: winningNumber (2 dígitos)
4. Si hay REVENTADO ganador:
   a. Validar extraMultiplierId (tipo REVENTADO, activo)
   b. Snapshot extraMultiplierX en sorteo
5. Actualizar sorteo:
   - status = EVALUATED
   - winningNumber
   - extraMultiplierId, extraMultiplierX
6. Evaluar todas las jugadas:
   - Marcar ganadoras/perdedoras
   - Calcular payout (amount × finalMultiplierX)
   - Para REVENTADO: aplicar extraMultiplierX si aplica
7. Actualizar tickets:
   - isWinner, status = EVALUATED
   - totalPayout
8. ActivityLog.create (SORTEO_EVALUATE)
```

### 3. Resolución de Comisiones

```
Prioridad: USER → VENTANA → BANCA

Para cada jugada:
1. Obtener políticas JSON (User, Ventana, Banca)
2. Parsear políticas (con fallback a 0% si malformadas)
3. Buscar regla matching:
   - loteriaId coincide (o null = comodín)
   - betType coincide (o null = comodín)
   - finalMultiplierX en [min, max]
4. Primera regla que calza gana
5. Si no hay match: usar defaultPercent
6. Calcular commissionAmount = amount × percent / 100
7. Snapshot en jugada:
   - commissionPercent
   - commissionAmount
   - commissionOrigin
   - commissionRuleId
```

### 4. Resolución de Restricciones

```
Prioridad: User (100) > Ventana (10) > Banca (1)

Para cada restricción aplicable:
1. Filtrar por:
   - scope (userId, ventanaId, bancaId)
   - loteriaId (si aplica)
   - multiplierId (si aplica)
   - number (si aplica)
   - appliesToDate, appliesToHour (vigencia)
   - isActive = true
2. Ordenar por prioridad (User > Ventana > Banca)
3. Aplicar primera regla encontrada
4. Validar contra límites:
   - maxAmount por número
   - maxTotal por ticket
   - salesCutoffMinutes (tiempo)
   - salesPercentage (% de ventas)
```

### 5. Generación de Sorteos desde Reglas

```
1. GET /loterias/:id/preview_schedule
   - Calcular ocurrencias desde rulesJson.drawSchedule
   - Respuesta: array de fechas UTC (sin crear en BD)

2. POST /loterias/:id/seed_sorteos
   - Calcular ocurrencias
   - Filtrar duplicados (loteriaId, scheduledAt)
   - createMany({ skipDuplicates: true })
   - Respuesta: { created, skipped, alreadyExists }
```

---

## 🔐 Seguridad y Autenticación

### Autenticación JWT

**Tokens**:
- **Access Token**: Corta duración (15m por defecto)
- **Refresh Token**: Larga duración (7d), revocable

**Payload del JWT**:
```typescript
{
  sub: string;        // userId
  role: Role;         // ADMIN | VENTANA | VENDEDOR
  ventanaId?: string; // Opcional (para VENTANA)
}
```

**Flujo**:
1. Login → Access + Refresh tokens
2. Requests → Header: `Authorization: Bearer <access_token>`
3. Access expirado → Refresh endpoint con refresh token
4. Logout → Revocar refresh token en BD

### RBAC (Role-Based Access Control)

**Principio**: El backend **nunca confía** en parámetros del cliente

**Reglas por Rol**:

#### VENDEDOR
- Solo ve sus propios tickets
- Ignora `scope` parameter
- Filtro automático: `vendedorId = userId`

#### VENTANA
- Solo ve tickets de su ventana
- Ignora `scope` parameter
- Filtro automático: `ventanaId = JWT.ventanaId`
- Si falta `ventanaId` en JWT → fetch desde BD
- Puede ver vendedores de su ventana

#### ADMIN
- Acceso total
- Respeta `scope` parameter
- Puede filtrar por cualquier `ventanaId`/`vendedorId`

**Implementación**:
- `applyRbacFilters()` en `src/utils/rbac.ts`
- Se aplica en servicios antes de queries
- Logging de filtros aplicados

### Rate Limiting

- Configurado en `rateLimit.middleware.ts`
- Basado en IP (con `trust proxy`)
- Límites configurables por endpoint

### Validación de Entrada

- **Zod schemas** en `validators/`
- Middleware `validateBody/Query/Params`
- Rechaza claves extra con `.strict()`
- Errores estructurados con detalles

### Protección de Rutas

- `protect`: Requiere autenticación
- `restrictTo(...roles)`: Restringe por roles
- `restrictToAdminOrSelf`: Admin o propio usuario
- Guards personalizados según necesidad

---

## 🎯 Sistemas Especializados

### 1. Sistema de Comisiones

**Arquitectura**:
- Políticas JSON configurables por User/Ventana/Banca
- Prioridad jerárquica: USER → VENTANA → BANCA
- Snapshot inmutable en cada jugada

**Estructura de Política**:
```json
{
  "version": 1,
  "effectiveFrom": "2025-01-01T00:00:00.000Z",
  "effectiveTo": "2025-12-31T23:59:59.999Z",
  "defaultPercent": 5.0,
  "rules": [
    {
      "id": "uuid-auto",
      "loteriaId": "uuid" | null,
      "betType": "NUMERO" | "REVENTADO" | null,
      "multiplierRange": { "min": 70, "max": 100 },
      "percent": 8.5
    }
  ]
}
```

**Matching**:
- Primera regla que calza gana
- Criterios: loteriaId, betType, multiplierRange
- Fallback: `defaultPercent` si no hay match

**Archivos clave**:
- `src/services/commission.resolver.ts`: Resolución jerárquica
- `src/api/v1/services/commissions.service.ts`: CRUD de políticas
- `src/utils/commissionCache.ts`: Cache de políticas

### 2. Sistema de Restricciones

**Jerarquía de Prioridad**:
- User: 100 (más alta)
- Ventana: 10
- Banca: 1 (más baja)

**Tipos de Restricción**:
- `maxAmount`: Límite por número
- `maxTotal`: Límite total por ticket
- `salesCutoffMinutes`: Bloqueo por tiempo antes del sorteo
- `salesPercentage`: % de ventas permitido

**Vigencia Temporal**:
- `appliesToDate`: Fecha específica
- `appliesToHour`: Hora específica
- `isAutoDate`: Auto-activación por fecha

**Soporte para Arrays**:
- `POST /restrictions` acepta `number: string | string[]`
- Crea múltiples restricciones en una operación

**Archivos clave**:
- `src/repositories/restrictionRule.repository.ts`: Resolución jerárquica
- `src/api/v1/services/restrictionRule.service.ts`: Lógica de negocio

### 3. Sistema de Multiplicadores

**Resolución de Base Multiplier X** (para NUMERO):
1. `UserMultiplierOverride.baseMultiplierX`
2. `BancaLoteriaSetting.baseMultiplierX`
3. `LoteriaMultiplier` activo con `name="Base"` o primer `kind="NUMERO"`
4. `Loteria.rulesJson.baseMultiplierX`
5. `process.env.MULTIPLIER_BASE_DEFAULT_X`

**Snapshot**:
- `finalMultiplierX` se congela en jugada al momento de venta
- Para REVENTADO: se aplica `extraMultiplierX` al evaluar

**Archivos clave**:
- `src/repositories/ticket.repository.ts`: `resolveBaseMultiplierX()`
- `src/api/v1/services/multiplier.service.ts`: CRUD de multiplicadores

### 4. Sistema de Dashboard y Analytics

**Endpoints**:
- `/admin/dashboard`: KPIs principales
- `/admin/dashboard/timeseries`: Series temporales
- `/admin/dashboard/exposure`: Análisis de exposición
- `/ventas/summary`: Resumen de ventas
- `/ventas/breakdown`: Desglose por dimensión

**Métricas**:
- Ventas: totalSales, totalTickets, avgTicketAmount
- Premios: totalPayout, totalWinners, netRevenue
- Comisiones: totalCommissions, netAfterCommission
- CXC: totalAmount, overdueAmount, oldestDays
- Pagos: totalPaid, remainingAmount, paidCount

**RBAC Automático**:
- Filtrado automático por rol
- Comparación periódica (`compare=true`)
- Alertas automáticas

**Archivos clave**:
- `src/api/v1/services/dashboard.service.ts`: Cálculo de métricas
- `src/api/v1/services/venta.service.ts`: Agregaciones de ventas

### 5. Sistema de Estados de Cuenta

**AccountStatement**:
- Estado diario por ventana o vendedor
- Campos: totalSales, totalPayouts, balance, isSettled
- Cálculo automático desde tickets y jugadas

**AccountPayment**:
- Pagos/cobros asociados
- Tipos: `payment`, `collection`
- Métodos: `cash`, `transfer`, `check`
- Soporte para reversión

**Archivos clave**:
- `src/repositories/accountStatement.repository.ts`
- `src/api/v1/services/accounts.service.ts`

### 6. Sistema de Auditoría

**ActivityLog**:
- Registra todas las operaciones críticas
- Campos: userId, action, targetType, targetId, details
- Contexto completo: requestId, layer, payload

**Tipos de Acción**:
- `TICKET_CREATE`, `TICKET_CANCEL`, `TICKET_PAY`
- `SORTEO_CREATE`, `SORTEO_EVALUATE`, `SORTEO_OPEN`
- `LOTERIA_CREATE`, `LOTERIA_UPDATE`
- `USER_CREATE`, `USER_UPDATE`
- Y más...

**Archivos clave**:
- `src/core/activity.service.ts`: Servicio centralizado
- `src/repositories/activityLog.repository.ts`: Queries

---

## 🧰 Utilidades y Helpers

### `src/utils/rbac.ts`
- `applyRbacFilters()`: Aplica filtros según rol
- `validateVentanaUser()`: Valida y obtiene ventanaId

### `src/utils/businessDate.ts`
- `getBusinessDate()`: Fecha comercial (CR timezone)
- `getBusinessDateRange()`: Rango de fechas comerciales

### `src/utils/loteriaRules.ts`
- `parseRulesJson()`: Parser de rulesJson
- `validateBetType()`: Validación de tipos de apuesta
- `getNumberRange()`: Obtener rango de números permitido

### `src/utils/schedule.ts`
- `computeOccurrences()`: Genera fechas desde drawSchedule
- Manejo de timezone (CR → UTC)

### `src/utils/commissionCache.ts`
- Cache de políticas de comisión
- Evita queries repetidas

### `src/utils/commissionPrecalc.ts`
- Pre-cálculo de comisiones
- Optimización de queries

### `src/utils/datetime.ts`
- Helpers de fecha/hora
- Conversiones de timezone

### `src/utils/pagination.ts`
- Helpers de paginación
- Cálculo de skip/limit

### `src/utils/responses.ts`
- `success()`: Respuesta exitosa estandarizada
- `error()`: Respuesta de error estandarizada

---

## 🧪 Testing

### Estructura
```
tests/
├── setup.ts                    # Configuración global
├── helpers/
│   └── testIds.ts             # IDs de prueba
├── tickets/
│   ├── ticket.businessDate.test.ts
│   ├── concurrency.test.ts
│   └── restrictionRules.test.ts
└── sorteos/
    ├── sorteo.evaluate.test.ts
    ├── sorteo.evaluate.guards.test.ts
    ├── sorteo.update.guards.test.ts
    └── sorteo.lifecycle.test.ts
```

### Configuración
- **Jest**: Configurado con `ts-jest`
- **Base de datos**: `.env.test` separado
- **Supertest**: Testing de endpoints HTTP

### Tests Principales
- ✅ Concurrencia de tickets (prevención de overselling)
- ✅ Restricciones jerárquicas
- ✅ Evaluación de sorteos
- ✅ Guards de actualización
- ✅ Ciclo de vida de sorteos

### Comandos
```bash
npm test              # Ejecutar todos los tests
npm run test:watch    # Modo watch
npm run test:coverage # Con cobertura
```

---

## 📜 Scripts y Herramientas

### Scripts NPM

**Desarrollo**:
```bash
npm run dev              # Desarrollo con nodemon
npm run build            # Compilar TypeScript
npm run typecheck        # Verificar tipos sin compilar
```

**Prisma**:
```bash
npm run prisma:generate  # Generar Prisma Client
npm run migrate:dev      # Migración de desarrollo
npm run migrate:deploy   # Aplicar migraciones (producción)
npm run studio           # Abrir Prisma Studio
```

**Testing**:
```bash
npm run test             # Ejecutar tests
npm run test:watch       # Modo watch
npm run test:coverage    # Con cobertura
```

**Mantenimiento**:
```bash
npm run maintenance      # Herramientas de mantenimiento
```

### Scripts de Utilidad (`scripts/`)

**Backfill**:
- `backfillAccountStatements.ts`: Recalcular estados de cuenta
- `backfill-ticket-isactive.ts`: Actualizar flags isActive

**Testing/Debug**:
- `test-exposure.js`: Probar análisis de exposición
- `test-accounts-endpoint.ts`: Probar endpoints de cuentas
- `debugAccountStatements.ts`: Debug de estados de cuenta

**Migraciones**:
- `aplicar_migracion_sales_percentage.ts`: Aplicar migración de porcentajes
- `ejecutar_migracion_cron.ts`: Migraciones programadas

**Limpieza**:
- `purgeTickets.js`: Eliminar tickets antiguos
- `delete-orphaned-jugadas.js`: Eliminar jugadas huérfanas

### Herramientas de Mantenimiento (`src/tools/maintenance/`)

**Tareas disponibles**:
- `reapplyCommissions`: Re-aplicar comisiones
- `purgeTickets`: Eliminar tickets antiguos
- `processTickets`: Procesar tickets pendientes
- `clonePolicies`: Clonar políticas

**Uso**:
```bash
npm run maintenance -- --task=reapplyCommissions --from=2025-01-01 --to=2025-01-31
```

---

## 📊 Convenciones y Patrones

### Naming Conventions

**Archivos**:
- Controllers: `*.controller.ts`
- Services: `*.service.ts`
- Repositories: `*.repository.ts`
- Validators: `*.validator.ts`
- DTOs: `*.dto.ts`
- Routes: `*.routes.ts`

**Funciones**:
- Controllers: verbos HTTP (`create`, `list`, `get`, `update`, `delete`)
- Services: acciones de negocio (`createTicket`, `evaluateSorteo`)
- Repositories: operaciones CRUD (`create`, `findById`, `update`)

### Estructura de Respuestas

**Éxito**:
```typescript
success(res, data, meta?)
// Responde: { success: true, data, meta }
```

**Error**:
```typescript
throw new AppError(message, statusCode, meta)
// Middleware convierte a: { success: false, error: { message, ...meta } }
```

### Manejo de Transacciones

**Patrón**:
```typescript
await withTransactionRetry(async (tx) => {
  // Operaciones en transacción
  const ticket = await ticketRepo.create(tx, data);
  await jugadaRepo.createMany(tx, jugadas);
  return ticket;
});
```

### Logging

**Estructura**:
```typescript
logger.info({
  layer: 'service',
  action: 'TICKET_CREATE',
  userId: req.user.id,
  requestId: req.requestId,
  payload: { ticketId, totalAmount },
  meta: { commissionOrigin: 'USER' }
});
```

### Validación

**Patrón**:
```typescript
// En routes
router.post('/tickets', 
  protect,
  validateBody(CreateTicketSchema),
  ticketController.create
);
```

---

## 🔧 Configuración

### Variables de Entorno

**Requeridas**:
```bash
DATABASE_URL=postgresql://...
JWT_ACCESS_SECRET=...
JWT_REFRESH_SECRET=...
```

**Opcionales**:
```bash
PORT=4000
NODE_ENV=development
LOG_LEVEL=info
DISABLE_AUTH=false
MULTIPLIER_BASE_DEFAULT_X=95
CORS_ORIGIN=http://localhost:3000
TRUST_PROXY=1
TX_MAX_RETRIES=3
TX_BACKOFF_MIN_MS=150
TX_BACKOFF_MAX_MS=2000
```

### Configuración de Prisma

- **Provider**: PostgreSQL
- **URL**: Desde `DATABASE_URL`
- **Direct URL**: Desde `DIRECT_URL` (para migraciones)
- **Shadow Database**: Opcional para validación

### Configuración de TypeScript

- **Target**: ES2020
- **Module**: CommonJS
- **Strict**: true
- **Source Maps**: Habilitado
- **Declarations**: Habilitado

---

## 📈 Métricas y Performance

### Optimizaciones

1. **Índices de Base de Datos**:
   - Índices en campos frecuentemente consultados
   - Índices GIN para búsqueda de texto (trgm)
   - Índices compuestos para queries comunes

2. **Queries Optimizadas**:
   - Uso de `select` para campos específicos
   - Evitar `include` innecesarios
   - Paginación en listados grandes

3. **Cache**:
   - Cache de políticas de comisión
   - Cache de multiplicadores

4. **Transacciones**:
   - Reintentos automáticos para deadlocks
   - Timeouts configurables
   - Aislamiento Serializable

### Monitoreo

- **Logging estructurado**: Pino con niveles configurables
- **Sentry**: Opcional para tracking de errores
- **ActivityLog**: Auditoría completa de operaciones

---

## 🚀 Despliegue

### Build

```bash
npm run build          # Compilar TypeScript
npm run prisma:generate # Generar Prisma Client
```

### Migraciones

```bash
npm run migrate:deploy  # Aplicar migraciones pendientes
```

### Inicio

```bash
npm start              # Ejecutar dist/index.js
```

### Health Check

```
GET /api/v1/healthz    # Retorna { status: 'ok' }
```

---

## 📝 Notas Adicionales

### Timezone

- **Base de datos**: UTC
- **Cálculos internos**: UTC
- **Display**: Conversión a hora local (CR = GMT-6)
- **Business Date**: Basado en hora local de CR

### Soft Delete

- La mayoría de entidades soportan soft-delete
- Campos: `deletedAt`, `deletedBy`, `deletedReason`
- Queries por defecto excluyen eliminados
- Endpoint `restore` disponible para restaurar

### Idempotencia

- Operaciones críticas son idempotentes
- `idempotencyKey` en pagos
- `createMany({ skipDuplicates: true })` en sorteos

### Concurrencia

- `withTransactionRetry` maneja deadlocks
- Secuencias atómicas para números de ticket
- Validaciones dentro de transacciones

---

## 🔗 Referencias

- **README.md**: Documentación principal del proyecto
- **CHANGELOG.md**: Historial de cambios
- **docs/**: Documentación adicional por módulo
- **prisma/schema.prisma**: Schema completo de base de datos

---

---

## 📊 Estadísticas del Codebase

### Archivos por Tipo
- **Controllers**: 17 archivos
- **Services**: 17 archivos  
- **Repositories**: 11 archivos
- **Routes**: 23 archivos
- **Validators**: 17 archivos
- **DTOs**: 11 archivos
- **Middlewares**: 10 archivos
- **Utils**: 14 archivos
- **Tests**: 9 archivos
- **Scripts**: 50+ archivos de utilidad

### Modelos de Base de Datos
- **Entidades principales**: 20 modelos
- **Enums**: 6 enums (Role, TicketStatus, SorteoStatus, BetType, etc.)
- **Relaciones**: 30+ relaciones definidas
- **Índices**: 50+ índices para optimización

### Endpoints API
- **Total de endpoints**: 80+ endpoints REST
- **Versión API**: v1
- **Autenticación**: JWT (Access + Refresh)
- **Rate Limiting**: Configurado por endpoint

---

## 🔍 Análisis de Dependencias

### Dependencias Principales
```json
{
  "runtime": {
    "@prisma/client": "^6.18.0",
    "express": "^4.21.2",
    "jsonwebtoken": "^9.0.2",
    "zod": "^4.1.11",
    "pino": "^10.0.0"
  },
  "security": {
    "bcryptjs": "^2.4.3",
    "helmet": "^8.1.0",
    "express-rate-limit": "^8.1.0"
  },
  "utilities": {
    "decimal.js": "^10.6.0",
    "uuid": "^13.0.0",
    "exceljs": "^4.4.0",
    "pdfmake": "^0.2.20"
  }
}
```

### Arquitectura de Dependencias
```
Express App
├── Middlewares (Auth, Validation, CORS, Rate Limit)
├── Routes (v1)
│   ├── Controllers
│   │   └── Services
│   │       └── Repositories
│   │           └── Prisma Client
│   │               └── PostgreSQL
│   └── Validators (Zod)
└── Core Modules
    ├── Logger (Pino)
    ├── Error Handler
    ├── Activity Service
    └── Transaction Retry
```

---

## 🎨 Patrones de Diseño Implementados

### 1. Repository Pattern
- **Ubicación**: `src/repositories/`
- **Propósito**: Abstracción de acceso a datos
- **Características**:
  - Recibe `TransactionClient` para transacciones
  - Sin lógica de negocio
  - Queries optimizadas

### 2. Service Layer Pattern
- **Ubicación**: `src/api/v1/services/`
- **Propósito**: Lógica de negocio centralizada
- **Características**:
  - Orquestación entre repositorios
  - Validaciones de dominio
  - Cálculos complejos

### 3. Middleware Pattern
- **Ubicación**: `src/middlewares/`
- **Propósito**: Cross-cutting concerns
- **Características**:
  - Composición funcional
  - Reutilizable
  - Orden de ejecución crítico

### 4. Strategy Pattern (Comisiones)
- **Ubicación**: `src/services/commission.resolver.ts`
- **Propósito**: Resolución jerárquica de políticas
- **Características**:
  - Prioridad: USER → VENTANA → BANCA
  - Matching de reglas flexible
  - Fallback graceful

### 5. Retry Pattern (Transacciones)
- **Ubicación**: `src/core/withTransactionRetry.ts`
- **Propósito**: Manejo robusto de concurrencia
- **Características**:
  - Backoff exponencial
  - Detección de deadlocks
  - Logging por intento

---

## 🔐 Seguridad Detallada

### Autenticación JWT

**Estructura del Token**:
```typescript
{
  sub: string;           // userId (UUID)
  role: Role;           // ADMIN | VENTANA | VENDEDOR
  ventanaId?: string;   // Opcional (para VENTANA)
  iat: number;          // Issued at
  exp: number;          // Expiration
}
```

**Validación**:
- Firma verificada con `JWT_ACCESS_SECRET`
- Expiración verificada automáticamente
- Payload validado (sub y role requeridos)

**Refresh Token**:
- Almacenado en BD (`RefreshToken` table)
- Revocable por logout
- UUID v4 + JWT firmado

### RBAC Implementation

**Flujo de Validación**:
```
1. Request con JWT
2. Middleware `protect` extrae usuario
3. Middleware `restrictTo` valida rol
4. Service aplica `applyRbacFilters()`
5. Repository ejecuta query filtrada
```

**Reglas de Filtrado**:
- **VENDEDOR**: `WHERE vendedorId = userId`
- **VENTANA**: `WHERE ventanaId = JWT.ventanaId` (fetch desde BD si falta)
- **ADMIN**: Sin filtro (o según `scope` parameter)

### Rate Limiting

**Configuración**:
- Basado en IP (con `trust proxy`)
- Límites configurables por endpoint
- Window: 15 minutos por defecto
- Max requests: Variable según endpoint

### Validación de Entrada

**Zod Schemas**:
- Validación estricta con `.strict()`
- Type inference automático
- Errores estructurados con detalles
- Transformaciones automáticas (UUIDs, fechas)

---

## 📈 Performance y Optimización

### Optimizaciones de Base de Datos

**Índices Estratégicos**:
```sql
-- Búsqueda de texto (GIN con trgm)
CREATE INDEX idx_ventana_name_trgm ON "Ventana" USING gin(name gin_trgm_ops);

-- Queries frecuentes
CREATE INDEX idx_ticket_sorteo_vendedor ON "Ticket"(sorteoId, vendedorId, createdAt);

-- Unicidad
CREATE UNIQUE INDEX "Sorteo_loteriaId_scheduledAt_key" ON "Sorteo"(loteriaId, scheduledAt);
```

**Queries Optimizadas**:
- Uso de `select` para campos específicos
- Evitar `include` innecesarios
- Paginación en listados grandes
- CTEs para subqueries complejas

### Caching Strategy

**Comisiones**:
- Cache de políticas JSON parseadas
- Cache de multiplicadores activos
- Invalidación manual cuando cambian políticas

**Multiplicadores**:
- Cache en memoria durante creación de ticket
- Lookup optimizado con Map

### Transacciones

**Configuración**:
- Isolation Level: Serializable (por defecto)
- Max Retries: 3
- Backoff: 150ms - 2000ms (exponencial)
- Timeout: 20s

---

## 🧩 Módulos Especializados Detallados

### Sistema de Comisiones

**Resolución Jerárquica**:
```typescript
// Prioridad: USER → VENTANA → BANCA
const userPolicy = parseCommissionPolicy(user.commissionPolicyJson, "USER");
if (userPolicy) {
  const match = findMatchingRule(userPolicy, input);
  if (match) return { origin: "USER", ...match };
}

const ventanaPolicy = parseCommissionPolicy(ventana.commissionPolicyJson, "VENTANA");
if (ventanaPolicy) {
  const match = findMatchingRule(ventanaPolicy, input);
  if (match) return { origin: "VENTANA", ...match };
}

const bancaPolicy = parseCommissionPolicy(banca.commissionPolicyJson, "BANCA");
if (bancaPolicy) {
  const match = findMatchingRule(bancaPolicy, input);
  if (match) return { origin: "BANCA", ...match };
}

// Fallback: 0% (no bloquea venta)
return { origin: null, percent: 0, ruleId: null };
```

**Matching de Reglas**:
- `loteriaId`: Coincidencia exacta o `null` (comodín)
- `betType`: `NUMERO` | `REVENTADO` | `null` (comodín)
- `multiplierRange`: `[min, max]` inclusivo
- **Primera regla que calza gana** (orden importa)

### Sistema de Restricciones

**Resolución Jerárquica**:
```typescript
// Prioridad: User (100) > Ventana (10) > Banca (1)
const userRules = await findRules({ userId, isActive: true });
const ventanaRules = await findRules({ ventanaId, isActive: true });
const bancaRules = await findRules({ bancaId, isActive: true });

// Aplicar primera regla encontrada (mayor prioridad primero)
const effectiveRule = userRules[0] || ventanaRules[0] || bancaRules[0];
```

**Tipos de Restricción**:
- `maxAmount`: Límite por número específico
- `maxTotal`: Límite total por ticket
- `salesCutoffMinutes`: Bloqueo por tiempo antes del sorteo
- `salesPercentage`: % de ventas permitido (0-100)

**Vigencia Temporal**:
- `appliesToDate`: Fecha específica
- `appliesToHour`: Hora específica (0-23)
- `isAutoDate`: Auto-activación por fecha comercial

### Sistema de Multiplicadores

**Resolución de Base Multiplier X**:
```typescript
// 1. User Override (más alta prioridad)
const userOverride = await findUserMultiplierOverride(userId, loteriaId);
if (userOverride?.baseMultiplierX) return userOverride.baseMultiplierX;

// 2. Banca-Lotería Setting
const bls = await findBancaLoteriaSetting(bancaId, loteriaId);
if (bls?.baseMultiplierX) return bls.baseMultiplierX;

// 3. LoteriaMultiplier "Base"
const baseMultiplier = await findLoteriaMultiplier(loteriaId, "Base");
if (baseMultiplier?.valueX) return baseMultiplier.valueX;

// 4. rulesJson.baseMultiplierX
const rulesJson = loteria.rulesJson;
if (rulesJson?.baseMultiplierX) return rulesJson.baseMultiplierX;

// 5. Env var (fallback)
return process.env.MULTIPLIER_BASE_DEFAULT_X || 95;
```

**Snapshot Inmutable**:
- `finalMultiplierX` se congela en jugada al momento de venta
- No se recalcula posteriormente
- Para REVENTADO: `extraMultiplierX` se aplica al evaluar

---

## 🧪 Testing Strategy

### Cobertura Actual

**Tests Unitarios**:
- ✅ Concurrencia de tickets
- ✅ Restricciones jerárquicas
- ✅ Evaluación de sorteos
- ✅ Guards de actualización
- ✅ Ciclo de vida de sorteos

**Tests de Integración**:
- ✅ Endpoints de autenticación
- ✅ CRUD de usuarios
- ✅ Creación de tickets con validaciones

### Configuración de Tests

**Base de Datos de Prueba**:
- `.env.test` separado
- Migraciones automáticas antes de tests
- Limpieza después de cada suite

**Helpers**:
- `testIds.ts`: IDs de prueba reutilizables
- Factories para crear datos de prueba
- Mocks para servicios externos

---

## 📚 Documentación Adicional

### Documentos Principales
- `README.md`: Documentación principal del proyecto
- `CHANGELOG.md`: Historial completo de cambios
- `CODEBASE_INDEX.md`: Este documento (indexación profunda)

### Documentos por Módulo (`docs/`)
- `COMMISSION_SYSTEM.md`: Sistema de comisiones completo
- `DASHBOARD_API.md`: Especificación del Dashboard API
- `VENTAS_SUMMARY_API.md`: API de ventas con payment tracking
- `ACCOUNTS_API.md`: Sistema de estados de cuenta
- `BUG_FIX_RBAC_SCOPE_MINE.md`: Análisis de bugs RBAC
- Y 200+ documentos adicionales

---

## 🚀 Roadmap y Mejoras Futuras

### En Progreso
- [ ] Integración completa de TicketPayments
- [ ] Documentación OpenAPI/Swagger completa
- [ ] CI/CD en GitHub Actions
- [ ] Deploy Docker Compose

### Planificado
- [ ] Webhooks para eventos críticos
- [ ] Sistema de alertas avanzado
- [ ] Exportación mejorada (Excel, PDF)
- [ ] Dashboard en tiempo real
- [ ] API GraphQL (opcional)

---

---

## 📂 Índice Detallado de Archivos por Módulo

### Controllers (`src/api/v1/controllers/`)

| Archivo | Responsabilidad | Endpoints Principales |
|---------|----------------|----------------------|
| `ticket.controller.ts` | Gestión de tickets | POST/GET/PATCH/DELETE `/tickets` |
| `sorteo.controller.ts` | Gestión de sorteos | POST/GET/PATCH `/sorteos`, `/sorteos/:id/evaluate` |
| `loteria.controller.ts` | Gestión de loterías | POST/GET/PATCH `/loterias`, `/loterias/:id/preview_schedule` |
| `venta.controller.ts` | Resúmenes de ventas | GET `/ventas/summary`, `/ventas/breakdown`, `/ventas/timeseries` |
| `dashboard.controller.ts` | Dashboard y métricas | GET `/admin/dashboard/*` |
| `accounts.controller.ts` | Estados de cuenta | GET/POST `/accounts/statement`, `/accounts/payment` |
| `auth.controller.ts` | Autenticación | POST `/auth/login`, `/auth/refresh`, `/auth/logout` |
| `user.controller.ts` | CRUD de usuarios | POST/GET/PATCH/DELETE `/users` |
| `ventana.controller.ts` | CRUD de ventanas | POST/GET/PATCH/DELETE `/ventanas` |
| `banca.controller.ts` | CRUD de bancas | POST/GET/PATCH/DELETE `/bancas` |
| `restrictionRule.controller.ts` | Restricciones | POST/GET/PATCH/DELETE `/restrictions` |
| `commissions.controller.ts` | Políticas de comisión | PUT/GET `/bancas/:id/commission-policy` |
| `ticketPayment.controller.ts` | Pagos de tickets | POST `/tickets/:id/pay`, `/tickets/:id/reverse-payment` |
| `multiplier.controller.ts` | Multiplicadores | CRUD `/multipliers` |
| `multiplierOverride.controller.ts` | Overrides de multiplicadores | CRUD `/multiplier-overrides` |
| `vendedor.controller.ts` | Gestión de vendedores | GET `/vendedores` |
| `cierre.controller.ts` | Cierres operativos | POST/GET `/cierres` |
| `reports.controller.ts` | Reportes | GET `/reports/*` |
| `sorteosAuto.controller.ts` | Automatización de sorteos | GET/PATCH `/sorteos-auto` |
| `activityLog.controller.ts` | Logs de actividad | GET `/activity-logs` |
| `sales.controller.ts` | Ventas y analytics | GET `/sales/*` |
| `diagnostics.controller.ts` | Diagnósticos | GET `/diagnostics/*` |

### Services (`src/api/v1/services/`)

| Archivo | Responsabilidad | Lógica Clave |
|---------|----------------|--------------|
| `ticket.service.ts` | Creación y gestión de tickets | Validaciones, resolución de comisiones, restricciones |
| `sorteo.service.ts` | Ciclo de vida de sorteos | Evaluación, apertura, cierre, reversión |
| `loteria.service.ts` | Gestión de loterías | Preview de horarios, seed de sorteos |
| `venta.service.ts` | Agregaciones de ventas | Resúmenes, breakdowns, timeseries |
| `dashboard.service.ts` | Cálculo de métricas | KPIs, alertas, comparaciones |
| `accounts.service.ts` | Estados de cuenta | Cálculo de balances, pagos, cobros |
| `auth.service.ts` | Autenticación JWT | Login, refresh tokens, validación |
| `user.service.ts` | Lógica de usuarios | CRUD, validaciones de rol |
| `ventana.service.ts` | Lógica de ventanas | CRUD, validaciones |
| `banca.service.ts` | Lógica de bancas | CRUD, validaciones |
| `restrictionRule.service.ts` | Resolución de restricciones | Jerarquía, validaciones temporales |
| `commissions.service.ts` | Políticas de comisión | CRUD de políticas JSON |
| `ticketPayment.service.ts` | Pagos de tickets | Registro, reversión, finalización |
| `multiplier.service.ts` | Multiplicadores | CRUD, validaciones |
| `multiplierOverride.service.ts` | Overrides | Resolución jerárquica |
| `vendedor.service.ts` | Lógica de vendedores | Queries, validaciones |
| `cierre.service.ts` | Cierres | Cálculo de balances, exportación |
| `cierre-export.service.ts` | Exportación de cierres | Excel, PDF |
| `dashboard-export.service.ts` | Exportación de dashboard | Excel, PDF |
| `sorteosAuto.service.ts` | Automatización | Cron jobs, creación automática |
| `activityLog.service.ts` | Logs | Queries, filtros |
| `sales.service.ts` | Analytics de ventas | Agregaciones avanzadas |

#### Services de Reportes (`src/api/v1/services/reports/`)

| Archivo | Responsabilidad |
|---------|----------------|
| `ticketsReport.service.ts` | Reportes de tickets |
| `ventanasReport.service.ts` | Reportes de ventanas |
| `vendedoresReport.service.ts` | Reportes de vendedores |
| `loteriasReport.service.ts` | Reportes de loterías |

### Repositories (`src/repositories/`)

| Archivo | Responsabilidad | Queries Principales |
|---------|----------------|-------------------|
| `ticket.repository.ts` | Acceso a tickets | `create`, `findById`, `list`, `resolveBaseMultiplierX` |
| `sorteo.repository.ts` | Acceso a sorteos | `create`, `findById`, `open`, `close`, `evaluate` |
| `user.repository.ts` | Acceso a usuarios | `findById`, `findByEmail`, `list` |
| `ventana.repository.ts` | Acceso a ventanas | `findById`, `list` |
| `banca.repository.ts` | Acceso a bancas | `findById`, `list` |
| `restrictionRule.repository.ts` | Restricciones | `getEffectiveLimits`, `resolveSalesCutoff` |
| `accountStatement.repository.ts` | Estados de cuenta | `findByDate`, `calculateBalance` |
| `accountPayment.repository.ts` | Pagos de cuentas | `create`, `reverse` |
| `activityLog.repository.ts` | Logs | `create`, `list` |
| `multiplierOverride.repository.ts` | Overrides | `findByScope` |
| `vendedor.repository.ts` | Vendedores | `findByVentana` |

### Middlewares (`src/middlewares/`)

| Archivo | Responsabilidad | Funciones Principales |
|---------|----------------|---------------------|
| `auth.middleware.ts` | Autenticación JWT | `protect`, `restrictTo`, `restrictToAdminOrSelf` |
| `validate.middleware.ts` | Validación Zod | `validateBody`, `validateQuery`, `validateParams` |
| `error.middleware.ts` | Manejo de errores | `errorHandler` (global) |
| `rbac.middleware.ts` | RBAC filters | `applyRbacFilters` (deprecated, usar utils/rbac.ts) |
| `roleGuards.middleware.ts` | Guards de roles | Guards personalizados |
| `rateLimit.middleware.ts` | Rate limiting | `rateLimitMiddleware` |
| `cors.middleware.ts` | CORS | `corsMiddleware` |
| `attachLogger.middleware.ts` | Logger por request | `attachRequestLogger` |
| `requestId.middleware.ts` | Request ID | `requestIdMiddleware` |
| `bancaContext.middleware.ts` | Contexto de banca | `bancaContextMiddleware` |
| `contentTypeJson.middleware.ts` | Content-Type | `requireJson` |

### Core (`src/core/`)

| Archivo | Responsabilidad | Funciones Principales |
|---------|----------------|---------------------|
| `logger.ts` | Logging estructurado | `logger.info/warn/error/debug` |
| `errors.ts` | Clases de error | `AppError` |
| `prismaClient.ts` | Cliente Prisma | Singleton `prisma` |
| `withTransactionRetry.ts` | Transacciones con reintentos | `withTransactionRetry` |
| `activity.service.ts` | Servicio de auditoría | `ActivityService.log` |
| `types.ts` | Tipos Express extendidos | `AuthenticatedRequest` |
| `express.d.ts` | Declaraciones Express | Tipos globales |

### Utils (`src/utils/`)

| Archivo | Responsabilidad | Funciones Principales |
|---------|----------------|---------------------|
| `rbac.ts` | RBAC helpers | `applyRbacFilters`, `validateVentanaUser` |
| `businessDate.ts` | Fechas comerciales | `getBusinessDate`, `getBusinessDateRange` |
| `loteriaRules.ts` | Parser de rulesJson | `parseRulesJson`, `validateBetType` |
| `commissionCache.ts` | Cache de comisiones | Cache en memoria |
| `commissionPrecalc.ts` | Pre-cálculo | Optimización de queries |
| `schedule.ts` | Generación de horarios | `computeOccurrences` |
| `datetime.ts` | Helpers de fecha/hora | Conversiones de timezone |
| `pagination.ts` | Paginación | `calculateSkipLimit` |
| `responses.ts` | Respuestas estandarizadas | `success`, `error` |
| `decimal.ts` | Precisión decimal | Helpers para cálculos financieros |
| `cors.ts` | CORS parsing | `parseCorsOrigins` |
| `crypto.ts` | Utilidades criptográficas | Helpers de seguridad |
| `dateRange.ts` | Rangos de fechas | Validación y normalización |
| `phoneNormalizer.ts` | Normalización de teléfonos | Formato estándar |

### Routes (`src/api/v1/routes/`)

Todas las rutas están organizadas por módulo y siguen el patrón:
- `*.routes.ts` - Definición de rutas con middlewares
- Integración en `index.ts` con prefijo `/api/v1`

**Rutas principales**:
- `/auth` - Autenticación
- `/users` - Usuarios
- `/tickets` - Tickets
- `/sorteos` - Sorteos
- `/loterias` - Loterías
- `/ventanas` - Ventanas
- `/bancas` - Bancas
- `/vendedores` - Vendedores
- `/restrictions` - Restricciones
- `/multipliers` - Multiplicadores
- `/multiplier-overrides` - Overrides
- `/ticket-payments` - Pagos de tickets
- `/ventas` - Ventas y analytics
- `/admin/dashboard` - Dashboard
- `/accounts` - Estados de cuenta
- `/commissions` - Políticas de comisión
- `/activity-logs` - Logs de actividad
- `/cierres` - Cierres operativos
- `/reports` - Reportes
- `/diagnostics` - Diagnósticos
- `/sales` - Analytics de ventas

### Validators (`src/api/v1/validators/`)

Cada módulo tiene su validador Zod correspondiente:
- `*.validator.ts` - Schemas de validación con `.strict()`
- Validación automática vía middleware `validateBody/Query/Params`

### DTOs (`src/api/v1/dto/`)

Data Transfer Objects para tipado fuerte:
- `*.dto.ts` - Interfaces TypeScript para request/response

---

## 🔍 Flujos Detallados de Código

### Flujo de Creación de Ticket (Detallado)

```typescript
// 1. Request HTTP
POST /api/v1/tickets
Body: { loteriaId, sorteoId, jugadas[], vendedorId? }

// 2. Middleware Chain
requestIdMiddleware → attachLogger → cors → validateBody → protect → bancaContext

// 3. Controller (ticket.controller.ts)
ticketController.create(req, res)
  → TicketService.create(data, userId, requestId, actorRole)

// 4. Service (ticket.service.ts)
TicketService.create():
  a. Validar vendedorId según rol (impersonación)
  b. Validar ventana, sorteo, lotería
  c. Resolver sales cutoff (RestrictionRuleRepository.resolveSalesCutoff)
  d. Validar sorteo está OPEN
  e. Validar tiempo (sales cutoff)
  f. Llamar TicketRepository.create() dentro de withTransactionRetry

// 5. Repository (ticket.repository.ts)
TicketRepository.create():
  a. Obtener número de ticket (secuencial atómico)
  b. Resolver base multiplier X (jerarquía completa)
  c. Validar jugadas contra rulesJson
  d. Resolver restricciones jerárquicas (User > Ventana > Banca)
  e. Resolver comisiones (CommissionResolver.resolveCommission)
  f. Crear ticket y jugadas (con snapshots)
  g. Actualizar contadores

// 6. Activity Log (async)
ActivityService.log({ action: 'TICKET_CREATE', ... })

// 7. Response
{ success: true, data: ticket }
```

### Flujo de Evaluación de Sorteo (Detallado)

```typescript
// 1. Request HTTP
PATCH /api/v1/sorteos/:id/evaluate
Body: { winningNumber, extraMultiplierId?, extraOutcomeCode? }

// 2. Middleware Chain
requestIdMiddleware → attachLogger → cors → validateBody → protect → restrictTo(ADMIN)

// 3. Controller (sorteo.controller.ts)
sorteoController.evaluate(req, res)
  → SorteoService.evaluate(id, data, userId)

// 4. Service (sorteo.service.ts)
SorteoService.evaluate():
  a. Validar sorteo existe y está CLOSED o EVALUATED
  b. Validar winningNumber (2 dígitos)
  c. Si hay REVENTADO ganador:
     - Validar extraMultiplierId (tipo REVENTADO, activo)
     - Snapshot extraMultiplierX
  d. Llamar SorteoRepository.evaluate()

// 5. Repository (sorteo.repository.ts)
SorteoRepository.evaluate():
  a. Actualizar sorteo (status=EVALUATED, winningNumber, extraMultiplierId/X)
  b. Buscar todas las jugadas del sorteo
  c. Evaluar cada jugada:
     - NUMERO: isWinner = (number === winningNumber)
     - REVENTADO: isWinner = (number === winningNumber && extraMultiplierId existe)
  d. Calcular payout:
     - NUMERO: amount × finalMultiplierX
     - REVENTADO: amount × extraMultiplierX (snapshot)
  e. Actualizar jugadas (isWinner, payout)
  f. Actualizar tickets (isWinner, status=EVALUATED, totalPayout)

// 6. Activity Log (async)
ActivityService.log({ action: 'SORTEO_EVALUATE', ... })

// 7. Response
{ success: true, data: sorteo }
```

---

## 🗂️ Estructura de Base de Datos (Resumen)

### Modelos Principales (20 modelos)

1. **Banca** - Entidad raíz
2. **Ventana** - Pertenece a Banca
3. **User** - Usuarios (ADMIN/VENTANA/VENDEDOR)
4. **Loteria** - Configuración de loterías
5. **Sorteo** - Sorteos programados
6. **Ticket** - Tickets de venta
7. **Jugada** - Jugadas dentro de tickets
8. **RestrictionRule** - Reglas de restricción
9. **LoteriaMultiplier** - Multiplicadores por lotería
10. **MultiplierOverride** - Overrides jerárquicos
11. **TicketPayment** - Pagos de tickets
12. **AccountStatement** - Estados de cuenta diarios
13. **AccountPayment** - Pagos/cobros de cuentas
14. **ActivityLog** - Auditoría
15. **RefreshToken** - Tokens de refresh
16. **UserBanca** - Relación usuario-banca
17. **BancaLoteriaSetting** - Configuración banca-lotería
18. **TicketCounter** - Contador diario de tickets
19. **SorteosAutoConfig** - Configuración de automatización
20. **SavedReport, ExportJob, Alert, ApiKey, Webhook, etc.** - Módulos avanzados

### Enums Principales (6 enums)

- `Role`: ADMIN, VENTANA, VENDEDOR
- `TicketStatus`: ACTIVE, EVALUATED, PAID, PAGADO, CANCELLED, RESTORED
- `SorteoStatus`: SCHEDULED, OPEN, CLOSED, EVALUATED
- `BetType`: NUMERO, REVENTADO
- `MultiplierKind`: NUMERO, REVENTADO
- `ActivityType`: 50+ tipos de acción

---

## 📊 Estadísticas del Codebase (Actualizado)

### Archivos por Tipo
- **Controllers**: 21 archivos
- **Services**: 21 archivos (incluyendo reports/)
- **Repositories**: 11 archivos
- **Routes**: 25 archivos
- **Validators**: 21 archivos
- **DTOs**: 13 archivos
- **Middlewares**: 11 archivos
- **Utils**: 14 archivos
- **Core**: 7 archivos
- **Tests**: 11 archivos
- **Scripts**: 50+ archivos de utilidad

### Líneas de Código Estimadas
- **TypeScript**: ~50,000+ líneas
- **Prisma Schema**: ~800 líneas
- **Tests**: ~3,000+ líneas
- **Documentación**: ~200+ archivos MD

### Endpoints API
- **Total**: 100+ endpoints REST
- **Autenticación**: 3 endpoints
- **Tickets**: 8 endpoints
- **Sorteos**: 10 endpoints
- **Loterías**: 8 endpoints
- **Ventas/Analytics**: 15+ endpoints
- **Dashboard**: 5 endpoints
- **Cuentas**: 6 endpoints
- **Comisiones**: 6 endpoints
- **Restricciones**: 4 endpoints
- **Usuarios/Ventanas/Bancas**: 20+ endpoints
- **Reportes**: 10+ endpoints
- **Otros**: 10+ endpoints

---

**Última actualización**: 2025-01-20  
**Versión del sistema**: v1.2.0  
**Mantenido por**: Mario Quirós P.  
**Email**: mquirosp78@gmail.com

