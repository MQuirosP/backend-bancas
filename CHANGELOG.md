## 🚀 v1.2.0 - Evaluated Summary, Advanced Filters & Timezone Fixes

📅 **Fecha:** 2025-01-15
🔖 **Rama:** `master`

### ✳️ Nuevas funcionalidades

- **Endpoint `GET /api/v1/sorteos/evaluated-summary`**
  - Resumen financiero de sorteos evaluados con datos agregados
  - Campos: `totalSales`, `totalCommission`, `totalPrizes`, `subtotal`, `accumulated`
  - Flag `isReventado` basado en `extraMultiplierId` o `extraMultiplierX`
  - Campo `winningNumber` del sorteo
  - Campos `chronologicalIndex` y `totalChronological` para orden cronológico explícito
  - Ordenamiento consistente: `scheduledAt ASC`, `loteriaId ASC`, `id ASC` para cálculo de acumulado
  - Filtros: `date`, `fromDate`, `toDate`, `scope`, `loteriaId`
  - Documentación: `docs/EJEMPLO_RESPUESTA_EVALUATED_SUMMARY.md`, `docs/GUIA_FE_EVALUATED_SUMMARY.md`

- **Filtros avanzados en `GET /api/v1/tickets`**
  - `loteriaId`: Filtrar por lotería específica
  - `sorteoId`: Filtrar por sorteo específico (con regla especial: no aplicar fechas cuando hay `sorteoId`)
  - `multiplierId`: Filtrar tickets con al menos una jugada con ese multiplicador (todas las jugadas se devuelven)
  - `winnersOnly`: Filtrar solo tickets ganadores (`isWinner: true`)
  - Relación `multiplier` incluida en `jugadas` para población completa
  - Documentación: `docs/DETALLES_IMPLEMENTACION_FE.md`

- **Agrupación de sorteos por hora (`groupBy`)**
  - Parámetro `groupBy` en `GET /api/v1/sorteos`: `'loteria-hour'` o `'hour'`
  - Agrupa sorteos por `loteriaId + hora` o solo por `hora` (cuando ya hay `loteriaId` filtrado)
  - Extrae hora directamente de `scheduledAt` usando `TO_CHAR` en PostgreSQL
  - Respuesta incluye: `loteriaId`, `hour`, `hour24`, `mostRecentSorteoId`, `sorteoIds`
  - Optimizado con `GROUP BY` en SQL y CTEs para `mostRecentSorteoId`
  - Documentación: `docs/DETALLES_SORTEOS_AGRUPADOS_FE.md`

- **Búsqueda en `GET /api/v1/activity-logs`**
  - Parámetro `search` para buscar en `action`, `targetType`, `targetId`, `user.name`, `user.username`
  - Búsqueda case-insensitive con `OR` entre campos

### 🐛 Bug Fixes (CRÍTICOS)

- **Cálculo incorrecto de `totalPrizes` en `evaluated-summary`**
  - Antes: Sumaba `totalPayout` de todos los tickets (incluyendo no ganadores con `totalPayout = 0`)
  - Ahora: Suma `totalPayout` solo de tickets con `isWinner: true`
  - Impacto: Corrige el cálculo de premios ganados en el resumen de sorteos evaluados

- **Error aritmético en `accumulated` balance**
  - Antes: Orden inconsistente cuando múltiples sorteos ocurrían a la misma hora
  - Ahora: Orden determinístico con `scheduledAt ASC`, `loteriaId ASC`, `id ASC`
  - Agregados campos `chronologicalIndex` y `totalChronological` para claridad del frontend
  - Impacto: El acumulado se calcula correctamente del más antiguo al más reciente

- **Comisiones de listero mostrando 0 cuando deberían tener valor**
  - Antes: No se buscaban usuarios VENTANA por ventana individualmente cuando no había `ventanaUserPolicy` global
  - Ahora: Busca usuarios VENTANA por ventana específica y aplica sus políticas correctamente
  - Cuando `dimension=ventana` y hay `ventanaUserPolicy`: aplica política solo a la ventana del usuario VENTANA
  - Para otras ventanas: usa políticas de ventana/banca directamente
  - Impacto: Las comisiones de listero se calculan correctamente desde políticas activas

