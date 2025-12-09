# Reporte de Hallazgos - Endpoint `/sorteos/evaluated-summary`

## Resumen Ejecutivo

Se realizó una revisión exhaustiva del endpoint `/api/v1/sorteos/evaluated-summary` comparándolo con el endpoint `/api/v1/accounts/statement` y la solicitud del frontend. Se identificaron **5 problemas críticos** y **3 problemas menores** que requieren corrección.

---

## Problemas Críticos Identificados

### 1. ❌ **FALTA `monthlyAccumulated` - Saldo Acumulado del Mes**

**Ubicación:** `src/api/v1/services/sorteo.service.ts:1900-1910`

**Situación Actual:**
- El endpoint solo devuelve `meta.totals` que representa el período filtrado (ej: hoy, esta semana)
- **NO existe** `meta.monthlyAccumulated` que muestre el saldo acumulado del mes completo hasta hoy

**Comparación con `/accounts/statement`:**
- `/accounts/statement` devuelve:
  - `totals`: Totales del período filtrado
  - `monthlyAccumulated`: Totales acumulados del mes completo (Saldo a Hoy)

**Impacto:** Los vendedores no pueden ver su saldo real acumulado del mes, solo el del período filtrado.

**Solución Requerida:**
- Agregar cálculo de `monthlyAccumulated` desde el primer día del mes actual hasta la fecha actual
- Debe incluir todos los sorteos evaluados del vendedor en ese período
- Debe incluir todos los pagos/cobros registrados del vendedor en ese período
- Estructura debe ser idéntica a `totals` pero con datos del mes completo

---

### 2. ❌ **FALTA `totalPaid` y `totalCollected` en Totales**

**Ubicación:** `src/api/v1/services/sorteo.service.ts:1862-1898`

**Situación Actual:**
- `dayTotals` solo incluye: `totalSales`, `totalCommission`, `commissionByNumber`, `commissionByReventado`, `totalPrizes`, `totalSubtotal`, `totalTickets`
- **NO incluye** `totalPaid` (pagos registrados)
- **NO incluye** `totalCollected` (cobros registrados)
- **NO incluye** `totalBalance` (balance antes de pagos/cobros)
- **NO incluye** `totalRemainingBalance` (saldo restante real)

**Comparación con `/accounts/statement`:**
- `/accounts/statement` incluye todos estos campos en `DayStatement`:
  - `totalPaid`: Suma de pagos activos (`type='payment'` y `isReversed=false`)
  - `totalCollected`: Suma de cobros activos (`type='collection'` y `isReversed=false`)
  - `balance`: `totalSales - totalPayouts - listeroCommission`
  - `remainingBalance`: `balance - totalCollected + totalPaid`

**Impacto:** Los vendedores no pueden ver cuánto han pagado o cobrado, y el saldo mostrado (`totalSubtotal`) no refleja la realidad porque no considera movimientos de pago/cobro.

**Solución Requerida:**
- Consultar `AccountPayment` para obtener pagos y cobros del vendedor por fecha
- Agregar `totalPaid`, `totalCollected`, `totalBalance`, `totalRemainingBalance` a `dayTotals`
- Agregar los mismos campos a `meta.totals`
- Agregar los mismos campos a `meta.monthlyAccumulated`

**Código de Referencia:**
- Ver `src/api/v1/services/accounts/accounts.calculations.ts:1047-1054` para cálculo de `totalPaid` y `totalCollected`
- Ver `src/repositories/accountPayment.repository.ts:310-441` para método `findMovementsByDateRange`

---

### 3. ❌ **CÁLCULO INCORRECTO de `totalSubtotal`**

**Ubicación:** `src/api/v1/services/sorteo.service.ts:1684-1687` y `1868`

**Situación Actual:**
```typescript
const subtotal = financial.totalSales - financial.totalCommission - financial.totalPrizes;
```

**Problema:**
- `totalSubtotal` se calcula como `totalSales - totalCommission - totalPrizes`
- **NO considera** los pagos/cobros registrados (`totalPaid` y `totalCollected`)
- Esto hace que el saldo mostrado sea incorrecto

**Fórmula CORRECTA según `/accounts/statement`:**
```typescript
balance = totalSales - totalPrizes - totalCommission
remainingBalance = balance - totalCollected + totalPaid
```

**Impacto:** El campo `totalSubtotal` muestra un saldo incorrecto que no refleja la realidad financiera del vendedor.

