import { BetType, Role } from "../../generated/prisma/client";
import { ReportDimension } from "../../types/enums/report.enum";
import { CommissionContext } from "../commission/types/CommissionContext";

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

export type CreateTicketOptions = {
  actorRole?: Role;
  commissionContext?: CommissionContext;
  scheduledAt?: Date | null;
  createdBy?: string;
  createdByRole?: Role;
  idempotencyKey?: string;
  preFetched?: {
    vendedor?: any;
    sorteo?: any;
    ventana?: any;
    loteria?: any;
    multipliers?: any[];
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