- **`commissionVentanaTotal` faltante en `/admin/dashboard`**
  - Antes: `getSummary` devolvía `commissionVentana` pero frontend buscaba `commissionVentanaTotal`
  - Ahora: Agregado alias `commissionVentanaTotal` en `getSummary` para compatibilidad
  - `calculatePreviousPeriod` ahora calcula `commissionVentana` desde políticas usando `computeVentanaCommissionFromPolicies`
  - Impacto: La card "Comisión Listero" en el dashboard muestra valores correctos

- **`totalCommission` incorrecto en `/api/v1/commissions`**
  - Antes: No se calculaba correctamente según la dimensión (ventana vs vendedor)
  - Ahora: `totalCommission = commissionListero` cuando `dimension=ventana`, `totalCommission = commissionVendedor` cuando `dimension=vendedor`
  - Comisiones siempre calculadas desde políticas activas (no snapshot para ventana)
  - Impacto: Los totales de comisión coinciden con el dashboard

- **Constraint violations en `AccountStatement`**
  - Antes: Violación de `@@check` constraint (`AccountStatement_one_relation_check`) y unique constraint (`P2002`)
  - Ahora: Lógica refactorizada para asegurar solo uno de `ventanaId` o `vendedorId` es no-null
  - `findByDate` explícitamente establece `ventanaId = null` cuando hay `vendedorId` y viceversa
  - Verificación de tipo correcto antes de actualizar (evita actualizar ventana statement con datos de vendedor)
  - Impacto: Elimina errores de constraint al calcular estados de cuenta

- **Timestamps en zona horaria incorrecta en `GET /api/v1/admin/dashboard/timeseries`**
  - Antes: Timestamps en UTC causaban que el frontend mostrara el día incorrecto
  - Ahora: Timestamps formateados con offset `-06:00` explícito (`YYYY-MM-DDTHH:mm:ss-06:00`)
  - Campo `date` como `YYYY-MM-DD` en zona horaria de Costa Rica
  - Campo `timezone: 'America/Costa_Rica'` en `meta`
  - Impacto: El frontend muestra correctamente el día al interpretar timestamps

### ⚙️ Mejoras

- **Optimización de queries SQL**
  - Uso de CTEs (Common Table Expressions) para subqueries complejas
  - `GROUP BY` optimizado con todas las expresiones necesarias
  - Ordenamiento en JavaScript cuando `STRING_AGG` no requiere `ORDER BY`

- **Type safety mejorado**
  - Type guards para manejar `meta` con y sin paginación según `groupBy`
  - Conversión explícita de `null` a `undefined` para compatibilidad con tipos TypeScript

- **Precisión en cálculos de comisión**
  - Uso de `commissionAmount` directamente de `resolveCommission` en lugar de recalcular
  - `finalMultiplierX` siempre `number` (no `null`)

- **Documentación completa**
  - Múltiples documentos creados para frontend con ejemplos y guías de implementación
  - Documentación de estructura de respuesta y cómo interpretar campos

### 📦 Archivos modificados

- `src/api/v1/services/sorteo.service.ts` - Endpoint `evaluated-summary`, agrupación por hora
- `src/api/v1/services/dashboard.service.ts` - Fix timezone en timeseries, `commissionVentanaTotal`
- `src/api/v1/services/commissions.service.ts` - Cálculo correcto de comisiones de listero
- `src/api/v1/services/accounts.service.ts` - Fixes de constraints en AccountStatement
- `src/api/v1/services/activityLog.service.ts` - Búsqueda en activity logs
- `src/repositories/ticket.repository.ts` - Filtros avanzados (loteriaId, sorteoId, multiplierId, winnersOnly)
- `src/repositories/accountStatement.repository.ts` - Fixes de constraints
- `src/repositories/activityLog.repository.ts` - Implementación de búsqueda
- `src/api/v1/controllers/ticket.controller.ts` - Regla especial para `sorteoId` (no aplicar fechas)
- `src/api/v1/controllers/sorteo.controller.ts` - Endpoint `evaluated-summary`, manejo de `groupBy`
- `src/api/v1/validators/ticket.validator.ts` - Validación de nuevos filtros
- `src/api/v1/validators/sorteo.validator.ts` - Validación de `groupBy`
- `src/api/v1/validators/activityLog.validator.ts` - Validación de `search`

