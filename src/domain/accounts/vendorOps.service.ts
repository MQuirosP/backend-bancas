import prisma from '../../core/prismaClient';
import { Role, ActivityType } from '../../generated/prisma/client';
import { CacheService } from '../../core/cache.service';
import { invalidateAccountStatementCache } from '../../utils/accountStatementCache';
import { tz } from '../../utils/timezone';
import { crDateService } from '../../utils/crDateService';
import ActivityService from '../../core/activity.service';
import logger from '../../core/logger';
import { AppError } from '../../core/errors';

export interface VendorAuditInfo {
  id: string;
  name: string;
  username: string | null;
  code: string | null;
  isActive: boolean;
  bancaId: string | null;
  ventanaId: string | null;
  bancaName: string | null;
  ventanaName: string | null;
  currentBalance: number;
  lastStatementDate: string | null;
  bancasHistory: Array<{
    bancaId: string;
    bancaName: string;
    statementCount: number;
    lastStatementDate: string | null;
    lastBalance: number;
  }>;
}

export interface TransferVendorParams {
  vendedorId: string;
  targetBancaId: string;
  targetVentanaId: string;
  balanceMode: 'ZERO' | 'CARRY' | 'CUSTOM';
  customBalance?: number;
  resetOriginBalance?: boolean;
  notes?: string;
  performedByUserId?: string;
}

export interface AdjustVendorBalanceParams {
  vendedorId: string;
  bancaId: string;
  targetBalance: number;
  reason?: string;
  performedByUserId?: string;
}

