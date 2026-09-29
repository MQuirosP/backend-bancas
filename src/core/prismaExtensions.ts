/**
 * Prisma Tenant Isolation Extension
 *
 * Inyecta automáticamente `{ bancaId }` en las queries de Prisma cuando hay un
 * TenantCtx activo (AsyncLocalStorage). Actúa como segunda línea de defensa:
 * complementa —no reemplaza— la lógica de applyRbacFilters.
 *
 * MODELOS CON SCOPE (LIST_SCOPED_MODELS):
 *   Ticket, Jugada, AccountStatement, AccountPayment,
 *   ResumenCierreDiario, DailyNumberSales, MonthlyClosingBalance
 *
 * MODELOS GLOBALES (excluidos explícitamente):
 *   Sorteo       → puede tener bancaId IS NULL (sorteos globales compartidos)
 *   Loteria      → catálogo global
 *   LoteriaMultiplier → catálogo global
 *   RestrictionRule   → mixto; tiene su propio RBAC en ticket-restriction.helper
 *   User / Ventana / Banca → accedidos por ID o gestionados por RBAC de ruta
 *
 * OPERACIONES CUBIERTAS (LIST_OPERATIONS):
 *   findMany, findFirst, count, aggregate, groupBy
 *   — NO findUnique (acceso por PK, ya aislado por el caller)
 *   — NO create/update/delete (bancaId es responsabilidad del caller en escrituras)
 *
 * RAW QUERIES:
 *   $queryRaw / $executeRaw no son interceptables por extensiones de Prisma.
 *   Cada raw query debe incluir filtros de bancaId explícitos cuando corresponda.
 */

import { Prisma } from '../generated/prisma/client';
import { getCurrentTenant } from './tenantContext';

/** Modelos con campo `bancaId` donde se aplica el filtro de tenant en lecturas de lista. */
const LIST_SCOPED_MODELS = new Set([
  'Ticket',
  'Jugada',
  'AccountStatement',
  'AccountPayment',
  'ResumenCierreDiario',
  'DailyNumberSales',
  'MonthlyClosingBalance',
]);

/** Operaciones de lectura en lista donde aplica el filtro de tenant. */
const LIST_OPERATIONS = new Set([
  'findMany',
  'findFirst',
  'count',
  'aggregate',
  'groupBy',
]);

export const tenantIsolationExtension = Prisma.defineExtension({
  name: 'tenantIsolation',
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        const tenant = getCurrentTenant();

        // Sin contexto (startup, test sin tenant) o bypass explícito → pasar directo
        if (!tenant || tenant.bypassIsolation || !tenant.bancaId) {
          return query(args);
        }

        // Solo filtrar en modelos scoped y operaciones de lista
        if (!LIST_SCOPED_MODELS.has(model ?? '') || !LIST_OPERATIONS.has(operation)) {
          return query(args);
        }

        // Inyectar bancaId como condición AND adicional en el where existente
        const injectedArgs = {
          ...args,
          where: (args as any).where
            ? { AND: [(args as any).where, { bancaId: tenant.bancaId }] }
            : { bancaId: tenant.bancaId },
        };

        return query(injectedArgs);
      },
    },
  },
});