### 🧪 Checklist de validación

- ✅ `evaluated-summary` devuelve datos financieros correctos
- ✅ `totalPrizes` solo incluye tickets ganadores
- ✅ `accumulated` se calcula correctamente del más antiguo al más reciente
- ✅ Filtros de tickets funcionan correctamente (`loteriaId`, `sorteoId`, `multiplierId`, `winnersOnly`)
- ✅ Regla especial para `sorteoId` (no aplicar fechas) funciona
- ✅ Agrupación por hora devuelve grupos correctos
- ✅ Comisiones de listero se calculan correctamente desde políticas
- ✅ `commissionVentanaTotal` presente en dashboard
- ✅ `totalCommission` correcto según dimensión en `/api/v1/commissions`
- ✅ AccountStatement no genera constraint violations
- ✅ Timestamps en timeseries muestran día correcto en frontend
- ✅ Búsqueda en activity-logs funciona correctamente

### 🎯 Resultado

✅ **Endpoint `evaluated-summary` funcional** - Resumen financiero completo de sorteos evaluados
✅ **Filtros avanzados en tickets** - 4 nuevos filtros para búsqueda precisa
✅ **Agrupación de sorteos por hora** - Optimizada con SQL GROUP BY
✅ **7 bugs críticos corregidos** - Comisiones, constraints, timezone, cálculos
✅ **Documentación completa** - Múltiples guías para frontend
✅ **TypeScript compilation 100%** - Sin errores

---

## 🚀 v1.1.1 - Accounts Statement Fixes & Restrictions Array Support

📅 **Fecha:** 2025-11-06
🔖 **Rama:** `master`

### 🐛 Bug Fixes (CRÍTICOS)

- **Cálculo incorrecto de `totalPayouts` en accounts statement**
  - Antes: Usaba `totalPaid` de tickets (lo pagado, no lo ganado)
  - Ahora: Usa `payout` de jugadas ganadoras (total de premios ganados)
  - Impacto: Corrige el cálculo de `balance` y `remainingBalance` en estados de cuenta
  - Afecta: `/api/v1/accounts/statement`

- **Lógica incorrecta de `isSettled` en accounts statement**
  - Antes: Marcaba como saldado si `remainingBalance ≈ 0`, incluso sin pagos registrados
  - Ahora: Solo marca como saldado si hay pagos/cobros registrados (`totalPaid > 0` o `totalCollected > 0`)
  - Impacto: Evita confusión cuando un listero ve su propio estado de cuenta (no puede registrar pagos de sí mismo)
  - Afecta: `/api/v1/accounts/statement`

- **Cálculo incorrecto de comisiones del listero cuando `dimension=ventana`**
  - Antes: Recalculaba comisiones para todas las jugadas, incluso si ya estaban guardadas
  - Ahora: Usa `commissionOrigin` para optimizar:
    - Si `commissionOrigin === "VENTANA"` o `"BANCA"`: usa directamente `commissionAmount`
    - Si `commissionOrigin === "USER"`: calcula comisión de la ventana usando políticas
  - Impacto: Muestra correctamente las comisiones del listero en estados de cuenta
  - Afecta: `/api/v1/accounts/statement?dimension=ventana`

- **Comisiones excluían jugadas no ganadoras**
  - Antes: Filtraba solo jugadas ganadoras (`isWinner: true`) para calcular comisiones
  - Ahora: Incluye TODAS las jugadas (las comisiones se aplican a todas, no solo a ganadoras)
  - Impacto: Los montos de comisiones ahora coinciden con el dashboard (`admin/reportes/cuentas`)
  - Afecta: `/api/v1/accounts/statement`

