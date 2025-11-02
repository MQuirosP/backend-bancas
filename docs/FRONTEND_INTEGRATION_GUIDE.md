# Guía de Integración Frontend - Registros de Auditoría

## 📋 Resumen

Se ha implementado un sistema completo de auditoría que rastrea todas las acciones importantes en el sistema. El frontend puede consultar estos registros a través de endpoints REST protegidos (solo acceso ADMIN).

## 🔑 Características Principales

- ✅ **Auditoría Completa**: Todas las operaciones CRUD se registran automáticamente
- ✅ **Trazabilidad**: Rastrear quién, qué, cuándo y por qué
- ✅ **Búsqueda Avanzada**: Filtrar por usuario, acción, entidad, rango de fechas
- ✅ **Paginación**: Manejo eficiente de grandes volúmenes de datos
- ✅ **Mantenimiento**: Limpieza automática de registros antiguos

## 🌐 Endpoints API

### Base URL
```
GET /api/v1/activity-logs
```

### Endpoints Principales

| Endpoint | Método | Descripción |
|----------|--------|-------------|
| `/` | GET | Listar logs con filtros y paginación |
| `/:id` | GET | Obtener un log específico |
| `/user/:userId` | GET | Obtener logs de un usuario |
| `/target/:targetType/:targetId` | GET | Obtener logs de una entidad |
| `/action/:action` | GET | Obtener logs de una acción |
| `/cleanup` | POST | Eliminar logs antiguos |

## 📊 Tipos de Datos

### Respuesta de Log Individual

```typescript
interface ActivityLog {
  id: string;                    // UUID único del registro
  userId: string | null;         // Quién realizó la acción
  user?: {                        // Información del usuario
    id: string;
    username: string;
    name: string;
    role: 'ADMIN' | 'VENTANA' | 'VENDEDOR';
  };
  action: ActivityType;          // Tipo de acción realizada
  targetType: string | null;     // Tipo de entidad afectada
  targetId: string | null;       // ID de la entidad afectada
  details: Record<string, any>;  // JSON con información adicional
  createdAt: string;             // Timestamp ISO 8601
}
```

### Metadata de Listados

```typescript
interface ListMeta {
  total: number;        // Total de registros
  page: number;         // Página actual
  pageSize: number;     // Elementos por página
  totalPages: number;   // Total de páginas
  hasNextPage: boolean; // Hay página siguiente
  hasPrevPage: boolean; // Hay página anterior
}
```

## 🔍 Parámetros de Filtro

```typescript
interface ActivityLogFilters {
  page?: number;           // Página (default: 1)
  pageSize?: number;       // Elementos/página (default: 10, max: 100)
  userId?: string;         // UUID del usuario
  action?: ActivityType;   // Tipo de acción
  targetType?: string;     // Tipo de entidad (USER, VENTANA, etc.)
  targetId?: string;       // ID de la entidad
  startDate?: string;      // Fecha inicio (ISO 8601)
  endDate?: string;        // Fecha fin (ISO 8601)
}
```

## 💻 Ejemplo de Integración en React

### Hook personalizado

```typescript
import { useQuery } from '@tanstack/react-query';
import { ActivityLog, ActivityLogFilters } from '@/types/activityLog';

interface ActivityLogResponse {
  success: boolean;
  data: ActivityLog[];
  meta: {
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
    hasNextPage: boolean;
    hasPrevPage: boolean;
  };
}

export const useActivityLogs = (filters?: ActivityLogFilters) => {
  const authToken = useAuth().token; // Tu forma de obtener el token

  return useQuery<ActivityLogResponse>({
    queryKey: ['activityLogs', filters],
    queryFn: async () => {
      const params = new URLSearchParams();

      if (filters?.page) params.append('page', filters.page.toString());
      if (filters?.pageSize) params.append('pageSize', filters.pageSize.toString());
      if (filters?.userId) params.append('userId', filters.userId);
      if (filters?.action) params.append('action', filters.action);
      if (filters?.targetType) params.append('targetType', filters.targetType);
      if (filters?.startDate) params.append('startDate', filters.startDate);
      if (filters?.endDate) params.append('endDate', filters.endDate);

      const response = await fetch(`/api/v1/activity-logs?${params}`, {
        headers: {
          'Authorization': `Bearer ${authToken}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Error al obtener registros');
      }

      return response.json();
    },
    enabled: !!authToken // Solo ejecutar si hay autenticación
  });
};
```

### Componente de Tabla

```typescript
import React, { useState } from 'react';
import { useActivityLogs } from '@/hooks/useActivityLogs';
import { ActivityType } from '@/types/enums';

