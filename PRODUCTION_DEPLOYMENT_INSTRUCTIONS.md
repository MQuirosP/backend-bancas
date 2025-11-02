# 🚀 Activity Log System - Instrucciones de Despliegue en Producción

**IMPORTANTE**: Este documento contiene instrucciones específicas para desplegar el sistema de Activity Log en producción de forma SEGURA.

---

## ⚠️ ANTES DE EMPEZAR

1. **✅ HACER BACKUP DE BASE DE DATOS COMPLETO**
   ```bash
   # En el servidor de producción
   pg_dump -h $DB_HOST -U $DB_USER -d $DB_NAME -Fc > activity_log_backup_$(date +%Y%m%d_%H%M%S).dump

   # Copiar el backup a lugar seguro
   scp activity_log_backup_*.dump backup_server:/backups/
   ```

2. **✅ NOTIFICAR AL EQUIPO**
   - Decir que se desplegará Activity Log
   - Explicar que el sistema eliminará automáticamente logs > 45 días
   - Agendar mantenimiento si es necesario

3. **✅ PROBAR EN STAGING PRIMERO**
   - Aplicar cambios en staging
   - Ejecutar job de limpieza manualmente
   - Verificar que funciona correctamente

---

## 📋 PASO A PASO PARA PRODUCCIÓN

### PASO 1: Hacer Merge a Master (si no está ya hecho)

```bash
# En tu rama local
git checkout master
git pull origin master
git merge feature/activity-log-audit --no-ff -m "feat: add activity log system with auto cleanup"
git push origin master
```

### PASO 2: Desplegar Código a Producción

Sigue tu procedimiento estándar de deployment:
```bash
# Ejemplo con GitHub Actions o tu CI/CD
git pull origin master  # En servidor de prod
npm ci  # Instalar dependencias exactas
npm run build  # Compilar si es necesario
```

### PASO 3: Aplicar Migrations (⚠️ CRÍTICO - HACER CON CUIDADO)

```bash
# En servidor de producción, conectarte como usuario que gestiona BD

# Opción A: Usar npx prisma
npx dotenv -e .env.production -- npx prisma migrate deploy

# Opción B: Si prefieres hacerlo manualmente (más seguro)
# Conectarte a BD directamente
psql -h $DB_HOST -U $DB_USER -d $DB_NAME << 'EOF'
-- Ver si indices ya existen
\di "idx_activitylog_*"

-- Si no existen, crearlos (SEGURO - no modifica datos)
CREATE INDEX idx_activitylog_userid ON "ActivityLog"("userId");
CREATE INDEX idx_activitylog_action ON "ActivityLog"("action");
CREATE INDEX idx_activitylog_target ON "ActivityLog"("targetType", "targetId");
CREATE INDEX idx_activitylog_createdat_desc ON "ActivityLog"("createdAt" DESC);

-- Verificar que se crearon
\di "idx_activitylog_*"
EOF
```

**⚠️ IMPORTANTE**:
- La creation de índices es **SEGURA** en PostgreSQL 11+
- No bloquea escrituras
- No modifica datos
- Puede tomar unos minutos en tabla grande

### PASO 4: Agregr Job de Limpieza en el Main File

En tu archivo principal (ej: `src/main.ts`, `src/server.ts`, `src/app.ts`):

```typescript
// En el top del archivo, agregar import:
import { startActivityLogCleanupJob } from './jobs/activityLogCleanup.job';

// En donde inicializas el servidor (app.listen o similar):
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);

  // ← AGREGAR ESTA LÍNEA:
  startActivityLogCleanupJob();

  console.log(`📋 Activity Log cleanup job started (runs daily at 2 AM UTC)`);
});
```

### PASO 5: Reiniciar el Servidor

```bash
# Depende de tu setup:

# Si usas PM2:
pm2 restart all  # o pm2 restart app-name

# Si usas systemd:
sudo systemctl restart backend-service

# Si usas Docker:
docker restart backend-container

# Si usas AWS/Heroku:
# Usar dashboard o: heroku restart --app backend-prod
```

