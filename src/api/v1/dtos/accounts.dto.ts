import { LedgerType, ReferenceType, OwnerType } from '@prisma/client';

export interface AccountDTO {
  id: string;
  ownerType: OwnerType;
  ownerId: string;
  currency: string;
  balance: number;
  isActive: boolean;
  createdAt: Date;
}

export interface AccountDetailsDTO extends AccountDTO {
  entryCount: number;
  latestEntry?: LedgerEntryDTO | null;
}

export interface BalanceDTO {
  accountId: string;
  balance: number;
  currency: string;
  asOf: Date;
}

export interface LedgerEntryDTO {
  id: string;
  type: LedgerType;
  amount: number;
  referenceType: ReferenceType | null;
  referenceId: string | null;
  note: string | null;
  date: Date;
  createdAt: Date;
  createdBy: string;
  reversalOfEntryId: string | null;
}

export interface ListLedgerEntriesResponseDTO {
  entries: LedgerEntryDTO[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}

export interface BankDepositDTO {
  depositId: string;
  docNumber: string;
  amount: number;
  date: Date;
  bankName?: string | null;
  entryId: string;
  createdAt: Date;
}

export interface DailySnapshotDTO {
  snapshotId: string;
  date: Date;
  opening: number;
  debit: number;
  credit: number;
  closing: number;
  createdAt: Date;
}

export interface BalanceSummaryDTO {
  accountId: string;
  balance: number;
  totalDebit: number;
  totalCredit: number;
  entryCount: number;
  asOf: Date;
}

export interface StatementExportDTO {
  accountId: string;
  ownerType: OwnerType;
  ownerId: string;
  currency: string;
  period: { from: Date; to: Date };
  entries: LedgerEntryDTO[];
  snapshots: Array<{
    date: Date;
    opening: number;
    debit: number;
    credit: number;
    closing: number;
  }>;
  totalEntries: number;
  totalSnapshots: number;
  generatedAt: Date;
}

export interface ListAccountsResponseDTO {
  accounts: AccountDTO[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}
