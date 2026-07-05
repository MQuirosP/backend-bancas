# Arquitectura de Evaluación de Sorteos en Base de Datos (PL/pgSQL)

Para optimizar el rendimiento y mitigar la latencia y consumo de CPU del event loop en Node.js, se migraron los procesos financieros y transaccionales críticos de evaluación a procedimientos almacenados nativos en PostgreSQL.

---

## 1. `fn_evaluate_sorteo`

Evalúa de forma atómica y en una única transacción de base de datos todas las jugadas, premios y estados de tickets de un sorteo específico.

### Parámetros y Firma
```sql
CREATE OR REPLACE FUNCTION fn_evaluate_sorteo(
    p_sorteo_id UUID,                     -- ID del sorteo a evaluar
    p_winning_number VARCHAR,             -- Número ganador (00-99)
    p_extra_multiplier_id UUID DEFAULT NULL, -- ID del multiplicador extra (ej. Reventados)
    p_extra_outcome_code VARCHAR DEFAULT NULL, -- Nombre/código del resultado extra
    p_user_id UUID DEFAULT NULL           -- ID del usuario que evalúa (opcional)
) RETURNS JSONB;
```

### Flujo Interno Transaccional (Secuencia de Pasos)
El procedimiento almacenado ejecuta las siguientes acciones secuenciales en el servidor PostgreSQL:

1. **Bloqueo Pesimista (`FOR UPDATE`):**
   Obtiene el estado actual del sorteo y ejecuta un bloqueo exclusivo en la fila del sorteo en la tabla `"Sorteo"` para evitar condiciones de carrera si dos administradores evalúan concurrentemente.
2. **Validaciones de Estado:**
   - Si el sorteo no existe, lanza un error `P0002`.
   - Si el estado del sorteo ya es `EVALUATED` o `CLOSED`, aborta inmediatamente con un código de error `D0001`.
3. **Resolución de Multiplicadores:**
   Si se provee un multiplicador extra (`p_extra_multiplier_id`), valida en la tabla `"LoteriaMultiplier"` que pertenezca a la misma lotería y esté activo. Si no es válido, levanta el error `D0002`.
4. **Actualización de Estado del Sorteo:**
   Actualiza la tabla `"Sorteo"` fijando el estado en `EVALUATED`, el número ganador, el multiplicador y su valor real `valueX`.
5. **Evaluación de Jugadas de Tipo `NUMERO`:**
   Actualiza masivamente la tabla `"Jugada"` buscando todas las jugadas activas asociadas a tickets no cancelados del sorteo dado. Si el número jugado coincide con `p_winning_number`, marca `isWinner = TRUE` y calcula el `payout` aplicando el multiplicador base correspondiente (`amount * finalMultiplierX`).
6. **Evaluación de Jugadas de Tipo `REVENTADO`:**
   Si el valor del multiplicador extra es superior a `0`, actualiza de la misma manera las jugadas tipo `REVENTADO` que coincidan con el número ganador, calculando su `payout` con el valor del multiplicador extra (`amount * v_extra_x`).
7. **Puesta a Cero de Tickets (Reset):**
   Actualiza todos los tickets no cancelados del sorteo a `status = 'EVALUATED'`, fijando inicialmente `isWinner = FALSE`, `totalPayout = 0` y `remainingAmount = 0`.
8. **Asignación de Premios a Tickets:**
   Mediante una expresión de tabla común (CTE), suma los payouts de todas las jugadas ganadoras por ticket y actualiza masivamente `"Ticket"`, marcando `isWinner = TRUE`, `totalPayout` y `remainingAmount` con el total acumulado.
9. **Bandera `hasWinner`:**
   Comprueba si existieron ganadores en el sorteo y actualiza el campo `hasWinner` del sorteo evaluado.
10. **Resultado de Auditoría:**
    Genera y retorna un objeto `JSONB` que contiene: `sorteoId`, `status = EVALUATED`, `hasWinner` (booleano), `winnersCount` (total de tickets ganadores) y `businessDate`.

---

## 2. `fn_revert_sorteo`

Revierte por completo y de forma segura una evaluación de sorteo regresando todos los tickets a su estado previo.

### Parámetros y Firma
```sql
CREATE OR REPLACE FUNCTION fn_revert_sorteo(
    p_sorteo_id UUID
) RETURNS JSONB;
```

### Flujo Interno Transaccional
1. **Bloqueo Pesimista (`FOR UPDATE`):**
   Bloquea la fila del sorteo y valida que su estado actual sea `EVALUATED`. Si no lo es, aborta con el error `D0003`.
2. **Eliminación de Pagos en Cascada:**
   Elimina físicamente todos los registros de la tabla `"TicketPayment"` asociados a tickets que pertenezcan al sorteo revertido.
3. **Reinicio de Jugadas:**
   Establece `isWinner = FALSE`, `payout = 0`, y limpia los multiplicadores y modificadores extraordinarios en todas las jugadas de los tickets del sorteo.
4. **Reinicio de Tickets:**
   Establece el estado de los tickets de vuelta a `ACTIVE`, `isWinner = FALSE`, `totalPayout = 0`, `remainingAmount = 0` y `totalPaid = 0`.
5. **Reinicio del Sorteo:**
   Regresa el estado del sorteo a `OPEN`, limpiando el número ganador, el multiplicador extra y reiniciando `hasWinner = FALSE`.

---

## 3. Lógica de Sincronización Contable (Híbrida)

### ¿Por qué la sincronización NO se realiza dentro del Stored Procedure de base de datos?

Durante el diseño de la Fase 2, se creó la función `fn_internal_sync_statements` para sincronizar los estados de cuenta diarios (`AccountStatement`) directamente dentro de la base de datos tras la evaluación.

Sin embargo, **se descartó su ejecución interna en la base de datos debido a inconsistencias de multitenancy**:
* **El problema del filtrado por sorteo:** El SP solo recibe el ID del sorteo que se evalúa en ese instante. Al realizar la sincronización basada únicamente en ese sorteo, la base de datos **sobrescribía** el balance del día completo para el tenant (banca), borrando la información de otros sorteos del mismo día que se evaluaron antes.
* **El problema del acoplamiento:** Los estados de cuenta diarios consolidan movimientos financieros globales (ventas, cobros, pagos, comisiones históricas, bloqueos de balances e inicializaciones). Controlar toda esta lógica arrastrando acumulados históricos anteriores con subconsultas SQL resulta frágil y propenso a race conditions complejas en el motor de base de datos.

### El Flujo Híbrido Seguro (Node.js background)
En su lugar, se optó por un modelo híbrido:
1. **Base de Datos:** Resuelve la transacción en milisegundos y retorna el estado.
2. **Node.js (`syncSorteoStatements`):** Inmediatamente después del éxito del SP, orquesta la sincronización en segundo plano. Al usar la función de Node.js, el sistema calcula el statement diario utilizando un filtro por **fecha de negocio (`businessDate`) completa**. Esto asegura que:
   - Se sumen los tickets de **todos los sorteos evaluados del día** para el tenant específico.
   - No exista contaminación entre bancas (aislamiento multitenant robusto por `bancaId`).
   - El event loop no sufra bloqueos porque la sincronización corre asíncronamente en segundo plano.
