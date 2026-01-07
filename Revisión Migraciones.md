# Revisión y Plan de Migraciones

**Fecha:** 2026-01-06
**Estado:** Crítico - Desfase detectado entre código y base de datos.

## 1. Diagnóstico del Desfase

### A. Migraciones locales NO aplicadas en la DB
Estas carpetas existen en `prisma/migrations` pero no están marcadas como ejecutadas en la tabla `_prisma_migrations`:
- `20251129000000_add_sorteo_lista_exclusion` (Crea la tabla `SorteoListaExclusion`).
- Otras migraciones recientes posteriores a Diciembre 2025 podrían estar en estado "shadow".

### B. Migraciones en DB que NO existen localmente (Migraciones Fantasma)
La base de datos tiene registros de ejecuciones que no tienen una carpeta correspondiente en el proyecto:
- `20250129000000_fase1_accounts_aggregates_functions`
- `20250129000001_fase2_accounts_triggers`
- `20250129000002_fase3_materialized_view_triggers`
- `20250129000003_fase4_validations`
- `20260105184500_fix_account_statement_unique_constraints`

---

## 2. Plan de Acción (Sesión Nocturna)

### Paso 1: Sincronización de Estructura (Prisma)
1. **Respaldo Total**: `pg_dump` de la base de datos antes de tocar nada.
2. **Reconstrucción de carpeta migrations**:
   - Si las migraciones fantasma contienen lógica vital (Triggers/Funciones), debemos intentar extraer el SQL de la DB y recrear las carpetas locales para que Prisma las reconozca.
3. **Resolución de Conflictos**:
   - Usar `npx prisma migrate resolve --applied <nombre>` para marcar como aplicadas aquellas que ya existen físicamente en la DB pero Prisma cree pendientes.
   - Usar `npx prisma migrate dev` con precaución para detectar cambios no registrados.

### Paso 2: Corrección de Datos de Saldos (Saldo a Hoy)
Se detectó un bug en la lógica de suma global de estados de cuenta (`accounts.calculations.ts`). 
- **Problema**: Al pedir reporte global (`scope=all`), el sistema usaba `findFirst` en lugar de sumar los arrastres de todas las entidades.
- **Tareas**:
  - **Verificar `MonthlyClosingBalance`**: Asegurar que todos los cierres de Diciembre 2025 estén presentes para cada banca, ventana y vendedor.
  - **Script de Recálculo**: Si los cierres están incompletos o erróneos, ejecutar un script manual que dispare `calculateMonthlyClosing` para todas las entidades usando la lógica corregida.
  - **Validación de Arrastre**: Confirmar que el "Saldo Anterior" en Enero 2026 coincida con la suma de todos los cierres de Diciembre 2025.

### Paso 3: Limpieza de Triggers y Funciones
- Revisar si las migraciones `fase1` a `fase4` instalaron triggers que están duplicando o bloqueando cálculos de `AccountStatement`.
- Validar la integridad de la vista materializada `daily_account_summary` respecto a los nuevos cambios.

---

## 3. Riesgos y Precauciones
- **Pérdida de Datos**: El comando `migrate dev` puede sugerir borrar tablas si no encuentra la correspondencia. **NUNCA** aceptar un "drop" de tabla en esta fase.
- **Inconsistencia de Saldos**: Cambiar la lógica de suma sin corregir los datos históricos (`MonthlyClosingBalance`) dejará los reportes de meses pasados con errores.

---

Este documento debe ser la hoja de ruta para la sesión de corrección. No se debe aplicar ningún cambio directamente en producción sin probar la secuencia de `resolve` en un entorno local espejo.