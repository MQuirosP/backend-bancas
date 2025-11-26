import prisma from "../../core/prismaClient";
import { writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { parseArgs, requireFlag, optionalFlag, flagAsBoolean } from "./utils/argParser";
import { parseDateRange } from "./utils/dateRange";
import { clonePolicies } from "./tasks/clonePolicies";
import { processTickets } from "./tasks/processTickets";
import { reapplyCommissions } from "./tasks/reapplyCommissions";
import { purgeTickets } from "./tasks/purgeTickets";
import { backfillSorteoClosed } from "./tasks/backfillSorteoClosed";
import { info, error, success, warn } from "./utils/logger";

async function main() {
  const { command, flags } = parseArgs(process.argv);
  const task = command ?? "help";

  try {
    switch (task) {
      case "clone-policies":
        await handleClonePolicies(flags);
        break;
      case "recalc-commissions":
        await handleRecalc(flags);
        break;
      case "normalize-multipliers":
        await handleNormalize(flags);
        break;
      case "purge-tickets":
        await handlePurge(flags);
        break;
      case "reapply-commissions":
        await handleReapply(flags);
        break;
      case "backfill-sorteo-closed":
        await handleBackfillSorteoClosed(flags);
        break;
      case "help":
      default:
        printHelp();
        break;
    }
  } catch (err) {
    error((err as Error).message);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

function printHelp() {
  console.log(`
Uso: ts-node src/tools/maintenance/index.ts <comando> [opciones]

Comandos disponibles:
  clone-policies           Clona la política de comisión de una ventana a otra
    --source-ventana <id>
    --target-ventana <id>
    [--include-banca]
    [--dry-run]

  recalc-commissions       Normaliza multipliers y recalcula comisiones
    --from YYYY-MM-DD
    --to YYYY-MM-DD
    [--ventana <id>]
    [--normalize] (normaliza multipliers antes de recalcular)
    [--dry-run]

  normalize-multipliers    Solo normaliza los multipliers (sin recalcular comisión)
    --from YYYY-MM-DD
    --to YYYY-MM-DD
    [--ventana <id>]
    [--dry-run]

  purge-tickets            Elimina tickets/jugadas anteriores o iguales a una fecha
    --before YYYY-MM-DD
    [--dry-run]

  reapply-commissions      Recalcula snapshots de comisión usando políticas actuales
    --from YYYY-MM-DD
    --to YYYY-MM-DD
    [--ventana <id>]
    [--dry-run]

  backfill-sorteo-closed   Marca tickets de sorteos CLOSED como isSorteoClosed
    [--dry-run]
    [--limit N] (procesar máximo N sorteos, para testing)
`);
}

async function handleClonePolicies(flags: Record<string, string | boolean>) {
  const sourceVentanaId = requireFlag(flags, "source-ventana");
  const targetVentanaId = requireFlag(flags, "target-ventana");
  const includeBanca = flagAsBoolean(flags, "include-banca");
  const dryRun = flagAsBoolean(flags, "dry-run");

  info(
    `Clonando políticas de ${sourceVentanaId} -> ${targetVentanaId} (includeBanca=${includeBanca}, dryRun=${dryRun})`
  );
  await clonePolicies({
    sourceVentanaId,
    targetVentanaId,
    includeBanca,
    dryRun,
  });
}

async function handleRecalc(flags: Record<string, string | boolean>) {
  const from = requireFlag(flags, "from");
  const to = requireFlag(flags, "to");
  const ventanaId = optionalFlag(flags, "ventana");
  const normalize = flagAsBoolean(flags, "normalize");
  const dryRun = flagAsBoolean(flags, "dry-run");

  const range = parseDateRange(from, to);
  info(
    `Procesando tickets ${range.from.toISOString()} - ${range.to.toISOString()} (ventana=${ventanaId ?? "todas"}, normalize=${normalize}, dryRun=${dryRun})`
  );

  await processTickets({
    from: range.from,
    to: range.to,
    ventanaId,
    normalizeMultipliers: normalize,
    recalcCommissions: true,
    dryRun,
  });
}

async function handleNormalize(flags: Record<string, string | boolean>) {
  const from = requireFlag(flags, "from");
  const to = requireFlag(flags, "to");
  const ventanaId = optionalFlag(flags, "ventana");
  const dryRun = flagAsBoolean(flags, "dry-run");

  const range = parseDateRange(from, to);
  info(
    `Normalizando multipliers ${range.from.toISOString()} - ${range.to.toISOString()} (ventana=${ventanaId ?? "todas"}, dryRun=${dryRun})`
  );

  await processTickets({
    from: range.from,
    to: range.to,
    ventanaId,
    normalizeMultipliers: true,
    recalcCommissions: false,
    dryRun,
  });
}

async function handlePurge(flags: Record<string, string | boolean>) {
  const before = requireFlag(flags, "before");
  const dryRun = flagAsBoolean(flags, "dry-run");

  info(`Purgando tickets con fecha <= ${before} (dryRun=${dryRun})`);
  const outcome = await purgeTickets({ beforeDate: before, dryRun });

  const reportPath = join(process.cwd(), "debug", `purge-tickets-${before}.json`);
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify(outcome, null, 2));
  success(`Reporte escrito en ${reportPath}`);
}

async function handleReapply(flags: Record<string, string | boolean>) {
  const from = requireFlag(flags, "from");
  const to = requireFlag(flags, "to");
  const ventanaId = optionalFlag(flags, "ventana");
  const dryRun = flagAsBoolean(flags, "dry-run");

  const range = parseDateRange(from, to);
  info(
    `Reaplicando comisiones ${range.from.toISOString()} - ${range.to.toISOString()} (ventana=${ventanaId ?? "todas"}, dryRun=${dryRun})`
  );

  await reapplyCommissions({
    from: range.from,
    to: range.to,
    ventanaId,
    dryRun,
  });
}

async function handleBackfillSorteoClosed(flags: Record<string, string | boolean>) {
  const dryRun = flagAsBoolean(flags, "dry-run");
  const limitStr = optionalFlag(flags, "limit");
  const limit = limitStr ? parseInt(limitStr, 10) : undefined;

  await backfillSorteoClosed({ dryRun, limit });
}

main().catch((err) => {
  error((err as Error).message);
  process.exitCode = 1;
});


