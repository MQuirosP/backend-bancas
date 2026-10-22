/**
 * Servicio de Reglas de Alertas del Dashboard
 */

export class DashboardAlertsService {
  /**
   * Genera alertas automáticas basadas en umbrales de negocio
   */
  static generateAlerts(data: any): Array<{
    type: string;
    severity: 'info' | 'warn' | 'crit';
    message: string;
    action: string;
  }> {
    const alerts: Array<{
      type: string;
      severity: 'info' | 'warn' | 'crit';
      message: string;
      action: string;
    }> = [];

    // Constantes de umbrales
    const CXC_THRESHOLD_CRITICAL = 500000; // ₡500k
    const CXC_THRESHOLD_WARNING = 200000; // ₡200k
    const LOW_SALES_THRESHOLD = 10000; // ₡10k
    const EXPOSURE_THRESHOLD_CRITICAL = 100; // 100x
    const EXPOSURE_THRESHOLD_WARNING = 50; // 50x

    // 1. Alerta CxC (Cuentas por Cobrar altas)
    // El formato varía según si data.cxc es por ventana o por vendedor
    const isVendedorDimension = data.cxc?.byVendedor !== undefined;
    
    if (isVendedorDimension) {
      if (data.cxc.totalAmount > CXC_THRESHOLD_CRITICAL) {
        alerts.push({
          type: 'HIGH_CXC',
          severity: 'crit',
          message: `Saldo pendiente total en vendedores alto: ₡${data.cxc.totalAmount.toLocaleString('es-CR')}`,
          action: 'Revisar cobros de vendedores con mayor saldo',
        });
      } else if (data.cxc.totalAmount > CXC_THRESHOLD_WARNING) {
        alerts.push({
          type: 'HIGH_CXC',
          severity: 'warn',
          message: `Saldo pendiente moderado en vendedores: ₡${data.cxc.totalAmount.toLocaleString('es-CR')}`,
          action: 'Monitorear cobros de vendedores',
        });
      }

      // Alerta CxP (Saldo a favor del vendedor - banca debe)
      if (data.cxp?.totalAmount > 0) {
        alerts.push({
          type: 'HIGH_CXP',
          severity: 'info',
          message: `Vendedores con saldo a favor: ₡${data.cxp.totalAmount.toLocaleString('es-CR')}`,
          action: 'Coordinar pagos a vendedores con saldo a favor',
        });
      }
    } else {
      // Dimensión ventana
      if (data.cxc?.totalAmount > CXC_THRESHOLD_CRITICAL) {
        alerts.push({
          type: 'HIGH_CXC',
          severity: 'crit',
          message: `Saldo pendiente alto en ventanas: ₡${data.cxc.totalAmount.toLocaleString('es-CR')}`,
          action: 'Gestionar cobros de ventanas con saldos pendientes',
        });
      } else if (data.cxc?.totalAmount > CXC_THRESHOLD_WARNING) {
        alerts.push({
          type: 'HIGH_CXC',
          severity: 'warn',
          message: `Saldo pendiente moderado en ventanas: ₡${data.cxc.totalAmount.toLocaleString('es-CR')}`,
          action: 'Monitorear pagos de ventanas',
        });
      }

      // Alerta CxP
      if (data.cxp?.totalAmount > 0) {
        alerts.push({
          type: 'HIGH_CXP',
          severity: 'info',
          message: `Ventanas con saldo a favor: ₡${data.cxp.totalAmount.toLocaleString('es-CR')}`,
          action: 'Coordinar pagos a ventanas con saldo a favor',
        });
      }
    }

    // 2. Alerta Ventas Bajas
    if (data.summary?.totalSales < LOW_SALES_THRESHOLD) {
      alerts.push({
        type: 'LOW_SALES',
        severity: 'warn',
        message: `Ventas bajas en el período: ₡${(data.summary?.totalSales || 0).toLocaleString('es-CR')}`,
        action: 'Revisar actividad de vendedores y ventanas',
      });
    }

    // 3. Alerta Exposición Crítica (números con ratio alto)
    if (data.exposure?.topNumbers?.[0]?.ratio > EXPOSURE_THRESHOLD_CRITICAL) {
      alerts.push({
        type: 'CRITICAL_EXPOSURE',
        severity: 'crit',
        message: `Exposición crítica en número ${data.exposure.topNumbers[0].number}: ${data.exposure.topNumbers[0].ratio.toFixed(0)}x ratio de ventas`,
        action: 'Considerar limitar apuestas en este número',
      });
    } else if (data.exposure?.topNumbers?.[0]?.ratio > EXPOSURE_THRESHOLD_WARNING) {
      alerts.push({
        type: 'HIGH_EXPOSURE',
        severity: 'warn',
        message: `Exposición alta en número ${data.exposure.topNumbers[0].number}: ${data.exposure.topNumbers[0].ratio.toFixed(0)}x`,
        action: 'Monitorear ventas en este número',
      });
    }

    return alerts;
  }
}
