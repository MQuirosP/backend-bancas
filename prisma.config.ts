// prisma.config.ts
import path from "node:path";
import { defineConfig } from "prisma/config";

// Si NO usas variables de entorno aquí, puedes omitir dotenv.
// import "dotenv/config";

export default defineConfig({
  // Ruta a tu schema. Las rutas se resuelven relativas a ESTE archivo.
  schema: path.join("prisma", "schema.prisma"),
});
