<!-- markdownlint-disable MD024 -->


### Idempotencia y UTC en Sorteos (rc8)

- BD: restricción única `@@unique([loteriaId, scheduledAt])` para evitar duplicados por lotería-fecha.
- Tiempo: todos los cálculos de horario (`computeOccurrences`) y comparaciones internas se realizan en UTC.
- Seed idempotente: `POST /api/v1/loterias/:id/seed_sorteos?start&days&dryRun`
  - Opcional body: `{ "scheduledDates": ["2025-01-20T12:55:00.000Z", ...] }` para honrar un subset específico enviado por el frontend.
  - Respuesta (no dryRun):
    - `created: string[]` ISO UTC creados efectivamente
    - `skipped: string[]` ISO UTC omitidos (ya existían o perdidos por concurrencia)
    - `alreadyExists: string[]` ISO UTC detectados como existentes antes de insertar
    - `processed: string[]` ISO UTC procesados (eco)
  - Respuesta (dryRun): incluye `preview` y `processedSubset` (si aplica).

Notas:
- La deduplicación utiliza timestamps (`getTime`) en memoria y en BD (índice único), no `toISOString()` como clave.
- El repositorio usa `createMany({ skipDuplicates: true })` y trata P2002/23505 como “skipped”.

<!-- markdownlint-disable MD024 -->
<!-- markdownlint-disable MD047 -->

# 🏦 Banca Management Backend

