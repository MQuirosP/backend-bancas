# API de Registros de Auditoría (Activity Log)

## Descripción General

Los registros de auditoría rastrean todas las acciones importantes en el sistema. Cada registro contiene:
- **ID**: Identificador único del registro
- **Usuario**: Quién realizó la acción
- **Acción**: Tipo de operación (CREATE, UPDATE, DELETE, etc.)
- **Tipo de Destino**: Entidad afectada (USER, VENTANA, BANCA, TICKET, etc.)
- **ID de Destino**: ID específico de la entidad
- **Detalles**: JSON con información adicional
- **Fecha de Creación**: Cuándo ocurrió la acción

## Endpoints Disponibles

> **Nota**: Todos los endpoints requieren autenticación y acceso ADMIN

### 1. Listar Registros de Auditoría (Paginado)

**GET** `/api/v1/activity-logs`

**Query Parameters:**
```typescript
{
  page?: number;                    // Página (default: 1)
  pageSize?: number;                // Elementos por página (default: 10, máx: 100)
  userId?: string;                  // Filtrar por ID de usuario (UUID)
  action?: ActivityType;            // Filtrar por tipo de acción
  targetType?: string;              // Filtrar por tipo de entidad (USER, VENTANA, etc.)
  targetId?: string;                // Filtrar por ID de entidad específico
  startDate?: string;               // Fecha inicial (ISO 8601 format)
  endDate?: string;                 // Fecha final (ISO 8601 format)
}
```

**Ejemplo de Uso:**
```bash
GET /api/v1/activity-logs?page=1&pageSize=20&userId=<uuid>&action=USER_CREATE
GET /api/v1/activity-logs?targetType=VENTANA&startDate=2025-01-01T00:00:00Z&endDate=2025-01-31T23:59:59Z
```

**Respuesta Exitosa (200):**
```json
{
  "success": true,
  "data": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "userId": "user-uuid-1",
      "user": {
        "id": "user-uuid-1",
        "username": "admin",
        "name": "Administrador",
        "role": "ADMIN"
      },
      "action": "USER_CREATE",
      "targetType": "USER",
      "targetId": "new-user-uuid",
      "details": {
        "username": "juan_vendedor",
        "role": "VENDEDOR",
        "ventanaId": "listero-uuid-1"
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

### 2. Obtener un Registro Específico

**GET** `/api/v1/activity-logs/:id`

**Parámetros:**
- `id` (string, UUID): ID del registro de auditoría

**Ejemplo de Uso:**
```bash
GET /api/v1/activity-logs/550e8400-e29b-41d4-a716-446655440000
```

**Respuesta Exitosa (200):**
```json
{
  "success": true,
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "userId": "user-uuid-1",
    "user": {
      "id": "user-uuid-1",
      "username": "admin",
      "name": "Administrador",
      "role": "ADMIN"
    },
    "action": "USER_UPDATE",
    "targetType": "USER",
    "targetId": "user-uuid-2",
    "details": {
      "role": "VENDEDOR",
      "ventanaId": "listero-uuid-1"
    },
    "createdAt": "2025-01-15T11:45:22.456Z"
  }
}
```

---

### 3. Obtener Registros de un Usuario

**GET** `/api/v1/activity-logs/user/:userId`

**Parámetros:**
- `userId` (string, UUID): ID del usuario

**Ejemplo de Uso:**
```bash
GET /api/v1/activity-logs/user/user-uuid-1
```

**Respuesta:** Array de hasta 100 registros del usuario (ordenados por fecha descendente)

---

### 4. Obtener Registros de una Entidad

**GET** `/api/v1/activity-logs/target/:targetType/:targetId`

**Parámetros:**
- `targetType` (string): Tipo de entidad (USER, VENTANA, BANCA, TICKET, etc.)
- `targetId` (string): ID de la entidad

**Ejemplo de Uso:**
```bash
GET /api/v1/activity-logs/target/USER/user-uuid-2
GET /api/v1/activity-logs/target/VENTANA/listero-uuid-1
GET /api/v1/activity-logs/target/TICKET/ticket-uuid-5
```

**Respuesta:** Array de registros relacionados con esa entidad

---

### 5. Obtener Registros por Acción

**GET** `/api/v1/activity-logs/action/:action`

**Parámetros:**
- `action` (ActivityType): Tipo de acción

**Ejemplo de Uso:**
```bash
GET /api/v1/activity-logs/action/USER_CREATE
GET /api/v1/activity-logs/action/TICKET_PAY
GET /api/v1/activity-logs/action/VENTANA_DELETE
```

**Respuesta:** Array de hasta 100 registros con esa acción

---

### 6. Limpiar Registros Antiguos

**POST** `/api/v1/activity-logs/cleanup`

**Body:**
```json
{
  "days": 90  // Eliminar registros más antiguos que N días (default: 90)
}
```

**Ejemplo de Uso:**
```bash
POST /api/v1/activity-logs/cleanup
Content-Type: application/json

