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
