import { Role, Prisma } from "@prisma/client";
import prisma from "../../../../core/prismaClient";
import logger from "../../../../core/logger";
import { AccountPaymentRepository } from "../../../../repositories/accountPayment.repository";
import { buildTicketDateFilter } from "./accounts.dates.utils";
import { crDateService } from "../../../../utils/crDateService";
import { isExclusionListEmpty } from "../../../../core/exclusionListCache";



/**
 * Interface para los resultados de la consulta agregada de tickets
 */
export interface AggregatedTicketRow {
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
}

/**
 *  OPTIMIZACIÓN: Obtiene datos agregados de tickets directamente desde SQL
 * Centraliza la lógica de filtrado y agrupación para el estado de cuenta directo
 */
export async function getAggregatedTicketsData(params: {
    startDate: Date;
    endDate: Date;
    dimension: "banca" | "ventana" | "vendedor";
    bancaId?: string;
    ventanaId?: string;
    vendedorId?: string;
    daysInMonth: number;
    shouldGroupByDate?: boolean;
    sort?: "asc" | "desc";
    isToday?: boolean;
    monthStartDateForQuery?: string;
}): Promise<AggregatedTicketRow[]> {
    const {
        startDate,
        endDate,
        dimension,
        bancaId,
        ventanaId,
        vendedorId,
        daysInMonth,
        shouldGroupByDate = false,
        sort = "desc",
        isToday = false,
        monthStartDateForQuery
    } = params;

    const whereConditions: Prisma.Sql[] = [
        Prisma.sql`t."deletedAt" IS NULL`,
        Prisma.sql`t."isActive" = true`,
        Prisma.sql`t."status" IN ('EVALUATED', 'PAID', 'PAGADO')`, // Excluir ACTIVE
        Prisma.sql`EXISTS (
            SELECT 1 FROM "Sorteo" s
            WHERE s.id = t."sorteoId"
            AND s.status = 'EVALUATED'
        )`,
    ];

    const { startDateCRStr, endDateCRStr } = crDateService.dateRangeUTCToCRStrings(startDate, endDate);

    // Lógica de fecha (Today vs Mes completo)
    if (isToday) {
        whereConditions.push(Prisma.sql`t."businessDate" = ${startDateCRStr}::date`);
    } else if (monthStartDateForQuery) {
        whereConditions.push(Prisma.sql`t."businessDate" >= ${monthStartDateForQuery}::date`);
    } else {
        whereConditions.push(Prisma.sql`t."businessDate" >= ${startDateCRStr}::date`);
    }

    whereConditions.push(Prisma.sql`t."businessDate" <= ${endDateCRStr}::date`);

    // Excluir tickets de listas bloqueadas (solo si hay exclusiones activas)
    if (!await isExclusionListEmpty()) {
        whereConditions.push(Prisma.sql`NOT EXISTS (
            SELECT 1 FROM "sorteo_lista_exclusion" sle
            WHERE sle.sorteo_id = t."sorteoId"
            AND sle.ventana_id = t."ventanaId"
            AND (sle.vendedor_id IS NULL OR sle.vendedor_id = t."vendedorId")
            AND (
                sle.multiplier_id IS NULL
                OR EXISTS (
                    SELECT 1 FROM "Jugada" j
                    WHERE j."ticketId" = t.id
                    AND j."multiplierId" = sle.multiplier_id
                    AND j."deletedAt" IS NULL
                )
            )
        )`);
    }

    // Aplicar filtros según dimension
    if (dimension === "banca") {
        if (bancaId) {
            whereConditions.push(Prisma.sql`EXISTS (
                SELECT 1 FROM "Ventana" v 
                WHERE v.id = t."ventanaId" 
                AND v."bancaId" = ${bancaId}::uuid
            )`);
        }
        if (ventanaId) {
            whereConditions.push(Prisma.sql`t."ventanaId" = ${ventanaId}::uuid`);
        }
        if (vendedorId) {
            whereConditions.push(Prisma.sql`t."vendedorId" = ${vendedorId}::uuid`);
        }
    } else if (dimension === "vendedor") {
        if (vendedorId) whereConditions.push(Prisma.sql`t."vendedorId" = ${vendedorId}::uuid`);
        if (ventanaId) whereConditions.push(Prisma.sql`t."ventanaId" = ${ventanaId}::uuid`);
        if (bancaId) {
            whereConditions.push(Prisma.sql`EXISTS (
                SELECT 1 FROM "Ventana" v 
                JOIN "User" u ON u."ventanaId" = v.id
                WHERE u.id = t."vendedorId"
                AND v."bancaId" = ${bancaId}::uuid
            )`);
        }
    } else if (dimension === "ventana") {
        if (ventanaId) whereConditions.push(Prisma.sql`t."ventanaId" = ${ventanaId}::uuid`);
        if (bancaId) {
            whereConditions.push(Prisma.sql`EXISTS (
                SELECT 1 FROM "Ventana" v 
                WHERE v.id = t."ventanaId" 
                AND v."bancaId" = ${bancaId}::uuid
            )`);
        }
        if (vendedorId) whereConditions.push(Prisma.sql`t."vendedorId" = ${vendedorId}::uuid`);
    }

    const whereClause = Prisma.sql`WHERE ${Prisma.join(whereConditions, " AND ")}`;
    const dynamicLimit = Math.max(5000, daysInMonth * 200);

    const groupByClause = shouldGroupByDate
        ? Prisma.sql`
            t."businessDate",
            b.id`
        : Prisma.sql`
            t."businessDate",
            b.id,
            t."ventanaId",
            t."vendedorId"`;

    const query = Prisma.sql`
        WITH jugada_aggregates AS (
            SELECT 
                j."ticketId",
                COALESCE(SUM(j.amount), 0) as total_amount,
                COALESCE(SUM(j."listeroCommissionAmount"), 0) as total_listero_commission,
                COALESCE(SUM(CASE WHEN j."commissionOrigin" = 'USER' THEN j."commissionAmount" ELSE 0 END), 0) as total_vendedor_commission
            FROM "Jugada" j
            WHERE j."deletedAt" IS NULL
            GROUP BY j."ticketId"
        )
        SELECT
            t."businessDate" as business_date,
            b.id as banca_id,
            MAX(b.name) as banca_name,
            MAX(b.code) as banca_code,
            ${shouldGroupByDate ? Prisma.sql`NULL::uuid` : Prisma.sql`t."ventanaId"`} as ventana_id,
            MAX(v.name) as ventana_name,
            MAX(v.code) as ventana_code,
            ${shouldGroupByDate ? Prisma.sql`NULL::uuid` : (dimension === "ventana" && ventanaId ? Prisma.sql`NULL::uuid` : Prisma.sql`t."vendedorId"`)} as vendedor_id,
            MAX(u.name) as vendedor_name,
            MAX(u.code) as vendedor_code,
            COALESCE(SUM(ja.total_amount), 0) as total_sales,
            0 as total_payouts,
            COUNT(DISTINCT t.id) as total_tickets,
            COALESCE(SUM(ja.total_listero_commission), 0) as commission_listero,
            COALESCE(SUM(ja.total_vendedor_commission), 0) as commission_vendedor
        FROM "Ticket" t
        LEFT JOIN jugada_aggregates ja ON ja."ticketId" = t.id
        INNER JOIN "Ventana" v ON v.id = t."ventanaId"
        INNER JOIN "Banca" b ON b.id = v."bancaId"
        LEFT JOIN "User" u ON u.id = t."vendedorId"
        ${whereClause}
        GROUP BY ${groupByClause}
        ORDER BY business_date ${sort === "desc" ? Prisma.sql`DESC` : Prisma.sql`ASC`}
        LIMIT ${dynamicLimit}
    `;

    return prisma.$queryRaw<AggregatedTicketRow[]>(query);
}

