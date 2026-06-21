import { getCRLocalComponents } from "../../../../utils/businessDate";

export const TicketPrintService = {
  extractPrintConfig(settings: any, defaultName: string | null, defaultPhone: string | null) {
    const printSettings = (settings as any)?.print ?? {};
    return {
      printName: printSettings.name ?? defaultName,
      printPhone: printSettings.phone ?? defaultPhone,
      printWidth: printSettings.width ?? null,
      printFooter: printSettings.footer ?? null,
      printBarcode: printSettings.barcode ?? true,
      printBluetoothMacAddress: printSettings.bluetoothMacAddress ?? null,
    };
  },

  formatTime12h(date: Date): string {
    const { hour, minute } = getCRLocalComponents(date);
    const ampm = hour >= 12 ? 'PM' : 'AM';
    let hours12 = hour % 12;
    hours12 = hours12 || 12; // 0 debe ser 12
    const minutesStr = String(minute).padStart(2, '0');
    return `${hours12}:${minutesStr} ${ampm}`;
  },

  formatSorteoNameWithTime(sorteoName: string, scheduledAt: Date): string {
    const timeFormatted = this.formatTime12h(scheduledAt);
    return `${sorteoName} ${timeFormatted}`;
  },

  buildEnrichedResponse(
    ticket: any,
    sorteo: any,
    vendedorToPass: any,
    ventanaWithBanca: any,
    effectiveVendedorId: string,
    ventanaId: string
  ) {
    const sorteoWithFormattedName = {
      ...sorteo,
      name: this.formatSorteoNameWithTime(sorteo.name, sorteo.scheduledAt),
    };

    return {
      ...ticket,
      sorteo: sorteoWithFormattedName,
      loteria: sorteo.loteria
        ? { id: sorteo.loteria.id, name: sorteo.loteria.name }
        : undefined,
      vendedor: {
        id: effectiveVendedorId,
        ...this.extractPrintConfig(
          vendedorToPass?.settings,
          vendedorToPass?.name ?? null,
          vendedorToPass?.phone ?? null
        ),
      },
      ventana: {
        id: ventanaId,
        ...this.extractPrintConfig(
          ventanaWithBanca?.settings,
          ventanaWithBanca?.name ?? null,
          ventanaWithBanca?.phone ?? null
        ),
      },
    };
  }
};
