# Módulo Dashboard - Documentación Completa

## 📋 Índice

1. [Descripción General](#descripción-general)
2. [Funcionalidades](#funcionalidades)
3. [Endpoints y Especificaciones](#endpoints-y-especificaciones)
4. [Información Esperada desde Frontend](#información-esperada-desde-frontend)
5. [Cómo Trabaja Internamente](#cómo-trabaja-internamente)
6. [Casos de Uso](#casos-de-uso)
7. [Posibles Mejoras](#posibles-mejoras)
8. [Dependencias y Relaciones](#dependencias-y-relaciones)

---

## Descripción General

El módulo Dashboard proporciona **métricas financieras y analíticas** en tiempo real para administradores y ventanas del sistema de bancas. Incluye cálculos de:

- **Ventas totales** y cantidad de tickets
- **Ganancia** (comisiones acumuladas)
- **CxC** (Cuentas por Cobrar - dinero que ventanas deben al banco)
- **CxP** (Cuentas por Pagar - dinero que el banco debe a ventanas)
- **Resumen de pagos** y tickets ganadores

### Características Principales

✅ **Control de acceso jerárquico (RBAC)**

- ADMIN: Ve todas las ventanas, puede filtrar
- VENTANA: Solo ve sus propios datos
- VENDEDOR: Bloqueado

✅ **Filtros de fecha flexibles**

- Presets: `today`, `yesterday`, `week`, `month`, `year`
- Rangos personalizados: `range` con `fromDate` y `toDate`

✅ **Agregaciones complejas**

- Por ventana
- Por lotería
- Totales consolidados

✅ **Zona horaria Costa Rica (GMT-6)**

- Todas las fechas se manejan en hora local
- Conversión automática en queries

---

## Funcionalidades

### 1. Dashboard Principal (`getMainDashboard`)

Retorna un objeto completo con todas las métricas financieras:

```json
{
  "summary": { /* Totales generales */ },
  "ganancia": { /* Comisiones */ },
  "cxc": { /* Cuentas por Cobrar */ },
  "cxp": { /* Cuentas por Pagar */ },
  "meta": { /* Metadata de la consulta */ }
}
```

**Acceso:** ADMIN y VENTANA

### 2. Ganancia Detallada (`getGanancia`)

Desglose de comisiones por ventana y lotería.

**Cálculo:**

```
Ganancia = SUM(commissionAmount)
WHERE isWinner = true
AND sorteo.status = 'EVALUATED'
```

**Acceso:** ADMIN y VENTANA

### 3. Cuentas por Cobrar (`getCxC`)

Dinero pendiente que ventanas deben al banco.

**Cálculo:**

```
CxC = Total Ventas - Total Pagado
Solo valores positivos (debe > 0)
```

**Acceso:** ADMIN y VENTANA

### 4. Cuentas por Pagar (`getCxP`)

Dinero que el banco debe a ventanas (overpayment).

**Cálculo:**

```
CxP = Total Pagado - Total Premios
Solo valores positivos (debe > 0)
```

**Acceso:** ADMIN y VENTANA

---

## Endpoints y Especificaciones

### Base URL

```
/api/v1/admin/dashboard
```

### 1. GET `/api/v1/admin/dashboard`

**Dashboard completo con todas las métricas**

#### Headers

```http
Authorization: Bearer <token>
```

#### Query Parameters

| Parámetro | Tipo | Requerido | Default | Descripción |
|-----------|------|-----------|---------|-------------|
| `date` | enum | No | `"today"` | Preset de fecha: `"today"`, `"yesterday"`, `"week"`, `"month"`, `"year"`, `"range"` |
| `fromDate` | string | Condicional* | - | Fecha inicio (YYYY-MM-DD). *Requerido si `date="range"` |
| `toDate` | string | Condicional* | - | Fecha fin (YYYY-MM-DD). *Requerido si `date="range"` |
| `ventanaId` | uuid | No | - | Filtrar por ventana específica (solo ADMIN) |
| `scope` | enum | No | `"all"` | `"mine"` o `"all"` |

#### Ejemplo de Request (ADMIN - Hoy)

```http
GET /api/v1/admin/dashboard?date=today
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

#### Ejemplo de Request (ADMIN - Rango personalizado)

```http
GET /api/v1/admin/dashboard?date=range&fromDate=2025-10-01&toDate=2025-10-31
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

#### Ejemplo de Request (ADMIN - Filtrar ventana)

```http
GET /api/v1/admin/dashboard?date=week&ventanaId=550e8400-e29b-41d4-a716-446655440000
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

#### Ejemplo de Request (VENTANA - Solo ve sus datos)

```http
GET /api/v1/admin/dashboard?date=today
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
# El sistema automáticamente filtra por req.user.ventanaId
```

#### Response 200 OK

```json
{
  "success": true,
  "data": {
    "ganancia": {
      "totalAmount": 7500.00,
      "byVentana": [
        {
          "ventanaId": "550e8400-e29b-41d4-a716-446655440000",
          "ventanaName": "Ventana Central",
          "amount": 4500.00
        },
        {
          "ventanaId": "550e8400-e29b-41d4-a716-446655440001",
          "ventanaName": "Ventana Norte",
          "amount": 3000.00
        }
      ],
      "byLoteria": [
        {
          "loteriaId": "660e8400-e29b-41d4-a716-446655440000",
          "loteriaName": "Tiempos Tica",
          "amount": 5000.00
        },
        {
          "loteriaId": "660e8400-e29b-41d4-a716-446655440001",
          "loteriaName": "Lotto",
          "amount": 2500.00
        }
      ]
    },
    "cxc": {
      "totalAmount": 65000.00,
      "byVentana": [
        {
          "ventanaId": "550e8400-e29b-41d4-a716-446655440000",
          "ventanaName": "Ventana Central",
          "totalSales": 120000.00,
          "totalPaidOut": 55000.00,
          "amount": 65000.00
        }
      ]
    },
    "cxp": {
      "totalAmount": 0,
      "byVentana": []
    },
    "summary": {
      "totalSales": 150000.00,
      "totalPayouts": 85000.00,
      "totalCommissions": 7500.00,
      "totalTickets": 1250,
      "winningTickets": 85
    },
    "meta": {
      "range": {
        "fromAt": "2025-10-29T00:00:00.000Z",
        "toAt": "2025-10-29T23:59:59.999Z",
        "tz": "America/Costa_Rica"
      },
      "scope": "all",
      "generatedAt": "2025-10-29T15:30:00.000Z"
    }
  }
}
```

#### Response 401 Unauthorized

```json
{
  "success": false,
  "message": "Unauthorized"
}
```

#### Response 403 Forbidden (VENDEDOR)

```json
{
  "success": false,
  "message": "No autorizado para ver dashboard"
}
```

---

### 2. GET `/api/v1/admin/dashboard/ganancia`

**Desglose detallado de ganancia (comisiones)**

#### Query Parameters

Mismos que el dashboard principal.

#### Response 200 OK

```json
{
  "success": true,
  "data": {
    "totalAmount": 7500.00,
    "byVentana": [
      {
        "ventanaId": "550e8400-e29b-41d4-a716-446655440000",
        "ventanaName": "Ventana Central",
        "amount": 4500.00
      }
    ],
    "byLoteria": [
      {
        "loteriaId": "660e8400-e29b-41d4-a716-446655440000",
        "loteriaName": "Tiempos Tica",
        "amount": 5000.00
      }
    ]
  },
  "meta": {
    "range": {
      "fromAt": "2025-10-29T00:00:00.000Z",
      "toAt": "2025-10-29T23:59:59.999Z"
    },
    "generatedAt": "2025-10-29T15:30:00.000Z"
  }
}
```

---

### 3. GET `/api/v1/admin/dashboard/cxc`

**Desglose de Cuentas por Cobrar**

#### Query Parameters

Mismos que el dashboard principal.

#### Response 200 OK

```json
{
  "success": true,
  "data": {
    "totalAmount": 65000.00,
    "byVentana": [
      {
        "ventanaId": "550e8400-e29b-41d4-a716-446655440000",
        "ventanaName": "Ventana Central",
        "totalSales": 120000.00,
        "totalPaidOut": 55000.00,
        "amount": 65000.00
      }
    ]
  },
  "meta": {
    "range": {
      "fromAt": "2025-10-29T00:00:00.000Z",
      "toAt": "2025-10-29T23:59:59.999Z"
    },
    "generatedAt": "2025-10-29T15:30:00.000Z"
  }
}
```

**Interpretación:**

- `totalSales`: Total de ventas realizadas por la ventana
- `totalPaidOut`: Total de premios ya pagados a ganadores
- `amount`: Diferencia (ventas - pagos) = dinero que ventana debe al banco

---

### 4. GET `/api/v1/admin/dashboard/cxp`

**Desglose de Cuentas por Pagar**

#### Query Parameters

Mismos que el dashboard principal.

#### Response 200 OK

```json
{
  "success": true,
  "data": {
    "totalAmount": 0,
    "byVentana": []
  },
  "meta": {
    "range": {
      "fromAt": "2025-10-29T00:00:00.000Z",
      "toAt": "2025-10-29T23:59:59.999Z"
    },
    "generatedAt": "2025-10-29T15:30:00.000Z"
  }
}
```

**Interpretación:**

- `totalWinners`: Total de premios ganados
- `totalPaidOut`: Total de dinero pagado por la ventana
- `amount`: Diferencia (pagos - premios) = dinero que banco debe a ventana (overpayment)

**Nota:** CxP solo aparece cuando una ventana paga más de lo que los clientes ganaron (caso raro, posible error o adelanto).

---

## Información Esperada desde Frontend

### Escenarios de Uso por Rol

#### ADMIN - Dashboard General

```typescript
// Frontend code example
async function fetchAdminDashboard(datePreset: string) {
  const response = await fetch(
    `/api/v1/admin/dashboard?date=${datePreset}`,
    {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    }
  );
  return response.json();
}

// Uso:
const todayData = await fetchAdminDashboard('today');
const weekData = await fetchAdminDashboard('week');
```

#### ADMIN - Dashboard de Ventana Específica

```typescript
async function fetchVentanaDashboard(ventanaId: string, date: string) {
  const response = await fetch(
    `/api/v1/admin/dashboard?date=${date}&ventanaId=${ventanaId}`,
    {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    }
  );
  return response.json();
}
```

#### ADMIN - Rango Personalizado

```typescript
async function fetchCustomRangeDashboard(fromDate: string, toDate: string) {
  const response = await fetch(
    `/api/v1/admin/dashboard?date=range&fromDate=${fromDate}&toDate=${toDate}`,
    {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    }
  );
  return response.json();
}

// Uso:
const octoberData = await fetchCustomRangeDashboard('2025-10-01', '2025-10-31');
```

#### VENTANA - Dashboard Propio

```typescript
async function fetchMyDashboard(date: string) {
  // No se envía ventanaId - el backend automáticamente filtra por req.user.ventanaId
  const response = await fetch(
    `/api/v1/admin/dashboard?date=${date}`,
    {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    }
  );
  return response.json();
}
```

### Componentes Frontend Sugeridos

#### 1. Selector de Rango de Fechas

```typescript
interface DateRangeSelector {
  preset: 'today' | 'yesterday' | 'week' | 'month' | 'year' | 'range';
  fromDate?: string; // YYYY-MM-DD
  toDate?: string;   // YYYY-MM-DD
}

// Cuando preset !== 'range', fromDate y toDate se ignoran
```

#### 2. Filtro de Ventana (solo ADMIN)

```typescript
interface VentanaFilter {
  ventanaId?: string; // UUID o undefined (todas)
}
```

#### 3. Visualización de Datos

```typescript
interface DashboardData {
  summary: {
    totalSales: number;
    totalPayouts: number;
    totalCommissions: number;
    totalTickets: number;
    winningTickets: number;
  };
  ganancia: {
    totalAmount: number;
    byVentana: VentanaAmount[];
    byLoteria: LoteriaAmount[];
  };
  cxc: {
    totalAmount: number;
    byVentana: VentanaCxC[];
  };
  cxp: {
    totalAmount: number;
    byVentana: VentanaCxP[];
  };
  meta: {
    range: {
      fromAt: string;
      toAt: string;
      tz: string;
    };
    scope: string;
    generatedAt: string;
  };
}
```

---

## Cómo Trabaja Internamente

### Arquitectura del Módulo

```
dashboard.controller.ts
    ↓ (valida RBAC, aplica filtros)
dashboard.service.ts
    ↓ (ejecuta queries SQL raw)
PostgreSQL Database
    ↓ (agrega datos)
Response JSON
```

### Flujo de Ejecución

#### 1. Controller Layer ([dashboard.controller.ts](../../src/api/v1/controllers/dashboard.controller.ts))

**Responsabilidades:**

- Validar autenticación (`req.user`)
- Aplicar RBAC:
  - VENDEDOR → 403
  - VENTANA → auto-filtrado por `req.user.ventanaId`
  - ADMIN → acceso completo
- Resolver rango de fechas usando `resolveDateRange()`
- Delegar a `DashboardService`

**Código Simplificado:**

```typescript
async getMainDashboard(req: AuthenticatedRequest, res: Response) {
  // 1. Validar rol
  if (req.user.role === Role.VENDEDOR) {
    throw new AppError("No autorizado", 403);
  }

  // 2. Resolver fechas
  const date = query.date || 'today';
  const dateRange = resolveDateRange(date, query.fromDate, query.toDate);

  // 3. Aplicar RBAC para VENTANA
  let ventanaId = query.ventanaId;
  if (req.user.role === Role.VENTANA) {
    ventanaId = req.user.ventanaId!; // Forzar filtro
  }

  // 4. Llamar al servicio
  const result = await DashboardService.getFullDashboard({
    fromDate: dateRange.fromAt,
    toDate: dateRange.toAt,
    ventanaId,
    scope: query.scope || 'all',
  });

  return success(res, result);
}
```

#### 2. Service Layer ([dashboard.service.ts](../../src/api/v1/services/dashboard.service.ts))

**Responsabilidades:**

- Ejecutar queries SQL raw optimizadas
- Agrupar resultados por ventana/lotería
- Calcular totales consolidados
- Formatear respuesta

### Queries SQL Detalladas

#### Ganancia (Comisiones)

```sql
SELECT
  v.id as ventana_id,
  v.name as ventana_name,
  l.id as loteria_id,
  l.name as loteria_name,
  COALESCE(SUM(j."commissionAmount"), 0) as total_commission
FROM "Jugada" j
JOIN "Ticket" t ON j."ticketId" = t."id"
JOIN "Sorteo" s ON t."sorteoId" = s."id"
JOIN "Loteria" l ON t."loteriaId" = l."id"
JOIN "Ventana" v ON t."ventanaId" = v."id"
WHERE t."deletedAt" IS NULL
  AND s.status = 'EVALUATED'          -- Solo sorteos evaluados
  AND j."isWinner" = true             -- Solo jugadas ganadoras
  AND t.status IN ('ACTIVE', 'EVALUATED', 'PAID')
  AND t."createdAt" >= ?              -- Filtro de fecha
  AND t."createdAt" <= ?
  AND (? IS NULL OR t."ventanaId" = ?) -- Filtro opcional de ventana
GROUP BY v.id, v.name, l.id, l.name
ORDER BY total_commission DESC
```

**Post-procesamiento:**

- Agrupar por `ventana_id` → `byVentana[]`
- Agrupar por `loteria_id` → `byLoteria[]`
- Sumar todos → `totalAmount`

#### CxC (Cuentas por Cobrar)

```sql
SELECT
  v.id as ventana_id,
  v.name as ventana_name,
  COALESCE(SUM(t."totalAmount"), 0) as total_sales,
  COALESCE(SUM(tp."amountPaid"), 0) as total_paid
FROM "Ventana" v
LEFT JOIN "Ticket" t ON v.id = t."ventanaId"
  AND t."deletedAt" IS NULL
  AND t.status IN ('ACTIVE', 'EVALUATED', 'PAID')
  AND t."createdAt" >= ?
  AND t."createdAt" <= ?
LEFT JOIN "TicketPayment" tp ON t.id = tp."ticketId"
  AND tp."isReversed" = false         -- No incluir pagos revertidos
  AND tp."createdAt" >= ?
  AND tp."createdAt" <= ?
WHERE (? IS NULL OR v.id = ?)
GROUP BY v.id, v.name
```

**Cálculo:**

```typescript
const amount = totalSales - totalPaidOut;
// Solo mostrar si es positivo (ventana debe al banco)
return amount > 0 ? amount : 0;
```

#### CxP (Cuentas por Pagar)

```sql
SELECT
  v.id as ventana_id,
  v.name as ventana_name,
  COALESCE(SUM(j."payout"), 0) as total_winners,
  COALESCE(SUM(tp."amountPaid"), 0) as total_paid
FROM "Ventana" v
LEFT JOIN "Ticket" t ON v.id = t."ventanaId"
  AND t."deletedAt" IS NULL
  AND t.status IN ('EVALUATED', 'PAID')
  AND t."isWinner" = true
  AND t."createdAt" >= ?
  AND t."createdAt" <= ?
LEFT JOIN "Jugada" j ON t.id = j."ticketId"
  AND j."isWinner" = true
  AND j."deletedAt" IS NULL
LEFT JOIN "TicketPayment" tp ON t.id = tp."ticketId"
  AND tp."isReversed" = false
  AND tp."createdAt" >= ?
  AND tp."createdAt" <= ?
WHERE (? IS NULL OR v.id = ?)
GROUP BY v.id, v.name
```

**Cálculo:**

```typescript
const amount = totalPaidOut - totalWinners;
// Solo mostrar si es positivo (banco debe a ventana)
return amount > 0 ? amount : 0;
```

#### Summary (Resumen General)

**Ventas Totales:**

```sql
SELECT COALESCE(SUM(t."totalAmount"), 0) as total
FROM "Ticket" t
WHERE t."deletedAt" IS NULL
  AND t.status IN ('ACTIVE', 'EVALUATED', 'PAID')
  AND t."createdAt" >= ?
  AND t."createdAt" <= ?
  AND (? IS NULL OR t."ventanaId" = ?)
```

**Premios Totales:**

```sql
SELECT COALESCE(SUM(j."payout"), 0) as total
FROM "Jugada" j
JOIN "Ticket" t ON j."ticketId" = t."id"
WHERE t."deletedAt" IS NULL
  AND j."isWinner" = true
  AND t.status IN ('ACTIVE', 'EVALUATED', 'PAID')
  AND t."createdAt" >= ?
  AND t."createdAt" <= ?
  AND (? IS NULL OR t."ventanaId" = ?)
```

**Comisiones Totales:**

```sql
SELECT COALESCE(SUM(j."commissionAmount"), 0) as total
FROM "Jugada" j
JOIN "Ticket" t ON j."ticketId" = t."id"
WHERE t."deletedAt" IS NULL
  AND j."isWinner" = true
  AND t.status IN ('ACTIVE', 'EVALUATED', 'PAID')
  AND t."createdAt" >= ?
  AND t."createdAt" <= ?
  AND (? IS NULL OR t."ventanaId" = ?)
```

**Cantidad de Tickets:**

```typescript
await prisma.ticket.count({
  where: {
    deletedAt: null,
    status: { in: ['ACTIVE', 'EVALUATED', 'PAID'] },
    createdAt: { gte: fromDate, lte: toDate },
    ...(ventanaId && { ventanaId }),
  },
});
```

**Tickets Ganadores:**

```typescript
await prisma.ticket.count({
  where: {
    deletedAt: null,
    isWinner: true,
    status: { in: ['ACTIVE', 'EVALUATED', 'PAID'] },
    createdAt: { gte: fromDate, lte: toDate },
    ...(ventanaId && { ventanaId }),
  },
});
```

### Manejo de Fechas

El módulo usa `resolveDateRange()` desde [src/utils/dateRange.ts](../../src/utils/dateRange.ts):

```typescript
import { resolveDateRange } from '../../../utils/dateRange';

const dateRange = resolveDateRange('today', undefined, undefined);
// Returns: { fromAt: Date, toAt: Date }
// fromAt: 2025-10-29T00:00:00.000Z (inicio del día en UTC)
// toAt:   2025-10-29T23:59:59.999Z (fin del día en UTC)
```

**Presets disponibles:**

- `today` → Hoy (00:00:00 - 23:59:59)
- `yesterday` → Ayer
- `week` → Últimos 7 días
- `month` → Último mes
- `year` → Último año
- `range` → Personalizado (`fromDate` y `toDate` requeridos)

---

## Casos de Uso

### Caso 1: Dashboard de ADMIN - Vista General del Día

**Objetivo:** Ver métricas consolidadas de todas las ventanas hoy.

**Request:**

```http
GET /api/v1/admin/dashboard?date=today
```

**Respuesta Esperada:**

- Total de ventas del día
- Total de comisiones generadas
- CxC por ventana (dinero pendiente de cobro)
- Tickets vendidos y ganadores

**Uso en Frontend:**

- Panel principal con KPIs
- Gráficos de ventas por ventana
- Alertas de CxC alto

---

### Caso 2: ADMIN - Análisis de Ventana Específica (Mes)

**Objetivo:** Analizar rendimiento de "Ventana Central" en octubre.

**Request:**

```http
GET /api/v1/admin/dashboard?date=range&fromDate=2025-10-01&toDate=2025-10-31&ventanaId=550e8400-e29b-41d4-a716-446655440000
```

**Respuesta Esperada:**

- Ganancia de la ventana en el mes
- Desglose por lotería
- CxC/CxP específico de la ventana

**Uso en Frontend:**

- Vista detallada de ventana
- Comparación mes a mes
- Identificación de loterías más rentables

---

### Caso 3: VENTANA - Monitoreo de Ganancia del Día

**Objetivo:** Ventana revisa sus comisiones del día.

**Request:**

```http
GET /api/v1/admin/dashboard/ganancia?date=today
# Token de usuario con role=VENTANA
```

**Respuesta Esperada:**

- Solo ganancia de su ventana
- Desglose por lotería

**Uso en Frontend:**

- Dashboard personal de ventana
- Seguimiento de comisiones en tiempo real

---

### Caso 4: ADMIN - Identificar CxC Altos (Semana)

**Objetivo:** Detectar ventanas con deuda alta esta semana.

**Request:**

```http
GET /api/v1/admin/dashboard/cxc?date=week
```

**Respuesta Esperada:**

```json
{
  "data": {
    "totalAmount": 125000.00,
    "byVentana": [
      {
        "ventanaId": "...",
        "ventanaName": "Ventana Sur",
        "totalSales": 200000.00,
        "totalPaidOut": 75000.00,
        "amount": 125000.00  // ⚠️ Alto
      }
    ]
  }
}
```

**Uso en Frontend:**

- Alertas automáticas si `amount > umbral`
- Lista ordenada por deuda descendente
- Botón de acción: "Solicitar pago"

---

### Caso 5: ADMIN - Comparación de Ganancia por Lotería (Año)

**Objetivo:** Identificar loterías más rentables del año.

**Request:**

```http
GET /api/v1/admin/dashboard/ganancia?date=year
```

**Respuesta Esperada:**

```json
{
  "data": {
    "byLoteria": [
      { "loteriaName": "Tiempos Tica", "amount": 150000.00 },
      { "loteriaName": "Lotto", "amount": 80000.00 },
      { "loteriaName": "Reventados", "amount": 45000.00 }
    ]
  }
}
```

**Uso en Frontend:**

- Gráfico de barras comparativo
- Decisiones de negocio (enfocar recursos en loterías rentables)

---

## Posibles Mejoras

### 1. Filtros Adicionales

#### Por Lotería

```typescript
interface DashboardFilters {
  fromDate: Date;
  toDate: Date;
  ventanaId?: string;
  loteriaId?: string; // ← NUEVO
  scope?: 'all' | 'byVentana';
}
```

**Beneficio:** Analizar rendimiento de una lotería específica.

#### Por Tipo de Apuesta

```typescript
interface DashboardFilters {
  // ...
  betType?: 'NUMERO' | 'REVENTADO'; // ← NUEVO
}
```

**Beneficio:** Comparar ganancia entre NUMERO vs REVENTADO.

---

### 2. Métricas Adicionales

#### Margen de Ganancia

```typescript
interface GananciaResult {
  totalAmount: number;
  totalSales: number; // ← NUEVO
  margin: number;     // ← (ganancia / ventas) * 100
  // ...
}
```

**Cálculo:**

```typescript
const margin = (totalCommissions / totalSales) * 100;
// Ejemplo: 7500 / 150000 * 100 = 5%
```

#### Tasa de Ganadores

```typescript
interface SummaryResult {
  // ...
  winRate: number; // ← (winningTickets / totalTickets) * 100
}
```

---

### 3. Comparación Temporal

#### Período vs Período Anterior

```typescript
interface DashboardResponse {
  current: DashboardData;
  previous: DashboardData; // ← Mismo período anterior
  comparison: {
    salesGrowth: number;      // % cambio en ventas
    commissionGrowth: number; // % cambio en comisiones
  };
}
```

**Ejemplo:**

- `date=week` → Compara con semana anterior
- `date=range&fromDate=2025-10-01&toDate=2025-10-31` → Compara con septiembre

---

### 4. Exportación de Datos

#### Endpoint de Exportación

```http
GET /api/v1/admin/dashboard/export?date=month&format=csv
# Response: CSV file download
```

**Formatos soportados:**

- CSV
- Excel (XLSX)
- PDF (reporte visual)

---

### 5. Alertas Automáticas

#### Configuración de Umbrales

```typescript
interface DashboardAlerts {
  cxcThreshold: number;  // ej: 100000 (alertar si CxC > 100k)
  lowSalesThreshold: number; // ej: 50000 (alertar si ventas < 50k)
}
```

**Backend:**

- Calcular alertas en `getFullDashboard()`
- Retornar en respuesta:

```json
{
  "data": { /* ... */ },
  "alerts": [
    {
      "type": "HIGH_CXC",
      "ventanaId": "...",
      "ventanaName": "Ventana Sur",
      "amount": 125000.00,
      "threshold": 100000.00,
      "message": "CxC excede umbral configurado"
    }
  ]
}
```

---

### 6. Caché de Resultados

#### Implementación con Redis

```typescript
import { redisClient } from '../../../core/redis';

async function getFullDashboard(filters: DashboardFilters) {
  const cacheKey = `dashboard:${JSON.stringify(filters)}`;

  // Intentar leer de caché
  const cached = await redisClient.get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }

  // Calcular
  const result = await calculateFullDashboard(filters);

  // Guardar en caché (TTL: 5 minutos)
  await redisClient.setex(cacheKey, 300, JSON.stringify(result));

  return result;
}
```

**Beneficio:** Reducir carga en DB para consultas frecuentes (ej: dashboard de ADMIN cada 30 segundos).

---

### 7. Paginación en Desgloses

#### Para `byVentana` con muchas ventanas

```typescript
interface GananciaResult {
  totalAmount: number;
  byVentana: VentanaAmount[];
  pagination: {
    total: number;
    page: number;
    pageSize: number;
  };
}
```

**Query Parameters:**

```http
GET /api/v1/admin/dashboard/ganancia?date=month&page=1&pageSize=10
```

---

### 8. Gráficos Pre-calculados

#### Time Series Data

```typescript
interface TimeSeriesData {
  date: string; // YYYY-MM-DD
  sales: number;
  commissions: number;
  tickets: number;
}

interface DashboardResponse {
  // ...
  timeSeries: TimeSeriesData[]; // ← Datos diarios del período
}
```

**Beneficio:** Frontend puede renderizar gráficos de línea sin cálculos adicionales.

---

### 9. Métricas de Rendimiento

#### Tiempo de Respuesta

```typescript
interface DashboardMeta {
  // ...
  queryExecutionTime: number; // ms
  totalQueries: number;
}
```

**Uso:** Monitorear rendimiento y optimizar queries lentas.

---

### 10. Webhooks para Eventos

#### Notificar cuando CxC excede umbral

```typescript
// En dashboard.service.ts
if (cxcResult.totalAmount > ALERT_THRESHOLD) {
  await notifyWebhook({
    event: 'HIGH_CXC_ALERT',
    ventanaId: '...',
    amount: cxcResult.totalAmount,
    threshold: ALERT_THRESHOLD,
  });
}
```

**Integración:** Enviar a Slack, email, SMS, etc.

---

## Dependencias y Relaciones

### Dependencias Directas

**Core:**

- [src/core/prismaClient.ts](../../src/core/prismaClient.ts) - Cliente de Prisma
- [src/core/errors.ts](../../src/core/errors.ts) - `AppError`
- [src/core/types.ts](../../src/core/types.ts) - `AuthenticatedRequest`
- [src/core/logger.ts](../../src/core/logger.ts) - Logging (indirecto via service)

**Utilities:**

- [src/utils/responses.ts](../../src/utils/responses.ts) - `success()`
- [src/utils/dateRange.ts](../../src/utils/dateRange.ts) - `resolveDateRange()` ⚠️ **CRÍTICA**

**Middlewares:**

- [src/middlewares/auth.middleware.ts](../../src/middlewares/auth.middleware.ts) - `protect`
- [src/middlewares/validate.middleware.ts](../../src/middlewares/validate.middleware.ts) - `validateQuery`

**Validación:**

- `zod` - Schemas de validación

### Modelos de Base de Datos (Lectura)

**Principales:**

- `Ticket` - Ventas, totales, timestamps
- `Jugada` - Comisiones, payouts, isWinner
- `TicketPayment` - Pagos realizados

**Joins:**

- `Ventana` - Agrupación por ventana
- `Loteria` - Agrupación por lotería
- `Sorteo` - Validación de estado (EVALUATED)
- `User` - RBAC (req.user.ventanaId)

### Relaciones con Otros Módulos

#### 1. Módulo Ventas ([venta.routes.ts](../../src/api/v1/routes/venta.routes.ts))

- **Relación:** Complementario
- **Patrón compartido:** Mismo esquema de filtros de fecha
- **Diferencia:**
  - Ventas = datos operacionales (tickets individuales)
  - Dashboard = métricas agregadas (totales, promedios)

#### 2. Módulo Commission ([commission.routes.ts](../../src/api/v1/routes/commission.routes.ts))

- **Relación:** Consumidor
- **Dashboard lee:** `Jugada.commissionAmount` (calculado por commission.resolver)
- **Dashboard NO resuelve comisiones**, solo las agrega

#### 3. Módulo Ticket Payment ([ticketPayment.route.ts](../../src/api/v1/routes/ticketPayment.route.ts))

- **Relación:** Consumidor
- **Dashboard lee:** `TicketPayment.amountPaid` para CxC/CxP
- **Validación:** Ignora pagos con `isReversed = true`

#### 4. dateRange.ts (Utilidad Crítica)

- **Función:** `resolveDateRange(date, fromDate, toDate)`
- **Input:**
  - `date`: preset o "range"
  - `fromDate`/`toDate`: strings YYYY-MM-DD
- **Output:** `{ fromAt: Date, toAt: Date }` en UTC

**Ejemplo:**

```typescript
resolveDateRange('today', undefined, undefined)
// → {
//     fromAt: Date(2025-10-29T06:00:00.000Z), // 00:00 CR = 06:00 UTC
//     toAt:   Date(2025-10-30T05:59:59.999Z)  // 23:59 CR = 05:59 UTC (next day)
//   }
```

---

## Estructura de Archivos

```
src/api/v1/
├── controllers/
│   └── dashboard.controller.ts   # 4 endpoints + RBAC
├── routes/
│   └── dashboard.routes.ts       # Rutas + protect middleware
├── services/
│   └── dashboard.service.ts      # Lógica de negocio + SQL raw queries
└── validators/
    └── dashboard.validator.ts    # Zod schemas para query params

src/utils/
└── dateRange.ts                  # ⚠️ Conversión de presets a UTC
```

---

## Seguridad

### Autenticación
✅ Middleware `protect` en todas las rutas

- Valida JWT token
- Adjunta `req.user` con datos del usuario autenticado

### Autorización (RBAC)

| Rol | Acceso | Filtro Aplicado |
|-----|--------|----------------|
| **ADMIN** | ✅ Total | Puede filtrar por `ventanaId` o ver todas |
| **VENTANA** | ✅ Limitado | Auto-filtrado por `req.user.ventanaId` |
| **VENDEDOR** | ❌ Bloqueado | 403 Forbidden |

### Validación de Inputs

**Zod Schema ([dashboard.validator.ts](../../src/api/v1/validators/dashboard.validator.ts)):**

```typescript
const DashboardQuerySchema = z.object({
  date: z.enum(["today", "yesterday", "week", "month", "year", "range"])
         .optional()
         .default("today"),
  fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  ventanaId: z.string().uuid().optional(),
  scope: z.enum(["mine", "all"]).optional(),
}).strict();
```

### Protección SQL Injection

✅ **Prisma `$queryRaw` con parámetros tipados:**

```typescript
const result = await prisma.$queryRaw<Array<RowType>>(
  Prisma.sql`
    SELECT ...
    WHERE t."createdAt" >= ${filters.fromDate}  -- ← Tipado seguro
    AND t."createdAt" <= ${filters.toDate}
  `
);
```

❌ **NUNCA string interpolation:**

```typescript
// PELIGROSO - NO USAR
const query = `SELECT * FROM Ticket WHERE date = '${userInput}'`;
```

---

## Testing

### Tests Unitarios Sugeridos

#### Service Layer

```typescript
describe('DashboardService.calculateGanancia', () => {
  it('should calculate total commission amount', async () => {
    const result = await DashboardService.calculateGanancia({
      fromDate: new Date('2025-10-29T00:00:00Z'),
      toDate: new Date('2025-10-29T23:59:59Z'),
    });
    expect(result.totalAmount).toBeGreaterThanOrEqual(0);
  });

  it('should group commissions by ventana', async () => {
    const result = await DashboardService.calculateGanancia({
      fromDate: new Date('2025-10-29'),
      toDate: new Date('2025-10-29'),
    });
    expect(result.byVentana).toBeInstanceOf(Array);
  });
});
```

#### Controller Layer

```typescript
describe('DashboardController.getMainDashboard', () => {
  it('should reject VENDEDOR role', async () => {
    const req = mockRequest({ user: { role: 'VENDEDOR' } });
    await expect(
      DashboardController.getMainDashboard(req, res)
    ).rejects.toThrow('No autorizado');
  });

  it('should auto-filter by ventanaId for VENTANA role', async () => {
    const req = mockRequest({
      user: { role: 'VENTANA', ventanaId: 'uuid-123' }
    });
    const result = await DashboardController.getMainDashboard(req, res);
    // Verificar que solo incluye datos de uuid-123
  });
});
```

### Tests de Integración

```typescript
describe('GET /api/v1/admin/dashboard', () => {
  it('should return dashboard data for ADMIN', async () => {
    const response = await request(app)
      .get('/api/v1/admin/dashboard?date=today')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveProperty('summary');
    expect(response.body.data).toHaveProperty('ganancia');
    expect(response.body.data).toHaveProperty('cxc');
    expect(response.body.data).toHaveProperty('cxp');
  });
});
```

---

## Documentación Relacionada

- [Commission System](../COMMISSION_SYSTEM.md) - Sistema de comisiones
- [Sales API](../VENTAS_API_DOCUMENTATION.md) - Módulo de ventas (complementario)
- [Date Parameters](../UNIVERSAL_DATE_PARAMETER_STANDARD.md) - Estándar de fechas
- [RBAC Model](../BACKEND_AUTHORITY_MODEL_SUMMARY.md) - Modelo de autorización

---

## Changelog

| Fecha | Versión | Cambios |
|-------|---------|---------|
| 2025-10-29 | 1.0.0 | Documentación inicial completa |

---

**Autor:** AI Assistant
**Revisado por:** Mario Quirós Pizarro
**Última actualización:** 2025-10-29
