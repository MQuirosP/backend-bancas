# Dashboard API - Estado de Implementación

📅 **Fecha:** 2025-10-29
🏷️ **Versión:** v1.0.0 (Especificación)
⚠️ **Estado:** Implementación Parcial

---

## 📊 Resumen Ejecutivo

La especificación OpenAPI 3.1 completa del Dashboard API está **lista y documentada**, pero la implementación backend está **parcialmente completa**.

**Endpoints implementados:** 4/8 (50%)
**Endpoints pendientes:** 4/8 (50%)

---

## ✅ Endpoints IMPLEMENTADOS (Funcionan Ahora)

Los siguientes endpoints están **completamente implementados** y funcionando:

### 1. ✅ GET /api/v1/admin/dashboard
**Archivo:** [src/api/v1/controllers/dashboard.controller.ts:18-49](../../src/api/v1/controllers/dashboard.controller.ts#L18-L49)

**Estado:** ✅ Implementado

**Funcionalidad actual:**
- Retorna: `{ ganancia, cxc, cxp, summary, meta }`
- RBAC: ADMIN (total), VENTANA (limitado), VENDEDOR (403)
- Filtros: `date`, `fromDate`, `toDate`, `ventanaId`, `scope`

**Campos que FALTAN según spec:**
- ❌ `timeSeries[]` - Requiere implementación
- ❌ `exposure{}` - Requiere implementación
- ❌ `previousPeriod{}` - Requiere implementación
- ❌ `alerts[]` - Requiere implementación
- ❌ `summary.winRate` - Fácil de agregar
- ❌ `ganancia.margin` - Fácil de agregar
- ❌ `ganancia.totalSales` - Fácil de agregar
- ❌ `meta.queryExecutionTime` - Requiere middleware
- ❌ `meta.totalQueries` - Requiere middleware

**Action Required:**
- Extender `DashboardService.getFullDashboard()` para calcular campos faltantes
- Agregar middleware de performance tracking

---

### 2. ✅ GET /api/v1/admin/dashboard/ganancia
**Archivo:** [src/api/v1/controllers/dashboard.controller.ts:55-87](../../src/api/v1/controllers/dashboard.controller.ts#L55-L87)

**Estado:** ✅ Implementado

**Funcionalidad actual:**
- Retorna: `{ totalAmount, byVentana, byLoteria }`
- RBAC: ADMIN (total), VENTANA (limitado), VENDEDOR (403)
- Filtros: `date`, `fromDate`, `toDate`, `ventanaId`

**Campos que FALTAN según spec:**
- ❌ `totalSales` - Fácil de agregar
- ❌ `margin` - Cálculo simple: (totalAmount / totalSales) * 100
- ❌ `byVendedor[]` - Requiere nueva query
- ❌ `pagination` - Requiere implementación

**Filtros que FALTAN:**
- ❌ `loteriaId` - Agregar a where clause
- ❌ `betType` - Agregar a where clause
- ❌ `dimension` - Implementar switch case
- ❌ `top`, `orderBy`, `order` - Implementar ranking
- ❌ `page`, `pageSize` - Implementar paginación

**Action Required:**
- Extender `DashboardService.calculateGanancia()` para soportar nuevos filtros
- Agregar queries por dimensión (vendedor)

---

### 3. ✅ GET /api/v1/admin/dashboard/cxc
**Archivo:** [src/api/v1/controllers/dashboard.controller.ts:93-125](../../src/api/v1/controllers/dashboard.controller.ts#L93-L125)

**Estado:** ✅ Implementado

**Funcionalidad actual:**
- Retorna: `{ totalAmount, byVentana }`
- RBAC: ADMIN (total), VENTANA (limitado), VENDEDOR (403)
- Filtros: `date`, `fromDate`, `toDate`, `ventanaId`

**Campos que FALTAN según spec:**
- ❌ `aging[]` - Requiere query compleja con buckets temporales
- ❌ `pagination` - Requiere implementación

**Filtros que FALTAN:**
- ❌ `loteriaId` - Agregar a where clause
- ❌ `betType` - Agregar a where clause
- ❌ `aging=true` - Flag para incluir desglose
- ❌ `page`, `pageSize` - Implementar paginación

**Action Required:**
- Extender `DashboardService.calculateCxC()` para calcular aging
- Query adicional: agrupar por buckets de antigüedad (0-7, 8-14, 15-30, 31+)

---

### 4. ✅ GET /api/v1/admin/dashboard/cxp
**Archivo:** [src/api/v1/controllers/dashboard.controller.ts:131-163](../../src/api/v1/controllers/dashboard.controller.ts#L131-L163)

**Estado:** ✅ Implementado

**Funcionalidad actual:**
- Retorna: `{ totalAmount, byVentana }`
- RBAC: ADMIN (total), VENTANA (limitado), VENDEDOR (403)
- Filtros: `date`, `fromDate`, `toDate`, `ventanaId`

**Campos que FALTAN según spec:**
- ❌ `pagination` - Requiere implementación

**Filtros que FALTAN:**
- ❌ `loteriaId` - Agregar a where clause
- ❌ `betType` - Agregar a where clause
- ❌ `page`, `pageSize` - Implementar paginación

**Action Required:**
- Extender `DashboardService.calculateCxP()` para soportar nuevos filtros

---

## ❌ Endpoints NO IMPLEMENTADOS (Devuelven 404)

Los siguientes endpoints están **solo en la especificación** y devuelven **404 Not Found**:

### 5. ❌ GET /api/v1/admin/dashboard/timeseries
**Archivo:** NO EXISTE

**Estado:** ❌ No Implementado (404)

**Qué debe hacer:**
- Retornar serie temporal de ventas/comisiones/tickets
- Agrupación por día o por hora
- Validación: `interval=hour` solo si rango ≤ 7 días

**Query necesaria:**
```typescript
// Pseudo-código
const timeSeries = await prisma.$queryRaw`
  SELECT
    DATE_TRUNC('day', t."createdAt") as date,  -- o 'hour' si interval=hour
    SUM(t."totalAmount") as sales,
    SUM(j."commissionAmount") as commissions,
    COUNT(t.id) as tickets
  FROM "Ticket" t
  LEFT JOIN "Jugada" j ON t.id = j."ticketId" AND j."isWinner" = true
  WHERE t."deletedAt" IS NULL
    AND t."createdAt" >= ${fromDate}
    AND t."createdAt" <= ${toDate}
    -- Filtros adicionales
  GROUP BY DATE_TRUNC('day', t."createdAt")
  ORDER BY date ASC
`;
```

**Archivos a crear:**
1. Agregar método `DashboardService.getTimeSeries()`
2. Agregar método `DashboardController.getTimeSeries()`
3. Agregar ruta en `dashboard.routes.ts`

**Prioridad:** 🔴 ALTA (Gráficos de línea críticos para frontend)

---

### 6. ❌ GET /api/v1/admin/dashboard/exposure
**Archivo:** NO EXISTE

**Estado:** ❌ No Implementado (404)

**Qué debe hacer:**
- Top números con mayor venta
- Heatmap de ventas por número (00-99)
- Exposición por lotería con ratio (potentialPayout / sales)

**Queries necesarias:**
```typescript
// 1. Top números
const topNumbers = await prisma.$queryRaw`
  SELECT
    j.number,
    j.type as "betType",
    SUM(j.amount) as sales,
    SUM(j.amount * j."finalMultiplierX") as "potentialPayout",
    (SUM(j.amount * j."finalMultiplierX") / NULLIF(SUM(j.amount), 0)) as ratio
  FROM "Jugada" j
  JOIN "Ticket" t ON j."ticketId" = t.id
  WHERE t."deletedAt" IS NULL
    AND t."createdAt" >= ${fromDate}
    AND t."createdAt" <= ${toDate}
  GROUP BY j.number, j.type
  ORDER BY sales DESC
  LIMIT ${top || 10}
`;

// 2. Heatmap (todos los números)
const heatmap = await prisma.$queryRaw`
  SELECT
    j.number,
    SUM(j.amount) as sales
  FROM "Jugada" j
  JOIN "Ticket" t ON j."ticketId" = t.id
  WHERE t."deletedAt" IS NULL
    AND t."createdAt" >= ${fromDate}
    AND t."createdAt" <= ${toDate}
  GROUP BY j.number
  ORDER BY j.number ASC
`;

// 3. Por lotería
const byLoteria = await prisma.$queryRaw`
  SELECT
    l.id as "loteriaId",
    l.name as "loteriaName",
    SUM(j.amount) as sales,
    SUM(j.amount * j."finalMultiplierX") as "potentialPayout"
  FROM "Jugada" j
  JOIN "Ticket" t ON j."ticketId" = t.id
  JOIN "Loteria" l ON t."loteriaId" = l.id
  WHERE t."deletedAt" IS NULL
    AND t."createdAt" >= ${fromDate}
    AND t."createdAt" <= ${toDate}
  GROUP BY l.id, l.name
  ORDER BY sales DESC
`;
```

**Archivos a crear:**
1. Agregar método `DashboardService.calculateExposure()`
2. Agregar método `DashboardController.getExposure()`
3. Agregar ruta en `dashboard.routes.ts`

**Prioridad:** 🔴 ALTA (Gestión de riesgo crítica)

---

### 7. ❌ GET /api/v1/admin/dashboard/vendedores
**Archivo:** NO EXISTE

**Estado:** ❌ No Implementado (404)

**Qué debe hacer:**
- Ranking de vendedores con métricas
- Sales, commissions, tickets, winners, avgTicket
- Ordenamiento y top N

**Query necesaria:**
```typescript
const byVendedor = await prisma.$queryRaw`
  SELECT
    u.id as "vendedorId",
    u.name as "vendedorName",
    SUM(t."totalAmount") as sales,
    SUM(j."commissionAmount") as commissions,
    COUNT(DISTINCT t.id) as tickets,
    COUNT(DISTINCT CASE WHEN t."isWinner" = true THEN t.id END) as winners,
    (SUM(t."totalAmount") / NULLIF(COUNT(DISTINCT t.id), 0)) as "avgTicket"
  FROM "User" u
  JOIN "Ticket" t ON u.id = t."vendedorId"
  LEFT JOIN "Jugada" j ON t.id = j."ticketId" AND j."isWinner" = true
  WHERE t."deletedAt" IS NULL
    AND t."createdAt" >= ${fromDate}
    AND t."createdAt" <= ${toDate}
  GROUP BY u.id, u.name
  ORDER BY ${orderBy} ${order}
  LIMIT ${top || pageSize}
  OFFSET ${(page - 1) * pageSize}
`;
```

**Archivos a crear:**
1. Agregar método `DashboardService.getVendedores()`
2. Agregar método `DashboardController.getVendedores()`
3. Agregar ruta en `dashboard.routes.ts`

**Prioridad:** 🟡 MEDIA (Útil pero no crítico)

---

### 8. ❌ GET /api/v1/admin/dashboard/export
**Archivo:** NO EXISTE

**Estado:** ❌ No Implementado (404)

**Qué debe hacer:**
- Exportar datos del dashboard en CSV/XLSX/PDF
- Respeta filtros aplicados
- Descarga directa de archivo

**Implementación necesaria:**
```typescript
// Usar librerías:
// - CSV: csv-stringify
// - XLSX: xlsx
// - PDF: pdfkit

async exportDashboard(req, res) {
  const format = req.query.format; // csv | xlsx | pdf
  const data = await DashboardService.getFullDashboard(filters);

  switch (format) {
    case 'csv':
      return exportCSV(data, res);
    case 'xlsx':
      return exportXLSX(data, res);
    case 'pdf':
      return exportPDF(data, res);
  }
}
```

**Archivos a crear:**
1. Agregar método `DashboardController.exportDashboard()`
2. Agregar helpers: `exportCSV()`, `exportXLSX()`, `exportPDF()`
3. Agregar ruta en `dashboard.routes.ts`
4. Instalar dependencias: `csv-stringify`, `xlsx`, `pdfkit`

**Prioridad:** 🟢 BAJA (Nice to have)

---

## 🛠️ Roadmap de Implementación

### Phase 1: Campos Faltantes en Endpoints Existentes (1-2 días)
**Objetivo:** Completar campos faltantes en endpoints ya implementados

**Tareas:**
- [ ] Agregar `summary.winRate` al dashboard principal
- [ ] Agregar `ganancia.margin` y `ganancia.totalSales`
- [ ] Agregar middleware de performance (`queryExecutionTime`, `totalQueries`)
- [ ] Agregar filtros `loteriaId` y `betType` a ganancia/cxc/cxp
- [ ] Tests unitarios para nuevos campos

**Archivos a modificar:**
- `src/api/v1/services/dashboard.service.ts`
- `src/api/v1/controllers/dashboard.controller.ts`
- `src/middlewares/performance.middleware.ts` (crear)

---

### Phase 2: TimeSeries y Exposure (2-3 días)
**Objetivo:** Implementar endpoints críticos para gráficos y gestión de riesgo

**Tareas:**
- [ ] Implementar `GET /admin/dashboard/timeseries`
  - [ ] Service: `DashboardService.getTimeSeries()`
  - [ ] Controller: `DashboardController.getTimeSeries()`
  - [ ] Route: Agregar a `dashboard.routes.ts`
  - [ ] Validación: `interval=hour` solo si rango ≤ 7 días
  - [ ] Tests unitarios
- [ ] Implementar `GET /admin/dashboard/exposure`
  - [ ] Service: `DashboardService.calculateExposure()`
  - [ ] Controller: `DashboardController.getExposure()`
  - [ ] Route: Agregar a `dashboard.routes.ts`
  - [ ] Tests unitarios

**Archivos a crear/modificar:**
- `src/api/v1/services/dashboard.service.ts` (extender)
- `src/api/v1/controllers/dashboard.controller.ts` (extender)
- `src/api/v1/routes/dashboard.routes.ts` (agregar rutas)

---

### Phase 3: Características Avanzadas (2-3 días)
**Objetivo:** Agregar campos opcionales al dashboard principal

**Tareas:**
- [ ] Implementar `previousPeriod{}` (comparación período vs período)
  - Calcular período anterior automáticamente
  - Incluir summary, ganancia, cxc, cxp
- [ ] Implementar `alerts[]` (sistema de alertas)
  - Configurar thresholds (env vars)
  - Lógica de detección: HIGH_CXC, LOW_SALES, HIGH_EXPOSURE, OVERPAYMENT
  - Severidades: info, warn, critical
  - Acciones sugeridas
- [ ] Integrar `timeSeries` y `exposure` en dashboard principal
- [ ] Tests de integración

**Archivos a modificar:**
- `src/api/v1/services/dashboard.service.ts`
- `.env.example` (agregar thresholds)

---

### Phase 4: Vendedores y Paginación (2 días)
**Objetivo:** Implementar ranking de vendedores y paginación

**Tareas:**
- [ ] Implementar `GET /admin/dashboard/vendedores`
  - [ ] Service: `DashboardService.getVendedores()`
  - [ ] Controller: `DashboardController.getVendedores()`
  - [ ] Route: Agregar a `dashboard.routes.ts`
  - [ ] Paginación con `page`, `pageSize`
  - [ ] Tests unitarios
- [ ] Agregar paginación a ganancia/cxc/cxp
  - [ ] Helper: `paginateResults()`
  - [ ] Metadata: `{ page, pageSize, total }`

**Archivos a crear/modificar:**
- `src/api/v1/services/dashboard.service.ts` (extender)
- `src/api/v1/controllers/dashboard.controller.ts` (extender)
- `src/utils/pagination.ts` (ya existe, reutilizar)

---

### Phase 5: Redis Cache y ETag (1-2 días)
**Objetivo:** Implementar caché para mejorar performance

**Tareas:**
- [ ] Configurar cliente Redis
- [ ] Implementar middleware de caché
  - [ ] Cache key: `dashboard:${hash(filters)}`
  - [ ] TTL: 300s (configurable)
- [ ] Implementar ETag support
  - [ ] Hash de respuesta
  - [ ] Header `If-None-Match`
  - [ ] Response 304 Not Modified
- [ ] Tests de caché

**Archivos a crear:**
- `src/core/redis.ts` (cliente Redis)
- `src/middlewares/cache.middleware.ts` (caché)
- `src/middlewares/etag.middleware.ts` (ETag)

**Dependencias:**
```bash
npm install ioredis
npm install @types/ioredis --save-dev
```

---

### Phase 6: Aging y Dimensiones (1-2 días)
**Objetivo:** Agregar aging a CxC y dimensiones a ganancia

**Tareas:**
- [ ] Implementar aging en CxC
  - [ ] Query con buckets: 0-7, 8-14, 15-30, 31+
  - [ ] Flag `aging=true`
  - [ ] Tests unitarios
- [ ] Implementar dimensiones en ganancia
  - [ ] Dimension: `ventana` (ya existe)
  - [ ] Dimension: `loteria` (ya existe)
  - [ ] Dimension: `vendedor` (nuevo)
  - [ ] Switch case en service
  - [ ] Tests unitarios

**Archivos a modificar:**
- `src/api/v1/services/dashboard.service.ts`

---

### Phase 7: Export (1-2 días)
**Objetivo:** Implementar exportación de datos

**Tareas:**
- [ ] Implementar `GET /admin/dashboard/export`
  - [ ] Helper: `exportCSV()`
  - [ ] Helper: `exportXLSX()`
  - [ ] Helper: `exportPDF()`
  - [ ] Controller: `DashboardController.exportDashboard()`
  - [ ] Route: Agregar a `dashboard.routes.ts`
  - [ ] Tests unitarios
- [ ] Instalar dependencias

**Dependencias:**
```bash
npm install csv-stringify
npm install xlsx
npm install pdfkit
npm install @types/pdfkit --save-dev
```

**Archivos a crear:**
- `src/utils/export/csv.ts`
- `src/utils/export/xlsx.ts`
- `src/utils/export/pdf.ts`

---

### Phase 8: Testing y QA (2-3 días)
**Objetivo:** Garantizar calidad y compatibilidad

**Tareas:**
- [ ] Tests unitarios completos (coverage ≥80%)
- [ ] Tests de integración (RBAC, filtros)
- [ ] Tests de caché (hit/miss, ETag 304)
- [ ] Tests de compatibilidad v1 (sin breaking changes)
- [ ] Load testing (verificar SLO p95)
- [ ] Validación OpenAPI (prism/swagger-ui)

**Herramientas:**
```bash
npm test -- --coverage
npm run test:e2e
k6 run load-test.js  # Load testing
```

---

## 📈 Estimación Total

**Total de días:** 14-19 días (3-4 semanas)

**Por fase:**
- Phase 1: 1-2 días
- Phase 2: 2-3 días
- Phase 3: 2-3 días
- Phase 4: 2 días
- Phase 5: 1-2 días
- Phase 6: 1-2 días
- Phase 7: 1-2 días
- Phase 8: 2-3 días

**Priorización recomendada:**
1. 🔴 Phase 1 + Phase 2 (TimeSeries y Exposure críticos)
2. 🟡 Phase 3 (Alerts y previousPeriod)
3. 🟡 Phase 5 (Cache para performance)
4. 🟢 Phase 4, 6, 7 (Nice to have)

---

## 🚨 Solución Temporal para Frontend

Mientras se implementan los endpoints faltantes, el frontend debe:

### 1. Detectar 404 y Deshabilitar Features

```typescript
// Ejemplo: Wrapper de API con fallback
async function fetchTimeSeries(params) {
  try {
    const response = await fetch('/api/v1/admin/dashboard/timeseries?' + params);
    if (response.status === 404) {
      console.warn('Endpoint timeseries not implemented yet');
      return null; // o datos mock
    }
    return await response.json();
  } catch (error) {
    console.error('Error fetching timeseries:', error);
    return null;
  }
}

// En el componente
const TimeSeriesChart = () => {
  const { data, loading, error } = useTimeSeries(filters);

  if (!data) {
    return (
      <div className="coming-soon">
        <p>📊 Time Series Chart</p>
        <p>Coming soon - Under development</p>
      </div>
    );
  }

  return <LineChart data={data} />;
};
```

---

### 2. Usar Solo Campos Disponibles

```typescript
// Dashboard principal - Solo usar campos existentes
interface DashboardData {
  summary: {
    totalSales: number;
    totalTickets: number;
    totalWinners: number;
    totalCommissions: number;
    // winRate: number;  ← NO DISPONIBLE aún
  };
  ganancia: {
    totalAmount: number;
    // totalSales: number;  ← NO DISPONIBLE aún
    // margin: number;      ← NO DISPONIBLE aún
    byVentana: VentanaGanancia[];
    byLoteria: LoteriaGanancia[];
  };
  cxc: { ... };
  cxp: { ... };
  // timeSeries: [];      ← NO DISPONIBLE (404)
  // exposure: {};        ← NO DISPONIBLE (404)
  // previousPeriod: {};  ← NO DISPONIBLE aún
  // alerts: [];          ← NO DISPONIBLE aún
  meta: {
    range: { fromAt: string; toAt: string };
    generatedAt: string;
    // queryExecutionTime: number;  ← NO DISPONIBLE aún
    // totalQueries: number;        ← NO DISPONIBLE aún
  };
}
```

---

### 3. Mock Data para Desarrollo

```typescript
// mock/dashboard.ts
export const mockTimeSeries = [
  { date: '2025-10-23', sales: 148000, commissions: 7400, tickets: 1233 },
  { date: '2025-10-24', sales: 152000, commissions: 7600, tickets: 1267 },
  // ...
];

export const mockExposure = {
  topNumbers: [
    { number: '00', betType: 'NUMERO', sales: 15000, potentialPayout: 1050000, ratio: 70 },
    // ...
  ],
  heatmap: [/* ... */],
  byLoteria: [/* ... */],
};

// Usar en componente si endpoint no existe
const data = useTimeSeries() || mockTimeSeries;
```

---

## 📞 Comunicación con Frontend

### ⚠️ Endpoints que Devuelven 404 Ahora

Informar al equipo de frontend que estos endpoints NO están implementados:

1. ❌ `GET /api/v1/admin/dashboard/timeseries` → **404**
2. ❌ `GET /api/v1/admin/dashboard/exposure` → **404**
3. ❌ `GET /api/v1/admin/dashboard/vendedores` → **404**
4. ❌ `GET /api/v1/admin/dashboard/export` → **404**

### ✅ Endpoints que Funcionan Ahora

Estos endpoints están disponibles pero con campos limitados:

1. ✅ `GET /api/v1/admin/dashboard` - Funciona (campos: summary, ganancia, cxc, cxp, meta)
2. ✅ `GET /api/v1/admin/dashboard/ganancia` - Funciona (campos: totalAmount, byVentana, byLoteria)
3. ✅ `GET /api/v1/admin/dashboard/cxc` - Funciona (campos: totalAmount, byVentana)
4. ✅ `GET /api/v1/admin/dashboard/cxp` - Funciona (campos: totalAmount, byVentana)

**Campos opcionales que NO están disponibles aún:**
- `summary.winRate`
- `ganancia.margin`, `ganancia.totalSales`
- `meta.queryExecutionTime`, `meta.totalQueries`
- `timeSeries[]`, `exposure{}`, `previousPeriod{}`, `alerts[]`

---

## 📋 Checklist de Implementación

### Endpoints
- [x] GET /admin/dashboard (parcial)
- [x] GET /admin/dashboard/ganancia (parcial)
- [x] GET /admin/dashboard/cxc (parcial)
- [x] GET /admin/dashboard/cxp (parcial)
- [ ] GET /admin/dashboard/timeseries
- [ ] GET /admin/dashboard/exposure
- [ ] GET /admin/dashboard/vendedores
- [ ] GET /admin/dashboard/export

### Campos Opcionales
- [ ] summary.winRate
- [ ] ganancia.margin
- [ ] ganancia.totalSales
- [ ] meta.queryExecutionTime
- [ ] meta.totalQueries
- [ ] timeSeries[]
- [ ] exposure{}
- [ ] previousPeriod{}
- [ ] alerts[]

### Filtros Nuevos
- [ ] loteriaId (ganancia, cxc, cxp)
- [ ] betType (ganancia, cxc, cxp)
- [ ] dimension (ganancia)
- [ ] top (ganancia, exposure, vendedores)
- [ ] orderBy (ganancia, vendedores)
- [ ] order (ganancia, vendedores)
- [ ] interval (timeseries)
- [ ] aging (cxc)
- [ ] page, pageSize (paginación)

### Features
- [ ] Redis cache
- [ ] ETag support
- [ ] Sistema de alertas
- [ ] Aging en CxC
- [ ] Comparación período anterior
- [ ] Exportación (CSV/XLSX/PDF)

### Testing
- [ ] Tests unitarios (≥80% coverage)
- [ ] Tests de integración
- [ ] Tests de caché
- [ ] Tests de RBAC
- [ ] Load testing (SLO verification)

---

## 📚 Documentación

**Especificación completa:**
- [openapi-dashboard-v1.yaml](../../openapi-dashboard-v1.yaml)
- [README-DASHBOARD.md](../../README-DASHBOARD.md)
- [CHANGELOG-DASHBOARD.md](../../CHANGELOG-DASHBOARD.md)

**Implementación actual:**
- [dashboard.controller.ts](../../src/api/v1/controllers/dashboard.controller.ts)
- [dashboard.service.ts](../../src/api/v1/services/dashboard.service.ts)
- [dashboard.routes.ts](../../src/api/v1/routes/dashboard.routes.ts)

---

**Última actualización:** 2025-10-29
**Autor:** Backend Team