> **Backend modular y escalable** para la gestión integral de bancas de lotería.  
> Desarrollado con **TypeScript, Express y Prisma ORM**, bajo arquitectura por capas, validaciones estrictas (`Zod`) y trazabilidad total con `ActivityLog`.

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
| **Auditoría** | Modelo `ActivityLog` con contexto (`layer`, `action`, `userId`, `requestId`) |

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
├── utils/
└── tests/
```

### Responsabilidades por capa

| Capa | Rol |
|------|-----|
| **Controllers** | Gestionan la petición HTTP y respuesta |
| **Services** | Lógica de negocio y validaciones de dominio |
| **Repositories** | Acceso a datos con Prisma (sin lógica de dominio) |
| **Middlewares** | Seguridad, validación, logging y control de acceso |
| **Core** | Módulos críticos: logger, errores, Prisma, auditoría |
| **Utils** | Utilidades (paginación, transacciones, helpers de reglas) |

---

## 🔐 Autenticación y Roles

- **Tokens JWT**:
  - `Access Token` de corta duración.
  - `Refresh Token` persistente y revocable.
- **Flag de desarrollo**: `DISABLE_AUTH=true` permite simular un ADMIN.
- Middleware `protect` para proteger rutas privadas.

### Roles jerárquicos

| Rol | Descripción |
|-----|-------------|
| **ADMIN** | Control total del sistema. |
| **VENTANA** | Administra vendedores y controla sus límites. |
| **VENDEDOR** | Ejecuta ventas y consulta sorteos activos. |

---

## 🏢 Bancas y 🪟 Ventanas

- **Banca:** define límites globales (`defaultMinBet`, `globalMaxPerNumber`, `salesCutoffMinutes` por defecto vía `RestrictionRule`).  
- **Ventana:** comisiones (`commissionMarginX`), soft-delete, trazabilidad.  
- Jerarquía: **Banca → Ventana → Vendedor**.  
- Toda acción auditable mediante `ActivityLog`.

---

## 🎲 Loterías y 🧭 Sorteos

- `Loteria` (configuración general + `rulesJson` + multiplicadores).
- `Sorteo` con ciclo controlado:

| Estado | Descripción |
|--------|-------------|
| `SCHEDULED` | Aún no disponible para venta. |
| `OPEN` | Permite venta de tickets. |
| `CLOSED` | Cierre de venta, en espera de resultado. |
| `EVALUATED` | Resultado asignado, tickets evaluados. |

- Evaluación: `payout = jugada.amount × finalMultiplierX` (con *snapshot* del multiplicador efectivo al momento de la venta o de la evaluación para REVENTADO).

### Rutas Sorteos (v1)

```http
POST   /api/v1/sorteos                  # Crear sorteo
PUT    /api/v1/sorteos/:id              # Reprogramar (name/scheduledAt/isActive) ⬅️ rc5
PATCH  /api/v1/sorteos/:id              # Reprogramar (name/scheduledAt/isActive) ⬅️ rc5
PATCH  /api/v1/sorteos/:id/open         # Abrir sorteo (SCHEDULED -> OPEN)    (sin body)
PATCH  /api/v1/sorteos/:id/close        # Cerrar sorteo (OPEN/EVALUATED -> CLOSED) (sin body)
PATCH  /api/v1/sorteos/:id/evaluate     # Evaluar sorteo (ganador + REVENTADO opcional)
GET    /api/v1/sorteos                  # Listar (con búsqueda por nombre/ganador/lotería) ⬅️ rc5
GET    /api/v1/sorteos/:id              # Obtener por id
DELETE /api/v1/sorteos/:id              # Soft-delete
```

#### Contrato rc5 — **Update** y **Evaluate**

- **Update (`PUT/PATCH /sorteos/:id`)**  
  - Permite reprogramar `scheduledAt` y actualizar `name/isActive` (si se envían).  
  - No permite cambiar `status` ni resultados desde esta ruta.

- **Evaluate (`PATCH /sorteos/:id/evaluate`)**  
  - Body requerido:  

    ```json
    { "winningNumber": "00", "extraMultiplierId": "uuid-optional", "extraOutcomeCode": "opcional" }
    ```

  - Reglas:
    - `winningNumber` = 2 dígitos.
    - Si hay REVENTADO ganador (mismo número), **requiere** `extraMultiplierId` de tipo `REVENTADO`, activo y de la misma lotería (si `appliesToSorteoId` viene, debe coincidir).  
  - Efectos:
    - Snapshot `extraMultiplierX` en sorteo y `finalMultiplierX` en jugadas `REVENTADO`.
    - Relación `extraMultiplier` conectada/desconectada según corresponda.
    - Tickets marcados `EVALUATED` y `isActive=false` (ganadores/ perdedores).

---

## 📐 `rulesJson` de Lotería (servidor)

Archivo helper: `src/utils/loteriaRules.ts`

Campos relevantes soportados:

```ts
type RulesJson = {
  closingTimeBeforeDraw?: number; // minutos previos al sorteo para bloquear ventas (fallback)
  minBetAmount?: number;
  maxBetAmount?: number;
  maxNumbersPerTicket?: number;
  numberRange?: { min: number; max: number };
  allowedBetTypes?: Array<'NUMERO' | 'REVENTADO'>;
  reventadoConfig?: {
    enabled: boolean;
    requiresMatchingNumber?: boolean;
    colors?: Array<'ROJA' | 'VERDE'>;
  };
  drawSchedule?: {
    frequency?: 'diario' | 'semanal' | 'personalizado';
    times?: string[];       // "HH:MM"
    daysOfWeek?: number[];  // 0..6 (0=domingo)
  };
  autoCreateSorteos?: boolean;
  display?: { color?: string; icon?: string; description?: string; featured?: boolean };
  baseMultiplierX?: number; // Fallback final del multiplicador base
  salesHours?: { ...por día... };
};
```

### Resolución del **multiplicador base (X)** en la venta de NUMERO

Cadena de prioridad (la primera que aplique):

1. `UserMultiplierOverride.baseMultiplierX`
2. `BancaLoteriaSetting.baseMultiplierX`
3. `LoteriaMultiplier` activo con `name="Base"` **o**, si no existe, el primer `kind="NUMERO"`
4. `Loteria.rulesJson.baseMultiplierX`
5. `process.env.MULTIPLIER_BASE_DEFAULT_X`

> Además, el repositorio asegura que exista una fila `LoteriaMultiplier(name="Base")` para poder enlazar `jugadas.NUMERO` con su `multiplierId`. El valor X final se *congela* en `finalMultiplierX` al momento de la venta.

### Resolución del **sales cutoff** (bloqueo por tiempo)

Cadena de prioridad:

1. `RestrictionRule.salesCutoffMinutes` *User > Ventana > Banca* (sin `number`)
2. `Loteria.rulesJson.closingTimeBeforeDraw` *(fallback)*
3. `defaultCutoff` del servicio (5 minutos)

El servicio de tickets registra un diagnóstico (`TICKET_CUTOFF_DIAG`) con `source` y valores calculados.

### Validaciones de ticket contra reglas

- Rango de números (`numberRange`).
- Tipos permitidos (`allowedBetTypes`).
- `reventadoConfig` (habilitado / requiere número asociado).
- Mínimo y máximo por jugada.
- Máximo de jugadas por ticket.

---

## 🧭 Generación y *Preview* de Sorteos desde Reglas

### Endpoints Lotería (v1)

```http
POST  /api/v1/loterias                      # Crear lotería
GET   /api/v1/loterias                      # Listar (+search)
GET   /api/v1/loterias/:id                  # Obtener por id
PATCH /api/v1/loterias/:id                  # Actualizar (parcial)
PUT   /api/v1/loterias/:id                  # Actualizar (parcial)
DELETE /api/v1/loterias/:id                 # Soft-delete
PATCH /api/v1/loterias/:id/restore          # Restaurar

