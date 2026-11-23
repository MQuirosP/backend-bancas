import {
  ActivityType,
  BetType,
  Prisma,
  Role,
  SorteoStatus,
  TicketStatus,
} from "../../generated/prisma/client";
import ActivityService from "../../core/activity.service";
import { CacheService } from "../../core/cache.service";
import { AppError } from "../../core/errors";
import logger from "../../core/logger";
import prisma, { salesPrisma } from "../../core/prismaClient";
import { getBusinessDateCRInfo } from "../../utils/businessDate";
import { AccountStatementSyncService } from "../accounts/accounts.sync.service";
import { commissionResolver } from "../commission/CommissionResolver";
import { commissionService } from "../commission/CommissionService";
import { VendorCreditService } from "../credit/vendorCredit.service";
import { TicketNumberGenerator } from "../ticket/pipeline/TicketNumberGenerator";
import {
  PartnerCampaignDto,
  PartnerOrderResponseDto,
  PremiaticoClient,
} from "./premiatico.client";

export const PREMIATICO_PAYMENT_METHOD = "PREMIATICO_POS";
export const PREMIATICO_LOTERIA_NAME = "Premiático";

export interface CreatePremiaticoSaleInput {
  campaignId: string;
  comboId: string;
  customer: {
    name: string;
    phone: string;
    email?: string;
    idNumber?: string;
  };
  selectionMode: "RANDOM" | "MANUAL";
  selectedNumbers?: string[];
  includeInverse?: boolean;
  idempotencyKey?: string;
  vendedorId?: string;
}

export interface PremiaticoActor {
  id: string;
  role: Role;
  name?: string | null;
  bancaId?: string | null;
  ventanaId?: string | null;
}

export function isExternalCampaignLoteria(
  loteria: { rulesJson?: unknown } | null | undefined,
): boolean {
  if (!loteria?.rulesJson || typeof loteria.rulesJson !== "object") {
    return false;
  }
  return (loteria.rulesJson as Record<string, unknown>).isExternalCampaign === true;
}

function splitAmountEvenly(total: number, parts: number): number[] {
  if (parts <= 0) return [];
  if (parts === 1) return [Math.round(total * 100) / 100];

  const totalCents = Math.round(total * 100);
  const baseCents = Math.floor(totalCents / parts);
  const remainderCents = totalCents - baseCents * parts;

  return Array.from({ length: parts }, (_, idx) => {
    const cents = baseCents + (idx === 0 ? remainderCents : 0);
    return cents / 100;
  });
}

export class PremiaticoService {
  static async isPremiaticoEnabledForBanca(bancaId?: string | null): Promise<boolean> {
    if (!bancaId) return false;

    return CacheService.wrap(
      `premiatico:banca:${bancaId}:enabled`,
      async () => {
        const loteria = await prisma.loteria.findFirst({
          where: {
            bancaId,
            isActive: true,
            deletedAt: null,
            rulesJson: {
              path: ["isExternalCampaign"],
              equals: true,
            },
          },
          select: { id: true },
        });
        return Boolean(loteria);
      },
      60,
      [`premiatico:banca:${bancaId}`],
      true,
    );
  }

  static async isPremiaticoEnabledForUser(
    bancaId?: string | null,
    userSettings?: unknown,
  ): Promise<boolean> {
    if (!bancaId) return false;
    if (
      !userSettings ||
      typeof userSettings !== "object" ||
      (userSettings as Record<string, unknown>).premiaticoEnabled !== true
    ) {
      return false;
    }
    return this.isPremiaticoEnabledForBanca(bancaId);
  }

  static async getCampaigns(
    bancaId: string | null | undefined,
    userSettings?: unknown,
  ): Promise<PartnerCampaignDto[]> {
    const enabled = await this.isPremiaticoEnabledForUser(bancaId, userSettings);
    if (!enabled) {
      throw new AppError(
        "El módulo Premiático no está habilitado para este usuario o banca",
        403,
        "PREMIATICO_DISABLED",
      );
    }

    return CacheService.wrap(
      "premiatico:campaigns",
      () => PremiaticoClient.getCampaigns(),
      45,
      ["premiatico:campaigns"],
      true,
    );
  }

