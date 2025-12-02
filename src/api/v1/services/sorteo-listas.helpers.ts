import prisma from "../../../core/prismaClient";

/**
 * Obtiene los IDs de tickets excluidos para un sorteo
 * Retorna un Set de ticketIds que deben ser excluidos de cálculos
 * Soporta exclusión por multiplierId
 */
export async function getExcludedTicketIds(sorteoId: string): Promise<Set<string>> {
    // Obtener todas las exclusiones del sorteo
    const exclusions = await prisma.sorteoListaExclusion.findMany({
        where: { sorteoId },
        select: {
            ventanaId: true,
            vendedorId: true,
            multiplierId: true,
        },
    });

    if (exclusions.length === 0) {
        return new Set();
    }

    // WORKAROUND: ventanaId en la tabla apunta al User (listero), no a Ventana
    // Necesitamos obtener el ventanaId real de cada usuario listero
    const ventanaUserIds = Array.from(new Set(exclusions.map(e => e.ventanaId)));
    const ventanaUsers = await prisma.user.findMany({
        where: { id: { in: ventanaUserIds } },
        select: { id: true, ventanaId: true },
    });
    
    const userIdToVentanaId = new Map<string, string>();
    for (const user of ventanaUsers) {
        if (user.ventanaId) {
            userIdToVentanaId.set(user.id, user.ventanaId);
        }
    }

    // Construir condiciones WHERE para tickets excluidos
    const orConditions = exclusions.map((exclusion) => {
        const realVentanaId = userIdToVentanaId.get(exclusion.ventanaId);
        if (!realVentanaId) return null;

        const baseCondition: any = {
            sorteoId,
            ventanaId: realVentanaId,
        };

        // Si vendedorId es NULL -> excluir toda la ventana
        if (exclusion.vendedorId !== null) {
            baseCondition.vendedorId = exclusion.vendedorId;
        }

        // Si multiplierId es NULL -> excluir todos los multiplicadores
        // Si multiplierId es NOT NULL -> excluir solo ese multiplicador
        if (exclusion.multiplierId !== null) {
            baseCondition.jugadas = {
                some: {
                    multiplierId: exclusion.multiplierId,
                    deletedAt: null,
                },
            };
        }

        return baseCondition;
    }).filter(Boolean);

    if (orConditions.length === 0) {
        return new Set();
    }

    const excludedTickets = await prisma.ticket.findMany({
        where: {
            deletedAt: null,
            OR: orConditions,
        },
        select: { id: true },
    });

    return new Set(excludedTickets.map((t) => t.id));
}

/**
 * Genera condición Prisma WHERE para excluir tickets de listas bloqueadas
 * Soporta exclusión por multiplierId
 */
export async function getExclusionWhereCondition(sorteoId: string): Promise<any> {
    const exclusions = await prisma.sorteoListaExclusion.findMany({
        where: { sorteoId },
        select: {
            ventanaId: true,
            vendedorId: true,
            multiplierId: true,
        },
    });

    if (exclusions.length === 0) {
        return {}; // Sin exclusiones
    }

    // WORKAROUND: ventanaId en la tabla apunta al User (listero), no a Ventana
    const ventanaUserIds = Array.from(new Set(exclusions.map(e => e.ventanaId)));
    const ventanaUsers = await prisma.user.findMany({
        where: { id: { in: ventanaUserIds } },
        select: { id: true, ventanaId: true },
    });
    
    const userIdToVentanaId = new Map<string, string>();
    for (const user of ventanaUsers) {
        if (user.ventanaId) {
            userIdToVentanaId.set(user.id, user.ventanaId);
        }
    }

    // Construir condición NOT para excluir tickets
    const orConditions = exclusions.map((exclusion) => {
        const realVentanaId = userIdToVentanaId.get(exclusion.ventanaId);
        if (!realVentanaId) return null;

        const condition: any = {
            ventanaId: realVentanaId,
        };

        if (exclusion.vendedorId !== null) {
            condition.vendedorId = exclusion.vendedorId;
        }

        if (exclusion.multiplierId !== null) {
            condition.jugadas = {
                some: {
                    multiplierId: exclusion.multiplierId,
                    deletedAt: null,
                },
            };
        }

        return condition;
    }).filter(Boolean);

    if (orConditions.length === 0) {
        return {};
    }

    return {
        NOT: {
            OR: orConditions,
        },
    };
}
