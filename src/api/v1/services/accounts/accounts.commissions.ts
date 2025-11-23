import { Prisma, Role } from "@prisma/client";
import prisma from "../../../../core/prismaClient";
import { resolveCommission } from "../../../../services/commission.resolver";
import { resolveCommissionFromPolicy } from "../../../../services/commission/commission.resolver";

/**
 * Helper: Calcula si un estado de cuenta está saldado
 * CRÍTICO: Solo está saldado si hay tickets Y el saldo es cero Y hay pagos/cobros registrados
 */
export function calculateIsSettled(
    ticketCount: number,
    remainingBalance: number,
    totalPaid: number,
    totalCollected: number
): boolean {
    const hasPayments = totalPaid > 0 || totalCollected > 0;
    return ticketCount > 0
        && Math.abs(remainingBalance) < 0.01
        && hasPayments;
}

export async function computeListeroCommissionsForWhere(
    ticketWhere: Prisma.TicketWhereInput
): Promise<Map<string, number>> {
    const result = new Map<string, number>();

    const jugadas = await prisma.jugada.findMany({
        where: {
            ticket: ticketWhere,
            deletedAt: null,
        },
        select: {
            amount: true,
            type: true,
            finalMultiplierX: true,
            ticket: {
                select: {
                    loteriaId: true,
                    ventanaId: true,
                    ventana: {
                        select: {
                            commissionPolicyJson: true,
                            banca: {
                                select: {
                                    commissionPolicyJson: true,
                                },
                            },
                        },
                    },
                },
            },
        },
    });

    if (jugadas.length === 0) {
        return result;
    }

    const ventanaIds = Array.from(
        new Set(
            jugadas
                .map((j) => j.ticket.ventanaId)
                .filter((id): id is string => typeof id === "string")
        )
    );

    const ventanasWithBancas = ventanaIds.length
        ? await prisma.ventana.findMany({
            where: { id: { in: ventanaIds } },
            select: {
                id: true,
                commissionPolicyJson: true,
                banca: {
                    select: { commissionPolicyJson: true },
                },
            },
        })
        : [];

    const ventanaUsers = ventanaIds.length
        ? await prisma.user.findMany({
            where: {
                role: Role.VENTANA,
                isActive: true,
                deletedAt: null,
                ventanaId: { in: ventanaIds },
            },
            select: {
                id: true,
                ventanaId: true,
                commissionPolicyJson: true,
                updatedAt: true,
            },
            orderBy: { updatedAt: "desc" },
        })
        : [];

    const policiesMap = new Map<
        string,
        {
            userPolicy: any;
            ventanaPolicy: any;
            bancaPolicy: any;
            ventanaUserId: string | null;
        }
    >();

    ventanasWithBancas.forEach((ventana) => {
        policiesMap.set(ventana.id, {
            userPolicy: null,
            ventanaPolicy: ventana.commissionPolicyJson as any,
            bancaPolicy: ventana.banca?.commissionPolicyJson as any,
            ventanaUserId: null,
        });
    });

    ventanaUsers.forEach((user) => {
        if (!user.ventanaId) return;
        const existing =
            policiesMap.get(user.ventanaId) || {
                userPolicy: null,
                ventanaPolicy: null,
                bancaPolicy: null,
                ventanaUserId: null,
            };
        if (!existing.userPolicy) {
            existing.userPolicy = user.commissionPolicyJson as any;
            existing.ventanaUserId = user.id;
        }
        policiesMap.set(user.ventanaId, existing);
    });

    for (const jugada of jugadas) {
        const ventanaId = jugada.ticket.ventanaId;
        if (!ventanaId) continue;

        const policies = policiesMap.get(ventanaId) || {
            userPolicy: null,
            ventanaPolicy: null,
            bancaPolicy: null,
            ventanaUserId: null,
        };

        const ventanaPolicy =
            (jugada.ticket.ventana?.commissionPolicyJson as any) ?? policies.ventanaPolicy;
        const bancaPolicy =
            (jugada.ticket.ventana?.banca?.commissionPolicyJson as any) ?? policies.bancaPolicy;
        const userPolicy = policies.userPolicy;
        const ventanaUserId = policies.ventanaUserId ?? ventanaId;

        // Actualizar cache en caso de que obtengamos políticas desde el ticket
        policiesMap.set(ventanaId, {
            userPolicy,
            ventanaPolicy,
            bancaPolicy,
            ventanaUserId,
        });

        let commissionAmount = 0;

        if (userPolicy) {
            try {
                const resolution = resolveCommissionFromPolicy(userPolicy as any, {
                    userId: ventanaUserId ?? ventanaId,
                    loteriaId: jugada.ticket.loteriaId,
                    betType: jugada.type as "NUMERO" | "REVENTADO",
                    finalMultiplierX: jugada.finalMultiplierX ?? null,
                });
                commissionAmount = parseFloat(((jugada.amount * resolution.percent) / 100).toFixed(2));
            } catch {
                const fallback = resolveCommission(
                    {
                        loteriaId: jugada.ticket.loteriaId,
                        betType: jugada.type as "NUMERO" | "REVENTADO",
                        finalMultiplierX: jugada.finalMultiplierX || 0,
                        amount: jugada.amount,
                    },
                    null,
                    ventanaPolicy,
                    bancaPolicy
                );
                commissionAmount = parseFloat((fallback.commissionAmount || 0).toFixed(2));
            }
        } else {
            const fallback = resolveCommission(
                {
                    loteriaId: jugada.ticket.loteriaId,
                    betType: jugada.type as "NUMERO" | "REVENTADO",
                    finalMultiplierX: jugada.finalMultiplierX || 0,
                    amount: jugada.amount,
                },
                null,
                ventanaPolicy,
                bancaPolicy
            );
            commissionAmount = parseFloat((fallback.commissionAmount || 0).toFixed(2));
        }

        if (commissionAmount <= 0) continue;

        result.set(ventanaId, (result.get(ventanaId) || 0) + commissionAmount);
    }

    return result;
}

