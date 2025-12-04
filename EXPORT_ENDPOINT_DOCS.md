# 📊 Endpoint de Exportación de Comisiones - Documentación para Frontend

## 🎯 Resumen

Nuevo endpoint implementado para exportar reportes de comisiones en tres formatos: **CSV**, **Excel** y **PDF**.

**URL:** `GET /api/v1/commissions/export`

---

## 📋 Parámetros de Query

### Obligatorios

| Parámetro | Tipo | Valores Posibles | Descripción |
|-----------|------|------------------|-------------|
| `format` | string | `'csv'` \| `'excel'` \| `'pdf'` | **NUEVO**: Formato de exportación |
| `scope` | string | `'all'` \| `'mine'` | Alcance del reporte |
| `dimension` | string | `'ventana'` \| `'vendedor'` | Dimensión del reporte (Listero o Vendedor) |

### Opcionales (Filtros de Fecha)

| Parámetro | Tipo | Valores Posibles | Descripción |
|-----------|------|------------------|-------------|
| `date` | string | `'today'` \| `'yesterday'` \| `'week'` \| `'month'` \| `'year'` \| `'range'` | Token de fecha (default: `'today'`) |
| `fromDate` | string | `YYYY-MM-DD` | Fecha inicio (obligatorio si `date='range'`) |
| `toDate` | string | `YYYY-MM-DD` | Fecha fin (obligatorio si `date='range'`) |

### Opcionales (Filtros de Entidad)

| Parámetro | Tipo | Descripción |
|-----------|------|-------------|
| `ventanaId` | string (UUID) | ID del listero específico (solo si `dimension='ventana'`) |
| `vendedorId` | string (UUID) | ID del vendedor específico (solo si `dimension='vendedor'`) |

### Opcionales (Opciones de Exportación)

| Parámetro | Tipo | Default | Descripción |
|-----------|------|---------|-------------|
| `includeBreakdown` | boolean | `true` | Incluir desglose por lotería/sorteo/multiplicador |
| `includeWarnings` | boolean | `true` | Incluir advertencias (políticas faltantes, exclusiones) |

---

## 📤 Respuesta

### Headers HTTP

```
Content-Type: application/octet-stream | text/csv | application/pdf
Content-Disposition: attachment; filename="comisiones-{detalle}.{ext}"
Content-Length: {tamaño en bytes}
```

### Tipos de Contenido por Formato

- **CSV**: `text/csv; charset=utf-8`
- **Excel**: `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`
- **PDF**: `application/pdf`

### Body

Binary stream del archivo generado.

---

## 🔐 Autenticación y Permisos

- **Requiere JWT**: Sí (header `Authorization: Bearer <token>`)
- **Roles permitidos**: `ADMIN`, `VENTANA`, `VENDEDOR`
- **RBAC**:
  - `ADMIN`: Puede exportar con `scope='all'` o `scope='mine'`
  - `VENTANA`: Solo puede exportar con `scope='mine'` y `dimension='ventana'`
  - `VENDEDOR`: Solo puede exportar con `scope='mine'` y `dimension='vendedor'`

---

## 🚦 Rate Limiting

- **Límite**: 10 exportaciones por minuto por usuario
- **Respuesta si excede**:
  ```json
  {
    "success": false,
    "error": "Demasiadas exportaciones. Por favor espere un momento antes de intentar nuevamente."
  }
  ```
- **Status Code**: `429 Too Many Requests`

---

## 📊 Estructura de Datos Exportados

### CSV y Excel: Hoja "Comisiones" (Resumen)

**Para `dimension='ventana'` (Listeros):**

| Fecha | Listero | Total Ventas | Total Tickets | Comisión Listero | Comisión Vendedor | Ganancia Listero |
|-------|---------|--------------|---------------|------------------|-------------------|------------------|
| 04/12/2025 | Juan Pérez | ₡125,450.00 | 45 | ₡10,036.00 | ₡6,272.50 | ₡3,763.50 |
| 04/12/2025 | María López | ₡98,250.00 | 32 | ₡7,860.00 | ₡4,912.50 | ₡2,947.50 |
| **TOTAL** | **-** | **₡223,700.00** | **77** | **₡17,896.00** | **₡11,185.00** | **₡6,711.00** |