/**
 *  OPTIMIZACIÓN: Lee resúmenes diarios de la vista materializada
 * Retorna un Map<dateKey, { ventanaId, vendedorId, ticket_count, total_sales, ... }>
 */
export async function getDailySummariesFromMaterializedView(
    startDate: Date,
    endDate: Date,
    dimension: "banca" | "ventana" | "vendedor", //  NUEVO: Agregado 'banca'
    ventanaId: string | undefined,
    vendedorId: string | undefined,
    bancaId?: string, //  NUEVO: Filtro opcional por banca
    sort: "asc" | "desc" = "desc"
): Promise<Map<string, {
    date: Date;
    ventanaId: string | null;
    vendedorId: string | null;
    ticket_count: number;
    total_sales: number;
    total_payouts: number;
    vendedor_commission: number;
    listero_commission: number;
    balance: number;
}>> {
    try {
        // ️ CRÍTICO: Convertir fechas UTC a fechas CR antes de usar en SQL
        // startDate y endDate son instantes UTC que representan días en CR
        // Usar servicio centralizado para conversión de fechas
        const { startDateCRStr: startDateCR, endDateCRStr: endDateCR } = crDateService.dateRangeUTCToCRStrings(startDate, endDate);

        // ️ CRÍTICO: Usar límite exclusivo para excluir el inicio del día siguiente
        // endDate representa el fin del último día incluido (ej: 2025-11-20T05:59:59.999Z = fin del 19 en CR)
        // Para excluir datos del día siguiente, usar el día siguiente (exclusivo) en SQL
        // Si endDateCR es '2025-11-19', queremos excluir '2025-11-20', entonces usamos date < '2025-11-20'::date
        const [endYear, endMonth, endDay] = endDateCR.split('-').map(Number);
        const endDateObj = new Date(Date.UTC(endYear, endMonth - 1, endDay));
        endDateObj.setUTCDate(endDateObj.getUTCDate() + 1); // Día siguiente
        const endDateNextDayCR = `${endDateObj.getUTCFullYear()}-${String(endDateObj.getUTCMonth() + 1).padStart(2, '0')}-${String(endDateObj.getUTCDate()).padStart(2, '0')}`;

        // Construir condiciones WHERE dinámicamente
        const conditions: string[] = [
            `date >= '${startDateCR}'::date`,
            `date < '${endDateNextDayCR}'::date`, // ️ CRÍTICO: Exclusivo para no incluir datos del día siguiente
        ];

        //  NUEVO: Filtros para dimension='banca'
        // Nota: La vista materializada no tiene bancaId directamente, así que filtramos por ventanas de esa banca
        if (dimension === "banca") {
            if (bancaId) {
                // Filtrar por ventanas de esta banca específica
                conditions.push(`"ventanaId" IN (SELECT id FROM "Ventana" WHERE "bancaId" = '${bancaId}'::uuid)`);
            }
            if (ventanaId) {
                conditions.push(`"ventanaId" = '${ventanaId}'::uuid`);
            }
            if (vendedorId) {
                conditions.push(`"vendedorId" = '${vendedorId}'::uuid`);
            }
            // Para dimension='banca', no filtramos por vendedorId IS NULL porque puede haber vendedores
        } else if (dimension === "ventana" && ventanaId) {
            conditions.push(`"ventanaId" = '${ventanaId}'::uuid`);
            conditions.push(`"vendedorId" IS NULL`);
        } else if (dimension === "ventana") {
            conditions.push(`"ventanaId" IS NOT NULL`);
            conditions.push(`"vendedorId" IS NULL`);
        } else if (dimension === "vendedor" && vendedorId) {
            conditions.push(`"vendedorId" = '${vendedorId}'::uuid`);
            conditions.push(`"ventanaId" IS NULL`);
        } else if (dimension === "vendedor") {
            conditions.push(`"vendedorId" IS NOT NULL`);
            conditions.push(`"ventanaId" IS NULL`);
        }

        const whereClause = conditions.join(' AND ');
        const orderClause = sort === "desc" ? "DESC" : "ASC";

        // Query la vista materializada
        const summaries = await prisma.$queryRawUnsafe<Array<{
            date: Date;
            ventanaId: string | null;
            vendedorId: string | null;
            ticket_count: bigint;
            total_sales: number;
            total_payouts: number;
            vendedor_commission: number;
            listero_commission: number;
            balance: number;
        }>>(`
      SELECT 
        date,
        "ventanaId",
        "vendedorId",
        ticket_count,
        total_sales,
        total_payouts,
        vendedor_commission,
        listero_commission,
        balance
      FROM mv_daily_account_summary
      WHERE ${whereClause}
      ORDER BY date ${orderClause}
    `);

        // Convertir a Map por dateKey
        const resultMap = new Map<string, {
            date: Date;
            ventanaId: string | null;
            vendedorId: string | null;
            ticket_count: number;
            total_sales: number;
            total_payouts: number;
            vendedor_commission: number;
            listero_commission: number;
            balance: number;
        }>();

        for (const summary of summaries) {
            // ️ CRÍTICO: summary.date viene de la BD como DATE (sin hora), representando un día calendario en CR
            // Usar servicio centralizado para obtener la fecha CR correcta
            // summary.date viene de PostgreSQL DATE, usar postgresDateToCRString
            const dateKey = crDateService.postgresDateToCRString(summary.date);
            resultMap.set(dateKey, {
                date: summary.date,
                ventanaId: summary.ventanaId,
                vendedorId: summary.vendedorId,
                ticket_count: Number(summary.ticket_count),
                total_sales: summary.total_sales,
                total_payouts: summary.total_payouts,
                vendedor_commission: summary.vendedor_commission,
                listero_commission: summary.listero_commission,
                balance: summary.balance,
            });
        }

        return resultMap;
    } catch (error: any) {
        // Si la vista materializada no existe o hay error, retornar Map vacío
        // El código fallback usará calculateDayStatement
        logger.warn({
            layer: "service",
            action: "MATERIALIZED_VIEW_QUERY_FAILED",
            payload: { error: error.message },
        });
        return new Map();
    }
}

