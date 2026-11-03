# 📱 PLAN MAESTRO FASE 2: Client-Side Rendering en Frontend (Web y APK)

**Documento de Arquitectura y Estrategia de Implementación**  
**Proyecto:** Plataforma Bancas (Backend + Web + APK Móvil)  
**Fecha:** 19 de Agosto 2026  
**Objetivo:** Trasladar el 100% de la responsabilidad de renderizado gráfico de sábanas y listas de números hacia los dispositivos de los clientes (navegadores y teléfonos móviles), permitiendo que el backend opere de forma ultraligera en el plan **Starter de 512 MB en Render**.

---

## 1. 🎯 Diagnóstico y Estado Actual del Backend

### Lo que ya está listo en el Backend (Cero cambios de API requeridos):
El backend **ya cuenta con el endpoint JSON completo y optimizado**:
* **Ruta:** `GET /tickets/numbers-summary` (`ticket.controller.ts:460`)
* **Tiempo de respuesta:** **3 ms a 5 ms** (agregación pura en PostgreSQL).
* **Peso del Payload:** **~3 KB a 6 KB** (comprimido gzip).
* **Uso de RAM en Backend:** **0 MB** de Canvas, 0 Worker Threads, 0 buffers binarios temporales.

### Estructura de Datos que ya entrega el Endpoint JSON:
```json
{
  "success": true,
  "data": [
    {
      "number": "00",
      "amountByNumber": 1500,
      "amountByReventado": 500,
      "totalAmount": 2000,
      "ticketCount": 2,
      "ticketsByNumber": 2,
      "ticketsByReventado": 1
    },
    ...
  ],
  "meta": {
    "vendedorName": "Mauren1",
    "vendedorCode": "V001",
    "ventanaName": "CEN Listero",
    "loteriaName": "NICA 7:30 PM",
    "sorteoName": "Nica 7:30 PM",
    "sorteoDate": "2026-08-19T01:30:00.000Z",
    "multiplierName": "REVENTADO 200X",
    "totalAmount": 185000,
    "totalAmountByNumber": 150000,
    "totalAmountByReventado": 35000,
    "totalTickets": 45,
    "totalCommission": 18500,
    "sorteoDigits": 2,
    "maxNumber": 99,
    "numbersWithBets": ["00", "01", "25", "84"]
  }
}
```

---

## 2. 💻 Implementación en el Frontend Web

En el panel web administrativo y de listeros, la descarga de la sábana se realiza directamente en el navegador del usuario utilizando la API nativa de **HTML5 Canvas** o una librería client-side (`html2canvas` / `jspdf`).

### Flujo en Web:
```
Usuario hace clic en "Descargar PNG"
   │
   ├─ 1. fetch('GET /tickets/numbers-summary?sorteoId=...') ──► Backend responde en 3ms (JSON 4KB)
   │
   ├─ 2. Client Canvas Renderer (en el navegador):
   │     - Crea un <canvas width="1200" height="1800"> invisible en memoria.
   │     - Dibuja el encabezado (Usuario, Lotería, Totales) con fuente Courier.
   │     - Dibuja la grilla de 3 columnas (00-99) en 5 milisegundos.
   │
   └─ 3. Descarga / Impresión local:
         - canvas.toBlob() ──► URL.createObjectURL(blob) ──► Descarga instantánea o ventana de impresión.
```

