/**
 * Audit Script: Commission Percentage Precision
 *
 * This script audits all commission policies in the database to identify
 * percentages with more than 2 decimal places.
 *
 * Usage: npx ts-node scripts/audit-commission-percentages.ts
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

interface AuditResult {
  entity: "Banca" | "Ventana" | "User";
  entityId: string;
  entityName: string;
  invalidDefaultPercent?: {
    value: number;
    decimalPlaces: number;
  };
  invalidRulePercents: Array<{
    ruleId?: string;
    loteriaId: string | null;
    betType: string | null;
    percent: number;
    decimalPlaces: number;
  }>;
}

function hasMoreThan2Decimals(value: number): boolean {
  const stringValue = value.toString();
  const decimalPart = stringValue.split(".")[1];
  return decimalPart ? decimalPart.length > 2 : false;
}

function getDecimalPlaces(value: number): number {
  const stringValue = value.toString();
  const decimalPart = stringValue.split(".")[1];
  return decimalPart ? decimalPart.length : 0;
}

async function auditBancas(): Promise<AuditResult[]> {
  const results: AuditResult[] = [];
  const bancas = await prisma.banca.findMany({
    select: { id: true, name: true, commissionPolicyJson: true },
  });

  for (const banca of bancas) {
    if (!banca.commissionPolicyJson) continue;

    const policy = banca.commissionPolicyJson as unknown as CommissionPolicy;
    const invalidRulePercents: AuditResult["invalidRulePercents"] = [];
    let invalidDefaultPercent: AuditResult["invalidDefaultPercent"] | undefined;

    // Check defaultPercent
    if (hasMoreThan2Decimals(policy.defaultPercent)) {
      invalidDefaultPercent = {
        value: policy.defaultPercent,
        decimalPlaces: getDecimalPlaces(policy.defaultPercent),
      };
    }

    // Check rule percents
    if (policy.rules && Array.isArray(policy.rules)) {
      for (const rule of policy.rules) {
        if (hasMoreThan2Decimals(rule.percent)) {
          invalidRulePercents.push({
            ruleId: rule.id,
            loteriaId: rule.loteriaId,
            betType: rule.betType,
            percent: rule.percent,
            decimalPlaces: getDecimalPlaces(rule.percent),
          });
        }
      }
    }

    if (invalidDefaultPercent || invalidRulePercents.length > 0) {
      results.push({
        entity: "Banca",
        entityId: banca.id,
        entityName: banca.name,
        invalidDefaultPercent,
        invalidRulePercents,
      });
    }
  }

  return results;
}

async function auditVentanas(): Promise<AuditResult[]> {
  const results: AuditResult[] = [];
  const ventanas = await prisma.ventana.findMany({
    select: { id: true, name: true, commissionPolicyJson: true },
  });

  for (const ventana of ventanas) {
    if (!ventana.commissionPolicyJson) continue;

    const policy = ventana.commissionPolicyJson as unknown as CommissionPolicy;
    const invalidRulePercents: AuditResult["invalidRulePercents"] = [];
    let invalidDefaultPercent: AuditResult["invalidDefaultPercent"] | undefined;

    // Check defaultPercent
    if (hasMoreThan2Decimals(policy.defaultPercent)) {
      invalidDefaultPercent = {
        value: policy.defaultPercent,
        decimalPlaces: getDecimalPlaces(policy.defaultPercent),
      };
    }

    // Check rule percents
    if (policy.rules && Array.isArray(policy.rules)) {
      for (const rule of policy.rules) {
        if (hasMoreThan2Decimals(rule.percent)) {
          invalidRulePercents.push({
            ruleId: rule.id,
            loteriaId: rule.loteriaId,
            betType: rule.betType,
            percent: rule.percent,
            decimalPlaces: getDecimalPlaces(rule.percent),
          });
        }
      }
    }

    if (invalidDefaultPercent || invalidRulePercents.length > 0) {
      results.push({
        entity: "Ventana",
        entityId: ventana.id,
        entityName: ventana.name,
        invalidDefaultPercent,
        invalidRulePercents,
      });
    }
  }

  return results;
}

async function auditUsers(): Promise<AuditResult[]> {
  const results: AuditResult[] = [];
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
    const invalidRulePercents: AuditResult["invalidRulePercents"] = [];
    let invalidDefaultPercent: AuditResult["invalidDefaultPercent"] | undefined;

    // Check defaultPercent
    if (hasMoreThan2Decimals(policy.defaultPercent)) {
      invalidDefaultPercent = {
        value: policy.defaultPercent,
        decimalPlaces: getDecimalPlaces(policy.defaultPercent),
      };
    }

    // Check rule percents
    if (policy.rules && Array.isArray(policy.rules)) {
      for (const rule of policy.rules) {
        if (hasMoreThan2Decimals(rule.percent)) {
          invalidRulePercents.push({
            ruleId: rule.id,
            loteriaId: rule.loteriaId,
            betType: rule.betType,
            percent: rule.percent,
            decimalPlaces: getDecimalPlaces(rule.percent),
          });
        }
      }
    }

    if (invalidDefaultPercent || invalidRulePercents.length > 0) {
      results.push({
        entity: "User",
        entityId: user.id,
        entityName: user.name,
        invalidDefaultPercent,
        invalidRulePercents,
      });
    }
  }

  return results;
}

async function main() {
  console.log("🔍 Auditing Commission Percentages...\n");

  try {
    const [bancaResults, ventanaResults, userResults] = await Promise.all([
      auditBancas(),
      auditVentanas(),
      auditUsers(),
    ]);

    const allResults = [...bancaResults, ...ventanaResults, ...userResults];

    if (allResults.length === 0) {
      console.log("✅ No invalid commission percentages found!");
      console.log("All percentages have 2 or fewer decimal places.\n");
    } else {
      console.log(`❌ Found ${allResults.length} entities with invalid percentages:\n`);

      for (const result of allResults) {
        console.log(`📍 ${result.entity}: ${result.entityName} (${result.entityId})`);

        if (result.invalidDefaultPercent) {
          console.log(
            `   • defaultPercent: ${result.invalidDefaultPercent.value} (${result.invalidDefaultPercent.decimalPlaces} decimal places)`
          );
        }

        if (result.invalidRulePercents.length > 0) {
          console.log(`   • ${result.invalidRulePercents.length} invalid rule percents:`);
          for (const rule of result.invalidRulePercents) {
            const ruleDesc = [
              rule.loteriaId ? `loteriaId: ${rule.loteriaId}` : null,
              rule.betType ? `betType: ${rule.betType}` : null,
            ]
              .filter(Boolean)
              .join(", ");

            console.log(
              `      - ${rule.percent} (${rule.decimalPlaces} decimal places) [${ruleDesc || "global"}]`
            );
          }
        }

        console.log();
      }

      console.log(
        "⚠️  Please review and fix these invalid percentages before deployment."
      );
      console.log(
        "Use the fix-commission-percentages script to normalize them.\n"
      );
    }
  } catch (error) {
    console.error("❌ Audit failed:", error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