/**
 *  OPTIMIZACIÓN: Obtiene el desglose por sorteo para múltiples días en batch
 * Retorna un Map<dateKey, Array<{...}>>
 */
export async function getSorteoBreakdownBatch(
    dates: Date[],
    dimension: "banca" | "ventana" | "vendedor", //  NUEVO: Agregado 'banca'
    ventanaId?: string,
    vendedorId?: string,
    bancaId?: string,
    userRole?: "ADMIN" | "VENTANA" | "VENDEDOR" //  CRÍTICO: Rol del usuario para calcular balance
): Promise<Map<string, Array<{
    sorteoId: string;
    sorteoName: string;
    loteriaId: string;
    loteriaName: string;
    scheduledAt: string;
    sales: number;
    payouts: number;
    listeroCommission: number;
    vendedorCommission: number;
    balance: number;
    ticketCount: number;
}>>> {
    if (dates.length === 0) {
        return new Map();
    }

    // 🚀 SQL-FIRST REFACTOR (Etapa 1):
    // Delegamos TODO el cálculo a PostgreSQL con una única $queryRaw.
    // Esto elimina la carga de hasta 10.000 tickets + jugadas en el Heap de Node.js.
    //
    // Columnas de agregación:
    //   total_sales    → SUM(j.amount)       columna ya snapshot-eada por jugada
    //   total_payouts  → SUM(j.payout) WHERE isWinner   (antes se iteraba en Node.js)
    //   commission_listero  → SUM(j."listeroCommissionAmount")  snapshot inmutable
    //   commission_vendedor → SUM(j."commissionAmount") WHERE "commissionOrigin"='USER'
    //
    // Filtros de dimensión:
    //   banca   → JOIN Ventana v WHERE v."bancaId" = :bancaId (o sin filtro si scope=all)
    //   ventana → t."ventanaId" = :ventanaId    (+ JOIN Ventana igual para bancaId cuando va junto)
    //   vendedor→ t."vendedorId" = :vendedorId  (+ t."ventanaId" cuando ventanaId está presente)
    //
    // Exclusiones: NOT EXISTS contra sorteo_lista_exclusion (con multiplierId IS NULL)
    //
    // Agrupación:
    //   banca   → GROUP BY businessDate, banca.id, sorteo.id
    //   ventana → GROUP BY businessDate, t.ventanaId, sorteo.id
    //   vendedor→ GROUP BY businessDate, t.vendedorId, sorteo.id

    // ── 1. Construir array de fechas para el IN clause ──────────────────────────
    // businessDate es tipo DATE en Postgres. Usamos la fecha UTC como YYYY-MM-DD string.
    const dateStrings = dates.map(d => d.toISOString().split('T')[0]);

    // ── 2. Construir condiciones WHERE dinámicas ──────────────────────────────────
    const whereClauses: Prisma.Sql[] = [
        Prisma.sql`t."deletedAt" IS NULL`,
        Prisma.sql`t."isActive" = true`,
        Prisma.sql`t."status" NOT IN ('CANCELLED', 'EXCLUDED')`,
        Prisma.sql`s.status = 'EVALUATED'`,
        Prisma.sql`j."deletedAt" IS NULL`,
        // Filtramos businessDate con IN sobre las fechas YYYY-MM-DD
        Prisma.sql`t."businessDate" = ANY(${dateStrings}::date[])`,
    ];

    // ── 3. Filtros de dimensión ───────────────────────────────────────────────────
    if (dimension === 'banca') {
        if (bancaId) {
            // Banca específica: los tickets pertenecen a ventanas de esa banca
            whereClauses.push(Prisma.sql`v."bancaId" = ${bancaId}::uuid`);
        }
        // scope=all: sin filtro adicional, incluye todas las bancas
    } else if (dimension === 'ventana') {
        if (ventanaId) {
            whereClauses.push(Prisma.sql`t."ventanaId" = ${ventanaId}::uuid`);
        }
        if (bancaId) {
            whereClauses.push(Prisma.sql`v."bancaId" = ${bancaId}::uuid`);
        }
    } else { // vendedor
        if (vendedorId) {
            whereClauses.push(Prisma.sql`t."vendedorId" = ${vendedorId}::uuid`);
        }
        if (ventanaId) {
            // Vendedores de una ventana específica
            whereClauses.push(Prisma.sql`t."ventanaId" = ${ventanaId}::uuid`);
        }
        if (bancaId) {
            whereClauses.push(Prisma.sql`v."bancaId" = ${bancaId}::uuid`);
        }
    }

    // ── 4. Exclusión de listas bloqueadas (WHERE NOT EXISTS) ──────────────────────
    // Solo agregamos el NOT EXISTS si hay exclusiones activas (optimización de corto-circuito)
    const exclusionExists = await isExclusionListEmpty();
    if (!exclusionExists) {
        whereClauses.push(Prisma.sql`NOT EXISTS (
            SELECT 1 FROM "sorteo_lista_exclusion" sle
            WHERE sle.sorteo_id = t."sorteoId"
              AND sle.ventana_id = t."ventanaId"
              AND (sle.vendedor_id IS NULL OR sle.vendedor_id = t."vendedorId")
              AND sle.multiplier_id IS NULL
        )`);
    }

    const whereClause = Prisma.join(whereClauses, ' AND ');

    // ── 5. Columna de agrupación por dimensión ────────────────────────────────────
    // entity_id: el ID de la entidad principal según la dimensión
    // Para 'banca': es b.id (la banca de la ventana)
    // Para 'ventana': es t."ventanaId"
    // Para 'vendedor': es t."vendedorId"
    const entityIdExpr: Prisma.Sql =
        dimension === 'banca' ? Prisma.sql`b.id` :
        dimension === 'ventana' ? Prisma.sql`t."ventanaId"` :
        Prisma.sql`t."vendedorId"`;

    // ── 6. Query final ─────────────────────────────────────────────────────────────
    interface SorteoAggRow {
        business_date: Date;
        entity_id: string;
        sorteo_id: string;
        sorteo_name: string;
        sorteo_scheduled_at: Date;
        loteria_id: string;
        loteria_name: string;
        total_sales: number;
        total_payouts: number;
        commission_listero: number;
        commission_vendedor: number;
        ticket_count: bigint;
    }

    const rows = await prisma.$queryRaw<SorteoAggRow[]>`
        SELECT
            t."businessDate"                                                        AS business_date,
            ${entityIdExpr}                                                         AS entity_id,
            s.id                                                                    AS sorteo_id,
            s.name                                                                  AS sorteo_name,
            s."scheduledAt"                                                         AS sorteo_scheduled_at,
            l.id                                                                    AS loteria_id,
            l.name                                                                  AS loteria_name,
            COALESCE(SUM(j.amount),  0)                                             AS total_sales,
            COALESCE(SUM(CASE WHEN j."isWinner" = true THEN j.payout ELSE 0 END), 0) AS total_payouts,
            COALESCE(SUM(j."listeroCommissionAmount"), 0)                            AS commission_listero,
            COALESCE(SUM(CASE WHEN j."commissionOrigin" = 'USER'
                              THEN j."commissionAmount" ELSE 0 END), 0)             AS commission_vendedor,
            COUNT(DISTINCT t.id)                                                    AS ticket_count
        FROM "Ticket"  t
        JOIN "Sorteo"  s  ON s.id  = t."sorteoId"
        JOIN "Loteria" l  ON l.id  = s."loteriaId"
        JOIN "Ventana" v  ON v.id  = t."ventanaId"
        JOIN "Banca"   b  ON b.id  = v."bancaId"
        JOIN "Jugada"  j  ON j."ticketId" = t.id
        WHERE ${whereClause}
        GROUP BY
            t."businessDate",
            ${entityIdExpr},
            s.id,
            s.name,
            s."scheduledAt",
            l.id,
            l.name
        ORDER BY t."businessDate" ASC, s."scheduledAt" DESC
    `;

    // ── 7. Construir el Map de salida (misma firma que antes) ─────────────────────
    const finalMap = new Map<string, Array<{
        sorteoId: string;
        sorteoName: string;
        loteriaId: string;
        loteriaName: string;
        scheduledAt: string;
        sales: number;
        payouts: number;
        listeroCommission: number;
        vendedorCommission: number;
        balance: number;
        ticketCount: number;
    }>>();

    for (const row of rows) {
        // La fecha de businessDate viene como DATE de Postgres → tomamos YYYY-MM-DD
        const dateKey = row.business_date.toISOString().split('T')[0];
        const entityId = row.entity_id;
        const mapKey = `${dateKey}_${entityId}`;

        if (!finalMap.has(mapKey)) {
            finalMap.set(mapKey, []);
        }

        const sales = Number(row.total_sales);
        const payouts = Number(row.total_payouts);
        const commissionListero = Number(row.commission_listero);
        const commissionVendedor = Number(row.commission_vendedor);

        // Balance: usa comisión del vendedor si dimension='vendedor' o si vendedorId está presente
        const balance = (dimension === 'vendedor' || !!vendedorId)
            ? sales - payouts - commissionVendedor
            : sales - payouts - commissionListero;

        finalMap.get(mapKey)!.push({
            sorteoId: row.sorteo_id,
            sorteoName: row.sorteo_name,
            loteriaId: row.loteria_id,
            loteriaName: row.loteria_name,
            scheduledAt: row.sorteo_scheduled_at.toISOString(),
            sales,
            payouts,
            listeroCommission: commissionListero,
            vendedorCommission: commissionVendedor,
            balance,
            ticketCount: Number(row.ticket_count),
        });
    }

    // Ordenar cada lista DESC por scheduledAt (ya viene DESC del ORDER BY,
    // pero re-ordenamos para garantizar consistencia en caso de ties)
    for (const [, arr] of finalMap) {
        arr.sort((a, b) => b.scheduledAt.localeCompare(a.scheduledAt));
    }

    logger.info({
        layer: 'service',
        action: 'SORTEO_BREAKDOWN_BATCH_SQL_FIRST',
        payload: {
            dimension,
            bancaId: bancaId ?? null,
            ventanaId: ventanaId ?? null,
            vendedorId: vendedorId ?? null,
            dates: dateStrings,
            rowsReturned: rows.length,
        },
    });

    return finalMap;
}

