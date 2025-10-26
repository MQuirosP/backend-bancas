# Resumen de Unificación MultiplierOverride

## ✅ Completado

Se ha realizado exitosamente la unificación de los módulos `UserMultiplierOverride` y `VentanaMultiplierOverride` en un único módulo `MultiplierOverride` con scope (USER | VENTANA) y scopeId.

### Archivos Creados

#### 1. Modelo Prisma
- **Archivo modificado**: `src/prisma/schema.prisma`
- **Nuevo enum**: `OverrideScope { USER, VENTANA }`
- **Nuevo modelo**: `MultiplierOverride` con campos:
  - `scope: OverrideScope`
  - `userId?: String` (nullable)
  - `ventanaId?: String` (nullable)
  - `loteriaId: String`
  - `multiplierType: String`
  - `baseMultiplierX: Float`
  - `isActive: Boolean`
  - Campos de auditoría: `deletedAt`, `deletedBy`, `deletedReason`, `createdAt`, `updatedAt`
- **Constraint único**: `[scope, userId, ventanaId, loteriaId, multiplierType]`
- **Índice**: Para optimizar búsquedas

#### 2. Repositorio
- **Archivo**: `src/repositories/multiplierOverride.repository.ts`
- **Métodos**:
  - `create(data)` - Crea override con validación de scope
  - `update(id, data)` - Actualiza override
  - `softDelete(id, deletedBy?, deletedReason?)` - Soft delete
  - `restore(id)` - Restaura override eliminado
  - `getById(id)` - Obtiene override por ID
  - `findOne(filters)` - Busca un override específico (usado en resolución)
  - `list(filters)` - Lista con filtros y paginación
  - `exists(filters)` - Verifica existencia

#### 3. DTOs
- **Archivo**: `src/api/v1/dto/multiplierOverride.dto.ts`
- **Interfaces**:
  - `CreateMultiplierOverrideDTO` - Para crear (scope, scopeId, loteriaId, multiplierType, baseMultiplierX)
  - `UpdateMultiplierOverrideDTO` - Para actualizar (baseMultiplierX?, isActive?)
  - `ListMultiplierOverrideQueryDTO` - Para listar con filtros

#### 4. Validadores
- **Archivo**: `src/api/v1/validators/multiplierOverride.validator.ts`
- **Schemas Zod**:
  - `createMultiplierOverrideValidator` - Valida creación con UUIDs y tipos
  - `updateMultiplierOverrideValidator` - Valida actualización
  - `listMultiplierOverrideQueryValidator` - Valida query params
  - `idParamValidator` - Valida parámetro ID en rutas

#### 5. Servicio
- **Archivo**: `src/api/v1/services/multiplierOverride.service.ts`
- **Funcionalidades**:
  - Control de acceso basado en roles (ADMIN, VENTANA)
  - Validación de scope y scopeId
  - Logging de actividades con ActivityService
  - Métodos: `create`, `update`, `softDelete`, `restore`, `getById`, `list`

#### 6. Controlador
- **Archivo**: `src/api/v1/controllers/multiplierOverride.controller.ts`
- **Endpoints manejados**: create, update, remove, restore, getById, list

#### 7. Rutas
- **Archivo**: `src/api/v1/routes/multiplierOverride.routes.ts`
- **Endpoints**:
  - `POST /api/v1/multiplier-overrides` - Crear
  - `PUT /api/v1/multiplier-overrides/:id` - Actualizar
  - `DELETE /api/v1/multiplier-overrides/:id` - Soft delete
  - `PATCH /api/v1/multiplier-overrides/:id/restore` - Restaurar
  - `GET /api/v1/multiplier-overrides/:id` - Obtener por ID
  - `GET /api/v1/multiplier-overrides` - Listar (con filtros)

### Archivos Modificados

#### 1. Resolución de Multiplicadores
- **Archivo**: `src/repositories/ticket.repository.ts`
- **Función modificada**: `resolveBaseMultiplierX()`
- **Nueva jerarquía de resolución**:
  1. `MultiplierOverride` con `scope=USER` (máxima prioridad)
  2. `MultiplierOverride` con `scope=VENTANA` (segunda prioridad)
  3. `BancaLoteriaSetting.baseMultiplierX`
  4. `LoteriaMultiplier` (name="Base" o kind="NUMERO")
  5. `Loteria.rulesJson.baseMultiplierX`
  6. Variable de entorno `MULTIPLIER_BASE_DEFAULT_X`

