# Mantenimiento de políticas y tickets

Este módulo agrupa utilidades internas (CLI + scripts) para clonar políticas, normalizar jugadas, purgar tickets y recalcular comisiones/estados de cuenta. Se ejecuta con `npm run maintenance -- <comando> [opciones]` o con scripts directos vía `npx ts-node --transpile-only`.

> ️ Todas las tareas operan sobre la base en curso (incluida producción). Asegúrate de tener un `.env.local` válido y usa `--dry-run` siempre que el comando lo permita.

## Preparación rápida

1. Instalar dependencias (`npm install`).
2. Configurar credenciales en `.env.local`.
3. Conocer los comandos disponibles:
   ```bash
   npm run maintenance -- help
   ```

## Resumen de comandos CLI

| Comando | Descripción | Flags principales |
| --- | --- | --- |
| `clone-policies` | Clona `commissionPolicyJson` entre ventanas (opcional banca) | `--source-ventana`, `--target-ventana`, `--include-banca`, `--dry-run` |
| `recalc-commissions` | Normaliza multipliers y recalcula comisiones históricas | `--from`, `--to`, `--ventana`, `--normalize`, `--dry-run` |
| `normalize-multipliers` | Ajusta únicamente `finalMultiplierX` de jugadas | `--from`, `--to`, `--ventana`, `--dry-run` |
| `purge-tickets` | Borra tickets/jugadas/pagos anteriores a una fecha y limpia `TicketCounter` | `--before`, `--dry-run` |
| `reapply-commissions` | Reaplica snapshots de comisión con la política vigente | `--from`, `--to`, `--ventana`, `--dry-run` |

### 1. Clonar políticas (`clone-policies`)

```
npm run maintenance -- clone-policies \
  --source-ventana <UUID> \
  --target-ventana <UUID> \
  [--include-banca] \
  [--dry-run]
```

- `--source-ventana`: ventana origen.
- `--target-ventana`: ventana destino.
- `--include-banca`: también copia la política de banca asociada.
- `--dry-run`: imprime acciones sin ejecutarlas.

### 2. Recalcular comisiones (`recalc-commissions`)

Normaliza `finalMultiplierX` (si pasas `--normalize`) y recalcula las comisiones de jugadas/tickets en el rango seleccionado.

```
npm run maintenance -- recalc-commissions \
  --from YYYY-MM-DD \
  --to YYYY-MM-DD \
  [--ventana <UUID>] \
  [--normalize] \
  [--dry-run]
```

- `--from` / `--to`: Intervalo de businessDate (fallback a createdAt).
- `--ventana`: limita a una ventana específica.
- `--normalize`: corrige multiplicadores antes de recalcular.
- `--dry-run`: solo reporta sin persistir.

### 3. Normalizar solo multiplicadores (`normalize-multipliers`)

```
npm run maintenance -- normalize-multipliers \
  --from YYYY-MM-DD \
  --to YYYY-MM-DD \
  [--ventana <UUID>] \
  [--dry-run]
```

Ajusta `finalMultiplierX` en jugadas históricas sin recalcular comisiones.

### 4. Purgar tickets (`purge-tickets`)

```
npm run maintenance -- purge-tickets \
  --before YYYY-MM-DD \
  [--dry-run]
```

- `--before`: elimina tickets/jugadas/pagos con fecha ≤ valor indicado.
- `--dry-run`: muestra cuántos registros se eliminarían.

> **Importante:** la purga no toca `AccountStatement` ni `AccountPayment`; usa los scripts auxiliares descritos más abajo para limpiar y recalcular cuentas después de purgar.

### 5. Reaplicar snapshots de comisión (`reapply-commissions`)

```
npm run maintenance -- reapply-commissions \
  --from YYYY-MM-DD \
  --to YYYY-MM-DD \
  [--ventana <UUID>] \
  [--dry-run]
```

- Recalcula `commissionPercent`, `commissionAmount`, `commissionOrigin` de jugadas según las políticas actuales.
- No cambia `finalMultiplierX` (para eso está `normalize-multipliers`).

## Scripts auxiliares (`scripts/`)

Se ejecutan directo con `npx ts-node --transpile-only`:

| Script | Uso |
| --- | --- |
| `scripts/resetAccountStatements.ts [--dry-run]` | Elimina `AccountStatement` y `AccountPayment` anteriores al corte (por defecto 2025-11-09). Ejecuta en dry-run primero. |
| `scripts/backfillAccountStatements.ts` | Recalcula estados de cuenta para el rango configurado (por defecto 2025-11-09, ventanas activas). Edita fechas/ventanas dentro del script antes de usarlo. |
| `scripts/inspectTicketCommissions.ts <ticket-id>` | Guarda en `debug/` el detalle de jugadas y comisiones de un ticket (auditoría puntual). |
| `scripts/findReventadoJugadas.ts <vendedor-id>` | Lista las jugadas REVENTADO recientes de un vendedor y sus porcentajes. Útil para validar políticas. |
| `scripts/testResolve.ts <jugada-id>` | Corre `resolveCommission` para una jugada concreta y guarda el snapshot resultado (diagnóstico). |

> **Limpieza:** los scripts que generan diagnósticos dejan archivos bajo `debug/`. Elimina esos JSON (`del debug\*.json`) antes de commitear.

## Flujo recomendado

1. **Auditar** con `--dry-run` o scripts de inspección.
2. **Clonar/ajustar políticas** si es necesario (`clone-policies`).
3. **Generar pruebas** o identificar tickets a recalcular.
4. **Purgar/Reaplicar** según el caso:
   - Purga (`purge-tickets`) → limpia estados (`resetAccountStatements`) → backfill (`backfillAccountStatements`).
   - Ajuste de políticas → `reapply-commissions` (y opcional `recalc-commissions` con `--normalize` si cambiaron multiplicadores).
5. **Verificar** en `/commissions`, `/admin/dashboard`, `/accounts` o usando los scripts de inspección.

## Integración con Frontend

Consulta `src/tools/maintenance/FE_GUIDE.md` para conocer los parámetros obligatorios, validaciones y flujos sugeridos que debe exponer el panel de superadmin al invocar estas tareas.

## Extensiones futuras

- Auditoría previa (`maintenance -- audit`) para listar deltas antes de alterar datos.
- Reportes CSV/JSON con diferencias detectadas.
- Endpoints dedicados para que el FE dispare estas tareas (respetando reglas de superadmin).

Si agregas nuevas tareas, regístralas en `index.ts`, documenta los flags y considera tests en `tests/tools/maintenance`.
