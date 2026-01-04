import prisma from "../core/prismaClient";
import { Prisma } from "@prisma/client";
import logger from "../core/logger";

export const AccountStatementRepository = {
  /**
   * Encuentra o crea un estado de cuenta para una fecha específica
   * ✅ CRÍTICO: Usa transacciones con locking para evitar condiciones de carrera
   * cuando múltiples pagos/cobros se registran simultáneamente
   */
  async findOrCreate(data: {
    date: Date;
    month: string;
    bancaId?: string;
    ventanaId?: string;
    vendedorId?: string;
  }) {
    // ✅ CRÍTICO: Inferir bancaId y ventanaId si no están presentes
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

    // ✅ CRÍTICO: Usar transacción con locking para evitar condiciones de carrera
    // Esto asegura que solo un proceso pueda crear/actualizar el statement a la vez
    return await prisma.$transaction(async (tx) => {
      const where: Prisma.AccountStatementWhereInput = {
        date: data.date,
      };

      // ✅ ACTUALIZADO: Permitir búsqueda con ambos campos presentes
      // El constraint _one_relation_check ha sido eliminado
      if (data.vendedorId) {
        // Si hay vendedorId, buscar por vendedorId (con o sin ventanaId)
        // Los constraints únicos parciales protegen la unicidad por vendedor
        where.vendedorId = data.vendedorId;
        // Si también hay ventanaId, incluirlo en la búsqueda para mayor precisión
        if (finalVentanaId) {
          where.ventanaId = finalVentanaId;
        }
      } else if (finalVentanaId) {
        // Si solo hay ventanaId (sin vendedorId), buscar statement consolidado de ventana
        where.ventanaId = finalVentanaId;
        where.vendedorId = null; // Statement consolidado de ventana
      } else {
        // Sin ninguno, buscar statement general (caso raro, pero permitido)
        where.ventanaId = null;
        where.vendedorId = null;
      }

      // ✅ CRÍTICO: Buscar con locking usando raw SQL para SELECT FOR UPDATE
      // Esto bloquea el registro hasta que la transacción termine, evitando condiciones de carrera
      // ✅ IMPORTANTE: El constraint único es (date, ventanaId), por lo que cuando hay ventanaId,
      // siempre debe buscar primero el statement consolidado de ventana para que múltiples pagos
      // del mismo día usen el mismo statement
      let existing: any = null;

      // ✅ PRIORIDAD 1: Si hay ventanaId, buscar primero el statement consolidado de ventana
      // Esto asegura que todos los pagos del mismo día para la misma ventana usen el mismo statement
      if (finalVentanaId) {
        // Buscar statement consolidado de ventana (vendedorId: null)
        const result = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM "AccountStatement"
          WHERE date = ${data.date}
            AND "ventanaId" = ${finalVentanaId}::uuid
            AND "vendedorId" IS NULL
          FOR UPDATE
          LIMIT 1
        `;
        if (result.length > 0) {
          existing = await tx.accountStatement.findUnique({
            where: { id: result[0].id },
          });
        }

        // ✅ Si no encontramos consolidado pero hay vendedorId, buscar por vendedorId con ventanaId
        // (puede existir un statement incorrecto que necesita corrección)
        if (!existing && data.vendedorId) {
          const result = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT id FROM "AccountStatement"
            WHERE date = ${data.date}
              AND "vendedorId" = ${data.vendedorId}::uuid
              AND "ventanaId" = ${finalVentanaId}::uuid
            FOR UPDATE
            LIMIT 1
          `;
          if (result.length > 0) {
            existing = await tx.accountStatement.findUnique({
              where: { id: result[0].id },
            });
          }
        }

        // ✅ Si aún no encontramos, buscar por vendedorId con ventanaId: null
        // (statement incorrecto que necesita corrección)
        if (!existing && data.vendedorId) {
          const result = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT id FROM "AccountStatement"
            WHERE date = ${data.date}
              AND "vendedorId" = ${data.vendedorId}::uuid
              AND "ventanaId" IS NULL
            FOR UPDATE
            LIMIT 1
          `;
          if (result.length > 0) {
            existing = await tx.accountStatement.findUnique({
              where: { id: result[0].id },
            });
          }
        }
      } else if (data.vendedorId) {
        // ✅ PRIORIDAD 2: Si solo hay vendedorId (sin ventanaId), buscar por vendedorId
        const result = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM "AccountStatement"
          WHERE date = ${data.date}
            AND "vendedorId" = ${data.vendedorId}::uuid
            AND "ventanaId" IS NULL
          FOR UPDATE
          LIMIT 1
        `;
        if (result.length > 0) {
          existing = await tx.accountStatement.findUnique({
            where: { id: result[0].id },
          });
        }
      } else {
        // ✅ PRIORIDAD 3: Buscar statement general (sin ventanaId ni vendedorId)
        const result = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM "AccountStatement"
          WHERE date = ${data.date}
            AND "ventanaId" IS NULL
            AND "vendedorId" IS NULL
          FOR UPDATE
          LIMIT 1
        `;
        if (result.length > 0) {
          existing = await tx.accountStatement.findUnique({
            where: { id: result[0].id },
          });
        }
      }

      if (existing) {
        // ✅ CRÍTICO: Si el statement existe pero le faltan ventanaId o bancaId, actualizarlo
        // Esto es importante cuando se crea un pago/cobro y el statement ya existe pero
        // fue creado antes de que implementáramos la persistencia de estos campos
        // IMPORTANTE: Si el statement tiene ventanaId: null pero debería tenerlo, primero
        // verificamos si ya existe otro statement con el ventanaId corregido (violaría constraint único)
        let needsUpdate = false;
        const updateData: { ventanaId?: string | null; bancaId?: string | null } = {};

        // Si falta ventanaId pero debería tenerlo
        if (!existing.ventanaId && finalVentanaId) {
          // Verificar si ya existe un statement con este ventanaId y date (constraint único)
          const conflictingStatement = await tx.accountStatement.findFirst({
            where: {
              date: data.date,
              ventanaId: finalVentanaId,
              vendedorId: null, // Statement consolidado de ventana
            },
          });

          if (conflictingStatement) {
            // Ya existe un statement consolidado de ventana
            // Retornar el consolidado en lugar del incorrecto
            logger.info({
              layer: 'repository',
              action: 'ACCOUNT_STATEMENT_USE_CONSOLIDADO',
              payload: {
                date: data.date,
                vendedorId: data.vendedorId,
                ventanaId: finalVentanaId,
                incorrectStatementId: existing.id,
                consolidadoStatementId: conflictingStatement.id,
                note: 'Using consolidado statement instead of incorrect one with ventanaId: null',
              },
            });
            return conflictingStatement;
          }

          // También verificar si existe un statement con ventanaId y vendedorId (otro vendedor de la misma ventana)
          // En este caso, no podemos crear/actualizar porque violaría el constraint (date, ventanaId)
          const anotherVendedorStatement = await tx.accountStatement.findFirst({
            where: {
              date: data.date,
              ventanaId: finalVentanaId,
              vendedorId: { not: null }, // Otro vendedor
            },
          });

          if (anotherVendedorStatement) {
            // Ya existe un statement de otro vendedor para esta ventana y fecha
            // Por el constraint (date, ventanaId), no podemos tener múltiples
            // Retornar el existente sin actualizar
            logger.warn({
              layer: 'repository',
              action: 'ACCOUNT_STATEMENT_CONSTRAINT_CONFLICT',
              payload: {
                date: data.date,
                vendedorId: data.vendedorId,
                attemptedVentanaId: finalVentanaId,
                existingStatementId: existing.id,
                conflictingStatementId: anotherVendedorStatement.id,
                note: 'Cannot update ventanaId: null to ventanaId because another vendedor statement exists for same ventana and date',
              },
            });
            return existing;
          }

          updateData.ventanaId = finalVentanaId;
          needsUpdate = true;
        }

        // Si falta bancaId pero debería tenerlo
        if (!existing.bancaId && finalBancaId) {
          updateData.bancaId = finalBancaId;
          needsUpdate = true;
        }

        // Actualizar si es necesario
        if (needsUpdate) {
          return await tx.accountStatement.update({
            where: { id: existing.id },
            data: updateData,
          });
        }

        return existing;
      }

      // ✅ CRÍTICO: Antes de crear, verificar si ya existe un statement con la misma date y ventanaId
      // El constraint único (date, ventanaId) no permite múltiples statements con la misma combinación
      // Esto puede pasar si otro proceso creó el statement después de nuestra búsqueda inicial
      if (finalVentanaId) {
        const conflictingStatement = await tx.accountStatement.findFirst({
          where: {
            date: data.date,
            ventanaId: finalVentanaId,
          },
        });

        if (conflictingStatement) {
          // Ya existe un statement con esta combinación de date y ventanaId
          // ✅ CORREGIDO: Actualizar campos básicos si están desactualizados antes de retornar
          // Esto evita mantener valores antiguos incorrectos
          const needsUpdate = 
            (!conflictingStatement.bancaId && finalBancaId) ||
            (!conflictingStatement.ventanaId && finalVentanaId);
          
          if (needsUpdate) {
            try {
              const updated = await tx.accountStatement.update({
                where: { id: conflictingStatement.id },
                data: {
                  ...(finalBancaId && !conflictingStatement.bancaId ? { bancaId: finalBancaId } : {}),
                  ...(finalVentanaId && !conflictingStatement.ventanaId ? { ventanaId: finalVentanaId } : {}),
                },
              });
              return updated;
            } catch (updateError) {
              // Si falla la actualización, retornar el existente de todas formas
              logger.warn({
                layer: 'repository',
                action: 'ACCOUNT_STATEMENT_UPDATE_FAILED',
                payload: {
                  statementId: conflictingStatement.id,
                  error: (updateError as Error).message,
                },
              });
            }
          }
          
          logger.info({
            layer: 'repository',
            action: 'ACCOUNT_STATEMENT_CONSTRAINT_PREVENTED',
            payload: {
              date: data.date,
              ventanaId: finalVentanaId,
              vendedorId: data.vendedorId,
              existingStatementId: conflictingStatement.id,
              updated: needsUpdate,
              note: 'Prevented creation of duplicate statement, using existing one',
            },
          });
          return conflictingStatement;
        }
      }

      // ✅ ACTUALIZADO: Crear con ambos campos si están presentes, incluyendo bancaId
      // Usar try-catch para manejar errores de constraint único en caso de condición de carrera
      try {
        return await tx.accountStatement.create({
          data: {
            date: data.date,
            month: data.month,
            bancaId: finalBancaId ?? null,
            ventanaId: finalVentanaId ?? null,
            vendedorId: data.vendedorId ?? null,
          },
        });
      } catch (error: any) {
        // Si falla por constraint único, buscar el statement existente
        if (error.code === 'P2002') {
          logger.warn({
            layer: 'repository',
            action: 'ACCOUNT_STATEMENT_CONSTRAINT_RACE_CONDITION',
            payload: {
              date: data.date,
              ventanaId: finalVentanaId,
              vendedorId: data.vendedorId,
              note: 'Race condition detected, fetching existing statement',
            },
          });

          // Buscar el statement que se creó en paralelo
          const existingStatement = await tx.accountStatement.findFirst({
            where: {
              date: data.date,
              ...(finalVentanaId ? { ventanaId: finalVentanaId } : {}),
              ...(data.vendedorId ? { vendedorId: data.vendedorId } : {}),
            },
          });

          if (existingStatement) {
            return existingStatement;
          }

          // Si no se encuentra, relanzar el error
          throw error;
        }
        throw error;
      }
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable, // ✅ CRÍTICO: Usar nivel de aislamiento más estricto para evitar condiciones de carrera
      timeout: 10000, // 10 segundos de timeout
    });
  },

  /**
   * Actualiza un estado de cuenta
   */
  async update(id: string, data: {
    totalSales?: number;
    totalPayouts?: number;
    listeroCommission?: number;
    vendedorCommission?: number;
    balance?: number;
    totalPaid?: number;
    totalCollected?: number; // ✅ Campo para totales de collections
    remainingBalance?: number;
    accumulatedBalance?: number; // ✅ NUEVO: Campo para balance acumulado
    isSettled?: boolean;
    canEdit?: boolean;
    ticketCount?: number;
    ventanaId?: string | null;
    vendedorId?: string | null;
    settledAt?: Date | null;
    settledBy?: string | null;
  }) {
    return await prisma.accountStatement.update({
      where: { id },
      data,
    });
  },

  /**
   * Obtiene estados de cuenta por mes
   */
  async findByMonth(
    month: string,
    filters: {
      ventanaId?: string;
      vendedorId?: string;
    },
    options: {
      sort?: "asc" | "desc";
      include?: Prisma.AccountStatementInclude;
    } = {}
  ) {
    const where: Prisma.AccountStatementWhereInput = {
      month,
    };

    // ✅ ACTUALIZADO: Permitir búsqueda con ambos campos presentes
    // El constraint _one_relation_check ha sido eliminado
    if (filters.vendedorId) {
      // Si hay vendedorId, buscar por vendedorId (puede tener o no ventanaId)
      where.vendedorId = filters.vendedorId;
      if (filters.ventanaId) {
        where.ventanaId = filters.ventanaId;
      }
    } else if (filters.ventanaId) {
      // Si solo hay ventanaId, buscar statements consolidados de ventana
      where.ventanaId = filters.ventanaId;
      // No forzar vendedorId=null, permitir ambos casos
    }

    return await prisma.accountStatement.findMany({
      where,
      orderBy: { date: options.sort || "desc" },
      include: options.include,
    });
  },

  /**
   * Obtiene totales acumulados del mes
   */
  async getMonthTotals(
    month: string,
    filters: {
      ventanaId?: string;
      vendedorId?: string;
    }
  ) {
    const where: Prisma.AccountStatementWhereInput = {
      month,
    };

    if (filters.ventanaId) {
      where.ventanaId = filters.ventanaId;
    }
    if (filters.vendedorId) {
      where.vendedorId = filters.vendedorId;
    }

    const result = await prisma.accountStatement.aggregate({
      where,
      _sum: {
        totalSales: true,
        totalPayouts: true,
        listeroCommission: true,
        vendedorCommission: true,
        balance: true,
        totalPaid: true,
        remainingBalance: true,
      },
      _count: {
        id: true,
      },
    });

    const all = await prisma.accountStatement.findMany({
      where,
      select: { isSettled: true },
    });

    const settledDays = all.filter((s) => s.isSettled).length;
    const pendingDays = all.filter((s) => !s.isSettled).length;

    return {
      totalSales: result._sum.totalSales ?? 0,
      totalPayouts: result._sum.totalPayouts ?? 0,
      totalListeroCommission: result._sum.listeroCommission ?? 0,
      totalVendedorCommission: result._sum.vendedorCommission ?? 0,
      totalBalance: result._sum.balance ?? 0,
      totalPaid: result._sum.totalPaid ?? 0,
      totalRemainingBalance: result._sum.remainingBalance ?? 0,
      settledDays,
      pendingDays,
    };
  },

  /**
   * Obtiene un estado de cuenta por fecha
   */
  async findByDate(
    date: Date,
    filters: {
      ventanaId?: string;
      vendedorId?: string;
    }
  ) {
    const where: Prisma.AccountStatementWhereInput = {
      date,
    };

    // ✅ ACTUALIZADO: Permitir búsqueda con ambos campos presentes
    // El constraint _one_relation_check ha sido eliminado
    if (filters.vendedorId) {
      where.vendedorId = filters.vendedorId;
      if (filters.ventanaId) {
        where.ventanaId = filters.ventanaId;
      }
    } else if (filters.ventanaId) {
      where.ventanaId = filters.ventanaId;
    }
    // ✅ FIX: Si no se especifica ninguno, NO forzar ventanaId/vendedorId a null
    // Dejar que la query encuentre cualquier statement para esa fecha
    // (sin restricción de dimension)

    return await prisma.accountStatement.findFirst({
      where,
      include: {
        ventana: {
          select: {
            id: true,
            name: true,
            code: true,
          },
        },
        vendedor: {
          select: {
            id: true,
            name: true,
            code: true,
          },
        },
      },
    });
  },

  /**
   * Elimina un estado de cuenta
   */
  async delete(id: string) {
    return await prisma.accountStatement.delete({
      where: { id },
    });
  },

  /**
   * Obtiene un estado de cuenta por ID
   */
  async findById(id: string) {
    return await prisma.accountStatement.findUnique({
      where: { id },
      include: {
        payments: true, // Incluir todos los pagos para validación completa
      },
    });
  },
};

