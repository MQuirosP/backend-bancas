/**
 * Accounts Service (Legacy Facade)
 * Este archivo ahora re-exporta la funcionalidad desde el nuevo módulo refactorizado.
 * Mantenido para retrocompatibilidad.
 */

export * from "./accounts/accounts.types";
export * from "./accounts/accounts.service";
export * from "./accounts/accounts.dates.utils"; // Exportar utilidades también por si acaso
