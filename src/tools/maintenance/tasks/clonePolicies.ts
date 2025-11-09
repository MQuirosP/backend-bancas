import prisma from "../../../core/prismaClient";
import { ClonePoliciesOptions } from "../types";
import { success, warn } from "../utils/logger";

export async function clonePolicies(options: ClonePoliciesOptions) {
  const source = await prisma.ventana.findUnique({
    where: { id: options.sourceVentanaId },
    select: {
      name: true,
      commissionPolicyJson: true,
      banca: {
        select: {
          id: true,
          commissionPolicyJson: true,
        },
      },
    },
  });

  if (!source) {
    throw new Error(`No se encontró la ventana origen ${options.sourceVentanaId}`);
  }

  if (!source.commissionPolicyJson) {
    warn(`La ventana origen ${source.name} no tiene política definida. Se copiará como null.`);
  }

  const target = await prisma.ventana.findUnique({
    where: { id: options.targetVentanaId },
    select: {
      name: true,
      bancaId: true,
    },
  });

  if (!target) {
    throw new Error(`No se encontró la ventana destino ${options.targetVentanaId}`);
  }

  if (options.dryRun) {
    success(
      `Dry-run: se clonaría la política de ${source.name} -> ${target.name} (includeBanca=${options.includeBanca ?? false})`
    );
    return;
  }

  await prisma.$transaction(async (tx) => {
    await tx.ventana.update({
      where: { id: options.targetVentanaId },
      data: {
        commissionPolicyJson: source.commissionPolicyJson as any,
      },
    });

    if (options.includeBanca && source.banca?.commissionPolicyJson && target.bancaId) {
      await tx.banca.update({
        where: { id: target.bancaId },
        data: {
          commissionPolicyJson: source.banca.commissionPolicyJson as any,
        },
      });
    }
  });

  success(`Política clonada de ${source.name} hacia ${target.name}`);
}