**Solución Requerida:**
- Mantener `totalSubtotal` por compatibilidad pero igualarlo a `totalRemainingBalance`
- O mejor aún, deprecar `totalSubtotal` y usar `totalRemainingBalance` que es más descriptivo
- Agregar `totalBalance` para mostrar el balance antes de pagos/cobros

---

### 4. ❌ **NO SE CONSULTAN `AccountPayment` para Pagos/Cobros**

**Ubicación:** `src/api/v1/services/sorteo.service.ts:1385-1938`

**Situación Actual:**
- El endpoint solo consulta `Ticket` y `Jugada` para calcular ventas, comisiones y premios
- **NO consulta** `AccountPayment` para obtener pagos y cobros registrados
- **NO hay** ninguna referencia a `AccountPaymentRepository` en el código

**Comparación con `/accounts/statement`:**
- `/accounts/statement` usa `AccountPaymentRepository.findMovementsByDateRange()` para obtener pagos y cobros por fecha
- Ver `src/api/v1/services/accounts/accounts.calculations.ts:872` y `1047-1054`

**Impacto:** Los pagos y cobros registrados en el sistema de estado de cuenta no se reflejan en el historial del vendedor.

**Solución Requerida:**
- Importar `AccountPaymentRepository` desde `src/repositories/accountPayment.repository.ts`
- Llamar a `AccountPaymentRepository.findMovementsByDateRange()` para obtener movimientos por fecha
- Filtrar por `vendedorId` y rango de fechas
- Agrupar movimientos por fecha (usando `toCRDateString` para convertir a fecha CR)
- Calcular `totalPaid` y `totalCollected` por día filtrando `type='payment'` y `type='collection'` con `isReversed=false`

**Código de Referencia:**
```typescript
// Ver src/api/v1/services/accounts/accounts.calculations.ts:872
const movementsByDate = await AccountPaymentRepository.findMovementsByDateRange(
  startDate,
  endDate,
  "vendedor",
  undefined,
  vendedorId
);

// Ver src/api/v1/services/accounts/accounts.calculations.ts:1047-1054
const totalPaid = movements
  .filter((m: any) => m.type === "payment" && !m.isReversed)
  .reduce((sum: number, m: any) => sum + m.amount, 0);
const totalCollected = movements
  .filter((m: any) => m.type === "collection" && !m.isReversed)
  .reduce((sum: number, m: any) => sum + m.amount, 0);
```

---

### 5. ❌ **FALTA CÁLCULO de `monthlyAccumulated`**

**Ubicación:** `src/api/v1/services/sorteo.service.ts:1900-1910`

**Situación Actual:**
- Solo se calcula `meta.totals` que es la suma de los días del período filtrado
- **NO se calcula** `meta.monthlyAccumulated` que debe ser el acumulado del mes completo

**Comparación con `/accounts/statement`:**
- Ver `src/api/v1/services/accounts/accounts.calculations.ts:1627-1731` para cálculo de `monthlyAccumulated`
- Se calcula desde el primer día del mes hasta la fecha actual
- Incluye todos los sorteos, pagos y cobros del mes completo

**Impacto:** Los vendedores no pueden ver su saldo acumulado del mes completo, solo el del período filtrado.

**Solución Requerida:**
- Calcular rango de fechas desde el primer día del mes actual hasta hoy
- Consultar todos los sorteos evaluados del vendedor en ese rango
- Consultar todos los pagos/cobros del vendedor en ese rango
- Calcular totales acumulados con las mismas fórmulas que `totals`
- Agregar `monthlyAccumulated` a `meta` con la misma estructura que `totals`

**Código de Referencia:**
```typescript
// Ver src/api/v1/services/accounts/accounts.calculations.ts:1627-1731
// Calcular desde inicio del mes hasta hoy
const monthlyStartDate = new Date(today.getFullYear(), today.getMonth(), 1);
const monthlyMovementsByDate = await AccountPaymentRepository.findMovementsByDateRange(
  monthlyStartDate,
  today,
  "vendedor",
  undefined,
  vendedorId
);
```

---

## Problemas Menores Identificados

### 6. ⚠️ **FALTA `totalBalance` en Estructura**

**Ubicación:** `src/api/v1/services/sorteo.service.ts:1862-1898`

**Situación Actual:**
- Solo existe `totalSubtotal` que es `totalSales - totalCommission - totalPrizes`
- **NO existe** `totalBalance` que muestre explícitamente el balance antes de pagos/cobros

