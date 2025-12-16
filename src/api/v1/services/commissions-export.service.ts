// src/api/v1/services/commissions-export.service.ts
import { CommissionsService } from './commissions.service';
import { CommissionsExportCsvService } from './commissions-export-csv.service';
import { CommissionsExportExcelService } from './commissions-export-excel.service';
import { CommissionsExportPdfService } from './commissions-export-pdf.service';
import {
  CommissionExportPayload,
  ExportFormat,
  CommissionBreakdownItem,
  CommissionWarning,
  CommissionPolicy,
  CommissionPolicyRule,
} from '../types/commissions-export.types';
import prisma from '../../../core/prismaClient';
import { resolveDateRange } from '../../../utils/dateRange';
import { Prisma } from '@prisma/client';
import logger from '../../../core/logger';

/**
 * Servicio orquestador para exportación de comisiones
 */
export class CommissionsExportService {
  /**
   * Genera archivo de exportación en el formato solicitado
   */
  static async export(
    format: ExportFormat,
    date: string,
    fromDate: string | undefined,
    toDate: string | undefined,
    filters: {
      scope: string;
      dimension: string;
      ventanaId?: string;
      vendedorId?: string;
      bancaId?: string;
    },
    options: {
      includeBreakdown: boolean;
      includeWarnings: boolean;
    },
    ventanaUserId?: string
  ): Promise<{ buffer: Buffer; filename: string; mimeType: string }> {
    try {
      // 1. Obtener datos de resumen
      const summary = await CommissionsService.list(date, fromDate, toDate, filters, ventanaUserId);

      // 2. Resolver rango de fechas
      const dateRange = resolveDateRange(date, fromDate, toDate);
      const COSTA_RICA_OFFSET_HOURS = -6;
      const offsetMs = COSTA_RICA_OFFSET_HOURS * 60 * 60 * 1000;
      const fromDateCr = new Date(dateRange.fromAt.getTime() + offsetMs);
      const toDateCr = new Date(dateRange.toAt.getTime() + offsetMs);
      const fromDateStr = fromDateCr.toISOString().split('T')[0];
      const toDateStr = toDateCr.toISOString().split('T')[0];

      // 3. Obtener breakdown detallado (si está habilitado)
      let breakdown: CommissionBreakdownItem[] | undefined = undefined;
      if (options.includeBreakdown) {
        breakdown = await this.getBreakdown(fromDateStr, toDateStr, filters, ventanaUserId);
      }

      // 4. Detectar advertencias (si está habilitado)
      let warnings: CommissionWarning[] | undefined = undefined;
      if (options.includeWarnings) {
        warnings = await this.detectWarnings(fromDateStr, toDateStr, filters);
      }

      // 4.5. Obtener políticas de comisión configuradas
      const policies = await this.getPolicies(fromDateStr, toDateStr, filters);

      // 5. Obtener nombres de entidades para metadata
      let ventanaName: string | undefined = undefined;
      let vendedorName: string | undefined = undefined;

      if (filters.ventanaId) {
        const ventana = await prisma.ventana.findUnique({
          where: { id: filters.ventanaId },
          select: { name: true },
        });
        ventanaName = ventana?.name;
      }

      if (filters.vendedorId) {
        const vendedor = await prisma.user.findUnique({
          where: { id: filters.vendedorId },
          select: { name: true },
        });
        vendedorName = vendedor?.name;
      }

      // 6. Calcular totales
      const totals = {
        totalSales: summary.reduce((acc, item) => acc + item.totalSales, 0),
        totalTickets: summary.reduce((acc, item) => acc + item.totalTickets, 0),
        totalCommission: summary.reduce((acc, item) => acc + item.totalCommission, 0),
        totalPayouts: summary.reduce((acc, item) => acc + item.totalPayouts, 0),
        commissionListero: summary.reduce((acc, item) => acc + (item.commissionListero || 0), 0),
        commissionVendedor: summary.reduce((acc, item) => acc + (item.commissionVendedor || 0), 0),
        net: summary.reduce((acc, item) => acc + (item.net || 0), 0),
      };

      // 7. Construir payload completo
      const payload: CommissionExportPayload = {
        summary,
        breakdown,
        warnings,
        policies,
        metadata: {
          generatedAt: new Date(),
          timezone: 'America/Costa_Rica',
          dateRange: {
            from: fromDateStr,
            to: toDateStr,
          },
          filters: {
            scope: filters.scope,
            dimension: filters.dimension,
            ventanaId: filters.ventanaId,
            vendedorId: filters.vendedorId,
            ventanaName,
            vendedorName,
          },
          totals,
        },
      };

      // 8. Generar archivo según formato
      let buffer: Buffer;
      let mimeType: string;

      switch (format) {
        case 'csv':
          buffer = CommissionsExportCsvService.generate(payload);
          mimeType = 'text/csv; charset=utf-8';
          break;
        case 'excel':
          buffer = await CommissionsExportExcelService.generate(payload);
          mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
          break;
        case 'pdf':
          buffer = await CommissionsExportPdfService.generate(payload);
          mimeType = 'application/pdf';
          break;
        default:
          throw new Error(`Formato de exportación no soportado: ${format}`);
      }

      // 9. Generar nombre de archivo
      const filename = this.generateFilename(format, filters, fromDateStr, toDateStr, ventanaName, vendedorName);

      logger.info({
        layer: 'service',
        action: 'COMMISSIONS_EXPORT',
        payload: {
          format,
          filters,
          dateRange: { from: fromDateStr, to: toDateStr },
          recordCount: summary.length,
          breakdownCount: breakdown?.length || 0,
          warningsCount: warnings?.length || 0,
          filename,
        },
      });

      return { buffer, filename, mimeType };
    } catch (err: any) {
      logger.error({
        layer: 'service',
        action: 'COMMISSIONS_EXPORT_FAIL',
        payload: { message: err.message, format, filters },
      });
      throw err;
    }
  }

