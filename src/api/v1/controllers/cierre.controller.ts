import { Response } from 'express';
import { AppError } from '../../../core/errors';
import { success } from '../../../utils/responses';
import { AuthenticatedRequest } from '../../../core/types';
import { Role } from '@prisma/client';
import { CierreService } from '../services/cierre.service';
import { CierreExportService } from '../services/cierre-export.service';
import { validateVentanaUser } from '../../../utils/rbac';
import { validateDateRange } from '../validators/cierre.validator';
import {
  CierreFilters,
  CierreScope,
  CierreView,
} from '../types/cierre.types';

const TIMEZONE = 'America/Costa_Rica';

/**
 * Parsea una fecha YYYY-MM-DD en zona horaria Costa Rica a UTC
 */
function parseDateCR(dateStr: string, boundary: 'start' | 'end'): Date {
  const [year, month, day] = dateStr.split('-').map(Number);

  if (boundary === 'start') {
    // Inicio del día en CR: 00:00:00 CR = 06:00:00 UTC
    return new Date(Date.UTC(year, month - 1, day, 6, 0, 0, 0));
  } else {
    // Fin del día en CR: 23:59:59.999 CR = 05:59:59.999 UTC del día siguiente
    return new Date(Date.UTC(year, month - 1, day + 1, 5, 59, 59, 999));
  }
}

/**
 * Aplica filtros RBAC basados en el rol del usuario
 */
async function applyRbacToFilters(
  user: { id: string; role: Role; ventanaId?: string | null },
  fromDate: Date,
  toDate: Date,
  requestedVentanaId?: string,
  requestedScope?: string
): Promise<CierreFilters> {
  const scope: CierreScope = requestedScope === 'mine' ? 'mine' : 'all';
  let ventanaId: string | undefined;

  if (user.role === Role.VENTANA) {
    // VENTANA: siempre scope=mine, forzar ventanaId
    const validatedVentanaId = await validateVentanaUser(
      user.role,
      user.ventanaId,
      user.id
    );

    if (!validatedVentanaId) {
      throw new AppError('VENTANA user must have ventanaId assigned', 403, {
        code: 'RBAC_003',
      });
    }

    ventanaId = validatedVentanaId;

    // Si solicita una ventana diferente, rechazar
    if (requestedVentanaId && requestedVentanaId !== ventanaId) {
      throw new AppError('Cannot access other ventanas', 403, {
        code: 'RBAC_001',
      });
    }
  } else if (user.role === Role.ADMIN) {
    // ADMIN: puede ver todas las ventanas o una específica
    if (scope === 'mine' && user.ventanaId) {
      ventanaId = user.ventanaId;
    } else if (requestedVentanaId) {
      ventanaId = requestedVentanaId;
    }
    // Si scope=all y no requestedVentanaId, ventanaId queda undefined (global)
  }

  return {
    fromDate,
    toDate,
    ventanaId,
    scope,
  };
}

/**
 * Controlador para endpoints de Cierre Operativo
 * Implementa RBAC (ADMIN=all; VENTANA=mine con DB lookup)
 * Sigue estándar: success(res, data, meta)
 */
