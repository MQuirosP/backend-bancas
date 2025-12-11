import { Prisma, Role } from "@prisma/client";
import prisma from "../../../../core/prismaClient";
import logger from "../../../../core/logger";
import { AppError } from "../../../../core/errors";
import { AccountStatementRepository } from "../../../../repositories/accountStatement.repository";
import { AccountPaymentRepository } from "../../../../repositories/accountPayment.repository";
import { calculateIsSettled } from "./accounts.commissions";
import { buildTicketDateFilter } from "./accounts.dates.utils";
import { crDateService } from "../../../../utils/crDateService";
import { AccountsFilters, DayStatement, StatementTotals } from "./accounts.types";
import { resolveCommissionFromPolicy } from "../../../../services/commission/commission.resolver";
import { resolveCommission } from "../../../../services/commission.resolver";
import { getSorteoBreakdownBatch } from "./accounts.queries";
import { getCachedDayStatement, setCachedDayStatement } from "../../../../utils/accountStatementCache";

/**
 * Calcula y actualiza el estado de cuenta para un día específico
 */
export async function calculateDayStatement(
    date: Date,
    month: string,
    dimension: "banca" | "ventana" | "vendedor", // ✅ NUEVO: Agregado 'banca'
    ventanaId?: string,
    vendedorId?: string,
    bancaId?: string,
    userRole?: "ADMIN" | "VENTANA" | "VENDEDOR" // ✅ CRÍTICO: Rol del usuario para calcular balance correctamente
): Promise<DayStatement> {
    // ✅ OPTIMIZACIÓN: Intentar obtener del caché primero
    const dateStr = crDateService.postgresDateToCRString(date);
    const cacheKey = {
        date: dateStr,
        dimension,
        ventanaId: ventanaId || null,
        vendedorId: vendedorId || null,
        bancaId: bancaId || null,
        userRole: userRole || "ADMIN",
    };
    
    const cached = await getCachedDayStatement<DayStatement>(cacheKey);
    if (cached) {
        return cached;
    }

    // Construir WHERE clause
    // FIX: Usar businessDate en lugar de createdAt para agrupar correctamente por día de negocio
    const dateFilter = buildTicketDateFilter(date);

    // ✅ NUEVO: Obtener tickets excluidos para esta fecha
    const excludedTicketIds = await getExcludedTicketIdsForDate(date);

    const where: any = {
        ...dateFilter,
        deletedAt: null,
        isActive: true,
        status: { in: ["ACTIVE", "EVALUATED", "PAID", "PAGADO"] },
        ...(excludedTicketIds.length > 0 ? { id: { notIn: excludedTicketIds } } : {}), // ✅ NUEVO: Excluir tickets bloqueados
    };

    // Filtrar por banca activa (para ADMIN multibanca)
    if (bancaId) {
        where.ventana = {
            bancaId: bancaId,
        };
    }

    // ✅ NUEVO: Validación defensiva según dimensión
    if (dimension === "banca" && bancaId) {
        // Filtrar por banca (ya aplicado arriba con where.ventana.bancaId)
    } else if (dimension === "ventana" && ventanaId) {
        where.ventanaId = ventanaId;
    } else if (dimension === "vendedor" && vendedorId) {
        where.vendedorId = vendedorId;
    }

    // Usar agregaciones de Prisma para calcular totales directamente en la base de datos
    // Esto es mucho más eficiente que traer todos los tickets y jugadas a memoria
    const [ticketAgg, ticketAggWinners, jugadaAggVendor, jugadaAggListero] = await Promise.all([
        // Agregaciones de tickets (TODOS los tickets para ventas)
        prisma.ticket.aggregate({
            where,
            _sum: {
                totalAmount: true,
            },
            _count: {
                id: true,
            },
        }),
        // ✅ CORRECCIÓN: Agregaciones de tickets SOLO con jugadas ganadoras para payouts
        // Esto asegura que solo contamos totalPayout de tickets que realmente tienen jugadas ganadoras
        prisma.ticket.aggregate({
            where: {
                ...where,
                jugadas: {
                    some: {
                        isWinner: true,
                        deletedAt: null,
                    },
                },
            },
            _sum: {
                totalPayout: true, // ✅ CORRECCIÓN: Usar totalPayout del ticket (una vez por ticket, solo si tiene jugadas ganadoras)
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
    ]);

    // Calcular totales básicos desde agregaciones
    const totalSales = ticketAgg._sum.totalAmount || 0;
    // ✅ CORRECCIÓN: totalPayouts debe ser la suma de totalPayout de tickets que tienen jugadas ganadoras
    // NO debe sumar el payout de cada jugada individualmente porque un ticket puede tener múltiples jugadas ganadoras
    // El campo totalPayout del ticket ya contiene la suma correcta de todos los payouts de las jugadas ganadoras de ese ticket
    // IMPORTANTE: Solo sumar totalPayout de tickets que tienen al menos una jugada ganadora
    const totalPayouts = ticketAggWinners._sum.totalPayout || 0;
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
    // ✅ OPTIMIZACIÓN: Usar agregación en lugar de findMany para mejor rendimiento
    if (totalListeroCommission === 0 && ticketCount > 0) {
        // Verificar si hay tickets con commissionOrigin VENTANA/BANCA que no tienen snapshot
        // Esto indica que fueron creados antes de los cambios
        // ✅ OPTIMIZACIÓN: Usar agregación en lugar de findMany para evitar traer todas las jugadas
        const fallbackAgg = await prisma.jugada.aggregate({
            where: {
                ticket: where,
                deletedAt: null,
                commissionOrigin: { in: ["VENTANA", "BANCA"] },
                listeroCommissionAmount: 0, // Tickets antiguos tienen 0 por defecto
            },
            _sum: {
                commissionAmount: true,
            },
            _count: {
                id: true,
            },
        });
        
        const fallbackTotal = fallbackAgg._sum.commissionAmount || 0;
        if (fallbackTotal > 0) {
            totalListeroCommission = fallbackTotal;
            logger.warn({
                layer: 'service',
                action: 'LISTERO_COMMISSION_FALLBACK_FROM_ORIGIN',
                payload: {
                    fallbackTotal,
                    jugadasCount: fallbackAgg._count.id || 0,
                    note: 'Using commissionOrigin as fallback for old tickets',
                },
            });
        }
    }

    // ✅ CORRECCIÓN: Calcular balance según dimensión
    // - Vendedor: balance = totalSales - totalPayouts - vendedorCommission
    // - Ventana/Banca: balance = totalSales - totalPayouts - listeroCommission
    const balance = dimension === "vendedor"
        ? totalSales - totalPayouts - totalVendedorCommission
        : totalSales - totalPayouts - totalListeroCommission;

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

            // ✅ OPTIMIZACIÓN: Obtener nombres de ventana/vendedor en paralelo si existen
            let ventanaName: string | null = null;
            let vendedorName: string | null = null;
            
            const [ventana, vendedor] = await Promise.all([
                existingStatement.ventanaId
                    ? prisma.ventana.findUnique({
                          where: { id: existingStatement.ventanaId },
                          select: { name: true },
                      })
                    : Promise.resolve(null),
                existingStatement.vendedorId
                    ? prisma.user.findUnique({
                          where: { id: existingStatement.vendedorId },
                          select: { name: true },
                      })
                    : Promise.resolve(null),
            ]);
            
            ventanaName = ventana?.name || null;
            vendedorName = vendedor?.name || null;

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
                ventanaName,
                vendedorName,
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

        // ✅ OPTIMIZACIÓN: Obtener nombres de ventana/vendedor en paralelo si existen
        let ventanaName: string | null = null;
        let vendedorName: string | null = null;
        
        const [ventana, vendedor] = await Promise.all([
            newStatement.ventanaId
                ? prisma.ventana.findUnique({
                      where: { id: newStatement.ventanaId },
                      select: { name: true },
                  })
                : Promise.resolve(null),
            newStatement.vendedorId
                ? prisma.user.findUnique({
                      where: { id: newStatement.vendedorId },
                      select: { name: true },
                  })
                : Promise.resolve(null),
        ]);
        
        ventanaName = ventana?.name || null;
        vendedorName = vendedor?.name || null;

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
            ventanaName,
            vendedorName,
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

    // ✅ OPTIMIZACIÓN: Obtener nombres de ventana/vendedor en paralelo si existen
    let ventanaName: string | null = null;
    let vendedorName: string | null = null;
    
    const [ventana, vendedor] = await Promise.all([
        finalStatement.ventanaId
            ? prisma.ventana.findUnique({
                  where: { id: finalStatement.ventanaId },
                  select: { name: true },
              })
            : Promise.resolve(null),
        finalStatement.vendedorId
            ? prisma.user.findUnique({
                  where: { id: finalStatement.vendedorId },
                  select: { name: true },
              })
            : Promise.resolve(null),
    ]);
    
    ventanaName = ventana?.name || null;
    vendedorName = vendedor?.name || null;

    const result: DayStatement = {
        ...finalStatement,
        totalSales: parseFloat(totalSales.toFixed(2)),
        totalPayouts: parseFloat(totalPayouts.toFixed(2)),
        listeroCommission: parseFloat(totalListeroCommission.toFixed(2)),
        vendedorCommission: parseFloat(totalVendedorCommission.toFixed(2)),
        balance: parseFloat(balance.toFixed(2)),
        totalPaid: parseFloat(totalPaid.toFixed(2)),
        totalCollected: parseFloat(totalCollected.toFixed(2)), // Agregar totalCollected al objeto retornado
        totalPaymentsCollections: parseFloat(totalPaymentsCollections.toFixed(2)), // ✅ NUEVO: Total de pagos y cobros combinados (no revertidos)
        remainingBalance: parseFloat(remainingBalance.toFixed(2)),
        isSettled,
        canEdit,
        ticketCount,
        ventanaId: finalStatement.ventanaId,
        vendedorId: finalStatement.vendedorId,
        ventanaName,
        vendedorName,
    };

    // ✅ OPTIMIZACIÓN: Guardar en caché (no esperar, hacerlo en background)
    setCachedDayStatement(cacheKey, result).catch(() => {
        // Ignorar errores de caché
    });

    return result;
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
    dimension: "banca" | "ventana" | "vendedor", // ✅ NUEVO: Agregado 'banca'
    ventanaId?: string,
    vendedorId?: string,
    bancaId?: string,
    userRole: "ADMIN" | "VENTANA" | "VENDEDOR" = "ADMIN",
    sort: "asc" | "desc" = "desc"
) {
    // ✅ CORRECCIÓN: Usar servicio centralizado para conversión de fechas
    const { startDateCRStr, endDateCRStr } = crDateService.dateRangeUTCToCRStrings(startDate, endDate);

    // ✅ NUEVO: Detectar si debemos agrupar por fecha solamente (sin separar por entidad)
    // Agrupamos cuando:
    // - dimension=banca y bancaId NO está especificado
    // - dimension=ventana y ventanaId NO está especificado
    // - dimension=vendedor y vendedorId NO está especificado
    // ✅ CRÍTICO: Verificar tanto undefined como null y cadena vacía
    const shouldGroupByDate = 
        (dimension === "banca" && (!bancaId || bancaId === "" || bancaId === null)) ||
        (dimension === "ventana" && (!ventanaId || ventanaId === "" || ventanaId === null)) ||
        (dimension === "vendedor" && (!vendedorId || vendedorId === "" || vendedorId === null));
    
    // ✅ DEBUG: Log para verificar agrupación y rendimiento
    const functionStartTime = Date.now();
    logger.info({
        layer: "service",
        action: "GET_STATEMENT_DIRECT_START",
        payload: {
            dimension,
            ventanaId: ventanaId || null,
            vendedorId: vendedorId || null,
            bancaId: bancaId || null,
            shouldGroupByDate,
            startDate: startDateCRStr,
            endDate: endDateCRStr,
            daysInRange: daysInMonth,
        },
    });

    // Construir filtros WHERE dinámicos según RBAC (igual que commissions)
    const whereConditions: Prisma.Sql[] = [
        Prisma.sql`t."deletedAt" IS NULL`,
        Prisma.sql`t."isActive" = true`,
        Prisma.sql`t.status IN ('ACTIVE', 'EVALUATED', 'PAID', 'PAGADO')`,
        Prisma.sql`COALESCE(t."businessDate", DATE((t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica'))) >= ${startDateCRStr}::date`,
        Prisma.sql`COALESCE(t."businessDate", DATE((t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica'))) <= ${endDateCRStr}::date`,
        // ✅ NUEVO: Excluir tickets de listas bloqueadas (Lista Exclusion)
        Prisma.sql`NOT EXISTS (
            SELECT 1 FROM "sorteo_lista_exclusion" sle
            WHERE sle.sorteo_id = t."sorteoId"
            AND sle.ventana_id = t."ventanaId"
            AND (sle.vendedor_id IS NULL OR sle.vendedor_id = t."vendedorId")
        )`,
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
    if (dimension === "banca") {
        // ✅ NUEVO: Filtros para dimension='banca'
        if (bancaId) {
            // Filtrar solo tickets de esta banca específica
            whereConditions.push(Prisma.sql`EXISTS (
                SELECT 1 FROM "Ventana" v 
                WHERE v.id = t."ventanaId" 
                AND v."bancaId" = ${bancaId}::uuid
            )`);
        }
        if (ventanaId) {
            // Filtrar solo listeros de esa banca específica
            whereConditions.push(Prisma.sql`t."ventanaId" = ${ventanaId}::uuid`);
            // Validar que ventanaId pertenece a bancaId (si está presente)
            if (bancaId) {
                whereConditions.push(Prisma.sql`EXISTS (
                    SELECT 1 FROM "Ventana" v 
                    WHERE v.id = ${ventanaId}::uuid
                    AND v."bancaId" = ${bancaId}::uuid
                )`);
            }
        }
        if (vendedorId) {
            // Filtrar solo vendedores de esa banca (y opcionalmente de ese listero)
            whereConditions.push(Prisma.sql`t."vendedorId" = ${vendedorId}::uuid`);
            if (bancaId) {
                whereConditions.push(Prisma.sql`EXISTS (
                    SELECT 1 FROM "Ventana" v 
                    JOIN "User" u ON u."ventanaId" = v.id
                    WHERE u.id = ${vendedorId}::uuid
                    AND v."bancaId" = ${bancaId}::uuid
                )`);
            }
            if (ventanaId) {
                whereConditions.push(Prisma.sql`EXISTS (
                    SELECT 1 FROM "User" u
                    WHERE u.id = ${vendedorId}::uuid
                    AND u."ventanaId" = ${ventanaId}::uuid
                )`);
            }
        }
    } else if (dimension === "vendedor") {
        if (vendedorId) {
            whereConditions.push(Prisma.sql`t."vendedorId" = ${vendedorId}::uuid`);
        }
        if (ventanaId) {
            whereConditions.push(Prisma.sql`t."ventanaId" = ${ventanaId}::uuid`);
        }
        // ✅ NUEVO: Si hay bancaId, filtrar solo vendedores de esa banca
        if (bancaId) {
            whereConditions.push(Prisma.sql`EXISTS (
                SELECT 1 FROM "Ventana" v 
                JOIN "User" u ON u."ventanaId" = v.id
                WHERE u.id = t."vendedorId"
                AND v."bancaId" = ${bancaId}::uuid
            )`);
        }
    } else if (dimension === "ventana") {
        if (ventanaId) {
            whereConditions.push(Prisma.sql`t."ventanaId" = ${ventanaId}::uuid`);
        }
        // ✅ NUEVO: Si hay bancaId, filtrar solo listeros de esa banca
        if (bancaId) {
            whereConditions.push(Prisma.sql`EXISTS (
                SELECT 1 FROM "Ventana" v 
                WHERE v.id = t."ventanaId" 
                AND v."bancaId" = ${bancaId}::uuid
            )`);
        }
        // ✅ NUEVO: Si hay vendedorId, filtrar solo vendedores de ese listero
        if (vendedorId) {
            whereConditions.push(Prisma.sql`t."vendedorId" = ${vendedorId}::uuid`);
        }
    }

    // ✅ CRÍTICO: Optimización para dimension='banca' sin bancaId específica
    // Si estamos agrupando por todas las bancas, limitar el rango de fechas y usar índices
    // Agregar límite de fechas más agresivo si no hay filtros específicos
    if (dimension === "banca" && !bancaId && whereConditions.length <= 2) {
        // Solo filtros de fecha básicos, agregar límite de tiempo para evitar consultas masivas
        // Esto previene consultas de años completos cuando solo se necesita un mes
        const maxDaysBack = 90; // Máximo 90 días hacia atrás
        const minDate = new Date(startDate);
        minDate.setUTCDate(minDate.getUTCDate() - maxDaysBack);
        const minDateCR = crDateService.postgresDateToCRString(minDate);
        whereConditions.push(Prisma.sql`COALESCE(t."businessDate", DATE((t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica'))) >= ${minDateCR}::date`);
    }

    const whereClause = Prisma.sql`WHERE ${Prisma.join(whereConditions, " AND ")}`;

    // ✅ OPTIMIZACIÓN: Usar agregaciones SQL directamente en lugar de traer todas las jugadas
    // Esto reduce significativamente la cantidad de datos transferidos y mejora el rendimiento
    // Usar subquery para calcular payouts correctamente (una vez por ticket, solo si tiene jugadas ganadoras)
    const queryStartTime = Date.now();
    logger.info({
        layer: "service",
        action: "ACCOUNT_STATEMENT_SQL_QUERY_START",
        payload: {
            dimension,
            bancaId,
            ventanaId,
            vendedorId,
            startDate: startDateCRStr,
            endDate: endDateCRStr,
            shouldGroupByDate,
        },
    });
    
    // ✅ CRÍTICO: Construir la consulta SQL completa usando Prisma.sql correctamente
    // No podemos insertar Prisma.sql dentro de otro Prisma.sql porque los parámetros se desalinean
    // Construir la consulta completa con todos los parámetros en orden
    const query = Prisma.sql`
    SELECT
      COALESCE(
        t."businessDate",
        DATE((t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica'))
      ) as business_date,
      b.id as banca_id,
      b.name as banca_name,
      b.code as banca_code,
      t."ventanaId" as ventana_id,
      v.name as ventana_name,
      v.code as ventana_code,
      t."vendedorId" as vendedor_id,
      u.name as vendedor_name,
      u.code as vendedor_code,
      COALESCE(SUM(j.amount), 0) as total_sales,
      0 as total_payouts,
      COUNT(DISTINCT t.id) as total_tickets,
      COALESCE(SUM(j."listeroCommissionAmount"), 0) as commission_listero,
      COALESCE(SUM(CASE WHEN j."commissionOrigin" = 'USER' THEN j."commissionAmount" ELSE 0 END), 0) as commission_vendedor
    FROM "Ticket" t
    INNER JOIN "Jugada" j ON j."ticketId" = t.id
    INNER JOIN "Ventana" v ON v.id = t."ventanaId"
    INNER JOIN "Banca" b ON b.id = v."bancaId"
    LEFT JOIN "User" u ON u.id = t."vendedorId"
    WHERE ${Prisma.join(whereConditions, " AND ")}
    AND j."deletedAt" IS NULL
    GROUP BY 
      COALESCE(t."businessDate", DATE((t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica'))),
      b.id,
      b.name,
      b.code,
      t."ventanaId",
      v.name,
      v.code,
      t."vendedorId",
      u.name,
      u.code
    ORDER BY business_date ${sort === "desc" ? Prisma.sql`DESC` : Prisma.sql`ASC`}
    LIMIT 5000
  `;
    
    const aggregatedData = await prisma.$queryRaw<
        Array<{
            business_date: Date;
            banca_id: string | null;
            banca_name: string | null;
            banca_code: string | null;
            ventana_id: string;
            ventana_name: string;
            ventana_code: string | null;
            vendedor_id: string | null;
            vendedor_name: string | null;
            vendedor_code: string | null;
            total_sales: number;
            total_payouts: number;
            total_tickets: bigint;
            commission_listero: number;
            commission_vendedor: number;
        }>
    >(query);
    
    const queryEndTime = Date.now();
    logger.info({
        layer: "service",
        action: "ACCOUNT_STATEMENT_SQL_QUERY_END",
        payload: {
            dimension,
            bancaId,
            ventanaId,
            vendedorId,
            rowsReturned: aggregatedData.length,
            queryTimeMs: queryEndTime - queryStartTime,
        },
    });

    // ✅ CRÍTICO: Agrupar jugadas por día y banca/ventana/vendedor, calculando comisiones jugada por jugada
    // EXACTAMENTE igual que commissions (líneas 403-492)
    // ✅ NUEVO: Si shouldGroupByDate=true, agrupar solo por fecha (sin separar por entidad)
    const byDateAndDimension = new Map<
        string,
        {
            bancaId: string | null; // ✅ NUEVO: ID de banca
            bancaName: string | null; // ✅ NUEVO: Nombre de banca
            bancaCode: string | null; // ✅ NUEVO: Código de banca
            ventanaId: string | null;
            ventanaName: string | null;
            ventanaCode: string | null; // ✅ NUEVO: Código de ventana
            vendedorId: string | null;
            vendedorName: string | null;
            vendedorCode: string | null; // ✅ NUEVO: Código de vendedor
            totalSales: number;
            totalPayouts: number;
            totalTickets: Set<string>;
            commissionListero: number;
            commissionVendedor: number;
            payoutTickets: Set<string>;
        }
    >();

    // ✅ NUEVO: Mapa para desglose por entidad (byBanca/byVentana/byVendedor) cuando hay agrupación
    const breakdownByEntity = new Map<
        string, // `${dateKey}_${entityId}` o `${dateKey}_${bancaId}` o `${dateKey}_${ventanaId}` o `${dateKey}_${vendedorId}`
        {
            bancaId: string | null; // ✅ NUEVO: ID de banca
            bancaName: string | null; // ✅ NUEVO: Nombre de banca
            bancaCode: string | null; // ✅ NUEVO: Código de banca
            ventanaId: string | null;
            ventanaName: string | null;
            ventanaCode: string | null; // ✅ NUEVO: Código de ventana
            vendedorId: string | null;
            vendedorName: string | null;
            vendedorCode: string | null; // ✅ NUEVO: Código de vendedor
            totalSales: number;
            totalPayouts: number;
            totalTickets: Set<string>;
            commissionListero: number;
            commissionVendedor: number;
            payoutTickets: Set<string>;
        }
    >();

    // ✅ OPTIMIZACIÓN: Procesar datos agregados en lugar de jugadas individuales
    for (const row of aggregatedData) {
        const dateKey = crDateService.postgresDateToCRString(row.business_date);
        
        // ✅ CRÍTICO: Filtrar datos fuera del período solicitado ANTES de agregarlos al mapa
        if (!crDateService.isDateInCRRange(dateKey, startDateCRStr, endDateCRStr)) {
            continue; // Saltar datos fuera del período
        }
        
        // ✅ NUEVO: Si shouldGroupByDate=true, agrupar solo por fecha; si no, por fecha + entidad
        const groupKey = shouldGroupByDate
            ? dateKey // Solo fecha cuando hay agrupación
            : (dimension === "banca"
                ? `${dateKey}_${row.banca_id || 'null'}`
                : dimension === "ventana"
                ? `${dateKey}_${row.ventana_id}`
                : `${dateKey}_${row.vendedor_id || 'null'}`);

        // Clave para el desglose por entidad (siempre incluye entidad)
        const breakdownKey = dimension === "banca"
            ? `${dateKey}_${row.banca_id || 'null'}`
            : dimension === "ventana"
            ? `${dateKey}_${row.ventana_id}`
            : `${dateKey}_${row.vendedor_id || 'null'}`;

        // Obtener o crear entrada principal (agrupada por fecha si shouldGroupByDate)
        let entry = byDateAndDimension.get(groupKey);
        if (!entry) {
            entry = {
                bancaId: shouldGroupByDate ? null : (dimension === "banca" ? row.banca_id : null),
                bancaName: shouldGroupByDate ? null : (dimension === "banca" ? row.banca_name : null),
                bancaCode: shouldGroupByDate ? null : (dimension === "banca" ? row.banca_code : null),
                ventanaId: shouldGroupByDate ? null : (dimension === "ventana" ? row.ventana_id : null),
                ventanaName: shouldGroupByDate ? null : (dimension === "ventana" ? row.ventana_name : null),
                ventanaCode: shouldGroupByDate ? null : (dimension === "ventana" ? row.ventana_code : null),
                vendedorId: shouldGroupByDate ? null : (dimension === "vendedor" ? row.vendedor_id : null),
                vendedorName: shouldGroupByDate ? null : (dimension === "vendedor" ? row.vendedor_name : null),
                vendedorCode: shouldGroupByDate ? null : (dimension === "vendedor" ? row.vendedor_code : null),
                totalSales: 0,
                totalPayouts: 0,
                totalTickets: new Set<string>(),
                commissionListero: 0,
                commissionVendedor: 0,
                payoutTickets: new Set<string>(),
            };
            byDateAndDimension.set(groupKey, entry);
        }

        // ✅ NUEVO: Mantener desglose por entidad cuando hay agrupación
        if (shouldGroupByDate) {
            let breakdownEntry = breakdownByEntity.get(breakdownKey);
            if (!breakdownEntry) {
                breakdownEntry = {
                    bancaId: dimension === "banca" ? row.banca_id : null,
                    bancaName: dimension === "banca" ? row.banca_name : null,
                    bancaCode: dimension === "banca" ? row.banca_code : null,
                    ventanaId: dimension === "ventana" ? row.ventana_id : (dimension === "banca" ? row.ventana_id : null),
                    ventanaName: dimension === "ventana" ? row.ventana_name : (dimension === "banca" ? row.ventana_name : null),
                    ventanaCode: dimension === "ventana" ? row.ventana_code : (dimension === "banca" ? row.ventana_code : null),
                    vendedorId: dimension === "vendedor" ? row.vendedor_id : null,
                    vendedorName: dimension === "vendedor" ? row.vendedor_name : null,
                    vendedorCode: dimension === "vendedor" ? row.vendedor_code : null,
                    totalSales: 0,
                    totalPayouts: 0,
                    totalTickets: new Set<string>(),
                    commissionListero: 0,
                    commissionVendedor: 0,
                    payoutTickets: new Set<string>(),
                };
                breakdownByEntity.set(breakdownKey, breakdownEntry);
            }

            // Actualizar desglose por entidad (ya agregado desde SQL)
            breakdownEntry.totalSales += Number(row.total_sales || 0);
            // ✅ NOTA: totalPayouts se calcula desde bySorteo, NO desde SQL
            breakdownEntry.commissionListero += Number(row.commission_listero || 0);
            breakdownEntry.commissionVendedor += Number(row.commission_vendedor || 0);
            // ✅ OPTIMIZACIÓN: Usar un contador aproximado en lugar de Set de IDs
            // El Set se usa solo para mantener la estructura, pero el conteo real viene de SQL
            const ticketCount = Number(row.total_tickets || 0);
            breakdownEntry.totalTickets = new Set(Array.from({ length: ticketCount }, (_, i) => `${row.ventana_id}_${row.vendedor_id}_${i}`));
        }

        // Actualizar entrada principal (agrupada) - ya agregado desde SQL
        entry.totalSales += Number(row.total_sales || 0);
        entry.totalPayouts += Number(row.total_payouts || 0);
        entry.commissionListero += Number(row.commission_listero || 0);
        entry.commissionVendedor += Number(row.commission_vendedor || 0);
        // ✅ OPTIMIZACIÓN: Usar un contador aproximado en lugar de Set de IDs
        // El Set se usa solo para mantener la estructura, pero el conteo real viene de SQL
        const ticketCount = Number(row.total_tickets || 0);
        entry.totalTickets = new Set(Array.from({ length: ticketCount }, (_, i) => `${row.ventana_id}_${row.vendedor_id}_${i}`));
    }

    // Obtener movimientos (pagos/cobros) para el rango de fechas
    const movementsByDate = await AccountPaymentRepository.findMovementsByDateRange(
        startDate,
        endDate,
        dimension,
        ventanaId,
        vendedorId,
        bancaId
    );

    // ✅ NUEVO: Incorporar días que solo tienen movimientos (sin ventas)
    // ✅ CRÍTICO: Filtrar movimientos fuera del período solicitado ANTES de agregarlos al mapa
    for (const [dateKey, movements] of movementsByDate.entries()) {
        // Filtrar fechas fuera del período
        if (dateKey < startDateCRStr || dateKey > endDateCRStr) {
            continue; // Saltar movimientos fuera del período
        }
        
        for (const movement of movements) {
            // Determinar ID según dimensión
            const targetId = dimension === "banca" 
                ? movement.bancaId 
                : dimension === "ventana" 
                ? movement.ventanaId 
                : movement.vendedorId;
            // Si estamos filtrando por dimensión y el movimiento no coincide, ignorar (aunque el repo ya filtra)
            if (dimension === "banca" && bancaId && targetId !== bancaId) continue;
            if (dimension === "ventana" && ventanaId && targetId !== ventanaId) continue;
            if (dimension === "vendedor" && vendedorId && targetId !== vendedorId) continue;

            // ✅ NUEVO: Si shouldGroupByDate=true, agrupar solo por fecha; si no, por fecha + entidad
            const groupKey = shouldGroupByDate
                ? dateKey // Solo fecha cuando hay agrupación
                : `${dateKey}_${targetId || 'null'}`;

            if (!byDateAndDimension.has(groupKey)) {
                // Crear entrada vacía si no existe (día sin ventas)
                byDateAndDimension.set(groupKey, {
                    bancaId: shouldGroupByDate ? null : (dimension === "banca" ? movement.bancaId : null),
                    bancaName: shouldGroupByDate ? null : (dimension === "banca" ? (movement.bancaName || "Desconocido") : null),
                    bancaCode: shouldGroupByDate ? null : (dimension === "banca" ? movement.bancaCode : null),
                    ventanaId: shouldGroupByDate ? null : (dimension === "ventana" ? movement.ventanaId : (dimension === "banca" ? movement.ventanaId : null)),
                    ventanaName: shouldGroupByDate ? null : (dimension === "ventana" ? (movement.ventanaName || "Desconocido") : (dimension === "banca" ? (movement.ventanaName || "Desconocido") : null)),
                    ventanaCode: shouldGroupByDate ? null : (dimension === "ventana" ? movement.ventanaCode : (dimension === "banca" ? movement.ventanaCode : null)),
                    vendedorId: shouldGroupByDate ? null : (dimension === "vendedor" ? movement.vendedorId : null),
                    vendedorName: shouldGroupByDate ? null : (dimension === "vendedor" ? (movement.vendedorName || "Desconocido") : null),
                    vendedorCode: shouldGroupByDate ? null : (dimension === "vendedor" ? movement.vendedorCode : null),
                    totalSales: 0,
                    totalPayouts: 0,
                    totalTickets: new Set<string>(),
                    commissionListero: 0,
                    commissionVendedor: 0,
                    payoutTickets: new Set<string>(),
                });
            }
        }
    }

    // Obtener desglose por sorteo
    // ✅ CRÍTICO: Si shouldGroupByDate=true, las claves son solo fechas; si no, son fecha_entidad
    const statementDates = Array.from(new Set(
        Array.from(byDateAndDimension.keys()).map(k => {
            // Si shouldGroupByDate=true, la clave es solo la fecha; si no, extraer fecha de fecha_entidad
            const dateStr = shouldGroupByDate ? k : k.split("_")[0];
            return dateStr;
        })
    )).map(d => {
        const [year, month, day] = d.split('-').map(Number);
        return new Date(Date.UTC(year, month - 1, day));
    });

    const sorteoBreakdownBatch = await getSorteoBreakdownBatch(statementDates, dimension, ventanaId, vendedorId, bancaId, userRole);

    // ✅ DEBUG: Log para verificar el mapa antes de construir statements
    logger.info({
        layer: "service",
        action: "ACCOUNT_STATEMENT_MAP_BEFORE_CONSTRUCTION",
        payload: {
            shouldGroupByDate,
            mapKeys: Array.from(byDateAndDimension.keys()),
            mapSize: byDateAndDimension.size,
        },
    });

    // Construir statements desde el mapa agrupado
    // ✅ CRÍTICO: Filtrar solo fechas dentro del período solicitado
    // Nota: startDateCRStr y endDateCRStr ya están declaradas arriba (línea 359-360)
    const statements = Array.from(byDateAndDimension.entries())
        .filter(([key]) => {
            // ✅ NUEVO: Si shouldGroupByDate=true, la clave es solo la fecha; si no, es fecha_entidad
            const date = shouldGroupByDate ? key : key.split("_")[0];
            // Solo incluir fechas dentro del período filtrado
            return date >= startDateCRStr && date <= endDateCRStr;
        })
        .map(([key, entry]) => {
        // ✅ NUEVO: Si shouldGroupByDate=true, la clave es solo la fecha; si no, es fecha_entidad
        const date = shouldGroupByDate ? key : key.split("_")[0];

        // ✅ NUEVO: Obtener movimientos y desglose por sorteo según si hay agrupación
        const allMovementsForDate = movementsByDate.get(date) || [];
        let movements: any[];
        let bySorteo: any[];

        if (shouldGroupByDate) {
            // Cuando hay agrupación, incluir TODOS los movimientos de la fecha (sin filtrar por entidad)
            movements = allMovementsForDate;
            
            // ✅ NUEVO: Agrupar bySorteo por fecha solamente (sumar todos los sorteos de todas las entidades)
            // sorteoBreakdownBatch es un Map<string, Array<...>> donde la clave es `${date}_${ventanaId}` o `${date}_${vendedorId}`
            const sorteoMap = new Map<string, any>();
            for (const [sorteoKey, sorteoDataArray] of sorteoBreakdownBatch.entries()) {
                const sorteoDate = sorteoKey.split("_")[0];
                if (sorteoDate === date) {
                    // sorteoDataArray es un array de sorteos para esta fecha y entidad
                    for (const sorteoData of sorteoDataArray) {
                        const sorteoId = sorteoData.sorteoId;
                        if (sorteoId) {
                            const existing = sorteoMap.get(sorteoId);
                            if (existing) {
                                // Sumar campos numéricos
                                existing.sales += sorteoData.sales;
                                existing.payouts += sorteoData.payouts;
                                existing.listeroCommission += sorteoData.listeroCommission;
                                existing.vendedorCommission += sorteoData.vendedorCommission;
                                // ✅ CORRECCIÓN: Balance siempre usando listeroCommission
                                existing.balance = existing.sales - existing.payouts - existing.listeroCommission;
                                existing.ticketCount += sorteoData.ticketCount;
                            } else {
                                sorteoMap.set(sorteoId, {
                                    sorteoId: sorteoData.sorteoId,
                                    sorteoName: sorteoData.sorteoName,
                                    loteriaId: sorteoData.loteriaId,
                                    loteriaName: sorteoData.loteriaName,
                                    scheduledAt: sorteoData.scheduledAt,
                                    sales: sorteoData.sales,
                                    payouts: sorteoData.payouts,
                                    listeroCommission: sorteoData.listeroCommission,
                                    vendedorCommission: sorteoData.vendedorCommission,
                                    // ✅ CORRECCIÓN: Balance siempre usando listeroCommission
                                    balance: sorteoData.sales - sorteoData.payouts - sorteoData.listeroCommission,
                                    ticketCount: sorteoData.ticketCount,
                                });
                            }
                        }
                    }
                }
            }
            bySorteo = Array.from(sorteoMap.values()).sort((a, b) => 
                new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime()
            );
        } else {
            // Sin agrupación: comportamiento original (filtrar por entidad)
            movements = allMovementsForDate.filter((m: any) => {
                if (dimension === "banca") {
                    return m.bancaId === entry.bancaId;
                } else if (dimension === "ventana") {
                    return m.ventanaId === entry.ventanaId;
                } else {
                    return m.vendedorId === entry.vendedorId;
                }
            });
            // Obtener desglose por sorteo usando clave según dimensión
            const sorteoKey = dimension === "banca"
                ? `${date}_${entry.bancaId || 'null'}`
                : dimension === "ventana"
                ? `${date}_${entry.ventanaId}`
                : `${date}_${entry.vendedorId || 'null'}`;
            bySorteo = sorteoBreakdownBatch.get(sorteoKey) || [];
        }

        // ✅ CRÍTICO: Calcular totalPayouts sumando desde bySorteo en lugar de la query SQL
        // Esto evita la multiplicación por número de jugadas que ocurría en el JOIN
        const totalPayouts = bySorteo.reduce((sum: number, sorteo: any) => sum + (sorteo.payouts || 0), 0);

        // (DEPRECADO) CORRECCIÓN: Balance SIEMPRE usando listeroCommission
        // El balance siempre debe calcularse restando las comisiones del listero,
        // independientemente del nivel de agrupación o filtrado (dimensión)
        // ✅ SE CORRIGE: balance = entry.totalSales - totalPayouts - entry.commissionVendedor
        const balance = entry.totalSales - totalPayouts - entry.commissionVendedor;

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
            bancaId: entry.bancaId, // ✅ NUEVO: Solo si dimension='banca' o si hay filtro por banca
            bancaName: entry.bancaName, // ✅ NUEVO
            bancaCode: entry.bancaCode, // ✅ NUEVO
            ventanaId: entry.ventanaId,
            ventanaName: entry.ventanaName,
            ventanaCode: entry.ventanaCode, // ✅ NUEVO: Código de ventana
            vendedorId: entry.vendedorId,
            vendedorName: entry.vendedorName,
            vendedorCode: entry.vendedorCode, // ✅ NUEVO: Código de vendedor
            totalSales: parseFloat(entry.totalSales.toFixed(2)),
            totalPayouts: parseFloat(totalPayouts.toFixed(2)),
            listeroCommission: parseFloat(entry.commissionListero.toFixed(2)),
            vendedorCommission: parseFloat(entry.commissionVendedor.toFixed(2)),
            balance: parseFloat(balance.toFixed(2)),
            totalPaid: parseFloat(totalPaid.toFixed(2)),
            totalCollected: parseFloat(totalCollected.toFixed(2)),
            totalPaymentsCollections: parseFloat((totalPaid + totalCollected).toFixed(2)),
            remainingBalance: parseFloat(remainingBalance.toFixed(2)),
            isSettled: calculateIsSettled(entry.totalTickets.size, remainingBalance, totalPaid, totalCollected),
            canEdit: !calculateIsSettled(entry.totalTickets.size, remainingBalance, totalPaid, totalCollected),
            ticketCount: entry.totalTickets.size,
            bySorteo,
            movements,
        };

        // ✅ NUEVO: Agregar desglose por entidad cuando hay agrupación
        if (shouldGroupByDate) {
            if (dimension === "banca") {
                // ✅ NUEVO: Construir byBanca desde breakdownByEntity
                const bancaBreakdown: any[] = [];
                // Agrupar breakdowns por banca
                const bancaMap = new Map<string, {
                    bancaId: string;
                    bancaName: string;
                    bancaCode: string | null;
                    ventanas: Map<string, any>;
                    vendedores: Map<string, any>;
                    totalSales: number;
                    totalPayouts: number;
                    commissionListero: number;
                    commissionVendedor: number;
                    totalTickets: Set<string>;
                }>();

                for (const [breakdownKey, breakdownEntry] of breakdownByEntity.entries()) {
                    const breakdownDate = breakdownKey.split("_")[0];
                    if (breakdownDate === date && breakdownEntry.bancaId) {
                        // ✅ CRÍTICO: Calcular totalPayouts desde sorteos para este breakdown
                        // Dentro de dimension="banca", los breakdowns pueden ser por ventana o vendedor
                        const breakdownSorteoKey = breakdownEntry.vendedorId
                            ? `${date}_${breakdownEntry.vendedorId}`
                            : `${date}_${breakdownEntry.ventanaId}`;
                        const breakdownSorteos = sorteoBreakdownBatch.get(breakdownSorteoKey) || [];
                        const breakdownTotalPayouts = breakdownSorteos.reduce((sum: number, sorteo: any) => sum + (sorteo.payouts || 0), 0);

                        let bancaGroup = bancaMap.get(breakdownEntry.bancaId);
                        if (!bancaGroup) {
                            bancaGroup = {
                                bancaId: breakdownEntry.bancaId,
                                bancaName: breakdownEntry.bancaName || "Desconocido",
                                bancaCode: breakdownEntry.bancaCode,
                                ventanas: new Map(),
                                vendedores: new Map(),
                                totalSales: 0,
                                totalPayouts: 0,
                                commissionListero: 0,
                                commissionVendedor: 0,
                                totalTickets: new Set<string>(),
                            };
                            bancaMap.set(breakdownEntry.bancaId, bancaGroup);
                        }

                        // Agregar a totales de banca
                        bancaGroup.totalSales += breakdownEntry.totalSales;
                        bancaGroup.totalPayouts += breakdownTotalPayouts;
                        bancaGroup.commissionListero += breakdownEntry.commissionListero;
                        bancaGroup.commissionVendedor += breakdownEntry.commissionVendedor;
                        breakdownEntry.totalTickets.forEach(id => bancaGroup.totalTickets.add(id));

                        // Agrupar por ventana dentro de esta banca
                        if (breakdownEntry.ventanaId) {
                            const ventanaKey = breakdownEntry.ventanaId;
                            let ventanaGroup = bancaGroup.ventanas.get(ventanaKey);
                            if (!ventanaGroup) {
                                ventanaGroup = {
                                    ventanaId: breakdownEntry.ventanaId,
                                    ventanaName: breakdownEntry.ventanaName || "Desconocido",
                                    ventanaCode: breakdownEntry.ventanaCode,
                                    totalSales: 0,
                                    totalPayouts: 0,
                                    commissionListero: 0,
                                    commissionVendedor: 0,
                                    totalTickets: new Set<string>(),
                                };
                                bancaGroup.ventanas.set(ventanaKey, ventanaGroup);
                            }
                            ventanaGroup.totalSales += breakdownEntry.totalSales;
                            ventanaGroup.totalPayouts += breakdownTotalPayouts;
                            ventanaGroup.commissionListero += breakdownEntry.commissionListero;
                            ventanaGroup.commissionVendedor += breakdownEntry.commissionVendedor;
                            breakdownEntry.totalTickets.forEach(id => ventanaGroup.totalTickets.add(id));
                        }

                        // Agrupar por vendedor dentro de esta banca
                        if (breakdownEntry.vendedorId) {
                            const vendedorKey = breakdownEntry.vendedorId;
                            let vendedorGroup = bancaGroup.vendedores.get(vendedorKey);
                            if (!vendedorGroup) {
                                vendedorGroup = {
                                    vendedorId: breakdownEntry.vendedorId,
                                    vendedorName: breakdownEntry.vendedorName || "Desconocido",
                                    vendedorCode: breakdownEntry.vendedorCode,
                                    ventanaId: breakdownEntry.ventanaId,
                                    ventanaName: breakdownEntry.ventanaName || "Desconocido",
                                    ventanaCode: breakdownEntry.ventanaCode,
                                    totalSales: 0,
                                    totalPayouts: 0,
                                    commissionListero: 0,
                                    commissionVendedor: 0,
                                    totalTickets: new Set<string>(),
                                };
                                bancaGroup.vendedores.set(vendedorKey, vendedorGroup);
                            }
                            vendedorGroup.totalSales += breakdownEntry.totalSales;
                            vendedorGroup.totalPayouts += breakdownTotalPayouts;
                            vendedorGroup.commissionListero += breakdownEntry.commissionListero;
                            vendedorGroup.commissionVendedor += breakdownEntry.commissionVendedor;
                            breakdownEntry.totalTickets.forEach(id => vendedorGroup.totalTickets.add(id));
                        }
                    }
                }

                // Construir byBanca con byVentana y byVendedor
                for (const [bancaId, bancaGroup] of bancaMap.entries()) {
                    const bancaBalance = bancaGroup.totalSales - bancaGroup.totalPayouts - bancaGroup.commissionListero;
                    const bancaMovements = allMovementsForDate.filter((m: any) => m.bancaId === bancaId);
                    const bancaTotalPaid = bancaMovements
                        .filter((m: any) => m.type === "payment" && !m.isReversed)
                        .reduce((sum: number, m: any) => sum + m.amount, 0);
                    const bancaTotalCollected = bancaMovements
                        .filter((m: any) => m.type === "collection" && !m.isReversed)
                        .reduce((sum: number, m: any) => sum + m.amount, 0);
                    const bancaRemainingBalance = bancaBalance - bancaTotalCollected + bancaTotalPaid;

                    // Construir byVentana para esta banca
                    const byVentana: any[] = [];
                    for (const [ventanaId, ventanaGroup] of bancaGroup.ventanas.entries()) {
                        const ventanaBalance = ventanaGroup.totalSales - ventanaGroup.totalPayouts - ventanaGroup.commissionListero;
                        const ventanaMovements = allMovementsForDate.filter((m: any) => m.ventanaId === ventanaId);
                        const ventanaTotalPaid = ventanaMovements
                            .filter((m: any) => m.type === "payment" && !m.isReversed)
                            .reduce((sum: number, m: any) => sum + m.amount, 0);
                        const ventanaTotalCollected = ventanaMovements
                            .filter((m: any) => m.type === "collection" && !m.isReversed)
                            .reduce((sum: number, m: any) => sum + m.amount, 0);
                        const ventanaRemainingBalance = ventanaBalance - ventanaTotalCollected + ventanaTotalPaid;
                        const ventanaSorteoKey = `${date}_${ventanaId}`;
                        const ventanaSorteos = sorteoBreakdownBatch.get(ventanaSorteoKey) || [];

                        byVentana.push({
                            ventanaId: ventanaGroup.ventanaId,
                            ventanaName: ventanaGroup.ventanaName,
                            ventanaCode: ventanaGroup.ventanaCode,
                            bancaId: bancaGroup.bancaId, // ✅ NUEVO: ID de banca
                            bancaName: bancaGroup.bancaName, // ✅ NUEVO: Nombre de banca
                            totalSales: ventanaGroup.totalSales,
                            totalPayouts: ventanaGroup.totalPayouts,
                            listeroCommission: ventanaGroup.commissionListero,
                            vendedorCommission: ventanaGroup.commissionVendedor,
                            balance: ventanaBalance,
                            totalPaid: ventanaTotalPaid,
                            totalCollected: ventanaTotalCollected,
                            remainingBalance: ventanaRemainingBalance,
                            ticketCount: ventanaGroup.totalTickets.size,
                            bySorteo: ventanaSorteos,
                            movements: ventanaMovements,
                        });
                    }

                    // Construir byVendedor para esta banca
                    const byVendedor: any[] = [];
                    for (const [vendedorId, vendedorGroup] of bancaGroup.vendedores.entries()) {
                        // ✅ CORRECCIÓN: Balance de vendedor usando vendedorCommission
                        const vendedorBalance = vendedorGroup.totalSales - vendedorGroup.totalPayouts - vendedorGroup.commissionVendedor;
                        const vendedorMovements = allMovementsForDate.filter((m: any) => m.vendedorId === vendedorId);
                        const vendedorTotalPaid = vendedorMovements
                            .filter((m: any) => m.type === "payment" && !m.isReversed)
                            .reduce((sum: number, m: any) => sum + m.amount, 0);
                        const vendedorTotalCollected = vendedorMovements
                            .filter((m: any) => m.type === "collection" && !m.isReversed)
                            .reduce((sum: number, m: any) => sum + m.amount, 0);
                        const vendedorRemainingBalance = vendedorBalance - vendedorTotalCollected + vendedorTotalPaid;
                        const vendedorSorteoKey = `${date}_${vendedorId || 'null'}`;
                        const vendedorSorteos = sorteoBreakdownBatch.get(vendedorSorteoKey) || [];

                        byVendedor.push({
                            vendedorId: vendedorGroup.vendedorId,
                            vendedorName: vendedorGroup.vendedorName,
                            vendedorCode: vendedorGroup.vendedorCode,
                            ventanaId: vendedorGroup.ventanaId,
                            ventanaName: vendedorGroup.ventanaName,
                            ventanaCode: vendedorGroup.ventanaCode,
                            bancaId: bancaGroup.bancaId, // ✅ NUEVO: ID de banca
                            bancaName: bancaGroup.bancaName, // ✅ NUEVO: Nombre de banca
                            totalSales: vendedorGroup.totalSales,
                            totalPayouts: vendedorGroup.totalPayouts,
                            listeroCommission: vendedorGroup.commissionListero,
                            vendedorCommission: vendedorGroup.commissionVendedor,
                            balance: vendedorBalance,
                            totalPaid: vendedorTotalPaid,
                            totalCollected: vendedorTotalCollected,
                            remainingBalance: vendedorRemainingBalance,
                            ticketCount: vendedorGroup.totalTickets.size,
                            bySorteo: vendedorSorteos,
                            movements: vendedorMovements,
                        });
                    }

                    bancaBreakdown.push({
                        bancaId: bancaGroup.bancaId,
                        bancaName: bancaGroup.bancaName,
                        bancaCode: bancaGroup.bancaCode,
                        totalSales: bancaGroup.totalSales,
                        totalPayouts: bancaGroup.totalPayouts,
                        listeroCommission: bancaGroup.commissionListero,
                        vendedorCommission: bancaGroup.commissionVendedor,
                        balance: bancaBalance,
                        totalPaid: bancaTotalPaid,
                        totalCollected: bancaTotalCollected,
                        remainingBalance: bancaRemainingBalance,
                        ticketCount: bancaGroup.totalTickets.size,
                        byVentana: byVentana.sort((a, b) => a.ventanaName.localeCompare(b.ventanaName)),
                        byVendedor: byVendedor.sort((a, b) => a.vendedorName.localeCompare(b.vendedorName)),
                        movements: bancaMovements,
                    });
                }
                statement.byBanca = bancaBreakdown.sort((a, b) => a.bancaName.localeCompare(b.bancaName));
            } else if (dimension === "ventana") {
                // Construir byVentana desde breakdownByEntity
                const ventanaBreakdown: any[] = [];
                for (const [breakdownKey, breakdownEntry] of breakdownByEntity.entries()) {
                    const breakdownDate = breakdownKey.split("_")[0];
                    if (breakdownDate === date) {
                        // ✅ CRÍTICO: Obtener sorteos específicos de esta ventana
                        const ventanaSorteoKey = `${date}_${breakdownEntry.ventanaId}`;
                        const ventanaSorteos = sorteoBreakdownBatch.get(ventanaSorteoKey) || [];

                        // ✅ CRÍTICO: Calcular totalPayouts sumando desde sorteos
                        const ventanaTotalPayouts = ventanaSorteos.reduce((sum: number, sorteo: any) => sum + (sorteo.payouts || 0), 0);

                        const breakdownBalance = breakdownEntry.totalSales - ventanaTotalPayouts - breakdownEntry.commissionListero;
                        // Calcular totalPaid y totalCollected para esta ventana en esta fecha
                        const ventanaMovements = allMovementsForDate.filter((m: any) => m.ventanaId === breakdownEntry.ventanaId);
                        const ventanaTotalPaid = ventanaMovements
                            .filter((m: any) => m.type === "payment" && !m.isReversed)
                            .reduce((sum: number, m: any) => sum + m.amount, 0);
                        const ventanaTotalCollected = ventanaMovements
                            .filter((m: any) => m.type === "collection" && !m.isReversed)
                            .reduce((sum: number, m: any) => sum + m.amount, 0);
                        const ventanaRemainingBalance = breakdownBalance - ventanaTotalCollected + ventanaTotalPaid;

                        // ✅ CRÍTICO: Obtener movimientos específicos de esta ventana
                        const ventanaMovementsFiltered = allMovementsForDate.filter((m: any) => m.ventanaId === breakdownEntry.ventanaId);

                        ventanaBreakdown.push({
                            ventanaId: breakdownEntry.ventanaId,
                            ventanaName: breakdownEntry.ventanaName,
                            ventanaCode: breakdownEntry.ventanaCode, // ✅ NUEVO: Código de ventana
                            bancaId: breakdownEntry.bancaId, // ✅ NUEVO: ID de banca (si está disponible)
                            bancaName: breakdownEntry.bancaName, // ✅ NUEVO: Nombre de banca (si está disponible)
                            totalSales: breakdownEntry.totalSales,
                            totalPayouts: ventanaTotalPayouts,
                            listeroCommission: breakdownEntry.commissionListero,
                            vendedorCommission: breakdownEntry.commissionVendedor,
                            balance: breakdownBalance,
                            totalPaid: ventanaTotalPaid,
                            totalCollected: ventanaTotalCollected,
                            remainingBalance: ventanaRemainingBalance,
                            ticketCount: breakdownEntry.totalTickets.size,
                            // ✅ CRÍTICO: Sorteos específicos de esta ventana (NO agrupados con otras ventanas)
                            bySorteo: ventanaSorteos,
                            // ✅ CRÍTICO: Movimientos específicos de esta ventana (NO agrupados con otras ventanas)
                            movements: ventanaMovementsFiltered,
                        });
                    }
                }
                statement.byVentana = ventanaBreakdown.sort((a, b) => a.ventanaName.localeCompare(b.ventanaName));
            } else {
                // Construir byVendedor desde breakdownByEntity
                const vendedorBreakdown: any[] = [];
                for (const [breakdownKey, breakdownEntry] of breakdownByEntity.entries()) {
                    const breakdownDate = breakdownKey.split("_")[0];
                    if (breakdownDate === date) {
                        // ✅ CRÍTICO: Obtener sorteos específicos de este vendedor
                        const vendedorSorteoKey = `${date}_${breakdownEntry.vendedorId || 'null'}`;
                        const vendedorSorteos = sorteoBreakdownBatch.get(vendedorSorteoKey) || [];

                        // ✅ CRÍTICO: Calcular totalPayouts sumando desde sorteos
                        const vendedorTotalPayouts = vendedorSorteos.reduce((sum: number, sorteo: any) => sum + (sorteo.payouts || 0), 0);

                        // ✅ CORRECCIÓN: Balance de vendedor usando vendedorCommission
                        const breakdownBalance = breakdownEntry.totalSales - vendedorTotalPayouts - breakdownEntry.commissionVendedor;
                        // Calcular totalPaid y totalCollected para este vendedor en esta fecha
                        const vendedorMovements = allMovementsForDate.filter((m: any) => m.vendedorId === breakdownEntry.vendedorId);
                        const vendedorTotalPaid = vendedorMovements
                            .filter((m: any) => m.type === "payment" && !m.isReversed)
                            .reduce((sum: number, m: any) => sum + m.amount, 0);
                        const vendedorTotalCollected = vendedorMovements
                            .filter((m: any) => m.type === "collection" && !m.isReversed)
                            .reduce((sum: number, m: any) => sum + m.amount, 0);
                        const vendedorRemainingBalance = breakdownBalance - vendedorTotalCollected + vendedorTotalPaid;

                        // ✅ CRÍTICO: Obtener movimientos específicos de este vendedor
                        const vendedorMovementsFiltered = allMovementsForDate.filter((m: any) => m.vendedorId === breakdownEntry.vendedorId);

                        vendedorBreakdown.push({
                            vendedorId: breakdownEntry.vendedorId,
                            vendedorName: breakdownEntry.vendedorName,
                            ventanaId: breakdownEntry.ventanaId,
                            ventanaName: breakdownEntry.ventanaName,
                            totalSales: breakdownEntry.totalSales,
                            totalPayouts: vendedorTotalPayouts,
                            listeroCommission: breakdownEntry.commissionListero,
                            vendedorCommission: breakdownEntry.commissionVendedor,
                            balance: breakdownBalance,
                            totalPaid: vendedorTotalPaid,
                            totalCollected: vendedorTotalCollected,
                            remainingBalance: vendedorRemainingBalance,
                            ticketCount: breakdownEntry.totalTickets.size,
                            // ✅ CRÍTICO: Sorteos específicos de este vendedor (NO agrupados con otros vendedores)
                            bySorteo: vendedorSorteos,
                            // ✅ CRÍTICO: Movimientos específicos de este vendedor (NO agrupados con otros vendedores)
                            movements: vendedorMovementsFiltered,
                        });
                    }
                }
                statement.byVendedor = vendedorBreakdown.sort((a, b) => a.vendedorName.localeCompare(b.vendedorName));
            }
            // Cuando hay agrupación, bancaId/ventanaId/vendedorId son null según dimensión
            if (dimension === "banca") {
                statement.bancaId = null;
                statement.bancaName = null;
                statement.bancaCode = null;
            }
            statement.ventanaId = null;
            statement.ventanaName = null;
            statement.ventanaCode = null;
            statement.vendedorId = null;
            statement.vendedorName = null;
            statement.vendedorCode = null;
        } else {
            // Sin agrupación: comportamiento original
            if (dimension === "banca") {
                statement.bancaId = entry.bancaId;
                statement.bancaName = entry.bancaName;
                statement.bancaCode = entry.bancaCode;
            } else if (dimension === "ventana") {
                statement.ventanaId = entry.ventanaId;
                statement.ventanaName = entry.ventanaName;
                statement.ventanaCode = entry.ventanaCode;
            } else {
                statement.vendedorId = entry.vendedorId;
                statement.vendedorName = entry.vendedorName;
                statement.vendedorCode = entry.vendedorCode;
            }
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
    // (DEPRECADO) CORRECCIÓN: Balance total SIEMPRE usando listeroCommission
    // El balance siempre debe calcularse restando las comisiones del listero,
    // independientemente del nivel de agrupación o filtrado (dimensión)
    // Esto asegura consistencia con monthlyTotalBalance y refleja que el listero
    // es quien asume la responsabilidad financiera de los tickets
    // ✅ CRÍTICO: Balance total usando vendedorCommission
    const totalBalance = totalSales - totalPayouts - totalVendedorCommission;
    const totalPaid = statements.reduce((sum, s) => sum + s.totalPaid, 0);
    const totalCollected = statements.reduce((sum, s) => sum + s.totalCollected, 0);
    // ✅ CRÍTICO: Calcular totalRemainingBalance desde los totales agregados, NO sumando remainingBalance individuales
    // Esto asegura consistencia matemática: remainingBalance = balance - totalCollected + totalPaid
    const totalRemainingBalance = totalBalance - totalCollected + totalPaid;



    // ✅ NUEVO: Calcular monthlyAccumulated (acumulado del mes COMPLETO)
    // Esto es INMUTABLE respecto al período filtrado (siempre es el mes completo)
    const [year, month] = effectiveMonth.split("-").map(Number);
    const monthStartDate = new Date(Date.UTC(year, month - 1, 1)); // Primer día del mes
    const monthEndDate = new Date(Date.UTC(year, month, 0)); // Último día del mes
    const monthStartDateCRStr = crDateService.dateUTCToCRString(monthStartDate);
    const monthEndDateCRStr = crDateService.dateUTCToCRString(monthEndDate);

    // Construir WHERE conditions para el mes completo
    const monthlyWhereConditions: Prisma.Sql[] = [
        Prisma.sql`t."deletedAt" IS NULL`,
        Prisma.sql`t."isActive" = true`,
        Prisma.sql`t.status IN ('ACTIVE', 'EVALUATED', 'PAID', 'PAGADO')`,
        Prisma.sql`COALESCE(t."businessDate", DATE((t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica'))) >= ${monthStartDateCRStr}::date`,
        Prisma.sql`COALESCE(t."businessDate", DATE((t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica'))) <= ${monthEndDateCRStr}::date`,
        // ✅ NUEVO: Excluir sorteos CLOSED para no incluir datos de sorteos finalizados (mismo filtro que dashboard)
        Prisma.sql`NOT EXISTS (
            SELECT 1 FROM "Sorteo" s
            WHERE s.id = t."sorteoId"
            AND s.status = 'CLOSED'
        )`,
        // ✅ NUEVO: Excluir tickets de listas bloqueadas (Lista Exclusion)
        Prisma.sql`NOT EXISTS (
            SELECT 1 FROM "sorteo_lista_exclusion" sle
            WHERE sle.sorteo_id = t."sorteoId"
            AND sle.ventana_id = t."ventanaId"
            AND (sle.vendedor_id IS NULL OR sle.vendedor_id = t."vendedorId")
        )`,
    ];

    // Reutilizar filtros RBAC/banca
    if (bancaId) {
        monthlyWhereConditions.push(Prisma.sql`EXISTS (
      SELECT 1 FROM "Ventana" v
      WHERE v.id = t."ventanaId"
      AND v."bancaId" = ${bancaId}::uuid
    )`);
    }

    if (dimension === "vendedor") {
        if (vendedorId) {
            monthlyWhereConditions.push(Prisma.sql`t."vendedorId" = ${vendedorId}::uuid`);
        }
        if (ventanaId) {
            monthlyWhereConditions.push(Prisma.sql`t."ventanaId" = ${ventanaId}::uuid`);
        }
    } else if (dimension === "ventana") {
        if (ventanaId) {
            monthlyWhereConditions.push(Prisma.sql`t."ventanaId" = ${ventanaId}::uuid`);
        }
    }

    const monthlyWhereClause = Prisma.sql`WHERE ${Prisma.join(monthlyWhereConditions, " AND ")}`;

    // ✅ OPTIMIZACIÓN: Log de rendimiento para consulta mensual
    const monthlyQueryStartTime = Date.now();
    logger.info({
        layer: "service",
        action: "ACCOUNT_STATEMENT_MONTHLY_QUERY_START",
        payload: {
            dimension,
            bancaId,
            ventanaId,
            vendedorId,
            month: effectiveMonth,
        },
    });
    
    // Obtener jugadas del mes completo
    const monthlyJugadas = await prisma.$queryRaw<
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
            commission_amount: number | null;
            listero_commission_amount: number | null;
            commission_origin: string;
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
    ${monthlyWhereClause}
    AND j."deletedAt" IS NULL
    LIMIT 50000 -- ✅ CRÍTICO: Limitar resultados para prevenir consultas masivas del mes completo
  `;
    
    const monthlyQueryEndTime = Date.now();
    logger.info({
        layer: "service",
        action: "ACCOUNT_STATEMENT_MONTHLY_QUERY_END",
        payload: {
            dimension,
            bancaId,
            ventanaId,
            vendedorId,
            month: effectiveMonth,
            rowsReturned: monthlyJugadas.length,
            queryTimeMs: monthlyQueryEndTime - monthlyQueryStartTime,
        },
    });

    // Agrupar jugadas del mes por día y dimensión
    const monthlyByDateAndDimension = new Map<
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

    // Procesar jugadas del mes (misma lógica que periodo filtrado)
    for (const jugada of monthlyJugadas) {
        // ✅ CORREGIDO: Usar listeroCommissionAmount directamente de Jugada (igual que dashboard)
        // Esto asegura consistencia entre ambos endpoints
        const commissionListeroFinal = Number(jugada.listero_commission_amount || 0);
        const dateKey = crDateService.postgresDateToCRString(jugada.business_date);
        const key = dimension === "ventana"
            ? `${dateKey}_${jugada.ventana_id}`
            : `${dateKey}_${jugada.vendedor_id || 'null'}`;

        let entry = monthlyByDateAndDimension.get(key);
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
            monthlyByDateAndDimension.set(key, entry);
        }

        entry.totalSales += jugada.amount;
        entry.totalTickets.add(jugada.ticket_id);
        entry.commissionListero += commissionListeroFinal;
        if (jugada.commission_origin === "USER") {
            entry.commissionVendedor += Number(jugada.commission_amount || 0);
        }
        if (!entry.payoutTickets.has(jugada.ticket_id)) {
            entry.totalPayouts += Number(jugada.ticket_total_payout || 0);
            entry.payoutTickets.add(jugada.ticket_id);
        }
    }

    // Calcular movimientos del mes completo
    const monthlyMovementsByDate = await AccountPaymentRepository.findMovementsByDateRange(
        monthStartDate,
        monthEndDate,
        dimension,
        ventanaId,
        vendedorId,
        bancaId
    );

    // ✅ NUEVO: Incorporar días que solo tienen movimientos al mapa mensual
    for (const [dateKey, movements] of monthlyMovementsByDate.entries()) {
        for (const movement of movements) {
            const targetId = dimension === "ventana" ? movement.ventanaId : movement.vendedorId;
            if (dimension === "ventana" && ventanaId && targetId !== ventanaId) continue;
            if (dimension === "vendedor" && vendedorId && targetId !== vendedorId) continue;

            const key = `${dateKey}_${targetId || 'null'}`;

            if (!monthlyByDateAndDimension.has(key)) {
                monthlyByDateAndDimension.set(key, {
                    ventanaId: movement.ventanaId,
                    ventanaName: movement.ventanaName || "Desconocido",
                    vendedorId: movement.vendedorId,
                    vendedorName: movement.vendedorName || "Desconocido",
                    totalSales: 0,
                    totalPayouts: 0,
                    totalTickets: new Set<string>(),
                    commissionListero: 0,
                    commissionVendedor: 0,
                    payoutTickets: new Set<string>(),
                });
            }
        }
    }

    // Calcular totales mensuales
    const monthlyTotalSales = Array.from(monthlyByDateAndDimension.values()).reduce(
        (sum, entry) => sum + entry.totalSales,
        0
    );
    const monthlyTotalPayouts = Array.from(monthlyByDateAndDimension.values()).reduce(
        (sum, entry) => sum + entry.totalPayouts,
        0
    );
    const monthlyTotalListeroCommission = Array.from(monthlyByDateAndDimension.values()).reduce(
        (sum, entry) => sum + entry.commissionListero,
        0
    );
    const monthlyTotalVendedorCommission = Array.from(monthlyByDateAndDimension.values()).reduce(
        (sum, entry) => sum + entry.commissionVendedor,
        0
    );
    //  (DEPRECADO) CORRECCIÓN: Balance total mensual siempre usando listeroCommission
    // El balance siempre debe calcularse restando las comisiones del listero,
    // independientemente del nivel de agrupación o filtrado
    // monthlyTotalBalance = monthlyTotalSales - monthlyTotalPayouts - monthlyTotalListeroCommission
    // ✅ SE CORRIGE: monthlyTotalBalance = monthlyTotalSales - monthlyTotalPayouts - monthlyTotalVendedorCommission
    const monthlyTotalBalance = monthlyTotalSales - monthlyTotalPayouts - monthlyTotalVendedorCommission;

    // Calcular totales de pagos/cobros del mes
    let monthlyTotalPaid = 0;
    let monthlyTotalCollected = 0;
    for (const movements of monthlyMovementsByDate.values()) {
        monthlyTotalPaid += movements
            .filter((m: any) => m.type === "payment" && !m.isReversed)
            .reduce((sum: number, m: any) => sum + m.amount, 0);
        monthlyTotalCollected += movements
            .filter((m: any) => m.type === "collection" && !m.isReversed)
            .reduce((sum: number, m: any) => sum + m.amount, 0);
    }

    // Contar días saldados en el mes
    const monthlySettledDays = Array.from(monthlyByDateAndDimension.entries())
        .filter(([key, entry]) => {
            const date = key.split("_")[0];
            // Obtener movimientos específicos para esta entrada (fecha + dimensión)
            const allMovements = monthlyMovementsByDate.get(date) || [];
            const movements = allMovements.filter((m: any) => {
                if (dimension === "ventana") return m.ventanaId === entry.ventanaId;
                else return m.vendedorId === entry.vendedorId;
            });

            const totalPaid = movements
                .filter((m: any) => m.type === "payment" && !m.isReversed)
                .reduce((sum: number, m: any) => sum + m.amount, 0);
            const totalCollected = movements
                .filter((m: any) => m.type === "collection" && !m.isReversed)
                .reduce((sum: number, m: any) => sum + m.amount, 0);

            // ✅ CORRECCIÓN: Balance según dimensión
            const commission = dimension === "vendedor" ? entry.commissionVendedor : entry.commissionListero;
            const remainingBalance = entry.totalSales - entry.totalPayouts - commission - totalCollected + totalPaid;
            return calculateIsSettled(entry.totalTickets.size, remainingBalance, totalPaid, totalCollected);
        }).length;
    const monthlyPendingDays = monthlyByDateAndDimension.size - monthlySettledDays;

    // ✅ CRÍTICO: Calcular monthlyRemainingBalance desde los totales agregados del mes
    // Esto asegura consistencia matemática: remainingBalance = balance - totalCollected + totalPaid
    const monthlyRemainingBalance = monthlyTotalBalance - monthlyTotalCollected + monthlyTotalPaid;

    const monthlyAccumulated: StatementTotals = {
        totalSales: parseFloat(monthlyTotalSales.toFixed(2)),
        totalPayouts: parseFloat(monthlyTotalPayouts.toFixed(2)),
        totalBalance: parseFloat(monthlyTotalBalance.toFixed(2)),
        totalPaid: parseFloat(monthlyTotalPaid.toFixed(2)),
        totalCollected: parseFloat(monthlyTotalCollected.toFixed(2)),
        totalRemainingBalance: parseFloat(monthlyRemainingBalance.toFixed(2)),
        settledDays: monthlySettledDays,
        pendingDays: monthlyPendingDays,
    };

    const functionEndTime = Date.now();
    logger.info({
        layer: "service",
        action: "GET_STATEMENT_DIRECT_END",
        payload: {
            dimension,
            bancaId,
            ventanaId,
            vendedorId,
            statementsCount: statements.length,
            totalTimeMs: functionEndTime - functionStartTime,
        },
    });
    
    return {
        statements,
        totals: {
            totalSales: parseFloat(totalSales.toFixed(2)),
            totalPayouts: parseFloat(totalPayouts.toFixed(2)),
            totalListeroCommission: parseFloat(totalListeroCommission.toFixed(2)),
            totalVendedorCommission: parseFloat(totalVendedorCommission.toFixed(2)),
            totalBalance: parseFloat(totalBalance.toFixed(2)),
            totalPaid: parseFloat(totalPaid.toFixed(2)),
            totalCollected: parseFloat(totalCollected.toFixed(2)),
            totalRemainingBalance: parseFloat(totalRemainingBalance.toFixed(2)),
            settledDays: statements.filter(s => s.isSettled).length,
            pendingDays: statements.filter(s => !s.isSettled).length,
        },
        monthlyAccumulated,  // ✅ NUEVO: Saldo a Hoy (acumulado del mes)
        meta: {
            month: effectiveMonth,
            startDate: startDateCRStr,
            endDate: endDateCRStr,
            dimension,
            totalDays: daysInMonth,
            monthStartDate: crDateService.dateUTCToCRString(monthStartDate),
            monthEndDate: crDateService.dateUTCToCRString(monthEndDate),
        },
    };
}

/**
 * Helper para obtener IDs de tickets excluidos en una fecha específica
 * Basado en la tabla sorteo_lista_exclusion
 */
async function getExcludedTicketIdsForDate(date: Date): Promise<string[]> {
    // Convertir fecha a string YYYY-MM-DD para comparación SQL
    // Nota: date viene como objeto Date UTC (00:00:00Z) que representa el día
    const dateStr = crDateService.dateUTCToCRString(date);

    const excludedIds = await prisma.$queryRaw<{ id: string }[]>`
      SELECT t.id
      FROM "Ticket" t
      JOIN "sorteo_lista_exclusion" sle ON sle.sorteo_id = t."sorteoId"
      WHERE
        (
          t."businessDate" = ${date}::date
          OR (
            t."businessDate" IS NULL
            AND DATE(t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica') = ${date}::date
          )
        )
        AND sle.ventana_id = t."ventanaId"
        AND (sle.vendedor_id IS NULL OR sle.vendedor_id = t."vendedorId")
    `;

    return excludedIds.map(r => r.id);
}