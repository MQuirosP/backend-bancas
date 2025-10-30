# API: GET /ventas/summary

## Descripción
Retorna un resumen ejecutivo con KPIs de ventas, incluyendo información completa sobre pagos realizados y pendientes.

## Endpoint
```
GET /api/v1/ventas/summary
```

## Parámetros Query

| Parámetro | Tipo | Descripción | Ejemplo |
|-----------|------|-------------|---------|
| `date` | string | Preset de fecha | `today`, `yesterday`, `week`, `month`, `year`, `range` |
| `fromDate` | string | Fecha inicio (YYYY-MM-DD) | `2025-10-01` |
| `toDate` | string | Fecha fin (YYYY-MM-DD) | `2025-10-31` |
| `scope` | string | Alcance (ignorado, RBAC automático) | `mine`, `all` |
| `ventanaId` | UUID | Filtrar por ventana | `550e8400-e29b-41d4-a716-446655440000` |
| `vendedorId` | UUID | Filtrar por vendedor | `550e8400-e29b-41d4-a716-446655440001` |
| `loteriaId` | UUID | Filtrar por lotería | `550e8400-e29b-41d4-a716-446655440002` |
| `sorteoId` | UUID | Filtrar por sorteo | `550e8400-e29b-41d4-a716-446655440003` |
| `status` | string | Estado de tickets | `ACTIVE`, `EVALUATED`, `CANCELLED`, `RESTORED` |
| `winnersOnly` | boolean | Solo tickets ganadores | `true`, `false` |

## Respuesta

### Estructura Completa

```json
{
  "success": true,
  "data": {
    // === VENTAS ===
    "ventasTotal": 31050,           // Total de ventas (sum de Ticket.totalAmount)
    "ticketsCount": 7,              // Cantidad de tickets vendidos
    "jugadasCount": 43,             // Cantidad de jugadas (apuestas)

    // === PREMIOS Y GANANCIAS ===
    "payoutTotal": 12000,           // Total de premios potenciales (sum de Jugada.payout donde isWinner=true)
    "neto": 19050,                  // Neto = ventasTotal - payoutTotal

    // === COMISIONES ===
    "commissionTotal": 600,         // Total de comisiones pagadas a vendedores
    "netoDespuesComision": 18450,   // Neto final = neto - commissionTotal

    // === PAGOS REALIZADOS ===
    "totalPaid": 8000,              // Total PAGADO a ganadores (sum de Ticket.totalPaid)
    "remainingAmount": 4000,        // Total PENDIENTE de pago (sum de Ticket.remainingAmount)
    "paidTicketsCount": 3,          // Tickets completamente pagados (remainingAmount=0)
    "unpaidTicketsCount": 2,        // Tickets con pago pendiente (remainingAmount>0)

    // === METADATA ===
    "lastTicketAt": "2025-10-29T18:45:30.123Z"  // Fecha del último ticket creado
  },
  "meta": {
    "range": {
      "fromAt": "2025-10-29T06:00:00.000Z",
      "toAt": "2025-10-30T05:59:59.999Z",
      "tz": "America/Costa_Rica"
    },
    "effectiveFilters": {
      "scope": "mine",
      "ventanaId": "c90c283b-c28d-4bd0-8d85-d1d6d006fd8f"
    }
  }
}
```

## Campos Detallados

### Ventas
- **ventasTotal**: Suma total de `Ticket.totalAmount` (ingresos brutos)
- **ticketsCount**: Cantidad de tickets que cumplen los filtros
- **jugadasCount**: Cantidad de jugadas (apuestas individuales dentro de tickets)

### Premios y Ganancias
- **payoutTotal**: Suma de `Jugada.payout` para jugadas ganadoras (premios potenciales)
- **neto**: Ganancia bruta = `ventasTotal - payoutTotal`

### Comisiones
- **commissionTotal**: Suma de `Jugada.commissionAmount` (comisiones pagadas a vendedores)
- **netoDespuesComision**: Ganancia neta = `neto - commissionTotal`

### Pagos Realizados (NUEVO)
- **totalPaid**: Suma de `Ticket.totalPaid` - Dinero YA PAGADO a ganadores
- **remainingAmount**: Suma de `Ticket.remainingAmount` - Dinero PENDIENTE de pagar
- **paidTicketsCount**: Tickets donde `isWinner=true AND remainingAmount=0 AND totalPaid>0`
- **unpaidTicketsCount**: Tickets donde `isWinner=true AND remainingAmount>0`

