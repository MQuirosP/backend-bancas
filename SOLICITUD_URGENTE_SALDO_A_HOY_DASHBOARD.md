# 🔴 SOLICITUD URGENTE: Implementar saldoAHoy en CXC/CXP

## Status: BLOQUEADOR - Frontend esperando

---

## El Problema

El frontend ya está listo para mostrar "Saldo a Hoy" en el dashboard, **PERO el backend NO está retornando el campo `saldoAHoy`**.

### Evidencia
```javascript
// Frontend viendo esto en consola:
CxC item: {ventanaId: '08d629d9-...', saldoAHoy: undefined}  ← UNDEFINED!
CxP item: {ventanaId: 'f1a6f9f3-...', saldoAHoy: undefined}  ← UNDEFINED!
```

El campo `saldoAHoy` **NO está viniendo del backend**.

---

## Qué se necesita

### Endpoint: `/api/v1/admin/dashboard/cxc`

**Cambiar el response de:**
```typescript
{
  "items": [
    {
      "ventanaId": "...",
      "ventanaName": "Ventana A",
      "totalSales": 500000,
      "amount": 315000,
      "remainingBalance": 315000
      // ← FALTA saldoAHoy
    }
  ]
}
```

**A:**
```typescript
{
  "items": [
    {
      "ventanaId": "...",
      "ventanaName": "Ventana A",
      "totalSales": 500000,
      "amount": 315000,
      "remainingBalance": 315000,
      "saldoAHoy": 745000  // ✅ AGREGADO
    }
  ]
}
```

### Endpoint: `/api/v1/admin/dashboard/cxp`

Mismo cambio: agregar `saldoAHoy` a cada item.

---

## ¿Cuál es el valor de `saldoAHoy`?

Es el **acumulado del mes COMPLETO para esa ventana específica**.

**Ejemplo:**
- Ventana A:
  - Acumulado del mes (Nov 1-30): ¢745,000 ← Este es el `saldoAHoy`
  - Período actual (filtro "hoy"): ¢315,000 ← Este es `remainingBalance`

---

## ¿Cómo calcularlo?

Ya tienes la lógica en `/api/v1/accounts/statement` que calcula `monthlyAccumulated`.

Necesitas hacer lo **mismo pero para cada ventana/vendedor** en los endpoints CXC/CXP.

**Pseudocódigo:**
```typescript
// Para cada ventana en CXC:
const monthlyData = await calculateMonthlyAccumulated(ventanaId)
const saldoAHoy = monthlyData.totalRemainingBalance

// Agregar al response:
item.saldoAHoy = saldoAHoy
```

---

## Timeline

- **Prioridad**: 🔴 CRÍTICA (bloquea frontend)
- **Complejidad**: Media (reutilizar código existente)
- **ETA**: ASAP

---

## Verificación

Una vez implementado, el frontend debería ver en consola:
```javascript
CxC item: {ventanaId: '08d629d9-...', saldoAHoy: 745000}  ← CON VALOR
CxP item: {ventanaId: 'f1a6f9f3-...', saldoAHoy: 520000}  ← CON VALOR
```

Y en el dashboard deberían verse los valores en azul al extremo derecho de cada listero.

---

## Frontend status

✅ Todo listo, esperando que el backend retorne `saldoAHoy`

```typescript
// Código en FinanceAnalysis.tsx está así:
{item.saldoAHoy !== undefined && (
  <YStack>
    <Text>Saldo a Hoy</Text>
    <Text>{formatCurrency(item.saldoAHoy)}</Text>  ← Mostrará cuando backend lo envíe
  </YStack>
)}
```

Si no hace nada, no se renderiza. Una vez que el backend retorne el valor, aparecerá automáticamente.

---

## Resumen

| Qué | Dónde |
|-----|-------|
| Falta | `/api/v1/admin/dashboard/cxc` y `/cxp` |
| Campo | `saldoAHoy: number` (acumulado del mes) |
| Efecto | Frontend mostrará "Saldo a Hoy" en dashboard |

**Gracias por la implementación rápida!** 🚀