export const CierreController = {
  /**
   * GET /api/v1/cierres/weekly
   * Cierre semanal agregado por banda, lotería y turno
   */
  async getWeekly(req: AuthenticatedRequest, res: Response) {
    if (!req.user) {
      throw new AppError('Unauthorized', 401);
    }

    // Solo ADMIN y VENTANA tienen acceso
    if (req.user.role === Role.VENDEDOR) {
      throw new AppError('No autorizado para ver cierres', 403);
    }

    const query = req.query as any;

    // Validar fechas obligatorias
    if (!query.from || !query.to) {
      throw new AppError('Parámetros "from" y "to" son obligatorios', 400);
    }

    // Validar rango de fechas
    validateDateRange(query.from, query.to);

    // Convertir fechas a UTC (inicio y fin de día en CR)
    const fromDate = parseDateCR(query.from, 'start');
    const toDate = parseDateCR(query.to, 'end');

    // Aplicar RBAC
    const filters = await applyRbacToFilters(
      req.user,
      fromDate,
      toDate,
      query.ventanaId,
      query.scope
    );

    // Ejecutar agregación (servicio retorna data + _performance)
    const { _performance, ...data } = await CierreService.aggregateWeekly(filters);

    // Construir effectiveFilters para meta
    const effectiveFilters: any = {
      scope: filters.scope,
    };
    if (filters.ventanaId) effectiveFilters.ventanaId = filters.ventanaId;
    if (filters.loteriaId) effectiveFilters.loteriaId = filters.loteriaId;

    // Retornar siguiendo estándar: success(res, data, meta)
    return success(res, data, {
      range: {
        fromAt: filters.fromDate.toISOString(),
        toAt: filters.toDate.toISOString(),
        tz: TIMEZONE,
      },
      scope: filters.scope,
      effectiveFilters,
      queryExecutionTime: _performance.queryExecutionTime,
      totalQueries: _performance.totalQueries,
      generatedAt: new Date().toISOString(),
    });
  },

  /**
   * GET /api/v1/cierres/by-seller
   * Cierre agregado por vendedor
   */
  async getBySeller(req: AuthenticatedRequest, res: Response) {
    if (!req.user) {
      throw new AppError('Unauthorized', 401);
    }

    // Solo ADMIN y VENTANA tienen acceso
    if (req.user.role === Role.VENDEDOR) {
      throw new AppError('No autorizado para ver cierres', 403);
    }

    const query = req.query as any;

    // Validar fechas obligatorias
    if (!query.from || !query.to) {
      throw new AppError('Parámetros "from" y "to" son obligatorios', 400);
    }

    // Validar rango de fechas
    validateDateRange(query.from, query.to);

    // Convertir fechas
    const fromDate = parseDateCR(query.from, 'start');
    const toDate = parseDateCR(query.to, 'end');

    // Aplicar RBAC
    const filters = await applyRbacToFilters(
      req.user,
      fromDate,
      toDate,
      query.ventanaId,
      query.scope
    );

    // Parámetros de ordenamiento
    const top = query.top ? parseInt(query.top, 10) : undefined;
    const orderBy = query.orderBy || 'totalVendida';

    // Ejecutar agregación (servicio retorna data + _performance)
    const { _performance, ...data } = await CierreService.aggregateBySeller(
      filters,
      top,
      orderBy
    );

    // Construir effectiveFilters para meta
    const effectiveFilters: any = {
      scope: filters.scope,
      top,
      orderBy,
    };
    if (filters.ventanaId) effectiveFilters.ventanaId = filters.ventanaId;
    if (filters.loteriaId) effectiveFilters.loteriaId = filters.loteriaId;

    // Retornar siguiendo estándar: success(res, data, meta)
    return success(res, data, {
      range: {
        fromAt: filters.fromDate.toISOString(),
        toAt: filters.toDate.toISOString(),
        tz: TIMEZONE,
      },
      scope: filters.scope,
      effectiveFilters,
      queryExecutionTime: _performance.queryExecutionTime,
      totalQueries: _performance.totalQueries,
      generatedAt: new Date().toISOString(),
    });
  },

  /**
   * GET /api/v1/cierres/export.xlsx
   * Exporta cierre a Excel
   */
  async exportXLSX(req: AuthenticatedRequest, res: Response) {
    if (!req.user) {
      throw new AppError('Unauthorized', 401);
    }

    // Solo ADMIN y VENTANA tienen acceso
    if (req.user.role === Role.VENDEDOR) {
      throw new AppError('No autorizado para exportar cierres', 403);
    }

    const query = req.query as any;

    // Validar parámetros
    if (!query.from || !query.to || !query.view) {
      throw new AppError(
        'Parámetros "from", "to" y "view" son obligatorios',
        400
      );
    }

    // Validar rango de fechas
    validateDateRange(query.from, query.to);

    const view: CierreView = query.view;

    // Convertir fechas
    const fromDate = parseDateCR(query.from, 'start');
    const toDate = parseDateCR(query.to, 'end');

    // Aplicar RBAC
    const filters = await applyRbacToFilters(
      req.user,
      fromDate,
      toDate,
      query.ventanaId,
      query.scope
    );

    // Obtener datos según la vista
    let result;

    if (view === 'seller') {
      const top = query.top ? parseInt(query.top, 10) : undefined;
      const orderBy = query.orderBy || 'totalVendida';
      result = await CierreService.aggregateBySeller(filters, top, orderBy);
    } else {
      result = await CierreService.aggregateWeekly(filters);
    }

    // Remover _performance antes de exportar
    const { _performance, ...data } = result;

    // Generar workbook de Excel
    const workbook = await CierreExportService.generateWorkbook(data as any, view);

    // Configurar headers de respuesta
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=cierre-${query.from}-${query.to}.xlsx`
    );

    // Escribir workbook directamente a la respuesta
    await workbook.xlsx.write(res);
    res.end();
  },
};
