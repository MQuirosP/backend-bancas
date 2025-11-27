# Problema Crítico: commissionVentana Retorna 2201 Cuando Debería Ser 1097

**Fecha:** 26 de Noviembre, 2024
**Severidad:** 🔴 CRÍTICA - Afecta todos los reportes de comisión del listero
**Impacto:** Dashboard, Reportes, Cálculos de ganancia neta y margen

---

## 🎯 El Problema

El Backend retorna:
- **Recibido:** `commissionVentana: 2201`
- **Esperado:** `commissionVentana: 1097`
- **Factor:** `2201 / 1097 ≈ 2.006` (casi exactamente el DOBLE)

---

## 🔍 Root Cause Analysis

### Ubicación del Bug

**Archivo:** `src/api/v1/services/dashboard.service.ts`

**Líneas problemáticas:**
- Línea 503-509 (en query `commissions_per_ventana`)
- Línea 570-577 (en query `commissions_per_loteria`)

### El SQL Problemático

Ambas queries usan:

```sql
COALESCE(SUM(
  CASE
    WHEN j."listeroCommissionAmount" > 0 THEN j."listeroCommissionAmount"
    WHEN j."commissionOrigin" IN ('VENTANA', 'BANCA') THEN j."commissionAmount"  -- ❌ BUG AQUÍ
    ELSE 0
  END
), 0) AS commission_ventana
```

### El Problema Específico

La lógica FALLBACK está **incorrecta**:

```
IF listeroCommissionAmount > 0:
  Usa listeroCommissionAmount ✅ CORRECTO
ELSE IF commissionOrigin IN ('VENTANA', 'BANCA'):
  Usa j."commissionAmount" ❌ INCORRECTO
```

**¿Por qué es incorrecto?**

- `j."commissionAmount"` es el snapshot de **comisión del VENDEDOR** (cuando `commissionOrigin='USER'`)
- Para jugadas con `commissionOrigin IN ('VENTANA', 'BANCA')`, no hay `commissionAmount` válido
- El `commissionAmount` en esos casos viene de otra transacción y NO representa la comisión del listero

### Escenario Típico

**Ticket con 2 jugadas:**

```
Jugada 1:
- commissionOrigin: 'USER'
- amount: 100
- commissionAmount: 5 (comisión vendedor)
- listeroCommissionAmount: 10 (comisión listero)

Jugada 2:
- commissionOrigin: 'VENTANA'
- amount: 100
- commissionAmount: 5 (valor residual de otra jugada anterior)
- listeroCommissionAmount: 0 (no calculado aún o es NULL)
```

**Query actual (INCORRECTA):**
```
Para Jugada 1: listeroCommissionAmount=10 > 0 → Suma 10 ✓
Para Jugada 2: listeroCommissionAmount=0, pero commissionOrigin='VENTANA' → Suma commissionAmount=5 ✗

Total incorrecto: 10 + 5 = 15 (cuando debería ser solo 10, porque Jugada 2 tiene comisión listero diferente)
```

---

## ✅ La Solución

### Cambio 1: Fix en Query de Ventana (Línea 503-509)

**ANTES:**
```sql
COALESCE(SUM(
  CASE
    WHEN j."listeroCommissionAmount" > 0 THEN j."listeroCommissionAmount"
    WHEN j."commissionOrigin" IN ('VENTANA', 'BANCA') THEN j."commissionAmount"  -- ❌ BUG
    ELSE 0
  END
), 0) AS commission_ventana
```

**DESPUÉS:**
```sql
COALESCE(SUM(
  CASE
    WHEN j."listeroCommissionAmount" > 0 THEN j."listeroCommissionAmount"
    WHEN j."commissionOrigin" IN ('VENTANA', 'BANCA') AND j."listeroCommissionAmount" IS NULL THEN 0
    WHEN j."commissionOrigin" = 'USER' THEN j."commissionAmount"
    ELSE 0
  END
), 0) AS commission_ventana
```

**O más simple:**
```sql
COALESCE(SUM(
  CASE
    WHEN j."listeroCommissionAmount" > 0 THEN j."listeroCommissionAmount"
    WHEN j."commissionOrigin" = 'USER' THEN j."commissionAmount"
    ELSE 0
  END
), 0) AS commission_ventana
```

### Cambio 2: Fix en Query de Lotería (Línea 570-577)

**Idéntico al cambio anterior**, en la query `commissions_per_loteria`.

---

## 📊 Impacto del Bug

### Qué está pasando ahora

```
Jugada with commissionOrigin='VENTANA', listeroCommissionAmount=10:
  Query suma: commissionAmount (incorrecto) = 5-15 (valor aleatorio)

Jugada with commissionOrigin='USER', commissionAmount=5, listeroCommissionAmount=0:
  Query suma: commissionAmount (correcto) = 5

Total erróneo: 5-15 + 5 = 10-20 (en lugar de 10-15 que es lo correcto)
```

### Campos Afectados en Dashboard

- ✅ `dashboard.byVentana[].commissionVentana` - **INCORRECTO** (casi doble)
- ✅ `dashboard.byLoteria[].commissionVentana` - **INCORRECTO** (casi doble)
- ✅ `dashboard.commissionVentanaTotal` - **INCORRECTO** (suma de lo anterior)
- ✅ Cálculo de `net` (ganancia neta) - **INCORRECTO** (porque usa commissionVentana)
- ✅ Cálculo de `margin` - **INCORRECTO** (porque usa net)

