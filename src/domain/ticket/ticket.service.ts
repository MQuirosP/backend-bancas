/**
 * Ticket Service (Facade)
 * 
 * Actúa como fachada liviana preservando el 100% de los contratos públicos,
 * firmas de métodos, tipos e interfaces, delegando la ejecución a servicios especializados:
 * - TicketCreationService: Validación, prefetch, cálculo de riesgo y pipeline de venta
 * - TicketPayoutService: Gestión de pagos totales/parciales, reversiones y trazabilidad
 * - TicketNumbersSummaryService: Consultas de números jugados, agregaciones por sorteo y batch PNG
 * - TicketThermalRenderService: Renderizado térmico a imagen PNG vía worker threads y caché L1/Redis
 * - TicketWinnerQueryService: Búsqueda de jugadas por ticket number y opciones de filtros
 * - TicketOperationsService: Operaciones CRUD (getById, list, cancel, restore, balances, etc.)
 */

import { Role } from "../../generated/prisma/client";
import {
  RegisterPaymentInput,
  NumbersSummaryParams,
  FilterOptionsParams,
  FilterOptionsContext,
  NumbersSummaryFilterOptionsParams,
} from "./types/ticket.types";
import { TicketCreationService } from "./creation/ticket-creation.service";
import { TicketPayoutService } from "./payout/ticket-payout.service";
import { TicketThermalRenderService } from "./render/ticket-thermal-render.service";
import { TicketWinnerQueryService } from "./winners/ticket-winner-query.service";
import { TicketNumbersSummaryService } from "./summary/ticket-numbers-summary.service";
import { TicketOperationsService } from "./ops/ticket-operations.service";
import { buildTicketFilterClause } from "./helpers/ticket-filter.helper";

// Re-exportar tipos, interfaces y helpers para 100% retrocompatibilidad
export * from "./types/ticket.types";
export { buildTicketFilterClause };

export const TicketService = {
  /**
   * Crea un nuevo ticket ejecutando el pipeline de validación, riesgo, comisión y persistencia
   */
  async create(
    data: any,
    userId: string,
    requestId?: string,
    actorRole: Role = Role.VENDEDOR,
    userVentanaId?: string | null,
  ) {
    return TicketCreationService.create(data, userId, requestId, actorRole, userVentanaId);
  },

  /**
   * Obtiene un ticket por su ID con relaciones y configuraciones de impresión enriquecidas
   */
  async getById(id: string, bancaId?: string) {
    return TicketOperationsService.getById(id, bancaId);
  },

  /**
   * Lista tickets paginados con filtros
   */
  async list(
    page = 1,
    pageSize = 10,
    filters: any = {},
  ) {
    return TicketOperationsService.list(page, pageSize, filters);
  },

  /**
   * Cancela un ticket validando el cutoff de sorteo
   */
  async cancel(
    id: string,
    userId: string,
    requestId?: string,
    bancaId?: string,
  ) {
    return TicketOperationsService.cancel(id, userId, requestId, bancaId);
  },

  /**
   * Incrementa el conteo de reimpresiones de un ticket
   */
  async incrementPrintCount(id: string, userId: string, requestId?: string) {
    return TicketOperationsService.incrementPrintCount(id, userId, requestId);
  },

  /**
   * Restaura un ticket cancelado
   */
  async restore(
    id: string,
    userId: string,
    requestId?: string,
    bancaId?: string,
  ) {
    return TicketOperationsService.restore(id, userId, requestId, bancaId);
  },

  /**
   * Registrar un pago (total o parcial) en un ticket ganador
   */
  async registerPayment(
    ticketId: string,
    data: RegisterPaymentInput,
    userId: string,
    requestId?: string,
  ) {
    return TicketPayoutService.registerPayment(ticketId, data, userId, requestId);
  },

  /**
   * Revertir el último pago de un ticket
   */
  async reversePayment(
    ticketId: string,
    userId: string,
    reason?: string,
    requestId?: string,
  ) {
    return TicketPayoutService.reversePayment(ticketId, userId, reason, requestId);
  },

  /**
   * Marcar un pago parcial como final (acepta deuda restante)
   */
  async finalizePayment(
    ticketId: string,
    userId: string,
    notes?: string,
    requestId?: string,
  ) {
    return TicketPayoutService.finalizePayment(ticketId, userId, notes, requestId);
  },

  /**
   * Obtiene resumen de números dinámicamente con montos por tipo
   */
  async numbersSummary(
    params: NumbersSummaryParams,
    role: string,
    userId: string,
  ) {
    return TicketNumbersSummaryService.numbersSummary(params, role, userId);
  },

  /**
   * Resuelve los multiplicadores a usar en el batch
   */
  async resolveMultipliersForBatch(params: {
    loteriaId?: string | null;
    sorteoId?: string | null;
    multiplierIds?: string[];
  }) {
    return TicketNumbersSummaryService.resolveMultipliersForBatch(params);
  },

  /**
   * Batch numbers summary por multiplicador
   */
  async numbersSummaryBatch(
    params: any,
    role: string,
    userId: string,
    format: "pdf" | "png" = "png",
  ) {
    return TicketNumbersSummaryService.numbersSummaryBatch(params, role, userId, format);
  },

  /**
   * Obtiene las jugadas de un ticket existente mediante su número de ticket
   */
  async getByTicketNumber(ticketNumber: string) {
    return TicketWinnerQueryService.getByTicketNumber(ticketNumber);
  },

  /**
   * Obtiene las opciones disponibles para los filtros de tickets
   */
  async getFilterOptions(
    params: FilterOptionsParams,
    context: FilterOptionsContext,
  ) {
    return TicketWinnerQueryService.getFilterOptions(params, context);
  },

  /**
   * Obtiene las opciones disponibles para los filtros de numbers-summary
   */
  async getNumbersSummaryFilterOptions(
    params: NumbersSummaryFilterOptionsParams,
    context: FilterOptionsContext,
  ) {
    return TicketNumbersSummaryService.getNumbersSummaryFilterOptions(params, context);
  },

  /**
   * Obtiene la imagen del ticket como blob PNG térmico
   */
  async getTicketImage(
    id: string,
    userId: string,
    role: Role,
    requestId?: string,
  ): Promise<Buffer> {
    return TicketThermalRenderService.getTicketImage(id, userId, role, requestId);
  },

  /**
   * Busca un ticket por su llave de idempotencia (usado para recuperación)
   */
  async getByIdempotencyKey(key: string) {
    return TicketOperationsService.getByIdempotencyKey(key);
  },

  /**
   * Obtiene los saldos disponibles para todos los números de un sorteo
   */
  async getBalances(
    sorteoId: string,
    vendedorId: string,
    bancaId?: string,
    actorRole?: Role,
  ) {
    return TicketOperationsService.getBalances(sorteoId, vendedorId, bancaId, actorRole);
  },
};

export default TicketService;
