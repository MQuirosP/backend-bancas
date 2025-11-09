# Guía para integrar Maintenance CLI en el Frontend (Superadmin)

Este documento describe qué formularios, validaciones y post-acciones debe contemplar el módulo de mantenimiento en el FE para invocar las tareas disponibles en `src/tools/maintenance`. La idea es exponer estas acciones solo para usuarios superadmin respetando la lógica actual del backend.

## Reglas generales

- Todas las tareas se ejecutan hoy desde CLI. La capa FE deberá invocar endpoints (o jobs) backend que a su vez llamen a los comandos documentados. Hasta que esos endpoints existan, la UI puede quedar “en espera” tras el botón (por ejemplo, mostrando los parámetros requeridos y enlazando a SOP manual).
- Siempre solicitar `--dry-run` primero cuando el comando lo soporte. Ofrecer un toggle “Ejecutar en modo real” desactivado por defecto.
- Mostrar advertencias claras sobre la irreversibilidad de las acciones (principalmente `purge-tickets`, `reset-account-statements`).
- Registrar quién ejecutó la tarea y con qué parámetros (para bitácora).

## Formularios sugeridos

### 1. Clonar políticas (`clone-policies`)

| Campo | Tipo | Requerido | Validación |
| --- | --- | --- | --- |
| `sourceVentanaId` | Selector de ventana | Sí | Debe existir en catálogo de ventanas activas |
| `targetVentanaId` | Selector de ventana | Sí | Diferente del origen, activa |
| `includeBanca` | Checkbox | No | — |
| `dryRun` | Checkbox | No (por defecto ON) | — |

Acciones:
- Enviar payload `{ command: "clone-policies", flags: { source-ventana, target-ventana, include-banca?, dry-run? } }`.
- Mostrar resultado textual del comando (lista de políticas clonadas o cambios simulados).

### 2. Recalcular comisiones (`recalc-commissions`)

| Campo | Tipo | Requerido | Validación |
| --- | --- | --- | --- |
| `fromDate` | Date picker | Sí | Formato YYYY-MM-DD, `from <= to` |
| `toDate` | Date picker | Sí | — |
| `ventanaId` | Selector de ventana | No | Si se usa, debe existir |
| `normalize` | Checkbox | No | — |
| `dryRun` | Checkbox | No (ON por defecto) | — |

Acciones:
- Payload `{ command: "recalc-commissions", flags: { from, to, ventana?, normalize?, dry-run? } }`.
- En resultado, mostrar conteo de tickets jugadas procesadas y advertir que puede tardar (procesa en lotes de 100).

### 3. Normalizar multiplicadores (`normalize-multipliers`)

Formulario idéntico al de `recalc-commissions` sin `normalize`. Payload: `{ command: "normalize-multipliers", flags: ... }`.

### 4. Purgar tickets (`purge-tickets`)

| Campo | Tipo | Requerido | Validación |
| --- | --- | --- | --- |
| `beforeDate` | Date picker | Sí | Formato YYYY-MM-DD |
| `dryRun` | Checkbox | Sí (forzar tick por defecto) | Para ejecutar real, requiere confirmar modal |

Acciones:
- Payload `{ command: "purge-tickets", flags: { before, dry-run? } }`.
- Mostrar al usuario los totales que se eliminan (tickets, jugadas, pagos, registros de `TicketCounter`).
- Tras ejecución real, invitar a correr `reset-account-statements` y `backfill-account-statements` (ver flujo sugerido).

### 5. Reaplicar comisiones (`reapply-commissions`)

| Campo | Tipo | Requerido | Validación |
| --- | --- | --- | --- |
| `fromDate` | Date picker | Sí | — |
| `toDate` | Date picker | Sí | — |
| `ventanaId` | Selector ventana | No | — |
| `dryRun` | Checkbox | No (ON por defecto) | — |

Acciones:
- Payload `{ command: "reapply-commissions", flags: { from, to, ventana?, dry-run? } }`.
- Uso común: después de corregir políticas; backfill de snapshots.

### 6. Scripts auxiliares

Durante la fase CLI, se sugiere exponer estos scripts como “acciones complementarias”:

| Script | Entrada FE | Notas |
| --- | --- | --- |
| `resetAccountStatements.ts` | Date picker (`beforeDate`), botón dry-run / ejecutar | Advertir que borra snapshots de cuentas. |
| `backfillAccountStatements.ts` | Date picker (`targetDate`), selector de ventanas opcional | Se ejecuta por cada ventana con tickets en el rango configurado dentro del script. |
| `inspectTicketCommissions.ts` | Campo `ticketId` | Devuelve JSON (descargable) con comisiones. |
| `findReventadoJugadas.ts` | Selector `vendedorId` | Lista jugadas REVENTADO recientes y porcentajes actuales. |
| `testResolve.ts` | Campo `jugadaId` | Snapshot del cálculo de comisión (para soporte). |

> Para integrar estos scripts habrá que exponer endpoints backend específicos (futuros). Mientras tanto el FE puede mantenerlos como pasos manuales documentados (copy/paste de comando).

## Post-acciones recomendadas

| Acción | Endpoints a revisar |
| --- | --- |
| Purgar tickets | `/admin/dashboard/*`, `/accounts/statement`, `/accounts/totals` |
| Reaplicar comisiones | `/commissions`, `/admin/dashboard/ganancia` |
| Reset + backfill de cuentas | `/accounts/statement`, `/admin/dashboard/cxc`, `/admin/dashboard/cxp` |

Además, registrar siempre:
- Usuario superadmin que ejecutó la tarea.
- Parámetros utilizados.
- Salida textual del comando (guardar en bitácora o S3).

## Errores comunes a capturar en UI

- **Formato de fecha inválido** → Validar en FE antes de enviar.
- **ventanaId inexistente** → Cargar catálogo de ventanas activas y bloquear IDs manuales.
- **Monto excede saldo** (al ejecutar scripts de pagos) → Mostrar que debe recalcular estados primero.
- **dry-run obligatorio** → Forzar el primer paso como simulación antes de habilitar ejecución real.

## Próximos pasos

1. Backend implementará endpoints wrappers para cada comando (autenticados, auditados).
2. FE podrá invocarlos mediante formularios descritos arriba.
3. Integrar logs/resultados en una vista de historial para trazabilidad.