/**
 * Obtiene el desglose por sorteo para un día específico (mantener para compatibilidad)
 */
export async function getSorteoBreakdown(
    date: Date,
    dimension: "banca" | "ventana" | "vendedor", //  NUEVO: Agregado 'banca'
    ventanaId?: string,
    vendedorId?: string,
    bancaId?: string,
    userRole?: "ADMIN" | "VENTANA" | "VENDEDOR" //  CRÍTICO: Rol del usuario para calcular balance
): Promise<Array<{
    sorteoId: string;
    sorteoName: string;
    loteriaId: string;
    loteriaName: string;
    scheduledAt: string;
    sales: number;
    payouts: number;
    listeroCommission: number;
    vendedorCommission: number;
    balance: number;
    ticketCount: number;
}>> {
    const dateFilter = buildTicketDateFilter(date);
    const where: any = {
        ...dateFilter,
        deletedAt: null,
        status: { not: "CANCELLED" },
        //  CORRECCIÓN: Filtrar estrictamente solo sorteos EVALUADOS (no CERRADOS)
        sorteo: {
            status: "EVALUATED"
        },
    };

    // Filtrar por banca activa (para ADMIN multibanca)
    if (bancaId) {
        where.ventana = {
            bancaId: bancaId,
        };
    }

    if (dimension === "ventana" && ventanaId) {
        where.ventanaId = ventanaId;
    } else if (dimension === "vendedor") {
        if (vendedorId) {
            where.vendedorId = vendedorId;
        }
        //  NUEVO: Filtrar por ventanaId cuando está presente (para agrupamiento por "Todos")
        if (ventanaId) {
            where.ventanaId = ventanaId;
        }
    }

    // Obtener tickets con sus sorteos, loterías y jugadas
    const tickets = await prisma.ticket.findMany({
        where,
        select: {
            id: true,
            totalAmount: true,
            sorteoId: true,
            //  FIX: Agregar vendedorId para la verificación de exclusiones
            vendedorId: true,
            ventanaId: true,
            loteriaId: true,
            sorteo: {
                select: {
                    id: true,
                    name: true,
                    scheduledAt: true,
                    loteria: {
                        select: {
                            id: true,
                            name: true,
                        },
                    },
                },
            },
            jugadas: {
                where: { deletedAt: null },
                select: {
                    payout: true,
                    isWinner: true,
                    amount: true,
                    type: true,
                    finalMultiplierX: true,
                    commissionAmount: true,
                    commissionOrigin: true,
                    listeroCommissionAmount: true, //  Snapshot (puede ser 0)
                },
            },
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
    });

    //  CRÍTICO: Obtener usuarios VENTANA con sus políticas (igual que commissions.service.ts)
    const ventanaIds = Array.from(new Set(tickets.map(t => t.ventanaId).filter((id): id is string => id !== null)));
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

    // Agrupar por sorteo
    const sorteoMap = new Map<string, {
        sorteoId: string;
        sorteoName: string;
        loteriaId: string;
        loteriaName: string;
        scheduledAt: Date;
        sales: number;
        payouts: number;
        listeroCommission: number;
        vendedorCommission: number;
        ticketCount: number;
    }>();

    //  OPTIMIZACIÓN: Fetch exclusions for the relevant sorteos
    const uniqueSorteoIds = Array.from(new Set(tickets.map(t => t.sorteoId)));
    const exclusions = uniqueSorteoIds.length > 0
        ? await prisma.sorteoListaExclusion.findMany({
            where: {
                sorteoId: { in: uniqueSorteoIds },
            },
        })
        : [];

    // Helper to check exclusion
    const isExcluded = (t: typeof tickets[0]) => {
        return exclusions.some(e =>
            e.sorteoId === t.sorteoId &&
            e.ventanaId === t.ventanaId &&
            (e.vendedorId === null || e.vendedorId === t.vendedorId) &&
            (e.multiplierId === null)
        );
    };

    for (const ticket of tickets) {
        if (!ticket.sorteoId || !ticket.sorteo) continue;

        //  NUEVO: Verificar exclusión
        if (isExcluded(ticket)) continue;

        const sorteoId = ticket.sorteo.id;
        let entry = sorteoMap.get(sorteoId);

        if (!entry) {
            entry = {
                sorteoId,
                sorteoName: ticket.sorteo.name,
                loteriaId: ticket.sorteo.loteria.id,
                loteriaName: ticket.sorteo.loteria.name,
                scheduledAt: ticket.sorteo.scheduledAt,
                sales: 0,
                payouts: 0,
                listeroCommission: 0,
                vendedorCommission: 0,
                ticketCount: 0,
            };
            sorteoMap.set(sorteoId, entry);
        }

        entry.sales += ticket.totalAmount || 0;
        entry.ticketCount += 1;

        //  CRÍTICO: Calcular comisiones usando el snapshot inmutable en Jugada
        for (const jugada of ticket.jugadas) {
            // Payouts
            if (jugada.isWinner) {
                entry.payouts += jugada.payout || 0;
            }

            // Comisión del vendedor (usar snapshot)
            if (jugada.commissionOrigin === "USER") {
                entry.vendedorCommission += jugada.commissionAmount || 0;
            }

            // Comisión del listero (usar snapshot)
            entry.listeroCommission += jugada.listeroCommissionAmount || 0;
        }
    }

    // Calcular balance para cada sorteo y convertir a formato de respuesta
    const result = Array.from(sorteoMap.values())
        .map((entry) => ({
            sorteoId: entry.sorteoId,
            sorteoName: entry.sorteoName,
            loteriaId: entry.loteriaId,
            loteriaName: entry.loteriaName,
            scheduledAt: entry.scheduledAt.toISOString(),
            sales: entry.sales,
            payouts: entry.payouts,
            listeroCommission: entry.listeroCommission,
            vendedorCommission: entry.vendedorCommission,
            //  CORRECCIÓN: Calcular balance según vendedorId en query params, NO según userRole
            // Si vendedorId está presente → usar vendedorCommission
            // Si vendedorId NO está presente → usar listeroCommission
            balance: vendedorId
                ? entry.sales - entry.payouts - entry.vendedorCommission
                : entry.sales - entry.payouts - entry.listeroCommission,
            ticketCount: entry.ticketCount,
        }))
        .sort((a, b) => new Date(b.scheduledAt).getTime() - new Date(a.scheduledAt).getTime()); //  DESC para consistencia con sorteo module

    return result;
}

/**
 * Obtiene los movimientos (pagos/cobros) de un statement para un día específico
 * Los movimientos se ordenan por createdAt (ascendente) para reflejar el orden cronológico
 * según lo especificado en BE_CUENTAS_REGISTRO_PAGO_COBRO.md
 */
export async function getMovementsForDay(
    statementId: string
): Promise<Array<{
    id: string;
    accountStatementId: string;
    date: string;
    time: string | null; //  NUEVO: HH:MM (opcional, hora del movimiento en CR)
    amount: number;
    type: "payment" | "collection";
    method: "cash" | "transfer" | "check" | "other";
    notes: string | null;
    isFinal: boolean;
    isReversed: boolean;
    reversedAt: string | null; //  Cambiado a string para serialización ISO
    reversedBy: string | null;
    paidById: string;
    paidByName: string;
    createdAt: string;
    updatedAt: string;
}>> {
    const payments = await AccountPaymentRepository.findByStatementId(statementId);

    return payments
        //  CORREGIDO: Retornar TODOS los movimientos (activos y reversados)
        // El FE los separa en "Activos" y "Revertidos" para mostrar en historial de auditoria
        // Los cálculos en el backend filtran !isReversed cuando es necesario
        .map((p) => ({
            id: p.id,
            accountStatementId: p.accountStatementId,
            date: p.date.toISOString().split("T")[0],
            time: p.time || null, //  NUEVO: Hora del movimiento si está disponible
            amount: p.amount,
            type: p.type as "payment" | "collection",
            method: p.method as "cash" | "transfer" | "check" | "other",
            notes: p.notes,
            isFinal: p.isFinal,
            isReversed: p.isReversed,
            //  CRÍTICO: Serializar reversedAt como ISO string para consistencia con la API
            reversedAt: p.reversedAt ? p.reversedAt.toISOString() : null,
            reversedBy: p.reversedBy,
            paidById: p.paidById,
            paidByName: p.paidByName,
            createdAt: p.createdAt.toISOString(),
            updatedAt: p.updatedAt.toISOString(),
        }))
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()); // Ordenar por createdAt ascendente
}