  /**
   * Obtiene breakdown detallado por lotería, sorteo y multiplicador
   */
  private static async getBreakdown(
    fromDateStr: string,
    toDateStr: string,
    filters: {
      scope: string;
      dimension: string;
      ventanaId?: string;
      vendedorId?: string;
      bancaId?: string;
    },
    ventanaUserId?: string
  ): Promise<CommissionBreakdownItem[]> {
    // Construir filtros WHERE dinámicos
    const whereConditions: Prisma.Sql[] = [
      Prisma.sql`t."deletedAt" IS NULL`,
      Prisma.sql`t."isActive" = true`,
      Prisma.sql`t."status" IN ('ACTIVE', 'EVALUATED', 'PAID', 'PAGADO')`,
      Prisma.sql`j."deletedAt" IS NULL`,
      Prisma.sql`j."isActive" = true`,
      // Filtrar SOLO sorteos evaluados
      Prisma.sql`EXISTS (
        SELECT 1 FROM "Sorteo" s
        WHERE s.id = t."sorteoId"
        AND s.status = 'EVALUATED'
      )`,
      Prisma.sql`COALESCE(t."businessDate", DATE((t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica'))) >= ${fromDateStr}::date`,
      Prisma.sql`COALESCE(t."businessDate", DATE((t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica'))) <= ${toDateStr}::date`,
      Prisma.sql`j."isExcluded" IS FALSE`,
      // Excluir tickets de listas bloqueadas
      Prisma.sql`NOT EXISTS (
        SELECT 1 FROM "sorteo_lista_exclusion" sle
        JOIN "User" u ON u.id = sle.ventana_id
        WHERE sle.sorteo_id = t."sorteoId"
        AND u."ventanaId" = t."ventanaId"
        AND (sle.vendedor_id IS NULL OR sle.vendedor_id = t."vendedorId")
        AND sle.multiplier_id IS NULL
      )`,
    ];

    // Filtrar por banca activa (para ADMIN multibanca)
    if (filters.bancaId) {
      whereConditions.push(Prisma.sql`EXISTS (
        SELECT 1 FROM "Ventana" v
        WHERE v.id = t."ventanaId"
        AND v."bancaId" = ${filters.bancaId}::uuid
      )`);
    }

    // Aplicar filtros de RBAC según dimension
    if (filters.dimension === 'vendedor') {
      if (filters.vendedorId) {
        whereConditions.push(Prisma.sql`t."vendedorId" = ${filters.vendedorId}::uuid`);
      }
      if (filters.ventanaId) {
        whereConditions.push(Prisma.sql`t."ventanaId" = ${filters.ventanaId}::uuid`);
      }
    } else if (filters.dimension === 'ventana') {
      if (filters.ventanaId) {
        whereConditions.push(Prisma.sql`t."ventanaId" = ${filters.ventanaId}::uuid`);
      }
    }

    const whereClause = Prisma.sql`WHERE ${Prisma.join(whereConditions, ' AND ')}`;

    // Query para obtener breakdown
    const result = await prisma.$queryRaw<
      Array<{
        business_date: Date;
        ventana_name: string | null;
        vendedor_name: string | null;
        loteria_name: string;
        sorteo_time: string;
        multiplier_name: string | null;
        multiplier_value_x: number | null;
        multiplier_kind: string | null;
        total_sales: number;
        commission_amount: number | null;
        listero_commission_amount: number | null;
        tickets_count: string;
      }>
    >`
      SELECT
        COALESCE(
          t."businessDate",
          DATE((t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica'))
        ) as business_date,
        v.name as ventana_name,
        u.name as vendedor_name,
        l.name as loteria_name,
        (s."scheduledAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica')::time::text as sorteo_time,
        lm.name as multiplier_name,
        lm."valueX" as multiplier_value_x,
        lm.kind as multiplier_kind,
        SUM(j.amount) as total_sales,
        SUM(j."commissionAmount") as commission_amount,
        SUM(j."listeroCommissionAmount") as listero_commission_amount,
        COUNT(DISTINCT t.id)::text as tickets_count
      FROM "Ticket" t
      INNER JOIN "Jugada" j ON j."ticketId" = t.id
      INNER JOIN "Loteria" l ON l.id = t."loteriaId"
      INNER JOIN "Sorteo" s ON s.id = t."sorteoId"
      LEFT JOIN "Ventana" v ON v.id = t."ventanaId"
      LEFT JOIN "User" u ON u.id = t."vendedorId"
      LEFT JOIN "LoteriaMultiplier" lm ON lm.id = j."multiplierId"
      ${whereClause}
      AND NOT EXISTS (
        SELECT 1 FROM "sorteo_lista_exclusion" sle
        JOIN "User" u_ex ON u_ex.id = sle.ventana_id
        WHERE sle.sorteo_id = t."sorteoId"
        AND u_ex."ventanaId" = t."ventanaId"
        AND (sle.vendedor_id IS NULL OR sle.vendedor_id = t."vendedorId")
        AND sle.multiplier_id = j."multiplierId"
      )
      GROUP BY business_date, v.name, u.name, l.name, s."scheduledAt", lm.name, lm."valueX", lm.kind
      ORDER BY business_date DESC, l.name ASC, s."scheduledAt" ASC
    `;

    // Transformar resultado
    return result.map((row) => {
      // Determinar nombre del multiplicador
      let multiplierName: string;
      if (!row.multiplier_name) {
        multiplierName = 'REVENTADO';
      } else if (row.multiplier_name === 'Base' && row.multiplier_kind === 'NUMERO' && row.multiplier_value_x) {
        multiplierName = `Base ${row.multiplier_value_x}x`;
      } else {
        multiplierName = row.multiplier_name;
      }

      // Usar comisión apropiada según dimensión
      const commission =
        filters.dimension === 'ventana'
          ? Number(row.listero_commission_amount || 0)
          : Number(row.commission_amount || 0);

      const commissionPercent = row.total_sales > 0 ? (commission / row.total_sales) * 100 : 0;

      return {
        date: row.business_date.toISOString().split('T')[0],
        ventanaName: row.ventana_name || undefined,
        vendedorName: row.vendedor_name || undefined,
        loteriaName: row.loteria_name,
        sorteoTime: row.sorteo_time,
        multiplierName,
        totalSales: row.total_sales,
        commission,
        commissionPercent,
        ticketsCount: parseInt(row.tickets_count, 10),
      };
    });
  }