### ✳️ Nuevas funcionalidades

- **Soporte para array de números en restricciones**
  - Endpoint `POST /api/v1/restrictions` ahora acepta `number` como `string | string[]`
  - Permite crear múltiples restricciones con la misma regla para diferentes números en una sola operación
  - Validaciones: formato (00-99), sin duplicados, máximo 100 elementos
  - Compatibilidad legacy: sigue aceptando `number` como `string`
  - Endpoint `PATCH /api/v1/restrictions/:id` solo acepta `string` (no array) según recomendación
  - Documentación: `docs/BACKEND_RESTRICTIONS_NUMBERS_ARRAY.md`

### ⚙️ Mejoras

- **Optimización de cálculo de comisiones**
  - Usa `commissionOrigin` para evitar recálculos innecesarios
  - Separa jugadas por origen de comisión para procesamiento eficiente
  - Reduce consultas a la base de datos cuando las comisiones ya están guardadas

- **Mejora en lógica de `isSettled`**
  - Validación más estricta: requiere pagos registrados para marcar como saldado
  - Evita confusión cuando no hay movimientos registrados
  - Mejora la experiencia del usuario al ver estados de cuenta

### 📦 Archivos modificados

- `src/api/v1/services/accounts.service.ts` - Correcciones en cálculo de comisiones y `isSettled`
- `src/api/v1/validators/restrictionRule.validator.ts` - Soporte para array de números
- `src/api/v1/dto/restrictionRule.dto.ts` - Actualización de tipos
- `src/api/v1/services/restrictionRule.service.ts` - Lógica para crear múltiples restricciones

### 🧪 Checklist de validación

- ✅ `totalPayouts` calculado correctamente (payout de jugadas ganadoras)
- ✅ `isSettled` solo `true` cuando hay pagos registrados
- ✅ Comisiones del listero correctas cuando `dimension=ventana`
- ✅ Comisiones incluyen todas las jugadas (no solo ganadoras)
- ✅ Montos de comisiones coinciden con dashboard
- ✅ Soporte para array de números en restricciones funciona correctamente
- ✅ Compatibilidad legacy mantenida (string sigue funcionando)

---

## 🚀 v1.1.0 - Dashboard API, Payment Tracking & RBAC Security Fixes

📅 **Fecha:** 2025-10-29
🔖 **Rama:** `master`

### ✳️ Nuevas funcionalidades

- **Dashboard API v1.0.0 completo**
  - 4 nuevos endpoints de analytics: timeseries, exposure, vendedores, export
  - Sistema de alertas automáticas (HIGH_CXC, LOW_SALES, HIGH_EXPOSURE, OVERPAYMENT)
  - Comparación con periodo anterior (`compare=true`)
  - Intervalos temporales flexibles (day/hour) con validación
  - Performance metrics: `queryExecutionTime` y `totalQueries`
  - Documentación OpenAPI 3.1 completa en `openapi-dashboard-v1.yaml`

- **Payment Tracking en `/ventas/summary`**
  - 4 nuevos campos de pagos:
    - `totalPaid`: Total pagado a ganadores
    - `remainingAmount`: Premios pendientes de pago
    - `paidTicketsCount`: Tickets completamente pagados
    - `unpaidTicketsCount`: Tickets con pago pendiente
  - Lógica inteligente: cuenta tickets con `status='PAID'` O `remainingAmount=0`
  - Documentación completa en `docs/VENTAS_SUMMARY_API.md`

### 🔒 Security Fixes (CRÍTICOS)

- **RBAC Bug Fix #1**: `/ventas/breakdown` para usuarios VENTANA
  - Usuarios VENTANA veían vendedores de TODAS las ventanas
  - Fix: Fetch de `ventanaId` desde DB cuando falta en JWT
  - Permissive mode para transición gradual de tokens

