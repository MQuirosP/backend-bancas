// src/api/v1/controllers/accounts.controller.ts
import { Response } from "express";
import { createHash } from "crypto";
import { AccountsService } from "../services/accounts.service";
import { AccountsExportService } from "../services/accounts-export.service";
import { AuthenticatedRequest } from "../../../core/types";
import { success } from "../../../utils/responses";
import { AppError } from "../../../core/errors";
import { Role, ActivityType } from "@prisma/client";
import prisma from "../../../core/prismaClient";
import ActivityService from "../../../core/activity.service";
import logger from "../../../core/logger";
import { AccountPaymentRepository } from "../../../repositories/accountPayment.repository";
import { applyRbacFilters, AuthContext } from "../../../utils/rbac";
import { ExportFormat } from "../types/accounts-export.types";
import { StatementResponse } from "../services/accounts/accounts.types";

/**
 * Calcula el ETag para una respuesta de estado de cuenta
 * Incluye todos los parámetros relevantes para invalidar correctamente el caché
 */
function calculateStatementETag(
  month: string | undefined,
  date: string | undefined,
  fromDate: string | undefined,
  toDate: string | undefined,
  dimension: string | undefined,
  ventanaId: string | undefined,
  vendedorId: string | undefined,
  bancaId: string | undefined,
  scope: string | undefined,
  sort: string | undefined,
  result: StatementResponse
): string {
  // Crear clave única con todos los parámetros relevantes
  const etagRawKey = [
    month || '',
    date || '',
    fromDate || '',
    toDate || '',
    dimension || '',
    ventanaId || '',
    vendedorId || '',
    bancaId || '',
    scope || '',
    sort || '',
    // Incluir hash de los totales para detectar cambios en datos
    JSON.stringify({
      totalSales: result.totals?.totalSales,
      totalPayouts: result.totals?.totalPayouts,
      totalRemainingBalance: result.totals?.totalRemainingBalance,
      statementCount: result.statements?.length || 0,
    })
  ].join(':');
  
  const hash = createHash('sha1').update(etagRawKey).digest('hex');
  return `W/"${hash}"`;
}

