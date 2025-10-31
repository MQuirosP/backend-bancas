/**
 * UUIDs válidos para usar en tests
 * Generados con crypto.randomUUID()
 */

export const TEST_IDS = {
  // Usuarios
  ADMIN_ID: "eeae221a-abe5-4f51-b148-927b450c551c",
  VENDEDOR_ID: "1d686b42-3a1b-42d1-9417-c229c42cd067",
  VENDEDOR_2_ID: "3f8c5d2a-7b4e-4a1c-9f3e-5d6c7a8b9c0d",
  GERENTE_ID: "4a9b6c3d-8e5f-4b2d-a0f4-6e7d8f9a0b1c",

  // Bancas y Ventanas
  BANCA_ID: "226f0795-ccb2-4780-aa3f-9e328fc8ae46",
  BANCA_2_ID: "5b0c7e4f-9a6d-4c3e-b1f5-7f8e9a0b1c2d",
  VENTANA_ID: "f9643401-acba-43a1-9596-8c4d1d78e774",
  VENTANA_2_ID: "6c1d8f5a-0b7e-4d4f-c2a6-8a9b0c1d2e3f",

  // Loterías
  LOTERIA_ID: "4be00dab-6d99-4c43-8a2b-fb560a81af2f",
  LOTERIA_2_ID: "7d2e9a6b-1c8f-4e5a-d3b7-9b0c1d2e3f4a",

  // Multiplicadores
  BASE_MULTIPLIER_ID: "8c81e1b4-556c-451f-946e-2a7f8dda745f",
  EXTRA_MULTIPLIER_ID: "28142e3a-c2ed-43d1-bc9e-bbb87c0beb1c",
  MULTIPLIER_X3_ID: "9d3f0b7c-2d9a-4f6b-e4c8-0c1d2e3f4a5b",

  // Sorteos
  SORTEO_ID: "2075ca06-45fc-4057-adfa-c5669f3b0d56",
  SORTEO_2_ID: "0e4a1c8d-3f0b-4a7c-f5d9-1d2e3f4a5b6c",
  SORTEO_3_ID: "1f5b2d9e-4a1c-4b8d-a6e0-2e3f4a5b6c7d",

  // Tickets
  TICKET_ID: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
  TICKET_2_ID: "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e",
  TICKET_3_ID: "c3d4e5f6-a7b8-4c9d-0e1f-2a3b4c5d6e7f",
};

/**
 * Generar un UUID válido para tests
 */
export function generateTestUUID(): string {
  return crypto.randomUUID();
}