**Para `dimension='vendedor'` (Vendedores):**

| Fecha | Vendedor | Total Ventas | Total Tickets | Comisión Vendedor | Comisión Listero | Ganancia Neta |
|-------|----------|--------------|---------------|-------------------|------------------|---------------|
| 04/12/2025 | Carlos Mora | ₡85,200.00 | 28 | ₡4,260.00 | ₡6,816.00 | ₡78,384.00 |
| **TOTAL** | **-** | **₡85,200.00** | **28** | **₡4,260.00** | **₡6,816.00** | **₡78,384.00** |

### Excel: Hoja "Desglose por Lotería" (si `includeBreakdown=true`)

| Fecha | Listero/Vendedor | Lotería | Sorteo | Multiplicador | Ventas | Comisión | % Comisión | Tickets |
|-------|------------------|---------|--------|---------------|--------|----------|------------|---------|
| 04/12/2025 | Juan Pérez | Nacional | 12:10PM | Base 80x | ₡45,000.00 | ₡3,600.00 | 8.00% | 15 |
| 04/12/2025 | Juan Pérez | Nacional | 12:10PM | Base 85x | ₡30,000.00 | ₡2,550.00 | 8.50% | 10 |
| 04/12/2025 | Juan Pérez | Tiempos | 6:00PM | REVENTADO | ₡25,450.00 | ₡2,036.00 | 8.00% | 8 |

### Excel: Hoja "Advertencias" (si `includeWarnings=true` y existen advertencias)

| Tipo | Descripción | Afecta a | Severidad |
|------|-------------|----------|-----------|
| Política Faltante | El listero "Juan Pérez" no tiene política de comisión configurada | Juan Pérez | HIGH |
| Exclusión | Sorteo "12:10PM" excluido para listero "María López" | María López | MEDIUM |

---

## 📝 Ejemplos de Peticiones

### Ejemplo 1: Exportar CSV de todos los listeros, hoy

```
GET /api/v1/commissions/export?format=csv&scope=all&dimension=ventana&date=today
```

**Respuesta:**
- Archivo: `comisiones-listeros-todos-2025-12-04.csv`
- Content-Type: `text/csv; charset=utf-8`

---

### Ejemplo 2: Exportar Excel de un listero específico, rango personalizado

```
GET /api/v1/commissions/export?format=excel&scope=all&dimension=ventana&ventanaId=abc-123-uuid&date=range&fromDate=2025-12-01&toDate=2025-12-04
```

**Respuesta:**
- Archivo: `comisiones-listeros-Juan_Perez-2025-12-01_2025-12-04.xlsx`
- Content-Type: `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`

---

### Ejemplo 3: Exportar PDF de todos los vendedores, este mes

```
GET /api/v1/commissions/export?format=pdf&scope=all&dimension=vendedor&date=month
```

**Respuesta:**
- Archivo: `comisiones-vendedores-todos-2025-12-01_2025-12-31.pdf`
- Content-Type: `application/pdf`

---

### Ejemplo 4: Exportar sin breakdown ni advertencias

```
GET /api/v1/commissions/export?format=excel&scope=all&dimension=ventana&date=today&includeBreakdown=false&includeWarnings=false
```

**Respuesta:**
- Solo incluye la hoja de resumen principal
- Sin hoja de desglose ni advertencias

---

## 🛠️ Implementación en el Frontend

### Opción 1: Descarga directa con `<a>` tag

```typescript
const handleExport = (format: 'csv' | 'excel' | 'pdf') => {
  // Construir URL con parámetros actuales
  const params = new URLSearchParams({
    format,
    scope: 'all',
    dimension: 'ventana',
    date: 'today',
    // ... otros filtros
  });

  // Crear URL completa
  const url = `${API_BASE_URL}/api/v1/commissions/export?${params.toString()}`;

  // Crear elemento <a> temporal para descarga
  const link = document.createElement('a');
  link.href = url;
  link.setAttribute('download', ''); // Usa el filename del servidor

  // Agregar headers de autenticación
  fetch(url, {
    headers: {
      'Authorization': `Bearer ${getToken()}`,
    },
  })
    .then(response => response.blob())
    .then(blob => {
      const url = window.URL.createObjectURL(blob);
      link.href = url;
      link.click();
      window.URL.revokeObjectURL(url);
    })
    .catch(error => {
      console.error('Error al exportar:', error);
      toast.error('Error al exportar el reporte');
    });
};
```

