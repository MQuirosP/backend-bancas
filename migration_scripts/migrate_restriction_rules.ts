
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  console.log('--- INICIANDO BACKFILL DE CORRECCIÓN DE BANCAID ---');

  // 1. Corregir RestrictionRules de Vendedores
  const userRules = await prisma.restrictionRule.findMany({
    where: { userId: { not: null } },
    include: { user: { include: { ventana: true } } }
  });

  console.log(`Analizando ${userRules.length} reglas de usuarios...`);
  let userUpdates = 0;
  for (const rule of userRules) {
    const correctBancaId = rule.user?.ventana?.bancaId;
    if (correctBancaId && rule.bancaId !== correctBancaId) {
      await prisma.restrictionRule.update({
        where: { id: rule.id },
        data: { bancaId: correctBancaId }
      });
      userUpdates++;
    }
  }
  console.log(`Corregidas ${userUpdates} reglas de usuarios que tenían bancaId incorrecto o nulo.`);

  // 2. Corregir RestrictionRules de Ventanas
  const ventanaRules = await prisma.restrictionRule.findMany({
    where: { ventanaId: { not: null } },
    include: { ventana: true }
  });

  console.log(`Analizando ${ventanaRules.length} reglas de ventanas...`);
  let ventanaUpdates = 0;
  for (const rule of ventanaRules) {
    const correctBancaId = rule.ventana?.bancaId;
    if (correctBancaId && rule.bancaId !== correctBancaId) {
      await prisma.restrictionRule.update({
        where: { id: rule.id },
        data: { bancaId: correctBancaId }
      });
      ventanaUpdates++;
    }
  }
  console.log(`Corregidas ${ventanaUpdates} reglas de ventanas.`);

  // 3. Corregir MultiplierOverrides
  const overrides = await prisma.multiplierOverride.findMany({
    include: { user: { include: { ventana: true } }, ventana: true }
  });

  console.log(`Analizando ${overrides.length} multiplier overrides...`);
  let overrideUpdates = 0;
  for (const mo of overrides) {
    const correctBancaId = mo.user?.ventana?.bancaId || mo.ventana?.bancaId;
    if (correctBancaId && mo.bancaId !== correctBancaId) {
      await prisma.multiplierOverride.update({
        where: { id: mo.id },
        data: { bancaId: correctBancaId }
      });
      overrideUpdates++;
    }
  }
  console.log(`Corregidos ${overrideUpdates} multiplier overrides.`);

  console.log('--- BACKFILL COMPLETADO ---');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
