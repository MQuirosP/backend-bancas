import dotenv from "dotenv";
dotenv.config();

import prisma from "./src/core/prismaClient";
import { initRedisClient } from "./src/core/redisClient";
import { rehydrateRedisAccumulated } from "./src/repositories/helpers/ticket-restriction.helper";

async function main() {
  const sorteoId = "86fb2d26-f060-449a-953a-66ff0d3fe6b7"; // TICA 12:55
  console.log("Initializing Redis Client...");
  await initRedisClient();
  
  console.log("Starting rehydration for Sorteo TICA 12:55:", sorteoId);
  await rehydrateRedisAccumulated(sorteoId);
  console.log("Rehydration complete!");
  
  // Cerrar conexión
  await prisma.$disconnect();
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