- **RBAC Bug Fix #2**: `/tickets` para usuarios VENTANA
  - Mismo bug que #1, aplicado fix idéntico
  - Fetch automático desde DB con logging de warnings

- **RBAC Bug Fix #3**: `/tickets` para usuarios VENDEDOR
  - Filtro por `vendedorId` no se aplicaba correctamente
  - Fix: Mapeo de `vendedorId` → `userId` para compatibilidad con repository
  - Logging de mapeo para debug

### 🐛 Bug Fixes

- **Tickets PAID excluidos de reportes**
  - `/ventas/summary` tenía filtro hardcodeado `status IN ['ACTIVE', 'EVALUATED']`
  - Excluía todos los tickets con `status='PAID'`
  - Resultado: `payoutTotal`, `totalPaid`, `paidTicketsCount` siempre en 0
  - Fix: Removido filtro hardcodeado, ahora incluye TODOS los statuses
  - Afecta 5 endpoints: summary, list, breakdown, timeseries, facets

- **Validaciones faltantes en dashboard**
  - Parámetros `granularity` y `compare` causaban 400 Bad Request
  - Fix: Agregados a `DashboardQuerySchema` con validación estricta

- **Error de columna en exposure**
  - Query usaba `j."betType"` pero Jugada usa columna `type`
  - Fix: Cambiado a `j.type` en todas las queries de exposure

### ⚙️ Mejoras

- **RBAC centralizado con `applyRbacFilters()`**
  - Función unificada para aplicar filtros por rol
  - Fetch automático de `ventanaId` desde DB cuando falta en JWT
  - Logging estructurado: `VENTANA_FETCHING_FROM_DB`, `VENTANA_VENTANAID_LOADED`
  - Validación estricta con `validateVentanaUser()`

- **Debug logging completo**
  - `RBAC_DEBUG` antes de aplicar filtros
  - `RBAC_APPLIED` después de aplicar filtros
  - `VENDEDOR_MAPPING` para mapeo vendedorId → userId
  - Facilita troubleshooting de problemas RBAC

- **Documentación extendida**
  - `docs/DASHBOARD_API.md` - Especificación completa del Dashboard
  - `docs/VENTAS_SUMMARY_API.md` - API de ventas con payment tracking
  - `docs/BUG_FIX_RBAC_SCOPE_MINE.md` - Análisis completo del bug RBAC
  - `docs/JWT_TRANSITION_PLAN.md` - Plan de transición de JWTs
  - `README-DASHBOARD.md` - Guía del Dashboard API

### 📦 Archivos creados/modificados

**Nuevos:**
- `src/api/v1/services/dashboard.service.ts` - Lógica de dashboard
- `src/api/v1/controllers/dashboard.controller.ts` - Controladores dashboard
- `src/api/v1/routes/dashboard.routes.ts` - Rutas dashboard
- `src/api/v1/validators/dashboard.validator.ts` - Validaciones dashboard
- `docs/DASHBOARD_API.md` - Documentación completa
- `docs/VENTAS_SUMMARY_API.md` - Documentación de payment tracking
- `docs/BUG_FIX_RBAC_SCOPE_MINE.md` - Análisis de bugs RBAC
- `docs/JWT_TRANSITION_PLAN.md` - Guía de transición

**Modificados:**
- `src/utils/rbac.ts` - Función `applyRbacFilters()` y `validateVentanaUser()`
- `src/api/v1/controllers/venta.controller.ts` - Integración RBAC con logging
- `src/api/v1/controllers/ticket.controller.ts` - RBAC y mapeo vendedorId
- `src/api/v1/services/venta.service.ts` - Payment tracking y fix status filter
- `README.md` - 3 nuevas secciones: Dashboard, Payment Tracking, RBAC Security

### 🧪 Checklist de validación

