<!-- markdownlint-disable MD024 -->

# 📘 CHANGELOG – Banca Management Backend

> Proyecto backend modular y escalable para la gestión integral de bancas de lotería.  
> Desarrollado con **TypeScript**, **Express**, **Prisma ORM** y **PostgreSQL**, bajo arquitectura modular, con trazabilidad total mediante `ActivityLog`.

---

## 🏷️ v1.0.0-rc6 — Draw schedule preview & auto-seed, cutoff & multipliers

📅 **Fecha:** 2025-10-24  
🔖 **Rama:** `master`

### ✳️ Nuevas funcionalidades

- **Preview de calendario de sorteos desde reglas**  
  - `GET /api/v1/loterias/:id/preview_schedule?days=7&start=ISO&limit=200`  
    Genera en memoria las próximas ocurrencias usando `Loteria.rulesJson.drawSchedule` (`frequency`, `times`, `daysOfWeek`). **No** escribe en DB.

- **Auto-seed de sorteos SCHEDULED**  
  - `POST /api/v1/loterias/:id/seed_sorteos?days=7&start=ISO&limit=200`  
    Reutiliza la lógica de preview para **crear** sorteos `SCHEDULED` en base de datos, evitando duplicados por `(loteriaId, scheduledAt)`.  
    Respuesta: `{ created, skipped }`.

- **Cutoff de ventas jerárquico con fuente**  
  - `RestrictionRuleRepository.resolveSalesCutoff()` prioriza **User → Ventana → Banca**; si no hay regla, cae a `DEFAULT` (5 min).  
  - `TicketService.create` bloquea ventas cercanas al sorteo: `limitTime = scheduledAt - cutoff`, con **gracia** de 5s.  
  - Log estructurado `TICKET_CUTOFF_DIAG` con `source` y tiempos.

- **Resolución robusta de multiplicador base (NUMERO)**  
  Cadena de resolución para `finalMultiplierX` y `multiplierId` “Base”:
  1) `UserMultiplierOverride.baseMultiplierX`  
  2) `BancaLoteriaSetting.baseMultiplierX`  
  3) `LoteriaMultiplier(name="Base")` (o primer `kind="NUMERO"`)  
  4) `Loteria.rulesJson.baseMultiplierX`  
  5) `env MULTIPLIER_BASE_DEFAULT_X`  
  Además, se **asegura** la fila `LoteriaMultiplier` “Base” si no existe.

### ⚙️ Mejoras y endurecimientos

- **Validaciones estrictas en tickets**  
  - Sorteo debe estar `OPEN`.  
  - `REVENTADO` exige jugada `NUMERO` emparejada en el mismo ticket.  
  - Límite diario por vendedor.  
  - Reglas de restricción aplicadas **dentro** de la transacción.

- **Evaluación de sorteos**  
  - `PATCH /sorteos/:id/evaluate` hace snapshot `extraMultiplierX` en sorteo y `finalMultiplierX` en jugadas `REVENTADO`.  
  - Exige `extraMultiplierId` si existen ganadores `REVENTADO`.

- **Listado y búsqueda de sorteos**  
  - `GET /sorteos` con `search` por `sorteo.name`, `winningNumber` y **nombre de lotería**.  
  - Incluye `loteria { id, name }` y `extraMultiplier { id, name, valueX }`.

- **Repository de RestrictionRules**  
  - Listado con filtros: `hasCutoff`, `hasAmount`, `isActive`, paginado.  
  - Devolución con etiquetas (`banca`, `ventana`, `user`).

### 🧪 Pruebas recomendadas (checklist rápida)

- Preview devuelve ocurrencias esperadas según `rulesJson.drawSchedule`.  
- Seed crea `SCHEDULED` sin duplicar.  
- Crear ticket: bloquea por cutoff si corresponde; valida `REVENTADO` vinculado.  
- Evaluar sorteo con/ sin `extraMultiplierId` según casos.

### 🔌 Nuevos endpoints (rc6)

```http
GET   /api/v1/loterias/:id/preview_schedule?days&start&limit
POST  /api/v1/loterias/:id/seed_sorteos?days&start&limit     # body opcional { dryRun?: boolean }
```

> **Nota:** `preview_schedule` es **GET**; `seed_sorteos` es **POST**.

### 📦 Migraciones

- No se requieren migraciones para rc6 (se apoyan en modelos existentes).

### 🧭 Guía de actualización

- Asegurar que `rulesJson.drawSchedule` esté poblado (ejemplo):

  ```json
  {
    "drawSchedule": {
      "frequency": "diario",
      "times": ["12:55", "16:30", "19:30"],
      "daysOfWeek": [0,1,2,3,4,5,6]
    },
    "closingTimeBeforeDraw": 5,
    "baseMultiplierX": 95
  }
  ```

