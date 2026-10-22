// src/domain/sorteo/sorteo.service.ts
/**
 * SorteoService Facade
 * 
 * Centraliza y delega las operaciones del dominio Sorteo a servicios especializados:
 * - SorteoCrudService: Operaciones CRUD, catálogos, agrupaciones y consultas de sorteos.
 * - SorteoLifecycleService: Transiciones de ciclo de vida (open, close, forceOpen, reset, etc.).
 * - SorteoEvaluationService: Transacción atómica de evaluación y reversión de sorteos.
 * - SorteoEvaluatedSummaryService: Generación de resúmenes evaluados, balances y métricas para terminales.
 * - SorteoWarmupCoordinatorService: Coordinación de precalentamiento masivo y sincronización de locks en Redis.
 *
 * Mantiene compatibilidad total (CERO breaking changes) con todas las firmas y tipos públicos preexistentes.
 */

import { SorteoCrudService } from "./crud/sorteo-crud.service";
import { SorteoLifecycleService } from "./lifecycle/sorteo-lifecycle.service";
import { SorteoEvaluationService } from "./evaluation/sorteo-evaluation.service";
import { SorteoEvaluatedSummaryService } from "./summary/sorteo-evaluated-summary.service";
import { SorteoWarmupCoordinatorService } from "./evaluation/sorteo-warmup.coordinator";

// Re-exportar tipos, DTOs y utilidades de serialización / caché
export * from "./types/sorteo.types";
export { SorteoCrudService } from "./crud/sorteo-crud.service";
export { SorteoLifecycleService } from "./lifecycle/sorteo-lifecycle.service";
export { SorteoEvaluationService } from "./evaluation/sorteo-evaluation.service";
export { SorteoEvaluatedSummaryService } from "./summary/sorteo-evaluated-summary.service";
export { SorteoWarmupCoordinatorService } from "./evaluation/sorteo-warmup.coordinator";

export const SorteoService = {
  // ==========================================
  // CRUD & Catálogo (SorteoCrudService)
  // ==========================================
  validateSorteoOwnership: SorteoCrudService.validateSorteoOwnership.bind(SorteoCrudService),
  create: SorteoCrudService.create.bind(SorteoCrudService),
  update: SorteoCrudService.update.bind(SorteoCrudService),
  remove: SorteoCrudService.remove.bind(SorteoCrudService),
  restore: SorteoCrudService.restore.bind(SorteoCrudService),
  findById: SorteoCrudService.findById.bind(SorteoCrudService),
  getActiveMultipliers: SorteoCrudService.getActiveMultipliers.bind(SorteoCrudService),
  getCommissionPolicy: SorteoCrudService.getCommissionPolicy.bind(SorteoCrudService),
  shouldShowSorteo: SorteoCrudService.shouldShowSorteo.bind(SorteoCrudService),
  filterSorteosByCommissionPolicy: SorteoCrudService.filterSorteosByCommissionPolicy.bind(SorteoCrudService),
  list: SorteoCrudService.list.bind(SorteoCrudService),
  groupedByLoteriaHour: SorteoCrudService.groupedByLoteriaHour.bind(SorteoCrudService),
  groupedByHour: SorteoCrudService.groupedByHour.bind(SorteoCrudService),

  // ==========================================
  // Ciclo de Vida (SorteoLifecycleService)
  // ==========================================
  setActive: SorteoLifecycleService.setActive.bind(SorteoLifecycleService),
  forceOpen: SorteoLifecycleService.forceOpen.bind(SorteoLifecycleService),
  activateAndOpen: SorteoLifecycleService.activateAndOpen.bind(SorteoLifecycleService),
  resetToScheduled: SorteoLifecycleService.resetToScheduled.bind(SorteoLifecycleService),
  open: SorteoLifecycleService.open.bind(SorteoLifecycleService),
  close: SorteoLifecycleService.close.bind(SorteoLifecycleService),

  // ==========================================
  // Evaluación y Reversión (SorteoEvaluationService)
  // ==========================================
  evaluate: SorteoEvaluationService.evaluate.bind(SorteoEvaluationService),
  revertEvaluation: SorteoEvaluationService.revertEvaluation.bind(SorteoEvaluationService),

  // ==========================================
  // Resumen Evaluado (SorteoEvaluatedSummaryService)
  // ==========================================
  evaluatedSummaryFastPath: SorteoEvaluatedSummaryService.evaluatedSummaryFastPath.bind(SorteoEvaluatedSummaryService),
  evaluatedSummary: SorteoEvaluatedSummaryService.evaluatedSummary.bind(SorteoEvaluatedSummaryService),

  // ==========================================
  // Warmup y Locks en Redis (SorteoWarmupCoordinatorService)
  // ==========================================
  waitForWarmupLockRelease: SorteoWarmupCoordinatorService.waitForWarmupLockRelease.bind(SorteoWarmupCoordinatorService),
  warmupSorteoSummariesBatch: SorteoWarmupCoordinatorService.warmupSorteoSummariesBatch.bind(SorteoWarmupCoordinatorService),
  warmupEvaluatedSummaries: SorteoWarmupCoordinatorService.warmupEvaluatedSummaries.bind(SorteoWarmupCoordinatorService),
};

export default SorteoService;