export class VendorOpsService {
  /**
   * Lista bancas activas
   */
  static async listBancas() {
    return prisma.banca.findMany({
      where: { isActive: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
  }

  /**
   * Lista ventanas activas pertenecientes a una banca
   */
  static async listVentanas(bancaId: string) {
    return prisma.ventana.findMany({
      where: { bancaId, isActive: true },
      select: { id: true, name: true, bancaId: true },
      orderBy: { name: 'asc' },
    });
  }
  /**
   * Busca vendedores activos por texto o banca
   */
  static async searchVendors(query?: string, bancaId?: string | null) {
    const where: any = {
      role: Role.VENDEDOR,
      deletedAt: null,
    };

    if (bancaId) {
      where.bancaId = bancaId;
    }

    if (query && query.trim()) {
      const q = query.trim();
      where.OR = [
        { name: { contains: q, mode: 'insensitive' } },
        { username: { contains: q, mode: 'insensitive' } },
        { code: { contains: q, mode: 'insensitive' } },
      ];
    }

    const vendors = await prisma.user.findMany({
      where,
      select: {
        id: true,
        name: true,
        username: true,
        code: true,
        isActive: true,
        bancaId: true,
        ventanaId: true,
        banca: { select: { id: true, name: true } },
        ventana: { select: { id: true, name: true } },
      },
      orderBy: { name: 'asc' },
      take: 50,
    });

    return vendors;
  }

  /**
   * Obtiene la auditoría completa de un vendedor: banca actual, saldo actual e historial en otras bancas
   */
  static async getVendorAudit(vendedorId: string): Promise<VendorAuditInfo> {
    const vendor = await prisma.user.findUnique({
      where: { id: vendedorId },
      include: {
        banca: { select: { id: true, name: true } },
        ventana: { select: { id: true, name: true } },
      },
    });

    if (!vendor || vendor.role !== Role.VENDEDOR) {
      throw new AppError('Vendedor no encontrado', 404, 'VENDOR_NOT_FOUND');
    }

    // 1. Saldo actual en su banca actual
    let currentBalance = 0;
    let lastStatementDate: string | null = null;

    if (vendor.bancaId) {
      const lastStmt = await prisma.accountStatement.findFirst({
        where: { vendedorId, bancaId: vendor.bancaId },
        orderBy: { date: 'desc' },
        select: { date: true, remainingBalance: true, accumulatedBalance: true },
      });
      if (lastStmt) {
        currentBalance = Number(lastStmt.remainingBalance) || Number(lastStmt.accumulatedBalance) || 0;
        lastStatementDate = crDateService.postgresDateToCRString(lastStmt.date);
      }
    }

    // 2. Historial en todas las bancas donde ha tenido AccountStatement
    const bancaGroups = await prisma.accountStatement.groupBy({
      by: ['bancaId'],
      where: { vendedorId, bancaId: { not: null } },
      _count: { id: true },
    });

    const bancasHistory: VendorAuditInfo['bancasHistory'] = [];

    for (const bg of bancaGroups) {
      if (!bg.bancaId) continue;
      const b = await prisma.banca.findUnique({
        where: { id: bg.bancaId },
        select: { name: true },
      });

      const lastStmtInBanca = await prisma.accountStatement.findFirst({
        where: { vendedorId, bancaId: bg.bancaId },
        orderBy: { date: 'desc' },
        select: { date: true, remainingBalance: true, accumulatedBalance: true },
      });

      const bBal = lastStmtInBanca
        ? (Number(lastStmtInBanca.remainingBalance) || Number(lastStmtInBanca.accumulatedBalance) || 0)
        : 0;

      bancasHistory.push({
        bancaId: bg.bancaId,
        bancaName: b?.name || `Banca ${bg.bancaId.slice(0, 8)}`,
        statementCount: bg._count.id,
        lastStatementDate: lastStmtInBanca ? crDateService.postgresDateToCRString(lastStmtInBanca.date) : null,
        lastBalance: bBal,
      });
    }

    return {
      id: vendor.id,
      name: vendor.name,
      username: vendor.username,
      code: vendor.code,
      isActive: vendor.isActive,
      bancaId: vendor.bancaId,
      ventanaId: vendor.ventanaId,
      bancaName: vendor.banca?.name || null,
      ventanaName: vendor.ventana?.name || null,
      currentBalance,
      lastStatementDate,
      bancasHistory,
    };
  }

  /**
   * Ejecuta el traslado de un vendedor de una banca a otra con gestión controlada de saldos
   */
  static async transferVendor(params: TransferVendorParams) {
    const { vendedorId, targetBancaId, targetVentanaId, balanceMode, customBalance, resetOriginBalance, notes, performedByUserId } = params;

    const vendor = await prisma.user.findUnique({
      where: { id: vendedorId },
      include: {
        banca: { select: { id: true, name: true } },
        ventana: { select: { id: true, name: true } },
      },
    });

    if (!vendor || vendor.role !== Role.VENDEDOR) {
      throw new AppError('Vendedor no encontrado o no tiene rol VENDEDOR', 404, 'VENDOR_NOT_FOUND');
    }

    const originBancaId = vendor.bancaId;
    const originBancaName = vendor.banca?.name || 'Ninguna';
    const originVentanaId = vendor.ventanaId;

    // Validar banca y ventana destino
    const targetBanca = await prisma.banca.findUnique({ where: { id: targetBancaId }, select: { id: true, name: true } });
    if (!targetBanca) throw new AppError('Banca destino no encontrada', 404, 'TARGET_BANCA_NOT_FOUND');

    const targetVentana = await prisma.ventana.findUnique({ where: { id: targetVentanaId }, select: { id: true, name: true, bancaId: true } });
    if (!targetVentana) throw new AppError('Ventana/Listero destino no encontrado', 404, 'TARGET_VENTANA_NOT_FOUND');
    if (targetVentana.bancaId !== targetBancaId) {
      throw new AppError('La ventana seleccionada no pertenece a la banca destino', 400, 'VENTANA_BANCA_MISMATCH');
    }

    // Calcular saldo actual en banca origen
    let originBalance = 0;
    let lastOriginStmt: any = null;
    if (originBancaId) {
      lastOriginStmt = await prisma.accountStatement.findFirst({
        where: { vendedorId, bancaId: originBancaId },
        orderBy: { date: 'desc' },
        select: { id: true, month: true, remainingBalance: true, accumulatedBalance: true },
      });
      if (lastOriginStmt) {
        originBalance = Number(lastOriginStmt.remainingBalance) || Number(lastOriginStmt.accumulatedBalance) || 0;
      }
    }

    // Determinar saldo objetivo en la banca destino
    let targetInitialBalance = 0;
    if (balanceMode === 'ZERO') {
      targetInitialBalance = 0;
    } else if (balanceMode === 'CARRY') {
      targetInitialBalance = originBalance;
    } else if (balanceMode === 'CUSTOM') {
      targetInitialBalance = typeof customBalance === 'number' ? customBalance : 0;
    }

    // 1. Actualizar User con la nueva banca y ventana
    await prisma.user.update({
      where: { id: vendedorId },
      data: {
        bancaId: targetBancaId,
        ventanaId: targetVentanaId,
      },
    });

    // 2. Gestionar la posición contable en la banca destino
    const lastTargetStmt = await prisma.accountStatement.findFirst({
      where: { vendedorId, bancaId: targetBancaId },
      orderBy: { date: 'desc' },
    });

    if (lastTargetStmt) {
      // Si ya tenía historial previo en la banca destino, actualizar el último statement a targetInitialBalance
      await prisma.accountStatement.update({
        where: { id: lastTargetStmt.id },
        data: {
          remainingBalance: targetInitialBalance,
          accumulatedBalance: targetInitialBalance,
          canEdit: true,
        },
      });

      // Si existe un MonthlyClosingBalance para ese mes en esa banca, ajustarlo también
      const targetMonth = lastTargetStmt.month;
      await prisma.monthlyClosingBalance.updateMany({
        where: {
          vendedorId,
          bancaId: targetBancaId,
          closingMonth: targetMonth,
        },
        data: {
          closingBalance: targetInitialBalance,
        },
      });
    } else if (targetInitialBalance !== 0) {
      // Si no existe ningún statement histórico y el saldo inicial no es cero, crear un statement de transición
      // Buscando una fecha sin colisión con @@unique([date, vendedorId])
      let targetDate = new Date();
      targetDate.setUTCDate(targetDate.getUTCDate() - 1);
      for (let i = 0; i < 365; i++) {
        const dateOnly = new Date(targetDate.toISOString().slice(0, 10) + 'T00:00:00Z');
        const collision = await prisma.accountStatement.findFirst({
          where: { date: dateOnly, vendedorId },
          select: { id: true },
        });
        if (!collision) {
          targetDate = dateOnly;
          break;
        }
        targetDate.setUTCDate(targetDate.getUTCDate() - 1);
      }
      const monthStr = targetDate.toISOString().slice(0, 7);

      await prisma.accountStatement.create({
        data: {
          date: targetDate,
          month: monthStr,
          bancaId: targetBancaId,
          vendedorId,
          ventanaId: targetVentanaId,
          totalSales: 0,
          totalPayouts: 0,
          listeroCommission: 0,
          vendedorCommission: 0,
          balance: 0,
          totalPaid: 0,
          totalCollected: 0,
          remainingBalance: targetInitialBalance,
          accumulatedBalance: targetInitialBalance,
          isSettled: true,
          canEdit: true,
          ticketCount: 0,
        },
      });
    }

    // 2.1. Opcional: Si se solicitó resetear el saldo en la banca origen para no duplicar deuda
    if (resetOriginBalance && originBancaId && lastOriginStmt) {
      await prisma.accountStatement.update({
        where: { id: lastOriginStmt.id },
        data: {
          remainingBalance: 0,
          accumulatedBalance: 0,
          canEdit: true,
        },
      });
      await prisma.monthlyClosingBalance.updateMany({
        where: {
          vendedorId,
          bancaId: originBancaId,
          closingMonth: lastOriginStmt.month,
        },
        data: {
          closingBalance: 0,
        },
      });
    }

    // 3. Invalidar Cachés exhaustivamente (Regla 14)
    const todayCRStr = tz.toDateStr(new Date());
    const currentMonth = todayCRStr.slice(0, 7);

    // Invalidar tags de entidades
    if (originBancaId) await CacheService.invalidateTag(`banca:${originBancaId}`);
    if (originVentanaId) await CacheService.invalidateTag(`ventana:${originVentanaId}`);
    await CacheService.invalidateTag(`banca:${targetBancaId}`);
    await CacheService.invalidateTag(`ventana:${targetVentanaId}`);
    await CacheService.invalidateTag(`user:${vendedorId}`);

    // Invalidar AccountStatement cache en ambas bancas
    await invalidateAccountStatementCache({
      date: todayCRStr,
      vendedorId,
      bancaId: targetBancaId,
    });

    if (originBancaId) {
      await invalidateAccountStatementCache({
        date: todayCRStr,
        vendedorId,
        bancaId: originBancaId,
      });
    }

    // 4. Log de auditoría
    await ActivityService.log({
      userId: performedByUserId || null,
      bancaId: targetBancaId,
      action: ActivityType.USER_UPDATE,
      targetType: 'USER',
      targetId: vendedorId,
      details: {
        action: 'VENDOR_TRANSFER_OPS',
        vendorName: vendor.name,
        fromBancaId: originBancaId,
        fromBancaName: originBancaName,
        toBancaId: targetBancaId,
        toBancaName: targetBanca.name,
        toVentanaId: targetVentanaId,
        toVentanaName: targetVentana.name,
        balanceMode,
        resetOriginBalance: Boolean(resetOriginBalance),
        originBalance,
        targetInitialBalance,
        notes: notes || null,
      },
      layer: 'service',
    });

    return {
      success: true,
      vendorName: vendor.name,
      originBanca: originBancaName,
      targetBanca: targetBanca.name,
      targetVentana: targetVentana.name,
      originBalance,
      targetInitialBalance,
      balanceMode,
      resetOriginBalance: Boolean(resetOriginBalance),
    };
  }

  /**
   * Ajusta o corrige directamente el saldo inicial de un vendedor en una banca específica
   */
  static async adjustBalance(params: AdjustVendorBalanceParams) {
    const { vendedorId, bancaId, targetBalance, reason, performedByUserId } = params;

    const vendor = await prisma.user.findUnique({
      where: { id: vendedorId },
      select: { id: true, name: true },
    });
    if (!vendor) throw new AppError('Vendedor no encontrado', 404, 'VENDOR_NOT_FOUND');

    const banca = await prisma.banca.findUnique({
      where: { id: bancaId },
      select: { id: true, name: true },
    });
    if (!banca) throw new AppError('Banca no encontrada', 404, 'BANCA_NOT_FOUND');

    // Buscar el último statement del vendedor en esa banca
    const lastStmt = await prisma.accountStatement.findFirst({
      where: { vendedorId, bancaId },
      orderBy: { date: 'desc' },
    });

    let previousBalance = 0;

    if (lastStmt) {
      previousBalance = Number(lastStmt.remainingBalance) || Number(lastStmt.accumulatedBalance) || 0;
      await prisma.accountStatement.update({
        where: { id: lastStmt.id },
        data: {
          remainingBalance: targetBalance,
          accumulatedBalance: targetBalance,
          canEdit: true,
        },
      });

      // Actualizar también cierre mensual si existe
      await prisma.monthlyClosingBalance.updateMany({
        where: {
          vendedorId,
          bancaId,
          closingMonth: lastStmt.month,
        },
        data: {
          closingBalance: targetBalance,
        },
      });
    } else {
      // Si no existe ningún statement histórico en esa banca, crear statement inicial de transición
      // Buscando una fecha sin colisión con @@unique([date, vendedorId])
      let targetDate = new Date();
      targetDate.setUTCDate(targetDate.getUTCDate() - 1);
      for (let i = 0; i < 365; i++) {
        const dateOnly = new Date(targetDate.toISOString().slice(0, 10) + 'T00:00:00Z');
        const collision = await prisma.accountStatement.findFirst({
          where: { date: dateOnly, vendedorId },
          select: { id: true },
        });
        if (!collision) {
          targetDate = dateOnly;
          break;
        }
        targetDate.setUTCDate(targetDate.getUTCDate() - 1);
      }
      const monthStr = targetDate.toISOString().slice(0, 7);

      await prisma.accountStatement.create({
        data: {
          date: targetDate,
          month: monthStr,
          bancaId,
          vendedorId,
          ventanaId: null,
          totalSales: 0,
          totalPayouts: 0,
          listeroCommission: 0,
          vendedorCommission: 0,
          balance: 0,
          totalPaid: 0,
          totalCollected: 0,
          remainingBalance: targetBalance,
          accumulatedBalance: targetBalance,
          isSettled: true,
          canEdit: true,
          ticketCount: 0,
        },
      });
    }

    // Invalidar cachés
    const todayCRStr = tz.toDateStr(new Date());
    const currentMonth = todayCRStr.slice(0, 7);

    await CacheService.invalidateTag(`banca:${bancaId}`);
    await CacheService.invalidateTag(`user:${vendedorId}`);
    await invalidateAccountStatementCache({
      date: todayCRStr,
      vendedorId,
      bancaId,
    });

    // Log de auditoría
    await ActivityService.log({
      userId: performedByUserId || null,
      bancaId,
      action: ActivityType.USER_UPDATE,
      targetType: 'USER',
      targetId: vendedorId,
      details: {
        action: 'VENDOR_BALANCE_ADJUST_OPS',
        vendorName: vendor.name,
        bancaId,
        bancaName: banca.name,
        previousBalance,
        targetBalance,
        reason: reason || null,
      },
      layer: 'service',
    });

    return {
      success: true,
      vendorName: vendor.name,
      bancaName: banca.name,
      previousBalance,
      targetBalance,
    };
  }
}
