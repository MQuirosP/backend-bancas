import { processTickets } from "./processTickets";
import { TicketRangeOptions } from "../types";

interface ReapplyOptions extends TicketRangeOptions {
  ventanaId?: string;
  dryRun?: boolean;
}

export async function reapplyCommissions({
  from,
  to,
  ventanaId,
  dryRun = false,
}: ReapplyOptions) {
  await processTickets({
    from,
    to,
    ventanaId,
    normalizeMultipliers: false,
    recalcCommissions: true,
    dryRun,
  });
}

