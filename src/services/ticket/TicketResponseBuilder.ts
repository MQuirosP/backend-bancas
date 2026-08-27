import logger from "../../core/logger";
import { CreateTicketInput, CreateTicketOptions } from "./ticket.types";

export class TicketResponseBuilder {
  /**
   * Construye el objeto de ticket formateado para la respuesta del cliente fuera de la transacción.
   */
  static build(
    txResult: any,
    data: CreateTicketInput,
    userId: string,
    options?: CreateTicketOptions
  ): any {
    const {
      createdTicketId,
      ticketNumber,
      businessDateInfo,
      jugadasWithCommissions,
    } = txResult;

    const clienteNombre = data.clienteNombre;
    const totalAmount = data.jugadas.reduce((sum: number, j: any) => sum + j.amount, 0);
    const totalCommission = jugadasWithCommissions.reduce(
      (sum: number, j: any) => sum + (j.commissionAmount || 0),
      0
    );
    const totalListeroCommission = jugadasWithCommissions.reduce(
      (sum: number, j: any) => sum + (j.listeroCommissionAmount || 0),
      0
    );

    const ticket: any = {
      id: createdTicketId,
      ticketNumber: ticketNumber,
      businessDate: businessDateInfo.businessDate,
      loteriaId: data.loteriaId,
      sorteoId: data.sorteoId,
      ventanaId: data.ventanaId,
      vendedorId: userId,
      totalAmount,
      totalCommission,
      totalListeroCommission,
      status: "ACTIVE",
      isActive: true,
      clienteNombre: clienteNombre?.trim() || "CLIENTE CONTADO",
      createdBy: options?.createdBy ?? null,
      createdByRole: options?.createdByRole ?? null,
      idempotencyKey: options?.idempotencyKey ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
      loteria: options?.preFetched?.loteria || null,
      sorteo: options?.preFetched?.sorteo || null,
      ventana: options?.preFetched?.ventana || null,
      vendedor: options?.preFetched?.vendedor || null,
      jugadas: jugadasWithCommissions.map((j: any, idx: number) => ({
        id: `temp-${createdTicketId}-${idx}`,
        ticketId: createdTicketId,
        type: j.type,
        number: j.number,
        reventadoNumber: j.reventadoNumber,
        amount: j.amount,
        finalMultiplierX: j.finalMultiplierX,
        commissionPercent: j.commissionPercent,
        commissionAmount: j.commissionAmount,
        commissionOrigin: j.commissionOrigin,
        commissionRuleId: j.commissionRuleId,
        listeroCommissionAmount: j.listeroCommissionAmount,
        multiplierId: j.multiplierId,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      })),
    };

    logger.info({
      layer: "repository",
      action: "TICKET_CREATE_OPTIMIZED_SUCCESS",
      payload: {
        ticketId: ticket.id,
        ticketNumber: ticket.ticketNumber,
        totalAmount: ticket.totalAmount,
        jugadas: data.jugadas.length,
      },
    });

    return ticket;
  }
}