  /**
   * Detecta advertencias en los datos de comisiones
   */
  private static async detectWarnings(
    fromDateStr: string,
    toDateStr: string,
    filters: {
      scope: string;
      dimension: string;
      ventanaId?: string;
      vendedorId?: string;
      bancaId?: string;
    }
  ): Promise<CommissionWarning[]> {
    const warnings: CommissionWarning[] = [];

    // Detectar exclusiones activas
    const exclusionesActivas = await prisma.$queryRaw<
      Array<{ sorteo_name: string; ventana_name: string; multiplier_name: string | null }>
    >`
      SELECT DISTINCT
        s.name as sorteo_name,
        v.name as ventana_name,
        lm.name as multiplier_name
      FROM "sorteo_lista_exclusion" sle
      INNER JOIN "Sorteo" s ON s.id = sle.sorteo_id
      INNER JOIN "User" u ON u.id = sle.ventana_id
      INNER JOIN "Ventana" v ON v.id = u."ventanaId"
      LEFT JOIN "LoteriaMultiplier" lm ON lm.id = sle.multiplier_id
      WHERE s."scheduledAt"::date >= ${fromDateStr}::date
        AND s."scheduledAt"::date <= ${toDateStr}::date
        ${filters.ventanaId ? Prisma.sql`AND u."ventanaId" = ${filters.ventanaId}::uuid` : Prisma.empty}
    `;

    for (const row of exclusionesActivas) {
      const multiplierInfo = row.multiplier_name ? ` (multiplicador: ${row.multiplier_name})` : '';
      warnings.push({
        type: 'exclusion',
        description: `Sorteo "${row.sorteo_name}" excluido para listero "${row.ventana_name}"${multiplierInfo}`,
        affectedEntity: row.ventana_name,
        severity: 'medium',
      });
    }

    return warnings;
  }

