# JWT Transition Plan - RBAC ventanaId Fix

## Situación Actual

✅ **Base de Datos**: Todos los usuarios VENTANA tienen `ventanaId` asignado correctamente
❌ **JWT Tokens**: Algunos usuarios tienen JWT antiguos con `ventanaId: null`

## Solución Implementada: Modo Permisivo

### Fase 1: Modo Permisivo (ACTUAL - Commit 0e705e6)

**Comportamiento**:
- `validateVentanaUser()` registra WARNING pero NO lanza error 403
- Usuarios con JWT antiguo (ventanaId: null) pueden seguir trabajando
- Se registra en logs cada vez que un usuario con JWT antiguo hace una request

**Log de ejemplo**:
```json
{
  "layer": "rbac",
  "action": "VENTANA_USER_NO_VENTANAID",
  "payload": {
    "userId": "fbb28b4d-507e-4051-8472-80936b7fedcb",
    "role": "VENTANA",
    "ventanaId": null,
    "message": "VENTANA user has null ventanaId - JWT needs refresh (logout/login)",
    "recommendation": "User should logout and login again to get updated JWT"
  }
}
```

**Ventajas**:
- ✅ No interrumpe el trabajo de usuarios activos
- ✅ Transición gradual y controlada
- ✅ Monitoring de qué usuarios necesitan renovar JWT

### Fase 2: Modo Estricto (FUTURO)

**Cuándo activar**: Después de que todos los usuarios hayan renovado su JWT

**Cómo verificar**:
```bash
# Revisar logs del último día
grep "VENTANA_USER_NO_VENTANAID" logs/app.log

# Si no hay entradas en las últimas 24 horas, es seguro cambiar a modo estricto
```

**Cómo activar modo estricto**:

1. Editar `src/utils/rbac.ts`
2. En la función `validateVentanaUser()`, descomentar el bloque:
   ```typescript
   /*
   throw new AppError('VENTANA user must have ventanaId assigned', 403, {
     code: 'RBAC_003',
     details: [...]
   });
   */
   ```
3. Comentar o eliminar el bloque de `logger.warn()`
4. Commit y deploy

## Plan de Transición

### Opción A: Natural (Recomendada)

Esperar a que usuarios renueven JWT naturalmente:

1. **Deploy código actual** (modo permisivo)
2. **Monitorear logs** diariamente:
   ```bash
   # Contar usuarios únicos con JWT antiguo
   grep "VENTANA_USER_NO_VENTANAID" logs/app.log | \
     jq -r '.payload.userId' | \
     sort -u | \
     wc -l
   ```
3. **Después de 7 días** (expiración típica de JWT):
   - La mayoría de usuarios habrán renovado su JWT
   - Revisar logs para confirmar
4. **Activar modo estricto** cuando logs estén limpios

**Tiempo estimado**: 7-14 días

### Opción B: Forzada (Rápida pero disruptiva)

Forzar renovación inmediata de todos los JWT:

1. **Deploy código actual** (modo permisivo)
2. **Invalidar todos los JWT**:
   ```sql
   -- Opción 1: Cambiar JWT_SECRET en .env (invalida TODOS los tokens)
   -- Opción 2: Agregar campo "tokenVersion" y incrementarlo
   ```
3. **Notificar usuarios**: "Por favor haga logout y login nuevamente"
4. **Esperar 1 hora** para que usuarios se re-autentiquen
5. **Activar modo estricto** inmediatamente

**Tiempo estimado**: 1 día

### Opción C: Híbrida (Recomendada para producción)

Combinar ambos enfoques:

1. **Semana 1**: Modo permisivo + monitoreo
2. **Semana 2**: Notificación a usuarios con JWT antiguo (vía UI banner)
3. **Semana 3**: Modo estricto para nuevos logins, permisivo para antiguos
4. **Semana 4**: Modo estricto para todos

## Monitoreo

### Dashboard de Logs

Query para ver usuarios afectados:
```bash
# Últimas 24 horas
grep "VENTANA_USER_NO_VENTANAID" logs/app-$(date +%Y-%m-%d).log | \
  jq -r '.payload.userId' | \
  sort -u

# Por usuario (cuántas requests)
grep "VENTANA_USER_NO_VENTANAID" logs/app-$(date +%Y-%m-%d).log | \
  jq -r '.payload.userId' | \
  sort | \
  uniq -c | \
  sort -nr
```

### Métricas Recomendadas

1. **Total de warnings por día**
2. **Usuarios únicos con JWT antiguo**
3. **Requests bloqueadas** (cuando se active modo estricto)

## Rollback Plan

Si necesitas volver atrás:

```bash
# Revertir último commit (modo estricto)
git revert HEAD

# O revertir ambos commits (volver a versión original)
git revert HEAD~1..HEAD

# Deploy
git push origin master
```

## Testing

### Test Manual - Modo Permisivo

1. Login como usuario VENTANA
2. Hacer request a `/ventas/breakdown?dimension=vendedor`
3. Verificar:
   - ✅ Request exitosa (200 OK)
   - ✅ Warning en logs
   - ✅ Datos filtrados correctamente (solo su ventana)

### Test Manual - Modo Estricto (Futuro)

1. Simular JWT antiguo (ventanaId: null en token)
2. Hacer request a `/ventas/breakdown`
3. Verificar:
   - ✅ Error 403 Forbidden
   - ✅ Código: RBAC_003
   - ✅ Mensaje claro: "Please logout and login again"

## Código Modificado

### Archivos en Modo Permisivo:
- `src/utils/rbac.ts` - validateVentanaUser() con logger.warn()
- `src/api/v1/controllers/dashboard.controller.ts` - Llamadas actualizadas

### Archivos para Modo Estricto (TODO):
- `src/utils/rbac.ts` - Descomentar throw AppError()

## Resumen

| Fase | Estado | Descripción | Acción Requerida |
|------|--------|-------------|------------------|
| **1. Modo Permisivo** | ✅ IMPLEMENTADO | Warnings sin bloqueo | Monitorear logs |
| **2. Transición** | 🟡 EN PROGRESO | Usuarios renovando JWT | Esperar 7-14 días |
| **3. Modo Estricto** | ⏳ PENDIENTE | Bloqueo con 403 | Descomentar código |

---

**Última actualización**: 2025-10-29
**Commit actual**: 0e705e6 (modo permisivo)
**Próximo paso**: Monitorear logs durante 7 días