/**
 * Calcula comisiones para un ticket
 * Nota: Las comisiones ya están guardadas en Jugada (commissionAmount, commissionOrigin)
 * Para el estado de cuenta, separamos comisiones de listero y vendedor
 * 
 * Lógica:
 * - Si dimension='ventana': La comisión guardada en Jugada es del listero (ventana)
 * - Si dimension='vendedor': La comisión guardada en Jugada es del vendedor
 *   - Para calcular la comisión del listero, necesitamos obtener la política de la ventana
 *   - La comisión del listero = comisión de la ventana - comisión del vendedor
 */
export async function calculateCommissionsForTicket(
    ticket: any,
    dimension: "ventana" | "vendedor"
): Promise<{ listeroCommission: number; vendedorCommission: number }> {
    const jugadas = ticket.jugadas || [];
    let listeroCommission = 0;
    let vendedorCommission = 0;

    if (dimension === "ventana") {
        // Si es ventana, toda la comisión guardada es del listero
        for (const jugada of jugadas) {
            const commissionAmount = jugada.commissionAmount || 0;
            listeroCommission += commissionAmount;
        }
        vendedorCommission = 0; // No hay comisión de vendedor en este caso
    } else {
        // Si es vendedor, obtener la ventana UNA VEZ por ticket (no por jugada)
        let ventanaPolicy: any = null;
        let bancaPolicy: any = null;

        if (ticket.ventanaId) {
            const ventana = await prisma.ventana.findUnique({
                where: { id: ticket.ventanaId },
                select: {
                    commissionPolicyJson: true,
                    banca: {
                        select: {
                            commissionPolicyJson: true,
                        },
                    },
                },
            });
            ventanaPolicy = ventana?.commissionPolicyJson as any;
            bancaPolicy = ventana?.banca?.commissionPolicyJson as any;
        }

        // Calcular comisiones para todas las jugadas del ticket
        for (const jugada of jugadas) {
            // La comisión guardada es del vendedor
            const commissionAmount = jugada.commissionAmount || 0;
            vendedorCommission += commissionAmount;

            // Calcular comisión de la ventana usando la jerarquía VENTANA → BANCA
            // Nota: Pasamos null para userPolicy para que use solo VENTANA → BANCA
            const res = resolveCommission(
                {
                    loteriaId: ticket.loteriaId,
                    betType: jugada.type as "NUMERO" | "REVENTADO",
                    finalMultiplierX: jugada.finalMultiplierX || 0,
                    amount: jugada.amount,
                },
                null, // No usar política del vendedor para calcular comisión del listero
                ventanaPolicy, // Usar política de la ventana (obtenida una vez por ticket)
                bancaPolicy // Usar política de la banca como fallback (obtenida una vez por ticket)
            );

            const ventanaCommissionAmount = res.commissionAmount;

            // La comisión del listero es la diferencia entre la de la ventana y la del vendedor
            // Si la comisión del vendedor es mayor o igual a la de la ventana, el listero no recibe comisión
            listeroCommission += Math.max(0, ventanaCommissionAmount - commissionAmount);
        }
    }

    return { listeroCommission, vendedorCommission };
}