  /**
   * Obtiene políticas de comisión configuradas para las entidades del reporte
   */
  private static async getPolicies(
    fromDateStr: string,
    toDateStr: string,
    filters: {
      scope: string;
      dimension: string;
      ventanaId?: string;
      vendedorId?: string;
      bancaId?: string;
    }
  ): Promise<CommissionPolicy[]> {
    const policies: CommissionPolicy[] = [];

    if (filters.dimension === 'ventana') {
      // Obtener políticas de ventanas/listeros respetando los filtros
      const whereConditions: string[] = [];

      if (filters.ventanaId) {
        whereConditions.push(`v.id = '${filters.ventanaId}'::uuid`);
      }
      if (filters.bancaId) {
        whereConditions.push(`v."bancaId" = '${filters.bancaId}'::uuid`);
      }

      const whereClause = whereConditions.length > 0
        ? Prisma.raw(`WHERE ${whereConditions.join(' AND ')}`)
        : Prisma.empty;

      const ventanas = await prisma.$queryRaw<
        Array<{
          ventana_id: string;
          ventana_name: string;
          commission_policy_json: any | null;
        }>
      >`
        SELECT
          v.id as ventana_id,
          v.name as ventana_name,
          v."commissionPolicyJson" as commission_policy_json
        FROM "Ventana" v
        ${whereClause}
      `;

      // Obtener datos de loterías para mapear IDs a nombres
      const loterias = await prisma.loteria.findMany({
        select: { id: true, name: true },
      });
      const loteriaMap = new Map(loterias.map(l => [l.id, l.name]));

      for (const ventana of ventanas) {
        const rules: CommissionPolicyRule[] = [];

        if (ventana.commission_policy_json) {
          const policy = typeof ventana.commission_policy_json === 'string'
            ? JSON.parse(ventana.commission_policy_json)
            : ventana.commission_policy_json;

          if (policy?.rules && Array.isArray(policy.rules)) {
            for (const rule of policy.rules) {
              const loteriaName = loteriaMap.get(rule.loteriaId) || 'Desconocida';
              const multiplierRange = rule.multiplierRange
                ? `${rule.multiplierRange.min}-${rule.multiplierRange.max}`
                : 'N/A';

              rules.push({
                loteriaName,
                betType: rule.betType,
                multiplierRange,
                percent: rule.percent,
              });
            }
          }
        }

        if (rules.length > 0) {
          policies.push({
            entityId: ventana.ventana_id,
            entityName: ventana.ventana_name,
            rules,
          });
        }
      }
    } else if (filters.dimension === 'vendedor') {
      // Obtener políticas de vendedores respetando los filtros
      let whereClause = Prisma.sql`WHERE u.role = 'VENDEDOR'`;

      if (filters.vendedorId) {
        whereClause = Prisma.sql`${whereClause} AND u.id = ${filters.vendedorId}::uuid`;
      }
      if (filters.ventanaId) {
        whereClause = Prisma.sql`${whereClause} AND u."ventanaId" = ${filters.ventanaId}::uuid`;
      }
      if (filters.bancaId) {
        whereClause = Prisma.sql`${whereClause} AND v."bancaId" = ${filters.bancaId}::uuid`;
      }

      const vendedores = await prisma.$queryRaw<
        Array<{
          vendedor_id: string;
          vendedor_name: string;
          commission_policy_json: any | null;
        }>
      >`
        SELECT
          u.id as vendedor_id,
          u.name as vendedor_name,
          u."commissionPolicyJson" as commission_policy_json
        FROM "User" u
        LEFT JOIN "Ventana" v ON u."ventanaId" = v.id
        ${whereClause}
      `;

      // Obtener datos de loterías
      const loterias = await prisma.loteria.findMany({
        select: { id: true, name: true },
      });
      const loteriaMap = new Map(loterias.map(l => [l.id, l.name]));

      for (const vendedor of vendedores) {
        const rules: CommissionPolicyRule[] = [];

        if (vendedor.commission_policy_json) {
          const policy = typeof vendedor.commission_policy_json === 'string'
            ? JSON.parse(vendedor.commission_policy_json)
            : vendedor.commission_policy_json;

          if (policy?.rules && Array.isArray(policy.rules)) {
            for (const rule of policy.rules) {
              const loteriaName = loteriaMap.get(rule.loteriaId) || 'Desconocida';
              const multiplierRange = rule.multiplierRange
                ? `${rule.multiplierRange.min}-${rule.multiplierRange.max}`
                : 'N/A';

              rules.push({
                loteriaName,
                betType: rule.betType,
                multiplierRange,
                percent: rule.percent,
              });
            }
          }
        }

        if (rules.length > 0) {
          policies.push({
            entityId: vendedor.vendedor_id,
            entityName: vendedor.vendedor_name,
            rules,
          });
        }
      }
    }

    return policies;
  }