{
  "days": 60
}
```

**Respuesta Exitosa (200):**
```json
{
  "success": true,
  "data": {
    "message": "Se eliminaron 1250 registros de auditoría",
    "deletedCount": 1250
  }
}
```

---

## Tipos de Acciones (ActivityType Enum)

Las siguientes acciones pueden ser registradas:

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

  // Ventanas/Listeros
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

---

## Códigos de Error

| Código | Mensaje | Causa |
|--------|---------|-------|
| 400 | `La fecha de inicio no puede ser mayor que la fecha de fin` | Rango de fechas inválido |
| 400 | `El número de días debe ser mayor a 0` | cleanup con días <= 0 |
| 401 | `No autorizado` | Sin token de autenticación válido |
| 403 | `Prohibido` | No es un usuario ADMIN |
| 404 | `Registro de auditoría no encontrado` | ID de registro no existe |

---

## Ejemplos de Uso en Frontend

### React Hook para listar logs

```typescript
import { useQuery } from '@tanstack/react-query';

const useActivityLogs = (filters?: {
  page?: number;
  pageSize?: number;
  userId?: string;
  action?: string;
  targetType?: string;
  startDate?: string;
  endDate?: string;
}) => {
  return useQuery({
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
          'Authorization': `Bearer ${token}`
        }
      });

      if (!response.ok) throw new Error('Error al obtener registros');
      return response.json();
    }
  });
};

// Uso en componente
function ActivityLogsPage() {
  const { data, isLoading, error } = useActivityLogs({
    page: 1,
    pageSize: 20,
    startDate: '2025-01-01T00:00:00Z',
    endDate: '2025-01-31T23:59:59Z'
  });

  if (isLoading) return <div>Cargando...</div>;
  if (error) return <div>Error: {error.message}</div>;

  return (
    <div>
      {data?.data.map(log => (
        <div key={log.id}>
          <p>{log.user.name} - {log.action}</p>
          <p>Afectó: {log.targetType} ({log.targetId})</p>
          <p>{new Date(log.createdAt).toLocaleString('es-ES')}</p>
        </div>
      ))}
      <p>Total: {data?.meta.total} registros</p>
    </div>
  );
}
```

---

## Consideraciones de Rendimiento

- Los datos se devuelven paginados para evitar sobrecarga
- Los filtros de fecha están optimizados con índices en la base de datos
- Los registros más antiguos pueden limpiarse automáticamente (90 días por defecto)
- Se recomienda usar el endpoint de limpieza regularmente para mantener la base de datos óptima

---

## Seguridad

- **Solo ADMIN** puede acceder a estos endpoints
- Los registros son **de solo lectura** (no se pueden editar, solo crear internamente y eliminar los antiguos)
- Cada registro rastrea **quién** realizó la acción y **cuándo**
- Los registros no se pueden eliminar individualmente (solo limpieza masiva de antiguos)
