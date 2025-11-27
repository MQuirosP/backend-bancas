import { Prisma, Role } from "@prisma/client";
import prisma from "../../../../core/prismaClient";
import logger from "../../../../core/logger";
import { AppError } from "../../../../core/errors";
import { AccountStatementRepository } from "../../../../repositories/accountStatement.repository";
import { AccountPaymentRepository } from "../../../../repositories/accountPayment.repository";
import { calculateIsSettled } from "./accounts.commissions";
import { buildTicketDateFilter, toCRDateString } from "./accounts.dates.utils";
import { AccountsFilters, DayStatement } from "./accounts.types";
import { resolveCommissionFromPolicy } from "../../../../services/commission/commission.resolver";
import { resolveCommission } from "../../../../services/commission.resolver";
import { getSorteoBreakdownBatch } from "./accounts.queries";

/**
 * Calcula y actualiza el estado de cuenta para un día específico
 */
export async function calculateDayStatement(
    date: Date,
    month: string,
    dimension: "ventana" | "vendedor",
    ventanaId?: string,
    vendedorId?: string,
    bancaId?: string,
    userRole?: "ADMIN" | "VENTANA" | "VENDEDOR" // ✅ CRÍTICO: Rol del usuario para calcular balance correctamente
): Promise<DayStatement> {
    // Construir WHERE clause
    // FIX: Usar businessDate en lugar de createdAt para agrupar correctamente por día de negocio
    const dateFilter = buildTicketDateFilter(date);
    const where: any = {
        ...dateFilter,
        deletedAt: null,
        status: { not: "CANCELLED" },
    };

    // Filtrar por banca activa (para ADMIN multibanca)
    if (bancaId) {
        where.ventana = {
            bancaId: bancaId,
        };
    }

    // FIX: Validación defensiva - asegurar que ventanaId coincide en dimensión "ventana"
    if (dimension === "ventana" && ventanaId) {
        where.ventanaId = ventanaId;
    } else if (dimension === "vendedor" && vendedorId) {
        where.vendedorId = vendedorId;
    }

    // Usar agregaciones de Prisma para calcular totales directamente en la base de datos
    // Esto es mucho más eficiente que traer todos los tickets y jugadas a memoria
    const [ticketAgg, jugadaAggVendor, jugadaAggListero, jugadaAggWinners] = await Promise.all([
        // Agregaciones de tickets
        prisma.ticket.aggregate({
            where,
            _sum: {
                totalAmount: true,
            },
            _count: {
                id: true,
            },
        }),
        // Agregaciones de jugadas - TODAS las jugadas para comisiones
        // IMPORTANTE: Para comisiones, incluir TODAS las jugadas (no solo ganadoras)
        // Las comisiones se aplican a todas las jugadas, no solo a las ganadoras
        prisma.jugada.aggregate({
            where: {
                ticket: where,
                deletedAt: null,
                commissionOrigin: "USER",
            },
            _sum: {
                commissionAmount: true,
            },
        }),
        // ✅ NUEVO: Agregación de comisiones del listero desde snapshot
        // Nota: Si la columna no existe aún (migración pendiente), usar fallback desde commissionOrigin
        prisma.jugada.aggregate({
            where: {
                ticket: where,
                deletedAt: null,
            },
            _sum: {
                listeroCommissionAmount: true, // ✅ Usar snapshot en lugar de calcular desde políticas
            },
        }).catch((error: any) => {
            // Fallback si la columna no existe aún (migración pendiente)
            if (error?.message?.includes('listeroCommissionAmount')) {
                return { _sum: { listeroCommissionAmount: null } };
            }
            throw error;
        }),
        // Agregaciones de jugadas - Solo jugadas ganadoras para payouts
        prisma.jugada.aggregate({
            where: {
                ticket: where,
                deletedAt: null,
                isWinner: true, // Solo jugadas ganadoras para payouts
            },
            _sum: {
                payout: true, // Total de premios (payout de jugadas ganadoras)
            },
        }),
    ]);

    // Calcular totales básicos desde agregaciones
    const totalSales = ticketAgg._sum.totalAmount || 0;
    // CRÍTICO: totalPayouts debe ser la suma de payout de jugadas ganadoras, no totalPaid de tickets
    // totalPaid de tickets es lo que se ha pagado, pero totalPayouts debe ser el total de premios ganados
    const totalPayouts = jugadaAggWinners._sum.payout || 0;
    const ticketCount = ticketAgg._count.id || 0;
    // FIX: Solo sumar comisiones del vendedor (commissionOrigin === "USER")
    const totalVendedorCommission = jugadaAggVendor._sum.commissionAmount || 0;

    // ✅ NUEVO: Usar snapshot de comisión del listero en lugar de calcular desde políticas
    // Esto es mucho más rápido y preciso
    // Fallback: Si el snapshot es 0 (tickets creados antes de los cambios), calcular desde commissionOrigin
    let totalListeroCommission = jugadaAggListero?._sum?.listeroCommissionAmount || 0;

    // Si el snapshot es 0, puede ser porque:
    // 1. Realmente no hay comisión del listero
    // 2. Los tickets fueron creados antes de los cambios (tienen listeroCommissionAmount: 0 por defecto)
    // En el caso 2, necesitamos calcular desde commissionOrigin como fallback
    if (totalListeroCommission === 0) {
        // Verificar si hay tickets con commissionOrigin VENTANA/BANCA que no tienen snapshot
        // Esto indica que fueron creados antes de los cambios
        // Buscar jugadas con commissionOrigin VENTANA/BANCA que tienen listeroCommissionAmount = 0
        // Esto indica tickets creados antes de los cambios (tienen 0 por defecto)
        const jugadasFallback = await prisma.jugada.findMany({
            where: {
                ticket: where,
                deletedAt: null,
                commissionOrigin: { in: ["VENTANA", "BANCA"] },
                listeroCommissionAmount: 0, // Tickets antiguos tienen 0 por defecto
            },
            select: {
                commissionAmount: true,
                listeroCommissionAmount: true,
            },
        });
        const fallbackTotal = jugadasFallback.reduce((sum, j) => sum + (j.commissionAmount || 0), 0);
        if (fallbackTotal > 0) {
            totalListeroCommission = fallbackTotal;
            logger.warn({
                layer: 'service',
                action: 'LISTERO_COMMISSION_FALLBACK_FROM_ORIGIN',
                payload: {
                    fallbackTotal,
                    jugadasCount: jugadasFallback.length,
                    note: 'Using commissionOrigin as fallback for old tickets',
                },
            });
        }
    }

    // ✅ CRÍTICO: Calcular saldo según ROL del usuario, NO según dimensión
    // ADMIN siempre resta listeroCommission (independiente de dimensión)
    // VENTANA siempre resta vendedorCommission
    const effectiveUserRole = userRole || "ADMIN"; // Por defecto ADMIN si no se especifica
    const balance = effectiveUserRole === "ADMIN"
        ? totalSales - totalPayouts - totalListeroCommission
        : totalSales - totalPayouts - totalVendedorCommission;

    // Si no hay tickets, retornar valores por defecto sin crear statement
    // FIX: No crear fechas nuevas cada vez para mantener consistencia
    if (ticketCount === 0) {
        // Intentar obtener statement existente si existe
        const existingStatement = await AccountStatementRepository.findByDate(date, {
            ventanaId,
            vendedorId,
        });

        if (existingStatement) {
            // ✅ FIX: Recalcular totalPaid y totalCollected desde movimientos activos
            // Esto asegura que los valores reflejen los movimientos actuales
            const recalculatedTotalPaid = await AccountPaymentRepository.getTotalPaid(existingStatement.id);
            const recalculatedTotalCollected = await AccountPaymentRepository.getTotalCollected(existingStatement.id);
            // ✅ NUEVO: Recalcular totalPaymentsCollections
            const recalculatedTotalPaymentsCollections = await AccountPaymentRepository.getTotalPaymentsCollections(existingStatement.id);
            // remainingBalance = balance - totalCollected + totalPaid
            // Como balance = 0 (no hay tickets), remainingBalance = 0 - totalCollected + totalPaid
            const recalculatedRemainingBalance = 0 - recalculatedTotalCollected + recalculatedTotalPaid;

            // ✅ FIX: Actualizar el statement con los valores recalculados
            await AccountStatementRepository.update(existingStatement.id, {
                totalPaid: recalculatedTotalPaid,
                totalCollected: recalculatedTotalCollected,
                remainingBalance: recalculatedRemainingBalance,
            });

            // Si existe, retornar el existente con valores recalculados
            return {
                ...existingStatement,
                totalSales: 0,
                totalPayouts: 0,
                listeroCommission: 0,
                vendedorCommission: 0,
                balance: 0,
                totalPaid: recalculatedTotalPaid,
                totalCollected: recalculatedTotalCollected,
                totalPaymentsCollections: recalculatedTotalPaymentsCollections, // ✅ NUEVO
                remainingBalance: recalculatedRemainingBalance,
                isSettled: false,
                canEdit: true,
                ticketCount: 0,
            };
        }

        // Si no existe, crear statement para tener un id
        // ✅ Calcular month desde la fecha si no está disponible
        const monthForStatement = month || `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
        const newStatement = await AccountStatementRepository.findOrCreate({
            date,
            month: monthForStatement,
            ventanaId,
            vendedorId,
        });

        return {
            ...newStatement,
            totalSales: 0,
            totalPayouts: 0,
            listeroCommission: 0,
            vendedorCommission: 0,
            balance: 0,
            totalPaid: 0,
            totalCollected: 0,
            totalPaymentsCollections: 0, // ✅ NUEVO
            remainingBalance: 0,
            isSettled: false, // No está saldado si no hay tickets
            canEdit: true,
            ticketCount: 0,
        };
    }

    // CRITICAL: Determinar el tipo de statement que necesitamos antes de buscar/crear
    // El constraint requiere que solo uno de ventanaId o vendedorId sea no-null
    // Además, hay constraints únicos: (date, ventanaId) y (date, vendedorId)
    // Convertir null a undefined para compatibilidad con TypeScript
    const targetVentanaId = vendedorId ? undefined : (ventanaId ?? undefined);
    const targetVendedorId = vendedorId ?? undefined;

    // Crear o actualizar estado de cuenta primero con los valores correctos
    // findOrCreate ya maneja correctamente la búsqueda según ventanaId o vendedorId
    // ✅ Calcular month desde la fecha si no está disponible
    const monthForStatement = month || `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
    const statement = await AccountStatementRepository.findOrCreate({
        date,
        month: monthForStatement,
        ventanaId: targetVentanaId,
        vendedorId: targetVendedorId,
    });

    // CRITICAL: Verificar que el statement encontrado tiene el tipo correcto
    // No podemos cambiar el tipo de un statement existente porque violaría los constraints únicos
    const statementIsVentana = statement.ventanaId !== null && statement.vendedorId === null;
    const statementIsVendedor = statement.vendedorId !== null && statement.ventanaId === null;
    const needsVentana = targetVentanaId !== undefined;
    const needsVendedor = targetVendedorId !== undefined;

    // Si el tipo no coincide (caso edge: statement corrupto), buscar el correcto
    let finalStatement = statement;
    if ((needsVentana && !statementIsVentana) || (needsVendedor && !statementIsVendedor)) {
        // Buscar específicamente el statement correcto usando findByDate
        const correctStatement = await AccountStatementRepository.findByDate(date, {
            ventanaId: targetVentanaId,
            vendedorId: targetVendedorId,
        });

        if (correctStatement) {
            finalStatement = correctStatement;
        } else {
            // Si no existe, crear uno nuevo (findOrCreate debería haberlo hecho, pero por seguridad)
            // ✅ Calcular month desde la fecha si no está disponible
            const monthForStatement = month || `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
            finalStatement = await AccountStatementRepository.findOrCreate({
                date,
                month: monthForStatement,
                ventanaId: targetVentanaId,
                vendedorId: targetVendedorId,
            });
        }
    }

    // Obtener total pagado y cobrado después de crear el statement
    const totalPaid = await AccountPaymentRepository.getTotalPaid(finalStatement.id);
    const totalCollected = await AccountPaymentRepository.getTotalCollected(finalStatement.id);
    // ✅ NUEVO: Obtener total de pagos y cobros combinados (no revertidos)
    const totalPaymentsCollections = await AccountPaymentRepository.getTotalPaymentsCollections(finalStatement.id);

    // Calcular saldo restante: remainingBalance = balance - totalCollected + totalPaid
    // Lógica:
    // - Collection (cobro): reduce remainingBalance cuando es positivo (resta totalCollected)
    // - Payment (pago): reduce remainingBalance cuando es negativo (suma totalPaid)
    // Fórmula: remainingBalance = balance - totalCollected + totalPaid
    const remainingBalance = balance - totalCollected + totalPaid;

    // FIX: Usar helper para cálculo consistente de isSettled
    const isSettled = calculateIsSettled(ticketCount, remainingBalance, totalPaid, totalCollected);
    const canEdit = !isSettled;

    // ✅ FIX: Guardar también totalCollected en el statement
    await AccountStatementRepository.update(finalStatement.id, {
        totalSales,
        totalPayouts,
        listeroCommission: totalListeroCommission,
        vendedorCommission: totalVendedorCommission,
        balance,
        totalPaid,
        totalCollected, // ✅ NUEVO: Guardar totalCollected
        remainingBalance,
        isSettled,
        canEdit,
        ticketCount,
        // No cambiar ventanaId/vendedorId aquí - ya están correctos en finalStatement
    });

    return {
        ...finalStatement,
        totalSales,
        totalPayouts,
        listeroCommission: totalListeroCommission,
        vendedorCommission: totalVendedorCommission,
        balance,
        totalPaid,
        totalCollected, // Agregar totalCollected al objeto retornado
        totalPaymentsCollections, // ✅ NUEVO: Total de pagos y cobros combinados (no revertidos)
        remainingBalance,
        isSettled,
        canEdit,
        ticketCount,
        ventanaId: finalStatement.ventanaId,
        vendedorId: finalStatement.vendedorId,
    };
}

/**
 * ✅ NUEVO: Calcula estado de cuenta directamente desde tickets/jugadas
 * Usa EXACTAMENTE la misma lógica que commissions.service.ts
 * Calcula jugada por jugada desde el principio, igual que commissions
 */
export async function getStatementDirect(
    filters: AccountsFilters,
    startDate: Date,
    endDate: Date,
    daysInMonth: number,
    effectiveMonth: string,
    dimension: "ventana" | "vendedor",
    ventanaId?: string,
    vendedorId?: string,
    bancaId?: string,
    userRole: "ADMIN" | "VENTANA" | "VENDEDOR" = "ADMIN",
    sort: "asc" | "desc" = "desc"
) {
    const startDateCRStr = toCRDateString(startDate);
    const endDateCRStr = toCRDateString(endDate);

    // Construir filtros WHERE dinámicos según RBAC (igual que commissions)
    const whereConditions: Prisma.Sql[] = [
        Prisma.sql`t."deletedAt" IS NULL`,
        Prisma.sql`t.status IN ('ACTIVE', 'EVALUATED', 'PAID')`,
        Prisma.sql`COALESCE(t."businessDate", DATE((t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica'))) >= ${startDateCRStr}::date`,
        Prisma.sql`COALESCE(t."businessDate", DATE((t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica'))) <= ${endDateCRStr}::date`,
    ];

    // Filtrar por banca activa (para ADMIN multibanca)
    if (bancaId) {
        whereConditions.push(Prisma.sql`EXISTS (
      SELECT 1 FROM "Ventana" v 
      WHERE v.id = t."ventanaId" 
      AND v."bancaId" = ${bancaId}::uuid
    )`);
    }

    // Aplicar filtros de RBAC según dimension
    if (dimension === "vendedor") {
        if (vendedorId) {
            whereConditions.push(Prisma.sql`t."vendedorId" = ${vendedorId}::uuid`);
        }
        if (ventanaId) {
            whereConditions.push(Prisma.sql`t."ventanaId" = ${ventanaId}::uuid`);
        }
    } else if (dimension === "ventana") {
        if (ventanaId) {
            whereConditions.push(Prisma.sql`t."ventanaId" = ${ventanaId}::uuid`);
        }
    }

    const whereClause = Prisma.sql`WHERE ${Prisma.join(whereConditions, " AND ")}`;

    // ✅ CRÍTICO: Obtener TODAS las jugadas individuales (igual que commissions)
    // Calcular todo jugada por jugada desde el principio
    const jugadas = await prisma.$queryRaw<
        Array<{
            business_date: Date;
            ventana_id: string;
            ventana_name: string;
            vendedor_id: string | null;
            vendedor_name: string | null;
            ticket_id: string;
            amount: number;
            type: string;
            finalMultiplierX: number | null;
            loteriaId: string;
            ventana_policy: any;
            banca_policy: any;
            ticket_total_payout: number | null;
            commission_amount: number | null; // snapshot del vendedor
            listero_commission_amount: number | null; // snapshot del listero
            commission_origin: string; // "USER" | "VENTANA" | "BANCA"
        }>
    >`
    SELECT
      COALESCE(
        t."businessDate",
        DATE((t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica'))
      ) as business_date,
      t."ventanaId" as ventana_id,
      v.name as ventana_name,
      t."vendedorId" as vendedor_id,
      u.name as vendedor_name,
      t.id as ticket_id,
      j.amount,
      j.type,
      j."finalMultiplierX",
      t."loteriaId",
      v."commissionPolicyJson" as ventana_policy,
      b."commissionPolicyJson" as banca_policy,
      t."totalPayout" as ticket_total_payout,
      j."commissionAmount" as commission_amount,
      j."listeroCommissionAmount" as listero_commission_amount,
      j."commissionOrigin" as commission_origin
    FROM "Ticket" t
    INNER JOIN "Jugada" j ON j."ticketId" = t.id
    INNER JOIN "Ventana" v ON v.id = t."ventanaId"
    INNER JOIN "Banca" b ON b.id = v."bancaId"
    LEFT JOIN "User" u ON u.id = t."vendedorId"
    ${whereClause}
    AND j."deletedAt" IS NULL
  `;

    // Obtener usuarios VENTANA por ventana (igual que commissions)
    const ventanaIds = Array.from(new Set(jugadas.map((j) => j.ventana_id)));
    const ventanaUsers = ventanaIds.length > 0
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

    // Mapa de políticas de usuario VENTANA por ventana (tomar el más reciente)
    const userPolicyByVentana = new Map<string, any>();
    const ventanaUserIdByVentana = new Map<string, string>();
    for (const user of ventanaUsers) {
        if (!user.ventanaId) continue;
        if (!userPolicyByVentana.has(user.ventanaId)) {
            userPolicyByVentana.set(user.ventanaId, user.commissionPolicyJson ?? null);
            ventanaUserIdByVentana.set(user.ventanaId, user.id);
        }
    }

    // ✅ CRÍTICO: Agrupar jugadas por día y ventana/vendedor, calculando comisiones jugada por jugada
    // EXACTAMENTE igual que commissions (líneas 403-492)
    const byDateAndDimension = new Map<
        string,
        {
            ventanaId: string;
            ventanaName: string;
            vendedorId: string | null;
            vendedorName: string | null;
            totalSales: number;
            totalPayouts: number;
            totalTickets: Set<string>;
            commissionListero: number;
            commissionVendedor: number;
            payoutTickets: Set<string>;
        }
    >();

    for (const jugada of jugadas) {
        // Obtener política de usuario VENTANA para esta ventana específica
        const userPolicyJson = userPolicyByVentana.get(jugada.ventana_id) ?? null;
        const ventanaUserId = ventanaUserIdByVentana.get(jugada.ventana_id) ?? "";

        let commissionListero = 0;

        // ✅ CRÍTICO: Calcular comisión del listero jugada por jugada (igual que dashboard.service.ts)
        if (userPolicyJson) {
            // Si hay política de usuario VENTANA, usarla (prioridad más alta)
            try {
                const resolution = resolveCommissionFromPolicy(userPolicyJson, {
                    userId: ventanaUserId,
                    loteriaId: jugada.loteriaId,
                    betType: jugada.type as "NUMERO" | "REVENTADO",
                    finalMultiplierX: jugada.finalMultiplierX ?? null,
                });
                commissionListero = parseFloat(((jugada.amount * resolution.percent) / 100).toFixed(2));
            } catch (err) {
                // Si falla, usar fallback con políticas de ventana/banca
                const fallback = resolveCommission(
                    {
                        loteriaId: jugada.loteriaId,
                        betType: jugada.type as "NUMERO" | "REVENTADO",
                        finalMultiplierX: jugada.finalMultiplierX || 0,
                        amount: jugada.amount,
                    },
                    null,
                    jugada.ventana_policy,
                    jugada.banca_policy
                );
                commissionListero = parseFloat((fallback.commissionAmount).toFixed(2));
            }
        } else {
            // Si NO hay política de usuario VENTANA, usar políticas de ventana/banca
            const ventanaCommission = resolveCommission(
                {
                    loteriaId: jugada.loteriaId,
                    betType: jugada.type as "NUMERO" | "REVENTADO",
                    finalMultiplierX: jugada.finalMultiplierX || 0,
                    amount: jugada.amount,
                },
                null, // No hay política de usuario VENTANA
                jugada.ventana_policy, // Política de ventana
                jugada.banca_policy // Política de banca
            );
            commissionListero = parseFloat((ventanaCommission.commissionAmount).toFixed(2));
        }

        // Usar snapshot si está disponible, sino usar el calculado
        const commissionListeroFinal = (jugada.listero_commission_amount && jugada.listero_commission_amount > 0)
            ? parseFloat((jugada.listero_commission_amount).toFixed(2))
            : commissionListero;

        const dateKey = jugada.business_date.toISOString().split("T")[0]; // YYYY-MM-DD
        const key = dimension === "ventana"
            ? `${dateKey}_${jugada.ventana_id}`
            : `${dateKey}_${jugada.vendedor_id || 'null'}`;

        let entry = byDateAndDimension.get(key);
        if (!entry) {
            entry = {
                ventanaId: jugada.ventana_id,
                ventanaName: jugada.ventana_name,
                vendedorId: jugada.vendedor_id,
                vendedorName: jugada.vendedor_name,
                totalSales: 0,
                totalPayouts: 0,
                totalTickets: new Set<string>(),
                commissionListero: 0,
                commissionVendedor: 0,
                payoutTickets: new Set<string>(),
            };
            byDateAndDimension.set(key, entry);
        }

        entry.totalSales += jugada.amount;
        entry.totalTickets.add(jugada.ticket_id);
        entry.commissionListero += commissionListeroFinal;
        // Solo sumar commission_amount si la jugada es de comisión de VENDEDOR (USER)
        if (jugada.commission_origin === "USER") {
            entry.commissionVendedor += Number(jugada.commission_amount || 0);
        }
        if (!entry.payoutTickets.has(jugada.ticket_id)) {
            entry.totalPayouts += Number(jugada.ticket_total_payout || 0);
            entry.payoutTickets.add(jugada.ticket_id);
        }
    }

    // Obtener movimientos y desglose por sorteo
    const statementDates = Array.from(new Set(Array.from(byDateAndDimension.keys()).map(k => k.split("_")[0]))).map(d => {
        const [year, month, day] = d.split('-').map(Number);
        return new Date(Date.UTC(year, month - 1, day));
    });

    const [movementsByDate, sorteoBreakdownBatch] = await Promise.all([
        AccountPaymentRepository.findMovementsByDateRange(startDate, endDate, dimension, ventanaId, vendedorId, bancaId),
        getSorteoBreakdownBatch(statementDates, dimension, ventanaId, vendedorId, bancaId, userRole),
    ]);

    // Construir statements desde el mapa agrupado
    const statements = Array.from(byDateAndDimension.entries()).map(([key, entry]) => {
        const date = key.split("_")[0];

        // Calcular balance según rol
        const balance = userRole === "ADMIN"
            ? entry.totalSales - entry.totalPayouts - entry.commissionListero
            : entry.totalSales - entry.totalPayouts - entry.commissionVendedor;

        // Obtener movimientos y desglose por sorteo para esta fecha
        const movements = movementsByDate.get(date) || [];
        const bySorteo = sorteoBreakdownBatch.get(date) || [];

        // Calcular totales de pagos y cobros
        const totalPaid = movements
            .filter((m: any) => m.type === "payment" && !m.isReversed)
            .reduce((sum: number, m: any) => sum + m.amount, 0);
        const totalCollected = movements
            .filter((m: any) => m.type === "collection" && !m.isReversed)
            .reduce((sum: number, m: any) => sum + m.amount, 0);
        const remainingBalance = balance - totalCollected + totalPaid;

        const statement: any = {
            date,
            totalSales: entry.totalSales,
            totalPayouts: entry.totalPayouts,
            listeroCommission: entry.commissionListero,
            vendedorCommission: entry.commissionVendedor,
            balance,
            totalPaid,
            totalCollected,
            totalPaymentsCollections: totalPaid + totalCollected,
            remainingBalance,
            isSettled: calculateIsSettled(entry.totalTickets.size, remainingBalance, totalPaid, totalCollected),
            canEdit: !calculateIsSettled(entry.totalTickets.size, remainingBalance, totalPaid, totalCollected),
            ticketCount: entry.totalTickets.size,
            bySorteo,
            movements,
        };

        if (dimension === "ventana") {
            statement.ventanaId = entry.ventanaId;
            statement.ventanaName = entry.ventanaName;
        } else {
            statement.vendedorId = entry.vendedorId;
            statement.vendedorName = entry.vendedorName;
        }

        return statement;
    }).sort((a, b) => {
        const dateA = new Date(a.date).getTime();
        const dateB = new Date(b.date).getTime();
        return sort === "desc" ? dateB - dateA : dateA - dateB;
    });

    // Calcular totales
    const totalSales = statements.reduce((sum, s) => sum + s.totalSales, 0);
    const totalPayouts = statements.reduce((sum, s) => sum + s.totalPayouts, 0);
    const totalListeroCommission = statements.reduce((sum, s) => sum + s.listeroCommission, 0);
    const totalVendedorCommission = statements.reduce((sum, s) => sum + s.vendedorCommission, 0);
    const totalBalance = userRole === "ADMIN"
        ? totalSales - totalPayouts - totalListeroCommission
        : totalSales - totalPayouts - totalVendedorCommission;
    const totalPaid = statements.reduce((sum, s) => sum + s.totalPaid, 0);
    const totalCollected = statements.reduce((sum, s) => sum + s.totalCollected, 0);
    const totalRemainingBalance = statements.reduce((sum, s) => sum + s.remainingBalance, 0);

    return {
        statements,
        totals: {
            totalSales,
            totalPayouts,
            totalListeroCommission,
            totalVendedorCommission,
            totalBalance,
            totalPaid,
            totalCollected,
            totalRemainingBalance,
            settledDays: statements.filter(s => s.isSettled).length,
            pendingDays: statements.filter(s => !s.isSettled).length,
        },
        meta: {
            month: effectiveMonth,
            startDate: startDateCRStr,
            endDate: endDateCRStr,
            dimension,
            totalDays: daysInMonth,
        },
    };
}
