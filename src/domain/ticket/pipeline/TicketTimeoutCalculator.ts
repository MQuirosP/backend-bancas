export class TicketTimeoutCalculator {
  /**
   * Calcula el timeout dinámico en ms para la transacción Prisma según la cantidad de jugadas.
   */
  static calculate(jugadasCount: number): number {
    const baseTimeout = 20_000;
    const perJugadaTimeout = 300;
    const maxTimeout = 30_000;
    return Math.min(baseTimeout + jugadasCount * perJugadaTimeout, maxTimeout);
  }
}
