import prisma from '../src/core/prismaClient';
import { Role, Prisma } from '@prisma/client';

async function main() {
  console.log('🚀 Iniciando proceso de clonado de loterías y multiplicadores para Multi-Tenant...');

  // 1. Obtener todas las bancas activas
  const bancas = await prisma.banca.findMany({
    where: { isActive: true },
  });
  console.log(`✅ Se encontraron ${bancas.length} bancas activas.`);

  // 2. Obtener loterías globales (sin bancaId)
  const globalLoterias = await prisma.loteria.findMany({
    where: { bancaId: null },
    include: { multipliers: true }
  });
  console.log(`✅ Se encontraron ${globalLoterias.length} loterías globales.`);

  // Mapa para guardar: { [oldLoteriaId_bancaId]: newLoteriaId }
  const loteriaMapping: Record<string, string> = {};

  // 3. Empezar el clonado por banca
  for (const banca of bancas) {
    console.log(`\n--- Procesando Banca: ${banca.name} (${banca.id}) ---`);

    for (const globalLoteria of globalLoterias) {
      const existing = await prisma.loteria.findFirst({
        where: { name: globalLoteria.name, bancaId: banca.id }
      });

      let newLoteriaId: string;

      if (existing) {
        console.log(`  - Lotería "${globalLoteria.name}" ya existe para esta banca. Saltando creación.`);
        newLoteriaId = existing.id;
      } else {
        const clonedLoteria: any = await prisma.loteria.create({
          data: {
            name: globalLoteria.name,
            rulesJson: globalLoteria.rulesJson as any,
            isActive: globalLoteria.isActive,
            bancaId: banca.id, 
          }
        });
        console.log(`  + Lotería "${globalLoteria.name}" clonada (ID: ${clonedLoteria.id})`);
        newLoteriaId = clonedLoteria.id;

        for (const m of globalLoteria.multipliers) {
          await prisma.loteriaMultiplier.create({
            data: {
              name: m.name,
              valueX: m.valueX,
              kind: m.kind,
              isActive: m.isActive,
              loteriaId: newLoteriaId,
              bancaId: banca.id,
            }
          });
        }
        console.log(`    - ${globalLoteria.multipliers.length} multiplicadores clonados.`);
      }

      loteriaMapping[`${globalLoteria.id}_${banca.id}`] = newLoteriaId;
    }
  }

  // 4. Actualizar políticas de comisiones en Usuarios (Vendedores)
  console.log('\n🔄 Actualizando políticas de comisiones en Usuarios...');
  const users = await prisma.user.findMany({
    where: { 
      role: Role.VENDEDOR, 
      commissionPolicyJson: { not: Prisma.DbNull },
      bancaId: { not: null }
    }
  });

  let usersUpdatedCountCount = 0;
  for (const user of users) {
    const policy = user.commissionPolicyJson as any;
    if (!policy || !policy.rules || !Array.isArray(policy.rules)) continue;

    let modified = false;
    for (const rule of policy.rules) {
      const mappingKey = `${rule.loteriaId}_${user.bancaId}`;
      if (loteriaMapping[mappingKey]) {
        rule.loteriaId = loteriaMapping[mappingKey];
        modified = true;
      }
    }

    if (modified) {
      await prisma.user.update({
        where: { id: user.id },
        data: { commissionPolicyJson: policy }
      });
      usersUpdatedCountCount++;
    }
  }
  console.log(`✅ Se actualizaron ${usersUpdatedCountCount} políticas de vendedores.`);

  // 5. Actualizar políticas de comisiones en Ventanas
  console.log('\n🔄 Actualizando políticas de comisiones en Ventanas...');
  const ventanas = await prisma.ventana.findMany({
    where: { 
      commissionPolicyJson: { not: Prisma.DbNull },
    }
  });

  let ventanasUpdatedCountCount = 0;
  for (const v of ventanas) {
    const policy = v.commissionPolicyJson as any;
    if (!policy || !policy.rules || !Array.isArray(policy.rules)) continue;

    let modified = false;
    for (const rule of policy.rules) {
      const mappingKey = `${rule.loteriaId}_${v.bancaId}`;
      if (loteriaMapping[mappingKey]) {
        rule.loteriaId = loteriaMapping[mappingKey];
        modified = true;
      }
    }

    if (modified) {
      await prisma.ventana.update({
        where: { id: v.id },
        data: { commissionPolicyJson: policy }
      });
      ventanasUpdatedCountCount++;
    }
  }
  console.log(`✅ Se actualizaron ${ventanasUpdatedCountCount} políticas de ventanas.`);

  // 6. Bootstrap de Sorteos para HOY basado en los de AYER
  console.log('\n🔄 Generando sorteos de "arranque" para HOY basados en los de ayer...');
  
  try {
    const bootstrapRes = await prisma.$executeRawUnsafe(`
      INSERT INTO "Sorteo" (
        id, "bancaId", "loteriaId", "scheduledAt", status, "isActive", 
        "createdAt", "updatedAt", name, digits
      )
      SELECT 
        gen_random_uuid(), b.id, l_new.id, 
        (s."scheduledAt" + interval '1 day'), 'OPEN', true, 
        now(), now(), s.name, s.digits
      FROM "Sorteo" s
      JOIN "Loteria" l_global ON s."loteriaId" = l_global.id
      JOIN "Banca" b ON b."isActive" = true
      JOIN "Loteria" l_new ON l_new.name = l_global.name AND l_new."bancaId" = b.id
      WHERE s."bancaId" IS NULL 
        AND l_global."bancaId" IS NULL
        -- Ajuste de zona horaria para capturar el día operativo de Costa Rica completo
        AND (s."scheduledAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica')::date = (NOW() AT TIME ZONE 'America/Costa_Rica')::date - 1
        -- Evitar duplicados si ya se corrió el script
        AND NOT EXISTS (
          SELECT 1 FROM "Sorteo" s2 
          WHERE s2."bancaId" = b.id 
            AND s2."loteriaId" = l_new.id 
            AND s2."scheduledAt" = (s."scheduledAt" + interval '1 day')
        );
    `);
    console.log(`  ✅ Sorteos de arranque creados para hoy: ${bootstrapRes}`);

  } catch (error) {
    console.error('❌ Error durante el bootstrap de sorteos:', error);
    throw error;
  }

  console.log('\n✨ Proceso completado exitosamente.');
}

main()

  .catch((e) => {
    console.error('❌ Error durante el proceso:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
