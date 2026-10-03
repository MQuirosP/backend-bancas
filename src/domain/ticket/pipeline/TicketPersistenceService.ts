import { Prisma, TicketStatus } from "../../../generated/prisma/client";
import { salesPrisma } from "../../../core/prismaClient";
import { AppError } from "../../../core/errors";
import logger from "../../../core/logger";
import { DailyNumberSalesService } from "../../sorteo/dailyNumberSales.service";
import {
  CreateTicketInput,
  CreateTicketOptions,
  PreparedCommissions,
  TransactionMeta,
  TransactionSaveResult,
} from "./ticket.types";

export type TicketSaveContext = {
  data: CreateTicketInput;
  meta: TransactionMeta;
  ticketNumber: string;
  seqForLog: number | null;
  totalAmountTx: number;
  commissions: PreparedCommissions;
  warnings: any[];
  userId: string;
  options?: CreateTicketOptions;
};

export interface AtomicTicketRpcParams {
  loteriaId: string;
  sorteoId: string;
  ventanaId: string;
  bancaId: string;
  vendedorId: string;
  businessDateISO: string; // YYYY-MM-DD
  totalAmount: number;
  totalCommission: number;
  totalListeroCommission: number;
  clienteNombre?: string | null;
  createdBy?: string | null;
  createdByRole?: string | null;
  idempotencyKey?: string | null;
  jugadasJson: string;
}

export interface AtomicTicketRpcResult {
  id: string;
  ticketNumber: string;
  businessDate?: string;
  loteriaId?: string;
  sorteoId?: string;
  ventanaId?: string;
  vendedorId?: string;
  bancaId?: string;
  totalAmount?: number;
  totalCommission?: number;
  totalListeroCommission?: number;
  status?: string;
  clienteNombre?: string;
  createdAt?: string;
}

/**
 * Normaliza y sanitiza el array de jugadas a formato JSON string defensivo para PostgreSQL jsonb_to_recordset.
 * Asegura que nulos y campos vacíos se conviertan estrictamente a null para evitar fallos de casteo UUID/numérico.
 */
export function sanitizeJugadasForRpc(jugadasWithCommissions: any[]): string {
  const sanitized = jugadasWithCommissions.map((j) => ({
    type: j.type ?? "NUMERO",
    number: String(j.number),
    reventadoNumber:
      j.reventadoNumber && String(j.reventadoNumber).trim() !== ""
        ? String(j.reventadoNumber).trim()
        : null,
    amount: Number(j.amount),
    finalMultiplierX: Number(j.finalMultiplierX ?? 0),
    commissionPercent: Number(j.commissionPercent ?? 0),
    commissionAmount: Number(j.commissionAmount ?? 0),
    commissionOrigin:
      j.commissionOrigin && String(j.commissionOrigin).trim() !== ""
        ? String(j.commissionOrigin).trim()
        : null,
    commissionRuleId:
      j.commissionRuleId && String(j.commissionRuleId).trim() !== ""
        ? String(j.commissionRuleId).trim()
        : null,
    listeroCommissionAmount: Number(j.listeroCommissionAmount ?? 0),
    multiplierId:
      j.multiplierId && String(j.multiplierId).trim() !== ""
        ? String(j.multiplierId).trim()
        : null,
  }));

  return JSON.stringify(sanitized);
}

/**
 * Invoca la función almacenada atómica fn_crear_ticket_venta en PostgreSQL / Supabase en un único Round-Trip Time (RTT).
 * Mapea las excepciones SQL esperadas (P0003: SORTEO_NOT_OPEN -> 409, P0002: SORTEO_NOT_FOUND -> 404).
 */
