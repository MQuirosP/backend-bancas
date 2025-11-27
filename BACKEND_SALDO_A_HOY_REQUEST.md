# Solicitud Backend: Saldo a Hoy - Acumulado del Mes

## Resumen Ejecutivo

Se solicita que el backend calcule y retorne:
1. **Totales del período seleccionado** (varían según filtro)
2. **Saldo a Hoy** = Acumulado del mes actual (inmutable respecto a período filtrado)

El Saldo a Hoy debe ser el **acumulado de todos los movimientos (cobros/pagos) del mes**, no un cálculo especial.

---

## Definiciones Requeridas

### Saldo a Hoy
- **Qué es**: Acumulado de movimientos (cobros + pagos) del mes actual
- **Fórmula**: `sum(cobros) + sum(pagos) de todo el mes` OR suma de saldos del mes
- **Cambios**: Solo cuando se registran nuevos movimientos en el mes
- **NO cambia**: Cuando el usuario selecciona diferentes períodos
- **Se aplica a**:
  - `/api/v1/accounts/statement?month=2024-11` (mes completo)
  - `/api/v1/accounts/statement?date=today` (hoy)
  - `/api/v1/accounts/statement?date=range&fromDate=...&toDate=...` (rango)

### Totales del Período Seleccionado
- **Qué es**: Suma de movimientos del período específicamente filtrado
- **Cambios**: Cuando el usuario cambia el período (hoy, este mes, este año, rango custom)
- **Ejemplos**:
  - Si filtra "hoy" → suma solo movimientos de hoy
  - Si filtra "este mes" → suma movimientos de todo el mes
  - Si filtra "rango custom (Nov 10-20)" → suma solo ese rango

---

## Response Esperado del Backend

```typescript
{
  "success": true,
  "data": {
    "statements": [
      // Array de statements del período filtrado
      {
        "date": "2024-11-27",
        "month": "2024-11",
        "totalSales": 150000,
        "totalPayouts": 50000,
        "balance": 100000,
        "totalPaid": 20000,
        "totalCollected": 10000,
        "remainingBalance": 70000,
        // ...
      }
    ],

    "totals": {
      // Totales del PERÍODO SELECCIONADO (cambian según filtro)
      "totalSales": 150000,        // Período
      "totalPayouts": 50000,       // Período
      "totalBalance": 100000,      // Período
      "totalPaid": 20000,          // Período
      "totalCollected": 10000,     // Período
      "totalRemainingBalance": 70000, // Período
      "settledDays": 0,
      "pendingDays": 1
    },

    "monthlyAccumulated": {
      // ✅ NUEVO: Acumulado del MES COMPLETO (inmutable respecto a período)
      "totalSales": 1050000,           // Todo el mes
      "totalPayouts": 400000,          // Todo el mes
      "totalBalance": 545000,          // Todo el mes
      "totalPaid": 80000,              // Todo el mes
      "totalCollected": 50000,         // Todo el mes
      "totalRemainingBalance": 415000, // Todo el mes (Saldo a Hoy)
      "settledDays": 26,
      "pendingDays": 1
    },

    "meta": {
      "month": "2024-11",
      "startDate": "2024-11-01",           // Período filtrado
      "endDate": "2024-11-27",             // Período filtrado
      "dimension": "ventana",
      "totalDays": 27,
      "monthStartDate": "2024-11-01",      // Siempre inicio del mes
      "monthEndDate": "2024-11-30"         // Siempre fin del mes
    }
  }
}
```

---

## Casos de Uso

### Caso 1: Usuario filtra por "hoy" (Nov 27)

**Request**:
```
GET /api/v1/accounts/statement?date=today&scope=all&dimension=ventana
```

**Response esperado**:
```json
{
  "totals": {
    "totalSales": 150000,           // HOY solo
    "totalBalance": 100000,         // HOY solo
    "totalRemainingBalance": 70000  // HOY solo
  },

  "monthlyAccumulated": {
    "totalSales": 1050000,          // TODO el mes
    "totalBalance": 545000,         // TODO el mes
    "totalRemainingBalance": 415000 // Saldo a Hoy (inmutable)
  }
}
```

**Comportamiento esperado en FE**:
- Muestra "Período (hoy): ¢70,000"
- Muestra "Saldo a Hoy: ¢415,000"

---

### Caso 2: Usuario filtra por "este mes"

**Request**:
```
GET /api/v1/accounts/statement?month=2024-11&scope=all&dimension=ventana
```

**Response esperado**:
```json
{
  "totals": {
    "totalSales": 1050000,          // TODO el mes (porque es el filtro)
    "totalBalance": 545000,         // TODO el mes
    "totalRemainingBalance": 415000 // TODO el mes
  },

  "monthlyAccumulated": {
    "totalSales": 1050000,          // TODO el mes (mismo valor)
    "totalBalance": 545000,         // TODO el mes (mismo valor)
    "totalRemainingBalance": 415000 // Saldo a Hoy (MISMO que antes)
  }
}
```

**Comportamiento esperado en FE**:
- Muestra "Período (este mes): ¢415,000"
- Muestra "Saldo a Hoy: ¢415,000"
- ✅ Saldo a Hoy NO cambió respecto a Caso 1

