/**
 * TenantContext — Propagación de contexto multi-tenant por flujo async.
 *
 * Usa AsyncLocalStorage (Node ≥ 16.4) para llevar bancaId + rol a lo largo
 * de toda la cadena async de un request sin necesidad de pasar parámetros.
 *
 * Los jobs globales deben usar runAsGlobalJob() para bypassear el aislamiento.
 */

import { AsyncLocalStorage } from 'async_hooks';
import { Role } from '../generated/prisma/client';

export interface TenantCtx {
  bancaId: string | null;
  role: Role;
  userId: string;
  ventanaId?: string | null;
  /** true → jobs globales; la extensión de Prisma NO inyecta filtros */
  bypassIsolation: boolean;
}

const tenantStorage = new AsyncLocalStorage<TenantCtx>();

/** Retorna el contexto del flujo async actual, o undefined si no hay ninguno. */
export function getCurrentTenant(): TenantCtx | undefined {
  return tenantStorage.getStore();
}

/**
 * Ejecuta fn dentro del contexto de tenant dado.
 * Llamado desde bancaContextMiddleware para cada request HTTP.
 */
export function runWithTenant<T>(ctx: TenantCtx, fn: () => T): T {
  return tenantStorage.run(ctx, fn);
}

/**
 * Ejecuta fn como un job del sistema (sin aislamiento por banca).
 * Usar en sorteosAuto.job, accountStatementSettlement.job, monthlyClosing.job.
 */
export function runAsGlobalJob<T>(fn: () => Promise<T>): Promise<T> {
  return tenantStorage.run(
    {
      bancaId: null,
      role: Role.ADMIN,
      userId: 'system',
      bypassIsolation: true,
    },
    fn
  );
}