  private static async resolvePremiaticoLoteriaAndSorteo(
    bancaId: string,
    campaign: PartnerCampaignDto,
  ): Promise<{
    loteria: { id: string; name: string };
    sorteo: { id: string; name: string; scheduledAt: Date };
  }> {
    const loteria = await prisma.loteria.findFirst({
      where: {
        bancaId,
        isActive: true,
        deletedAt: null,
        rulesJson: {
          path: ["isExternalCampaign"],
          equals: true,
        },
      },
      select: { id: true, name: true },
    });

    if (!loteria) {
      throw new AppError(
        "La banca no tiene habilitada la lotería exclusiva de Premiático",
        403,
        "PREMIATICO_DISABLED",
      );
    }

    const scheduledAt = new Date(campaign.drawAt);
    if (Number.isNaN(scheduledAt.getTime())) {
      throw new AppError(
        "Fecha de sorteo inválida en la campaña de Premiático",
        502,
        "PREMIATICO_INVALID_CAMPAIGN",
      );
    }

    let sorteo = await prisma.sorteo.findUnique({
      where: {
        loteriaId_scheduledAt_bancaId: {
          loteriaId: loteria.id,
          scheduledAt,
          bancaId,
        },
      },
      select: {
        id: true,
        name: true,
        scheduledAt: true,
        deletedAt: true,
        status: true,
      },
    });

    if (!sorteo) {
      sorteo = await prisma.sorteo.create({
        data: {
          loteriaId: loteria.id,
          bancaId,
          name: campaign.title,
          scheduledAt,
          status: SorteoStatus.OPEN,
          isActive: true,
          digits: campaign.digits,
        },
        select: {
          id: true,
          name: true,
          scheduledAt: true,
          deletedAt: true,
          status: true,
        },
      });
    } else if (sorteo.deletedAt !== null || sorteo.status !== SorteoStatus.OPEN) {
      sorteo = await prisma.sorteo.update({
        where: { id: sorteo.id },
        data: {
          deletedAt: null,
          isActive: true,
          status: SorteoStatus.OPEN,
          name: campaign.title,
          digits: campaign.digits,
        },
        select: {
          id: true,
          name: true,
          scheduledAt: true,
          deletedAt: true,
          status: true,
        },
      });
    }

    return {
      loteria,
      sorteo: {
        id: sorteo.id,
        name: sorteo.name,
        scheduledAt: sorteo.scheduledAt,
      },
    };
  }

  static async createSale(input: CreatePremiaticoSaleInput, actor: PremiaticoActor) {
    const targetVendedorId =
      actor.role === Role.VENDEDOR ? actor.id : input.vendedorId || actor.id;

    const vendedor = await prisma.user.findUnique({
      where: { id: targetVendedorId },
      select: {
        id: true,
        name: true,
        role: true,
        isActive: true,
        deletedAt: true,
        ventanaId: true,
        bancaId: true,
        settings: true,
        commissionPolicyJson: true,
        ventana: {
          select: {
            id: true,
            name: true,
            code: true,
            bancaId: true,
            isActive: true,
            commissionPolicyJson: true,
            banca: {
              select: {
                id: true,
                name: true,
                code: true,
                isActive: true,
                commissionPolicyJson: true,
              },
            },
          },
        },
      },
    });

    if (!vendedor || !vendedor.isActive || vendedor.deletedAt !== null) {
      throw new AppError("Vendedor no encontrado o inactivo", 404, "VENDOR_NOT_FOUND");
    }

    if (!vendedor.ventana || !vendedor.ventana.isActive || !vendedor.ventana.banca?.isActive) {
      throw new AppError(
        "El vendedor no tiene una ventana o banca activa asignada",
        400,
        "VENTANA_INACTIVE",
      );
    }

    const bancaId = vendedor.ventana.bancaId;
    if (actor.bancaId && actor.role !== Role.ADMIN && actor.bancaId !== bancaId) {
      throw new AppError("Operación fuera de su banca", 403, "FORBIDDEN");
    }

    const enabled = await this.isPremiaticoEnabledForUser(bancaId, vendedor.settings);
    if (!enabled) {
      throw new AppError(
        "El módulo Premiático no está habilitado para este usuario o banca",
        403,
        "PREMIATICO_DISABLED",
      );
    }

    // Idempotency check in local DB
    if (input.idempotencyKey) {
      const existingTicket = await prisma.ticket.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        include: {
          jugadas: true,
          loteria: { select: { id: true, name: true } },
          sorteo: { select: { id: true, name: true, scheduledAt: true, status: true, loteriaId: true } },
          vendedor: { select: { id: true, name: true, code: true, settings: true } },
          ventana: { select: { id: true, name: true, code: true, bancaId: true } },
        },
      });