**Impacto:** Menor claridad en la estructura de datos. Sería mejor tener `totalBalance` y `totalRemainingBalance` separados.

**Solución Requerida:**
- Agregar `totalBalance = totalSales - totalPrizes - totalCommission` a `dayTotals` y `totals`
- Mantener `totalSubtotal` por compatibilidad pero igualarlo a `totalRemainingBalance`

---

### 7. ⚠️ **FALTA Validación de Comisión Correcta**

**Ubicación:** `src/api/v1/services/sorteo.service.ts:1616`

**Situación Actual:**
- Se usa `totalCommission` de `ticket.totalCommission`
- No está claro si esto incluye solo `commissionAmount` (comisión de vendedor) o también `listeroCommissionAmount`

**Comparación con `/accounts/statement`:**
- `/accounts/statement` calcula:
  - `listeroCommission`: Suma de `jugada.listeroCommissionAmount`
  - `vendedorCommission`: Suma de `jugada.commissionAmount` donde `commissionOrigin='USER'`
  - `balance = totalSales - totalPayouts - listeroCommission` (solo resta comisión de listero)

**Impacto:** Si `totalCommission` incluye ambas comisiones, el balance podría estar incorrecto para vendedores.

**Solución Requerida:**
- Verificar qué incluye `ticket.totalCommission`
- Si incluye ambas comisiones, separar en `listeroCommission` y `vendedorCommission`
- Usar solo `listeroCommission` para calcular `balance` (como en `/accounts/statement`)

**Nota:** Según la solicitud, la fórmula debe ser `balance = totalSales - totalPrizes - totalCommission`, donde `totalCommission` es la comisión del vendedor. Esto sugiere que para vendedores, solo se debe restar su propia comisión.

---

### 8. ⚠️ **FALTA Manejo de Zona Horaria en Fechas de Movimientos**

**Ubicación:** `src/api/v1/services/sorteo.service.ts` (cuando se agregue consulta de AccountPayment)

**Situación Actual:**
- El endpoint usa `resolveDateRange` que maneja zona horaria CR correctamente
- Pero cuando se agregue `AccountPaymentRepository.findMovementsByDateRange()`, debe asegurarse que las fechas se conviertan correctamente

**Comparación con `/accounts/statement`:**
- Ver `src/repositories/accountPayment.repository.ts:396-403` para función `toCRDateString`
- Los movimientos se agrupan por fecha CR usando `toCRDateString(payment.date)`

**Impacto:** Si no se maneja correctamente la zona horaria, los movimientos podrían agruparse en días incorrectos.

**Solución Requerida:**
- Asegurarse que `AccountPaymentRepository.findMovementsByDateRange()` reciba fechas en UTC
- Los movimientos ya vienen agrupados por fecha CR desde el repositorio
- Verificar que las fechas de los sorteos (`scheduledAt`) se conviertan a fecha CR para agrupar correctamente con movimientos

---

## Estructura de Datos Actual vs Requerida

### Estructura Actual (`dayTotals`):
```typescript
{
  totalSales: number
  totalCommission: number
  commissionByNumber?: number
  commissionByReventado?: number
  totalPrizes: number
  totalSubtotal: number  // ❌ Incorrecto: no considera pagos/cobros
  totalTickets: number
}
```

### Estructura Requerida (`dayTotals`):
```typescript
{
  totalSales: number
  totalCommission: number
  commissionByNumber?: number
  commissionByReventado?: number
  totalPrizes: number
  totalTickets: number
  // ✅ NUEVOS CAMPOS REQUERIDOS
  totalPaid: number          // Total de pagos registrados (reduce CxP)
  totalCollected: number     // Total de cobros registrados (reduce CxC)
  totalBalance: number       // Balance = totalSales - totalPrizes - totalCommission
  totalRemainingBalance: number  // Saldo restante = totalBalance - totalCollected + totalPaid
  totalSubtotal?: number     // DEPRECATED: igual a totalRemainingBalance
}
```

### Estructura Actual (`meta.totals`):
```typescript
{
  totalSales: number
  totalCommission: number
  commissionByNumber?: number
  commissionByReventado?: number
  totalPrizes: number
  totalSubtotal: number  // ❌ Incorrecto
  totalTickets: number
}
```

