// src/api/v1/services/accounts-export-excel.service.ts
import ExcelJS from 'exceljs';
import { AccountStatementExportPayload } from '../types/accounts-export.types';

/**
 * Servicio para exportar estados de cuenta a Excel (.xlsx)
 */
export class AccountsExportExcelService {
  /**
   * Genera workbook de Excel
   */
  static async generate(payload: AccountStatementExportPayload): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();

    workbook.creator = 'Sistema de Bancas';
    workbook.created = new Date();
    workbook.modified = new Date();

    // Hoja 1: Resumen por Día
    this.addSummarySheet(workbook, payload);

    // Hoja 2: Desglose por Sorteo (si está incluido)
    if (payload.breakdown && payload.breakdown.length > 0) {
      this.addBreakdownSheet(workbook, payload);
    }

    // Hoja 3: Movimientos (si están incluidos)
    if (payload.movements && payload.movements.length > 0) {
      this.addMovementsSheet(workbook, payload);
    }

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }

  /**
   * Agrega hoja de resumen por día
   */
  private static addSummarySheet(
    workbook: ExcelJS.Workbook,
    payload: AccountStatementExportPayload
  ): void {
    const sheet = workbook.addWorksheet('Resumen por Día');
    const isDimensionVentana = payload.metadata.filters.dimension === 'ventana';

    // Metadata del reporte (primeras filas)
    sheet.addRow(['Estado de Cuenta']).font = { bold: true, size: 14 };
    sheet.addRow(['Generado:', this.formatDateTime(payload.metadata.generatedAt) + ' (GMT-6)']);
    sheet.addRow([
      'Período:',
      `${this.formatDate(payload.metadata.startDate)} - ${this.formatDate(payload.metadata.endDate)}`,
    ]);
    sheet.addRow(['Dimensión:', isDimensionVentana ? 'Listeros' : 'Vendedores']);

    if (payload.metadata.filters.ventanaName) {
      sheet.addRow(['Listero:', payload.metadata.filters.ventanaName]);
    }
    if (payload.metadata.filters.vendedorName) {
      sheet.addRow(['Vendedor:', payload.metadata.filters.vendedorName]);
    }

    sheet.addRow([]); // Fila vacía

    // Encabezados de tabla
    const headerRow = isDimensionVentana
      ? sheet.addRow([
          'Fecha',
          'Listero',
          'Ventas',
          'Premios',
          'Com. Listero',
          'Com. Vendedor',
          'Balance',
          'Pagado',
          'Cobrado',
          'Saldo',
          'Tickets',
        ])
      : sheet.addRow([
          'Fecha',
          'Vendedor',
          'Ventas',
          'Premios',
          'Com. Vendedor',
          'Com. Listero',
          'Balance',
          'Pagado',
          'Cobrado',
          'Saldo',
          'Tickets',
        ]);

    this.styleHeaderRow(headerRow);

    // Datos
    for (const item of payload.statements) {
      const date = this.formatDate(item.date);
      
      // ✅ NUEVO: Detectar si hay agrupación (byVentana o byVendedor presente)
      const hasGrouping = (isDimensionVentana && item.byVentana && item.byVentana.length > 0) ||
                          (!isDimensionVentana && item.byVendedor && item.byVendedor.length > 0);

      if (hasGrouping) {
        // ✅ NUEVO: Fila de total consolidado con "TODOS" y formato destacado
        const totalEntity = 'TODOS';
        
        const totalRow = isDimensionVentana
          ? sheet.addRow([
              date,
              totalEntity,
              item.totalSales,
              item.totalPayouts,
              item.listeroCommission,
              item.vendedorCommission,
              item.balance,
              item.totalPaid,
              item.totalCollected,
              item.remainingBalance,
              item.ticketCount,
            ])
          : sheet.addRow([
              date,
              totalEntity,
              item.totalSales,
              item.totalPayouts,
              item.vendedorCommission,
              item.listeroCommission,
              item.balance,
              item.totalPaid,
              item.totalCollected,
              item.remainingBalance,
              item.ticketCount,
            ]);

        // ✅ NUEVO: Formato destacado para fila de total (negrita, fondo gris claro)
        this.styleTotalRow(totalRow, [3, 4, 5, 6, 7, 8, 9, 10], [11]);

        // ✅ NUEVO: Filas de desglose por entidad con indentación visual
        if (isDimensionVentana && item.byVentana) {
          for (const breakdown of item.byVentana) {
            const breakdownEntity = `  - ${breakdown.ventanaName}`;
            const breakdownRow = sheet.addRow([
              date,
              breakdownEntity,
              breakdown.totalSales,
              breakdown.totalPayouts,
              breakdown.listeroCommission,
              breakdown.vendedorCommission,
              breakdown.balance,
              breakdown.totalPaid || 0,
              breakdown.totalCollected || 0,
              breakdown.remainingBalance,
              breakdown.ticketCount || 0,
            ]);
            this.styleDataRow(breakdownRow, [3, 4, 5, 6, 7, 8, 9, 10], [11]);
          }
        } else if (!isDimensionVentana && item.byVendedor) {
          for (const breakdown of item.byVendedor) {
            const breakdownEntity = `  - ${breakdown.vendedorName}`;
            const breakdownRow = sheet.addRow([
              date,
              breakdownEntity,
              breakdown.totalSales,
              breakdown.totalPayouts,
              breakdown.vendedorCommission,
              breakdown.listeroCommission,
              breakdown.balance,
              breakdown.totalPaid || 0,
              breakdown.totalCollected || 0,
              breakdown.remainingBalance,
              breakdown.ticketCount || 0,
            ]);
            this.styleDataRow(breakdownRow, [3, 4, 5, 6, 7, 8, 9, 10], [11]);
          }
        }
      } else {
        // ✅ Comportamiento normal cuando NO hay agrupación
        const entity = isDimensionVentana
          ? item.ventanaName || '-'
          : item.vendedorName || '-';

        const row = isDimensionVentana
          ? sheet.addRow([
              date,
              entity,
              item.totalSales,
              item.totalPayouts,
              item.listeroCommission,
              item.vendedorCommission,
              item.balance,
              item.totalPaid,
              item.totalCollected,
              item.remainingBalance,
              item.ticketCount,
            ])
          : sheet.addRow([
              date,
              entity,
              item.totalSales,
              item.totalPayouts,
              item.vendedorCommission,
              item.listeroCommission,
              item.balance,
              item.totalPaid,
              item.totalCollected,
              item.remainingBalance,
              item.ticketCount,
            ]);

        this.styleDataRow(row, [3, 4, 5, 6, 7, 8, 9, 10], [11]);
      }
    }

    // Fila de totales del período
    const totalRow = isDimensionVentana
      ? sheet.addRow([
          'TOTAL PERÍODO',
          '-',
          payload.totals.totalSales,
          payload.totals.totalPayouts,
          payload.totals.totalListeroCommission,
          payload.totals.totalVendedorCommission,
          payload.totals.totalBalance,
          payload.totals.totalPaid,
          payload.totals.totalCollected,
          payload.totals.totalRemainingBalance,
          '', // Tickets no se suma en total
        ])
      : sheet.addRow([
          'TOTAL PERÍODO',
          '-',
          payload.totals.totalSales,
          payload.totals.totalPayouts,
          payload.totals.totalVendedorCommission,
          payload.totals.totalListeroCommission,
          payload.totals.totalBalance,
          payload.totals.totalPaid,
          payload.totals.totalCollected,
          payload.totals.totalRemainingBalance,
          '',
        ]);

    this.styleTotalRow(totalRow, [3, 4, 5, 6, 7, 8, 9, 10]);

    // Fila de acumulado del mes (Saldo a Hoy)
    if (payload.monthlyAccumulated) {
      const accRow = isDimensionVentana
        ? sheet.addRow([
            'SALDO A HOY (MES COMPLETO)',
            '-',
            payload.monthlyAccumulated.totalSales,
            payload.monthlyAccumulated.totalPayouts,
            payload.monthlyAccumulated.totalListeroCommission,
            payload.monthlyAccumulated.totalVendedorCommission,
            payload.monthlyAccumulated.totalBalance,
            payload.monthlyAccumulated.totalPaid,
            payload.monthlyAccumulated.totalCollected,
            payload.monthlyAccumulated.totalRemainingBalance,
            '',
          ])
        : sheet.addRow([
            'SALDO A HOY (MES COMPLETO)',
            '-',
            payload.monthlyAccumulated.totalSales,
            payload.monthlyAccumulated.totalPayouts,
            payload.monthlyAccumulated.totalVendedorCommission,
            payload.monthlyAccumulated.totalListeroCommission,
            payload.monthlyAccumulated.totalBalance,
            payload.monthlyAccumulated.totalPaid,
            payload.monthlyAccumulated.totalCollected,
            payload.monthlyAccumulated.totalRemainingBalance,
            '',
          ]);

      this.styleAccumulatedRow(accRow, [3, 4, 5, 6, 7, 8, 9, 10]);
    }

    // Ajustar anchos de columna
    this.autoSizeColumns(sheet);

    // Congelar encabezado
    sheet.views = [{ state: 'frozen', xSplit: 0, ySplit: headerRow.number }];
  }

  /**
   * Agrega hoja de desglose por sorteo
   */
  private static addBreakdownSheet(
    workbook: ExcelJS.Workbook,
    payload: AccountStatementExportPayload
  ): void {
    const sheet = workbook.addWorksheet('Desglose por Sorteo');
    const isDimensionVentana = payload.metadata.filters.dimension === 'ventana';

    // Título
    sheet.addRow(['Desglose por Sorteo']).font = { bold: true, size: 14 };
    sheet.addRow([]); // Fila vacía

    // Encabezados
    const headerRow = isDimensionVentana
      ? sheet.addRow([
          'Fecha',
          'Listero',
          'Lotería',
          'Sorteo',
          'Ventas',
          'Premios',
          'Com. Listero',
          'Com. Vendedor',
          'Balance',
          'Tickets',
        ])
      : sheet.addRow([
          'Fecha',
          'Vendedor',
          'Lotería',
          'Sorteo',
          'Ventas',
          'Premios',
          'Com. Vendedor',
          'Com. Listero',
          'Balance',
          'Tickets',
        ]);

    this.styleHeaderRow(headerRow);

    // ✅ OPTIMIZACIÓN: Agregar todas las filas primero, luego aplicar estilos en batch
    const rows: ExcelJS.Row[] = [];
    for (const item of payload.breakdown || []) {
      const date = this.formatDate(item.date);
      const entity = isDimensionVentana
        ? item.ventanaName || '-'
        : item.vendedorName || '-';

      const row = isDimensionVentana
        ? sheet.addRow([
            date,
            entity,
            item.loteriaName,
            item.sorteoTime,
            item.totalSales,
            item.totalPayouts,
            item.listeroCommission,
            item.vendedorCommission,
            item.balance,
            item.ticketCount,
          ])
        : sheet.addRow([
            date,
            entity,
            item.loteriaName,
            item.sorteoTime,
            item.totalSales,
            item.totalPayouts,
            item.vendedorCommission,
            item.listeroCommission,
            item.balance,
            item.ticketCount,
          ]);

      rows.push(row);
    }

    // Aplicar estilos en batch (más eficiente)
    rows.forEach((row) => {
      this.styleDataRow(row, [5, 6, 7, 8, 9], [10]);
    });

    // Ajustar anchos de columna
    this.autoSizeColumns(sheet);

    // Congelar encabezado
    sheet.views = [{ state: 'frozen', xSplit: 0, ySplit: headerRow.number }];
  }

  /**
   * Agrega hoja de movimientos (pagos/cobros)
   */
  private static addMovementsSheet(
    workbook: ExcelJS.Workbook,
    payload: AccountStatementExportPayload
  ): void {
    const sheet = workbook.addWorksheet('Movimientos');
    const isDimensionVentana = payload.metadata.filters.dimension === 'ventana';

    // Título
    sheet.addRow(['Movimientos de Pago y Cobro']).font = { bold: true, size: 14 };
    sheet.addRow([]); // Fila vacía

    // Encabezados
    const headerRow = isDimensionVentana
      ? sheet.addRow([
          'Fecha Mov.',
          'Fecha Aplicada',
          'Listero',
          'Tipo',
          'Monto',
          'Método',
          'Registrado Por',
          'Estado',
          'Notas',
        ])
      : sheet.addRow([
          'Fecha Mov.',
          'Fecha Aplicada',
          'Vendedor',
          'Tipo',
          'Monto',
          'Método',
          'Registrado Por',
          'Estado',
          'Notas',
        ]);

    this.styleHeaderRow(headerRow);

    // ✅ OPTIMIZACIÓN: Agregar todas las filas primero, luego aplicar estilos en batch
    const rows: ExcelJS.Row[] = [];
    const revertidoRows: ExcelJS.Row[] = [];
    
    for (const item of payload.movements || []) {
      const entity = isDimensionVentana
        ? item.ventanaName || '-'
        : item.vendedorName || '-';

      const row = sheet.addRow([
        this.formatDateTime(item.movementDate),
        this.formatDate(item.statementDate),
        entity,
        item.type,
        item.amount,
        item.method,
        item.registeredBy,
        item.status,
        item.notes || '',
      ]);

      rows.push(row);
      if (item.status === 'REVERTIDO') {
        revertidoRows.push(row);
      }
    }

    // Aplicar estilos en batch (más eficiente)
    rows.forEach((row) => {
      row.alignment = { horizontal: 'left', vertical: 'middle' };
      row.getCell(5).numFmt = '₡#,##0.00';
    });

    // Aplicar estilos especiales para revertidos
    revertidoRows.forEach((row) => {
      row.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFFFCCCC' }, // Rojo claro
      };
      row.font = { italic: true };
    });

    // Ajustar anchos de columna
    this.autoSizeColumns(sheet);

    // Congelar encabezado
    sheet.views = [{ state: 'frozen', xSplit: 0, ySplit: headerRow.number }];
  }

  /**
   * Aplica estilos a la fila de encabezado
   */
  private static styleHeaderRow(row: ExcelJS.Row): void {
    row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    row.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF4472C4' }, // Azul
    };
    row.alignment = { horizontal: 'center', vertical: 'middle' };
    row.height = 20;
  }

  /**
   * Aplica estilos a filas de datos
   */
  private static styleDataRow(
    row: ExcelJS.Row,
    currencyCols: number[],
    integerCols: number[]
  ): void {
    row.alignment = { horizontal: 'left', vertical: 'middle' };

    // Formato de moneda para columnas monetarias
    for (const col of currencyCols) {
      const cell = row.getCell(col);
      if (typeof cell.value === 'number') {
        // ✅ CRÍTICO: Formato con negativos en rojo, paréntesis y signo de menos
        if (cell.value < 0) {
          cell.numFmt = '₡#,##0.00_);[Red](₡#,##0.00)';
          cell.font = { color: { argb: 'FFFF0000' } }; // Rojo
        } else {
          cell.numFmt = '₡#,##0.00';
        }
      }
    }

    // Formato entero para contadores
    for (const col of integerCols) {
      const cell = row.getCell(col);
      if (typeof cell.value === 'number') {
        cell.numFmt = '#,##0';
      }
    }
  }

  /**
   * Aplica estilos a la fila de total
   */
  private static styleTotalRow(row: ExcelJS.Row, currencyCols: number[], integerCols?: number[]): void {
    row.font = { bold: true, size: 12, color: { argb: 'FFFFFFFF' } };
    row.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF203764' }, // Azul oscuro
    };
    row.alignment = { horizontal: 'left', vertical: 'middle' };
    row.height = 22;

    // Formato de moneda
    for (const col of currencyCols) {
      const cell = row.getCell(col);
      if (typeof cell.value === 'number') {
        // ✅ CRÍTICO: Formato con negativos en rojo, paréntesis y signo de menos
        if (cell.value < 0) {
          cell.numFmt = '₡#,##0.00_);[Red](₡#,##0.00)';
          // No cambiar font.color aquí porque ya es blanco por styleTotalRow
        } else {
          cell.numFmt = '₡#,##0.00';
        }
      }
    }
  }

  /**
   * Aplica estilos a la fila de acumulado del mes
   */
  private static styleAccumulatedRow(row: ExcelJS.Row, currencyCols: number[]): void {
    row.font = { bold: true, size: 11, color: { argb: 'FF000000' } }; // Negro
    row.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFD9E1F2' }, // Azul muy claro
    };
    row.alignment = { horizontal: 'left', vertical: 'middle' };
    row.height = 20;

    // Formato de moneda
    for (const col of currencyCols) {
      const cell = row.getCell(col);
      if (typeof cell.value === 'number') {
        // ✅ CRÍTICO: Formato con negativos en rojo, paréntesis y signo de menos
        if (cell.value < 0) {
          cell.numFmt = '₡#,##0.00_);[Red](₡#,##0.00)';
          cell.font = { bold: true, color: { argb: 'FFFF0000' } }; // Rojo
        } else {
          cell.numFmt = '₡#,##0.00';
        }
      }
    }
  }

  /**
   * Ajusta automáticamente el ancho de las columnas
   * ✅ OPTIMIZADO: Limita el número de filas procesadas para mejorar rendimiento
   */
  private static autoSizeColumns(sheet: ExcelJS.Worksheet): void {
    const MAX_ROWS_TO_CHECK = 1000; // Limitar para mejorar rendimiento
    const rowCount = sheet.rowCount;
    const rowsToCheck = Math.min(rowCount, MAX_ROWS_TO_CHECK);

    sheet.columns.forEach((column, index) => {
      let maxLength = 10; // Mínimo

      if (column && column.eachCell) {
        let checked = 0;
        column.eachCell({ includeEmpty: false }, (cell) => {
          if (checked >= rowsToCheck) return;
          const cellValue = cell.value ? cell.value.toString() : '';
          maxLength = Math.max(maxLength, cellValue.length);
          checked++;
        });
      }

      if (column) {
        column.width = Math.min(maxLength + 2, 50); // Máximo 50
      }
    });
  }

  /**
   * Formatea fecha de YYYY-MM-DD a DD/MM/YYYY
   */
  private static formatDate(dateStr: string | Date): string {
    if (dateStr instanceof Date) {
      const year = dateStr.getUTCFullYear();
      const month = String(dateStr.getUTCMonth() + 1).padStart(2, '0');
      const day = String(dateStr.getUTCDate()).padStart(2, '0');
      dateStr = `${year}-${month}-${day}`;
    }
    const [year, month, day] = dateStr.split('-');
    return `${day}/${month}/${year}`;
  }

  /**
   * Formatea fecha y hora
   */
  private static formatDateTime(date: Date): string {
    const d = new Date(date);
    const day = d.getDate().toString().padStart(2, '0');
    const month = (d.getMonth() + 1).toString().padStart(2, '0');
    const year = d.getFullYear();
    const hours = d.getHours().toString().padStart(2, '0');
    const minutes = d.getMinutes().toString().padStart(2, '0');
    return `${day}/${month}/${year} ${hours}:${minutes}`;
  }
}