# Preview de agenda según rulesJson.drawSchedule
GET   /api/v1/loterias/:id/preview_schedule?start=ISO&days=7&limit=200

# Seed de sorteos (creación en DB a partir del preview)
POST  /api/v1/loterias/:id/seed_sorteos?start=ISO&days=7&limit=200
Body opcional: { "dryRun": false }
```

- **Preview**: calcula próximas ocurrencias sin escribir en DB.
- **Seed**: crea sorteos `SCHEDULED` evitando duplicados `(loteriaId, scheduledAt)`; devuelve `{ created, skipped }`.

> La generación respeta `drawSchedule.frequency/times/daysOfWeek`. Para `personalizado`, se usan los `times` todos los días (semántica extensible).

---

## 🎫 Tickets

- Secuencia segura `ticket_number_seq` o `TicketCounter` atómico.
- Creación protegida por `withTransactionRetry` (manejo de *deadlocks* y *timeouts*).
- Aplicación de `RestrictionRule` jerárquica dentro de la transacción.
- **Sistema de comisiones** con snapshot inmutable por jugada.
- Cancelación con soft-delete y registro en `ActivityLog`.

### Validaciones automáticas

- Lotería, sorteo, ventana y usuario deben existir.
- Sorteo debe estar en estado **OPEN**.
- Cumplimiento de `maxAmount`, `maxTotal` y reglas de `rulesJson`.

### Flujo transaccional

1. Se obtiene número secuencial seguro.
2. Se verifica límite diario del vendedor.
3. Se resuelve **base multiplier X** (prioridad descrita arriba).
4. Se resuelve y aplica **sales cutoff** (User→Ventana→Banca→fallback).
5. Se normalizan y validan jugadas contra `rulesJson`.
6. **Se resuelve comisión** por prioridad (User→Ventana→Banca) y se persiste snapshot.
7. Se crea el ticket y sus jugadas (snapshot de `finalMultiplierX` para `NUMERO` y comisión).
8. Auditoría asincrónica (`TICKET_CREATE`) con detalles de comisión.

---

## 💰 Sistema de Comisiones

Sistema jerárquico de comisiones con políticas JSON configurables por **User**, **Ventana** y **Banca**.

### Características principales

- ✅ **Políticas JSON** (versión 1) con porcentajes 0-100
- ✅ **Prioridad jerárquica**: USER → VENTANA → BANCA
- ✅ **Primera regla gana** (first match wins)
- ✅ **Snapshot inmutable** por jugada al momento de venta
- ✅ **Vigencia temporal** con `effectiveFrom`/`effectiveTo`
- ✅ **UUID auto-generado** para reglas sin ID
- ✅ **Sin bloqueo**: JSON malformado → 0% comisión (WARN)

### Estructura de política

```json
{
  "version": 1,
  "effectiveFrom": "2025-01-01T00:00:00.000Z" | null,
  "effectiveTo": "2025-12-31T23:59:59.999Z" | null,
  "defaultPercent": 5.0,
  "rules": [
    {
      "id": "uuid-auto-generado",
      "loteriaId": "uuid" | null,
      "betType": "NUMERO" | "REVENTADO" | null,
      "multiplierRange": { "min": 70, "max": 100 },
      "percent": 8.5
    }
  ]
}
```

### Matching de reglas

Una regla aplica si **TODOS** los criterios se cumplen:

1. `loteriaId` coincide (o es `null` = comodín)
2. `betType` coincide (o es `null` = comodín)
3. `finalMultiplierX` está en `[min, max]` (inclusivo)

**Primera regla que calza gana** (orden del array).

### Snapshot en Jugada

Campos inmutables persistidos al momento de venta:

```typescript
{
  commissionPercent: 8.5,        // 0..100
  commissionAmount: 4.25,         // round2(amount * percent / 100)
  commissionOrigin: "USER",       // "USER" | "VENTANA" | "BANCA" | null
  commissionRuleId: "rule-uuid"   // ID de regla aplicada o null
}
```

### Endpoints CRUD (ADMIN only)

```http
PUT /api/v1/bancas/:id/commission-policy
GET /api/v1/bancas/:id/commission-policy