- Definir `BancaLoteriaSetting.baseMultiplierX` para cada banca-lotería (recomendado) o configurar `UserMultiplierOverride` si aplican excepciones.

---

## 🏷️ v1.0.0-rc5 — Sorteos hardening & search

📅 **Fecha:** 2025-10-22  
🔖 **Rama:** `master`

### ✳️ Nuevas/ajustes clave

- **Update de Sorteos endurecido (solo reprogramación)**
  - `UpdateSorteoSchema` con `.strict()` y campos opcionales.
  - En Servicio/Repositorio **solo** se aplica `scheduledAt` en `PUT/PATCH /sorteos/:id`.
  - Evita cambios de lotería y rechaza llaves no permitidas (p. ej. `extraOutcomeCode`, `extraMultiplierId`).

- **Evaluación con multiplicador extra (REVENTADO)**
  - `PATCH /sorteos/:id/evaluate` acepta `winningNumber` + opcionales `extraMultiplierId` y `extraOutcomeCode`.
  - Validaciones: activo, pertenece a la misma lotería, tipo `REVENTADO`, y (si existe) `appliesToSorteoId`.
  - Conecta/desconecta relación `extraMultiplier` y hace **snapshot** `extraMultiplierX`.
  - Payouts:
    - `NUMERO`: `amount * finalMultiplierX`.
    - `REVENTADO`: `amount * extraMultiplierX`.
  - Tickets del sorteo pasan a `EVALUATED` con `isActive = false`.

- **Listado con búsqueda avanzada**
  - `ListSorteosQuerySchema` en `.strict()` y soporte de `search` en repositorio:
    - Busca por `sorteo.name`, `winningNumber` y **nombre de lotería**.
  - Inclusión de `loteria { id, name }` y `extraMultiplier { id, name, valueX }` en respuestas de lista/detalle.

- **Auditoría y logging**
  - `ActivityLog` para `SORTEO_CREATE`, `SORTEO_UPDATE`, `SORTEO_OPEN`, `SORTEO_CLOSE`, `SORTEO_EVALUATE`.
  - Logs estructurados en repositorio/servicio para operaciones críticas.

### 🛠️ Fixes

- **400 por “claves no permitidas”** en `PUT /sorteos/:id` al enviar `extraOutcomeCode/extraMultiplierId`.  
  ➜ Validación estricta y contrato documentado: esos campos **van solo** en `/evaluate`.

### ⚠️ Breaking changes (contrato)

- No enviar `extraMultiplierId` ni `extraOutcomeCode` a `PUT/PATCH /sorteos/:id`. Usar `PATCH /sorteos/:id/evaluate`.
- No se permite cambiar la lotería de un sorteo vía update; únicamente reprogramar `scheduledAt`.

---

## 🏷️ v1.0.0-rc4 — Stable MVP Backend  

📅 **Fecha:** 2025-10-08  
🔖 **Rama:** `master`  

### ✳️ Nuevas funcionalidades

- **Pipeline de RestrictionRule (User → Ventana → Banca)**  
  - Reglas jerárquicas dinámicas.  
  - Compatibilidad con filtros por hora y fecha (`appliesToHour`, `appliesToDate`).  
  - Validaciones de límites `maxAmount` y `maxTotal` por número o ticket.  

- **Transacciones seguras con retry (`withTransactionRetry`)**  
  - Manejo automático de *deadlocks* y conflictos de aislamiento.  
  - Reintentos controlados con backoff exponencial y logging por intento.  

### ⚙️ Mejoras de robustez

- Refactor de `TicketRepository.create`:
  - Secuencia numérica estable `ticket_number_seq` o fallback `TicketCounter`.  
  - Validaciones defensivas de claves foráneas (`loteria`, `sorteo`, `ventana`, `user`).  
  - Rechazo de tickets con sorteos no abiertos (`SORTEO_NOT_OPEN`).  
- Integración de `ActivityLog` asincrónica y no bloqueante.  
- Logging estructurado con `layer`, `action`, `userId`, `requestId`, `payload`.  

### 🧪 Pruebas unitarias

- ✅ `tests/tickets/restrictionRules.test.ts`  
  Verifica rechazo por reglas de límite jerárquico.
- ✅ `tests/tickets/concurrency.test.ts`  
  Simula concurrencia masiva en venta de tickets sin overselling.

### 📈 Resultado

| Suite | Estado | Tiempo |
|-------|---------|--------|
| 🎯 RestrictionRule pipeline | ✅ Passed | 2.48s |
| 🧵 TicketRepository Concurrency | ✅ Passed | 3.10s |
| **Total suites:** 2 | **✅ All passed** | **~9.4s** |