      if (existingTicket) {
        return {
          ticket: existingTicket,
          premiatico: (existingTicket.paymentHistory as any)?.premiatico ?? null,
          idempotentHit: true,
        };
      }
    }

    const campaigns = await this.getCampaigns(bancaId, vendedor.settings);
    const campaign = campaigns.find((c) => c.id === input.campaignId);
    if (!campaign) {
      throw new AppError(
        "Campaña de Premiático no encontrada o no disponible",
        404,
        "PREMIATICO_CAMPAIGN_NOT_FOUND",
      );
    }

    const combo = campaign.combos.find((c) => c.id === input.comboId);
    if (!combo) {
      throw new AppError(
        "Combo de Premiático no encontrado en la campaña",
        404,
        "PREMIATICO_COMBO_NOT_FOUND",
      );
    }

    const { loteria, sorteo } = await this.resolvePremiaticoLoteriaAndSorteo(
      bancaId,
      campaign,
    );

    // Calcular comisiones usando el motor existente de Bancas
    const packageCount =
      input.includeInverse && campaign.enableInverseNumbers ? 2 : 1;
    const totalAmount = Math.round(combo.price * packageCount * 100) / 100;
    const commissionContext = await commissionService.prepareContext(
      vendedor.id,
      vendedor.ventana.id,
      bancaId,
      vendedor.commissionPolicyJson,
      vendedor.ventana.commissionPolicyJson,
      vendedor.ventana.banca?.commissionPolicyJson,
    );

    const [preCalc] = commissionService.calculateCommissionsForJugadas(
      [
        {
          number: "0".repeat(campaign.digits),
          amount: totalAmount,
          finalMultiplierX: 0,
          type: BetType.NUMERO,
        },
      ],
      loteria.id,
      commissionContext,
    );

    const totalCommission = Math.round((preCalc?.commissionAmount ?? 0) * 100) / 100;

    let totalListeroCommission = 0;
    if (commissionContext.listeroPolicy) {
      const listeroMatch = commissionResolver.findMatchingRule(
        commissionContext.listeroPolicy,
        {
          loteriaId: loteria.id,
          betType: BetType.NUMERO,
          finalMultiplierX: 0,
          amount: totalAmount,
        },
      );
      if (listeroMatch && listeroMatch.percent > 0) {
        totalListeroCommission =
          Math.round(((totalAmount * listeroMatch.percent) / 100) * 100) / 100;
      }
    }

    const netAmount = Math.max(0, Math.round((totalAmount - totalCommission) * 100) / 100);

    // Reservar crédito del vendedor antes de confirmar orden remota
    await VendorCreditService.validateAndReserve(vendedor.id, sorteo.id, netAmount);

    let order: PartnerOrderResponseDto;
    const orderIdempotencyKey =
      input.idempotencyKey ||
      `pos:${bancaId}:${vendedor.id}:${campaign.id}:${combo.id}:${Date.now()}`;

    try {
      order = await PremiaticoClient.createOrder({
        campaignId: campaign.id,
        comboId: combo.id,
        customer: {
          fullName: input.customer.name,
          phone: input.customer.phone,
          ...(input.customer.email ? { email: input.customer.email } : {}),
        },
        selectionMode: input.selectionMode,
        selectedNumbers: input.selectedNumbers,
        includeInverse: input.includeInverse,
        idempotencyKey: orderIdempotencyKey,
        externalContext: {
          bancaId,
          ventanaId: vendedor.ventana.id,
          sellerId: vendedor.id,
          sellerName: vendedor.name,
        },
      });
    } catch (err) {
      await VendorCreditService.compensateReservation(
        vendedor.id,
        sorteo.id,
        netAmount,
      ).catch((compErr) => {
        logger.error({
          layer: "service",
          action: "PREMIATICO_COMPENSATE_CREDIT_FAIL",
          payload: { vendedorId: vendedor.id, sorteoId: sorteo.id, error: compErr?.message },
        });
      });
      throw err;
    }

    const businessDateInfo = getBusinessDateCRInfo({
      scheduledAt: null,
      nowUtc: new Date(),
      cutoffHour: "00:00",
    });
    const numbers = order.numbers.length > 0 ? order.numbers : ["0".repeat(campaign.digits)];
    const amountParts = splitAmountEvenly(totalAmount, numbers.length);
    const commissionParts = splitAmountEvenly(totalCommission, numbers.length);
    const listeroParts = splitAmountEvenly(totalListeroCommission, numbers.length);

    const premiaticoMeta = {
      orderId: order.orderId,
      publicReference: order.publicReference,
      accessToken: order.accessToken,
      trackingUrl: order.trackingUrl,
      campaignId: campaign.id,
      campaignTitle: campaign.title,
      drawAt: campaign.drawAt,
      digits: campaign.digits,
      comboId: combo.id,
      comboName: combo.name,
      numbers: order.numbers,
      confirmedAt: order.confirmedAt,
    };

    try {
      const createdTicket = await salesPrisma.$transaction(
        async (tx) => {
          const { ticketNumber } = await TicketNumberGenerator.generate(
            tx,
            businessDateInfo.businessDateISO,
          );

          return tx.ticket.create({
            data: {
              ticketNumber,
              loteriaId: loteria.id,
              sorteoId: sorteo.id,
              ventanaId: vendedor.ventana!.id,
              vendedorId: vendedor.id,
              bancaId,
              totalAmount,
              totalCommission,
              totalListeroCommission,
              status: TicketStatus.ACTIVE,
              isActive: true,
              paymentMethod: PREMIATICO_PAYMENT_METHOD,
              paymentNotes: order.publicReference,
              paymentHistory: {
                premiatico: premiaticoMeta,
              } as Prisma.InputJsonValue,
              clienteNombre: input.customer.name,
              businessDate: businessDateInfo.businessDate,
              createdBy: actor.id,
              createdByRole: actor.role,
              idempotencyKey: input.idempotencyKey ?? null,
              jugadas: {
                create: numbers.map((num, index) => ({
                  number: num,
                  amount: amountParts[index] ?? 0,
                  finalMultiplierX: 0,
                  multiplierId: null,
                  type: BetType.NUMERO,
                  commissionPercent: preCalc?.commissionPercent ?? 0,
                  commissionAmount: commissionParts[index] ?? 0,
                  commissionOrigin: preCalc?.commissionOrigin ?? null,
                  commissionRuleId: preCalc?.commissionRuleId ?? null,
                  listeroCommissionAmount: listeroParts[index] ?? 0,
                  bancaId,
                })),
              },
            },
            include: {
              jugadas: true,
              loteria: { select: { id: true, name: true } },
              sorteo: { select: { id: true, name: true, scheduledAt: true, status: true, loteriaId: true } },
              vendedor: { select: { id: true, name: true, code: true, settings: true } },
              ventana: { select: { id: true, name: true, code: true, bancaId: true } },
            },
          });
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
          maxWait: 5_000,
          timeout: 15_000,
        },
      );

      // Side-effects post-commit (no bloqueantes)
      CacheService.invalidateTag("premiatico:campaigns").catch(() => {});
      CacheService.invalidateTag(`vendedor:${vendedor.id}`).catch(() => {});
      CacheService.invalidateTag(`user:${vendedor.id}`).catch(() => {});

      const statementSyncTasks: Promise<void>[] = [
        AccountStatementSyncService.syncDayStatement(
          businessDateInfo.businessDate,
          "vendedor",
          vendedor.id,
          { force: true },
        ),
        AccountStatementSyncService.syncDayStatement(
          businessDateInfo.businessDate,
          "banca",
          bancaId,
          { force: true },
        ),
      ];
      if (vendedor.ventanaId) {
        statementSyncTasks.push(
          AccountStatementSyncService.syncDayStatement(
            businessDateInfo.businessDate,
            "ventana",
            vendedor.ventanaId,
            { force: true },
          ),
        );
      }

      Promise.all(statementSyncTasks).catch((err) => {
        logger.warn({
          layer: "service",
          action: "PREMIATICO_STATEMENT_SYNC_WARN",
          payload: { vendedorId: vendedor.id, ventanaId: vendedor.ventanaId, bancaId, error: err?.message },
        });
      });

      ActivityService.log({
        userId: actor.id,
        bancaId,
        action: ActivityType.TICKET_CREATE,
        targetType: "TICKET",
        targetId: createdTicket.id,
        details: {
          ticketNumber: createdTicket.ticketNumber,
          totalAmount,
          paymentMethod: PREMIATICO_PAYMENT_METHOD,
          publicReference: order.publicReference,
          campaignId: campaign.id,
          description: `Venta Premiático #${order.publicReference} -> Ticket #${createdTicket.ticketNumber} (₡${totalAmount.toLocaleString()})`,
        },
        layer: "service",
      }).catch(() => {});

      return {
        ticket: createdTicket,
        premiatico: premiaticoMeta,
        idempotentHit: false,
      };
    } catch (persistErr) {
      // Compensar orden remota y crédito si falla el guardado local en DB
      await PremiaticoClient.cancelOrder(order.publicReference, {
        reason: "Rollback por fallo de persistencia local en Bancas",
        cancelledById: actor.id,
      }).catch((cancelErr) => {
        logger.error({
          layer: "service",
          action: "PREMIATICO_ROLLBACK_CANCEL_FAIL",
          payload: {
            publicReference: order.publicReference,
            error: cancelErr?.message,
          },
        });
      });

      await VendorCreditService.compensateReservation(
        vendedor.id,
        sorteo.id,
        netAmount,
      ).catch(() => {});

      throw persistErr;
    }
  }

  static async updateBancaConfig(
    bancaId: string,
    enabled: boolean,
    actorId: string,
  ): Promise<{ bancaId: string; enabled: boolean; loteriaId: string | null }> {
    const banca = await prisma.banca.findFirst({
      where: { id: bancaId, deletedAt: null },
      select: { id: true, name: true },
    });

    if (!banca) {
      throw new AppError("Banca no encontrada", 404, "NOT_FOUND");
    }

    const existingLoteria = await prisma.loteria.findFirst({
      where: {
        bancaId,
        OR: [
          {
            rulesJson: {
              path: ["isExternalCampaign"],
              equals: true,
            },
          },
          { name: PREMIATICO_LOTERIA_NAME },
        ],
      },
      select: { id: true, rulesJson: true },
    });

    let loteriaId: string | null = existingLoteria?.id ?? null;

    if (enabled) {
      const mergedRules = {
        ...((existingLoteria?.rulesJson && typeof existingLoteria.rulesJson === "object"
          ? existingLoteria.rulesJson
          : {}) as Record<string, unknown>),
        isExternalCampaign: true,
      };

      if (existingLoteria) {
        await prisma.loteria.update({
          where: { id: existingLoteria.id },
          data: {
            isActive: true,
            deletedAt: null,
            rulesJson: mergedRules as Prisma.InputJsonValue,
          },
        });
      } else {
        const created = await prisma.loteria.create({
          data: {
            name: PREMIATICO_LOTERIA_NAME,
            bancaId,
            isActive: true,
            rulesJson: mergedRules as Prisma.InputJsonValue,
          },
          select: { id: true },
        });
        loteriaId = created.id;
      }
    } else if (existingLoteria) {
      await prisma.loteria.update({
        where: { id: existingLoteria.id },
        data: { isActive: false },
      });
    }

    await CacheService.invalidateTag(`premiatico:banca:${bancaId}`).catch(() => {});

    ActivityService.log({
      userId: actorId,
      bancaId,
      action: ActivityType.USER_UPDATE,
      targetType: "BANCA",
      targetId: bancaId,
      details: {
        premiaticoEnabled: enabled,
        loteriaId,
        description: `Premiático ${enabled ? "habilitado" : "deshabilitado"} para banca ${banca.name}`,
      },
      layer: "service",
    }).catch(() => {});

    return { bancaId, enabled, loteriaId };
  }

  static async updateUserConfig(
    targetUserId: string,
    enabled: boolean,
    actorId: string,
    actorRole: Role,
    actorBancaId?: string | null,
  ): Promise<{ userId: string; premiaticoEnabled: boolean }> {
    const user = await prisma.user.findFirst({
      where: { id: targetUserId, deletedAt: null },
      select: {
        id: true,
        name: true,
        bancaId: true,
        settings: true,
        ventana: { select: { bancaId: true } },
      },
    });

    if (!user) {
      throw new AppError("Usuario no encontrado", 404, "NOT_FOUND");
    }

    const userBancaId = user.bancaId ?? user.ventana?.bancaId ?? null;
    if (actorRole !== Role.ADMIN && actorBancaId && userBancaId !== actorBancaId) {
      throw new AppError(
        "No tienes permisos para configurar un usuario de otra banca",
        403,
        "FORBIDDEN",
      );
    }

    const currentSettings =
      user.settings && typeof user.settings === "object"
        ? (user.settings as Record<string, unknown>)
        : {};

    await prisma.user.update({
      where: { id: targetUserId },
      data: {
        settings: {
          ...currentSettings,
          premiaticoEnabled: enabled,
        } as Prisma.InputJsonValue,
      },
    });

    await CacheService.invalidateTag(`user:${targetUserId}`).catch(() => {});

    ActivityService.log({
      userId: actorId,
      bancaId: userBancaId,
      action: ActivityType.USER_UPDATE,
      targetType: "USER",
      targetId: targetUserId,
      details: {
        premiaticoEnabled: enabled,
        description: `Premiático ${enabled ? "habilitado" : "deshabilitado"} para usuario ${user.name}`,
      },
      layer: "service",
    }).catch(() => {});

    return { userId: targetUserId, premiaticoEnabled: enabled };
  }
}