export async function executeAtomicTicketCreationRpc(
  params: AtomicTicketRpcParams
): Promise<AtomicTicketRpcResult> {
  const clienteNombre = params.clienteNombre
    ? params.clienteNombre.trim().slice(0, 100)
    : null;
  const createdBy = params.createdBy?.trim() || null;
  const createdByRole = params.createdByRole?.trim() || null;
  const idempotencyKey = params.idempotencyKey?.trim() || null;

  try {
    const rows = await salesPrisma.$queryRaw<Array<{ fn_crear_ticket_venta: any }>>(
      Prisma.sql`
        SELECT public.fn_crear_ticket_venta(
          ${params.loteriaId}::uuid,
          ${params.sorteoId}::uuid,
          ${params.ventanaId}::uuid,
          ${params.bancaId}::uuid,
          ${params.vendedorId}::uuid,
          ${params.businessDateISO}::date,
          ${params.totalAmount}::float8,
          ${params.totalCommission}::float8,
          ${params.totalListeroCommission}::float8,
          ${clienteNombre}::varchar,
          ${createdBy ? Prisma.sql`${createdBy}::uuid` : Prisma.sql`NULL::uuid`},
          ${createdByRole}::text,
          ${idempotencyKey}::text,
          ${params.jugadasJson}::jsonb
        )
      `
    );

    let result = rows?.[0]?.fn_crear_ticket_venta;
    if (typeof result === "string") {
      try {
        result = JSON.parse(result);
      } catch {}
    }

    if (!result?.id || !result?.ticketNumber) {
      throw new AppError("Respuesta inválida del stored procedure de venta", 500);
    }

    return result as AtomicTicketRpcResult;
  } catch (err: any) {
    if (err instanceof AppError) {
      throw err;
    }

    const fullErrorStr = `${err?.message || ""} ${err?.code || ""} ${JSON.stringify(err?.meta || "")}`;
    if (fullErrorStr.includes("SORTEO_NOT_OPEN") || err?.code === "P0003") {
      throw new AppError(
        "No se pueden crear tickets en un sorteo cerrado o no abierto",
        409,
        "SORTEO_CLOSED"
      );
    }
    if (fullErrorStr.includes("SORTEO_NOT_FOUND") || err?.code === "P0002") {
      throw new AppError("Sorteo no encontrado", 404, "SORTEO_NOT_FOUND");
    }

    throw err;
  }
}

export class TicketPersistenceService {
  static sanitizeJugadasForRpc = sanitizeJugadasForRpc;
  static executeAtomicTicketCreationRpc = executeAtomicTicketCreationRpc;
  /**
   * Inserta en la transacción el Ticket, sus Jugadas en batch e invoca la agregación en DailyNumberSales.
   * REGLA DE ORO: Recibe explícitamente tx: Prisma.TransactionClient.
   */
  static async save(
    tx: Prisma.TransactionClient,
    context: TicketSaveContext
  ): Promise<TransactionSaveResult> {
    const {
      data,
      meta,
      ticketNumber,
      seqForLog,
      totalAmountTx,
      commissions,
      warnings,
      userId,
      options,
    } = context;

    const { loteriaId, sorteoId, ventanaId, clienteNombre } = data;
    const { bancaId, businessDateInfo, sorteo } = meta;
    const {
      jugadasWithCommissions,
      commissionsDetails,
      totalCommission,
      totalListeroCommission,
    } = commissions;

    const normalizedClienteNombre =
      clienteNombre?.trim() || "CLIENTE CONTADO";

    const createdTicket = await tx.ticket.create({
      data: {
        ticketNumber,
        businessDate: businessDateInfo.businessDate,
        bancaId,
        loteriaId,
        sorteoId,
        ventanaId,
        vendedorId: userId,
        totalAmount: totalAmountTx,
        totalCommission,
        totalListeroCommission,
        status: TicketStatus.ACTIVE,
        isActive: true,
        clienteNombre: normalizedClienteNombre,
        createdBy: options?.createdBy ?? null,
        createdByRole: options?.createdByRole ?? null,
        idempotencyKey: options?.idempotencyKey ?? null,
      },
    });

    const BATCH_SIZE = 500;
    for (let i = 0; i < jugadasWithCommissions.length; i += BATCH_SIZE) {
      const batch = jugadasWithCommissions.slice(i, i + BATCH_SIZE);
      await tx.jugada.createMany({
        data: batch.map((j) => ({
          ticketId: createdTicket.id,
          bancaId,
          type: j.type,
          number: j.number,
          reventadoNumber: j.reventadoNumber,
          amount: j.amount,
          finalMultiplierX: j.finalMultiplierX,
          commissionPercent: j.commissionPercent,
          commissionAmount: j.commissionAmount,
          commissionOrigin: j.commissionOrigin,
          commissionRuleId: (j as any).commissionRuleId,
          listeroCommissionAmount: (j as any).listeroCommissionAmount,
          multiplierId: (j as any).multiplierId,
        })),
      });
    }

    // NOTA: DailyNumberSalesService.incrementFromTicket fue desacoplado de la transacción interactiva
    // y se despacha post-commit de forma asíncrona para no retener conexiones ni bloquear filas.

    logger.info({
      layer: "repository",
      action: "TICKET_FOLIO_DIAG",
      payload: {
        createdAtUTC: new Date().toISOString(),
        scheduledAt: sorteo?.scheduledAt ? new Date(sorteo.scheduledAt).toISOString() : null,
        businessDateISO: businessDateInfo.businessDateISO,
        prefixYYMMDD: businessDateInfo.prefixYYMMDD,
        counter: seqForLog,
        ticketNumber,
        optimized: true,
      },
    });

    return {
      createdTicketId: createdTicket.id,
      jugadasWithCommissions,
      commissionsDetails,
      ticketNumber,
      warnings,
      seqForLog,
    };
  }
}
