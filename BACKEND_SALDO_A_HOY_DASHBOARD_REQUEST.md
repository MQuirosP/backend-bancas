# Solicitud Backend: Saldo a Hoy por Listero/Vendedor en Dashboard

## Resumen

Se requiere que el backend agregue el **"Saldo a Hoy"** (acumulado del mes completo) a los endpoints de CxC y CxP del dashboard, desglosado por **listero/vendedor** (dependiendo de la dimensión).

Actualmente:
- ✅ El endpoint `/api/v1/accounts/statement` retorna `monthlyAccumulated` como un total general
- ❌ El endpoint `/api/v1/admin/dashboard/cxc` NO retorna `saldoAHoy` para cada listero/vendedor

---

## Definición: "Saldo a Hoy" por Listero/Vendedor

### ¿Qué es?
El acumulado del mes completo (1-último día del mes) para ese listero/vendedor específico, inmutable respecto al período filtrado en el dashboard.

### Características
- **Se calcula por**: Cada ventana (listero) o vendedor individual (dependiendo dimensión)
- **Se recalcula cuando**: Se registran nuevas ventas/premios en el mes
- **NO cambia cuando**:
  - El usuario cambia el período del dashboard (hoy, semana, mes, año, etc.)
  - Se registran cobros/pagos (movimientos transitorios)
- **Es independiente de**: El período filtrado actualmente en el dashboard

### Fórmula
Por listero/vendedor:
```
Saldo a Hoy = (Ventas del mes - Premios del mes - Comisiones del mes) - Cobros del mes + Pagos del mes
```

O más simple:
```
Saldo a Hoy = Acumulado restante del mes para ese listero/vendedor
```

---

## Cambios Requeridos

### 1. Endpoint: `/api/v1/admin/dashboard/cxc`

**Response estructura actual:**
```typescript
{
  "totalAmount": 1500000,
  "byVentana": [
    {
      "ventanaId": "v1",
      "ventanaName": "Ventana A",
      "totalSales": 500000,
      "totalPayouts": 100000,
      "totalListeroCommission": 25000,
      "totalVendedorCommission": 50000,
      "totalPaid": 10000,
      "totalPaidOut": 5000,
      "totalCollected": 20000,
      "totalPaidToCustomer": 0,
      "amount": 315000,              // Período actual
      "remainingBalance": 315000,    // Período actual
      "isActive": true
    }
  ]
}
```

**Response estructura solicitada:**
```typescript
{
  "totalAmount": 1500000,
  "byVentana": [
    {
      "ventanaId": "v1",
      "ventanaName": "Ventana A",
      "totalSales": 500000,
      "totalPayouts": 100000,
      "totalListeroCommission": 25000,
      "totalVendedorCommission": 50000,
      "totalPaid": 10000,
      "totalPaidOut": 5000,
      "totalCollected": 20000,
      "totalPaidToCustomer": 0,
      "amount": 315000,              // Período filtrado
      "remainingBalance": 315000,    // Período filtrado
      "isActive": true,

      // ✅ NUEVO: Saldo a Hoy (mes completo, inmutable)
      "saldoAHoy": 745000,           // Acumulado del mes COMPLETO para esta ventana
      "saldoAHoyMeta": {
        "monthSales": 1050000,        // Ventas del mes completo para esta ventana
        "monthPayouts": 400000,       // Premios del mes completo para esta ventana
        "monthBalance": 545000,       // Balance del mes completo
        "monthCollected": 50000,      // Cobros del mes completo
        "monthPaid": 80000,           // Pagos del mes completo
        "monthRemainingBalance": 745000 // = monthBalance - monthCollected + monthPaid (Saldo a Hoy)
      }
    }
  ]
}
```

### 2. Endpoint: `/api/v1/admin/dashboard/cxp`

**Mismo patrón que CxC**: Agregar `saldoAHoy` y `saldoAHoyMeta` a cada item en `byVentana`.

### 3. Endpoint: `/api/v1/admin/dashboard` (si aplica)

Si el dashboard completo también lista CxC/CxP, aplicar el mismo cambio.

---

## Casos de Uso (Frontend)

### Caso 1: Dashboard filtrado por "hoy"
```
GET /api/v1/admin/dashboard/cxc?date=today

Response para Ventana A:
- amount: ¢150,000 (solo hoy)
- remainingBalance: ¢150,000 (solo hoy)
- saldoAHoy: ¢745,000 (mes COMPLETO) ← INMUTABLE
```

