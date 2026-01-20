import prisma from "../core/prismaClient";
import { Prisma } from "@prisma/client";
import logger from "../core/logger";

export const AccountStatementRepository = {
  /**
   * Encuentra o crea un estado de cuenta para una fecha específica
   *  CRÍTICO: No usa upsert() para evitar issues con constraint naming en Prisma
   * En su lugar, busca primero y si no existe, crea
   */
  async findOrCreate(data: {
    date: Date;
    month: string;
    bancaId?: string;
    ventanaId?: string;
    vendedorId?: string;
  }) {
    let finalVentanaId: string | undefined = data.ventanaId;
    let finalBancaId: string | undefined = data.bancaId;

    // Inferir ventana desde vendedor
    if (!finalVentanaId && data.vendedorId) {
      const vendedor = await prisma.user.findUnique({
        where: { id: data.vendedorId },
        select: { ventanaId: true },
      });
      finalVentanaId = vendedor?.ventanaId ?? undefined; //  sin null
    }

    // Inferir banca desde ventana
    if (!finalBancaId && finalVentanaId) {
      const ventana = await prisma.ventana.findUnique({
        where: { id: finalVentanaId },
        select: { bancaId: true },
      });
      finalBancaId = ventana?.bancaId; //  sin null
    }


    /**
     *  REGLA DE BÚSQUEDA Y UNICIDAD
     * Buscamos el statement según la dimensión más específica proporcionada
     */
    let where: any = {
      date: data.date,
    };

    if (data.vendedorId) {
      // Dimensión Vendedor: único por (date, vendedorId)
      where.vendedorId = data.vendedorId;
    } else if (data.ventanaId) {
      // Dimensión Ventana: único por (date, ventanaId) Y vendedorId es NULL
      where.ventanaId = data.ventanaId;
      where.vendedorId = null;
    } else if (data.bancaId) {
      // Dimensión Banca: bancaId Y ventanaId/vendedorId son NULL
      where.bancaId = data.bancaId;
      where.ventanaId = null;
      where.vendedorId = null;
    } else {
      throw new Error("findOrCreate requiere al menos bancaId, ventanaId o vendedorId");
    }

    // Buscar statement existente
    let statement = await prisma.accountStatement.findFirst({
      where: where
    });

    //  SI ENCONTRAMOS UN VENDEDOR: Asegurar que ventanaId sea null (limpieza de datos sucios)
    // Esto evita que un record de vendedor bloquee el consolidado de la ventana
    if (statement && data.vendedorId && statement.ventanaId !== null) {
      statement = await prisma.accountStatement.update({
        where: { id: statement.id },
        data: { ventanaId: null }
      });
    }

    // Si no existe, intentar crear
    if (!statement) {
      try {
        statement = await prisma.accountStatement.create({
          data: {
            date: data.date,
            month: data.month,
            bancaId: finalBancaId ?? null,
            // Para vendedores: ventanaId debe ser null para evitar conflictos con el consolidado
            // (ya que existe un unique constraint sobre [date, ventanaId])
            ventanaId: data.vendedorId ? null : (data.ventanaId ?? null),
            vendedorId: data.vendedorId ?? null,
          },
        });
      } catch (error: any) {
        // P2002 es el código de Prisma para Unique constraint failed
        if (error.code === 'P2002') {
          // Si falló por concurrencia, lo buscamos de nuevo (ya debería existir)
          statement = await prisma.accountStatement.findFirst({
            where: where
          });

          if (statement) {
            logger.info({
              layer: "repository",
              action: "ACCOUNT_STATEMENT_CONCURRENCY_RESOLVED",
              payload: { date: data.date, dimension: data.vendedorId ? 'vendedor' : 'ventana' }
            });
          }

          if (!statement) {
            //  CASO CRÍTICO: Si aún no lo encuentra por 'where', es que existe uno "sucio"
            // que está bloqueando el constraint pero no coincide con nuestro 'where'
            if (data.ventanaId && !data.vendedorId) {
              // Intentar encontrar el culpable (registro con misma date/ventanaId pero vendedorId NOT NULL)
              const culprit = await prisma.accountStatement.findFirst({
                where: {
                  date: data.date,
                  ventanaId: data.ventanaId
                }
              });

              if (culprit) {
                logger.warn({
                  layer: "repository",
                  action: "ACCOUNT_STATEMENT_CULPRIT_FOUND",
                  payload: { id: culprit.id, date: data.date, ventanaId: data.ventanaId, originalVendedorId: culprit.vendedorId }
                });

                // Si encontramos el culpable, lo "limpiamos" quitándole la ventanaId
                // para que deje de bloquear el consolidado
                await prisma.accountStatement.update({
                  where: { id: culprit.id },
                  data: { ventanaId: null }
                });

                // Re-intentar crear el consolidado
                statement = await prisma.accountStatement.create({
                  data: {
                    date: data.date,
                    month: data.month,
                    bancaId: finalBancaId ?? null,
                    ventanaId: data.ventanaId,
                    vendedorId: null,
                  },
                });

                logger.info({
                  layer: "repository",
                  action: "ACCOUNT_STATEMENT_CULPRIT_RESOLVED",
                  payload: { date: data.date, ventanaId: data.ventanaId }
                });
              }
            }
          }

          if (!statement) {
            logger.error({
              layer: "repository",
              action: "ACCOUNT_STATEMENT_CONCURRENCY_ERROR",
              payload: {
                where,
                data,
                error: error.message
              }
            });
            throw new Error("Error de concurrencia crítico: no se pudo crear ni encontrar el statement");
          }
        } else {
          throw error; // Si es otro error, lanzarlo
        }
      }
    } else if (finalBancaId && !statement.bancaId) {
      // Actualizar bancaId si faltaba
      statement = await prisma.accountStatement.update({
        where: { id: statement.id },
        data: { bancaId: finalBancaId },
      });
    }

    return statement;
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
    totalCollected?: number; //  Campo para totales de collections
    remainingBalance?: number;
    accumulatedBalance?: number; //  NUEVO: Campo para balance acumulado
    isSettled?: boolean;
    canEdit?: boolean;
    ticketCount?: number;
    // ventanaId and vendedorId are immutable after creation and should not be updated here
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

    //  ACTUALIZADO: Permitir búsqueda con ambos campos presentes
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
      bancaId?: string;
    }
  ) {
    const where: Prisma.AccountStatementWhereInput = {
      date,
    };

    //  CRÍTICO: Implementar filtrado estricto por dimensión
    // Regla: Una entidad solo ve sus propios registros consolidados.
    if (filters.vendedorId) {
      // Nivel Vendedor: vendedorId específico
      where.vendedorId = filters.vendedorId;
    } else if (filters.ventanaId) {
      // Nivel Ventana: ventanaId específico Y vendedorId debe ser NULL (consolidado de ventana)
      where.ventanaId = filters.ventanaId;
      where.vendedorId = null;
    } else if (filters.bancaId) {
      // Nivel Banca: bancaId específico Y ventanaId/vendedorId deben ser NULL (consolidado de banca)
      where.bancaId = filters.bancaId;
      where.ventanaId = null;
      where.vendedorId = null;
    } else {
      // Nivel Global/Todas las Bancas: Mostrar solo consolidados de banca (donde ventanaId y vendedorId son NULL)
      where.ventanaId = null;
      where.vendedorId = null;
    }

    return await prisma.accountStatement.findFirst({
      where,
      include: {
        banca: {
          select: {
            id: true,
            name: true,
          },
        },
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

