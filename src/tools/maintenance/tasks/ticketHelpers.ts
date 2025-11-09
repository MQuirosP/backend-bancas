import prisma from "../../../core/prismaClient";
import { Ticket } from "@prisma/client";

export const BATCH_SIZE = 100;

export function buildTicketWhere(from: Date, to: Date, ventanaId?: string) {
  return {
    deletedAt: null,
    ...(ventanaId ? { ventanaId } : {}),
    OR: [
      {
        businessDate: {
          gte: from,
          lte: to,
        },
      },
      {
        AND: [
          { businessDate: null },
          {
            createdAt: {
              gte: from,
              lte: to,
            },
          },
        ],
      },
    ],
  };
}

export async function fetchTicketBatch(params: {
  cursor?: string;
  from: Date;
  to: Date;
  ventanaId?: string;
}) {
  const { cursor, from, to, ventanaId } = params;

  const tickets = await prisma.ticket.findMany({
    where: buildTicketWhere(from, to, ventanaId),
    select: {
      id: true,
      loteriaId: true,
      ventanaId: true,
      vendedorId: true,
      ventana: {
        select: {
          bancaId: true,
          commissionPolicyJson: true,
          banca: {
            select: {
              commissionPolicyJson: true,
            },
          },
        },
      },
      vendedor: {
        select: {
          commissionPolicyJson: true,
        },
      },
      jugadas: {
        select: {
          id: true,
          amount: true,
          type: true,
          finalMultiplierX: true,
          multiplierId: true,
          commissionAmount: true,
          commissionPercent: true,
          commissionOrigin: true,
          commissionRuleId: true,
        },
      },
    },
    orderBy: { id: "asc" },
    take: BATCH_SIZE,
    ...(cursor
      ? {
          skip: 1,
          cursor: { id: cursor },
        }
      : {}),
  });

  return tickets;
}

