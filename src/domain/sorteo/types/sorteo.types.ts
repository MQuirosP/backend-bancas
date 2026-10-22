import { SorteoStatus } from "../../../generated/prisma/client";
import { formatIsoLocal } from "../../../utils/datetime";
import { getCRLocalComponents } from "../../../utils/businessDate";
import { crDateService } from "../../../utils/crDateService";
import crypto from "crypto";

export type {
  CreateSorteoDTO,
  EvaluateSorteoDTO,
  UpdateSorteoDTO,
} from "../../../api/v1/dto/sorteo.dto";

export const FINAL_STATES: Set<SorteoStatus> = new Set([
  SorteoStatus.EVALUATED,
  SorteoStatus.CLOSED,
]);

export const EVALUABLE_STATES = new Set<SorteoStatus>([SorteoStatus.OPEN]);

export function extractReventadoEnabled(loteria: any): boolean {
  if (!loteria || typeof loteria !== "object") return false;
  const rules = (loteria as any)?.rulesJson;
  if (!rules || typeof rules !== "object") return false;
  try {
    return Boolean((rules as any)?.reventadoConfig?.enabled);
  } catch {
    return false;
  }
}

export function sanitizeLoteria(loteria: any) {
  if (!loteria || typeof loteria !== "object") return loteria;
  const { rulesJson, ...rest } = loteria;
  return rest;
}

export function serializeSorteo<
  T extends {
    scheduledAt?: Date | null;
    loteria?: any;
    hasSales?: boolean;
    ticketCount?: number;
    hasExclusions?: boolean;
  }
>(sorteo: T) {
  if (!sorteo) return sorteo;
  const reventadoEnabled = extractReventadoEnabled(sorteo.loteria);
  const serialized = {
    ...sorteo,
    scheduledAt: sorteo.scheduledAt ? formatIsoLocal(sorteo.scheduledAt) : null,
    reventadoEnabled,
    ...(sorteo.hasSales !== undefined ? { hasSales: sorteo.hasSales } : {}),
    ...(sorteo.ticketCount !== undefined ? { ticketCount: sorteo.ticketCount } : {}),
    ...(sorteo.hasExclusions !== undefined ? { hasExclusions: sorteo.hasExclusions } : {}),
  };
  if (sorteo.loteria) {
    (serialized as any).loteria = sanitizeLoteria(sorteo.loteria);
  }
  return serialized;
}

export function serializeSorteos<T extends { scheduledAt?: Date | null }>(sorteos: T[]) {
  return sorteos.map((s) => serializeSorteo(s));
}

/**
 * Formatea una hora en formato 12h con AM/PM (hora local Costa Rica)
 */
export function formatTime12h(date: Date): string {
  const { hour, minute } = getCRLocalComponents(date);
  const ampm = hour >= 12 ? "PM" : "AM";
  let hours12 = hour % 12;
  hours12 = hours12 ? hours12 : 12;
  const minutesStr = String(minute).padStart(2, "0");
  return `${hours12}:${minutesStr}${ampm} `;
}

/**
 * Extrae la fecha en formato YYYY-MM-DD de un Date en hora Costa Rica
 */
export function formatDateOnly(date: Date): string {
  const { year, month, day } = getCRLocalComponents(date);
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

export function buildSummaryCacheKey(options: {
  bancaId?: string | null;
  ventanaId?: string | null;
  vendedorId?: string | null;
  summaryOnly: boolean;
  date?: string | null;
  fromDate?: string | null;
  toDate?: string | null;
  loteriaId?: string | null;
  isActive?: boolean | string;
  scope?: string | null;
  ignoreReset?: boolean;
}): string {
  const isSummaryOnly = Boolean(options.summaryOnly);
  const vId = options.vendedorId || "all";
  const bId = options.bancaId || "all";
  const venId = options.ventanaId || "all";

  const todayStr = crDateService.dateUTCToCRString(new Date());
  const isToday =
    options.date === "today" ||
    !options.date ||
    (options.date === "range" && options.fromDate === todayStr && options.toDate === todayStr);

  if (isToday && !options.loteriaId && (options.scope === "mine" || !options.scope)) {
    return `banca:${bId}:ventana:${venId}:vendedor:${vId}:summary:today:${isSummaryOnly ? "summary" : "detailed"}`;
  }

  const hash = crypto
    .createHash("md5")
    .update(
      JSON.stringify({
        date: options.date,
        fromDate: options.fromDate,
        toDate: options.toDate,
        scope: options.scope || "mine",
        loteriaId: options.loteriaId || null,
        isActive: options.isActive !== false && options.isActive !== "false",
        summaryOnly: isSummaryOnly,
        vendedorId: options.vendedorId || null,
        ignoreReset: Boolean(options.ignoreReset),
      })
    )
    .digest("hex");

  return `banca:${bId}:ventana:${venId}:vendedor:${vId}:summary:${hash}`;
}

export interface SorteoListParams {
  page?: number;
  pageSize?: number;
  loteriaId?: string;
  status?: SorteoStatus;
  date?: string;
  fromDate?: string;
  toDate?: string;
  isActive?: boolean;
  bancaId?: string;
  role?: string;
  userId?: string;
  ventanaId?: string | null;
  userBancaId?: string | null;
  includeExclusions?: boolean;
}

export interface GroupedByLoteriaHourParams {
  date?: string;
  fromDate?: string;
  toDate?: string;
  status?: SorteoStatus;
  isActive?: boolean;
  bancaId?: string;
  role?: string;
  userId?: string;
  ventanaId?: string | null;
  userBancaId?: string | null;
}

export interface GroupedByHourParams {
  date?: string;
  fromDate?: string;
  toDate?: string;
  status?: SorteoStatus;
  isActive?: boolean;
  bancaId?: string;
  role?: string;
  userId?: string;
  ventanaId?: string | null;
  userBancaId?: string | null;
}

export interface EvaluatedSummaryParams {
  date?: string;
  fromDate?: string;
  toDate?: string;
  loteriaId?: string;
  isActive?: boolean | string;
  scope?: string;
  summaryOnly?: boolean | string;
  ventanaId?: string | null;
  vendedorId?: string | null;
  bancaId?: string | null;
  ignoreReset?: boolean | string;
  forceDetailed?: boolean | string;
  role?: string;
  userId?: string;
  userVentanaId?: string | null;
  userBancaId?: string | null;
}
