# Optimizaciones Dashboard y Estado de Cuentas

Este documento detalla las estrategias de optimización para mejorar los tiempos de respuesta en los módulos de Dashboard y Estado de Cuentas.

## 1. Optimizaciones de Base de Datos (SQL & Índices)

### Auditoría y Refinamiento de Índices

Aunque el esquema actual tiene una base sólida (≈ 8/10), es necesario realizar una limpieza para evitar la sobre-indexación y mejorar el rendimiento de escritura.

**Acciones Realizadas:**

- **Backfill y Normalización de `businessDate`**: Se ha poblado el campo `businessDate` en todos los tickets y se ha normalizado su uso en las consultas para evitar el uso de `COALESCE` y `DATE()`, permitiendo el uso eficiente de índices.
- **Índice en `businessDate`**: Se agregó un índice `B-Tree` en `Ticket(businessDate)` para acelerar los reportes y el estado de cuentas.
- **Índices Compuestos Críticos**: Implementados para `ventanaId`, `vendedorId` y `sorteoId` combinados con fechas y estados.

### Problema: Agregaciones Pesadas en Tiempo Real

El dashboard realiza múltiples sub-consultas que escanean las tablas `Ticket` y `Jugada` repetidamente.

**Propuestas:**

- **Uso Extendido de Vistas Materializadas**: Aprovechar `mv_daily_account_summary` no solo para estados de cuenta, sino también para métricas del dashboard (ventas, premios, comisiones).
- **Consolidación de Consultas**: Combinar múltiples agregaciones (`totalSales`, `totalPayouts`, `exposure`) en una sola consulta SQL utilizando CTEs.
- **Agregación en SQL vs JS**: Mover la lógica de cálculo de comisiones directamente a SQL mediante `SUM` y `GROUP BY`.

## 2. Diagnóstico Basado en Datos (Pasos Concretos)

Antes de realizar cambios masivos, se deben ejecutar los siguientes diagnósticos:

1. **Identificar Índices No Usados**:

   ```sql
   SELECT relname, indexrelname, idx_scan 
   FROM pg_stat_user_indexes 
   WHERE idx_scan = 0 AND NOT indisunique
   ORDER BY idx_scan DESC;
   ```

2. **Identificar Queries Lentas**:

   ```sql
   SELECT query, total_time, calls, rows 
   FROM pg_stat_statements 
   ORDER BY total_time DESC 
   LIMIT 10;
   ```

## 3. Estrategias de Caching y Pre-agregación

### Problema: Recálculo Constante de Datos Históricos

Los datos de días anteriores rara vez cambian, pero se recalculan en cada petición. Funciones como `getMonthlyRemainingBalancesBatch` caen en un "camino lento" (slow path) si los estados de cuenta no están al día.

**Propuestas:**

- **Redis para Dashboard**: Cachear la respuesta de `getFullDashboard` por periodos cortos (1-5 min) para filtros comunes.
- **Cache de Saldo Acumulado**: Cachear `accumulatedBalance` de meses anteriores.
- **Pre-agregación Nocturna**: Job para pre-calcular resúmenes del día anterior en una tabla de snapshots.
- **Mantener AccountStatement al día**: Asegurar la frecuencia de los cron jobs de asentamiento para evitar cálculos en tiempo real.

## 4. Optimización a Nivel de Aplicación (Node.js)

### Problema: Recálculo en Cascada del Acumulado Progresivo

El sistema actual sufre de una "reacción en cadena": para calcular el saldo de hoy, depende obligatoriamente del de ayer, y dentro del día, depende de la intercalación exacta de sorteos y movimientos (pagos/cobros) según su hora. Si se modifica un registro pasado, el sistema (en JS) debe recorrer todos los hitos posteriores para actualizar los saldos acumulados.

**Hallazgos Críticos:**
- **Intercalación en JS**: La función `intercalateSorteosAndMovements` realiza el cálculo del "ladder" de saldos en memoria cada vez que se consulta o se registra un movimiento.
- **Desconfianza del Dato**: Incluso cuando un día está asentado, el sistema realiza `count` de tickets para re-verificar saldos, ignorando la integridad de la tabla `AccountStatement`.
- **Triggers Fallidos**: Los intentos previos de usar triggers fallaron porque no lograban mantener la consistencia del saldo progresivo ante anulaciones o cambios retroactivos.

**Propuestas de Mejora:**

- **Motor de Cálculo Incremental (Delta Engine)**:
  - En lugar de recalcular todo el día, implementar una lógica que solo actualice el "segmento" afectado. Si cambia el sorteo de las 11:00 AM, solo se recalculan los hitos posteriores de ese mismo día.
- **Persistencia Post-Cierre**:
  - Aunque el `chronologicalIndex` sea dinámico durante el día de operación (debido a cambios en las horas de los sorteos), este debe **persistirse** en la tabla de hitos una vez que el día se asienta. Esto evita que el Dashboard tenga que ejecutar la lógica de `accounts.intercalate.ts` repetidamente para datos históricos.
- **Universal Settlement (Puntos de Control) [COMPLETADO]**:
  - Se implementó el "Asentamiento Universal" que cierra días y meses de forma definitiva. Una vez cerrado, el sistema **confía plenamente** en los datos de `AccountStatement`, rompiendo la cadena de dependencia histórica y evitando el recálculo masivo de tickets.
- **Refactor de `calculateDayStatement` [COMPLETADO]**:
  - La función ahora detecta si un día está asentado y devuelve los datos persistidos inmediatamente (Hard Lock), eliminando agregaciones costosas en memoria para datos históricos.
- **Consolidación de Lógica de Balances [COMPLETADO]**:
  - Se unificó la lógica de "Fuente de Verdad" en `accounts.balances.ts`, priorizando cierres mensuales, luego estados asentados y finalmente SQL crudo solo si es estrictamente necesario.

## 5. Próximos Pasos Priorizados
1.  **Limpieza de Índices Redundantes**: Eliminar índices no utilizados identificados en la auditoría.
2.  **Implementación de Redis**: Cachear las "escaleras" de saldos (ladders) para el día actual para evitar la intercalación repetitiva en memoria durante la operación en vivo.
3.  **Vistas Materializadas**: Expandir el uso de `mv_daily_account_summary` para métricas adicionales del dashboard.
