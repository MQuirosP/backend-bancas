import { getCRLocalComponents } from "../../../../utils/businessDate";
import { crDateService } from "../../../../utils/crDateService";

/**
 * Formatea una hora en formato 12h con AM/PM desde un Date
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
 * Convierte hora en formato 24h (HH:MM) a formato 12h (HH:MM AM/PM)
 * Ejemplo: "18:00" -> "6:00PM"
 */
function formatTime24hTo12h(time24h: string): string {
  const [hours, minutes] = time24h.split(':').map(Number);
  const ampm = hours >= 12 ? 'PM' : 'AM';
  let hours12 = hours % 12;
  hours12 = hours12 ? hours12 : 12; // 0 se convierte en 12
  const minutesStr = String(minutes).padStart(2, '0');
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
  type?: "payment" | "collection" | "initial_balance"; //  NUEVO: "initial_balance" para saldo del mes anterior
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
    time?: string | null; //  NUEVO: HH:MM (opcional, hora del movimiento en CR)
  }>,
  dateStr: string,
  initialAccumulated: number = 0 //  NUEVO: Acumulado inicial (para arrastrar saldo del día anterior)
): SorteoOrMovement[] {

  // PASO 1: Convertir movimientos a formato unificado
  const movementItems: SorteoOrMovement[] = [];

  for (const movement of movements) {
    //  INCLUIR TODOS los movimientos (activos y reversados)
    // Los movimientos reversados se muestran en el frontend con estilo diferente
    // pero NO afectan el balance acumulado (balance: 0 si isReversed)



    //  CRÍTICO: Usar time si está disponible y es válido, sino usar createdAt
    // Si movement.time existe, combinar date + time en CR y convertir a UTC para scheduledAt
    // Esto permite que el usuario especifique la hora del movimiento y se intercale correctamente con sorteos
    let scheduledAt: Date;
    let timeToDisplay: string;

    //  CRÍTICO: Validar que time existe y no es una cadena vacía
    const timeValue = movement.time;
    const hasTime = timeValue != null && typeof timeValue === 'string' && timeValue.trim().length > 0;

    //  CRÍTICO: Si el usuario especificó manualmente el time, SIEMPRE usarlo
    // El time puede estar lejos de createdAt si el usuario registró el movimiento después
    // (ej: registró a las 01:17 un movimiento que ocurrió a las 18:00)
    // Solo validamos que el formato sea correcto (HH:MM válido)
    const createdAtDate = new Date(movement.createdAt);

    let useTime = false;
    if (hasTime && timeValue) {
      const timeStr = timeValue.trim();
      const [hours, minutes] = timeStr.split(':').map(Number);

      //  VALIDACIÓN: Solo verificar que el formato sea válido (0-23 horas, 0-59 minutos)
      // Si el usuario especificó manualmente la hora, siempre debemos respetarla
      // incluso si está lejos de createdAt (el usuario puede registrar movimientos después)
      if (!isNaN(hours) && !isNaN(minutes) && hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59) {
        useTime = true;
      } else {
        // Formato inválido, no usar
        useTime = false;
      }
    }

    if (useTime && timeValue) {
      // Combinar date + time en CR y convertir a UTC para comparar con sorteos
      // date viene como YYYY-MM-DD, time como HH:MM (hora en CR, UTC-6)
      const [year, month, day] = movement.date.split('-').map(Number);
      const timeStr = timeValue.trim();
      const [hours, minutes] = timeStr.split(':').map(Number);
      //  CRÍTICO: Convertir hora CR a UTC correctamente
      // CR está en UTC-6, así que para convertir CR a UTC: SUMAR 6 horas
      // Ejemplo: 18:00 CR = 00:00 UTC del día siguiente
      // Si hours + 6 >= 24, entonces es el día siguiente
      const utcHours = hours + 6;
      let utcYear = year;
      let utcMonth = month;
      let utcDay = day;

      if (utcHours >= 24) {
        // Es el día siguiente en UTC
        const nextDay = new Date(Date.UTC(year, month - 1, day));
        nextDay.setUTCDate(nextDay.getUTCDate() + 1);
        utcYear = nextDay.getUTCFullYear();
        utcMonth = nextDay.getUTCMonth() + 1;
        utcDay = nextDay.getUTCDate();
        scheduledAt = new Date(Date.UTC(utcYear, utcMonth - 1, utcDay, utcHours - 24, minutes, 0, 0));
      } else {
        // Mismo día en UTC
        scheduledAt = new Date(Date.UTC(utcYear, utcMonth - 1, utcDay, utcHours, minutes, 0, 0));
      }
      timeToDisplay = formatTime24hTo12h(timeStr);
    } else {
      // Si no hay time válido, usar createdAt (que ya está en UTC)
      //  CRÍTICO: createdAt es un timestamp real generado por la BD, no podemos "corregirlo"
      // Si el time está mal guardado, simplemente usamos createdAt convertido a CR
      scheduledAt = createdAtDate;
      timeToDisplay = formatTime12h(createdAtDate);
    }

    //  CRÍTICO: Convertir amount a Number (puede venir como Decimal de Prisma)
    const amountNum = Number(movement.amount || 0);

    //  CRÍTICO: Si está reversado, balance = 0 (no afecta acumulado)
    // Si no está reversado, usar el monto normal
    const effectiveBalance = movement.isReversed
      ? 0
      : (movement.type === 'payment' ? amountNum : -amountNum);

    movementItems.push({
      sorteoId: `mov-${movement.id}`,
      sorteoName: movement.type === 'payment' ? 'Pago recibido' : 'Cobro realizado',
      scheduledAt: scheduledAt.toISOString(),
      date: movement.date,
      time: timeToDisplay, //  Usar time validado o createdAt convertido a CR
      balance: effectiveBalance, //  0 si reversado, monto normal si activo
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
      amount: amountNum, //  CRÍTICO: Convertir a Number (puede venir como Decimal de Prisma)
      method: movement.method,
      notes: movement.notes,
      isReversed: movement.isReversed, //  Frontend usa esto para aplicar estilo diferente
      createdAt: movement.createdAt,
    });
  }

  // PASO 2: Convertir sorteos a formato unificado
  //  CRÍTICO: scheduledAt de sorteos viene como string ISO desde la BD
  // Según la documentación, se guarda como hora local CR (sin 'Z')
  // Pero cuando Prisma lo lee y convierte a string con toISOString(), ya está en UTC
  // Necesitamos normalizar ambos (sorteos y movimientos) a UTC para comparar correctamente
  const sorteoItems: SorteoOrMovement[] = sorteos.map(sorteo => {
    // scheduledAt viene como string ISO desde accounts.queries.ts (ya convertido con toISOString())
    // Por lo tanto, ya está en UTC y podemos usarlo directamente
    const sorteoScheduledAt = new Date(sorteo.scheduledAt);

    //  CRÍTICO: Convertir balance a Number (puede venir como Decimal de Prisma)
    const balanceNum = Number(sorteo.balance || 0);

    return {
      sorteoId: sorteo.sorteoId,
      sorteoName: sorteo.sorteoName,
      scheduledAt: sorteoScheduledAt.toISOString(), //  Ya está en UTC
      date: dateStr,
      time: formatTime12h(sorteoScheduledAt),
      balance: balanceNum, //  CRÍTICO: Asegurar que balance sea Number
      accumulated: 0,
      chronologicalIndex: 0,
      totalChronological: 0,

      loteriaId: sorteo.loteriaId,
      loteriaName: sorteo.loteriaName,
      sales: Number(sorteo.sales || 0), //  CRÍTICO: Convertir a Number
      payouts: Number(sorteo.payouts || 0), //  CRÍTICO: Convertir a Number
      listeroCommission: Number(sorteo.listeroCommission || 0), //  CRÍTICO: Convertir a Number
      vendedorCommission: Number(sorteo.vendedorCommission || 0), //  CRÍTICO: Convertir a Number
      ticketCount: sorteo.ticketCount,
      sorteoAccumulated: Number(sorteo.sorteoAccumulated || 0), //  CRÍTICO: Convertir a Number
    };
  });

  // PASO 3: Combinar y ordenar cronológicamente ASC (para calcular accumulated)
  const allEvents = [...sorteoItems, ...movementItems];
  allEvents.sort((a, b) => {
    const timeA = new Date(a.scheduledAt).getTime();
    const timeB = new Date(b.scheduledAt).getTime();

    //  CRÍTICO: Si tiempos son iguales, priorizar "initial_balance"
    if (timeA === timeB) {
      if (a.type === 'initial_balance') return -1;
      if (b.type === 'initial_balance') return 1;
    }

    return timeA - timeB; // ASC para calcular
  });

  // PASO 4: Calcular accumulated y chronologicalIndex
  //  CRÍTICO: Iniciar con el acumulado inicial (saldo del día anterior desde AccountStatement.accumulatedBalance
  // o saldo del mes anterior para el primer día del mes)
  // Este initialAccumulated DEBE venir desde AccountStatement.accumulatedBalance del día anterior
  // para asegurar que el acumulado progresivo por sorteo sea correcto
  let eventAccumulated = Number(initialAccumulated || 0);
  const totalEvents = allEvents.length;
  const eventsWithAccumulated = allEvents.map((event, index) => {
    //  CRÍTICO: Convertir balance a Number (puede venir como Decimal de Prisma)
    const balanceNum = Number(event.balance || 0);
    //  CRÍTICO: Acumular progresivamente: cada evento suma su balance al acumulado anterior
    // El accumulated representa el saldo acumulado DESPUÉS de este evento
    eventAccumulated += balanceNum;
    return {
      ...event,
      balance: balanceNum, //  CRÍTICO: Asegurar que balance sea Number
      accumulated: parseFloat(eventAccumulated.toFixed(2)), //  Redondear a 2 decimales para consistencia
      sorteoAccumulated: parseFloat(eventAccumulated.toFixed(2)), //  NUEVO: También asignar a sorteoAccumulated para movimientos
      chronologicalIndex: index + 1,
      totalChronological: totalEvents,
    };
  });

  // PASO 5: Ordenar DESC para presentación (más reciente primero)
  //  CRÍTICO: Si hay múltiples eventos con el mismo scheduledAt, ordenar por chronologicalIndex DESC
  // Esto asegura que cuando hay sorteos a la misma hora, el último procesado (mayor índice) aparezca primero
  eventsWithAccumulated.sort((a, b) => {
    const timeA = new Date(a.scheduledAt).getTime();
    const timeB = new Date(b.scheduledAt).getTime();
    if (timeB !== timeA) {
      return timeB - timeA; // DESC por tiempo
    }
    // Si mismo tiempo, usar chronologicalIndex DESC (mayor índice = procesado después = más reciente)
    //  MEJORADO: Agregar sorteoId como criterio secundario para estabilidad
    const sorteoIdA = a.sorteoId || '';
    const sorteoIdB = b.sorteoId || '';
    if (sorteoIdA !== sorteoIdB) {
      return sorteoIdB.localeCompare(sorteoIdA); // DESC por sorteoId
    }
    const indexA = a.chronologicalIndex || 0;
    const indexB = b.chronologicalIndex || 0;
    return indexB - indexA; // DESC por índice
  });

  return eventsWithAccumulated;
}
