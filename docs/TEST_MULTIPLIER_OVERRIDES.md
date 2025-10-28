# Scripts de Prueba - Multiplier Overrides

Este documento contiene scripts curl para probar manualmente el nuevo endpoint unificado de Multiplier Overrides.

## Setup

Primero, obtén un token de autenticación:

```bash
# Login como ADMIN
curl -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "username": "admin",
    "password": "tu-password"
  }'

# Guarda el token en una variable
export TOKEN="tu-token-jwt-aqui"
```

---

## 1. Crear Override para Usuario

```bash
curl -X POST http://localhost:3000/api/v1/multiplier-overrides \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "scope": "USER",
    "scopeId": "REEMPLAZA-CON-USER-UUID",
    "loteriaId": "REEMPLAZA-CON-LOTERIA-UUID",
    "multiplierType": "NUMERO",
    "baseMultiplierX": 75.5
  }'
```

**Respuesta esperada (201)**:
```json
{
  "success": true,
  "data": {
    "id": "nuevo-uuid",
    "scope": "USER",
    "userId": "user-uuid",
    "ventanaId": null,
    "loteriaId": "loteria-uuid",
    "multiplierType": "NUMERO",
    "baseMultiplierX": 75.5,
    "isActive": true,
    "createdAt": "2025-10-25T...",
    "updatedAt": "2025-10-25T...",
    "user": { "id": "...", "name": "...", ... },
    "ventana": null,
    "loteria": { "id": "...", "name": "...", ... }
  }
}
```

---

## 2. Crear Override para Ventana

```bash
curl -X POST http://localhost:3000/api/v1/multiplier-overrides \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "scope": "VENTANA",
    "scopeId": "REEMPLAZA-CON-VENTANA-UUID",
    "loteriaId": "REEMPLAZA-CON-LOTERIA-UUID",
    "multiplierType": "NUMERO",
    "baseMultiplierX": 80.0
  }'
```

---

## 3. Listar Todos los Overrides (paginado)

```bash
curl -X GET "http://localhost:3000/api/v1/multiplier-overrides?page=1&pageSize=10" \
  -H "Authorization: Bearer $TOKEN"
```

**Respuesta esperada (200)**:
```json
{
  "success": true,
  "data": [
    { ... },
    { ... }
  ],
  "meta": {
    "page": 1,
    "pageSize": 10,
    "total": 25,
    "pages": 3
  }
}
```

---

## 4. Listar Overrides de un Usuario Específico

```bash
curl -X GET "http://localhost:3000/api/v1/multiplier-overrides?scope=USER&scopeId=USER-UUID" \
  -H "Authorization: Bearer $TOKEN"
```

---

## 5. Listar Overrides de una Ventana Específica

```bash
curl -X GET "http://localhost:3000/api/v1/multiplier-overrides?scope=VENTANA&scopeId=VENTANA-UUID" \
  -H "Authorization: Bearer $TOKEN"
```

---

## 6. Filtrar por Lotería y Tipo de Multiplicador

```bash
curl -X GET "http://localhost:3000/api/v1/multiplier-overrides?loteriaId=LOTERIA-UUID&multiplierType=NUMERO&isActive=true" \
  -H "Authorization: Bearer $TOKEN"
```

---

## 7. Obtener Override por ID

```bash
curl -X GET "http://localhost:3000/api/v1/multiplier-overrides/OVERRIDE-UUID" \
  -H "Authorization: Bearer $TOKEN"
```

---

## 8. Actualizar Override (cambiar multiplicador)

```bash
curl -X PUT "http://localhost:3000/api/v1/multiplier-overrides/OVERRIDE-UUID" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "baseMultiplierX": 85.0
  }'
```

---

## 9. Desactivar Override (Soft Delete)

```bash
curl -X DELETE "http://localhost:3000/api/v1/multiplier-overrides/OVERRIDE-UUID" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "deletedReason": "Cambio de política comercial"
  }'
```

---

## 10. Restaurar Override

```bash
curl -X PATCH "http://localhost:3000/api/v1/multiplier-overrides/OVERRIDE-UUID/restore" \
  -H "Authorization: Bearer $TOKEN"
```

---

## 11. Actualizar Estado del Override

```bash
curl -X PUT "http://localhost:3000/api/v1/multiplier-overrides/OVERRIDE-UUID" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "isActive": false
  }'
```

---

## 12. Actualizar Multiplicador y Estado Simultáneamente

```bash
curl -X PUT "http://localhost:3000/api/v1/multiplier-overrides/OVERRIDE-UUID" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "baseMultiplierX": 90.0,
    "isActive": true
  }'
```

---

## Casos de Error

### Error 400 - Validación Fallida

```bash
# Scope inválido
curl -X POST http://localhost:3000/api/v1/multiplier-overrides \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "scope": "INVALID",
    "scopeId": "uuid",
    "loteriaId": "uuid",
    "multiplierType": "NUMERO",
    "baseMultiplierX": 75.5
  }'
```

**Respuesta**:
```json
{
  "success": false,
  "message": "Hay errores de validación en body...",
  "meta": {
    "details": [
      {
        "field": "scope",
        "code": "invalid_enum_value",
        "issue": "..."
      }
    ]
  }
}
```

---

### Error 409 - Override Duplicado

```bash
# Intentar crear el mismo override dos veces
curl -X POST http://localhost:3000/api/v1/multiplier-overrides \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "scope": "USER",
    "scopeId": "MISMO-USER-UUID",
    "loteriaId": "MISMA-LOTERIA-UUID",
    "multiplierType": "NUMERO",
    "baseMultiplierX": 75.5
  }'
```

