import { Prisma, Role } from "@prisma/client";
import prisma from "../../../../core/prismaClient";
import { commissionSnapshotService } from "../../../../services/commission/CommissionSnapshotService";
import { resolveCommission } from "../../../../services/commission.resolver"; // Mantener para fallback

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

    // ✅ OPTIMIZACIÓN: Obtener tickets que cumplen el WHERE para luego leer snapshots
    const tickets = await prisma.ticket.findMany({
        where: ticketWhere,
        select: { id: true },
    });

    if (tickets.length === 0) {
        return result;
    }

    const ticketIds = tickets.map((t) => t.id);

    // ✅ USAR SNAPSHOTS: Leer snapshots directamente de BD en lugar de recalcular
    const snapshotsByTicket = await commissionSnapshotService.getSnapshotsForTickets(ticketIds);

    // Agregar por ventana usando snapshots
    for (const [ticketId, snapshots] of snapshotsByTicket.entries()) {
        // Obtener ventanaId del primer snapshot (todos los snapshots de un ticket tienen la misma ventanaId)
        if (snapshots.length === 0) continue;
        const ventanaId = snapshots[0].ventanaId;

        // Sumar comisiones del listero desde snapshots
        const totalListeroCommission = snapshots.reduce(
            (sum, snap) => sum + snap.listeroSnapshot.commissionAmount,
            0
        );

        if (totalListeroCommission > 0) {
            result.set(ventanaId, (result.get(ventanaId) || 0) + totalListeroCommission);
        }
    }

    return result;
}

/**
 * Calcula comisiones para un ticket usando snapshots guardados en BD
 * ✅ OPTIMIZADO: Usa snapshots en lugar de recalcular desde políticas
 * 
 * Lógica:
 * - Si dimension='ventana': Usa listeroCommissionAmount del snapshot
 * - Si dimension='vendedor': Usa commissionAmount del snapshot (vendedor) y listeroCommissionAmount (listero)
 */
export async function calculateCommissionsForTicket(
    ticket: any,
    dimension: "ventana" | "vendedor"
): Promise<{ listeroCommission: number; vendedorCommission: number }> {
    const ticketId = ticket.id;
    
    // ✅ USAR SNAPSHOTS: Leer snapshots directamente de BD
    const snapshotsByTicket = await commissionSnapshotService.getSnapshotsForTickets([ticketId]);
    const snapshots = snapshotsByTicket.get(ticketId) || [];

    let listeroCommission = 0;
    let vendedorCommission = 0;

    if (dimension === "ventana") {
        // Si es ventana, usar listeroCommissionAmount del snapshot
        for (const snap of snapshots) {
            listeroCommission += snap.listeroSnapshot.commissionAmount;
        }
        vendedorCommission = 0; // No hay comisión de vendedor en este caso
    } else {
        // Si es vendedor, usar ambos snapshots
        for (const snap of snapshots) {
            // La comisión del vendedor está en snapshot.commissionAmount
            vendedorCommission += snap.snapshot.commissionAmount;
            
            // La comisión del listero está en listeroSnapshot.commissionAmount
            listeroCommission += snap.listeroSnapshot.commissionAmount;
        }
    }

    return { listeroCommission, vendedorCommission };
}
