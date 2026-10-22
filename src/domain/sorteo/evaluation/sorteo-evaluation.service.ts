import { ActivityType, Prisma, Role, SorteoStatus } from "../../../generated/prisma/client";
import { AppError } from "../../../core/errors";
import logger from "../../../core/logger";
import ActivityService from "../../../core/activity.service";
import SorteoRepository from "../../../repositories/sorteo.repository";
import { CacheService } from "../../../core/cache.service";
import { formatDateCRWithTZ } from "../../../utils/datetime";
import { SorteoEvaluationCoordinator } from "../sorteoEvaluation.coordinator";
import { TenantEvaluationQueue } from "../tenantEvaluation.queue";
import { SorteoCrudService } from "../crud/sorteo-crud.service";
import { EvaluateSorteoDTO, serializeSorteo } from "../types/sorteo.types";

export class SorteoEvaluationService {
  /**
   * Evalúa un sorteo ingresando el número ganador y multiplicador extra
   */
  static async evaluate(
    id: string,
    body: EvaluateSorteoDTO,
    userId: string,
    bancaId?: string,
    role?: Role,
  ) {
    const existing = await SorteoCrudService.validateSorteoOwnership(id, bancaId, role);

    const maxAgeMs = 7 * 24 * 60 * 60 * 1000;
    if (Date.now() - existing.scheduledAt.getTime() > maxAgeMs) {
      throw new AppError("No se puede evaluar un sorteo con más de 7 días de antigüedad. Contacte a soporte técnico.", 409);
    }

    const { extraOutcomeCode } = await SorteoEvaluationCoordinator.validate(
      id,
      body,
      existing,
      bancaId,
      role,
    );

    const targetBancaId = bancaId || existing.bancaId || null;

    return TenantEvaluationQueue.enqueue(targetBancaId, id, async () => {
      const evaluated = await SorteoRepository.evaluate(id, {
        winningNumber: body.winningNumber.trim(),
        extraOutcomeCode,
        extraMultiplierId:
          body.extraMultiplierId &&
          body.extraMultiplierId !== "none" &&
          body.extraMultiplierId !== ""
            ? body.extraMultiplierId
            : null,
      });

      if (!evaluated) throw new AppError("Error al recuperar el sorteo evaluado", 500);

      await SorteoEvaluationCoordinator.triggerPostEvaluation(
        id,
        body.winningNumber.trim(),
        body.extraMultiplierId,
        existing,
        evaluated,
        userId,
        bancaId,
      );

      return serializeSorteo(evaluated);
    });
  }

  /**
   * Revierte la evaluación de un sorteo previamente evaluado
   */
  static async revertEvaluation(
    id: string,
    userId: string,
    reason?: string,
    bancaId?: string,
    role?: Role,
  ) {
    const existing = await SorteoCrudService.validateSorteoOwnership(id, bancaId, role);

    if (bancaId && !existing.bancaId && role !== Role.ADMIN) {
      throw new AppError("No tiene permisos para revertir un sorteo global", 403);
    }
    if (existing.status !== SorteoStatus.EVALUATED) {
      throw new AppError("Solo se puede revertir un sorteo evaluado", 409);
    }

    const maxRevertAgeMs = 7 * 24 * 60 * 60 * 1000;
    if (Date.now() - existing.scheduledAt.getTime() > maxRevertAgeMs) {
      throw new AppError(
        "No se puede revertir un sorteo con más de 7 días de antigüedad. Contacte a soporte técnico para realizar un ajuste contable.",
        409,
      );
    }

    const reverted = await SorteoRepository.revertEvaluation(id);

    (async () => {
      try {
        const { AccountStatementSyncService } = await import("../../accounts/accounts.sync.service");
        await AccountStatementSyncService.syncSorteoStatements(id, existing.scheduledAt);

        const { CierreRollupService } = await import("../../cierre/cierre.rollup.service");
        const { tz } = await import("../../../utils/timezone");
        const sorteoDateStr = existing.scheduledAt ? tz.toDateStr(existing.scheduledAt) : tz.toDateStr();
        const todayCR = tz.toDateStr();
        await CierreRollupService.aggregateRange(
          sorteoDateStr,
          sorteoDateStr < todayCR ? todayCR : sorteoDateStr,
        );

        const { VendorCreditService } = await import("../../credit/vendorCredit.service");
        await VendorCreditService.onSorteoReverted(id).catch(() => {});

        const { clearSorteoCache } = require("../../../utils/sorteoCache");
        clearSorteoCache();
        await CacheService.invalidateTag("sorteos").catch(() => { });
        await CacheService.invalidateTag(`sorteo:${id}`).catch(() => { });
        await CacheService.invalidateTag("dashboard").catch(() => { });
        await CacheService.invalidateTag("cierre").catch(() => { });
        await CacheService.invalidateTag("report:summary").catch(() => { });

        const { SocketService } = await import("../../../core/socket.service");
        SocketService.notifySorteoReverted({
          sorteoId: id,
          sorteoNombre: existing.name || "Sorteo",
          scheduledAt: existing.scheduledAt ? new Date(existing.scheduledAt).toISOString() : new Date().toISOString(),
          bancaId: existing.bancaId || null,
          revertedAt: new Date().toISOString(),
        });
      } catch (err: any) {
        logger.error({
          layer: "service",
          action: "ACCOUNT_STATEMENT_SYNC_REVERT_BACKGROUND_ERROR",
          payload: { sorteoId: id, error: (err as Error).message },
        });
      }
    })();

    const sFormattedAt = formatDateCRWithTZ(existing.scheduledAt);
    const lotName = existing.loteria?.name || "Lotería";
    const sorteoDesc = `${existing.name || "Sorteo"} (${lotName}) del ${sFormattedAt}`;

    await ActivityService.log({
      userId,
      bancaId: existing.bancaId,
      action: ActivityType.SORTEO_REOPEN,
      targetType: "SORTEO",
      targetId: id,
      details: {
        reason: reason ?? null,
        previousWinningNumber: existing.winningNumber,
        previousExtraMultiplierId: existing.extraMultiplierId,
        description: `Evaluación de ${sorteoDesc} REVERTIDA. Razón: ${reason ?? "No especificada"}`,
      },
    });

    return serializeSorteo(reverted);
  }
}
