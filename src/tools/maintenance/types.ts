import { BetType } from "@prisma/client";

export interface DateRangeInput {
  from: string;
  to: string;
}

export interface ParsedDateRange {
  from: Date;
  to: Date;
}

export interface ClonePoliciesOptions {
  sourceVentanaId: string;
  targetVentanaId: string;
  includeBanca?: boolean;
  dryRun?: boolean;
}

export interface TicketRangeOptions {
  from: Date;
  to: Date;
  ventanaId?: string;
  dryRun?: boolean;
}

export interface TicketProcessingContext {
  loteriaId: string;
  ventanaId: string;
  betType: BetType;
  finalMultiplierX: number;
  amount: number;
}

export interface CommandContext {
  logger: Console;
}