export const AccountsController = {
  /**
   * GET /api/v1/accounts/statement
   * Obtiene el estado de cuenta día a día del mes
   */
  async getStatement(req: AuthenticatedRequest, res: Response) {
    if (!req.user) throw new AppError("Unauthorized", 401);
    
    // ✅ NUEVO: Agregar filtros de período
    const { month, date, fromDate, toDate, scope, dimension, bancaId, ventanaId, vendedorId, sort } = req.query as any;
    const user = req.user;

    // Validar permisos según rol
    if (user.role === Role.VENDEDOR) {
      if (scope !== "mine" || dimension !== "vendedor") {
        throw new AppError("Los vendedores solo pueden ver su propio estado de cuenta", 403, "FORBIDDEN");
      }
      // Forzar vendedorId al usuario actual
        const filters = {
          month,
          date, // ✅ NUEVO
          fromDate, // ✅ NUEVO
          toDate, // ✅ NUEVO
          scope: "mine" as const,
          dimension: "vendedor" as const,
          vendedorId: user.id,
          sort: sort || "desc",
          userRole: user.role, // ✅ CRÍTICO: Pasar rol del usuario
        };
      const result = await AccountsService.getStatement(filters) as StatementResponse;
      
      // ✅ ETags: Calcular y verificar antes de procesar
      const etagVal = calculateStatementETag(
        month,
        date,
        fromDate,
        toDate,
        "vendedor",
        undefined,
        user.id,
        undefined,
        "mine",
        sort,
        result
      );
      
      res.setHeader('ETag', etagVal);
      res.setHeader('Cache-Control', 'private, max-age=60, stale-while-revalidate=120');
      
      const ifNoneMatch = req.headers['if-none-match'];
      if (ifNoneMatch && ifNoneMatch === etagVal) {
        return res.status(304).end();
      }
      
      return success(res, result);
    }

    if (user.role === Role.VENTANA) {
      if (scope === "all") {
        throw new AppError("Los usuarios VENTANA no pueden usar scope='all'", 403, "FORBIDDEN");
      }

      // Obtener ventanaId del usuario si no está en el token
      let effectiveVentanaId = user.ventanaId;
      if (!effectiveVentanaId) {
        const userWithVentana = await prisma.user.findUnique({
          where: { id: user.id },
          select: { ventanaId: true },
        });
        effectiveVentanaId = userWithVentana?.ventanaId || null;
      }

      if (!effectiveVentanaId) {
        throw new AppError("El usuario VENTANA no tiene una ventana asignada", 400, "NO_VENTANA");
      }

      if (scope === "mine") {
        if (dimension !== "ventana") {
          throw new AppError("Los usuarios VENTANA con scope='mine' deben usar dimension='ventana'", 400, "INVALID_DIMENSION");
        }
        const filters = {
          month,
          date, // ✅ NUEVO
          fromDate, // ✅ NUEVO
          toDate, // ✅ NUEVO
          scope: "mine" as const,
          dimension: "ventana" as const,
          ventanaId: effectiveVentanaId,
          sort: sort || "desc",
          userRole: user.role, // ✅ CRÍTICO: Pasar rol del usuario
        };
        const result = await AccountsService.getStatement(filters) as StatementResponse;
        
        // ✅ ETags: Calcular y verificar antes de procesar
        const etagVal = calculateStatementETag(
          month,
          date,
          fromDate,
          toDate,
          dimension,
          effectiveVentanaId,
          undefined,
          undefined,
          scope,
          sort,
          result
        );
        
        res.setHeader('ETag', etagVal);
        res.setHeader('Cache-Control', 'private, max-age=60, stale-while-revalidate=120');
        
        const ifNoneMatch = req.headers['if-none-match'];
        if (ifNoneMatch && ifNoneMatch === etagVal) {
          return res.status(304).end();
        }
        
        return success(res, result);
      }

      if (scope === "ventana") {
        if (dimension !== "vendedor") {
          throw new AppError("Los usuarios VENTANA con scope='ventana' deben usar dimension='vendedor'", 400, "INVALID_DIMENSION");
        }
        // ✅ NUEVO: Permitir vendedorId opcional para agrupamiento por "Todos"
        if (vendedorId) {
          // Validar que el vendedor pertenece a la ventana del usuario
          const vendedor = await prisma.user.findUnique({
            where: { id: vendedorId },
            select: { ventanaId: true, role: true },
          });
          if (!vendedor || vendedor.ventanaId !== effectiveVentanaId || vendedor.role !== Role.VENDEDOR) {
            throw new AppError("El vendedor no pertenece a tu ventana", 403, "FORBIDDEN");
          }
        }
        // Si no hay vendedorId, se agrupará automáticamente por fecha con byVendedor[]
        const filters = {
          month,
          date, // ✅ NUEVO
          fromDate, // ✅ NUEVO
          toDate, // ✅ NUEVO
          scope: "ventana" as const,
          dimension: "vendedor" as const,
          ventanaId: effectiveVentanaId,
          vendedorId,
          sort: sort || "desc",
          userRole: user.role, // ✅ CRÍTICO: Pasar rol del usuario
        };
        const result = await AccountsService.getStatement(filters) as StatementResponse;
        
        // ✅ ETags: Calcular y verificar antes de procesar
        const etagVal = calculateStatementETag(
          month,
          date,
          fromDate,
          toDate,
          dimension,
          effectiveVentanaId,
          vendedorId || undefined,
          undefined,
          scope,
          sort,
          result
        );
        
        res.setHeader('ETag', etagVal);
        res.setHeader('Cache-Control', 'private, max-age=60, stale-while-revalidate=120');
        
        const ifNoneMatch = req.headers['if-none-match'];
        if (ifNoneMatch && ifNoneMatch === etagVal) {
          return res.status(304).end();
        }
        
        return success(res, result);
      }
    }

    // ADMIN puede usar cualquier scope y dimension
    if (user.role === Role.ADMIN) {
      // Aplicar RBAC para obtener filtros efectivos (incluye filtro de banca si está activa)
      const context: AuthContext = {
        userId: user.id,
        role: user.role,
        ventanaId: user.ventanaId,
        bancaId: req.bancaContext?.bancaId || null,
      };
      const effectiveFilters = await applyRbacFilters(context, {
        ventanaId,
        vendedorId,
        bancaId, // ✅ CRÍTICO: Pasar bancaId del query para que se incluya en los filtros efectivos
      });
      
      const filters: any = {
        month,
        date, // ✅ NUEVO
        fromDate, // ✅ NUEVO
        toDate, // ✅ NUEVO
        scope: scope || "all",
        dimension: dimension || "ventana",
        ventanaId: effectiveFilters.ventanaId,
        vendedorId: effectiveFilters.vendedorId,
        bancaId: effectiveFilters.bancaId || bancaId || null, // ✅ CRÍTICO: Usar bancaId del query si no está en effectiveFilters
        sort: sort || "desc",
        userRole: user.role, // ✅ CRÍTICO: Pasar rol del usuario para calcular balance correctamente
      };
      
      const result = await AccountsService.getStatement(filters) as StatementResponse;
      
      // Log de auditoría
      await ActivityService.log({
        userId: user.id,
        action: ActivityType.ACCOUNT_STATEMENT_VIEW,
        targetType: "ACCOUNT_STATEMENT",
        targetId: null,
        details: {
          month,
          scope,
          dimension,
          ventanaId: filters.ventanaId || null,
          vendedorId: filters.vendedorId || null,
        },
        layer: "controller",
        requestId: req.requestId,
      });
      
      req.logger?.info({
        layer: "controller",
        action: "ACCOUNT_STATEMENT_VIEW",
        userId: user.id,
        requestId: req.requestId,
        payload: { month, scope, dimension },
      });
      
      // ✅ ETags: Calcular y verificar antes de procesar
      const etagVal = calculateStatementETag(
        month,
        date,
        fromDate,
        toDate,
        dimension,
        filters.ventanaId,
        filters.vendedorId,
        filters.bancaId,
        scope,
        sort,
        result
      );
      
      res.setHeader('ETag', etagVal);
      res.setHeader('Cache-Control', 'private, max-age=60, stale-while-revalidate=120');
      
      const ifNoneMatch = req.headers['if-none-match'];
      if (ifNoneMatch && ifNoneMatch === etagVal) {
        return res.status(304).end();
      }
      
      return success(res, result);
    }

    throw new AppError("Rol no permitido", 403, "FORBIDDEN");
  },

  /**
   * POST /api/v1/accounts/payment
   * Registra un pago o cobro
   */
  async createPayment(req: AuthenticatedRequest, res: Response) {
    const user = req.user!;
    const { date, ventanaId, vendedorId, amount, type, method, notes, isFinal, idempotencyKey } = req.body;

    // Validar permisos según rol
    if (user.role === Role.VENDEDOR) {
      throw new AppError("Los vendedores no pueden registrar pagos/cobros", 403, "FORBIDDEN");
    }

    // Validar que la fecha no sea futura
    const paymentDate = new Date(date + "T00:00:00.000Z");
    const now = new Date();
    if (paymentDate > now) {
      throw new AppError("La fecha no puede ser futura", 400, "FUTURE_DATE");
    }

    // Validar relaciones según rol
    let effectiveVentanaId = ventanaId;
    let effectiveVendedorId = vendedorId;

    if (user.role === Role.VENTANA) {
      // Obtener ventanaId del usuario si no está en el token
      if (!user.ventanaId) {
        const userWithVentana = await prisma.user.findUnique({
          where: { id: user.id },
          select: { ventanaId: true },
        });
        effectiveVentanaId = userWithVentana?.ventanaId || null;
      } else {
        effectiveVentanaId = user.ventanaId;
      }

      if (!effectiveVentanaId) {
        throw new AppError("El usuario VENTANA no tiene una ventana asignada", 400, "NO_VENTANA");
      }

      // Si se proporciona ventanaId, debe ser el del usuario
      if (ventanaId && ventanaId !== effectiveVentanaId) {
        throw new AppError("Solo puedes registrar pagos/cobros de tu propia ventana", 403, "FORBIDDEN");
      }

      // Si se proporciona vendedorId, debe pertenecer a la ventana del usuario
      if (vendedorId) {
        const vendedor = await prisma.user.findUnique({
          where: { id: vendedorId },
          select: { ventanaId: true, role: true },
        });
        if (!vendedor || vendedor.ventanaId !== effectiveVentanaId || vendedor.role !== Role.VENDEDOR) {
          throw new AppError("El vendedor no pertenece a tu ventana", 403, "FORBIDDEN");
        }
        effectiveVentanaId = undefined; // No usar ventanaId cuando es vendedor
      } else {
        effectiveVendedorId = undefined; // No usar vendedorId cuando es ventana
      }
    } else if (user.role === Role.ADMIN) {
      // ADMIN debe proporcionar ventanaId o vendedorId
      if (!ventanaId && !vendedorId) {
        throw new AppError("Debe proporcionar ventanaId o vendedorId", 400, "MISSING_DIMENSION");
      }
      // ✅ ACTUALIZADO: Permitir que ambos estén presentes (ventanaId se inferirá/persistirá cuando hay vendedorId)
      // El constraint _one_relation_check ha sido eliminado
    }

    // Validar que al menos uno de los dos esté presente después del procesamiento
    if (!effectiveVentanaId && !effectiveVendedorId) {
      throw new AppError("Debe proporcionar ventanaId o vendedorId", 400, "MISSING_DIMENSION");
    }

    // ✅ OPTIMIZACIÓN: Usar nombre del usuario del token si está disponible, sino buscar en BD
    // Nota: Si el token incluye el nombre del usuario, podemos evitar esta query
    const paidByName = (user as any).name || "Usuario";

    const result = await AccountsService.createPayment({
      date,
      ventanaId: effectiveVentanaId,
      vendedorId: effectiveVendedorId,
      amount,
      type,
      method,
      notes,
      isFinal,
      idempotencyKey,
      paidById: user.id,
      paidByName,
    }) as { payment: any; statement: any };

    // ✅ NUEVO: La respuesta ahora incluye { payment, statement }
    const { payment, statement } = result;

    // Verificar si es una respuesta cacheada (pago duplicado con idempotencyKey)
    const isCached = (payment as any).cached === true;
    const statusCode = isCached ? 200 : 201;

    // Log de auditoría
    await ActivityService.log({
      userId: user.id,
      action: ActivityType.ACCOUNT_PAYMENT_CREATE,
      targetType: "ACCOUNT_PAYMENT",
      targetId: payment.id,
      details: {
        date,
        amount,
        type,
        method,
        ventanaId: effectiveVentanaId || null,
        vendedorId: effectiveVendedorId || null,
        isFinal,
        cached: isCached,
      },
      layer: "controller",
      requestId: req.requestId,
    });

    req.logger?.info({
      layer: "controller",
      action: "ACCOUNT_PAYMENT_CREATE",
      userId: user.id,
      requestId: req.requestId,
      payload: {
        paymentId: payment.id,
        date,
        amount,
        type,
        method,
        cached: isCached,
      },
    });

    // Limpiar propiedad temporal antes de enviar respuesta
    const paymentResponse = { ...payment };
    delete (paymentResponse as any).cached;

    // ✅ OPTIMIZACIÓN: Incluir statement actualizado en la respuesta para sincronía total con FE
    // Esto evita que el FE tenga que hacer un GET adicional y mejora los tiempos de actualización
    return res.status(statusCode).json({
      success: true,
      data: {
        payment: paymentResponse,
        statement, // ✅ Statement actualizado con totalPaid, totalCollected, remainingBalance, etc.
      },
      ...(isCached ? { meta: { cached: true } } : {}),
    });
  },

  /**
   * GET /api/v1/accounts/payment-history
   * Obtiene el historial de pagos/cobros de un día
   */
  async getPaymentHistory(req: AuthenticatedRequest, res: Response) {
    if (!req.user) throw new AppError("Unauthorized", 401);
    
    const { date, ventanaId, vendedorId } = req.query as any;
    const user = req.user;

    // Validar permisos según rol
    if (user.role === Role.VENDEDOR) {
      // Los vendedores solo pueden ver su propio historial
      const filters = {
        vendedorId: user.id,
      };
      const history = await AccountsService.getPaymentHistory(date, filters);
      
      // Log de auditoría
      await ActivityService.log({
        userId: user.id,
        action: ActivityType.ACCOUNT_PAYMENT_HISTORY_VIEW,
        targetType: "ACCOUNT_PAYMENT",
        targetId: null,
        details: {
          date,
          vendedorId: user.id,
          count: history.length,
        },
        layer: "controller",
        requestId: req.requestId,
      });
      
      req.logger?.info({
        layer: "controller",
        action: "ACCOUNT_PAYMENT_HISTORY_VIEW",
        userId: user.id,
        requestId: req.requestId,
        payload: { date, count: history.length },
      });
      
      return success(res, history, 200);
    }

    if (user.role === Role.VENTANA) {
      // Obtener ventanaId del usuario si no está en el token
      let effectiveVentanaId = user.ventanaId;
      if (!effectiveVentanaId) {
        const userWithVentana = await prisma.user.findUnique({
          where: { id: user.id },
          select: { ventanaId: true },
        });
        effectiveVentanaId = userWithVentana?.ventanaId || null;
      }

      if (!effectiveVentanaId) {
        throw new AppError("El usuario VENTANA no tiene una ventana asignada", 400, "NO_VENTANA");
      }

      // Si se proporciona vendedorId, validar que pertenece a la ventana
      if (vendedorId) {
        const vendedor = await prisma.user.findUnique({
          where: { id: vendedorId },
          select: { ventanaId: true, role: true },
        });
        if (!vendedor || vendedor.ventanaId !== effectiveVentanaId || vendedor.role !== Role.VENDEDOR) {
          throw new AppError("El vendedor no pertenece a tu ventana", 403, "FORBIDDEN");
        }
        const filters = { vendedorId };
        const history = await AccountsService.getPaymentHistory(date, filters);
        
        // Log de auditoría
        await ActivityService.log({
          userId: user.id,
          action: ActivityType.ACCOUNT_PAYMENT_HISTORY_VIEW,
          targetType: "ACCOUNT_PAYMENT",
          targetId: null,
          details: {
            date,
            vendedorId,
            ventanaId: effectiveVentanaId,
            count: history.length,
          },
          layer: "controller",
          requestId: req.requestId,
        });
        
        req.logger?.info({
          layer: "controller",
          action: "ACCOUNT_PAYMENT_HISTORY_VIEW",
          userId: user.id,
          requestId: req.requestId,
          payload: { date, vendedorId, count: history.length },
        });
        
        return success(res, history, 200);
      }

      // Si no se proporciona vendedorId, ver historial de la ventana
      const filters = { ventanaId: effectiveVentanaId };
      const history = await AccountsService.getPaymentHistory(date, filters);
      
      // Log de auditoría
      await ActivityService.log({
        userId: user.id,
        action: ActivityType.ACCOUNT_PAYMENT_HISTORY_VIEW,
        targetType: "ACCOUNT_PAYMENT",
        targetId: null,
        details: {
          date,
          ventanaId: effectiveVentanaId,
          count: history.length,
        },
        layer: "controller",
        requestId: req.requestId,
      });
      
      req.logger?.info({
        layer: "controller",
        action: "ACCOUNT_PAYMENT_HISTORY_VIEW",
        userId: user.id,
        requestId: req.requestId,
        payload: { date, ventanaId: effectiveVentanaId, count: history.length },
      });
      
      return success(res, history, 200);
    }

    // ADMIN puede ver cualquier historial
    if (user.role === Role.ADMIN) {
      const filters = { ventanaId, vendedorId };
      const history = await AccountsService.getPaymentHistory(date, filters);
      
      // Log de auditoría
      await ActivityService.log({
        userId: user.id,
        action: ActivityType.ACCOUNT_PAYMENT_HISTORY_VIEW,
        targetType: "ACCOUNT_PAYMENT",
        targetId: null,
        details: {
          date,
          ventanaId: filters.ventanaId || null,
          vendedorId: filters.vendedorId || null,
          count: history.length,
        },
        layer: "controller",
        requestId: req.requestId,
      });
      
      req.logger?.info({
        layer: "controller",
        action: "ACCOUNT_PAYMENT_HISTORY_VIEW",
        userId: user.id,
        requestId: req.requestId,
        payload: { date, count: history.length },
      });
      
      return success(res, history, 200);
    }

    throw new AppError("Rol no permitido", 403, "FORBIDDEN");
  },

  /**
   * POST /api/v1/accounts/reverse-payment
   * Revierte un pago/cobro
   * CRÍTICO: ADMIN puede revertir cualquier pago. VENTANA solo puede revertir pagos de sus propios vendedores.
   * No permite revertir si el día quedaría saldado.
   */
  async reversePayment(req: AuthenticatedRequest, res: Response) {
    if (!req.user) throw new AppError("Unauthorized", 401);
    
    const user = req.user;
    const { paymentId, reason } = req.body;

    // ✅ OPTIMIZACIÓN: Obtener el pago una sola vez (incluye accountStatement)
    const payment = await AccountPaymentRepository.findById(paymentId);

    if (!payment) {
      throw new AppError("Pago no encontrado", 404, "PAYMENT_NOT_FOUND");
    }

    // ✅ NUEVO: Validar permisos según rol
    if (user.role === Role.ADMIN) {
      // ADMIN puede revertir cualquier pago
    } else if (user.role === Role.VENTANA) {
      // ✅ VENTANA solo puede revertir pagos de sus propios vendedores
      // ✅ OPTIMIZACIÓN: Obtener ventanaId del usuario solo si no está en el token
      let userVentanaId: string | null = user.ventanaId || null;
      
      if (!userVentanaId) {
        const userWithVentana = await prisma.user.findUnique({
          where: { id: user.id },
          select: { ventanaId: true },
        });
        userVentanaId = userWithVentana?.ventanaId || null;
      }

      if (!userVentanaId) {
        throw new AppError("Usuario VENTANA debe tener ventanaId asignado", 403, "FORBIDDEN");
      }

      // ✅ OPTIMIZACIÓN: Validar permisos según el tipo de pago
      if (payment.vendedorId) {
        // Si el pago tiene vendedorId, verificar que el vendedor pertenece a su ventana
        const vendedor = await prisma.user.findUnique({
          where: { id: payment.vendedorId },
          select: { ventanaId: true, role: true },
        });

        if (!vendedor || vendedor.role !== Role.VENDEDOR || vendedor.ventanaId !== userVentanaId) {
          throw new AppError("Solo puedes revertir pagos de tus propios vendedores", 403, "FORBIDDEN");
        }
      } else if (payment.ventanaId) {
        // Si el pago es de tipo ventana (sin vendedorId), verificar que es de su ventana
        if (payment.ventanaId !== userVentanaId) {
          throw new AppError("Solo puedes revertir pagos de tu propia ventana", 403, "FORBIDDEN");
        }
      } else {
        // Si no tiene ni ventanaId ni vendedorId, rechazar (caso edge)
        throw new AppError("No se puede determinar la ventana del pago", 403, "FORBIDDEN");
      }
    } else {
      // Otros roles no pueden revertir pagos
      throw new AppError("Solo usuarios con rol ADMIN o VENTANA pueden revertir pagos/cobros", 403, "FORBIDDEN");
    }

    // ✅ OPTIMIZACIÓN: Pasar el payment ya obtenido en lugar de solo el ID
    // Esto evita buscar el pago dos veces
    const result = await AccountsService.reversePayment(payment, user.id, reason) as { payment: any; statement: any };

    // ✅ NUEVO: La respuesta ahora incluye { payment, statement }
    const { payment: reversed, statement } = result;

    // ✅ OPTIMIZACIÓN: Obtener nombre del usuario solo una vez (necesario para la respuesta)
    // AuthUser no incluye name, así que necesitamos buscarlo
    const reversedByUser = await prisma.user.findUnique({
      where: { id: user.id },
      select: { id: true, name: true },
    });

    // Log de auditoría
    await ActivityService.log({
      userId: user.id,
      action: ActivityType.ACCOUNT_PAYMENT_REVERSE,
      targetType: "ACCOUNT_PAYMENT",
      targetId: paymentId,
      details: {
        reason,
        originalAmount: payment.amount,
        originalType: payment.type,
        reversedAt: new Date().toISOString(),
      },
      layer: "controller",
      requestId: req.requestId,
    });

    req.logger?.info({
      layer: "controller",
      action: "ACCOUNT_PAYMENT_REVERSE",
      userId: user.id,
      requestId: req.requestId,
      payload: {
        paymentId,
        reason,
        reversedBy: user.id,
      },
    });

    // ✅ OPTIMIZACIÓN: Incluir statement actualizado en la respuesta para sincronía total con FE
    return success(res, {
      payment: {
        id: reversed.id,
        isReversed: reversed.isReversed,
        reversedAt: reversed.reversedAt?.toISOString() || null,
        reversedBy: reversed.reversedBy,
        reversedByUser: reversedByUser
          ? {
              id: reversedByUser.id,
              name: reversedByUser.name,
            }
          : null,
      },
      statement, // ✅ Statement actualizado con totalPaid, totalCollected, remainingBalance, etc.
    }, 200);
  },

  /**
   * DELETE /api/v1/accounts/statement/:id
   * Elimina un estado de cuenta (solo si está vacío)
   */
  async deleteStatement(req: AuthenticatedRequest, res: Response) {
    if (!req.user) throw new AppError("Unauthorized", 401);

    const { id } = req.params;
    const user = req.user;

    // Validar permisos: solo ADMIN puede eliminar statements
    if (user.role !== Role.ADMIN) {
      throw new AppError("Solo los administradores pueden eliminar estados de cuenta", 403, "FORBIDDEN");
    }

    const result = await AccountsService.deleteStatement(id);

    // Log de auditoría
    // TODO: Cambiar a ACCOUNT_STATEMENT_DELETE cuando se regenere el cliente de Prisma
    await ActivityService.log({
      userId: user.id,
      action: ActivityType.ACCOUNT_STATEMENT_VIEW, // Temporal: usar ACCOUNT_STATEMENT_DELETE después de regenerar Prisma
      targetType: "ACCOUNT_STATEMENT",
      targetId: id,
      details: {
        statementId: id,
        action: "DELETE", // Indicar que es una eliminación en los detalles
      },
      layer: "controller",
      requestId: req.requestId,
    });

    req.logger?.info({
      layer: "controller",
      action: "ACCOUNT_STATEMENT_DELETE",
      userId: user.id,
      requestId: req.requestId,
      payload: { statementId: id },
    });

    return success(res, result, 200);
  },

  /**
   * GET /api/v1/accounts/balance/current
   * Obtiene el balance acumulado actual de una ventana
   * Solo para usuarios VENTANA con scope=mine y dimension=ventana
   */
  async getCurrentBalance(req: AuthenticatedRequest, res: Response) {
    if (!req.user) throw new AppError("Unauthorized", 401);

    const user = req.user;

    // Solo usuarios VENTANA pueden usar este endpoint
    if (user.role !== Role.VENTANA) {
      throw new AppError("Solo usuarios VENTANA pueden consultar su balance", 403, "FORBIDDEN");
    }

    // Obtener ventanaId del usuario si no está en el token
    let effectiveVentanaId = user.ventanaId;
    if (!effectiveVentanaId) {
      const userWithVentana = await prisma.user.findUnique({
        where: { id: user.id },
        select: { ventanaId: true },
      });
      effectiveVentanaId = userWithVentana?.ventanaId || null;
    }

    if (!effectiveVentanaId) {
      throw new AppError("El usuario VENTANA no tiene una ventana asignada", 400, "NO_VENTANA");
    }

    const result = await AccountsService.getCurrentBalance(effectiveVentanaId);

    // Log de auditoría
    await ActivityService.log({
      userId: user.id,
      action: ActivityType.ACCOUNT_STATEMENT_VIEW,
      targetType: "ACCOUNT_STATEMENT",
      targetId: null,
      details: {
        action: "CURRENT_BALANCE",
        ventanaId: effectiveVentanaId,
      },
      layer: "controller",
      requestId: req.requestId,
    });

    req.logger?.info({
      layer: "controller",
      action: "CURRENT_BALANCE_VIEW",
      userId: user.id,
      requestId: req.requestId,
      payload: { ventanaId: effectiveVentanaId },
    });

    return success(res, result);
  },

  /**
   * GET /api/v1/accounts/export
   * Exporta estados de cuenta en CSV, Excel o PDF
   */
  async export(req: AuthenticatedRequest, res: Response) {
    if (!req.user) throw new AppError("Unauthorized", 401);

    const {
      format,
      month,
      date,
      fromDate,
      toDate,
      scope,
      dimension,
      ventanaId,
      vendedorId,
      sort,
      includeBreakdown,
      includeMovements,
    } = req.query as any;

    const user = req.user;

    // Construir filtros según rol
    let filters: any;

    if (user.role === Role.VENDEDOR) {
      if (scope !== "mine" || dimension !== "vendedor") {
        throw new AppError("Los vendedores solo pueden exportar su propio estado de cuenta", 403, "FORBIDDEN");
      }
      filters = {
        month,
        date,
        fromDate,
        toDate,
        scope: "mine" as const,
        dimension: "vendedor" as const,
        vendedorId: user.id,
        sort: sort || "desc",
        userRole: user.role,
      };
    } else if (user.role === Role.VENTANA) {
      if (scope === "all") {
        throw new AppError("Los usuarios VENTANA no pueden usar scope='all'", 403, "FORBIDDEN");
      }

      // Obtener ventanaId del usuario
      let effectiveVentanaId = user.ventanaId;
      if (!effectiveVentanaId) {
        const userWithVentana = await prisma.user.findUnique({
          where: { id: user.id },
          select: { ventanaId: true },
        });
        effectiveVentanaId = userWithVentana?.ventanaId || null;
      }

      if (!effectiveVentanaId) {
        throw new AppError("El usuario VENTANA no tiene una ventana asignada", 400, "NO_VENTANA");
      }

      if (scope === "mine") {
        if (dimension !== "ventana") {
          throw new AppError("Los usuarios VENTANA con scope='mine' deben usar dimension='ventana'", 400, "INVALID_DIMENSION");
        }
        filters = {
          month,
          date,
          fromDate,
          toDate,
          scope: "mine" as const,
          dimension: "ventana" as const,
          ventanaId: effectiveVentanaId,
          sort: sort || "desc",
          userRole: user.role,
        };
      } else if (scope === "ventana") {
        if (dimension !== "vendedor") {
          throw new AppError("Los usuarios VENTANA con scope='ventana' deben usar dimension='vendedor'", 400, "INVALID_DIMENSION");
        }
        // ✅ NUEVO: Permitir vendedorId opcional para agrupamiento por "Todos"
        if (vendedorId) {
          // Validar que el vendedor pertenece a la ventana
          const vendedor = await prisma.user.findUnique({
            where: { id: vendedorId },
            select: { ventanaId: true, role: true },
          });
          if (!vendedor || vendedor.ventanaId !== effectiveVentanaId || vendedor.role !== Role.VENDEDOR) {
            throw new AppError("El vendedor no pertenece a tu ventana", 403, "FORBIDDEN");
          }
        }
        // Si no hay vendedorId, se agrupará automáticamente por fecha con byVendedor[]
        filters = {
          month,
          date,
          fromDate,
          toDate,
          scope: "ventana" as const,
          dimension: "vendedor" as const,
          ventanaId: effectiveVentanaId,
          vendedorId,
          sort: sort || "desc",
          userRole: user.role,
        };
      } else {
        throw new AppError("Scope inválido", 400, "INVALID_SCOPE");
      }
    } else if (user.role === Role.ADMIN) {
      filters = {
        month,
        date,
        fromDate,
        toDate,
        scope,
        dimension,
        ventanaId,
        vendedorId,
        bancaId: user.bancaId,
        sort: sort || "desc",
        userRole: user.role,
      };
    } else {
      throw new AppError("Rol no permitido", 403, "FORBIDDEN");
    }

    // Generar exportación
    const { buffer, filename, mimeType } = await AccountsExportService.export(filters, {
      format: format as ExportFormat,
      includeBreakdown: includeBreakdown === "true" || includeBreakdown === true,
      includeMovements: includeMovements === "true" || includeMovements === true,
    });

    // Log de auditoría
    await ActivityService.log({
      userId: user.id,
      action: ActivityType.ACCOUNT_STATEMENT_VIEW,
      targetType: "ACCOUNT_STATEMENT",
      targetId: null,
      details: {
        action: "EXPORT",
        format,
        filters: {
          month,
          date,
          fromDate,
          toDate,
          scope,
          dimension,
          ventanaId: filters.ventanaId || null,
          vendedorId: filters.vendedorId || null,
        },
        filename,
      },
      layer: "controller",
      requestId: req.requestId,
    });

    req.logger?.info({
      layer: "controller",
      action: "ACCOUNTS_EXPORT",
      userId: user.id,
      requestId: req.requestId,
      payload: { format, filename },
    });

    // Enviar archivo
    res.setHeader("Content-Type", mimeType);
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(buffer);
  },
};

