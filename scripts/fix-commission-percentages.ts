/**
 * Fix Script: Commission Percentage Precision
 *
 * This script normalizes all commission percentages to have maximum 2 decimal places.
 * It rounds values to 2 decimals using standard rounding (Math.round).
 *
 * Usage: npx ts-node scripts/fix-commission-percentages.ts
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

interface CommissionPolicy {
  version: number;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  defaultPercent: number;
  rules: Array<{
    id?: string;
    loteriaId: string | null;
    betType: string | null;
    multiplierRange: { min: number; max: number };
    percent: number;
  }>;
}

interface FixResult {
  entity: "Banca" | "Ventana" | "User";
  entityId: string;
  entityName: string;
  changes: number;
}

function normalizePercent(value: number): number {
  // Round to 2 decimal places
  return Math.round(value * 100) / 100;
}

function hasMoreThan2Decimals(value: number): boolean {
  const stringValue = value.toString();
  const decimalPart = stringValue.split(".")[1];
  return decimalPart ? decimalPart.length > 2 : false;
}

async function fixBancas(): Promise<FixResult[]> {
  const results: FixResult[] = [];
  const bancas = await prisma.banca.findMany({
    select: { id: true, name: true, commissionPolicyJson: true },
  });

  for (const banca of bancas) {
    if (!banca.commissionPolicyJson) continue;

    const policy = banca.commissionPolicyJson as unknown as CommissionPolicy;
    let changesMade = 0;

    // Fix defaultPercent
    if (hasMoreThan2Decimals(policy.defaultPercent)) {
      policy.defaultPercent = normalizePercent(policy.defaultPercent);
      changesMade++;
    }

    // Fix rule percents
    if (policy.rules && Array.isArray(policy.rules)) {
      for (const rule of policy.rules) {
        if (hasMoreThan2Decimals(rule.percent)) {
          rule.percent = normalizePercent(rule.percent);
          changesMade++;
        }
      }
    }

    // Update if changes were made
    if (changesMade > 0) {
      await prisma.banca.update({
        where: { id: banca.id },
        data: { commissionPolicyJson: policy },
      });

      results.push({
        entity: "Banca",
        entityId: banca.id,
        entityName: banca.name,
        changes: changesMade,
      });
    }
  }

  return results;
}

async function fixVentanas(): Promise<FixResult[]> {
  const results: FixResult[] = [];
  const ventanas = await prisma.ventana.findMany({
    select: { id: true, name: true, commissionPolicyJson: true },
  });

  for (const ventana of ventanas) {
    if (!ventana.commissionPolicyJson) continue;

    const policy = ventana.commissionPolicyJson as unknown as CommissionPolicy;
    let changesMade = 0;

    // Fix defaultPercent
    if (hasMoreThan2Decimals(policy.defaultPercent)) {
      policy.defaultPercent = normalizePercent(policy.defaultPercent);
      changesMade++;
    }

    // Fix rule percents
    if (policy.rules && Array.isArray(policy.rules)) {
      for (const rule of policy.rules) {
        if (hasMoreThan2Decimals(rule.percent)) {
          rule.percent = normalizePercent(rule.percent);
          changesMade++;
        }
      }
    }

    // Update if changes were made
    if (changesMade > 0) {
      await prisma.ventana.update({
        where: { id: ventana.id },
        data: { commissionPolicyJson: policy },
      });

      results.push({
        entity: "Ventana",
        entityId: ventana.id,
        entityName: ventana.name,
        changes: changesMade,
      });
    }
  }

  return results;
}

async function fixUsers(): Promise<FixResult[]> {
  const results: FixResult[] = [];
  const users = await prisma.user.findMany({
    select: {
      id: true,
      name: true,
      commissionPolicyJson: true,
    },
  });

  for (const user of users) {
    if (!user.commissionPolicyJson) continue;

    const policy = user.commissionPolicyJson as unknown as CommissionPolicy;
    let changesMade = 0;

    // Fix defaultPercent
    if (hasMoreThan2Decimals(policy.defaultPercent)) {
      policy.defaultPercent = normalizePercent(policy.defaultPercent);
      changesMade++;
    }

    // Fix rule percents
    if (policy.rules && Array.isArray(policy.rules)) {
      for (const rule of policy.rules) {
        if (hasMoreThan2Decimals(rule.percent)) {
          rule.percent = normalizePercent(rule.percent);
          changesMade++;
        }
      }
    }

    // Update if changes were made
    if (changesMade > 0) {
      await prisma.user.update({
        where: { id: user.id },
        data: { commissionPolicyJson: policy },
      });

      results.push({
        entity: "User",
        entityId: user.id,
        entityName: user.name,
        changes: changesMade,
      });
    }
  }

  return results;
}

async function main() {
  console.log("🔧 Fixing Commission Percentage Precision...\n");

  try {
    const [bancaResults, ventanaResults, userResults] = await Promise.all([
      fixBancas(),
      fixVentanas(),
      fixUsers(),
    ]);

    const allResults = [...bancaResults, ...ventanaResults, ...userResults];

    if (allResults.length === 0) {
      console.log("✅ No invalid percentages found. Database is already clean.\n");
    } else {
      console.log(`✅ Fixed ${allResults.length} entities:\n`);

      for (const result of allResults) {
        console.log(
          `📍 ${result.entity}: ${result.entityName} (${result.entityId})`
        );
        console.log(`   • ${result.changes} percent(s) normalized\n`);
      }

      const totalChanges = allResults.reduce((sum, r) => sum + r.changes, 0);
      console.log(`✅ Total: ${totalChanges} percentages normalized to 2 decimal places.\n`);
    }
  } catch (error) {
    console.error("❌ Fix failed:", error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