---

## 🏷️ v1.0.0-rc3 — Multiplier & Evaluation Integration  

📅 **Fecha:** 2025-10-06  

### ✳️ Nuevas funcionalidades

- **Módulo `UserMultiplierOverride`**  
  - Permite definir multiplicadores personalizados por usuario y lotería.  
  - Políticas de acceso por rol (`ADMIN`, `VENTANA`, `VENDEDOR`).  
  - Integración con `ActivityLog` (`MULTIPLIER_SETTING_*`).  

- **Evaluación de sorteos (`SorteoService.evaluate`)**  
  - Determina ganadores según número sorteado.  
  - Calcula payout por `jugada.amount * finalMultiplierX`.  
  - Actualiza estado global del sorteo y tickets (`EVALUATED`).  

### ⚙️ Mejoras

- Estabilización del `SorteoStatus` (ciclo: `SCHEDULED → OPEN → CLOSED → EVALUATED`).  
- Validaciones transaccionales de consistencia.  
- `ActivityLog` unificado para operaciones de `Sorteo` y `Ticket`.  

---

## 🏷️ v1.0.0-rc2 — Role-based Access & Audit  

📅 **Fecha:** 2025-10-04  

### ✳️ Nuevas funcionalidades

- Sistema completo de **roles y permisos** (`ADMIN`, `VENTANA`, `VENDEDOR`).  
- Middleware `protect` y validación de rol por ruta.  
- Auditoría global con `ActivityLog`:
  - Operaciones `CREATE`, `UPDATE`, `DELETE`, `RESTORE`.  
  - Nivel de detalle por `targetType`, `targetId` y `details`.  

### ⚙️ Mejoras

- Módulo `UserService` con CRUD y validación estricta (`Zod` DTOs).  
- Módulo `Ventana` y `Banca` con políticas jerárquicas (`ADMIN > VENTANA > VENDEDOR`).  
- Estandarización de logs (Pino) con niveles y requestId.  

---

## 🏷️ v1.0.0-rc1 — Core & Infrastructure Foundation  

📅 **Fecha:** 2025-09-28  

### ✳️ Componentes base

- Arquitectura modular inicial:  
  - `Auth`, `User`, `Ticket`, `Lotería`, `Sorteo`.  
- Integración con **Prisma ORM + PostgreSQL**.  
- Sistema de autenticación JWT clásico (Access + Refresh).  
- Middleware de validación `validateBody` / `validateQuery`.  
- Manejo centralizado de errores (`AppError`).  
- Configuración de entorno segura (`dotenv-safe`).  
- Logger estructurado y middleware de auditoría.

### ⚙️ Infraestructura

- **Paginación genérica** (`utils/pagination.ts`).  
- **Manejo de Soft Deletes** consistente en todas las entidades.  
- **CI local y en Render** con migraciones Prisma automáticas.

---

## 📊 Estado actual del MVP

| Módulo | Estado | Cobertura |
|--------|---------|------------|
| **Auth** | ✅ Completo | Login, Refresh, Protect |
| **Users** | ✅ Completo | CRUD + Role-based |
| **Bancas / Ventanas** | ✅ Completo | CRUD + Jerarquía |
| **Tickets** | ✅ Completo | Transacciones + Restricciones |
| **Sorteos** | ✅ Completo | Ciclo completo + Evaluación |
| **Multipliers** | ✅ Completo | Overrides + Políticas |
| **RestrictionRules** | ✅ Completo | Jerarquía dinámica |
| **ActivityLog** | ✅ Completo | Auditoría total |
| **TicketPayments** | 🟡 En progreso | Flujo estructurado pendiente de integración |
| **Reportes** | ⏸️ Pendiente | Iteración 2 |

---

## 📦 Próximos pasos

1. **Integrar módulo `TicketPayments` (fase 2)**  
   - Pago validado, reversión segura, auditoría por ticket.
2. **Implementar reportes operativos**  
   - Ventas por sorteo, top números, payouts.
3. **Generar documentación OpenAPI / Swagger.**
4. **CI/CD en GitHub Actions + Deploy Docker Compose (Postgres + API).**

---

## 🧭 Equipo y gestión

**Desarrollador responsable:**  
👤 *Mario Quirós Pizarro* (`@MQuirosP`)  
📧 `mquirosp78@gmail.com`  
📍 Costa Rica  

**Stack técnico:**  
TypeScript · Express.js · Prisma ORM · PostgreSQL · JWT · Zod · Pino  

---

> 💡 *Este release marca la culminación técnica del MVP Backend Bancas.*  
> La próxima iteración se enfocará en pagos, reportes, documentación y despliegue continuo.