---

## 🔄 Comparación: Antes vs Después

### Query ANTES (INCORRECTA)
```sql
WHEN j."listeroCommissionAmount" > 0 THEN j."listeroCommissionAmount"
WHEN j."commissionOrigin" IN ('VENTANA', 'BANCA') THEN j."commissionAmount"  -- Usa comisión vendedor
ELSE 0
```

**Resultado:** Suma AMBAS comisiones (vendedor + listero) = ~2x el valor correcto

### Query DESPUÉS (CORRECTA)
```sql
WHEN j."listeroCommissionAmount" > 0 THEN j."listeroCommissionAmount"
WHEN j."commissionOrigin" = 'USER' THEN j."commissionAmount"
ELSE 0
```

**Resultado:** Suma SOLO comisión listero = valor correcto

---

## 📋 Cambios Necesarios

### Archivo: `src/api/v1/services/dashboard.service.ts`

**Línea 503-509** (query `commissions_per_ventana`):
```sql
-- ANTES
COALESCE(SUM(
  CASE
    WHEN j."listeroCommissionAmount" > 0 THEN j."listeroCommissionAmount"
    WHEN j."commissionOrigin" IN ('VENTANA', 'BANCA') THEN j."commissionAmount"
    ELSE 0
  END
), 0) AS commission_ventana

-- DESPUÉS
COALESCE(SUM(
  CASE
    WHEN j."listeroCommissionAmount" > 0 THEN j."listeroCommissionAmount"
    WHEN j."commissionOrigin" = 'USER' THEN j."commissionAmount"
    ELSE 0
  END
), 0) AS commission_ventana
```

**Línea 570-577** (query `commissions_per_loteria`):
```sql
-- ANTES
COALESCE(SUM(
  CASE
    WHEN j."listeroCommissionAmount" > 0 THEN j."listeroCommissionAmount"
    WHEN j."commissionOrigin" IN ('VENTANA', 'BANCA') THEN j."commissionAmount"
    ELSE 0
  END
), 0) AS commission_ventana

-- DESPUÉS
COALESCE(SUM(
  CASE
    WHEN j."listeroCommissionAmount" > 0 THEN j."listeroCommissionAmount"
    WHEN j."commissionOrigin" = 'USER' THEN j."commissionAmount"
    ELSE 0
  END
), 0) AS commission_ventana
```

---

## 🎯 Validación Post-Fix

### Verificaciones

1. **commissionVentana debe ≈ 1097** (no 2201)
2. **margin debe ser correcto** (= (net / sales) * 100)
3. **net = sales - payouts - commissionVentana** debe ser matemáticamente correcto
4. **Suma de byVentana[].commissionVentana = dashboard.commissionVentanaTotal**

### Test Manual

```bash
# Antes del fix
GET /admin/dashboard?date=YYYY-MM-DD
# Retorna: byVentana[].commissionVentana = 2201 (INCORRECTO)

# Después del fix
GET /admin/dashboard?date=YYYY-MM-DD
# Retorna: byVentana[].commissionVentana = 1097 (CORRECTO)
```

---

## 🔗 Relación con Otros Problemas

Este bug está relacionado con las correcciones anteriores:
1. ✅ `ed80d4b` - Reemplazar Math.round() con toFixed(2)
2. ✅ `04b970d` - Validar commissionOrigin al sumar
3. ✅ `90b2772` - Usar resolveCommissionFromPolicy en accounts.calculations

Pero **este es un bug ADICIONAL** específico de las queries SQL en dashboard.

---

## 📈 Impacto en Financials

### Dashboard Actual (INCORRECTO)
```
Sales: $1,000
Payouts: $100
Commission Ventana: $2,201 (INCORRECTO - casi doble)
Net: $1,000 - $100 - $2,201 = -$1,301 (NEGATIVO - INCORRECTO)
Margin: -130.1% (INCORRECTO)
```

### Dashboard Correcto (ESPERADO)
```
Sales: $1,000
Payouts: $100
Commission Ventana: $1,097 (CORRECTO)
Net: $1,000 - $100 - $1,097 = -$197 (MEJOR, aunque aún negativo)
Margin: -19.7% (CORRECTO)
```

---

## ⚠️ Nota Técnica

### Campos de Comisión en Jugada

| Campo | Significa | Cuándo se Llena | Quién Recibe |
|-------|-----------|-----------------|-------------|
| `commissionAmount` | Monto de comisión | Siempre | VENDEDOR (si commissionOrigin='USER') |
| `commissionPercent` | Porcentaje aplicado | Siempre | N/A (solo referencia) |
| `commissionOrigin` | De quién es la comisión | Siempre | Indica la fuente |
| `listeroCommissionAmount` | Comisión del listero | Solo jugadas con origen VENTANA/BANCA | LISTERO/VENTANA |

**Regla de Oro:**
- Para `commissionOrigin='USER'`: Sumar `commissionAmount`
- Para `commissionOrigin='VENTANA'`: Sumar `listeroCommissionAmount` (NUNCA `commissionAmount`)
- Para `commissionOrigin='BANCA'`: Sumar `listeroCommissionAmount` (NUNCA `commissionAmount`)

---

**Status:** 🔴 CRÍTICA - REQUIERE FIX INMEDIATO
**Prioridad:** 🚨 ALTA
**Líneas:** 503-509, 570-577 en dashboard.service.ts