- ✅ Usuario VENTANA en `/tickets?scope=mine` solo ve tickets de su ventana
- ✅ Usuario VENDEDOR en `/tickets?scope=mine` solo ve sus propios tickets
- ✅ `/ventas/summary` incluye tickets PAID en totales
- ✅ Payment tracking devuelve valores correctos (totalPaid, remainingAmount, counts)
- ✅ Dashboard timeseries retorna series temporales correctas
- ✅ Dashboard exposure calcula exposición financiera
- ✅ Alertas se generan correctamente según umbrales
- ✅ Logs RBAC muestran fetches desde DB para JWTs antiguos

### 🎯 Resultado

✅ **Dashboard API v1.0.0 completo** - 4 endpoints + 1 principal
✅ **Payment tracking funcional** - 4 nuevos campos en summary
✅ **3 bugs RBAC críticos corregidos** - Seguridad restaurada
✅ **1 bug de reportes corregido** - Tickets PAID ahora incluidos
✅ **Documentación completa** - 5 nuevos docs + README actualizado
✅ **TypeScript compilation 100%** - Sin errores

---

## 🚀 v1.0.0-rc8 - Idempotencia de Sorteos y UTC

Fecha: 2025-10-26
Rama: master

### ✅ Nuevas/Ajustes clave

- Restricción única en Sorteo: @@unique([loteriaId, scheduledAt]) (evita duplicados por lotería-fecha-hora).
- computeOccurrences migra a UTC (entradas iguales ⇒ salidas iguales).
  - Usa getUTCDay y setUTCHours para construir horas exactas.
- Seed idempotente que respeta subset del frontend:
  - POST /api/v1/loterias/:id/seed_sorteos?start&days&dryRun
  - Body opcional { scheduledDates: string[] ISO } ⇒ procesa exclusivamente esas fechas.
  - Respuesta detallada: created, skipped, lreadyExists, processed.
- Dedupe robusto:
  - In-memory por timestamp (getTime) y BD por índice único.
  - createMany({ skipDuplicates: true }) + manejo de P2002/23505 como "skipped".
  - Verificación post-inserción para contar creados reales bajo concurrencia.
- Creación de tickets: `vendedorId` opcional en body para ADMIN/VENTANA con validación de pertenencia a Ventana y rol VENDEDOR.

### 🧩 Migración

20251026215000_add_unique_sorteo_loteria_scheduledAt

`
CREATE UNIQUE INDEX IF NOT EXISTS "Sorteo_loteriaId_scheduledAt_key"
  ON "Sorteo" ("loteriaId", "scheduledAt");
`

Requiere limpiar duplicados existentes antes de deploy:db.

### 📚 Documentación

- README: sección "Idempotencia y UTC en Sorteos (rc8)".
- docs/architecture/Sorteos_Idempotencia_UTC.md con detalles técnicos y contratos.

### 🧪 Checklist de validación

- Medianoche: preview/seed antes y después de 00:00 ⇒ segunda corrida sin created (solo skipped/alreadyExists).
- Concurrencia: dos seeds simultáneos ⇒ sin duplicados; contaje correcto de created.
- Subset: enviando 2 timestamps ⇒ sólo esos se crean/procesan.
- TZ: re-lectura de scheduledAt conserva el mismo timestamp.

---<!-- markdownlint-disable MD024 -->

# 📘 CHANGELOG – Banca Management Backend

> Proyecto backend modular y escalable para la gestión integral de bancas de lotería.
> Desarrollado con **TypeScript**, **Express**, **Prisma ORM** y **PostgreSQL**, bajo arquitectura modular, con trazabilidad total mediante `ActivityLog`.

---

## 🏷️ v1.0.0 — Commission System & Sales Analytics

📅 **Fecha:** 2025-10-26
🔖 **Rama:** `master`

### ✳️ Nuevas funcionalidades