### PASO 6: Verificar que Funciona

```bash
# Ver logs de la aplicación
tail -f /var/log/backend/app.log

# Buscar estos mensajes:
# ✅ "[Activity Log Cleanup] Job scheduled to run at ..."

# O ejecutar limpieza manual para testing:
curl -X POST https://api.production.com/api/v1/activity-logs/cleanup \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"days": 45}'

# Respuesta esperada:
# {"success": true, "data": {"message": "Se eliminaron X registros...", "deletedCount": X}}
```

---

## 📊 Monitoreo Post-Despliegue

### Primeras 24 Horas

1. **Verificar Índices**
   ```bash
   psql -h $DB_HOST -U $DB_USER -d $DB_NAME << 'EOF'
   -- Ver info de los índices creados
   SELECT indexname, tablename FROM pg_indexes
   WHERE indexname LIKE 'idx_activitylog%';

   -- Ver tamaño de tabla antes
   SELECT pg_size_pretty(pg_total_relation_size('"ActivityLog"'));
   EOF
   ```

2. **Monitorear Logs de Aplicación**
   ```bash
   # Buscar mensajes del cleanup job
   grep "Activity Log Cleanup" /var/log/backend/app.log

   # Debe mostrar algo como:
   # [Activity Log Cleanup] Job scheduled to run at 2025-11-03T02:00:00.000Z
   ```

3. **Testear Endpoint Manual** (opcional, para confirmar)
   ```bash
   curl -X POST https://api.production.com/api/v1/activity-logs/cleanup \
     -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"days": 45}'
   ```

### Próximas 72 Horas

1. **A las 2 AM UTC (próxima noche)**
   - Revisar logs: el job debe ejecutarse automáticamente
   - Verificar que se eliminaron logs antiguos correctamente
   - Buscar cualquier error en logs

2. **Verificar Performance de Queries**
   ```bash
   # Las queries deben ser más rápidas ahora
   # Verificar en monitoring tool (DataDog, New Relic, etc)

   # O en postgres manualmente:
   EXPLAIN ANALYZE SELECT * FROM "ActivityLog"
   WHERE "userId" = 'some-id'
   AND "createdAt" > NOW() - INTERVAL '45 days';

   # Debe usar el índice idx_activitylog_userid
   ```

3. **Monitorear Tamaño de Tabla**
   ```bash
   psql -h $DB_HOST -U $DB_USER -d $DB_NAME << 'EOF'
   SELECT
     count(*) as total_records,
     pg_size_pretty(pg_total_relation_size('"ActivityLog"')) as table_size
   FROM "ActivityLog";
   EOF
   ```

---

## 🆘 TROUBLESHOOTING

### Problema: "Migration already applied"
**Solución**: Normal, significa que alguien ya aplicó la migration. Verificar que los índices existen:
```bash
psql -h $DB_HOST -U $DB_USER -d $DB_NAME -c "\di idx_activitylog_*"
```

### Problema: El job no se ejecutó a las 2 AM
**Verificar**:
1. ¿El servidor está corriendo? → `ps aux | grep node`
2. ¿`startActivityLogCleanupJob()` está en main.ts? → Revisar archivo
3. ¿Hay errores en logs? → `grep ERROR /var/log/backend/app.log`

**Solución**:
- Reiniciar servidor: `pm2 restart app-name`
- Ejecutar manual: `curl -X POST /api/v1/activity-logs/cleanup ...`

### Problema: Se eliminaron logs que no debería

