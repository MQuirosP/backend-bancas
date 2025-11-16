// src/api/v1/controllers/commissions.controller.ts
import { Response } from "express";
import { CommissionsService } from "../services/commissions.service";
import { AuthenticatedRequest } from "../../../core/types";
import { success } from "../../../utils/responses";
import { Role } from "@prisma/client";
import { AppError } from "../../../core/errors";
import { resolveDateRange } from "../../../utils/dateRange";
import { applyRbacFilters, AuthContext } from "../../../utils/rbac";
import prisma from "../../../core/prismaClient";

export const CommissionsController = {
  /**
   * 1) Lista de comisiones por periodo
   * GET /api/v1/commissions
   */
  async list(req: AuthenticatedRequest, res: Response) {
    if (!req.user) throw new AppError("Unauthorized", 401);

    const {
      date = "today",
      fromDate,
      toDate,
      scope,
      dimension,
      ...rest
    } = req.query as any;

    // Asegurar que las fechas sean strings, no arrays
    const fromDateStr = Array.isArray(fromDate) ? fromDate[0] : fromDate;
    const toDateStr = Array.isArray(toDate) ? Array.isArray(toDate) ? toDate[0] : toDate : toDate;
    const dateStr = Array.isArray(date) ? date[0] : date;

    // Validar scope y dimension según rol
    if (req.user.role === Role.VENDEDOR) {
      // VENDEDOR solo puede ver sus propias comisiones
      if (scope !== "mine" || dimension !== "vendedor") {
        throw new AppError("VENDEDOR can only view own commissions with dimension=vendedor", 403);
      }
      // Forzar scope=mine y dimension=vendedor para VENDEDOR
      rest.scope = "mine";
      rest.dimension = "vendedor";
    } else if (req.user.role === Role.VENTANA) {
      // VENTANA solo puede ver sus comisiones y las de sus vendedores
      if (scope !== "mine") {
        throw new AppError("VENTANA can only view own commissions (scope=mine)", 403);
      }
      // Forzar scope=mine para VENTANA
      rest.scope = "mine";
    }

    // Aplicar RBAC para obtener filtros efectivos (incluye filtro de banca activa)
    const context: AuthContext = {
      userId: req.user.id,
      role: req.user.role,
      ventanaId: req.user.ventanaId,
      bancaId: req.bancaContext?.bancaId || null,
    };
    const effectiveFilters = await applyRbacFilters(context, rest);

    // Construir filtros para el servicio
    const filters: {
      scope: string;
      dimension: string;
      ventanaId?: string;
      vendedorId?: string;
      bancaId?: string;
    } = {
      scope: scope as string,
      dimension: dimension as string,
    };

    // Aplicar filtros de RBAC (ya vienen del applyRbacFilters)
    if (effectiveFilters.ventanaId) {
      filters.ventanaId = effectiveFilters.ventanaId;
    }
    if (effectiveFilters.vendedorId) {
      filters.vendedorId = effectiveFilters.vendedorId;
    }
    if (effectiveFilters.bancaId) {
      filters.bancaId = effectiveFilters.bancaId;
    }

    // Resolver rango de fechas
    const dateRange = resolveDateRange(dateStr, fromDateStr, toDateStr);

    // Si dimension=ventana, obtener el userId del usuario VENTANA para calcular comisiones
    // - Si el usuario es VENTANA: usar su propio userId
    // - Si el usuario es ADMIN y hay ventanaId: buscar el usuario VENTANA de esa ventana
    let ventanaUserId: string | undefined = undefined;
    if (filters.dimension === "ventana") {
      if (req.user.role === Role.VENTANA) {
        // Usuario VENTANA: usar su propio userId
        ventanaUserId = req.user.id;
      } else if (req.user.role === Role.ADMIN && filters.ventanaId) {
        // ADMIN con ventanaId: buscar el usuario VENTANA de esa ventana
        const ventanaUser = await prisma.user.findFirst({
          where: {
            role: Role.VENTANA,
            ventanaId: filters.ventanaId,
            isActive: true,
          },
          select: { id: true },
        });
        if (ventanaUser) {
          ventanaUserId = ventanaUser.id;
        }
      }
    }

    const result = await CommissionsService.list(dateStr, fromDateStr, toDateStr, filters, ventanaUserId);

    req.logger?.info({
      layer: "controller",
      action: "COMMISSIONS_LIST",
      payload: {
        date: dateStr,
        scope,
        dimension,
        effectiveFilters,
        dateRange: {
          fromAt: dateRange.fromAt.toISOString(),
          toAt: dateRange.toAt.toISOString(),
          tz: dateRange.tz,
        },
        resultCount: result.length,
      },
    });

    return success(res, result, {
      range: {
        fromAt: dateRange.fromAt.toISOString(),
        toAt: dateRange.toAt.toISOString(),
        tz: dateRange.tz,
      },
      effectiveFilters,
    });
  },

  /**
   * 2) Detalle de comisiones por lotería
   * GET /api/v1/commissions/detail
   */
  async detail(req: AuthenticatedRequest, res: Response) {
    if (!req.user) throw new AppError("Unauthorized", 401);

    const { date, scope, dimension, ...rest } = req.query as any;

    // Validar fecha requerida
    if (!date || typeof date !== "string") {
      throw new AppError("date parameter is required (YYYY-MM-DD format)", 400);
    }

    // Validar scope y dimension según rol
    if (req.user.role === Role.VENDEDOR) {
      if (scope !== "mine" || dimension !== "vendedor") {
        throw new AppError("VENDEDOR can only view own commissions with dimension=vendedor", 403);
      }
      rest.scope = "mine";
      rest.dimension = "vendedor";
    } else if (req.user.role === Role.VENTANA) {
      if (scope !== "mine") {
        throw new AppError("VENTANA can only view own commissions (scope=mine)", 403);
      }
      rest.scope = "mine";
    }

    // Aplicar RBAC
    const context: AuthContext = {
      userId: req.user.id,
      role: req.user.role,
      ventanaId: req.user.ventanaId,
    };
    const effectiveFilters = await applyRbacFilters(context, rest);

    // Construir filtros para el servicio
    const filters: {
      scope: string;
      dimension: string;
      ventanaId?: string;
      vendedorId?: string;
      bancaId?: string;
    } = {
      scope: scope as string,
      dimension: dimension as string,
    };

    // Aplicar filtros de RBAC (ya vienen del applyRbacFilters)
    if (effectiveFilters.ventanaId) {
      filters.ventanaId = effectiveFilters.ventanaId;
    }
    if (effectiveFilters.vendedorId) {
      filters.vendedorId = effectiveFilters.vendedorId;
    }
    if (effectiveFilters.bancaId) {
      filters.bancaId = effectiveFilters.bancaId;
    }

    // Resolver rango de fechas (un solo día)
    const dateRange = resolveDateRange("range", date, date);

    // Si dimension=ventana, obtener el userId del usuario VENTANA para calcular comisiones
    // - Si el usuario es VENTANA: usar su propio userId
    // - Si el usuario es ADMIN y hay ventanaId: buscar el usuario VENTANA de esa ventana
    let ventanaUserId: string | undefined = undefined;
    if (filters.dimension === "ventana") {
      if (req.user.role === Role.VENTANA) {
        // Usuario VENTANA: usar su propio userId
        ventanaUserId = req.user.id;
      } else if (req.user.role === Role.ADMIN && filters.ventanaId) {
        // ADMIN con ventanaId: buscar el usuario VENTANA de esa ventana
        const ventanaUser = await prisma.user.findFirst({
          where: {
            role: Role.VENTANA,
            ventanaId: filters.ventanaId,
            isActive: true,
          },
          select: { id: true },
        });
        if (ventanaUser) {
          ventanaUserId = ventanaUser.id;
        }
      }
    }

    const result = await CommissionsService.detail(date, filters, ventanaUserId);

    req.logger?.info({
      layer: "controller",
      action: "COMMISSIONS_DETAIL",
      payload: {
        date,
        scope,
        dimension,
        effectiveFilters,
        dateRange: {
          fromAt: dateRange.fromAt.toISOString(),
          toAt: dateRange.toAt.toISOString(),
          tz: dateRange.tz,
        },
        resultCount: result.length,
      },
    });

    return success(res, result, {
      range: {
        fromAt: dateRange.fromAt.toISOString(),
        toAt: dateRange.toAt.toISOString(),
        tz: dateRange.tz,
      },
      effectiveFilters,
    });
  },

  /**
   * 3) Tickets con comisiones
   * GET /api/v1/commissions/tickets
   */
  async tickets(req: AuthenticatedRequest, res: Response) {
    if (!req.user) throw new AppError("Unauthorized", 401);

    const {
      date,
      loteriaId,
      multiplierId,
      scope,
      dimension,
      page = 1,
      pageSize = 20,
      ...rest
    } = req.query as any;

    // Validar parámetros requeridos
    if (!date || typeof date !== "string") {
      throw new AppError("date parameter is required (YYYY-MM-DD format)", 400);
    }
    if (!loteriaId || typeof loteriaId !== "string") {
      throw new AppError("loteriaId parameter is required", 400);
    }
    if (!multiplierId || typeof multiplierId !== "string") {
      throw new AppError("multiplierId parameter is required", 400);
    }

    // Validar scope y dimension según rol
    if (req.user.role === Role.VENDEDOR) {
      if (scope !== "mine" || dimension !== "vendedor") {
        throw new AppError("VENDEDOR can only view own commissions with dimension=vendedor", 403);
      }
      rest.scope = "mine";
      rest.dimension = "vendedor";
    } else if (req.user.role === Role.VENTANA) {
      if (scope !== "mine") {
        throw new AppError("VENTANA can only view own commissions (scope=mine)", 403);
      }
      rest.scope = "mine";
    }

    // Aplicar RBAC
    const context: AuthContext = {
      userId: req.user.id,
      role: req.user.role,
      ventanaId: req.user.ventanaId,
    };
    const effectiveFilters = await applyRbacFilters(context, rest);

    // Construir filtros para el servicio
    const filters: {
      scope: string;
      dimension: string;
      ventanaId?: string;
      vendedorId?: string;
      bancaId?: string;
    } = {
      scope: scope as string,
      dimension: dimension as string,
    };

    // Aplicar filtros de RBAC (ya vienen del applyRbacFilters)
    if (effectiveFilters.ventanaId) {
      filters.ventanaId = effectiveFilters.ventanaId;
    }
    if (effectiveFilters.vendedorId) {
      filters.vendedorId = effectiveFilters.vendedorId;
    }
    if (effectiveFilters.bancaId) {
      filters.bancaId = effectiveFilters.bancaId;
    }

    // Resolver rango de fechas (un solo día)
    const dateRange = resolveDateRange("range", date, date);

    // Si dimension=ventana, obtener el userId del usuario VENTANA para calcular comisiones
    // - Si el usuario es VENTANA: usar su propio userId
    // - Si el usuario es ADMIN y hay ventanaId: buscar el usuario VENTANA de esa ventana
    let ventanaUserId: string | undefined = undefined;
    if (filters.dimension === "ventana") {
      if (req.user.role === Role.VENTANA) {
        // Usuario VENTANA: usar su propio userId
        ventanaUserId = req.user.id;
      } else if (req.user.role === Role.ADMIN && filters.ventanaId) {
        // ADMIN con ventanaId: buscar el usuario VENTANA de esa ventana
        const ventanaUser = await prisma.user.findFirst({
          where: {
            role: Role.VENTANA,
            ventanaId: filters.ventanaId,
            isActive: true,
          },
          select: { id: true },
        });
        if (ventanaUser) {
          ventanaUserId = ventanaUser.id;
        }
      }
    }

    const result = await CommissionsService.tickets(
      date,
      loteriaId,
      multiplierId,
      Number(page),
      Number(pageSize),
      filters,
      ventanaUserId
    );

    req.logger?.info({
      layer: "controller",
      action: "COMMISSIONS_TICKETS",
      payload: {
        date,
        loteriaId,
        multiplierId,
        scope,
        dimension,
        effectiveFilters,
        page: Number(page),
        pageSize: Number(pageSize),
        total: result.meta.total,
      },
    });

    return success(res, result.data, {
      ...result.meta,
      range: {
        fromAt: dateRange.fromAt.toISOString(),
        toAt: dateRange.toAt.toISOString(),
        tz: dateRange.tz,
      },
      effectiveFilters,
    });
  },
};

export default CommissionsController;