- **Sistema de Comisiones Jerárquico**
  - Políticas de comisión en JSON (version 1) con `percent` en escala 0-100.
  - Almacenamiento en `Banca.commissionPolicyJson`, `Ventana.commissionPolicyJson`, `User.commissionPolicyJson`.
  - Estructura: `defaultPercent` + `rules[]` con matching por `loteriaId`, `betType`, `multiplierRange`.
  - **Primera regla que calza gana** (orden del array importa).
  - Vigencia temporal con `effectiveFrom` y `effectiveTo` (ISO 8601).
  - Auto-generación de UUIDs para reglas sin `id` (Zod transform).

- **Snapshot Inmutable de Comisión por Jugada**
  - Campos en `Jugada`: `commissionPercent`, `commissionAmount`, `commissionOrigin`, `commissionRuleId`.
  - Resolución al momento de creación del ticket con prioridad **USER → VENTANA → BANCA**.
  - Persistencia inmutable (no se recalcula posteriormente).
  - Logging detallado en `ActivityLog.details.commissions` por cada jugada.

- **Endpoints CRUD de Políticas de Comisión (ADMIN only)**
  ```http
  PUT  /api/v1/bancas/:id/commission-policy
  GET  /api/v1/bancas/:id/commission-policy
  PUT  /api/v1/ventanas/:id/commission-policy
  GET  /api/v1/ventanas/:id/commission-policy
  PUT  /api/v1/users/:id/commission-policy
  GET  /api/v1/users/:id/commission-policy
  ```
  - Validación estricta con Zod schemas.
  - Permite establecer o remover (`null`) políticas.

- **Extensión de Endpoints de Analítica de Ventas**
  - `GET /api/v1/ventas/summary` incluye:
    - `commissionTotal`: Suma total de comisiones.
    - `netoDespuesComision`: `neto - commissionTotal`.
  - `GET /api/v1/ventas/breakdown` (5 dimensiones) incluye `commissionTotal` por grupo.
  - `GET /api/v1/ventas/timeseries` incluye `commissionTotal` por periodo temporal.

### ⚙️ Mejoras y endurecimientos

- **Manejo de errores graceful**
  - JSON malformado o políticas expiradas → `commissionPercent = 0`, WARN en logs, **no bloquea ventas**.
  - Validación de rangos: `min <= max`, `effectiveFrom <= effectiveTo`, `percent` 0-100.

- **Resolución robusta de comisión**
  - Matching exacto por `loteriaId` (o `null` = wildcard), `betType` (o `null`), `multiplierRange` inclusivo.
  - Fallback a `defaultPercent` si ninguna regla aplica.
  - Logging estructurado con origen, ruleId, percent y amount calculado.

- **Integración transaccional**
  - Resolución de comisión dentro de la transacción de creación de ticket.
  - Fetch de políticas en paralelo (`Promise.all`) junto con otras validaciones.
  - Cálculo de `commissionAmount` con redondeo a 2 decimales (`round2`).

### 📦 Migraciones

**Migration:** `20251026050708_add_commission_system`

```sql
ALTER TABLE "Banca" ADD COLUMN "commissionPolicyJson" JSONB;
ALTER TABLE "Ventana" ADD COLUMN "commissionPolicyJson" JSONB;
ALTER TABLE "User" ADD COLUMN "commissionPolicyJson" JSONB;

ALTER TABLE "Jugada" ADD COLUMN "commissionPercent" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "Jugada" ADD COLUMN "commissionAmount" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "Jugada" ADD COLUMN "commissionOrigin" TEXT;
ALTER TABLE "Jugada" ADD COLUMN "commissionRuleId" TEXT;
```

### 🧪 Checklist de pruebas

- Crear política de comisión en Banca/Ventana/User.
- Verificar prioridad USER > VENTANA > BANCA al crear ticket.
- Validar matching de reglas por lotería, betType y multiplierRange.
- Confirmar snapshot inmutable en Jugada (no recálculo).
- Verificar JSON malformado → 0% sin bloquear venta.
- Analítica: `commissionTotal` y `netoDespuesComision` correctos.

### 📚 Documentación

