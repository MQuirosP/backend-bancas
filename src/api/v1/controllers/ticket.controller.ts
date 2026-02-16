// src/modules/tickets/controllers/ticket.controller.ts
import { Response } from "express";
import { TicketService } from "../services/ticket.service";
import { AuthenticatedRequest } from "../../../core/types";
import { success } from "../../../utils/responses";
import { Role } from "@prisma/client";
import { resolveDateRange, DateRangeResolution } from "../../../utils/dateRange";
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

  async getTicketImage(req: AuthenticatedRequest, res: Response) {
    const ticketId = req.params.id;
    const userId = req.user!.id;
    const role = req.user!.role;

    try {
      const imageBuffer = await TicketService.getTicketImage(ticketId, userId, role, req.requestId);

      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Content-Disposition', `inline; filename="ticket-${ticketId}.png"`);
      res.setHeader('Cache-Control', 'public, max-age=3600'); // Cache por 1 hora
      res.setHeader('Content-Length', imageBuffer.length.toString());

      return res.send(imageBuffer);
    } catch (err: any) {
      if (err.statusCode && err.message) {
        return res.status(err.statusCode).json({
          success: false,
          error: err.errorCode || "ERROR",
          message: err.message,
        });
      }

      req.logger?.error({
        layer: "controller",
        action: "TICKET_IMAGE_ERROR",
        payload: {
          ticketId,
          error: err.message,
        },
      });

      return res.status(500).json({
        success: false,
        error: "INTERNAL_ERROR",
        message: "Error al generar imagen del ticket",
      });
    }
  },

  async list(req: AuthenticatedRequest, res: Response) {
    const { page = 1, pageSize = 10, scope = "mine", date = "today", fromDate, toDate, number, winningNumber, isActive, winnersOnly, scheduledTime, ...rest } = req.query as any;

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

    let dateRange: DateRangeResolution | null = null;

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
        dateTo: dateRange.toAt,
        businessDateFrom: dateRange.fromBusinessDate,
        businessDateTo: dateRange.toBusinessDate,
      } : {}),
      ...(number ? { number } : {}),
      ...(winningNumber ? { winningNumber } : {}),
      ...(scheduledTime ? { scheduledTime } : {}),
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
    const { date, fromDate, toDate, scope, dimension, ventanaId, vendedorId, loteriaId, sorteoId, multiplierId, status, page, pageSize } = req.query as any;

    const me = req.user!;

    // Log para debugging
    req.logger?.info({
      layer: "controller",
      action: "TICKET_NUMBERS_SUMMARY_REQUEST",
      payload: {
        userId: me.id,
        role: me.role,
        queryParams: { date, fromDate, toDate, scope, dimension, ventanaId, vendedorId, loteriaId, sorteoId, page, pageSize },
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
      //  FIX: Para dimension='listero', forzar el ventanaId del usuario VENTANA
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

    //  FIX: Regla especial - cuando hay sorteoId y no hay fechas explícitas, NO aplicar filtros de fecha
    // (igual que en endpoint /tickets/list)
    const hasSorteoId = effectiveFilters.sorteoId;
    const hasExplicitDateRange = fromDate || toDate;

    let dateRange: DateRangeResolution | null = null;

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
        multiplierId, //  NUEVO
        status, //  NUEVO
        page, //  FIX: Paginación para MONAZOS
        pageSize, //  FIX: Paginación para MONAZOS
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
      const { date, fromDate, toDate, scope, dimension, ventanaId, vendedorId, loteriaId, sorteoId, multiplierId, status, format, page, pageSize, onlyWithSales } = req.body;

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

      //  Para PDF/PNG, NO usar paginación - siempre obtener TODOS los números
      // La paginación solo se usa para la API de consulta, no para generación de archivos
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
          // NO pasar page ni pageSize - siempre obtener todos los números
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

      //  Convertir a PNG si se solicita
      if (format === 'png') {
        const sorteoDigits = result.meta.sorteoDigits ?? 2;
        const shouldFilterBySales = onlyWithSales === true && sorteoDigits === 3;

        req.logger?.info({
          layer: "controller",
          action: "TICKET_NUMBERS_SUMMARY_CONVERTING_TO_PNG",
          payload: {
            pdfSize: pdfBuffer.length,
            sorteoDigits,
            isMonazo: sorteoDigits === 3,
            onlyWithSales,
            shouldFilterBySales,
          },
        });

        const { pdfToPng } = await import('pdf-to-png-converter');
        const pdfUint8Array = new Uint8Array(pdfBuffer);

        //  NUEVO: Si onlyWithSales === true y es monazos (3 dígitos), generar PNG único filtrado
        if (shouldFilterBySales) {
          const numbersWithBets = result.meta.numbersWithBets || [];
          
          if (numbersWithBets.length === 0) {
            // No hay números con ventas - retornar PNG vacío o error
            req.logger?.warn({
              layer: "controller",
              action: "TICKET_NUMBERS_SUMMARY_PNG_NO_SALES",
              payload: {
                userId: me.id,
                sorteoId,
                message: "No hay números con ventas para generar PNG filtrado",
              },
            });
            
            // Retornar PNG vacío con mensaje
            const { generateNumbersSummaryPDF } = await import('../services/pdf-generator.service');
            const emptyPdfBuffer = await generateNumbersSummaryPDF({
              meta: result.meta,
              numbers: [], // Sin números
            });
            
            const emptyPngPages = await pdfToPng(new Uint8Array(emptyPdfBuffer).buffer, {
              pagesToProcess: [1],
            });
            
            if (!emptyPngPages || emptyPngPages.length === 0) {
              throw new Error('Failed to convert empty PDF to PNG');
            }
            
            const finalBuffer = emptyPngPages[0].content as Buffer;
            const timestamp = Date.now();
            const filename = `lista-numeros-sin-ventas-${timestamp}.png`;
            
            res.setHeader('Content-Type', 'image/png');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            res.setHeader('Content-Length', finalBuffer.length);
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
            
            return res.send(finalBuffer);
          }
          
          //  Filtrar números para incluir solo los que tienen ventas
          const sorteoDigits = result.meta.sorteoDigits ?? 3;
          const filteredNumbers = result.data.filter((item: any) => 
            numbersWithBets.includes(item.number.padStart(sorteoDigits, '0'))
          );
          
          req.logger?.info({
            layer: "controller",
            action: "TICKET_NUMBERS_SUMMARY_PNG_FILTERING",
            payload: {
              userId: me.id,
              totalNumbers: result.data.length,
              filteredNumbers: filteredNumbers.length,
              numbersWithBets: numbersWithBets.length,
            },
          });
          
          //  Generar PDF con solo números filtrados
          const { generateNumbersSummaryPDF } = await import('../services/pdf-generator.service');
          const filteredPdfBuffer = await generateNumbersSummaryPDF({
            meta: result.meta,
            numbers: filteredNumbers,
          });
          
          //  Convertir a PNG único (primera página)
          const filteredPngPages = await pdfToPng(new Uint8Array(filteredPdfBuffer).buffer, {
            pagesToProcess: [1],
          });
          
          if (!filteredPngPages || filteredPngPages.length === 0) {
            throw new Error('Failed to convert filtered PDF to PNG');
          }
          
          const finalBuffer = filteredPngPages[0].content as Buffer;
          const timestamp = Date.now();
          const filename = `lista-numeros-filtrado-${timestamp}.png`;
          
          req.logger?.info({
            layer: "controller",
            action: "TICKET_NUMBERS_SUMMARY_PNG_FILTERED_GENERATED",
            payload: {
              userId: me.id,
              pngSize: finalBuffer.length,
              filteredNumbersCount: filteredNumbers.length,
              conversionTimeMs: Date.now() - startTime,
              type: 'monazos-filtered',
            },
          });
          
          res.setHeader('Content-Type', 'image/png');
          res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
          res.setHeader('Content-Length', finalBuffer.length);
          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
          res.setHeader('Pragma', 'no-cache');
          res.setHeader('Expires', '0');
          
          return res.send(finalBuffer);
        }

        if (sorteoDigits === 2) {
          //  Tiempos (2 dígitos): 1 PNG con todos los números (00-99)
          const pngPages = await pdfToPng(pdfUint8Array.buffer, {
            pagesToProcess: [1], // Solo la primera página
          });

          if (!pngPages || pngPages.length === 0) {
            throw new Error('Failed to convert PDF to PNG');
          }

          const finalBuffer = pngPages[0].content as Buffer;
          const timestamp = Date.now();
          const filename = `lista-numeros-${timestamp}.png`;

          req.logger?.info({
            layer: "controller",
            action: "TICKET_NUMBERS_SUMMARY_PNG_GENERATED",
            payload: {
              userId: me.id,
              pngSize: finalBuffer.length,
              conversionTimeMs: Date.now() - startTime,
              type: 'tiempos',
            },
          });

          res.setHeader('Content-Type', 'image/png');
          res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
          res.setHeader('Content-Length', finalBuffer.length);
          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
          res.setHeader('Pragma', 'no-cache');
          res.setHeader('Expires', '0');

          return res.send(finalBuffer);

        } else if (sorteoDigits === 3) {
          //  Monazos (3 dígitos): 5 PNGs paginados (000-199, 200-399, ..., 800-999)
          // El PDF tiene exactamente 5 páginas para monazos (una por cada bloque de 200 números)
          // Generar array de números de página [1, 2, 3, 4, 5]
          const maxPages = 5;
          const pageNumbers = Array.from({ length: maxPages }, (_, i) => i + 1);
          
          req.logger?.info({
            layer: "controller",
            action: "TICKET_NUMBERS_SUMMARY_PNG_MONAZOS_CONVERTING",
            payload: {
              userId: me.id,
              pdfSize: pdfBuffer.length,
              pagesToConvert: pageNumbers,
              type: 'monazos',
            },
          });
          
          const allPngPages = await pdfToPng(pdfUint8Array.buffer, {
            pagesToProcess: pageNumbers, // Convertir todas las 10 páginas
          });

          if (!allPngPages || allPngPages.length === 0) {
            throw new Error('Failed to convert PDF to PNG');
          }

          req.logger?.info({
            layer: "controller",
            action: "TICKET_NUMBERS_SUMMARY_PNG_MONAZOS_GENERATED",
            payload: {
              userId: me.id,
              totalPages: allPngPages.length,
              expectedPages: maxPages,
              conversionTimeMs: Date.now() - startTime,
              type: 'monazos',
            },
          });

          //  Generar JSON con estructura requerida
          // Filtrar páginas sin contenido y mapear a formato requerido
          const pages = allPngPages
            .filter((pngPage) => pngPage && pngPage.content !== undefined && pngPage.content !== null)
            .map((pngPage, index) => {
              const buffer = pngPage.content as Buffer;
              if (!buffer) {
                req.logger?.warn({
                  layer: "controller",
                  action: "TICKET_NUMBERS_SUMMARY_PNG_PAGE_MISSING_CONTENT",
                  payload: { pageIndex: index },
                });
                return null;
              }
              
              //  Convertir Buffer a base64 puro (sin prefijo data URL)
              // El frontend agregará el prefijo si lo necesita para Web Share API
              const base64String = buffer.toString('base64');
              
              req.logger?.info({
                layer: "controller",
                action: "TICKET_NUMBERS_SUMMARY_PNG_PAGE_GENERATED",
                payload: {
                  pageIndex: index,
                  bufferSize: buffer.length,
                  base64Length: base64String.length,
                },
              });
              
              return {
                page: index,
                filename: `lista-numeros-page-${index + 1}.png`,
                image: base64String, // Base64 puro (sin prefijo data URL)
              };
            })
            .filter((page) => page !== null) as Array<{ page: number; filename: string; image: string }>; // Eliminar páginas nulas y tipar

          if (pages.length === 0) {
            throw new Error('No PNG pages were generated successfully');
          }

          req.logger?.info({
            layer: "controller",
            action: "TICKET_NUMBERS_SUMMARY_PNG_MONAZOS_FINAL",
            payload: {
              userId: me.id,
              totalPages: pages.length,
              numbersWithBetsCount: result.meta.numbersWithBets?.length || 0,
            },
          });

          //  Retornar JSON con páginas y números con apuestas
          return res.json({
            pages,
            numbersWithBets: result.meta.numbersWithBets || [], // Números que tienen apuestas
          });
        } else {
          // Fallback: tratar como tiempos (2 dígitos)
          const pngPages = await pdfToPng(pdfUint8Array.buffer, {
            pagesToProcess: [1],
          });

          if (!pngPages || pngPages.length === 0) {
            throw new Error('Failed to convert PDF to PNG');
          }

          const finalBuffer = pngPages[0].content as Buffer;
          const timestamp = Date.now();
          const filename = `lista-numeros-${timestamp}.png`;

          res.setHeader('Content-Type', 'image/png');
          res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
          res.setHeader('Content-Length', finalBuffer.length);
          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
          res.setHeader('Pragma', 'no-cache');
          res.setHeader('Expires', '0');

          return res.send(finalBuffer);
        }
      } else {
        //  Devolver PDF
        const timestamp = Date.now();
        const filename = `lista-numeros-${timestamp}.pdf`;

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-Length', pdfBuffer.length);
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');

        return res.send(pdfBuffer);
      }
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
   * POST /api/v1/tickets/numbers-summary/pdf/batch
   * Genera un único PDF/PNG con todas las listas por multiplicador (batch)
   * Disminuye N llamadas individuales actuales.
   */
  async numbersSummaryPdfBatch(req: AuthenticatedRequest, res: Response) {
    try {
      const { multiplierIds, format, groupBy = 'multiplier', ...rest } = req.body;
      const me = req.user!;

      if (groupBy !== 'multiplier') {
        return res.status(400).json({ success: false, error: "GROUP_NOT_SUPPORTED", message: "Solo se admite groupBy=multiplier" });
      }

      if (format && format !== 'png') {
        return res.status(400).json({ success: false, error: "FORMAT_NOT_SUPPORTED", message: "Solo se admite format='png' en batch" });
      }

      // Reutilizar el mismo contexto RBAC que el endpoint normal
      const context: AuthContext = {
        userId: me.id,
        role: me.role,
        ventanaId: me.ventanaId,
        bancaId: req.bancaContext?.bancaId || null,
      };

      const requestFilters: RequestFilters = {
        ...(rest.ventanaId ? { ventanaId: rest.ventanaId } : {}),
        ...(rest.vendedorId ? { vendedorId: rest.vendedorId } : {}),
        ...(rest.loteriaId ? { loteriaId: rest.loteriaId } : {}),
        ...(rest.sorteoId ? { sorteoId: rest.sorteoId } : {}),
      };

      const effectiveFilters = await applyRbacFilters(context, requestFilters);

      // Resolver lista de multiplicadores
      const multipliers = await TicketService.resolveMultipliersForBatch({
        loteriaId: effectiveFilters.loteriaId,
        sorteoId: effectiveFilters.sorteoId,
        multiplierIds,
      });

      if (multipliers.length === 0) {
        return res.status(404).json({ success: false, error: "NO_MULTIPLIERS", message: "No se encontraron multiplicadores para generar el batch" });
      }

      const result = await TicketService.numbersSummaryBatch(
        {
          ...rest,
          scope: rest.scope || (me.role === Role.ADMIN ? 'all' : 'mine'),
          ventanaId: effectiveFilters.ventanaId,
          vendedorId: effectiveFilters.vendedorId,
          loteriaId: effectiveFilters.loteriaId,
          sorteoId: effectiveFilters.sorteoId,
          multipliers,
        },
        me.role,
        me.id,
        'png'
      );

      // Siempre PNG para batch: devolver JSON
      return res.json({
        success: true,
        format: 'png',
        pages: result.pages,
        meta: result.meta,
      });
    } catch (err: any) {
      req.logger?.error({
        layer: "controller",
        action: "TICKET_NUMBERS_SUMMARY_PDF_BATCH_ERROR",
        payload: { message: err.message, stack: err.stack },
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