**EMERGENCIA - ROLLBACK INMEDIATO**:
```bash
# 1. Detener servidor
pm2 stop all

# 2. Restaurar desde backup
pg_restore -h $DB_HOST -U $DB_USER -d $DB_NAME < activity_log_backup_YYYYMMDD_HHMMSS.dump

# 3. Verificar que se restauraron
psql -h $DB_HOST -U $DB_USER -d $DB_NAME -c "SELECT COUNT(*) FROM \"ActivityLog\";"

# 4. Comentar startActivityLogCleanupJob() en main.ts
# 5. Reiniciar servidor
pm2 start all

# 6. Investigar qué salió mal
```

### Problema: Índices ralentizan el servidor
**Muy raro**, pero si ocurre:
```bash
# Los índices pueden usarse o no
# PostgreSQL elige automáticamente la mejor estrategia

# Si necesitas dropear un índice:
psql -h $DB_HOST -U $DB_USER -d $DB_NAME << 'EOF'
DROP INDEX idx_activitylog_userid;
-- etc
EOF

# Pero NO hagas esto sin consultar - los índices son beneficiosos
```

---

## 📈 Resultados Esperados

### Después de la Implementación:

| Métrica | Antes | Después |
|---------|-------|---------|
| Tamaño tabla | Crece indefinidamente | Máximo ~300 KB (45 días) |
| Registros máx | 1M+ después de 5 años | ~11,250 (constante) |
| Query por usuario | Lenta (sin índice) | Rápida (< 10ms) |
| Query por fecha | Lenta (sin índice) | Rápida (< 50ms) |
| Limpieza | Manual | Automática cada noche |
| Logs perdidos | NUNCA | Solo después de 45 días |

---

## ✅ Checklist Completo

### Antes del Despliegue
- [ ] Backup de BD hecho y verificado
- [ ] Cambios testeados en staging
- [ ] Team notificado
- [ ] startActivityLogCleanupJob() agregado a main.ts
- [ ] Variables de entorno configuradas

### Durante el Despliegue
- [ ] Código mergeado a master
- [ ] Código desplegado en servidor
- [ ] Migrations aplicadas sin errores
- [ ] Servidor reiniciado
- [ ] Logs muestran que job fue scheduled

### Después del Despliegue
- [ ] Índices existen en BD (verificar con \di)
- [ ] Cleanup job se ejecutó o fue testeado manualmente
- [ ] No hay errores en logs
- [ ] Performance de queries es bueno
- [ ] Monitoreo/alertas configurado

---

## 🔄 Rollback Rápido

Si algo sale mal:

```bash
# 1. Detener el job inmediatamente
# Comentar en main.ts:
// startActivityLogCleanupJob();

# 2. Deployment de código viejo
git revert HEAD
npm run build
# Deploy

# 3. Si la BD fue corrupta, restaurar
pg_restore -d $DB_NAME < activity_log_backup_YYYYMMDD.dump

# 4. Reiniciar
pm2 restart all
```

---

## 📞 Contacto y Soporte

Si algo falla en producción:

1. **Verificar logs**: `grep "Activity Log" /var/log/backend/app.log`
2. **Verificar BD**: Ver si índices existen
3. **Contactar**: Team backend/devops
4. **Documentación**: [docs/ACTIVITY_LOG_CLEANUP_SETUP.md](docs/ACTIVITY_LOG_CLEANUP_SETUP.md)

---

## 📋 Resumen de Cambios

```
Migration:    src/prisma/migrations/20251102_add_indices_to_activity_log/
              Crea 4 índices (100% seguro)

Job:          src/jobs/activityLogCleanup.job.ts
              Limpieza automática a 45 días, diario a 2 AM UTC

Service:      src/api/v1/services/activityLog.service.ts
              Default retention: 90 días → 45 días

Config:       Agregar startActivityLogCleanupJob() en main.ts

Docs:         docs/ACTIVITY_LOG_CLEANUP_SETUP.md (completa)
```

---

**Status**: ✅ Listo para despliegue en producción
**Fecha**: 2 de Noviembre, 2025
**Responsable**: Backend & DevOps
**Criticidad**: Media (mejora, no fix de bug crítico)
