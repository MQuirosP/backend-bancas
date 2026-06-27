import { SorteoStatus, Role, ActivityType, Prisma } from "../../../generated/prisma/client";
import prisma from "../../../core/prismaClient";
import { AppError } from "../../../core/errors";
import SorteoRepository from "../../../repositories/sorteo.repository";
import { EvaluateSorteoDTO } from "../dto/sorteo.dto";
import logger from "../../../core/logger";
import { CacheService } from "../../../core/cache.service";
import ActivityService from "../../../core/activity.service";
import { clearSorteoCache } from "../../../utils/sorteoCache";

const EVALUABLE_STATES = new Set<SorteoStatus>([SorteoStatus.OPEN]);

export class SorteoEvaluationCoordinator {
  /**
   * Valida las reglas de negocio previas a la evaluación
   */
  static async validate(
    id: string,
    body: EvaluateSorteoDTO,
    existingSorteo: any,
    bancaId?: string,
    role?: Role
  ) {
    const { winningNumber, extraMultiplierId = null } = body;

    if (!winningNumber?.length) {
      throw new AppError("winningNumber es requerido", 400);
    }

    if (bancaId && !existingSorteo.bancaId && role !== Role.ADMIN) {
      throw new AppError("No tiene permisos para evaluar un sorteo global", 403);
    }

    if (!EVALUABLE_STATES.has(existingSorteo.status)) {
      throw new AppError("Solo se puede evaluar desde OPEN", 409);
    }

    const requiredDigits = existingSorteo.digits ?? 2;
    if (winningNumber.length !== requiredDigits) {
      throw new AppError(
        `El número ganador debe tener ${requiredDigits} dígitos (recibido: ${winningNumber.length})`,
        400
      );
    }

    let extraX = 0;
    let extraOutcomeCode: string | null = null;

    if (extraMultiplierId) {
      const mul = await prisma.loteriaMultiplier.findUnique({
        where: { id: extraMultiplierId },
        select: {
          id: true,
          valueX: true,
          isActive: true,
          loteriaId: true,
          kind: true,
          name: true,
          appliesToSorteoId: true,
        },
      });

      if (!mul || !mul.isActive) {
        throw new AppError("extraMultiplierId inválido o inactivo", 400);
      }
      if (mul.loteriaId !== existingSorteo.loteriaId) {
        throw new AppError("extraMultiplierId no pertenece a la lotería del sorteo", 400);
      }
      if (mul.kind !== "REVENTADO") {
        throw new AppError("extraMultiplierId no es de tipo REVENTADO", 400);
      }
      if (mul.appliesToSorteoId && mul.appliesToSorteoId !== id) {
        throw new AppError("extraMultiplierId no aplica a este sorteo", 400);
      }

      extraX = mul.valueX;
      extraOutcomeCode = (body.extraOutcomeCode ?? mul.name ?? null) || null;
    }

    return { extraX, extraOutcomeCode };
  }

  /**
   * Ejecuta los efectos secundarios post-evaluación en background (asíncronos)
   */
  static triggerPostEvaluation(
    id: string,
    winningNumber: string,
    extraMultiplierId: string | null | undefined,
    existingSorteo: any,
    evaluatedSorteo: any,
    userId: string
  ) {
    // 1. Sincronización de Cuentas (Fire-and-Forget)
    import("./accounts/accounts.sync.service")
      .then(({ AccountStatementSyncService }) => {
        logger.info({
          layer: "coordinator",
          action: "SORTEO_EVALUATE_TRIGGERING_SYNC",
          payload: { sorteoId: id, scheduledAt: existingSorteo.scheduledAt },
        });

        return AccountStatementSyncService.syncSorteoStatements(id, existingSorteo.scheduledAt);
      })
      .then(() => {
        logger.info({
          layer: "coordinator",
          action: "SORTEO_EVALUATE_SYNC_QUEUED_OR_COMPLETED",
          payload: { sorteoId: id },
        });
      })
      .catch((err) => {
        logger.error({
          layer: "coordinator",
          action: "ACCOUNT_STATEMENT_SYNC_BACKGROUND_ERROR",
          payload: { sorteoId: id, error: err.message },
        });
      });

    // 2. Limpieza de Caché
    try {
      clearSorteoCache();
      CacheService.invalidateTag(`sorteo:${id}`).catch(() => {});
    } catch (err: any) {
      logger.error({
        layer: "coordinator",
        action: "CACHE_INVALIDATION_ERROR",
        payload: { sorteoId: id, error: err.message },
      });
    }

    // 3. Registro de Actividad
    ActivityService.log({
      userId,
      bancaId: existingSorteo.bancaId,
      action: ActivityType.SORTEO_EVALUATE,
      targetType: "SORTEO",
      targetId: id,
      details: {
        winningNumber,
        extraMultiplierId,
        hasWinner: (evaluatedSorteo as any)?.hasWinner,
      } as Prisma.InputJsonObject,
    }).catch((err) => {
      logger.error({
        layer: "coordinator",
        action: "ACTIVITY_LOG_ERROR",
        payload: { sorteoId: id, error: err.message },
      });
    });
  }
}
