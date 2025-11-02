# ✅ Sistema de Auditoría - Listo para Frontend

## 📦 Resumen de Implementación

Se ha completado la implementación de un sistema completo de registros de auditoría (Activity Log) que rastrea todas las acciones importantes en la plataforma.

---

## 🚀 Endpoints Disponibles

### Base URL
```
/api/v1/activity-logs
```

### Operaciones Principales

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| **GET** | `/` | Listar logs con paginación y filtros |
| **GET** | `/:id` | Obtener log específico por ID |
| **GET** | `/user/:userId` | Obtener todos los logs de un usuario |
| **GET** | `/target/:targetType/:targetId` | Obtener logs de una entidad |
| **GET** | `/action/:action` | Obtener logs por tipo de acción |
| **POST** | `/cleanup` | Limpiar logs más antiguos que N días |

---

## 📋 Ejemplo de Respuesta

```json
{
  "success": true,
  "data": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "userId": "admin-id-123",
      "user": {
        "id": "admin-id-123",
        "username": "admin",
        "name": "Administrador",
        "role": "ADMIN"
      },
      "action": "USER_CREATE",
      "targetType": "USER",
      "targetId": "user-id-456",
      "details": {
        "username": "juan_vendedor",
        "role": "VENDEDOR",
        "ventanaId": "listero-id-789"
      },
      "createdAt": "2025-01-15T10:30:45.123Z"
    }
  ],
  "meta": {
    "total": 150,
    "page": 1,
    "pageSize": 20,
    "totalPages": 8,
    "hasNextPage": true,
    "hasPrevPage": false
  }
}
```

---

## 🔍 Parámetros de Filtro (Query String)

```typescript
{
  page?: number;              // Página (default: 1)
  pageSize?: number;          // Elementos/página (default: 10, max: 100)
  userId?: string;            // UUID del usuario que realizó la acción
  action?: ActivityType;      // Tipo de acción (ej: USER_CREATE, VENTANA_UPDATE)
  targetType?: string;        // Tipo de entidad (USER, VENTANA, TICKET, etc.)
  targetId?: string;          // ID de la entidad afectada
  startDate?: string;         // Fecha inicio (ISO 8601, ej: 2025-01-01T00:00:00Z)
  endDate?: string;           // Fecha fin (ISO 8601)
}
```

**Ejemplos de uso:**
```bash
# Listar los últimos 20 registros
GET /api/v1/activity-logs?page=1&pageSize=20

# Filtrar cambios de un usuario específico en una fecha
GET /api/v1/activity-logs?userId=abc123&startDate=2025-01-01T00:00:00Z

# Ver todas las creaciones de usuarios
GET /api/v1/activity-logs?action=USER_CREATE

# Ver todos los cambios en un listero
GET /api/v1/activity-logs?targetType=VENTANA&targetId=xyz789
```

---

## 📝 Tipos de Acciones Registradas

```typescript
// Autenticación
LOGIN, LOGOUT

// Usuarios
USER_CREATE, USER_UPDATE, USER_DELETE, USER_RESTORE

// Bancas
BANCA_CREATE, BANCA_UPDATE, BANCA_DELETE, BANCA_RESTORE

// Ventanas (Listeros)
VENTANA_CREATE, VENTANA_UPDATE, VENTANA_DELETE, VENTANA_RESTORE

// Loterias
LOTERIA_CREATE, LOTERIA_UPDATE, LOTERIA_DELETE, LOTERIA_RESTORE

// Sorteos
SORTEO_CREATE, SORTEO_UPDATE, SORTEO_OPEN, SORTEO_CLOSE, SORTEO_EVALUATE

// Tickets
TICKET_CREATE, TICKET_CANCEL, TICKET_PAY, TICKET_PAY_FINALIZE, TICKET_PAYMENT_REVERSE

// Sistema
SYSTEM_ACTION, SOFT_DELETE, RESTORE
```

---

## 🔐 Autorización

- **Solo ADMIN**: Todos los endpoints requieren rol ADMIN
- **Sin Edición**: Los logs son de solo lectura (no se pueden editar)
- **Solo Lectura de Antiguos**: Los logs antiguos solo se pueden limpiar en massa (no individualmente)

---

## 💻 Integración Frontend - Quick Start

### 1. Hook React

```typescript
import { useQuery } from '@tanstack/react-query';

const useActivityLogs = (filters) => {
  const token = useAuth().token;

  return useQuery({
    queryKey: ['activityLogs', filters],
    queryFn: async () => {
      const params = new URLSearchParams(
        Object.fromEntries(
          Object.entries(filters || {}).filter(([, v]) => v != null)
        )
      );

      const res = await fetch(`/api/v1/activity-logs?${params}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });

      if (!res.ok) throw new Error('Error al obtener registros');
      return res.json();
    }
  });
};

export default useActivityLogs;
```

### 2. Componente React

```typescript
import useActivityLogs from '@/hooks/useActivityLogs';
import { useState } from 'react';

