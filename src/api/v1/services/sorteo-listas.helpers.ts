import prisma from "../../../core/prismaClient";

/**
 * Obtiene los IDs de tickets excluidos para un sorteo
 * Retorna un Set de ticketIds que deben ser excluidos de cálculos
 */
export async function getExcludedTicketIds(sorteoId: string): Promise<Set<string>> {
    // Obtener todas las exclusiones del sorteo
    const exclusions = await prisma.sorteoListaExclusion.findMany({
        where: { sorteoId },
        select: {
            ventanaId: true,
            vendedorId: true,
        },
    });

    if (exclusions.length === 0) {
        return new Set();
    }

    // Construir condiciones WHERE para tickets excluidos
    const excludedTickets = await prisma.ticket.findMany({
        where: {
            sorteoId,
            deletedAt: null,
            OR: exclusions.map((exclusion) => {
                if (exclusion.vendedorId === null) {
                    // Excluir todo el listero (ventana completa)
                    return { ventanaId: exclusion.ventanaId };
                } else {
                    // Excluir solo vendedor específico
                    return {
                        ventanaId: exclusion.ventanaId,
                        vendedorId: exclusion.vendedorId,
                    };
                }
            }),
        },
        select: { id: true },
    });

    return new Set(excludedTickets.map((t) => t.id));
}

/**
 * Genera condición Prisma WHERE para excluir tickets de listas bloqueadas
 */
export async function getExclusionWhereCondition(sorteoId: string): Promise<any> {
    const exclusions = await prisma.sorteoListaExclusion.findMany({
        where: { sorteoId },
        select: {
            ventanaId: true,
            vendedorId: true,
        },
    });

    if (exclusions.length === 0) {
        return {}; // Sin exclusiones
    }

    // Construir condición NOT para excluir tickets
    return {
        NOT: {
            OR: exclusions.map((exclusion) => {
                if (exclusion.vendedorId === null) {
                    // Excluir todo el listero
                    return { ventanaId: exclusion.ventanaId };
                } else {
                    // Excluir solo vendedor específico
                    return {
                        ventanaId: exclusion.ventanaId,
                        vendedorId: exclusion.vendedorId,
                    };
                }
            }),
        },
    };
}