**Respuesta**:
```json
{
  "success": false,
  "message": "A multiplier override already exists for this user, loteria, and multiplier type",
  "statusCode": 409
}
```

---

### Error 403 - No Autorizado

```bash
# VENTANA intentando modificar un usuario de otra ventana
curl -X POST http://localhost:3000/api/v1/multiplier-overrides \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN_VENTANA" \
  -d '{
    "scope": "USER",
    "scopeId": "USER-DE-OTRA-VENTANA",
    "loteriaId": "loteria-uuid",
    "multiplierType": "NUMERO",
    "baseMultiplierX": 75.5
  }'
```

**Respuesta**:
```json
{
  "success": false,
  "message": "Not allowed to manage this user",
  "statusCode": 403
}
```

---

### Error 404 - Recurso No Encontrado

```bash
# Override que no existe
curl -X GET "http://localhost:3000/api/v1/multiplier-overrides/00000000-0000-0000-0000-000000000000" \
  -H "Authorization: Bearer $TOKEN"
```

**Respuesta**:
```json
{
  "success": false,
  "message": "Multiplier override not found",
  "statusCode": 404
}
```

---

## Verificar Jerarquía de Resolución

Para probar que la jerarquía de resolución funciona correctamente:

### 1. Crear un ticket SIN override de usuario ni ventana
```bash
# Debe usar BancaLoteriaSetting o defaults
curl -X POST http://localhost:3000/api/v1/tickets \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "loteriaId": "loteria-uuid",
    "sorteoId": "sorteo-uuid",
    "ventanaId": "ventana-uuid",
    "jugadas": [
      {
        "type": "NUMERO",
        "number": "42",
        "amount": 100
      }
    ]
  }'
```

### 2. Crear override para VENTANA y crear ticket
```bash
# 1. Crear override
curl -X POST http://localhost:3000/api/v1/multiplier-overrides \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "scope": "VENTANA",
    "scopeId": "ventana-uuid",
    "loteriaId": "loteria-uuid",
    "multiplierType": "NUMERO",
    "baseMultiplierX": 80.0
  }'

# 2. Crear ticket (debe usar 80.0)
curl -X POST http://localhost:3000/api/v1/tickets \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "loteriaId": "loteria-uuid",
    "sorteoId": "sorteo-uuid",
    "ventanaId": "ventana-uuid",
    "jugadas": [
      {
        "type": "NUMERO",
        "number": "42",
        "amount": 100
      }
    ]
  }'

# Verificar que finalMultiplierX = 80.0 y totalAmount = 100 * 80.0 = 8000
```

### 3. Crear override para USER (debe tener prioridad sobre VENTANA)
```bash
# 1. Crear override de usuario
curl -X POST http://localhost:3000/api/v1/multiplier-overrides \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "scope": "USER",
    "scopeId": "user-uuid",
    "loteriaId": "loteria-uuid",
    "multiplierType": "NUMERO",
    "baseMultiplierX": 90.0
  }'

# 2. Crear ticket con el mismo usuario (debe usar 90.0, NO 80.0)
curl -X POST http://localhost:3000/api/v1/tickets \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN_USER" \
  -d '{
    "loteriaId": "loteria-uuid",
    "sorteoId": "sorteo-uuid",
    "ventanaId": "ventana-uuid",
    "jugadas": [
      {
        "type": "NUMERO",
        "number": "42",
        "amount": 100
      }
    ]
  }'

# Verificar que finalMultiplierX = 90.0 y totalAmount = 100 * 90.0 = 9000
```

---

## Tips de Debugging

### Ver logs del servidor
Los logs mostrarán la resolución del multiplicador:
```
INFO: BASE_MULTIPLIER_RESOLVED {
  bancaId: "...",
  loteriaId: "...",
  userId: "...",
  effectiveBaseX: 90.0,
  source: "multiplierOverride[scope=USER]"
}
```

### Verificar en base de datos
```sql
-- Ver todos los overrides activos
SELECT
  id,
  scope,
  COALESCE(u.name, v.name) as target_name,
  l.name as loteria_name,
  "multiplierType",
  "baseMultiplierX",
  "isActive"
FROM "MultiplierOverride" mo
LEFT JOIN "User" u ON mo."userId" = u.id
LEFT JOIN "Ventana" v ON mo."ventanaId" = v.id
LEFT JOIN "Loteria" l ON mo."loteriaId" = l.id
WHERE "isActive" = true;

-- Ver jerarquía para un usuario/ventana/lotería específica
SELECT
  scope,
  "baseMultiplierX",
  "multiplierType",
  "isActive"
FROM "MultiplierOverride"
WHERE
  (scope = 'USER' AND "userId" = 'user-uuid-here')
  OR (scope = 'VENTANA' AND "ventanaId" = 'ventana-uuid-here')
  AND "loteriaId" = 'loteria-uuid-here'
  AND "multiplierType" = 'NUMERO'
  AND "isActive" = true
ORDER BY
  CASE scope
    WHEN 'USER' THEN 1
    WHEN 'VENTANA' THEN 2
  END;
```

---

## Notas Finales

- Todos los endpoints requieren autenticación (`Authorization: Bearer <token>`)
- Los UUIDs deben ser válidos (formato UUID v4)
- El `baseMultiplierX` debe ser > 0 y <= 9999
- El `scope` solo acepta "USER" o "VENTANA"
- El `multiplierType` actualmente acepta "NUMERO" o "REVENTADO" pero es extensible
- Los filtros en GET son todos opcionales y se pueden combinar
- La paginación por defecto es page=1, pageSize=10