---

### Opción 2: Descarga con fetch + blob

```typescript
const handleExport = async (format: 'csv' | 'excel' | 'pdf') => {
  try {
    // Mostrar loading
    setIsExporting(true);

    // Construir URL con parámetros
    const params = new URLSearchParams({
      format,
      scope: filters.scope,
      dimension: filters.dimension,
      date: filters.date,
      fromDate: filters.fromDate,
      toDate: filters.toDate,
      ventanaId: filters.ventanaId,
      vendedorId: filters.vendedorId,
      includeBreakdown: 'true',
      includeWarnings: 'true',
    });

    const url = `${API_BASE_URL}/api/v1/commissions/export?${params.toString()}`;

    // Hacer petición con autenticación
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${getToken()}`,
      },
    });

    // Verificar respuesta
    if (!response.ok) {
      if (response.status === 429) {
        throw new Error('Demasiadas exportaciones. Por favor espere un momento.');
      }
      throw new Error('Error al exportar el reporte');
    }

    // Obtener nombre de archivo del header
    const contentDisposition = response.headers.get('Content-Disposition');
    const filenameMatch = contentDisposition?.match(/filename="(.+)"/);
    const filename = filenameMatch ? filenameMatch[1] : `comisiones.${format}`;

    // Convertir a blob y descargar
    const blob = await response.blob();
    const blobUrl = window.URL.createObjectURL(blob);

    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    // Liberar blob URL
    window.URL.revokeObjectURL(blobUrl);

    // Mostrar éxito
    toast.success('Reporte exportado exitosamente');
  } catch (error: any) {
    console.error('Error al exportar:', error);
    toast.error(error.message || 'Error al exportar el reporte');
  } finally {
    setIsExporting(false);
  }
};
```

---

### Opción 3: Usando axios

```typescript
import axios from 'axios';
import { saveAs } from 'file-saver'; // npm install file-saver

const handleExport = async (format: 'csv' | 'excel' | 'pdf') => {
  try {
    setIsExporting(true);

    const response = await axios.get('/api/v1/commissions/export', {
      params: {
        format,
        scope: 'all',
        dimension: 'ventana',
        date: 'today',
        // ... otros filtros
      },
      headers: {
        'Authorization': `Bearer ${getToken()}`,
      },
      responseType: 'blob', // Importante para archivos binarios
    });

    // Obtener filename del header
    const contentDisposition = response.headers['content-disposition'];
    const filenameMatch = contentDisposition?.match(/filename="(.+)"/);
    const filename = filenameMatch ? filenameMatch[1] : `comisiones.${format}`;

    // Descargar usando file-saver
    saveAs(response.data, filename);

    toast.success('Reporte exportado exitosamente');
  } catch (error: any) {
    if (error.response?.status === 429) {
      toast.error('Demasiadas exportaciones. Por favor espere un momento.');
    } else {
      toast.error('Error al exportar el reporte');
    }
  } finally {
    setIsExporting(false);
  }
};
```

---

## 🎨 Componente UI Sugerido

```tsx
import { Download, FileSpreadsheet, FileText, File } from 'lucide-react';