---

### Caso 3: Usuario filtra por "este año" (Jan-Nov)

**Request**:
```
GET /api/v1/accounts/statement?date=year&scope=all&dimension=ventana
```

**Response esperado**:
```json
{
  "totals": {
    "totalSales": 5000000,          // TODO el año
    "totalBalance": 2800000,        // TODO el año
    "totalRemainingBalance": 2400000 // TODO el año
  },

  "monthlyAccumulated": {
    "totalSales": 1050000,          // Mes actual (Nov)
    "totalBalance": 545000,         // Mes actual (Nov)
    "totalRemainingBalance": 415000 // Saldo a Hoy (MISMO que antes)
  }
}
```

**Comportamiento esperado en FE**:
- Muestra "Período (este año): ¢2,400,000"
- Muestra "Saldo a Hoy: ¢415,000"
- ✅ Saldo a Hoy NO cambió

---

## Cambios Requeridos en Backend

### 1. Tipo de Datos (`accounts.types.ts`)

```typescript
export interface StatementResponse {
    statements: DayStatement[];
    totals: StatementTotals;          // Período seleccionado
    monthlyAccumulated: StatementTotals; // ✅ NUEVO: Acumulado del mes
    meta: {
        month: string;
        startDate: string;             // Período filtrado
        endDate: string;               // Período filtrado
        dimension: "ventana" | "vendedor";
        totalDays: number;
        // ✅ NUEVO: Información del mes completo
        monthStartDate: string;        // Siempre "2024-11-01"
        monthEndDate: string;          // Siempre "2024-11-30"
    };
}
```

### 2. Lógica de Cálculo (`accounts.calculations.ts`)

**Cambio requerido**:
- Cuando se calcula `totals`, hacerlo para el período filtrado (comportamiento actual)
- **NUEVO**: Cuando se calcula `monthlyAccumulated`, SIEMPRE hacerlo para el mes completo (no afectado por período filtrado)

**Pseudocódigo**:
```typescript
async function getAccountStatement(filters) {
  // Período filtrado (lo que usuario seleccionó)
  const periodData = await fetchData(filters.dateRange);
  const totals = calculateTotals(periodData);

  // Acumulado del mes (SIEMPRE mes completo)
  const monthData = await fetchData({
    fromDate: `2024-11-01`,
    toDate: `2024-11-30`
  });
  const monthlyAccumulated = calculateTotals(monthData);

  return {
    statements: periodData,
    totals,
    monthlyAccumulated,
    meta
  };
}
```

---

## Validación

### ✅ Validación 1: Período no afecta Saldo a Hoy

```
Caso A: Filter "hoy" → monthlyAccumulated.totalRemainingBalance = ¢415,000
Caso B: Filter "este mes" → monthlyAccumulated.totalRemainingBalance = ¢415,000
Caso C: Filter "este año" → monthlyAccumulated.totalRemainingBalance = ¢415,000

Resultado: ✓ MISMO en todos los casos
```

### ✅ Validación 2: Totales del período sí cambian

```
Caso A: Filter "hoy" → totals.totalRemainingBalance = ¢70,000
Caso B: Filter "este mes" → totals.totalRemainingBalance = ¢415,000
Caso C: Filter "este año" → totals.totalRemainingBalance = ¢2,400,000

Resultado: ✓ DIFERENTE en cada caso
```

### ✅ Validación 3: Cuando se registra nuevo movimiento

```
Antes:
- monthlyAccumulated.totalRemainingBalance = ¢415,000

Registra ¢50,000 de pago:

Después:
- monthlyAccumulated.totalRemainingBalance = ¢365,000 ✓ (cambió)

Filtro no afecta resultado
```

---

## Casos Edge

### Edge Case 1: Mes anterior (Octubre)
```
GET /api/v1/accounts/statement?month=2024-10

El response debe retornar:
- totals: Datos de Octubre
- monthlyAccumulated: Datos de Octubre (mismo mes, no mes actual)
```

### Edge Case 2: Rango custom que abarca 2 meses
```
GET /api/v1/accounts/statement?date=range&fromDate=2024-10-15&toDate=2024-11-15

El response debe retornar:
- totals: Datos del rango (Oct 15 - Nov 15)
- monthlyAccumulated: ???
  Opción A: Datos del mes actual (Nov 1-30)
  Opción B: Datos del mes del último day (Nov 15-30)

PREGUNTAR: ¿Cuál debe ser el comportamiento aquí?
```

---

## Summary para Backend Team

**Solicitud**: Añadir `monthlyAccumulated` al response de `/api/v1/accounts/statement`

**Definición**:
- `monthlyAccumulated` = Acumulado de TODO el mes actual
- Siempre del 1 al último día del mes
- NUNCA afectado por período filtrado
- Refleja el "Saldo a Hoy"

**Cambios necesarios**:
1. Añadir field `monthlyAccumulated: StatementTotals` al tipo `StatementResponse`
2. En la lógica de cálculo, cuando se filtra un período, TAMBIÉN calcular el acumulado del mes completo
3. Retornar ambos en el response

**Timeline**: Cuando sea posible
**Bloquea**: Frontend no puede mostrar Saldo a Hoy correcto sin esto

