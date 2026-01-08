# Plan de Implementación: Origen y Destino de Pagos/Cobros (Ventanas)

## 1. Diagnóstico del Problema Actual

En el sistema actual, cada `AccountPayment` está vinculado rígidamente a un único `AccountStatement` mediante `accountStatementId`.

- Los movimientos entre Ventana y Vendedor se vinculan al estado de cuenta del **Vendedor**.
- Solo los movimientos directos Ventana-Banca se vinculan al estado de cuenta de la **Ventana**.

Esto causa que los pagos realizados por un usuario de la Ventana hacia un Vendedor sean **invisibles** en el estado de cuenta de la Ventana, a pesar de que representan una salida de dinero (pago) o entrada (cobro) para la oficina.

## 2. Solución Propuesta: Visibilidad por Atribución (Cross-Entity)

En lugar de duplicar registros, se propone evolucionar la lógica de consulta para que el estado de cuenta de una Ventana incluya movimientos basados en la **atribución de autoría**.

### Regla de Atribución para Ventanas

Un movimiento pertenece al estado de cuenta de la **Ventana V** si:

1. Está vinculado directamente al `AccountStatement` de la Ventana (Movimientos directos con la Banca).
2. **O** El movimiento tiene `ventanaId = V`, tiene un `vendedorId` asignado, y fue registrado por un usuario con rol `VENTANA` (`paidByRole = 'VENTANA'`).

## 3. Cambios Técnicos Necesarios

### A. Mejora del Modelo de Datos (`schema.prisma`)

Para optimizar las consultas y evitar joins costosos con la tabla de usuarios en cada cálculo de saldo, se agregará el campo `paidByRole` a `AccountPayment`.

```prisma
model AccountPayment {
  // ... existing fields
  paidByRole Role @default(VENTANA) // Snapshot del rol del autor al momento del registro
}
```

### B. Actualización del Repositorio (`AccountPaymentRepository.ts`)

Se deben modificar los métodos de agregación (`getTotalPaid`, `getTotalCollected`) y búsqueda (`findMovementsByDateRange`) para soportar la lógica de atribución cuando la dimensión es "ventana".

**Lógica de Filtro para Ventana:**

```typescript
const where = {
  ventanaId: targetVentanaId,
  OR: [
    { vendedorId: null }, // Movimientos directos de la oficina
    { 
      vendedorId: { not: null }, 
      paidByRole: 'VENTANA' // Movimientos de oficina hacia/desde vendedores
    }
  ]
};
```

### C. Ajustes en el Motor de Cálculos (`accounts.calculations.ts`)

La función `calculateDayStatement` debe ser actualizada para que, al calcular para una Ventana, utilice los totales atribuidos en lugar de limitarse a los vinculados por `accountStatementId`. Esto asegurará que el `remainingBalance` (Saldo Pendiente) de la Ventana refleje correctamente el flujo de caja hacia los vendedores.

### D. Lógica de Registro (`accounts.movements.ts`)

La función `registerPayment` deberá:

1. Persistir el `paidByRole` del usuario que realiza la acción.
2. **Actualización Dual de Balances**: Si un usuario de Ventana registra un pago para un Vendedor, la función debe identificar y actualizar los totales (`totalPaid`, `totalCollected`, `remainingBalance`) tanto en el `AccountStatement` del Vendedor como en el `AccountStatement` de la Ventana.
3. Mantener el vínculo principal del `accountStatementId` con el Vendedor para fines de auditoría y jerarquía, pero asegurar que el impacto financiero se refleje en ambos estados de cuenta en la base de datos.

## 4. Beneficios de esta Solución

1. **Integridad de Datos**: No hay duplicidad de registros (un solo ID de pago para una transacción).
2. **Consistencia en Reversiones**: Si se revierte un pago, impacta instantáneamente tanto al Vendedor como a la Ventana.
3. **Claridad de Roles**: Diferencia claramente los movimientos realizados por la oficina de aquellos que los vendedores podrían realizar por sí mismos (si se les permite).
4. **Desempeño**: El uso de un campo indexado `paidByRole` permite que el motor de la base de datos filtre eficientemente sin necesidad de lógica compleja en el servidor de aplicaciones.

## 5. Próximos Pasos

1. Ejecutar migración para agregar `paidByRole`.
2. Backfill de datos existentes (asignar `paidByRole` basado en el rol actual de `paidById`).
3. Refactorizar `AccountPaymentRepository` con la nueva lógica de filtros `OR`.
4. Validar cálculos de balances consolidados.