### Código de Ejemplo (Helper Web):
```typescript
export async function renderNumbersSummaryOnClient(summaryData: NumbersSummaryResponse): Promise<Blob> {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  
  canvas.width = 1200;
  canvas.height = 1800;
  
  // Fondo blanco
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  
  // Tipografía y Encabezado
  ctx.fillStyle = '#000000';
  ctx.font = 'bold 24px Courier New';
  ctx.fillText(`Usuario: ${summaryData.meta.vendedorName || 'Usuario'}`, 40, 50);
  ctx.font = '20px Courier New';
  ctx.fillText(`Sorteo: ${summaryData.meta.sorteoName}`, 40, 85);
  ctx.fillText(`TOTAL GENERAL: ¢ ${summaryData.meta.totalAmount.toLocaleString('es-CR')}`, 40, 120);
  
  // Grilla de números (3 columnas)
  const colWidth = 360;
  const rowHeight = 35;
  const startY = 180;
  
  summaryData.data.forEach((item, index) => {
    const col = index % 3;
    const row = Math.floor(index / 3);
    const x = 40 + col * colWidth;
    const y = startY + row * rowHeight;
    
    const text = `${item.number}-${item.amountByNumber.toLocaleString('es-CR')}` + 
                 (item.amountByReventado > 0 ? ` R-${item.amountByReventado.toLocaleString('es-CR')}` : '');
    
    ctx.font = 'bold 22px Courier New';
    ctx.fillText(text, x, y);
  });
  
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob!), 'image/png'));
}
```

---

## 3. 📱 Implementación en la APK Móvil (Flutter / Android)

En los teléfonos de los vendedores, la APK procesa el JSON localmente:

### Casos de Uso en el Teléfono:
1. **Compartir imagen por WhatsApp (Web Share API / Intent de Android):**
   - El teléfono recibe el JSON.
   - Genera la imagen PNG en la memoria local del teléfono usando `CustomPainter` (en Flutter) o `android.graphics.Canvas` (en Android nativo).
   - Dispara el Intent de compartir archivo hacia WhatsApp.
   - **Tiempo de ejecución en el teléfono:** **~15 milisegundos**.
   - **Carga en el servidor backend:** **CERO**.

2. **Impresión Térmica Bluetooth (ESC/POS):**
   - Para impresoras térmicas de 58mm o 80mm, enviar una imagen PNG pesada por Bluetooth suele ser lento.
   - Con el JSON en el teléfono, la APK puede imprimir en **modo texto ESC/POS nativo ultrarrápido** (columnas monoespaciadas), lo que hace que la impresora empiece a imprimir en 0.1 segundos sin trabarse.

---

## 4. ⚖️ Matriz Comparativa: Fase 1 (Redis Backend) vs. Fase 2 (Frontend Rendering)

| Dimensión | Fase 1: Redis JIT en Backend | Fase 2: Renderizado en Frontend (Web/APK) |
|---|---|---|
| **Carga en Backend** | ⬇️ 90% (solo genera 1 vez por huella) | ⬇️ **100%** (Cero uso de Canvas/Worker) |
| **Uso de RAM en Render (512MB)** | Estable en ~75% | **Mínimo absoluto (~60% - 65%)** |
| **Tiempo de Implementación** | **Inmediato (30 minutos)** | **1 a 2 semanas** (Web + Flutter APK + Pruebas) |
| **Dependencia de Actualización de APK** | **Ninguna** (funciona con todas las APKs viejas) | **Alta** (requiere que los vendedores descarguen la nueva APK) |
| **Riesgo Operativo** | **Mínimo** (cambio aislado en backend) | **Medio** (requiere validar múltiples marcas de impresoras Bluetooth) |
| **Compatibilidad con Impresoras POS** | Envía la imagen que ya conocen | Permite imprimir en texto ESC/POS nativo más veloz |

---

## 5. 🗺️ Recomendación Estratégica para el Plan de 512 MB

Dado que el objetivo prioritario es **garantizar estabilidad inmediata con el plan Starter de 512 MB mientras se negocia con nuevos clientes sin asumir costos extras**:

1. **Paso 1 (Inmediato):** Implementar la **Fase 1 (Redis JIT Cache en Backend)**.
   - Te da el blindaje y estabilidad de inmediato en Render sin costo adicional (usando los 240 MB libres de Redis).
   - No arriesga la operación ni exige actualizar APKs en la calle.
2. **Paso 2 (Roadmap siguiente versión APK):** Incorporar en la siguiente versión planificada de la APK y Web el renderizado local del JSON.
   - Conforme se desplieguen nuevas versiones de la app, el backend se irá aliviando al 100% de forma natural.