### Metadata
- **lastTicketAt**: ISO 8601 timestamp del ticket más reciente en el rango

## Relaciones Matemáticas

```
ventasTotal = totalAmount de todos los tickets

payoutTotal = payout de jugadas ganadoras (premios potenciales)
neto = ventasTotal - payoutTotal

commissionTotal = comisiones pagadas a vendedores
netoDespuesComision = neto - commissionTotal

totalPaid + remainingAmount = payoutTotal (de tickets ganadores)
totalPaid = dinero ya entregado
remainingAmount = dinero por entregar
```

## Casos de Uso

### 1. Dashboard de Ventas
```javascript
const { ventasTotal, ticketsCount, netoDespuesComision } = data;
console.log(`Ventas: ₡${ventasTotal.toLocaleString()}`);
console.log(`Tickets: ${ticketsCount}`);
console.log(`Ganancia Neta: ₡${netoDespuesComision.toLocaleString()}`);
```

### 2. Tracking de Pagos
```javascript
const { payoutTotal, totalPaid, remainingAmount } = data;
const paymentProgress = (totalPaid / payoutTotal) * 100;
console.log(`Pagado: ${paymentProgress.toFixed(1)}%`);
console.log(`Pendiente: ₡${remainingAmount.toLocaleString()}`);
```

### 3. Indicadores de Estado
```javascript
const { paidTicketsCount, unpaidTicketsCount } = data;
const totalWinners = paidTicketsCount + unpaidTicketsCount;
console.log(`${paidTicketsCount}/${totalWinners} tickets pagados`);
```

### 4. Cash Flow
```javascript
const { ventasTotal, totalPaid, commissionTotal } = data;
const cashInHand = ventasTotal - totalPaid - commissionTotal;
console.log(`Efectivo disponible: ₡${cashInHand.toLocaleString()}`);
```

## RBAC - Control de Acceso

| Rol | Comportamiento |
|-----|---------------|
| **ADMIN** | Ve todos los datos (puede filtrar por ventanaId) |
| **VENTANA** | Solo ve datos de SU ventana (ventanaId auto-aplicado) |
| **VENDEDOR** | Solo ve SUS ventas (vendedorId auto-aplicado) |

## Ejemplos de Requests

### Ver resumen del día actual
```bash
curl -X GET "http://localhost:4000/api/v1/ventas/summary?date=today" \
  -H "Authorization: Bearer $TOKEN"
```

### Ver resumen del mes con filtro por ventana (ADMIN)
```bash
curl -X GET "http://localhost:4000/api/v1/ventas/summary?date=month&ventanaId=c90c283b-c28d-4bd0-8d85-d1d6d006fd8f" \
  -H "Authorization: Bearer $TOKEN"
```

### Ver solo tickets ganadores
```bash
curl -X GET "http://localhost:4000/api/v1/ventas/summary?date=today&winnersOnly=true" \
  -H "Authorization: Bearer $TOKEN"
```

### Rango de fechas personalizado
```bash
curl -X GET "http://localhost:4000/api/v1/ventas/summary?date=range&fromDate=2025-10-01&toDate=2025-10-31" \
  -H "Authorization: Bearer $TOKEN"
```

## Performance

- **Queries**: 6 queries en paralelo (transaction)
- **Tiempo estimado**: 50-200ms (depende de volumen de datos)
- **Optimización**: Usa aggregate queries (no N+1)
- **Índices requeridos**:
  - `Ticket.deletedAt`
  - `Ticket.status`
  - `Ticket.createdAt`
  - `Ticket.ventanaId`
  - `Ticket.isWinner`

## Notas Importantes

1. **Timezone**: Todas las fechas se manejan en `America/Costa_Rica` (GMT-6)
2. **Soft Delete**: Solo cuenta tickets con `deletedAt IS NULL`
3. **Status**: Por defecto filtra `ACTIVE` y `EVALUATED`
4. **Winners Only**: `winnersOnly=true` solo incluye tickets con `isWinner=true`
5. **Payment Fields**: Solo cuentan tickets ganadores para evitar confusión

## Historial de Cambios

| Versión | Fecha | Cambios |
|---------|-------|---------|
| 1.1.0 | 2025-10-29 | Agregados campos de pagos: `totalPaid`, `remainingAmount`, `paidTicketsCount`, `unpaidTicketsCount` |
| 1.0.0 | 2025-10-XX | Versión inicial con campos básicos |

---

**Última actualización**: 2025-10-29
**Commit**: `b188523`
