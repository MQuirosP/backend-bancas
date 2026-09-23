/**
 * Accounts Service (Legacy Facade)
 * Este archivo ahora re-exporta la funcionalidad desde el nuevo módulo refactorizado.
 * Mantenido para retrocompatibilidad.
 */

export * from "../../../domain/accounts/accounts.types";
export * from "../../../domain/accounts/accounts.service";
export * from "../../../domain/accounts/accounts.dates.utils"; // Exportar utilidades también por si acaso
