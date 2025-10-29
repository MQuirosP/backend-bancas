# Dashboard API - Documentación Completa v1.0.0

## 📋 Tabla de Contenidos

1. [Descripción General](#descripción-general)
2. [Endpoints Disponibles](#endpoints-disponibles)
3. [Filtros y Parámetros](#filtros-y-parámetros)
4. [Convenciones de Fechas](#convenciones-de-fechas)
5. [Control de Acceso (RBAC)](#control-de-acceso-rbac)
6. [Caché y Performance](#caché-y-performance)
7. [Sistema de Alertas](#sistema-de-alertas)
8. [Ejemplos curl](#ejemplos-curl)
9. [Compatibilidad y Versionado](#compatibilidad-y-versionado)
10. [Códigos de Error](#códigos-de-error)

---

## Descripción General

El módulo Dashboard proporciona métricas financieras y analíticas consolidadas para la gestión operativa y toma de decisiones en el sistema de bancas.

### Características Principales

✅ **Métricas Consolidadas**
- Resumen de ventas, comisiones, tickets y ganadores
- Cuentas por cobrar (CxC) y por pagar (CxP)
- Exposición financiera por número y lotería
- Ranking de vendedores y métricas por dimensión

✅ **Zona Horaria America/Costa_Rica (GMT-6)**
- Todas las fechas de entrada se interpretan en hora local de Costa Rica
- Timestamps de respuesta incluyen offset -06:00
- Sin horario de verano (DST) - offset constante

✅ **Filtros Flexibles**
- Presets de fecha: today, yesterday, week, month, year, range
- Filtros por ventana, lotería, tipo de apuesta
- Agrupación por dimensión (ventana, lotería, vendedor)
- Ranking con top N y ordenamiento personalizado

✅ **Performance y Caché**
- Redis con TTL configurable (default: 300s)
- ETag para validación de caché (304 Not Modified)
- SLO: p95 ≤ 800ms (caliente) / ≤ 1500ms (frío)
- Métricas de performance en respuesta (queryExecutionTime, totalQueries)

✅ **Control de Acceso (RBAC)**
- ADMIN: Acceso total, filtros opcionales
- VENTANA: Scope limitado a su ventana
- VENDEDOR: Bloqueado (403 Forbidden)

---

## Endpoints Disponibles

### 1. Dashboard Principal

```http
GET /api/v1/admin/dashboard
```

**Descripción:** Retorna dashboard completo con todas las métricas consolidadas.

**Incluye:**
- `summary`: Totales de ventas, tickets, comisiones, tasa de ganadores
- `ganancia`: Desglose de comisiones por ventana y lotería
- `cxc`: Cuentas por cobrar con detalle por ventana
- `cxp`: Cuentas por pagar (overpayments)
- `timeSeries`: Serie temporal para gráficos
- `exposure`: Exposición financiera por número y lotería
- `previousPeriod`: Comparación con período anterior
- `alerts`: Alertas de negocio (CxC alto, ventas bajas, exposición alta)
- `meta`: Metadata de la consulta

**Para qué se usa:**
- Vista principal de administración
- Monitoreo en tiempo real de operaciones
- Identificación rápida de problemas (alertas)
- Comparación de rendimiento período vs período

---

### 2. Ganancia Detallada

```http
GET /api/v1/admin/dashboard/ganancia
```

**Descripción:** Desglose detallado de comisiones con agrupación por dimensión.

**Cálculos:**
- `totalAmount`: SUM(commissionAmount) WHERE isWinner=true
- `margin`: (totalCommissions / totalSales) * 100

**Para qué se usa:**
- Análisis de rentabilidad por ventana/lotería/vendedor
- Identificación de mejores performers
- Decisiones de incentivos y comisiones

---

### 3. Cuentas por Cobrar (CxC)

```http
GET /api/v1/admin/dashboard/cxc
```

**Descripción:** Dinero pendiente que ventanas deben al banco.

**Cálculo:**
- `CxC = Total Ventas - Total Pagado`
- Solo incluye montos positivos (debe > 0)

**Aging (opcional):**
- Desglose por antigüedad de deuda
- Buckets: 0-7, 8-14, 15-30, 31+ días

**Para qué se usa:**
- Gestión de crédito y cobranza
- Identificación de ventanas con deuda alta
- Análisis de antigüedad de saldos

---

### 4. Cuentas por Pagar (CxP)

```http
GET /api/v1/admin/dashboard/cxp
```

**Descripción:** Overpayments - dinero que banco debe a ventanas.

**Cálculo:**
- `CxP = Total Pagado - Total Premios`
- Solo incluye montos positivos (overpayment > 0)

**Para qué se usa:**
- Identificar errores de pago
- Regularización de saldos
- Auditoría de pagos

---

### 5. Serie Temporal

```http
GET /api/v1/admin/dashboard/timeseries
```

**Descripción:** Datos de serie temporal para gráficos de línea/área.

**Intervalos:**
- `day`: Agrupación diaria (default)
- `hour`: Agrupación por hora (solo si rango ≤ 7 días)

**Para qué se usa:**
- Gráficos de tendencias
- Análisis de patrones temporales
- Identificación de picos y valles

---

### 6. Exposición Financiera

```http
GET /api/v1/admin/dashboard/exposure
```

**Descripción:** Análisis de exposición por número y lotería.

**Incluye:**
- `topNumbers`: Números con mayor venta y payout potencial
- `heatmap`: Matriz de ventas por número (00-99)
- `byLoteria`: Exposición agregada por lotería

**Ratio de Exposición:**
- `ratio = potentialPayout / sales`
- Valores altos (>100) indican alta exposición financiera

**Para qué se usa:**
- Gestión de riesgo
- Identificación de concentración de ventas
- Decisiones de límites y restricciones

---

### 7. Ranking de Vendedores

```http
GET /api/v1/admin/dashboard/vendedores
```

**Descripción:** Métricas detalladas por vendedor.

**Incluye:**
- Ventas totales
- Comisiones generadas
- Cantidad de tickets
- Tickets ganadores
- Ticket promedio (sales / tickets)

**Para qué se usa:**
- Gestión de equipo de ventas
- Definición de metas e incentivos
- Identificación de top performers

---

### 8. Exportación de Datos

```http
GET /api/v1/admin/dashboard/export
```

**Descripción:** Exporta datos del dashboard en formato especificado.

**Formatos:**
- `csv`: Valores separados por coma (UTF-8 BOM)
- `xlsx`: Microsoft Excel
- `pdf`: Reporte PDF con gráficos

**Para qué se usa:**
- Reportes para gerencia
- Análisis offline
- Archivos para auditoría

---

## Filtros y Parámetros

### Tabla de Filtros Soportados

| Parámetro | Tipo | Descripción | Valores | Default | Endpoints |
|-----------|------|-------------|---------|---------|-----------|
| `date` | enum | Preset de fecha | `today`, `yesterday`, `week`, `month`, `year`, `range` | `today` | Todos |
| `fromDate` | string | Fecha inicio (YYYY-MM-DD) | - | - | Todos (requerido si `date=range`) |
| `toDate` | string | Fecha fin (YYYY-MM-DD) | - | - | Todos (requerido si `date=range`) |
| `ventanaId` | uuid | Filtrar por ventana | UUID | - | Todos |
| `loteriaId` | uuid | Filtrar por lotería | UUID | - | Todos |
| `betType` | enum | Tipo de apuesta | `NUMERO`, `REVENTADO` | - | Todos |
| `dimension` | enum | Agrupación | `ventana`, `loteria`, `vendedor` | `ventana` | ganancia |
| `top` | integer | Limitar a top N | 1-100 | - | ganancia, exposure, vendedores |
| `orderBy` | enum | Campo ordenamiento | `sales`, `commissions`, `amount`, `margin`, `tickets`, `winners`, `avgTicket` | `sales` | ganancia, vendedores |
| `order` | enum | Dirección | `asc`, `desc` | `desc` | ganancia, vendedores |
| `interval` | enum | Intervalo temporal | `day`, `hour` | `day` | dashboard, timeseries |
| `aging` | boolean | Incluir aging | `true`, `false` | `false` | cxc |
| `format` | enum | Formato exportación | `csv`, `xlsx`, `pdf` | - | export (requerido) |
| `page` | integer | Número de página | ≥1 | 1 | Con paginación |
| `pageSize` | integer | Elementos por página | 1-100 | 20 | Con paginación |

### Combinaciones Válidas

#### ✅ Válido: Preset simple
```http
GET /api/v1/admin/dashboard?date=today
```

#### ✅ Válido: Rango personalizado
```http
GET /api/v1/admin/dashboard?date=range&fromDate=2025-10-01&toDate=2025-10-31
```

#### ✅ Válido: Preset con filtros adicionales
```http
GET /api/v1/admin/dashboard/ganancia?date=week&ventanaId=550e8400-e29b-41d4-a716-446655440000&loteriaId=660e8400-e29b-41d4-a716-446655440000
```

#### ✅ Válido: Ranking top 5
```http
GET /api/v1/admin/dashboard/vendedores?date=month&top=5&orderBy=commissions&order=desc
```

#### ✅ Válido: Serie temporal por hora
```http
GET /api/v1/admin/dashboard/timeseries?date=today&interval=hour
```

#### ❌ Inválido: Rango sin fechas
```http
GET /api/v1/admin/dashboard?date=range
# Error 422: fromDate y toDate son requeridos
```

#### ❌ Inválido: fromDate > toDate
```http
GET /api/v1/admin/dashboard?date=range&fromDate=2025-10-31&toDate=2025-10-01
# Error 422: fromDate must be before or equal to toDate
```

#### ❌ Inválido: interval=hour con rango > 7 días
```http
GET /api/v1/admin/dashboard/timeseries?date=month&interval=hour
# Error 422: interval=hour is only allowed for ranges <= 7 days
```

---

## Convenciones de Fechas

### Zona Horaria: America/Costa_Rica (GMT-6)

**Características:**
- Offset fijo: -06:00 (no usa horario de verano)
- Todas las fechas de entrada se interpretan en hora local
- Timestamps de respuesta incluyen offset explícito

### Resolución de Presets a Rangos

El backend convierte presets a rangos UTC usando hora local de Costa Rica:

| Preset | fromAt (local CR) | toAt (local CR) | Ejemplo (2025-10-29) |
|--------|-------------------|-----------------|----------------------|
| `today` | Hoy 00:00:00 | Hoy 23:59:59 | `2025-10-29T00:00:00.000-06:00` → `2025-10-29T23:59:59.999-06:00` |
| `yesterday` | Ayer 00:00:00 | Ayer 23:59:59 | `2025-10-28T00:00:00.000-06:00` → `2025-10-28T23:59:59.999-06:00` |
| `week` | Hace 7 días 00:00:00 | Hoy 23:59:59 | `2025-10-22T00:00:00.000-06:00` → `2025-10-29T23:59:59.999-06:00` |
| `month` | Hace 30 días 00:00:00 | Hoy 23:59:59 | `2025-09-29T00:00:00.000-06:00` → `2025-10-29T23:59:59.999-06:00` |
| `year` | Hace 365 días 00:00:00 | Hoy 23:59:59 | `2024-10-29T00:00:00.000-06:00` → `2025-10-29T23:59:59.999-06:00` |
| `range` | fromDate 00:00:00 | toDate 23:59:59 | Definido por usuario |

### Formato de Fechas

**Entrada (Query Parameters):**
```
fromDate=2025-10-01  (formato: YYYY-MM-DD)
toDate=2025-10-31    (formato: YYYY-MM-DD)
```

**Salida (Responses):**
```json
{
  "meta": {
    "range": {
      "fromAt": "2025-10-01T00:00:00.000-06:00",  // ISO 8601 con offset
      "toAt": "2025-10-31T23:59:59.999-06:00"
    },
    "generatedAt": "2025-10-29T15:30:00.000-06:00"
  }
}
```

### Normalización Interna

El backend usa la utilidad `resolveDateRange()` ([src/utils/dateRange.ts](src/utils/dateRange.ts)) que:

1. **Interpreta fechas en hora local de Costa Rica**
2. **Convierte a UTC para queries** (con offset -6 horas)
3. **Retorna Date objects** para uso en Prisma

**Ejemplo:**
```typescript
resolveDateRange('today', undefined, undefined)
// Input: "today" (2025-10-29 en CR)
// Output: {
//   fromAt: Date(2025-10-29T06:00:00.000Z),  // 00:00 CR = 06:00 UTC
//   toAt:   Date(2025-10-30T05:59:59.999Z)   // 23:59 CR = 05:59 UTC (next day)
// }
```

### Límites Inclusivos

**IMPORTANTE:** Los rangos son **inclusivos** en ambos extremos:

- `fromAt`: Incluye el primer milisegundo del día (`00:00:00.000`)
- `toAt`: Incluye el último milisegundo del día (`23:59:59.999`)

**Query SQL:**
```sql
WHERE ticket.createdAt >= fromAt AND ticket.createdAt <= toAt
```

---

## Control de Acceso (RBAC)

### Matriz de Permisos

| Endpoint | ADMIN | VENTANA | VENDEDOR |
|----------|-------|---------|----------|
| `GET /admin/dashboard` | ✅ Total | ✅ Limitado | ❌ 403 |
| `GET /admin/dashboard/ganancia` | ✅ Total | ✅ Limitado | ❌ 403 |
| `GET /admin/dashboard/cxc` | ✅ Total | ✅ Limitado | ❌ 403 |
| `GET /admin/dashboard/cxp` | ✅ Total | ✅ Limitado | ❌ 403 |
| `GET /admin/dashboard/timeseries` | ✅ Total | ✅ Limitado | ❌ 403 |
| `GET /admin/dashboard/exposure` | ✅ Total | ✅ Limitado | ❌ 403 |
| `GET /admin/dashboard/vendedores` | ✅ Total | ✅ Limitado | ❌ 403 |
| `GET /admin/dashboard/export` | ✅ Total | ✅ Limitado | ❌ 403 |

### Comportamiento por Rol

#### ADMIN
**Acceso:** Total sin restricciones

**Filtros:**
- Puede especificar `ventanaId` para filtrar por ventana específica
- Puede omitir `ventanaId` para ver todas las ventanas
- Todos los demás filtros funcionan normalmente

**Ejemplo:**
```bash
# Ver todas las ventanas
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  "http://localhost:4000/api/v1/admin/dashboard?date=today"

# Ver ventana específica
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  "http://localhost:4000/api/v1/admin/dashboard?date=today&ventanaId=550e8400-e29b-41d4-a716-446655440000"
```

---

#### VENTANA
**Acceso:** Limitado a sus propios datos

**Filtros:**
- `ventanaId` es **ignorado** si lo envía
- `ventanaId` se **fija automáticamente** desde `req.user.ventanaId`
- Todos los demás filtros funcionan normalmente

**Ejemplo:**
```bash
# Token de VENTANA (ventanaId=550e8400-e29b-41d4-a716-446655440000)
curl -H "Authorization: Bearer $VENTANA_TOKEN" \
  "http://localhost:4000/api/v1/admin/dashboard?date=today"

# Aunque intente especificar otra ventana, será ignorado
curl -H "Authorization: Bearer $VENTANA_TOKEN" \
  "http://localhost:4000/api/v1/admin/dashboard?date=today&ventanaId=999999"
# → Respuesta incluirá solo datos de ventanaId=550e8400-e29b-41d4-a716-446655440000
```

**Código Backend:**
```typescript
if (req.user.role === Role.VENTANA) {
  ventanaId = req.user.ventanaId!; // Forzar filtro
}
```

---

#### VENDEDOR
**Acceso:** Bloqueado (403 Forbidden)

**Respuesta:**
```json
{
  "success": false,
  "message": "No autorizado para ver dashboard",
  "code": "FORBIDDEN"
}
```

**Código Backend:**
```typescript
if (req.user.role === Role.VENDEDOR) {
  throw new AppError("No autorizado para ver dashboard", 403);
}
```

---

## Caché y Performance

### Redis Cache

**Configuración:**
- TTL: 300 segundos (5 minutos) - configurable
- Cache key: `dashboard:${hash(filters)}`
- Invalidación: Automática por TTL

**Cálculo de Cache Key:**
```typescript
const cacheKey = `dashboard:${crypto
  .createHash('md5')
  .update(JSON.stringify({
    endpoint,
    date,
    fromDate,
    toDate,
    ventanaId,
    loteriaId,
    betType,
    dimension,
    top,
    orderBy,
    order,
    interval,
  }))
  .digest('hex')}`;
```

**Ejemplo:**
```
dashboard:a3f5c8e2b1d4a7f9c0e3b2d1a4f7c9e0
```

---

### ETag y Validación de Caché

**Header ETag:** Identificador único del recurso basado en hash del contenido

**Request con validación:**
```http
GET /api/v1/admin/dashboard?date=today
If-None-Match: "33a64df551425fcc55e4d42a148795d9f25f89d4"
```

**Response 304 Not Modified (si ETag coincide):**
```http
HTTP/1.1 304 Not Modified
ETag: "33a64df551425fcc55e4d42a148795d9f25f89d4"
Cache-Control: max-age=300
```

**Response 200 OK (si ETag cambió):**
```http
HTTP/1.1 200 OK
ETag: "6f4a8c9e2b1d3f7a5c0e8b2d9a4f1c7e"
Cache-Control: max-age=300
Content-Type: application/json

{
  "success": true,
  "data": { ... }
}
```

---

### Service Level Objectives (SLO)

| Endpoint | p95 Caliente | p95 Frío | Notas |
|----------|--------------|----------|-------|
| `/admin/dashboard` | ≤ 800ms | ≤ 1500ms | Dashboard completo (8 queries) |
| `/admin/dashboard/ganancia` | ≤ 400ms | ≤ 800ms | 2-3 queries según dimensión |
| `/admin/dashboard/cxc` | ≤ 300ms | ≤ 600ms | 1-2 queries |
| `/admin/dashboard/cxp` | ≤ 300ms | ≤ 600ms | 1 query |
| `/admin/dashboard/timeseries` | ≤ 500ms | ≤ 1000ms | 1 query con GROUP BY temporal |
| `/admin/dashboard/exposure` | ≤ 600ms | ≤ 1000ms | 3 queries (numbers, heatmap, loteria) |
| `/admin/dashboard/vendedores` | ≤ 500ms | ≤ 900ms | 2 queries con paginación |

**Definiciones:**
- **Caliente:** Cache hit, datos en Redis
- **Frío:** Cache miss, queries a PostgreSQL

---

### Métricas de Performance en Respuesta

**Incluidas en `meta`:**
```json
{
  "meta": {
    "queryExecutionTime": 245,  // Tiempo total de queries (ms)
    "totalQueries": 8            // Cantidad de queries ejecutadas
  }
}
```

**Uso:**
- Monitoreo de performance en frontend
- Identificación de endpoints lentos
- Optimización de queries

---

## Sistema de Alertas

### Tipos de Alertas

| Tipo | Descripción | Severidad | Threshold |
|------|-------------|-----------|-----------|
| `HIGH_CXC` | CxC excede umbral | `warn` / `critical` | Configurable por banca |
| `LOW_SALES` | Ventas bajo mínimo esperado | `warn` | Configurable por banca |
| `HIGH_EXPOSURE` | Concentración de ventas en número/lotería | `warn` / `critical` | % de exposición |
| `OVERPAYMENT` | Ventana pagó más de lo ganado | `info` / `warn` | Automático (CxP > 0) |

### Umbrales Configurables

**Configuración por banca (env o database):**
```env
CXC_THRESHOLD_WARN=50000      # ₡50,000
CXC_THRESHOLD_CRITICAL=100000 # ₡100,000
LOW_SALES_THRESHOLD=10000     # ₡10,000 por día
EXPOSURE_THRESHOLD_WARN=60    # 60% de concentración
EXPOSURE_THRESHOLD_CRITICAL=80 # 80% de concentración
```

### Estructura de Alerta

```json
{
  "id": "alert-001",
  "type": "HIGH_CXC",
  "severity": "warn",
  "message": "CxC de Ventana Central excede umbral",
  "threshold": 50000.00,
  "ventanaId": "550e8400-e29b-41d4-a716-446655440000",
  "ventanaName": "Ventana Central",
  "suggestedAction": "Solicitar pago o ajustar crédito"
}
```

### Cálculo de Alertas

**Código Backend (dashboard.service.ts):**
```typescript
const alerts: Alert[] = [];

// HIGH_CXC
cxc.byVentana.forEach(ventana => {
  if (ventana.amount > CXC_THRESHOLD_CRITICAL) {
    alerts.push({
      id: `cxc-${ventana.ventanaId}`,
      type: 'HIGH_CXC',
      severity: 'critical',
      message: `CxC de ${ventana.ventanaName} excede umbral crítico`,
      threshold: CXC_THRESHOLD_CRITICAL,
      ventanaId: ventana.ventanaId,
      ventanaName: ventana.ventanaName,
      suggestedAction: 'Suspender crédito y solicitar pago inmediato',
    });
  } else if (ventana.amount > CXC_THRESHOLD_WARN) {
    alerts.push({
      id: `cxc-${ventana.ventanaId}`,
      type: 'HIGH_CXC',
      severity: 'warn',
      message: `CxC de ${ventana.ventanaName} excede umbral`,
      threshold: CXC_THRESHOLD_WARN,
      ventanaId: ventana.ventanaId,
      ventanaName: ventana.ventanaName,
      suggestedAction: 'Solicitar pago o ajustar crédito',
    });
  }
});

// HIGH_EXPOSURE
exposure.topNumbers.forEach(num => {
  const exposurePercent = (num.sales / summary.totalSales) * 100;
  if (exposurePercent > EXPOSURE_THRESHOLD_CRITICAL) {
    alerts.push({
      id: `exp-${num.number}`,
      type: 'HIGH_EXPOSURE',
      severity: 'critical',
      message: `Número ${num.number} tiene ${exposurePercent.toFixed(1)}% de las ventas`,
      threshold: EXPOSURE_THRESHOLD_CRITICAL,
      suggestedAction: 'Aplicar restricción de venta para este número',
    });
  }
});

return alerts;
```

### Webhook de Alertas (Opcional)

**Endpoint:** `POST /webhooks/dashboard-alerts`

**Payload:**
```json
{
  "timestamp": "2025-10-29T15:30:00.000-06:00",
  "alert": {
    "id": "alert-001",
    "type": "HIGH_CXC",
    "severity": "warn",
    "message": "CxC de Ventana Central excede umbral",
    "threshold": 50000.00,
    "ventanaId": "550e8400-e29b-41d4-a716-446655440000",
    "ventanaName": "Ventana Central",
    "suggestedAction": "Solicitar pago o ajustar crédito"
  }
}
```

**Uso:** Integración con Slack, email, SMS, etc.

---

## Ejemplos curl

### 1. Dashboard Completo - Hoy (ADMIN)

```bash
curl -X GET "http://localhost:4000/api/v1/admin/dashboard?date=today" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
```

**Response:**
```json
{
  "success": true,
  "data": {
    "summary": {
      "totalSales": 150000.00,
      "totalTickets": 1250,
      "totalWinners": 85,
      "totalCommissions": 7500.00,
      "winRate": 6.80
    },
    "ganancia": { ... },
    "cxc": { ... },
    "cxp": { ... },
    "timeSeries": [ ... ],
    "exposure": { ... },
    "previousPeriod": { ... },
    "alerts": [ ... ],
    "meta": {
      "range": {
        "fromAt": "2025-10-29T00:00:00.000-06:00",
        "toAt": "2025-10-29T23:59:59.999-06:00"
      },
      "generatedAt": "2025-10-29T15:30:00.000-06:00",
      "scope": "all",
      "queryExecutionTime": 245,
      "totalQueries": 8
    }
  }
}
```

---

### 2. Dashboard Completo - Mes de Octubre con Filtros (ADMIN)

```bash
curl -X GET "http://localhost:4000/api/v1/admin/dashboard?date=range&fromDate=2025-10-01&toDate=2025-10-31&ventanaId=550e8400-e29b-41d4-a716-446655440000&loteriaId=660e8400-e29b-41d4-a716-446655440000&betType=NUMERO" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

---

### 3. Dashboard Completo - Con Validación de Caché

```bash
curl -X GET "http://localhost:4000/api/v1/admin/dashboard?date=today" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "If-None-Match: \"33a64df551425fcc55e4d42a148795d9f25f89d4\"" \
  -i
```

**Response 304 (si no cambió):**
```http
HTTP/1.1 304 Not Modified
ETag: "33a64df551425fcc55e4d42a148795d9f25f89d4"
Cache-Control: max-age=300
```

---

### 4. Ganancia - Top 5 Vendedores del Mes (ADMIN)

```bash
curl -X GET "http://localhost:4000/api/v1/admin/dashboard/ganancia?date=month&dimension=vendedor&top=5&orderBy=commissions&order=desc" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

**Response:**
```json
{
  "success": true,
  "data": {
    "totalAmount": 225000.00,
    "totalSales": 4500000.00,
    "margin": 5.00,
    "byVendedor": [
      {
        "vendedorId": "770e8400-e29b-41d4-a716-446655440000",
        "vendedorName": "Juan Pérez",
        "amount": 60000.00,
        "sales": 1200000.00,
        "margin": 5.00,
        "tickets": 10000
      },
      {
        "vendedorId": "770e8400-e29b-41d4-a716-446655440001",
        "vendedorName": "María González",
        "amount": 52500.00,
        "sales": 1050000.00,
        "margin": 5.00,
        "tickets": 8750
      }
    ],
    "pagination": {
      "page": 1,
      "pageSize": 5,
      "total": 25
    },
    "meta": { ... }
  }
}
```

---

### 5. CxC - Con Aging (ADMIN)

```bash
curl -X GET "http://localhost:4000/api/v1/admin/dashboard/cxc?date=month&aging=true" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

**Response:**
```json
{
  "success": true,
  "data": {
    "totalAmount": 1950000.00,
    "byVentana": [ ... ],
    "aging": [
      {
        "bucket": "0-7",
        "amount": 500000.00,
        "ventanas": [
          {
            "ventanaId": "550e8400-e29b-41d4-a716-446655440000",
            "ventanaName": "Ventana Central",
            "amount": 500000.00
          }
        ]
      },
      {
        "bucket": "8-14",
        "amount": 650000.00,
        "ventanas": [ ... ]
      },
      {
        "bucket": "15-30",
        "amount": 600000.00,
        "ventanas": [ ... ]
      },
      {
        "bucket": "31+",
        "amount": 200000.00,
        "ventanas": [ ... ]
      }
    ],
    "meta": { ... }
  }
}
```

---

### 6. Serie Temporal - Última Semana por Día (ADMIN)

```bash
curl -X GET "http://localhost:4000/api/v1/admin/dashboard/timeseries?date=week&interval=day" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

**Response:**
```json
{
  "success": true,
  "data": {
    "timeSeries": [
      {
        "date": "2025-10-23",
        "sales": 148000.00,
        "commissions": 7400.00,
        "tickets": 1233
      },
      {
        "date": "2025-10-24",
        "sales": 152000.00,
        "commissions": 7600.00,
        "tickets": 1267
      },
      // ... más días
    ],
    "meta": { ... }
  }
}
```

---

### 7. Serie Temporal - Hoy por Hora (ADMIN)

```bash
curl -X GET "http://localhost:4000/api/v1/admin/dashboard/timeseries?date=today&interval=hour" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

**Response:**
```json
{
  "success": true,
  "data": {
    "timeSeries": [
      {
        "date": "2025-10-29T06:00:00.000-06:00",
        "sales": 5000.00,
        "commissions": 250.00,
        "tickets": 42
      },
      {
        "date": "2025-10-29T07:00:00.000-06:00",
        "sales": 8000.00,
        "commissions": 400.00,
        "tickets": 67
      },
      // ... más horas
    ],
    "meta": { ... }
  }
}
```

---

### 8. Exposición - Top 10 Números de Hoy (ADMIN)

```bash
curl -X GET "http://localhost:4000/api/v1/admin/dashboard/exposure?date=today&top=10" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

**Response:**
```json
{
  "success": true,
  "data": {
    "topNumbers": [
      {
        "number": "00",
        "betType": "NUMERO",
        "sales": 15000.00,
        "potentialPayout": 1050000.00,
        "ratio": 70.00
      },
      {
        "number": "13",
        "betType": "NUMERO",
        "sales": 12000.00,
        "potentialPayout": 840000.00,
        "ratio": 70.00
      }
      // ... más números
    ],
    "heatmap": [ ... ],
    "byLoteria": [ ... ],
    "meta": { ... }
  }
}
```

---

### 9. Ranking de Vendedores - Top 10 del Mes (ADMIN)

```bash
curl -X GET "http://localhost:4000/api/v1/admin/dashboard/vendedores?date=month&top=10&orderBy=sales&order=desc" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

**Response:**
```json
{
  "success": true,
  "data": {
    "byVendedor": [
      {
        "vendedorId": "770e8400-e29b-41d4-a716-446655440000",
        "vendedorName": "Juan Pérez",
        "sales": 1200000.00,
        "commissions": 60000.00,
        "tickets": 10000,
        "winners": 680,
        "avgTicket": 120.00
      },
      {
        "vendedorId": "770e8400-e29b-41d4-a716-446655440001",
        "vendedorName": "María González",
        "sales": 1050000.00,
        "commissions": 52500.00,
        "tickets": 8750,
        "winners": 595,
        "avgTicket": 120.00
      }
      // ... más vendedores
    ],
    "pagination": {
      "page": 1,
      "pageSize": 10,
      "total": 45
    },
    "meta": { ... }
  }
}
```

---

### 10. Exportación - Excel del Mes (ADMIN)

```bash
curl -X GET "http://localhost:4000/api/v1/admin/dashboard/export?date=month&format=xlsx" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -o dashboard-2025-10.xlsx
```

**Response:**
```
Archivo descargado: dashboard-2025-10.xlsx
```

---

### 11. Dashboard - Vista de VENTANA

```bash
# Token de VENTANA (ventanaId en JWT)
curl -X GET "http://localhost:4000/api/v1/admin/dashboard?date=today" \
  -H "Authorization: Bearer $VENTANA_TOKEN"
```

**Response:** Solo incluye datos de la ventana del token, `meta.scope` será `"byVentana"`

---

### 12. Dashboard - Intento de VENDEDOR (Bloqueado)

```bash
curl -X GET "http://localhost:4000/api/v1/admin/dashboard?date=today" \
  -H "Authorization: Bearer $VENDEDOR_TOKEN"
```

**Response 403:**
```json
{
  "success": false,
  "message": "No autorizado para ver dashboard",
  "code": "FORBIDDEN"
}
```

---

## Compatibilidad y Versionado

### Política de Compatibilidad v1

**Sin breaking changes permitidos:**
- ❌ No eliminar propiedades existentes
- ❌ No cambiar tipos, enums ni nombres actuales
- ❌ No convertir campos opcionales en obligatorios
- ❌ No alterar semántica de campos ya documentados

**Cambios aditivos permitidos en v1:**
- ✅ Agregar nuevos endpoints
- ✅ Agregar nuevos campos opcionales en respuestas
- ✅ Agregar nuevos filtros opcionales (default no altera comportamiento)
- ✅ Agregar nuevos valores a enums (si no rompe lógica)

### Endpoints Existentes (Compatibilidad)

Los siguientes endpoints **YA EXISTEN** y NO deben cambiar incompatiblemente:

#### ✅ GET /api/v1/admin/dashboard
**Contrato actual:**
- Response: `{ success, data: { summary, ganancia, cxc, cxp, meta } }`

**Cambios aditivos v1:**
- ✅ Agregar: `data.timeSeries` (nuevo campo opcional)
- ✅ Agregar: `data.exposure` (nuevo campo opcional)
- ✅ Agregar: `data.previousPeriod` (nuevo campo opcional)
- ✅ Agregar: `data.alerts` (nuevo campo opcional)
- ✅ Agregar: `meta.queryExecutionTime` (nuevo campo opcional)
- ✅ Agregar: `meta.totalQueries` (nuevo campo opcional)
- ✅ Agregar: `summary.winRate` (nuevo campo opcional)
- ✅ Agregar: `ganancia.margin` (nuevo campo opcional)
- ✅ Agregar: `ganancia.totalSales` (nuevo campo opcional)

**QA requerido:**
```bash
# Llamada sin nuevos filtros debe retornar EXACTAMENTE lo mismo
# (excepto nuevos campos opcionales)
curl -X GET "http://localhost:4000/api/v1/admin/dashboard?date=today" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  | jq '{
      success: .success,
      summary: .data.summary | del(.winRate),
      ganancia: .data.ganancia | del(.margin, .totalSales),
      cxc: .data.cxc,
      cxp: .data.cxp,
      meta: .data.meta | del(.queryExecutionTime, .totalQueries)
    }'
# → Debe ser idéntico a respuesta anterior (sin nuevos campos)
```

---

#### ✅ GET /api/v1/admin/dashboard/ganancia
**Contrato actual:**
- Response: `{ success, data: { totalAmount, byVentana, byLoteria, meta } }`

**Cambios aditivos v1:**
- ✅ Agregar: `data.totalSales` (nuevo campo opcional)
- ✅ Agregar: `data.margin` (nuevo campo opcional)
- ✅ Agregar: `data.byVendedor` (cuando dimension=vendedor)
- ✅ Agregar: `data.pagination` (cuando aplica)
- ✅ Agregar: `byVentana[].sales` y `.margin` (campos opcionales)

---

#### ✅ GET /api/v1/admin/dashboard/cxc
**Contrato actual:**
- Response: `{ success, data: { totalAmount, byVentana, meta } }`

**Cambios aditivos v1:**
- ✅ Agregar: `data.aging` (cuando aging=true)
- ✅ Agregar: `data.pagination` (cuando aplica)

---

#### ✅ GET /api/v1/admin/dashboard/cxp
**Contrato actual:**
- Response: `{ success, data: { totalAmount, byVentana, meta } }`

**Cambios aditivos v1:**
- ✅ Agregar: `data.pagination` (cuando aplica)

---

### Nuevos Endpoints v1 (No existían antes)

Los siguientes endpoints son **NUEVOS** en v1:

- ✅ `GET /api/v1/admin/dashboard/timeseries` (nuevo)
- ✅ `GET /api/v1/admin/dashboard/exposure` (nuevo)
- ✅ `GET /api/v1/admin/dashboard/vendedores` (nuevo)
- ✅ `GET /api/v1/admin/dashboard/export` (nuevo)

Estos endpoints NO tienen restricciones de compatibilidad porque son completamente nuevos.

---

### Plan de Deprecación (si se requiere v2)

**Si algún cambio requiere breaking change:**

1. **Publicar v2** del endpoint afectado
   - Ruta: `/api/v2/admin/dashboard/...`
   - OpenAPI: `openapi-dashboard-v2.yaml`

2. **Mantener v1 en paralelo** por ≥90 días
   - v1 continúa funcionando sin cambios
   - v1 se marca como `deprecated: true` en OpenAPI

3. **Comunicar migración**
   - Changelog con fecha de deprecación
   - README con guía de migración
   - Ejemplo de migración v1 → v2

4. **Eliminar v1** después de período de gracia
   - Fecha anunciada con ≥90 días de anticipación
   - Devolver 410 Gone en v1 después de eliminación

**Ejemplo de deprecación en OpenAPI:**
```yaml
paths:
  /api/v1/admin/dashboard:
    get:
      deprecated: true
      description: |
        ⚠️ **DEPRECATED**: Este endpoint será removido el 2026-02-01.
        Migrar a `/api/v2/admin/dashboard` antes de esa fecha.

        **Cambios en v2:**
        - Campo `summary.winRate` ahora es obligatorio
        - Campo `meta` tiene nueva estructura

        **Guía de migración:** docs/MIGRATION_V1_TO_V2.md
```

---

### Negociación de Versión

**Método elegido:** Path-based versioning (`/v1/`, `/v2/`)

**No usamos:**
- ❌ Header-based (`X-API-Version: 1`)
- ❌ Query-based (`?version=1`)

**Razones:**
- ✅ Más explícito y claro
- ✅ Compatible con cache y proxies
- ✅ Fácil de documentar en OpenAPI

---

### Checklist de Compatibilidad

**Antes de merge a master:**

- [ ] Todas las rutas v1 existentes responden igual cuando no se envían nuevos filtros
- [ ] Campos nuevos en v1 son opcionales y no afectan parsing actual
- [ ] Tests de contrato pasan para v1 sin nuevos filtros
- [ ] Tests con caché (ETag 304) funcionan correctamente
- [ ] Matriz RBAC (ADMIN/VENTANA/VENDEDOR) confirmada
- [ ] Nuevas rutas entregan contratos completos con ejemplos
- [ ] OpenAPI compila sin errores (`swagger-ui` o `prism`)
- [ ] Documentación actualizada (CHANGELOG, README)

---

## Códigos de Error

### Errores de Autenticación

#### 401 Unauthorized
**Causa:** Token JWT ausente o inválido

**Response:**
```json
{
  "success": false,
  "message": "Unauthorized"
}
```

**Solución:**
- Verificar que el header `Authorization: Bearer <token>` esté presente
- Verificar que el token no haya expirado
- Obtener nuevo token del endpoint de autenticación

---

### Errores de Autorización

#### 403 Forbidden (VENDEDOR)
**Causa:** Usuario con rol VENDEDOR intenta acceder al dashboard

**Response:**
```json
{
  "success": false,
  "message": "No autorizado para ver dashboard",
  "code": "FORBIDDEN"
}
```

**Solución:**
- Verificar que el usuario tenga rol ADMIN o VENTANA
- Contactar administrador para cambio de rol

---

#### 403 Forbidden (VENTANA acceso denegado)
**Causa:** VENTANA intenta acceder a datos de otra ventana (caso raro)

**Response:**
```json
{
  "success": false,
  "message": "No autorizado",
  "code": "FORBIDDEN"
}
```

**Solución:**
- VENTANA solo puede ver sus propios datos
- ADMIN puede ver cualquier ventana

---

### Errores de Validación

#### 422 Validation Error - Rango de fechas inválido

**Causa:** `fromDate > toDate`

**Response:**
```json
{
  "success": false,
  "message": "ValidationError",
  "errors": [
    {
      "path": "fromDate",
      "message": "fromDate must be before or equal to toDate"
    }
  ]
}
```

**Solución:**
```bash
# ❌ Incorrecto
?date=range&fromDate=2025-10-31&toDate=2025-10-01

# ✅ Correcto
?date=range&fromDate=2025-10-01&toDate=2025-10-31
```

---

#### 422 Validation Error - Rango sin fechas

**Causa:** `date=range` pero falta `fromDate` o `toDate`

**Response:**
```json
{
  "success": false,
  "message": "ValidationError",
  "errors": [
    {
      "path": "fromDate",
      "message": "fromDate is required when date=range"
    },
    {
      "path": "toDate",
      "message": "toDate is required when date=range"
    }
  ]
}
```

**Solución:**
```bash
# ❌ Incorrecto
?date=range

# ✅ Correcto
?date=range&fromDate=2025-10-01&toDate=2025-10-31
```

---

#### 422 Validation Error - interval=hour con rango largo

**Causa:** `interval=hour` pero rango > 7 días

**Response:**
```json
{
  "success": false,
  "message": "ValidationError",
  "errors": [
    {
      "path": "interval",
      "message": "interval=hour is only allowed for ranges <= 7 days"
    }
  ]
}
```

**Solución:**
```bash
# ❌ Incorrecto
?date=month&interval=hour  # month = 30 días

# ✅ Correcto
?date=today&interval=hour  # today = 1 día
?date=week&interval=hour   # week = 7 días
?date=month&interval=day   # month con interval=day OK
```

---

#### 422 Validation Error - Enum inválido

**Causa:** Valor no reconocido en enum

**Response:**
```json
{
  "success": false,
  "message": "ValidationError",
  "errors": [
    {
      "path": "betType",
      "message": "betType must be NUMERO or REVENTADO"
    }
  ]
}
```

**Solución:**
```bash
# ❌ Incorrecto
?betType=INVALIDO

# ✅ Correcto
?betType=NUMERO
?betType=REVENTADO
```

---

### Errores del Servidor

#### 500 Internal Server Error
**Causa:** Error no controlado en el servidor

**Response:**
```json
{
  "success": false,
  "message": "Internal Server Error"
}
```

**Solución:**
- Reportar a equipo de backend con detalles de request
- Incluir timestamp, endpoint y parámetros
- Revisar logs del servidor

---

## Documentación Relacionada

- [OpenAPI Specification](openapi-dashboard-v1.yaml) - Contratos completos con ejemplos
- [CHANGELOG](CHANGELOG.md) - Historial de cambios del módulo
- [Dashboard Module (Integración)](docs/Pendientes%20integración/DASHBOARD_MODULE.md) - Documentación detallada para integración
- [Date Parameters Standard](docs/UNIVERSAL_DATE_PARAMETER_STANDARD.md) - Estándar de parámetros de fecha
- [RBAC Model](docs/BACKEND_AUTHORITY_MODEL_SUMMARY.md) - Modelo de autorización

---

## Soporte y Contacto

**Equipo Backend:**
- Email: backend@banca.com
- Issues: https://github.com/bancas/backend/issues

**Changelog:** Ver [CHANGELOG.md](CHANGELOG.md) para cambios y versiones

**Última actualización:** 2025-10-29
**Versión:** 1.0.0
