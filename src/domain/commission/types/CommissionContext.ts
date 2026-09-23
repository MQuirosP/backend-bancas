import { CommissionPolicy } from "./CommissionTypes";

/**
 * Contexto de políticas de comisión ya parseadas y cacheadas
 */
export interface CommissionContext {
  userPolicy: CommissionPolicy | null;
  ventanaPolicy: CommissionPolicy | null;
  bancaPolicy: CommissionPolicy | null;
  listeroPolicy: CommissionPolicy | null;
}