### Caso 2: Dashboard filtrado por "este mes"
```
GET /api/v1/admin/dashboard/cxc?date=month

Response para Ventana A:
- amount: ¢315,000 (todo el mes)
- remainingBalance: ¢315,000 (todo el mes)
- saldoAHoy: ¢745,000 (mes COMPLETO) ← MISMO VALOR
```

### Caso 3: Dashboard filtrado por "este año"
```
GET /api/v1/admin/dashboard/cxc?date=year

Response para Ventana A:
- amount: ¢500,000 (todo el año)
- remainingBalance: ¢500,000 (todo el año)
- saldoAHoy: ¢745,000 (mes ACTUAL completo) ← MISMO VALOR, solo del mes actual
```

---

## Nota Importante: Dimensiones

El dashboard puede cambiar de dimensión: `dimension=ventana` o `dimension=vendedor`.

- **Si `dimension=ventana`**: Cada item representa una ventana (listero), `saldoAHoy` = acumulado del mes para esa ventana
- **Si `dimension=vendedor`**: Cada item representa un vendedor, `saldoAHoy` = acumulado del mes para ese vendedor

El endpoint debe calcular el `saldoAHoy` para la dimensión correspondiente.

---

## Validación

### ✅ Validación 1: Período no afecta Saldo a Hoy
```
GET /api/v1/admin/dashboard/cxc?date=today
  → saldoAHoy = ¢745,000

GET /api/v1/admin/dashboard/cxc?date=month
  → saldoAHoy = ¢745,000 (MISMO)

GET /api/v1/admin/dashboard/cxc?date=year
  → saldoAHoy = ¢745,000 (MISMO)
```

### ✅ Validación 2: Múltiples listeros tienen diferentes saldoAHoy
```
GET /api/v1/admin/dashboard/cxc

byVentana: [
  { ventanaId: "v1", ventanaName: "Ventana A", saldoAHoy: ¢745,000 },
  { ventanaId: "v2", ventanaName: "Ventana B", saldoAHoy: ¢520,000 }, ← DIFERENTE
  { ventanaId: "v3", ventanaName: "Ventana C", saldoAHoy: ¢310,000 }  ← DIFERENTE
]
```

### ✅ Validación 3: Cuando se registra nuevo movimiento en el mes
Si se registra una venta de ¢100,000 para Ventana A el 29 de noviembre:
```
Antes: saldoAHoy = ¢745,000
Después: saldoAHoy = ¢845,000 ✓ (cambió)
```

---

## Timeline

- **Prioridad**: Alta (bloquea implementación en FE)
- **Complejidad**: Media (reutilizar lógica existente de `monthlyAccumulated`)
- **Reutilización**: El código de `calculateDayStatement` ya calcula `monthlyAccumulated`, se puede adaptar para cada listero/vendedor

---

## Preguntas de Clarificación

1. **¿El `saldoAHoy` debe incluir la meta desglosada** (`saldoAHoyMeta`) o solo el número final?
   - Recomendación: Incluir ambos (número + meta para debuggeo)

2. **¿En qué mes se basa cuando hay un rango custom que abarca 2 meses?**
   - Ej: `date=range&fromDate=2024-10-15&toDate=2024-11-15`
   - Respuesta recomendada: Usar el mes del `toDate` (mes actual = noviembre)

3. **¿Se debe aplicar también a `calculateGanancia` por ventana/vendedor?**
   - Si es necesario, será en una segunda solicitud

---

## Referencia: Implementación Existente

El código para calcular `monthlyAccumulated` ya existe en:
- `src/api/v1/services/accounts/accounts.calculations.ts` (línea ~675)
- Se puede adaptar para cada listero/vendedor en los endpoints de CxC/CxP

---

## Resumen de Cambios Necesarios

| Componente | Cambio |
|-----------|--------|
| **CxC Response** | Agregar `saldoAHoy` y `saldoAHoyMeta` a cada item en `byVentana` |
| **CxP Response** | Agregar `saldoAHoy` y `saldoAHoyMeta` a cada item en `byVentana` |
| **Lógica** | Calcular acumulado del mes completo para cada listero/vendedor |
| **Dimensiones** | Aplicar tanto para `dimension=ventana` como `dimension=vendedor` |

**Status**: Esperando respuesta del backend para proceder con la implementación en FE.