### Estructura Requerida (`meta.totals` y `meta.monthlyAccumulated`):
```typescript
{
  totalSales: number
  totalCommission: number
  commissionByNumber?: number
  commissionByReventado?: number
  totalPrizes: number
  totalTickets: number
  // ✅ NUEVOS CAMPOS REQUERIDOS
  totalPaid: number
  totalCollected: number
  totalBalance: number
  totalRemainingBalance: number  // Este es el saldo real
  totalSubtotal?: number  // DEPRECATED: igual a totalRemainingBalance
}
```

---

## Archivos que Requieren Modificación

1. **`src/api/v1/services/sorteo.service.ts`**
   - Línea 1385-1938: Método `evaluatedSummary`
   - Agregar import de `AccountPaymentRepository`
   - Agregar consulta de movimientos por fecha
   - Agregar cálculo de `totalPaid`, `totalCollected`, `totalBalance`, `totalRemainingBalance`
   - Agregar cálculo de `monthlyAccumulated`
   - Corregir cálculo de `totalSubtotal`

2. **`src/api/v1/types/sorteo.types.ts`** (si existe)
   - Agregar tipos para `EvaluatedSorteosSummaryTotals` con nuevos campos
   - Agregar tipo para `monthlyAccumulated`

---

## Dependencias y Referencias

### Repositorios a Usar:
- `AccountPaymentRepository.findMovementsByDateRange()` - Para obtener pagos/cobros por fecha
- Ver: `src/repositories/accountPayment.repository.ts:310-441`

### Servicios de Referencia:
- `src/api/v1/services/accounts/accounts.calculations.ts` - Cálculo de `monthlyAccumulated` (línea 1627-1731)
- `src/api/v1/services/accounts/accounts.calculations.ts` - Cálculo de `totalPaid` y `totalCollected` (línea 1047-1054)

### Utilidades:
- `toCRDateString()` - Para convertir fechas a formato CR (ver `src/repositories/accountPayment.repository.ts:396-403`)
- `resolveDateRange()` - Ya se usa en el endpoint para manejar fechas

---

## Prioridad de Implementación

1. **ALTA:** Agregar consulta de `AccountPayment` y cálculo de `totalPaid` y `totalCollected`
2. **ALTA:** Agregar `totalBalance` y `totalRemainingBalance` a `dayTotals` y `totals`
3. **ALTA:** Agregar `monthlyAccumulated` a `meta`
4. **MEDIA:** Corregir cálculo de `totalSubtotal` (igualarlo a `totalRemainingBalance`)
5. **BAJA:** Validar cálculo de comisiones (verificar si `totalCommission` incluye ambas comisiones)

---

## Notas Técnicas Adicionales

1. **Filtros de Movimientos:**
   - Solo contar movimientos con `isReversed=false`
   - Filtrar por `type='payment'` para `totalPaid`
   - Filtrar por `type='collection'` para `totalCollected`
   - Filtrar por `vendedorId` del usuario autenticado

2. **Agrupación por Fecha:**
   - Los movimientos deben agruparse por fecha CR (usando `toCRDateString`)
   - Los sorteos ya están agrupados por fecha usando `formatDateOnly(sorteo.scheduledAt)`
   - Asegurar que ambas fechas usen el mismo formato (YYYY-MM-DD)

3. **Cálculo de `monthlyAccumulated`:**
   - Debe calcularse desde el primer día del mes actual hasta hoy
   - Debe incluir todos los sorteos evaluados del vendedor en ese período
   - Debe incluir todos los pagos/cobros del vendedor en ese período
   - Debe usar las mismas fórmulas que `totals` pero con datos del mes completo

4. **Compatibilidad:**
   - `totalSubtotal` puede mantenerse por compatibilidad pero debe ser igual a `totalRemainingBalance`
   - Los campos nuevos son REQUERIDOS según la solicitud
   - `monthlyAccumulated` es REQUERIDO según la solicitud

---

## Conclusión

El endpoint `/sorteos/evaluated-summary` requiere modificaciones significativas para cumplir con los requisitos del frontend. Los problemas principales son:

1. Falta de consulta de `AccountPayment` para pagos/cobros
2. Falta de campos `totalPaid`, `totalCollected`, `totalBalance`, `totalRemainingBalance`
3. Falta de `monthlyAccumulated` para mostrar saldo acumulado del mes
4. Cálculo incorrecto de `totalSubtotal` que no considera pagos/cobros

La implementación debe seguir el mismo patrón usado en `/accounts/statement` para mantener consistencia en el sistema.