const ExportButton = () => {
  const [isExporting, setIsExporting] = useState(false);
  const [showMenu, setShowMenu] = useState(false);

  const handleExport = async (format: 'csv' | 'excel' | 'pdf') => {
    // ... implementación de exportación
    setShowMenu(false);
  };

  return (
    <div className="relative">
      <button
        onClick={() => setShowMenu(!showMenu)}
        disabled={isExporting}
        className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
      >
        <Download size={16} />
        {isExporting ? 'Exportando...' : 'Exportar'}
      </button>

      {showMenu && (
        <div className="absolute right-0 mt-2 w-48 bg-white rounded-lg shadow-lg border border-gray-200 z-10">
          <button
            onClick={() => handleExport('excel')}
            className="flex items-center gap-2 w-full px-4 py-2 hover:bg-gray-50 text-left"
          >
            <FileSpreadsheet size={16} className="text-green-600" />
            Exportar Excel
          </button>
          <button
            onClick={() => handleExport('csv')}
            className="flex items-center gap-2 w-full px-4 py-2 hover:bg-gray-50 text-left"
          >
            <FileText size={16} className="text-blue-600" />
            Exportar CSV
          </button>
          <button
            onClick={() => handleExport('pdf')}
            className="flex items-center gap-2 w-full px-4 py-2 hover:bg-gray-50 text-left"
          >
            <File size={16} className="text-red-600" />
            Exportar PDF
          </button>
        </div>
      )}
    </div>
  );
};
```

---

## ⚠️ Manejo de Errores

| Status Code | Descripción | Mensaje de Error |
|-------------|-------------|------------------|
| `400` | Parámetros inválidos | Ver mensaje específico (e.g., "format parameter is required") |
| `401` | No autenticado | "Unauthorized" |
| `403` | Sin permisos | "VENDEDOR can only view own commissions with dimension=vendedor" |
| `404` | Entidad no encontrada | "El listero/vendedor especificado no existe" |
| `429` | Rate limit excedido | "Demasiadas exportaciones. Por favor espere un momento antes de intentar nuevamente." |
| `500` | Error interno del servidor | "Error al generar el archivo de exportación" |

---

## 🕐 Timezone y Formatos de Fecha

- **Timezone del Servidor**: `America/Costa_Rica` (GMT-6)
- **Fechas en el Reporte**: Formato `DD/MM/YYYY`
- **Hora de Generación**: Formato `DD/MM/YYYY HH:mm (GMT-6)`
- **Parámetros de Query**: Formato `YYYY-MM-DD`

**Ejemplo:**
- Query: `fromDate=2025-12-04`
- En el reporte: `04/12/2025`

---

## 📊 Notas Importantes

1. **Performance**:
   - Generación **síncrona** (descarga inmediata)
   - Timeout extendido a **5 minutos** para reportes grandes
   - Recomendado para hasta **50,000 registros**

2. **Breakdown Detallado**:
   - Incluye desglose por **lotería, sorteo y multiplicador**
   - Muestra comisiones exactas por cada combinación
   - Útil para auditorías y análisis detallado

3. **Advertencias**:
   - Detecta **listeros sin política de comisión**
   - Identifica **sorteos en lista de exclusión**
   - Ayuda a mantener integridad de datos

4. **Nombres de Archivo**:
   - Formato: `comisiones-{dimensión}-{filtro}-{período}.{ext}`
   - Sanitizados (sin caracteres especiales)
   - Máximo 50 caracteres para entidad

5. **Excel Features**:
   - Múltiples hojas (Resumen, Breakdown, Advertencias)
   - Formato de moneda con símbolo `₡`
   - Colores según severidad en advertencias
   - Encabezados congelados para scroll
   - Anchos de columna automáticos

6. **PDF Features**:
   - Orientación horizontal (landscape)
   - Tablas con bordes y fondos alternados
   - Paginación automática
   - Pie de página con número de página

---

## ✅ Validaciones del Endpoint

- ✅ Formato debe ser `csv`, `excel` o `pdf`
- ✅ Dimensión debe ser `ventana` o `vendedor`
- ✅ Si `date='range'`, `fromDate` y `toDate` son obligatorios
- ✅ Fechas deben ser formato `YYYY-MM-DD`
- ✅ `fromDate` debe ser <= `toDate`
- ✅ `ventanaId` solo válido si `dimension='ventana'`
- ✅ `vendedorId` solo válido si `dimension='vendedor'`
- ✅ UUIDs deben ser válidos

---

## 🚀 Estado de Implementación

- ✅ Validadores Zod
- ✅ Servicios de exportación (CSV, Excel, PDF)
- ✅ Controlador con método `export`
- ✅ Rutas configuradas
- ✅ Rate limiting implementado
- ✅ RBAC enforcement
- ✅ Logs y auditoría
- ✅ Manejo de errores
- ✅ Breakdown detallado
- ✅ Detección de advertencias
- ✅ Timezone de Costa Rica
- ✅ Formato de nombres de archivo

---

## 📞 Contacto

Si tienes preguntas o necesitas soporte adicional, contacta al equipo de backend.