export function AuditLogs() {
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState({ page, pageSize: 20 });

  const { data, isLoading } = useActivityLogs(filters);

  if (isLoading) return <div>Cargando...</div>;

  return (
    <div>
      <h2>Registros de Auditoría</h2>

      <table>
        <thead>
          <tr>
            <th>Usuario</th>
            <th>Acción</th>
            <th>Entidad</th>
            <th>Fecha</th>
          </tr>
        </thead>
        <tbody>
          {data?.data.map(log => (
            <tr key={log.id}>
              <td>{log.user?.name || 'Sistema'}</td>
              <td>{log.action}</td>
              <td>{log.targetType}</td>
              <td>{new Date(log.createdAt).toLocaleString('es-ES')}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Paginación */}
      <div>
        <button onClick={() => setPage(p => p - 1)} disabled={!data?.meta.hasPrevPage}>
          ← Anterior
        </button>
        <span>Página {data?.meta.page} de {data?.meta.totalPages}</span>
        <button onClick={() => setPage(p => p + 1)} disabled={!data?.meta.hasNextPage}>
          Siguiente →
        </button>
      </div>
    </div>
  );
}
```

---

## 🎯 Casos de Uso Comunes

### Auditar Cambios de un Usuario
```typescript
// Ver todos los cambios realizados a un usuario específico
fetch('/api/v1/activity-logs/target/USER/user-id-123')
```

### Reporte de Operaciones por Mes
```typescript
// Obtener todas las operaciones de enero 2025
const start = new Date(2025, 0, 1).toISOString();
const end = new Date(2025, 1, 0, 23, 59, 59).toISOString();

fetch(`/api/v1/activity-logs?pageSize=1000&startDate=${start}&endDate=${end}`)
```

### Seguimiento de Pago de Ticket
```typescript
// Ver quién pagó un ticket y cuándo
fetch('/api/v1/activity-logs/target/TICKET/ticket-id-xyz')
```

### Historial de Usuario Específico
```typescript
// Ver todos los logs de un administrador
fetch('/api/v1/activity-logs/user/admin-id-123')
```

---

## 📊 Estructura del Log Detallada

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `id` | UUID | Identificador único |
| `userId` | UUID \| null | ID del usuario que realizó la acción |
| `user` | Object | Datos del usuario (si existe) |
| `user.id` | UUID | ID del usuario |
| `user.username` | string | Nombre de usuario |
| `user.name` | string | Nombre completo |
| `user.role` | string | Rol (ADMIN, VENTANA, VENDEDOR) |
| `action` | enum | Tipo de acción realizada |
| `targetType` | string \| null | Tipo de entidad afectada |
| `targetId` | string \| null | ID de la entidad afectada |
| `details` | JSON | Información adicional específica de la acción |
| `createdAt` | ISO8601 | Timestamp de cuándo ocurrió |

---

## 🛠️ Administración (ADMIN only)

### Limpiar Logs Antiguos

```typescript
// Eliminar logs más antiguos que 90 días
const response = await fetch('/api/v1/activity-logs/cleanup', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${adminToken}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ days: 90 })
});

const result = await response.json();
console.log(`Se eliminaron ${result.data.deletedCount} registros`);
```

---

## 📚 Documentación Completa

Para detalles técnicos exhaustivos, consulta:
- **[ACTIVITY_LOG_API.md](./docs/ACTIVITY_LOG_API.md)** - Especificación técnica completa
- **[FRONTEND_INTEGRATION_GUIDE.md](./docs/FRONTEND_INTEGRATION_GUIDE.md)** - Guía detallada para frontend
- **[ACTIVITY_LOG_DEPLOYMENT_GUIDE.md](./docs/ACTIVITY_LOG_DEPLOYMENT_GUIDE.md)** - Guía de despliegue y validación

---

## ✨ Lo Que Está Automáticamente Registrado

Cada una de estas acciones crea un log automáticamente:

- ✅ Creación de usuarios
- ✅ Cambios en roles/permisos de usuarios
- ✅ Eliminación de usuarios
- ✅ Reactivación de usuarios
- ✅ Cambios en ventanas/listeros
- ✅ Cambios en bancas
- ✅ Cambios en loterias
- ✅ Apertura/cierre de sorteos
- ✅ Creación de tickets
- ✅ Pagos de tickets
- ✅ Cancelaciones de tickets
- ✅ Y más...

---

## 🚦 Estado de Implementación

| Componente | Estado |
|-----------|--------|
| ✅ Modelo de Datos | Completado |
| ✅ Repositorio | Completado |
| ✅ Servicio | Completado |
| ✅ Controlador | Completado |
| ✅ Validadores | Completado |
| ✅ Rutas/Endpoints | Completado |
| ✅ Logs en User Service | Completado |
| ✅ Documentación API | Completado |
| ✅ Guía Frontend | Completado |
| ⏳ Testing | Pendiente (para fase siguiente) |
| ⏳ Merge a master | Pendiente (para validación) |

---

## 🔄 Rama de Feature

**Rama**: `feature/activity-log-audit`
**Commits**: 2
- `dbd7581`: Implementación del sistema completo
- `dcd7090`: Documentación

**Estado**: Listo para revisar y validar antes de merge a master

---

## 📞 Próximos Pasos

1. **Revisar** esta implementación en la rama feature
2. **Validar** que los endpoints funcionan correctamente
3. **Probar** la integración con el frontend
4. **Hacer merge** a master una vez validado
5. **Deploy** a producción

---

**Rama Feature**: https://github.com/MQuirosP/backend-bancas/tree/feature/activity-log-audit
