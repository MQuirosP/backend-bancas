import { getCRLocalComponents } from "../../../../utils/businessDate";

/**
 * Formatea una hora en formato 12h con AM/PM
 */
function formatTime12h(date: Date): string {
  const { hour, minute } = getCRLocalComponents(date);
  const ampm = hour >= 12 ? 'PM' : 'AM';
  let hours12 = hour % 12;
  hours12 = hours12 ? hours12 : 12;
  const minutesStr = String(minute).padStart(2, '0');
  return `${hours12}:${minutesStr}${ampm} `;
}

/**
 * Tipo unificado para sorteos y movimientos intercalados
 */
export interface SorteoOrMovement {
  // Campos comunes
  sorteoId: string;
  sorteoName: string;
  scheduledAt: string;
  date: string;
  time: string;
  balance: number;
  accumulated: number;
  chronologicalIndex: number;
  totalChronological: number;

  // Campos específicos de sorteos (null en movimientos)
  loteriaId: string | null;
  loteriaName: string | null;
  sales: number;
  payouts: number;
  listeroCommission: number;
  vendedorCommission: number;
  ticketCount: number;
  sorteoAccumulated?: number;

  // Campos específicos de movimientos (undefined en sorteos)
  type?: "payment" | "collection";
  amount?: number;
  method?: string;
  notes?: string | null;
  isReversed?: boolean;
  createdAt?: string;
}

/**
 * Intercala sorteos y movimientos en una lista cronológica unificada
 *
 * Comportamiento:
 * - Combina sorteos y movimientos del día
 * - Ordena cronológicamente DESC (más reciente primero)
 * - Calcula accumulated progresivo
 * - Asigna chronologicalIndex a cada evento
 * - Movimientos se identifican con sorteoId que empieza con "mov-"
 *
 * @param sorteos - Array de sorteos del día (ya ordenados DESC)
 * @param movements - Array de movimientos del día
 * @param dateStr - Fecha en formato YYYY-MM-DD
 * @returns Array intercalado ordenado DESC por scheduledAt
 */
export function intercalateSorteosAndMovements(
  sorteos: Array<{
    sorteoId: string;
    sorteoName: string;
    scheduledAt: string;
    sales: number;
    payouts: number;
    listeroCommission: number;
    vendedorCommission: number;
    balance: number;
    ticketCount: number;
    loteriaId: string;
    loteriaName: string;
    sorteoAccumulated?: number;
  }>,
  movements: Array<{
    id: string;
    type: "payment" | "collection";
    amount: number;
    method: string;
    notes: string | null;
    isReversed: boolean;
    createdAt: string;
    date: string;
  }>,
  dateStr: string
): SorteoOrMovement[] {

  // PASO 1: Convertir movimientos a formato unificado
  const movementItems: SorteoOrMovement[] = [];

  for (const movement of movements) {
    // ✅ INCLUIR TODOS los movimientos (activos y reversados)
    // Los movimientos reversados se muestran en el frontend con estilo diferente
    // pero NO afectan el balance acumulado (balance: 0 si isReversed)
    
    // Combinar: fecha del usuario + hora de createdAt (en hora CR)
    const createdAtDate = new Date(movement.createdAt);
    // Convertir UTC a CR (UTC-6)
    const crTime = new Date(createdAtDate.getTime() - (6 * 60 * 60 * 1000));
    const hour = crTime.getUTCHours();
    const minute = crTime.getUTCMinutes();
    const seconds = crTime.getUTCSeconds();
    const [year, month, day] = movement.date.split('-').map(Number);
    const scheduledAt = new Date(year, month - 1, day, hour, minute, seconds);

    // ✅ CRÍTICO: Si está reversado, balance = 0 (no afecta acumulado)
    // Si no está reversado, usar el monto normal
    const effectiveBalance = movement.isReversed 
      ? 0 
      : (movement.type === 'payment' ? movement.amount : -movement.amount);

    movementItems.push({
      sorteoId: `mov-${movement.id}`,
      sorteoName: movement.type === 'payment' ? 'Pago recibido' : 'Cobro realizado',
      scheduledAt: scheduledAt.toISOString(),
      date: movement.date,
      time: formatTime12h(scheduledAt),
      balance: effectiveBalance, // ✅ 0 si reversado, monto normal si activo
      accumulated: 0,
      chronologicalIndex: 0,
      totalChronological: 0,

      // Campos null para compatibilidad con sorteos
      loteriaId: null,
      loteriaName: null,
      sales: 0,
      payouts: 0,
      listeroCommission: 0,
      vendedorCommission: 0,
      ticketCount: 0,

      // Campos específicos de movimiento
      type: movement.type,
      amount: movement.amount, // ✅ Mantener monto original para mostrar en frontend
      method: movement.method,
      notes: movement.notes,
      isReversed: movement.isReversed, // ✅ Frontend usa esto para aplicar estilo diferente
      createdAt: movement.createdAt,
    });
  }

  // PASO 2: Convertir sorteos a formato unificado
  const sorteoItems: SorteoOrMovement[] = sorteos.map(sorteo => ({
    sorteoId: sorteo.sorteoId,
    sorteoName: sorteo.sorteoName,
    scheduledAt: sorteo.scheduledAt,
    date: dateStr,
    time: formatTime12h(new Date(sorteo.scheduledAt)),
    balance: sorteo.balance,
    accumulated: 0,
    chronologicalIndex: 0,
    totalChronological: 0,

    loteriaId: sorteo.loteriaId,
    loteriaName: sorteo.loteriaName,
    sales: sorteo.sales,
    payouts: sorteo.payouts,
    listeroCommission: sorteo.listeroCommission,
    vendedorCommission: sorteo.vendedorCommission,
    ticketCount: sorteo.ticketCount,
    sorteoAccumulated: sorteo.sorteoAccumulated,
  }));

  // PASO 3: Combinar y ordenar cronológicamente ASC (para calcular accumulated)
  const allEvents = [...sorteoItems, ...movementItems];
  allEvents.sort((a, b) => {
    const timeA = new Date(a.scheduledAt).getTime();
    const timeB = new Date(b.scheduledAt).getTime();
    return timeA - timeB; // ASC para calcular
  });

  // PASO 4: Calcular accumulated y chronologicalIndex
  let eventAccumulated = 0;
  const totalEvents = allEvents.length;
  const eventsWithAccumulated = allEvents.map((event, index) => {
    eventAccumulated += event.balance;
    return {
      ...event,
      accumulated: eventAccumulated,
      sorteoAccumulated: eventAccumulated, // ✅ NUEVO: También asignar a sorteoAccumulated para movimientos
      chronologicalIndex: index + 1,
      totalChronological: totalEvents,
    };
  });

  // PASO 5: Ordenar DESC para presentación (más reciente primero)
  eventsWithAccumulated.sort((a, b) => {
    const timeA = new Date(a.scheduledAt).getTime();
    const timeB = new Date(b.scheduledAt).getTime();
    return timeB - timeA; // DESC
  });

  return eventsWithAccumulated;
}
