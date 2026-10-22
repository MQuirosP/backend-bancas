import prisma from "../../../core/prismaClient";
import { AppError } from "../../../core/errors";
import logger from "../../../core/logger";
import { Role } from "../../../generated/prisma/client";
import { CacheService } from "../../../core/cache.service";
import { WorkerService } from "../../../api/v1/services/worker.service";
import { TicketPrintService } from "../TicketPrintService";
import { mmToPixels } from "../../../utils/printDimensions";

export class TicketThermalRenderService {
  /**
   * Obtiene la imagen del ticket como blob PNG térmico vía WorkerService y caché L1/Redis
   * GET /api/v1/tickets/:id/image
   */
  static async getTicketImage(
    id: string,
    userId: string,
    role: Role,
    requestId?: string,
  ): Promise<Buffer> {
    try {
      // Obtener ticket con todas las relaciones necesarias
      const ticket = await prisma.ticket.findUnique({
        where: { id },
        select: {
          id: true,
          ticketNumber: true,
          printCount: true,
          totalAmount: true,
          clienteNombre: true,
          createdAt: true,
          isActive: true,
          vendedorId: true,
          ventanaId: true,
          jugadas: {
            where: { deletedAt: null },
            select: {
              type: true,
              number: true,
              amount: true,
              finalMultiplierX: true,
            },
            orderBy: { createdAt: "asc" },
          },
          sorteo: {
            select: {
              name: true,
              scheduledAt: true,
              loteria: {
                select: {
                  name: true,
                  rulesJson: true,
                },
              },
            },
          },
          vendedor: {
            select: {
              name: true,
              phone: true,
              code: true,
              settings: true,
            },
          },
          ventana: {
            select: {
              name: true,
              phone: true,
              settings: true,
            },
          },
        },
      });

      if (!ticket) {
        throw new AppError("Ticket no encontrado", 404);
      }

      // Verificar permisos (RBAC)
      if (role === Role.VENDEDOR) {
        if (ticket.vendedorId !== userId) {
          throw new AppError("No autorizado para ver este ticket", 403);
        }
      } else if (role === Role.VENTANA) {
        const user = await prisma.user.findUnique({
          where: { id: userId },
          select: { ventanaId: true },
        });
        if (!user?.ventanaId || ticket.ventanaId !== user.ventanaId) {
          throw new AppError("No autorizado para ver este ticket", 403);
        }
      } else if (role === Role.BANCA) {
        // BANCA: solo puede ver tickets de su propia banca
        const user = await prisma.user.findUnique({
          where: { id: userId },
          select: { bancaId: true },
        });

        // Obtener bancaId del ticket a través de la ventana
        const ticketBanca = await prisma.ventana.findUnique({
          where: { id: ticket.ventanaId },
          select: { bancaId: true },
        });

        if (!user?.bancaId || ticketBanca?.bancaId !== user.bancaId) {
          throw new AppError("No autorizado para ver este ticket", 403);
        }
      }
      // ADMIN puede ver cualquier ticket

      // Obtener configuraciones de impresión
      const vendedorConfig = TicketPrintService.extractPrintConfig(
        ticket.vendedor?.settings,
        ticket.vendedor?.name || null,
        ticket.vendedor?.phone || null,
      );
      const ventanaConfig = TicketPrintService.extractPrintConfig(
        ticket.ventana?.settings,
        ticket.ventana?.name || null,
        ticket.ventana?.phone || null,
      );

      const vendedorBarcodeEnabled = vendedorConfig.printBarcode !== false;
      const ventanaBarcodeEnabled = ventanaConfig.printBarcode !== false;

      // Formatear sorteo.name concatenando la hora
      const sorteoWithFormattedName = {
        ...ticket.sorteo,
        name: TicketPrintService.formatSorteoNameWithTime(
          ticket.sorteo.name,
          ticket.sorteo.scheduledAt,
        ),
      };

      // 1. Verificar si la imagen ya existe en la caché determinista de Redis (<5ms)
      const printCount = ticket.printCount ?? 0;
      const activeFlag = ticket.isActive ? 1 : 0;
      const cacheKey = `ticket:img:${ticket.id}:${printCount}:${activeFlag}`;

      const cachedBuffer = await CacheService.getBuffer(cacheKey);
      if (cachedBuffer) {
        logger.info({
          layer: "service",
          action: "TICKET_IMAGE_CACHE_HIT",
          userId,
          requestId,
          payload: {
            ticketId: ticket.id,
            cacheKey,
            imageSize: cachedBuffer.length,
          },
        });
        return cachedBuffer;
      }

      // Determinar ancho usando la utilidad pura sin dependencias de Canvas
      const printWidthMm =
        vendedorConfig.printWidth || ventanaConfig.printWidth || 58;
      const printWidthPx = mmToPixels(printWidthMm);

      // Generar imagen delegando al Worker Thread para no bloquear el Event Loop
      const imageBuffer = await WorkerService.generateTicketImage(
        {
          ticket: {
            id: ticket.id,
            ticketNumber: ticket.ticketNumber,
            printCount: ticket.printCount,
            totalAmount: ticket.totalAmount,
            clienteNombre: ticket.clienteNombre,
            createdAt: ticket.createdAt,
            isActive: ticket.isActive,
            jugadas: ticket.jugadas,
            sorteo: {
              ...sorteoWithFormattedName,
              loteria: ticket.sorteo.loteria,
            },
            vendedor: {
              name: ticket.vendedor?.name || null,
              code: ticket.vendedor?.code || null,
              printName: vendedorConfig.printName,
              printPhone: vendedorConfig.printPhone,
              printBarcode: vendedorBarcodeEnabled,
              printFooter: vendedorConfig.printFooter,
            },
            ventana: {
              name: ticket.ventana?.name || null,
              printName: ventanaConfig.printName,
              printPhone: ventanaConfig.printPhone,
              printBarcode: ventanaBarcodeEnabled,
              printFooter: ventanaConfig.printFooter,
            },
          },
        },
        {
          width: printWidthPx,
          scale: 2,
        },
      );

      // Guardar en Redis con ventana efímera de 20 segundos
      await CacheService.setBuffer(cacheKey, imageBuffer, 20);

      // Registro de éxito
      logger.info({
        layer: "service",
        action: "TICKET_IMAGE_GENERATED",
        userId,
        requestId,
        payload: {
          ticketId: ticket.id,
          imageSize: imageBuffer.length,
          printWidthMm,
          printWidthPx,
        },
      });

      return imageBuffer;
    } catch (err: any) {
      logger.error({
        layer: "service",
        action: "TICKET_IMAGE_GENERATION_FAILED",
        userId,
        requestId,
        payload: {
          ticketId: id,
          error: err.message,
        },
      });
      throw err;
    }
  }
}