  /**
   * Genera nombre de archivo para la exportación
   */
  private static generateFilename(
    format: ExportFormat,
    filters: {
      dimension: string;
      ventanaId?: string;
      vendedorId?: string;
    },
    fromDateStr: string,
    toDateStr: string,
    ventanaName?: string,
    vendedorName?: string
  ): string {
    const ext = format === 'excel' ? 'xlsx' : format;
    const dimension = filters.dimension === 'ventana' ? 'listeros' : 'vendedores';

    // Filtro específico o todos
    let filterStr = 'todos';
    if (filters.ventanaId && ventanaName) {
      filterStr = this.sanitizeFilename(ventanaName);
    } else if (filters.vendedorId && vendedorName) {
      filterStr = this.sanitizeFilename(vendedorName);
    }

    // Período
    let periodStr: string;
    if (fromDateStr === toDateStr) {
      periodStr = fromDateStr;
    } else {
      periodStr = `${fromDateStr}_${toDateStr}`;
    }

    return `comisiones-${dimension}-${filterStr}-${periodStr}.${ext}`;
  }

  /**
   * Sanitiza nombre de archivo (remueve caracteres inválidos)
   */
  private static sanitizeFilename(name: string): string {
    return name
      .replace(/[^a-zA-Z0-9_\-\.]/g, '_')
      .replace(/_+/g, '_')
      .substring(0, 50);
  }
}