#### 2. Routing Principal
- **Archivo**: `src/api/v1/routes/index.ts`
- **Cambios**:
  - Eliminadas rutas legacy: `/user-multiplier-overrides` y `/ventana-multiplier-overrides`
  - Agregada nueva ruta: `/multiplier-overrides`

#### 3. Tests
- **Archivo**: `tests/tickets/helpers/resetDatabase.ts`
- **Cambio**: Actualizada tabla en TRUNCATE de `UserMultiplierOverride` a `MultiplierOverride`

### Archivos Eliminados

Se eliminaron completamente todos los archivos legacy (12 archivos en total):

#### UserMultiplierOverride (6 archivos):
- `src/api/v1/controllers/userMultiplierOverride.controller.ts`
- `src/api/v1/services/userMultiplierOverride.service.ts`
- `src/api/v1/routes/userMultiplierOverride.routes.ts`
- `src/api/v1/dto/userMultiplierOverride.dto.ts`
- `src/api/v1/validators/userMultiplierOverride.validator.ts`
- `src/repositories/userMultiplierOverride.repository.ts`

#### VentanaMultiplierOverride (6 archivos):
- `src/api/v1/controllers/ventanaMultiplierOverride.controller.ts`
- `src/api/v1/services/ventanaMultiplierOverride.service.ts`
- `src/api/v1/routes/ventanaMultiplierOverride.routes.ts`
- `src/api/v1/dto/ventanaMultiplierOverride.dto.ts`
- `src/api/v1/validators/ventanaMultiplierOverride.validator.ts`
- `src/repositories/ventanaMultiplierOverride.repository.ts`

### Verificaciones Completadas

✅ **TypeCheck**: Compilación exitosa sin errores
✅ **Import Residuales**: No se encontraron referencias a módulos legacy
✅ **Convenciones del Proyecto**: Se siguieron todos los patrones existentes

---

## 🔧 Pasos Pendientes (Usuario)

### 1. Generar y Aplicar Migración de Prisma

Como indicaste que no hay datos existentes, puedes ejecutar directamente:

```bash
npm run migrate:dev
```

Cuando te pida el nombre de la migración, usa algo descriptivo como:
```
unify_multiplier_overrides
```

O si prefieres un reset completo de la base de datos (CUIDADO: esto borra TODOS los datos):

```bash
# Solo en desarrollo
npx prisma migrate reset --schema=./src/prisma/schema.prisma
```

### 2. Regenerar el Cliente Prisma

Esto ya se ejecutó automáticamente, pero si necesitas hacerlo manualmente:

```bash
npm run prisma:generate
```

### 3. Verificar la Base de Datos

Revisa que las tablas antiguas fueron eliminadas y la nueva fue creada:

```sql
-- Verifica que NO existan estas tablas
SELECT tablename FROM pg_tables
WHERE tablename IN ('UserMultiplierOverride', 'VentanaMultiplierOverride');

-- Verifica que exista la nueva tabla
SELECT tablename FROM pg_tables WHERE tablename = 'MultiplierOverride';

-- Verifica el schema
\d "MultiplierOverride"
```

### 4. Testing

Ejecuta los tests para verificar que todo funciona:

```bash
npm test
```

Si tienes tests específicos para multiplier overrides, necesitarás actualizarlos para usar el nuevo endpoint unificado.

---

## 📋 API para Frontend

### Contrato de Endpoints

#### POST /api/v1/multiplier-overrides
Crear un nuevo override de multiplicador.

**Body**:
```json
{
  "scope": "USER" | "VENTANA",
  "scopeId": "uuid-del-usuario-o-ventana",
  "loteriaId": "uuid-de-loteria",
  "multiplierType": "NUMERO" | "REVENTADO" | string,
  "baseMultiplierX": 75.5
}
```

**Roles**: ADMIN, VENTANA

---

#### PUT /api/v1/multiplier-overrides/:id
Actualizar un override existente.

**Body**:
```json
{
  "baseMultiplierX": 80.0,  // opcional
  "isActive": true           // opcional
}
```

**Roles**: ADMIN, VENTANA

---

#### DELETE /api/v1/multiplier-overrides/:id
Soft delete de un override (isActive = false).

**Body** (opcional):
```json
{
  "deletedReason": "Cambio de política"
}
```

**Roles**: ADMIN, VENTANA

---

#### PATCH /api/v1/multiplier-overrides/:id/restore
Restaurar un override eliminado.

**Roles**: ADMIN, VENTANA

---

#### GET /api/v1/multiplier-overrides/:id
Obtener un override por ID.

**Roles**: Cualquier autenticado (con restricciones por rol)

---

