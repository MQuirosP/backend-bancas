// src/modules/tickets/controllers/ticket.controller.ts
import { Response } from "express";
import { TicketService } from "../services/ticket.service";
import { AuthenticatedRequest } from "../../../core/types";
import { success } from "../../../utils/responses";
import { Role } from "@prisma/client";
import { resolveDateRange } from "../../../utils/dateRange";
import { applyRbacFilters, AuthContext, RequestFilters } from "../../../utils/rbac";

export const TicketController = {
  async create(req: AuthenticatedRequest, res: Response) {
    const userId = req.user!.id;
    const result = await TicketService.create(
      req.body,
      userId,
      req.requestId,
      req.user!.role
    );
    return success(res, result);
  },

  async getById(req: AuthenticatedRequest, res: Response) {
    const result = await TicketService.getById(req.params.id);
    return success(res, result);
  },

  async list(req: AuthenticatedRequest, res: Response) {
    const { page = 1, pageSize = 10, scope = "mine", date = "today", fromDate, toDate, number, isActive, winnersOnly, ...rest } = req.query as any;

    const me = req.user!;

    // Build auth context
    const context: AuthContext = {
      userId: me.id,
      role: me.role,
      ventanaId: me.ventanaId,
      bancaId: req.bancaContext?.bancaId || null,
    };

    // Apply RBAC filters (fetches ventanaId from DB if missing in JWT)
    // Optimización: Solo loggear en modo debug para reducir overhead
    const effectiveFilters = await applyRbacFilters(context, { ...rest, scope });

    // Resolver rango de fechas (mismo patrón que Venta/Dashboard)
    // Regla especial: cuando hay sorteoId y no hay fechas explícitas, NO aplicar filtros de fecha
    const hasSorteoId = effectiveFilters.sorteoId;
    const hasExplicitDateRange = fromDate || toDate;

    let dateRange: { fromAt: Date; toAt: Date; tz: string; description?: string } | null = null;

    if (hasSorteoId && !hasExplicitDateRange) {
      // NO aplicar filtro de fecha cuando hay sorteoId y no hay fechas explícitas
      dateRange = null;
    } else {
      // Resolver rango de fechas normalmente
      dateRange = resolveDateRange(date, fromDate, toDate);
    }

    // Build final filters for service
    // IMPORTANT: Map vendedorId → userId for backward compatibility with repository
    const filters: any = {
      ...effectiveFilters,
      ...(dateRange ? {
        dateFrom: dateRange.fromAt,
        dateTo: dateRange.toAt
      } : {}),
      ...(number ? { number } : {}),
      ...(typeof isActive === 'boolean' ? { isActive } : {}),
      ...(typeof winnersOnly === 'boolean' ? { winnersOnly } : {}),
    };

    // Repository expects 'userId' but RBAC returns 'vendedorId'
    if (effectiveFilters.vendedorId) {
      filters.userId = effectiveFilters.vendedorId;
      delete filters.vendedorId;

      req.logger?.info({
        layer: "controller",
        action: "TICKET_LIST_VENDEDOR_MAPPING",
        payload: {
          vendedorId: filters.userId,
          message: "Mapped vendedorId → userId for repository compatibility"
        }
      });
    }

    const result = await TicketService.list(Number(page), Number(pageSize), filters);

    req.logger?.info({
      layer: "controller",
      action: "TICKET_LIST",
      payload: {
        page,
        pageSize,
        scope,
        role: me.role,
        effectiveFilters,
        dateRange: dateRange ? {
          fromAt: dateRange.fromAt.toISOString(),
          toAt: dateRange.toAt.toISOString(),
          tz: dateRange.tz,
          description: dateRange.description,
        } : null,
        skippedDateFilter: hasSorteoId && !hasExplicitDateRange,
      }
    });

    return success(res, result);
  },

  async cancel(req: AuthenticatedRequest, res: Response) {
    const userId = req.user!.id;
    const result = await TicketService.cancel(req.params.id, userId, req.requestId);
    return success(res, result);
  },

  async restore(req: AuthenticatedRequest, res: Response) {
    const userId = req.user!.id;
    const result = await TicketService.restore(req.params.id, userId, req.requestId);
    return success(res, result);
  },

  // ==================== PAYMENT ENDPOINTS ====================

  /**
   * POST /api/v1/tickets/:id/pay
   * Registrar un pago (total o parcial) en un ticket ganador
   */
  async registerPayment(req: AuthenticatedRequest, res: Response) {
    const userId = req.user!.id;
    const ticketId = req.params.id;
    const result = await TicketService.registerPayment(
      ticketId,
      req.body,
      userId,
      req.requestId
    );
    return success(res, result);
  },

  /**
   * POST /api/v1/tickets/:id/reverse-payment
   * Revertir el último pago de un ticket
   */
  async reversePayment(req: AuthenticatedRequest, res: Response) {
    const userId = req.user!.id;
    const ticketId = req.params.id;
    const { reason } = req.body;
    const result = await TicketService.reversePayment(
      ticketId,
      userId,
      reason,
      req.requestId
    );
    return success(res, result);
  },

  /**
   * POST /api/v1/tickets/:id/finalize-payment
   * Marcar el pago parcial como final (acepta deuda restante)
   */
  async finalizePayment(req: AuthenticatedRequest, res: Response) {
    const userId = req.user!.id;
    const ticketId = req.params.id;
    const { notes } = req.body;
    const result = await TicketService.finalizePayment(
      ticketId,
      userId,
      notes,
      req.requestId
    );
    return success(res, result);
  },

  async numbersSummary(req: AuthenticatedRequest, res: Response) {
    const { date, fromDate, toDate, scope, dimension, ventanaId, vendedorId, loteriaId, sorteoId, multiplierId, status } = req.query as any;

    const me = req.user!;

    // Log para debugging
    req.logger?.info({
      layer: "controller",
      action: "TICKET_NUMBERS_SUMMARY_REQUEST",
      payload: {
        userId: me.id,
        role: me.role,
        queryParams: { date, fromDate, toDate, scope, dimension, ventanaId, vendedorId, loteriaId, sorteoId },
      },
    });

    // Build auth context
    const context: AuthContext = {
      userId: me.id,
      role: me.role,
      ventanaId: me.ventanaId,
      bancaId: req.bancaContext?.bancaId || null,
    };

    // Aplicar RBAC filters (similar a otros endpoints)
    const requestFilters: RequestFilters = {
      ...(ventanaId ? { ventanaId } : {}),
      ...(vendedorId ? { vendedorId } : {}),
      ...(loteriaId ? { loteriaId } : {}),
      ...(sorteoId ? { sorteoId } : {}),
    };

    const effectiveFilters = await applyRbacFilters(context, requestFilters);

    // Determinar el scope efectivo según el rol
    let effectiveScope = scope || 'mine';
    if (me.role === Role.VENDEDOR) {
      // VENDEDOR siempre usa scope='mine' y filtra por su propio vendedorId
      effectiveScope = 'mine';
      effectiveFilters.vendedorId = me.id;
    } else if (me.role === Role.VENTANA) {
      // VENTANA siempre usa scope='mine' (su ventana)
      effectiveScope = 'mine';
      // ✅ FIX: Para dimension='listero', forzar el ventanaId del usuario VENTANA
      if (dimension === 'listero') {
        // Usar el ventanaId del effectiveFilters (que viene de RBAC)
        // Esto evita que el frontend envíe el userId en lugar del ventanaId
        effectiveFilters.ventanaId = effectiveFilters.ventanaId || me.ventanaId;
      }
    } else if (me.role === Role.ADMIN) {
      // ADMIN puede usar scope='all' o 'mine'
      effectiveScope = scope || 'all';
    }

    // Validar que ADMIN no intente usar scope='all' sin permisos
    if (effectiveScope === 'all' && me.role !== Role.ADMIN) {
      return res.status(403).json({
        success: false,
        error: "Solo los administradores pueden usar scope='all'",
      });
    }

    // ✅ FIX: Regla especial - cuando hay sorteoId y no hay fechas explícitas, NO aplicar filtros de fecha
    // (igual que en endpoint /tickets/list)
    const hasSorteoId = effectiveFilters.sorteoId;
    const hasExplicitDateRange = fromDate || toDate;

    let dateRange: { fromAt: Date; toAt: Date; tz: string; description?: string } | null = null;

    if (hasSorteoId && !hasExplicitDateRange) {
      // NO aplicar filtro de fecha cuando hay sorteoId y no hay fechas explícitas
      dateRange = null;
    } else {
      // Resolver rango de fechas normalmente
      dateRange = resolveDateRange(date || "today", fromDate, toDate);
    }

    req.logger?.info({
      layer: "controller",
      action: "TICKET_NUMBERS_SUMMARY_PARAMS",
      payload: {
        effectiveScope,
        effectiveFilters,
        dimension,
        dateRange: dateRange ? {
          fromAt: dateRange.fromAt.toISOString(),
          toAt: dateRange.toAt.toISOString(),
        } : null,
        skippedDateFilter: hasSorteoId && !hasExplicitDateRange,
      },
    });

    const result = await TicketService.numbersSummary(
      {
        date: date || "today",
        fromDate,
        toDate,
        scope: effectiveScope,
        dimension,
        ventanaId: effectiveFilters.ventanaId,
        vendedorId: effectiveFilters.vendedorId,
        loteriaId: effectiveFilters.loteriaId,
        sorteoId: effectiveFilters.sorteoId,
        multiplierId, // ✅ NUEVO
        status, // ✅ NUEVO
      },
      me.role,
      me.id
    );

    return success(res, result.data, result.meta);
  },

  /**
   * POST /api/v1/tickets/numbers-summary/pdf
   * Genera un PDF o PNG con la lista de números 00-99 con montos
   *
   * Request Body:
   * - format?: 'pdf' | 'png' (default: 'pdf')
   * - ... (otros parámetros de numbers-summary)
   *
   * Response:
   * - Content-Type: 'application/pdf' o 'image/png' según el formato
   */
  async numbersSummaryPdf(req: AuthenticatedRequest, res: Response) {
    try {
      const startTime = Date.now();
      const { date, fromDate, toDate, scope, dimension, ventanaId, vendedorId, loteriaId, sorteoId, multiplierId, status, format } = req.body;

      const me = req.user!;

      req.logger?.info({
        layer: "controller",
        action: "TICKET_NUMBERS_SUMMARY_PDF_REQUEST",
        payload: {
          userId: me.id,
          role: me.role,
          bodyParams: { date, fromDate, toDate, scope, dimension, ventanaId, vendedorId, loteriaId, sorteoId },
        },
      });

      // Build auth context
      const context: AuthContext = {
        userId: me.id,
        role: me.role,
        ventanaId: me.ventanaId,
        bancaId: req.bancaContext?.bancaId || null,
      };

      // Aplicar RBAC filters
      const requestFilters: RequestFilters = {
        ...(ventanaId ? { ventanaId } : {}),
        ...(vendedorId ? { vendedorId } : {}),
        ...(loteriaId ? { loteriaId } : {}),
        ...(sorteoId ? { sorteoId } : {}),
      };

      const effectiveFilters = await applyRbacFilters(context, requestFilters);

      // Determinar el scope efectivo según el rol
      let effectiveScope = scope || 'mine';
      if (me.role === Role.VENDEDOR) {
        effectiveScope = 'mine';
        effectiveFilters.vendedorId = me.id;
      } else if (me.role === Role.VENTANA) {
        effectiveScope = 'mine';
      } else if (me.role === Role.ADMIN) {
        effectiveScope = scope || 'all';
      }

      // Validar permisos
      if (effectiveScope === 'all' && me.role !== Role.ADMIN) {
        return res.status(403).json({
          success: false,
          error: "Solo los administradores pueden usar scope='all'",
        });
      }

      req.logger?.info({
        layer: "controller",
        action: "TICKET_NUMBERS_SUMMARY_PDF_BEFORE_SERVICE",
        payload: { effectiveFilters, effectiveScope },
      });

      // Obtener los datos del resumen
      const result = await TicketService.numbersSummary(
        {
          date: date || "today",
          fromDate,
          toDate,
          scope: effectiveScope,
          dimension,
          ventanaId: effectiveFilters.ventanaId,
          vendedorId: effectiveFilters.vendedorId,
          loteriaId: effectiveFilters.loteriaId,
          sorteoId: effectiveFilters.sorteoId,
          multiplierId,
          status,
        },
        me.role,
        me.id
      );

      req.logger?.info({
        layer: "controller",
        action: "TICKET_NUMBERS_SUMMARY_PDF_SERVICE_SUCCESS",
        payload: {
          metaKeys: Object.keys(result.meta),
          dataLength: result.data.length,
        },
      });

      // Generar el PDF
      const { generateNumbersSummaryPDF } = await import('../services/pdf-generator.service');

      req.logger?.info({
        layer: "controller",
        action: "TICKET_NUMBERS_SUMMARY_PDF_BEFORE_GENERATE",
        payload: { meta: result.meta },
      });

      const pdfBuffer = await generateNumbersSummaryPDF({
        meta: result.meta,
        numbers: result.data,
      });

      const generationTime = Date.now() - startTime;

      req.logger?.info({
        layer: "controller",
        action: "TICKET_NUMBERS_SUMMARY_PDF_GENERATED",
        payload: {
          userId: me.id,
          pdfSize: pdfBuffer.length,
          generationTimeMs: generationTime,
          format: format || 'pdf',
        },
      });

      // ✅ NUEVO: Convertir a PNG si se solicita
      let finalBuffer: Buffer;
      let contentType: string;
      let fileExtension: string;

      if (format === 'png') {
        // Convertir PDF a PNG
        const { pdfToPng } = await import('pdf-to-png-converter');

        req.logger?.info({
          layer: "controller",
          action: "TICKET_NUMBERS_SUMMARY_CONVERTING_TO_PNG",
          payload: { pdfSize: pdfBuffer.length },
        });

        // Convertir Buffer a Uint8Array para pdf-to-png-converter
        const pdfUint8Array = new Uint8Array(pdfBuffer);
        const pngPages = await pdfToPng(pdfUint8Array.buffer, {
          pagesToProcess: [1], // Solo la primera página
        });

        if (!pngPages || pngPages.length === 0) {
          throw new Error('Failed to convert PDF to PNG');
        }

        finalBuffer = pngPages[0].content as Buffer;
        contentType = 'image/png';
        fileExtension = 'png';

        req.logger?.info({
          layer: "controller",
          action: "TICKET_NUMBERS_SUMMARY_PNG_GENERATED",
          payload: {
            userId: me.id,
            pngSize: finalBuffer.length,
            conversionTimeMs: Date.now() - startTime,
          },
        });
      } else {
        // Devolver PDF
        finalBuffer = pdfBuffer;
        contentType = 'application/pdf';
        fileExtension = 'pdf';
      }

      // Configurar headers HTTP para descarga
      const timestamp = Date.now();
      const filename = `lista-numeros-${timestamp}.${fileExtension}`;

      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Length', finalBuffer.length);
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');

      return res.send(finalBuffer);
    } catch (err: any) {
      req.logger?.error({
        layer: "controller",
        action: "TICKET_NUMBERS_SUMMARY_PDF_ERROR",
        payload: {
          message: err.message,
          stack: err.stack,
          name: err.name,
          code: err.code,
        },
      });
      throw err;
    }
  },

  /**
   * GET /api/v1/tickets/by-number/:ticketNumber
   * Obtiene las jugadas de un ticket existente mediante su número
   * Endpoint público/inter-vendedor (no filtra por vendedor)
   */
  async getByTicketNumber(req: AuthenticatedRequest, res: Response) {
    const { ticketNumber } = req.params;

    try {
      const result = await TicketService.getByTicketNumber(ticketNumber);
      return success(res, result);
    } catch (err: any) {
      // Manejar errores de AppError
      if (err.statusCode && err.message) {
        return res.status(err.statusCode).json({
          success: false,
          error: err.errorCode || "ERROR",
          message: err.message,
        });
      }

      // Error genérico
      return res.status(500).json({
        success: false,
        error: "INTERNAL_ERROR",
        message: "Error al obtener el ticket",
      });
    }
  },

  /**
   * GET /api/v1/tickets/filter-options
   * Obtiene las opciones disponibles para los filtros de tickets
   * basándose en los tickets reales del usuario según su rol
   */
  async getFilterOptions(req: AuthenticatedRequest, res: Response) {
    const {
      scope,
      vendedorId,
      ventanaId,
      date,
      fromDate,
      toDate,
      status,
    } = req.query as any;

    const me = req.user!;

    try {
      const result = await TicketService.getFilterOptions(
        {
          scope,
          vendedorId,
          ventanaId,
          date,
          fromDate,
          toDate,
          status,
        },
        {
          userId: me.id,
          role: me.role,
          ventanaId: me.ventanaId,
          bancaId: req.bancaContext?.bancaId || null,
        }
      );

      req.logger?.info({
        layer: 'controller',
        action: 'TICKET_FILTER_OPTIONS',
        payload: {
          scope,
          totalTickets: result.meta.totalTickets,
          loteriasCount: result.loterias.length,
          sorteosCount: result.sorteos.length,
          multipliersCount: result.multipliers.length,
          vendedoresCount: result.vendedores.length,
        },
      });

      return success(res, result);
    } catch (err: any) {
      if (err.statusCode && err.message) {
        return res.status(err.statusCode).json({
          success: false,
          error: err.errorCode || 'ERROR',
          message: err.message,
        });
      }

      return res.status(500).json({
        success: false,
        error: 'INTERNAL_ERROR',
        message: 'Error al obtener opciones de filtros',
      });
    }
  },

  /**
   * GET /api/v1/tickets/numbers-summary/filter-options
   * Obtiene las opciones disponibles para los filtros de numbers-summary
   * basándose en los tickets reales del usuario según su rol
   */
  async getNumbersSummaryFilterOptions(req: AuthenticatedRequest, res: Response) {
    const {
      scope,
      vendedorId,
      ventanaId,
      date,
      fromDate,
      toDate,
      loteriaId,
      sorteoId,
      multiplierId,
      status,
    } = req.query as any;

    const me = req.user!;

    try {
      const result = await TicketService.getNumbersSummaryFilterOptions(
        {
          scope,
          vendedorId,
          ventanaId,
          date,
          fromDate,
          toDate,
          loteriaId,
          sorteoId,
          multiplierId,
          status,
        },
        {
          userId: me.id,
          role: me.role,
          ventanaId: me.ventanaId,
          bancaId: req.bancaContext?.bancaId || null,
        }
      );

      req.logger?.info({
        layer: 'controller',
        action: 'TICKET_NUMBERS_SUMMARY_FILTER_OPTIONS',
        payload: {
          scope,
          totalTickets: result.meta.totalTickets,
          loteriasCount: result.loterias.length,
          sorteosCount: result.sorteos.length,
          multipliersCount: result.multipliers.length,
          vendedoresCount: result.vendedores.length,
        },
      });

      return success(res, result);
    } catch (err: any) {
      if (err.statusCode && err.message) {
        return res.status(err.statusCode).json({
          success: false,
          error: err.errorCode || 'ERROR',
          message: err.message,
        });
      }

      return res.status(500).json({
        success: false,
        error: 'INTERNAL_ERROR',
        message: 'Error al obtener opciones de filtros para numbers-summary',
      });
    }
  },
};
