import { ParsedDateRange } from "../types";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function parseDateRange(from: string, to: string): ParsedDateRange {
  if (!ISO_DATE.test(from) || !ISO_DATE.test(to)) {
    throw new Error("Las fechas deben ir en formato YYYY-MM-DD");
  }

  const fromDate = new Date(`${from}T00:00:00.000Z`);
  const toDate = new Date(`${to}T23:59:59.999Z`);

  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
    throw new Error("Fechas inválidas");
  }

  if (fromDate > toDate) {
    throw new Error("La fecha inicial debe ser menor o igual a la final");
  }

  return { from: fromDate, to: toDate };
}