PUT /api/v1/ventanas/:id/commission-policy
GET /api/v1/ventanas/:id/commission-policy

PUT /api/v1/users/:id/commission-policy
GET /api/v1/users/:id/commission-policy
```

### Analytics de Comisiones

Los endpoints de ventas incluyen métricas de comisión:

```http
GET /api/v1/ventas/summary
# Retorna: commissionTotal, netoDespuesComision

GET /api/v1/ventas/breakdown?dimension=ventana
# Cada item incluye: commissionTotal

GET /api/v1/ventas/timeseries?granularity=day
# Cada punto incluye: commissionTotal
```

> 📖 Ver documentación completa en [`docs/COMMISSION_SYSTEM.md`](docs/COMMISSION_SYSTEM.md)

---

## 🔢 Multipliers y RestrictionRules

### **LoteriaMultiplier**

- Define multiplicadores configurables por lotería o por sorteo (`appliesToSorteoId`).

### **UserMultiplierOverride**

- Multiplicadores personalizados por **usuario + lotería** (clave única).

### **VentanaMultiplierOverride** *(planificado)*

- Ubicado entre Banca y Usuario como futura fuente intermedia de `baseMultiplierX` (no bloquea el flujo actual).

### **RestrictionRule**

- Limita montos por número o por ticket.
- Prioridad: **User (100) > Ventana (10) > Banca (1)**.
- Soporta `appliesToDate` y `appliesToHour`.

---

## ⚙️ Concurrencia y Transacciones Seguras

- Wrapper `withTransactionRetry`:
  - Maneja *deadlocks* (`P2034`) con backoff exponencial.
  - Timeouts explícitos y reintentos acotados.
  - Logging estructurado por intento.
- Evita overselling en ventas simultáneas.

---

## 🧪 Pruebas Unitarias

| Suite | Objetivo | Estado |
|------|----------|--------|
| `tickets/concurrency.test.ts` | Prevención de overselling | ✅ |
| `tickets/restrictionRules.test.ts` | Validación jerárquica de límites | ✅ |
| `auth` y `users` | CRUD + roles | ✅ |
| `payments` | Integración (fase 2) | ⏳ |

---

## 🧾 Auditoría Centralizada

Ejemplo:

```ts
await prisma.activityLog.create({
  data: {
    userId,
    action: 'TICKET_CREATE',
    targetType: 'TICKET',
    targetId: ticket.id,
    details: { totalAmount: ticket.totalAmount },
  },
});
```

Se auditan: `SORTEO_CREATE`, `SORTEO_UPDATE`, `SORTEO_OPEN`, `SORTEO_CLOSE`, `SORTEO_EVALUATE`, `TICKET_*`, `LOTERIA_*`.

---

## ⚙️ Scripts útiles

```bash
npm run dev              # Desarrollo
npm run build            # Compilación TypeScript
npm run test             # Tests
npm run prisma:generate  # Prisma Client
npm run prisma:deploy    # Migraciones
```

---

## 📦 Variables de entorno (.env)

```bash
PORT=4000
NODE_ENV=development
DATABASE_URL=postgresql://user:pass@localhost:5432/bancas
JWT_ACCESS_SECRET=your-access-secret
JWT_REFRESH_SECRET=your-refresh-secret
JWT_ACCESS_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=7d
DISABLE_AUTH=false
LOG_LEVEL=info
MULTIPLIER_BASE_DEFAULT_X=95
```

---

## 👨‍💻 Autor

**Mario Quirós P.**  
📧 [mquirosp78@gmail.com](mailto:mquirosp78@gmail.com)  
🌐 [github.com/MQuirosP](https://github.com/MQuirosP)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/MQuirosP/backend-bancas)

---

## 🧭 Licencia

Proyecto bajo licencia **MIT** (ver `LICENSE`).

---

> 💡 *Versión actual:* `v1.0.0-rc5`  
> *Notas rc5**: Update restringido; evaluación con `extraMultiplierId/extraOutcomeCode`; búsqueda por nombre/ganador/lotería; preview & seed de sorteos desde `rulesJson.drawSchedule`; resolución jerárquica de `baseMultiplierX` y `salesCutoff`.




