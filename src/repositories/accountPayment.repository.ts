import prisma from "../core/prismaClient";
import { Prisma } from "@prisma/client";
import logger from "../core/logger";
import { getCRLocalComponents } from "../utils/businessDate";
import { crDateService } from "../utils/crDateService";
import { ACCOUNT_CARRY_OVER_NOTES, ACCOUNT_PREVIOUS_MONTH_METHOD } from "../api/v1/services/accounts/accounts.types";

export const AccountPaymentRepository = {
  /**
   * Crea un pago/cobro
   */
  async create(data: {
    accountStatementId: string;
    date: Date;
    month: string;
    time: string; //  CRÍTICO: HH:MM (siempre presente, nunca null/undefined según especificación FE)
    ventanaId?: string;
    vendedorId?: string;
    bancaId?: string; //  NUEVO: bancaId para persistir directamente
    amount: number;
    type: "payment" | "collection";
    method: "cash" | "transfer" | "check" | "other";
    notes?: string;
    isFinal?: boolean;
    idempotencyKey?: string;
    paidById: string;
    paidByName: string;
  }) {
    //  CRÍTICO: Inferir ventanaId y bancaId si no están presentes
    // Esto garantiza que siempre se persistan estos campos para evitar problemas
    // cuando un vendedor cambia de ventana o una ventana cambia de banca
    let finalVentanaId = data.ventanaId;
    let finalBancaId = data.bancaId;

    // Si falta ventanaId pero hay vendedorId, inferir desde el vendedor
    if (!finalVentanaId && data.vendedorId) {
      const vendedor = await prisma.user.findUnique({
        where: { id: data.vendedorId },
        select: { ventanaId: true },
      });
      if (vendedor?.ventanaId) {
        finalVentanaId = vendedor.ventanaId;
      }
    }

    // Si falta bancaId pero hay ventanaId, inferir desde la ventana
    if (!finalBancaId && finalVentanaId) {
      const ventana = await prisma.ventana.findUnique({
        where: { id: finalVentanaId },
        select: { bancaId: true },
      });
      if (ventana?.bancaId) {
        finalBancaId = ventana.bancaId;
      }
    }

    //  CRÍTICO: Pasar todos los campos explícitamente, especialmente time
    // No usar spread operator para campos opcionales que pueden ser undefined
    // porque Prisma puede omitirlos y no guardarlos en la BD
    return await prisma.accountPayment.create({
      data: {
        accountStatementId: data.accountStatementId,
        date: data.date,
        month: data.month,
        time: data.time, //  CRÍTICO: Siempre string (HH:MM), nunca null/undefined según especificación FE
        ventanaId: finalVentanaId,
        vendedorId: data.vendedorId,
        bancaId: finalBancaId,
        amount: data.amount,
        type: data.type,
        method: data.method,
        notes: data.notes,
        isFinal: data.isFinal,
        idempotencyKey: data.idempotencyKey,
        paidById: data.paidById,
        paidByName: data.paidByName,
      },
      include: {
        accountStatement: true,
        paidBy: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });
  },

  /**
   * Encuentra un pago por idempotencyKey
   * Incluye relaciones necesarias para devolver como respuesta completa
   */
  async findByIdempotencyKey(idempotencyKey: string) {
    return await prisma.accountPayment.findUnique({
      where: { idempotencyKey },
      include: {
        accountStatement: true,
        paidBy: {
          select: {
            id: true,
            name: true,
          },
        },
        reversedByUser: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });
  },

  /**
   * Obtiene historial de pagos por fecha
   * Incluye TODOS los pagos (activos y revertidos) según el documento
   */
  async findByDate(
    date: Date,
    filters: {
      ventanaId?: string;
      vendedorId?: string;
      includeReversed?: boolean;
    }
  ) {
    const where: Prisma.AccountPaymentWhereInput = {
      date,
      // Incluir todos los pagos (activos y revertidos) por defecto
      ...(filters.includeReversed === false ? { isReversed: false } : {}),
    };

    if (filters.ventanaId) {
      where.ventanaId = filters.ventanaId;
    }
    if (filters.vendedorId) {
      where.vendedorId = filters.vendedorId;
    }

    return await prisma.accountPayment.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: {
        paidBy: {
          select: {
            id: true,
            name: true,
          },
        },
        reversedByUser: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });
  },

  /**
   * Obtiene solo pagos activos (no revertidos) de un día
   * Usado para calcular saldos
   */
  async findActiveByDate(
    date: Date,
    filters: {
      ventanaId?: string;
      vendedorId?: string;
    }
  ) {
    const where: Prisma.AccountPaymentWhereInput = {
      date,
      isReversed: false, // Solo pagos activos
    };

    if (filters.ventanaId) {
      where.ventanaId = filters.ventanaId;
    }
    if (filters.vendedorId) {
      where.vendedorId = filters.vendedorId;
    }

    return await prisma.accountPayment.findMany({
      where,
      orderBy: { createdAt: "desc" },
    });
  },

  /**
   * Obtiene un pago por ID
   */
  async findById(id: string) {
    return await prisma.accountPayment.findUnique({
      where: { id },
      include: {
        accountStatement: true,
        paidBy: {
          select: {
            id: true,
            name: true,
          },
        },
        reversedByUser: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });
  },

  /**
   * Revierte un pago
   */
  async reverse(id: string, reversedBy: string) {
    return await prisma.accountPayment.update({
      where: { id },
      data: {
        isReversed: true,
        reversedAt: new Date(),
        reversedBy,
      },
      include: {
        accountStatement: true,
      },
    });
  },

  /**
   * Obtiene total pagado (solo payments) de un statement
   *  CORREGIDO: Para ventanas, solo cuenta pagos propios (vendedorId = null), NO de vendedores
   * Para vendedores, solo cuenta pagos del vendedor específico
   * 
   * Fórmula correcta: remainingBalance = baseBalance - totalCollected + totalPaid
   * Este método retorna solo totalPaid (suma de payments)
   */
  async getTotalPaid(accountStatementId: string) {
    // Obtener el statement para determinar si es de ventana o vendedor
    const statement = await prisma.accountStatement.findUnique({
      where: { id: accountStatementId },
      select: { ventanaId: true, vendedorId: true },
    });

    const where: Prisma.AccountPaymentWhereInput = {
      accountStatementId,
      isReversed: false,
      type: "payment", // Solo payments
    };

    //  CRÍTICO: Si es statement de ventana (ventanaId presente, vendedorId = null)
    // Solo contar pagos propios de la ventana (vendedorId = null), NO de vendedores
    if (statement?.ventanaId && !statement.vendedorId) {
      where.vendedorId = null; // Solo pagos consolidados de ventana
    }
    // Si es statement de vendedor, ya está filtrado por accountStatementId que tiene el vendedorId correcto

    const payments = await prisma.accountPayment.findMany({
      where: {
        ...where,
        //  CRÍTICO: Excluir explícitamente el saldo del mes anterior
        //  FIX: Manejar notes=null correctamente (NULL LIKE '%text%' retorna NULL, no false)
        method: { not: ACCOUNT_PREVIOUS_MONTH_METHOD },
        OR: [
          { notes: null },
          { NOT: { notes: { contains: ACCOUNT_CARRY_OVER_NOTES } } }
        ]
      },
      select: {
        amount: true,
      },
    });

    return payments.reduce((sum, p) => sum + p.amount, 0);
  },

  /**
   * Obtiene total cobrado (solo collections) de un statement
   *  CORREGIDO: Para ventanas, solo cuenta cobros propios (vendedorId = null), NO de vendedores
   * Para vendedores, solo cuenta cobros del vendedor específico
   * 
   * Fórmula correcta: remainingBalance = baseBalance - totalCollected + totalPaid
   */
  async getTotalCollected(accountStatementId: string) {
    // Obtener el statement para determinar si es de ventana o vendedor
    const statement = await prisma.accountStatement.findUnique({
      where: { id: accountStatementId },
      select: { ventanaId: true, vendedorId: true },
    });

    const where: Prisma.AccountPaymentWhereInput = {
      accountStatementId,
      isReversed: false,
      type: "collection", // Solo collections
    };

    //  CRÍTICO: Si es statement de ventana (ventanaId presente, vendedorId = null)
    // Solo contar cobros propios de la ventana (vendedorId = null), NO de vendedores
    if (statement?.ventanaId && !statement.vendedorId) {
      where.vendedorId = null; // Solo cobros consolidados de ventana
    }
    // Si es statement de vendedor, ya está filtrado por accountStatementId que tiene el vendedorId correcto

    const collections = await prisma.accountPayment.findMany({
      where: {
        ...where,
        //  CRÍTICO: Excluir explícitamente el saldo del mes anterior
        //  FIX: Manejar notes=null correctamente (NULL LIKE '%text%' retorna NULL, no false)
        method: { not: ACCOUNT_PREVIOUS_MONTH_METHOD },
        OR: [
          { notes: null },
          { NOT: { notes: { contains: ACCOUNT_CARRY_OVER_NOTES } } }
        ]
      },
      select: {
        amount: true,
      },
    });

    return collections.reduce((sum, p) => sum + p.amount, 0);
  },

  /**
   *  NUEVO: Obtiene total de pagos y cobros combinados (no revertidos) de un statement
   * Suma el valor absoluto de todos los movimientos activos (payment + collection)
   */
  async getTotalPaymentsCollections(accountStatementId: string) {
    const movements = await prisma.accountPayment.findMany({
      where: {
        accountStatementId,
        isReversed: false, // Solo movimientos no revertidos
        //  CRÍTICO: Excluir explícitamente el saldo del mes anterior
        //  FIX: Manejar notes=null correctamente (NULL LIKE '%text%' retorna NULL, no false)
        method: { not: ACCOUNT_PREVIOUS_MONTH_METHOD },
        OR: [
          { notes: null },
          { NOT: { notes: { contains: ACCOUNT_CARRY_OVER_NOTES } } }
        ]
      },
      select: {
        amount: true,
      },
    });

    // Sumar el valor absoluto de todos los montos
    return movements.reduce((sum, m) => sum + Math.abs(m.amount), 0);
  },

  /**
   * Obtiene todos los pagos/cobros de un statement (para historial)
   */
  async findByStatementId(accountStatementId: string) {
    const payments = await prisma.accountPayment.findMany({
      where: {
        accountStatementId,
      },
      orderBy: { createdAt: "asc" },
      include: {
        paidBy: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    //  NUEVO: Incluir campo time en la respuesta
    return payments.map(payment => ({
      ...payment,
      time: payment.time || null,
    }));
  },

  /**
   *  OPTIMIZACIÓN: Obtiene totales de pagos y cobros para múltiples statements en una sola query
   * Retorna un Map<statementId, { totalPaid, totalCollected, totalPaymentsCollections }>
   */
  async findPaymentsTotalsBatch(accountStatementIds: string[]): Promise<Map<string, { totalPaid: number; totalCollected: number; totalPaymentsCollections: number }>> {
    if (accountStatementIds.length === 0) {
      return new Map();
    }

    // Obtener todos los pagos activos de los statements en una sola query
    const payments = await prisma.accountPayment.findMany({
      where: {
        accountStatementId: { in: accountStatementIds },
        isReversed: false,
        //  CRÍTICO: Excluir explícitamente el saldo del mes anterior
        //  FIX: Manejar notes=null correctamente (NULL LIKE '%text%' retorna NULL, no false)
        method: { not: ACCOUNT_PREVIOUS_MONTH_METHOD },
        OR: [
          { notes: null },
          { NOT: { notes: { contains: ACCOUNT_CARRY_OVER_NOTES } } }
        ]
      },
      select: {
        accountStatementId: true,
        type: true,
        amount: true,
      },
    });

    // Agrupar por statementId y tipo
    const totalsMap = new Map<string, { totalPaid: number; totalCollected: number; totalPaymentsCollections: number }>();

    // Inicializar todos los statements con 0
    for (const id of accountStatementIds) {
      totalsMap.set(id, { totalPaid: 0, totalCollected: 0, totalPaymentsCollections: 0 });
    }

    // Sumar los montos
    for (const payment of payments) {
      const totals = totalsMap.get(payment.accountStatementId) || { totalPaid: 0, totalCollected: 0, totalPaymentsCollections: 0 };
      const absAmount = Math.abs(payment.amount);
      if (payment.type === "payment") {
        totals.totalPaid += payment.amount;
      } else if (payment.type === "collection") {
        totals.totalCollected += payment.amount;
      }
      //  NUEVO: Sumar valor absoluto para totalPaymentsCollections
      totals.totalPaymentsCollections += absAmount;
      totalsMap.set(payment.accountStatementId, totals);
    }

    return totalsMap;
  },

  /**
   *  OPTIMIZACIÓN: Obtiene todos los movimientos de múltiples statements en una sola query
   * Retorna un Map<statementId, movements[]>
   */
  /**
   *  NUEVO: Obtiene movimientos agrupados por fecha sin depender de AccountStatement
   */
  async findMovementsByDateRange(
    startDate: Date,
    endDate: Date,
    dimension: "banca" | "ventana" | "vendedor", //  NUEVO: Agregado 'banca'
    ventanaId?: string,
    vendedorId?: string,
    bancaId?: string,
    includeChildren: boolean = false //  NUEVO: Flag para incluir movimientos de dependientes (ventanas/vendedores)
  ): Promise<Map<string, any[]>> {
    //  CRÍTICO: Convertir timestamps UTC a fechas YYYY-MM-DD en hora CR
    // El campo 'date' en AccountPayment es tipo DATE (sin hora), se almacena como YYYY-MM-DD
    // Prisma lo interpreta como medianoche UTC (ej: 2026-01-29 → 2026-01-29T00:00:00.000Z)
    // Si usamos timestamps UTC directamente, podemos incluir/excluir días incorrectos
    // Ejemplo: endDate=2026-01-29T05:59:59Z (23:59 CR del 28) incluiría 2026-01-29T00:00:00Z (día 29)
    const startCR = getCRLocalComponents(startDate);
    const endCR = getCRLocalComponents(endDate);
    const startDateStr = `${startCR.year}-${String(startCR.month).padStart(2, '0')}-${String(startCR.day).padStart(2, '0')}`;
    const endDateStr = `${endCR.year}-${String(endCR.month).padStart(2, '0')}-${String(endCR.day).padStart(2, '0')}`;

    const where: Prisma.AccountPaymentWhereInput = {
      date: {
        gte: new Date(startDateStr + 'T00:00:00.000Z'),
        lte: new Date(endDateStr + 'T00:00:00.000Z'),
      },
      //  CRÍTICO: Incluir TODOS los movimientos (activos y revertidos) para auditoría
      // Los cálculos en accounts.calculations.ts filtran !isReversed cuando es necesario
      //  CRÍTICO 2: Excluir explícitamente el saldo del mes anterior para que NO infla balances operativos
      //  FIX: Manejar notes=null correctamente (NULL LIKE '%text%' retorna NULL, no false)
      method: { not: ACCOUNT_PREVIOUS_MONTH_METHOD },
      OR: [
        { notes: null },
        { NOT: { notes: { contains: ACCOUNT_CARRY_OVER_NOTES } } }
      ]
    };

    if (dimension === "banca") {
      //  CRÍTICO: Usar bancaId directamente (persistido) en lugar de JOIN con ventana
      // Esto es mucho más eficiente y funciona correctamente con datos históricos
      if (bancaId) {
        where.bancaId = bancaId;
      } else {
        // Si es "Todas las Bancas", asegurar que tenga bancaId
        where.bancaId = { not: null };
      }

      /**
       * ========================================================================
       * FILTRADO DE MOVIMIENTOS POR BANCA
       * ========================================================================
       * 
       * REGLA CRÍTICA: 
       * - Si includeChildren=true (para Balances): Incluir TODOS los movimientos de la banca (propios + dependientes).
       * - Si includeChildren=false (para Historial): SOLO incluir movimientos administrativos propios de la banca.
       */
      if (!includeChildren) {
        //  CRÍTICO: Solo movimientos propios (administrativos)
        if (!ventanaId && !vendedorId) {
          where.ventanaId = null;
          where.vendedorId = null;
        } else {
          // En casos raros donde se filtre por dimensión banca pero se especifique ventana/vendedor
          if (ventanaId) {
            where.ventanaId = ventanaId;
          }
          if (vendedorId) {
            where.vendedorId = vendedorId;
          }
        }
      }
      // Si includeChildren=true, NO filtramos por ventanaId/vendedorId=null, 
      // permitiendo que vengan movimientos con ventanaId/vendedorId (hijos)
    } else if (dimension === "ventana") {
      /**
       * ========================================================================
       * FILTRADO DE MOVIMIENTOS POR VENTANA
       * ========================================================================
       *
       * REGLA CRÍTICA: Los pagos/cobros de vendedores NO deben afectar el estado de cuenta de la ventana
       * Cuando dimension='ventana' y hay un ventanaId específico, SOLO incluir:
       * - Movimientos consolidados de ventana (vendedorId = null)
       *
       * NO incluir movimientos de vendedores específicos (vendedorId != null)
       * porque esos afectan solo al estado de cuenta del vendedor, no de la ventana.
       *
       * ========================================================================
       */
      if (ventanaId) {
        //  CRÍTICO: Cuando hay un ventanaId específico, SOLO incluir movimientos propios de la ventana
        // (vendedorId = null), NO movimientos de vendedores
        where.ventanaId = ventanaId;
        where.vendedorId = null; //  CRÍTICO: Solo movimientos consolidados de ventana
      } else {
        // Sin ventanaId específico: solo movimientos consolidados de ventana (sin vendedorId)
        // Esto es para cuando se consulta todas las ventanas sin especificar una
        where.ventanaId = { not: null };
        where.vendedorId = null;
      }
    } else {
      if (vendedorId) {
        where.vendedorId = vendedorId;
      } else {
        where.vendedorId = { not: null };
      }
    }

    if (bancaId && dimension !== "banca") {
      //  CRÍTICO: Usar bancaId directamente (persistido) en lugar de JOIN con ventana
      // Si bancaId está presente pero dimension no es 'banca', filtrar por banca también
      where.bancaId = bancaId;
    }

    const payments = await prisma.accountPayment.findMany({
      where,
      include: {
        paidBy: {
          select: {
            id: true,
            name: true,
          },
        },
        banca: {
          //  CRÍTICO: Incluir relación directa con Banca (persistida)
          select: {
            id: true,
            name: true,
            code: true,
          },
        },
        ventana: {
          select: {
            name: true,
            code: true,
            bancaId: true, // Mantener para compatibilidad
            banca: { // Mantener para compatibilidad (fallback si bancaId no está persistido)
              select: {
                id: true,
                name: true,
                code: true,
              },
            },
          },
        },
        vendedor: {
          select: {
            name: true,
            code: true, //  NUEVO: Código de vendedor
          },
        },
      },
      orderBy: { createdAt: "asc" },
    });

    // USAR crDateService para conversiones consistentes
    const movementsMap = new Map<string, any[]>();
    for (const payment of payments) {
      // ️ CRÍTICO: payment.date es un DATE de PostgreSQL, ya representa el día correcto
      const dateKey = crDateService.postgresDateToCRString(payment.date);
      if (!movementsMap.has(dateKey)) {
        movementsMap.set(dateKey, []);
      }
      movementsMap.get(dateKey)!.push({
        id: payment.id,
        accountStatementId: payment.accountStatementId,
        date: dateKey,
        time: payment.time || null, //  NUEVO: Hora del movimiento si está disponible
        amount: payment.amount,
        type: payment.type,
        method: payment.method,
        notes: payment.notes,
        isFinal: payment.isFinal,
        isReversed: payment.isReversed,
        //  CRÍTICO: Serializar reversedAt como ISO string para consistencia con la API
        reversedAt: payment.reversedAt ? payment.reversedAt.toISOString() : null,
        reversedBy: payment.reversedBy,
        paidById: payment.paidById,
        paidByName: payment.paidBy?.name || payment.paidByName,
        createdAt: payment.createdAt.toISOString(),
        updatedAt: payment.updatedAt.toISOString(),
        bancaId: payment.bancaId || null, //  CRÍTICO: Usar bancaId persistido directamente
        bancaName: (payment as any).banca?.name || (payment as any).ventana?.banca?.name || null, //  Priorizar banca directa, fallback a ventana.banca
        bancaCode: (payment as any).banca?.code || (payment as any).ventana?.banca?.code || null, //  Priorizar banca directa, fallback a ventana.banca
        ventanaId: payment.ventanaId,
        ventanaName: (payment as any).ventana?.name || null,
        ventanaCode: (payment as any).ventana?.code || null, //  NUEVO: Código de ventana
        vendedorId: payment.vendedorId,
        vendedorName: (payment as any).vendedor?.name || null,
        vendedorCode: (payment as any).vendedor?.code || null, //  NUEVO: Código de vendedor
      });
    }

    return movementsMap;
  },

  async findMovementsBatch(accountStatementIds: string[]): Promise<Map<string, any[]>> {
    if (accountStatementIds.length === 0) {
      return new Map();
    }

    const payments = await prisma.accountPayment.findMany({
      where: {
        accountStatementId: { in: accountStatementIds },
      },
      orderBy: { createdAt: "asc" },
      include: {
        paidBy: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    // Agrupar por statementId
    const movementsMap = new Map<string, any[]>();
    for (const id of accountStatementIds) {
      movementsMap.set(id, []);
    }

    for (const payment of payments) {
      const movements = movementsMap.get(payment.accountStatementId) || [];
      movements.push({
        id: payment.id,
        accountStatementId: payment.accountStatementId,
        date: payment.date.toISOString().split("T")[0],
        time: payment.time || null, //  NUEVO: Hora del movimiento si está disponible
        amount: payment.amount,
        type: payment.type,
        method: payment.method,
        notes: payment.notes,
        isFinal: payment.isFinal,
        isReversed: payment.isReversed,
        reversedAt: payment.reversedAt?.toISOString() || null,
        reversedBy: payment.reversedBy,
        paidById: payment.paidById,
        paidByName: payment.paidByName,
        createdAt: payment.createdAt.toISOString(),
        updatedAt: payment.updatedAt.toISOString(),
      });
      movementsMap.set(payment.accountStatementId, movements);
    }

    return movementsMap;
  },
};