- **Documentación completa:** [`docs/COMMISSION_SYSTEM.md`](docs/COMMISSION_SYSTEM.md)
  - Estructura de JSON schema version 1
  - Reglas de matching y prioridades
  - Ejemplos de políticas (simple, por lotería, por betType, temporal)
  - Endpoints CRUD y analytics
  - Fórmulas de cálculo

- **README actualizado:** Sección "💰 Sistema de Comisiones" con características y endpoints.

### 🔌 Archivos creados/modificados

**Nuevos:**
- `src/services/commission.resolver.ts` — Motor de resolución de comisiones
- `src/api/v1/validators/commission.validator.ts` — Schemas Zod
- `src/api/v1/controllers/commission.controller.ts` — Controladores CRUD
- `src/api/v1/routes/commission.routes.ts` — Rutas de comisiones
- `docs/COMMISSION_SYSTEM.md` — Documentación completa

**Modificados:**
- `src/repositories/ticket.repository.ts` — Integración en creación de ticket
- `src/api/v1/services/venta.service.ts` — Métricas de comisión en analytics
- `src/prisma/schema.prisma` — 7 campos nuevos (3 JSONB, 4 en Jugada)
- `README.md` — Documentación principal actualizada

### 🧭 Guía de actualización

1. **Ejecutar migración:**
   ```bash
   npx prisma migrate deploy
   npx prisma generate
   ```

2. **Configurar políticas de comisión** (opcional):
   - Enviar `PUT /api/v1/bancas/:id/commission-policy` con JSON version 1.
   - Orden de reglas importa (primera match gana).

3. **Ejemplo de política básica:**
   ```json
   {
     "version": 1,
     "effectiveFrom": null,
     "effectiveTo": null,
     "defaultPercent": 5,
     "rules": [
       {
         "loteriaId": "uuid-loteria-especial",
         "betType": null,
         "multiplierRange": { "min": 0, "max": 999999 },
         "percent": 8.5
       }
     ]
   }
   ```

4. **Verificar analítica:**
   - `GET /api/v1/ventas/summary` ahora incluye `commissionTotal` y `netoDespuesComision`.

### 🎯 Resultado

✅ **Sistema de comisiones completo y funcional**
✅ **7 nuevos campos en base de datos**
✅ **6 endpoints CRUD + 3 endpoints analytics extendidos**
✅ **Documentación completa con ejemplos**
✅ **Integración transaccional y logging detallado**
✅ **Manejo graceful de errores (no bloquea ventas)**

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
  Cadena de resolución para `finalMultiplierX` y `multiplierId` "Base":
  1) `UserMultiplierOverride.baseMultiplierX`
  2) `BancaLoteriaSetting.baseMultiplierX`
  3) `LoteriaMultiplier(name="Base")` (o primer `kind="NUMERO"`)
  4) `Loteria.rulesJson.baseMultiplierX`
  5) `env MULTIPLIER_BASE_DEFAULT_X`
  Además, se **asegura** la fila `LoteriaMultiplier` "Base" si no existe.

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

- **400 por "claves no permitidas"** en `PUT /sorteos/:id` al enviar `extraOutcomeCode/extraMultiplierId`.
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
| **Reportes** | ✅ Completo | Dashboard + Analytics + Payment Tracking |

---

## 📦 Próximos pasos

1. **Mejorar módulo `TicketPayments`**
   - Integración completa con flujo de pagos múltiples
2. **Generar documentación OpenAPI / Swagger completa**
3. **CI/CD en GitHub Actions + Deploy Docker Compose (Postgres + API)**

---

## 🧭 Equipo y gestión

**Desarrollador responsable:**
👤 *Mario Quirós Pizarro* (`@MQuirosP`)
📧 `mquirosp78@gmail.com`
📍 Costa Rica

**Stack técnico:**
TypeScript · Express.js · Prisma ORM · PostgreSQL · JWT · Zod · Pino

---

> 💡 *Este release (v1.1.0) completa el Dashboard API, Payment Tracking y corrige bugs críticos de seguridad RBAC.*
> La próxima iteración se enfocará en mejoras del sistema de pagos y documentación OpenAPI completa.
