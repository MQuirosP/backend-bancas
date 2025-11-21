// src/api/v1/controllers/accounts.controller.ts
import { Response } from "express";
import { AccountsService } from "../services/accounts.service";
import { AuthenticatedRequest } from "../../../core/types";
import { success } from "../../../utils/responses";
import { AppError } from "../../../core/errors";
import { Role, ActivityType } from "@prisma/client";
import prisma from "../../../core/prismaClient";
import ActivityService from "../../../core/activity.service";
import logger from "../../../core/logger";
import { AccountPaymentRepository } from "../../../repositories/accountPayment.repository";
import { applyRbacFilters, AuthContext } from "../../../utils/rbac";

export const AccountsController = {
  /**
   * GET /api/v1/accounts/statement
   * Obtiene el estado de cuenta día a día del mes
   */
  async getStatement(req: AuthenticatedRequest, res: Response) {
    if (!req.user) throw new AppError("Unauthorized", 401);
    
    // ✅ NUEVO: Agregar filtros de período
    const { month, date, fromDate, toDate, scope, dimension, ventanaId, vendedorId, sort } = req.query as any;
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
        };
      const result = await AccountsService.getStatement(filters);
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
        };
        const result = await AccountsService.getStatement(filters);
        return success(res, result);
      }

      if (scope === "ventana") {
        if (dimension !== "vendedor") {
          throw new AppError("Los usuarios VENTANA con scope='ventana' deben usar dimension='vendedor'", 400, "INVALID_DIMENSION");
        }
        if (!vendedorId) {
          throw new AppError("Se requiere vendedorId cuando scope='ventana' y dimension='vendedor'", 400, "VENDEDOR_ID_REQUIRED");
        }
        // Validar que el vendedor pertenece a la ventana del usuario
        const vendedor = await prisma.user.findUnique({
          where: { id: vendedorId },
          select: { ventanaId: true, role: true },
        });
        if (!vendedor || vendedor.ventanaId !== effectiveVentanaId || vendedor.role !== Role.VENDEDOR) {
          throw new AppError("El vendedor no pertenece a tu ventana", 403, "FORBIDDEN");
        }
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
        };
        const result = await AccountsService.getStatement(filters);
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
        bancaId: effectiveFilters.bancaId, // Filtro de banca activa (si está presente)
        sort: sort || "desc",
      };
      
      const result = await AccountsService.getStatement(filters);
      
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
      // Si ambos están presentes, rechazar
      if (ventanaId && vendedorId) {
        throw new AppError("No se pueden proporcionar ventanaId y vendedorId al mismo tiempo", 400, "INVALID_DIMENSION");
      }
    }

    // Validar que al menos uno de los dos esté presente después del procesamiento
    if (!effectiveVentanaId && !effectiveVendedorId) {
      throw new AppError("Debe proporcionar ventanaId o vendedorId", 400, "MISSING_DIMENSION");
    }

    // Obtener nombre del usuario para auditoría desde la base de datos
    const userWithName = await prisma.user.findUnique({
      where: { id: user.id },
      select: { name: true },
    });
    const paidByName = userWithName?.name || "Usuario";

    const payment = await AccountsService.createPayment({
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
    });

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
      },
    });

    return success(res, payment, 201);
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
   * CRÍTICO: Solo ADMIN puede revertir. No permite revertir si el día quedaría saldado.
   */
  async reversePayment(req: AuthenticatedRequest, res: Response) {
    if (!req.user) throw new AppError("Unauthorized", 401);
    
    const user = req.user;
    const { paymentId, reason } = req.body;

    // Validar permisos: Solo ADMIN puede revertir pagos/cobros
    if (user.role !== Role.ADMIN) {
      throw new AppError("Solo usuarios con rol ADMIN pueden revertir pagos/cobros", 403, "FORBIDDEN");
    }

    // Obtener el pago para validar
    const payment = await AccountPaymentRepository.findById(paymentId);

    if (!payment) {
      throw new AppError("Pago no encontrado", 404, "PAYMENT_NOT_FOUND");
    }

    // Revertir pago (incluye validación de que el día no quede saldado)
    const reversed = await AccountsService.reversePayment(paymentId, user.id, reason);

    // Obtener usuario que revirtió para la respuesta
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

    // Formatear respuesta según el documento
    return success(res, {
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
};

