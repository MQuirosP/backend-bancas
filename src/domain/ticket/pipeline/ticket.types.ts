import { BetType, Role } from "../../../generated/prisma/client";
import { ReportDimension } from "../../../types/enums/report.enum";
import { CommissionContext } from "../../commission/types/CommissionContext";

export type CreateTicketInput = {
  loteriaId: string;
  sorteoId: string;
  ventanaId: string;
  totalAmount?: number;
  clienteNombre?: string | null;
  jugadas: Array<{
    type: BetType;
    number: string;
    reventadoNumber?: string | null;
    amount: number;
    multiplierId?: string;
    finalMultiplierX?: number;
  }>;
};

export type TicketWarning = {
  code: "LOTTERY_MULTIPLIER_RESTRICTED";
  restrictedButAllowed: boolean;
  ruleId: string;
  scope: ReportDimension;
  loteriaId: string;
  loteriaName?: string | null;
  multiplierId: string;
  multiplierName?: string | null;
  message: string;
};

export type TicketTimingCollector = {
  startTime: number;
  initialPoolStats: {
    sales_pool_waiting: number;
    sales_pool_total: number;
    sales_pool_idle: number;
    general_pool_waiting: number;
  };
  t_prefetch?: number;
  t_pool_wait?: number;
  t_tx?: number;
  tx_attempts?: number;
  tx_end_time?: number;
  prefetch_breakdown?: {
    t_actor?: number;
    t_effective_actor?: number;
    t_core_entities?: number;
    t_cutoff?: number;
    t_commissions?: number;
    t_lock_acquire?: number;
    t_multipliers?: number;
    t_pre_tx_meta?: number;
    t_rules?: number;
  };
};

export type CreateTicketOptions = {
  actorRole?: Role;
  commissionContext?: CommissionContext;
  scheduledAt?: Date | null;
  createdBy?: string;
  createdByRole?: Role;
  idempotencyKey?: string;
  timingCollector?: TicketTimingCollector;
  preFetched?: {
    vendedor?: any;
    sorteo?: any;
    ventana?: any;
    loteria?: any;
    multipliers?: any[];
    rules?: any[];
  };
};

export type TicketLockHandle = {
  lockKey: string;
  lockValue: string;
  lockAcquired: boolean;
};

export type TransactionMeta = {
  loteria: any;
  sorteo: any;
  ventana: any;
  user: any;
  bancaId: string;
  loteriaName: string | null;
  businessDateInfo: {
    businessDate: Date;
    businessDateISO: string;
    prefixYYMMDD: string;
  };
  effectiveBaseX: number;
  preResolvedMultiplier: any;
};

export type PreTxMeta = TransactionMeta;

export type PreparedCommissions = {
  jugadasWithCommissions: any[];
  commissionsDetails: any[];
  totalCommission: number;
  totalListeroCommission: number;
};

export type TransactionSaveResult = {
  createdTicketId: string;
  jugadasWithCommissions: any[];
  commissionsDetails: any[];
  ticketNumber: string;
  warnings: TicketWarning[];
  seqForLog: number | null;
};