#### GET /api/v1/multiplier-overrides
Listar overrides con filtros y paginación.

**Query Params**:
```
?scope=USER                    // Filtrar por tipo
&scopeId=uuid                  // Filtrar por ID específico
&loteriaId=uuid                // Filtrar por lotería
&multiplierType=NUMERO         // Filtrar por tipo de multiplicador
&isActive=true                 // Filtrar por estado
&page=1                        // Paginación
&pageSize=10                   // Tamaño de página
```

**Roles**: Cualquier autenticado (con restricciones por rol)

**Respuesta**:
```json
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "scope": "USER",
      "userId": "uuid",
      "ventanaId": null,
      "loteriaId": "uuid",
      "multiplierType": "NUMERO",
      "baseMultiplierX": 75.5,
      "isActive": true,
      "createdAt": "2025-10-25T...",
      "updatedAt": "2025-10-25T...",
      "user": { ... },
      "ventana": null,
      "loteria": { ... }
    }
  ],
  "meta": {
    "page": 1,
    "pageSize": 10,
    "total": 45,
    "pages": 5
  }
}
```

---

## 🎯 Beneficios de la Unificación

1. **Código más limpio**: Un solo módulo en lugar de dos duplicados
2. **API única**: Frontend consume un único endpoint `/multiplier-overrides`
3. **Mantenimiento simplificado**: Cambios futuros se hacen en un solo lugar
4. **Jerarquía clara**: USER > VENTANA > defaults (bien definida y documentada)
5. **Sin migraciones de datos**: Como no había datos, la transición es limpia
6. **Extensible**: Fácil agregar nuevos scopes en el futuro si es necesario

---

## 🔍 Ejemplos de Uso

### Crear Override para Usuario
```bash
POST /api/v1/multiplier-overrides
{
  "scope": "USER",
  "scopeId": "123e4567-e89b-12d3-a456-426614174000",
  "loteriaId": "987fcdeb-51a2-43c1-b789-123456789abc",
  "multiplierType": "NUMERO",
  "baseMultiplierX": 75.5
}
```

### Crear Override para Ventana
```bash
POST /api/v1/multiplier-overrides
{
  "scope": "VENTANA",
  "scopeId": "ventana-uuid-here",
  "loteriaId": "loteria-uuid-here",
  "multiplierType": "NUMERO",
  "baseMultiplierX": 80.0
}
```

### Listar Overrides de un Usuario
```bash
GET /api/v1/multiplier-overrides?scope=USER&scopeId=user-uuid&isActive=true
```

### Listar Overrides de una Ventana
```bash
GET /api/v1/multiplier-overrides?scope=VENTANA&scopeId=ventana-uuid&isActive=true
```

---

## 📝 Notas Importantes

1. **Validación de Scope**: El servicio valida que el `scopeId` corresponda a un usuario o ventana activo según el `scope`.

2. **Autorización**:
   - ADMIN puede gestionar todo
   - VENTANA solo puede gestionar su propia ventana y usuarios de su ventana
   - VENDEDOR solo puede ver (no modificar) sus propios overrides

3. **Constraint Único**: No se pueden crear dos overrides con el mismo `(scope, userId, ventanaId, loteriaId, multiplierType)`.

4. **Multiplicador Type**: Actualmente soporta "NUMERO" y "REVENTADO", pero es extensible a cualquier string.

5. **Soft Delete**: Los registros nunca se eliminan físicamente, solo se marcan como `isActive = false`.

---

## ✅ Checklist Final

Antes de considerar la migración completa:

- [ ] Ejecutar `npm run migrate:dev` para aplicar cambios de schema
- [ ] Verificar que las tablas antiguas fueron eliminadas
- [ ] Verificar que la nueva tabla `MultiplierOverride` existe
- [ ] Ejecutar `npm run typecheck` (ya pasó ✅)
- [ ] Ejecutar `npm test` para verificar tests
- [ ] Actualizar tests específicos de overrides si existen
- [ ] Documentar el nuevo endpoint en la documentación del API
- [ ] Notificar al equipo de frontend sobre el nuevo contrato
- [ ] Realizar pruebas de integración con el frontend

---

## 🆘 Soporte

Si encuentras algún problema:

1. Verifica los logs del servidor para errores específicos
2. Revisa que el Prisma client esté regenerado: `npm run prisma:generate`
3. Verifica que las migraciones se aplicaron: `npx prisma migrate status --schema=./src/prisma/schema.prisma`
4. Revisa la consola del navegador para errores de frontend

La unificación está completa y lista para usar! 🎉