export function ActivityLogsTable() {
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState<ActivityLogFilters>({
    page,
    pageSize: 20,
  });

  const { data, isLoading, error } = useActivityLogs(filters);

  if (isLoading) return <div className="loading">Cargando registros...</div>;
  if (error) return <div className="error">Error: {error.message}</div>;

  return (
    <div className="activity-logs-container">
      <h2>Registros de Auditoría</h2>

      {/* Filtros */}
      <div className="filters">
        <input
          type="text"
          placeholder="Filtrar por usuario..."
          onChange={(e) => setFilters({...filters, userId: e.target.value})}
        />
        <select
          onChange={(e) => setFilters({...filters, action: e.target.value})}
        >
          <option value="">Todas las acciones</option>
          {Object.entries(ActivityType).map(([key, value]) => (
            <option key={key} value={value}>{key}</option>
          ))}
        </select>
        <input
          type="date"
          onChange={(e) => setFilters({
            ...filters,
            startDate: new Date(e.target.value).toISOString()
          })}
        />
      </div>

      {/* Tabla */}
      <table className="activity-table">
        <thead>
          <tr>
            <th>Usuario</th>
            <th>Acción</th>
            <th>Entidad</th>
            <th>Detalles</th>
            <th>Fecha/Hora</th>
          </tr>
        </thead>
        <tbody>
          {data?.data.map((log) => (
            <tr key={log.id}>
              <td>{log.user?.name || 'Sistema'}</td>
              <td>
                <span className={`badge badge-${log.action.toLowerCase()}`}>
                  {log.action}
                </span>
              </td>
              <td>{log.targetType} ({log.targetId?.slice(0, 8)}...)</td>
              <td>
                <button onClick={() => showDetails(log.details)}>
                  Ver
                </button>
              </td>
              <td>{new Date(log.createdAt).toLocaleString('es-ES')}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Paginación */}
      <div className="pagination">
        <button
          onClick={() => setPage(page - 1)}
          disabled={!data?.meta.hasPrevPage}
        >
          ← Anterior
        </button>
        <span>
          Página {data?.meta.page} de {data?.meta.totalPages}
        </span>
        <button
          onClick={() => setPage(page + 1)}
          disabled={!data?.meta.hasNextPage}
        >
          Siguiente →
        </button>
      </div>
    </div>
  );
}
```

### Obtener Logs de una Entidad Específica

```typescript
// Obtener todos los cambios de un usuario específico
const userLogs = useQuery({
  queryKey: ['userActivity', userId],
  queryFn: async () => {
    const response = await fetch(
      `/api/v1/activity-logs/user/${userId}`,
      { headers: { 'Authorization': `Bearer ${token}` }}
    );
    return response.json();
  }
});

// Obtener todos los cambios de un listero (ventana)
const ventanaLogs = useQuery({
  queryKey: ['ventanaActivity', ventanaId],
  queryFn: async () => {
    const response = await fetch(
      `/api/v1/activity-logs/target/VENTANA/${ventanaId}`,
      { headers: { 'Authorization': `Bearer ${token}` }}
    );
    return response.json();
  }
});

// Obtener todos los tickets creados
const ticketCreationLogs = useQuery({
  queryKey: ['ticketCreations'],
  queryFn: async () => {
    const response = await fetch(
      `/api/v1/activity-logs/action/TICKET_CREATE`,
      { headers: { 'Authorization': `Bearer ${token}` }}
    );
    return response.json();
  }
});
```

## 🔐 Autorización

- **Solo ADMIN**: Solo usuarios con rol ADMIN pueden acceder a estos endpoints
- **Sin Escritura Directa**: Los logs se crean automáticamente, no se pueden crear/editar manualmente
- **Limpieza Automática**: Los registros más antiguos se pueden eliminar (90 días por defecto)

## 📝 Acciones Registradas

```typescript
enum ActivityType {
  // Autenticación
  LOGIN = "LOGIN",
  LOGOUT = "LOGOUT",

  // Usuarios
  USER_CREATE = "USER_CREATE",
  USER_UPDATE = "USER_UPDATE",
  USER_DELETE = "USER_DELETE",
  USER_RESTORE = "USER_RESTORE",

  // Bancas
  BANCA_CREATE = "BANCA_CREATE",
  BANCA_UPDATE = "BANCA_UPDATE",
  BANCA_DELETE = "BANCA_DELETE",
  BANCA_RESTORE = "BANCA_RESTORE",

  // Ventanas (Listeros)
  VENTANA_CREATE = "VENTANA_CREATE",
  VENTANA_UPDATE = "VENTANA_UPDATE",
  VENTANA_DELETE = "VENTANA_DELETE",
  VENTANA_RESTORE = "VENTANA_RESTORE",

  // Loterias
  LOTERIA_CREATE = "LOTERIA_CREATE",
  LOTERIA_UPDATE = "LOTERIA_UPDATE",
  LOTERIA_DELETE = "LOTERIA_DELETE",
  LOTERIA_RESTORE = "LOTERIA_RESTORE",

  // Sorteos
  SORTEO_CREATE = "SORTEO_CREATE",
  SORTEO_UPDATE = "SORTEO_UPDATE",
  SORTEO_OPEN = "SORTEO_OPEN",
  SORTEO_CLOSE = "SORTEO_CLOSE",
  SORTEO_EVALUATE = "SORTEO_EVALUATE",

  // Tickets
  TICKET_CREATE = "TICKET_CREATE",
  TICKET_CANCEL = "TICKET_CANCEL",
  TICKET_PAY = "TICKET_PAY",
  TICKET_PAY_FINALIZE = "TICKET_PAY_FINALIZE",
  TICKET_PAYMENT_REVERSE = "TICKET_PAYMENT_REVERSE",

  // Sistema
  SYSTEM_ACTION = "SYSTEM_ACTION",
  SOFT_DELETE = "SOFT_DELETE",
  RESTORE = "RESTORE",
}
```

## 🎯 Casos de Uso Comunes

### 1. Auditar Cambios de Usuario

```typescript
// Ver todos los cambios realizados a un usuario específico
const auditUserChanges = async (userId: string) => {
  const response = await fetch(
    `/api/v1/activity-logs/target/USER/${userId}?pageSize=100`,
    { headers: { 'Authorization': `Bearer ${token}` }}
  );
  const data = await response.json();

  // Mostrar timeline de cambios
  data.data.forEach(log => {
    console.log(`${log.user.name} realizó ${log.action} en ${log.createdAt}`);
    console.log('Detalles:', log.details);
  });
};
```

### 2. Reporte de Operaciones por Periodo

```typescript
// Generar reporte de todas las operaciones del mes
const monthlyReport = async (year: number, month: number) => {
  const startDate = new Date(year, month - 1, 1).toISOString();
  const endDate = new Date(year, month, 0, 23, 59, 59).toISOString();

  const response = await fetch(
    `/api/v1/activity-logs?pageSize=1000&startDate=${startDate}&endDate=${endDate}`,
    { headers: { 'Authorization': `Bearer ${token}` }}
  );
  const data = await response.json();

  return data.data;
};
```

### 3. Seguimiento de Pagos

```typescript
// Ver quién realizó el último pago de un ticket
const getPaymentAudit = async (ticketId: string) => {
  const response = await fetch(
    `/api/v1/activity-logs/target/TICKET/${ticketId}?pageSize=50`,
    { headers: { 'Authorization': `Bearer ${token}` }}
  );
  const data = await response.json();

  const paymentLogs = data.data.filter(log =>
    log.action.includes('PAYMENT') || log.action.includes('PAY')
  );

  return paymentLogs;
};
```

## ⚙️ Configuración Recomendada

### Variables de Entorno

```env
# Retención de logs (días)
ACTIVITY_LOG_RETENTION_DAYS=90

# Tamaño máximo de página
ACTIVITY_LOG_MAX_PAGE_SIZE=100
```

### Limpieza de Logs Antiguos

```typescript
// Ejecutar diariamente
async function cleanupOldLogs() {
  const response = await fetch('/api/v1/activity-logs/cleanup', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${adminToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ days: 90 })
  });

  const result = await response.json();
  console.log(`Eliminados ${result.data.deletedCount} registros`);
}
```

## 🐛 Troubleshooting

### Error 403 - Prohibido
- **Causa**: No eres un usuario ADMIN
- **Solución**: Solo usuarios ADMIN pueden acceder a estos endpoints

### Error 400 - Rango de fechas inválido
- **Causa**: startDate > endDate
- **Solución**: Asegúrate de que la fecha de inicio sea menor que la de fin

### Muy lento para buscar
- **Causa**: Demasiados registros o filtros ineficientes
- **Solución**: Usa paginación más pequeña, filtra por rangos de fechas específicos

---

**Documentación Completa**: Ver [ACTIVITY_LOG_API.md](./ACTIVITY_LOG_API.md) para detalles técnicos exhaustivos.
