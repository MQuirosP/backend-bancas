# Activity Log - Esquema de Base de Datos y Limitaciones

## 📊 Definición de la Tabla

La tabla `ActivityLog` se define en Prisma como:

```prisma
model ActivityLog {
  id         String       @id @default(uuid()) @db.Uuid
  userId     String?      @db.Uuid
  action     ActivityType
  targetType String?
  targetId   String?
  details    Json?
  createdAt  DateTime     @default(now())

  user User? @relation(fields: [userId], references: [id])
}
```

## 🔍 Columnas Disponibles

| Columna | Tipo | Restricciones | Notas |
|---------|------|---------------|-------|
| `id` | UUID | PRIMARY KEY, @default(uuid()) | Identificador único, autogenerado |
| `userId` | UUID | NULLABLE, FK a User | Usuario que realizó la acción |
| `action` | ActivityType | NOT NULL | Enum de tipos de acciones |
| `targetType` | String | NULLABLE | Tipo de entidad afectada (USER, VENTANA, etc.) |
| `targetId` | String | NULLABLE | ID de la entidad afectada |
| `details` | JSON | NULLABLE | Información adicional específica |
| `createdAt` | DateTime | NOT NULL, @default(now()) | Timestamp automático |

## ⚠️ Limitaciones Actuales

### 1. **NO HAY LÍMITE DE REGISTROS**
- La tabla puede crecer indefinidamente
- PostgreSQL no tiene límite de filas por defecto
- En producción podría causar problemas de rendimiento si crece excesivamente

### 2. **NO HAY ÍNDICES DEFINIDOS EXPLÍCITAMENTE**
```
Campos SIN índices actualmente:
  ⚠️ userId     - Las búsquedas "por usuario" serán lentas con millones de registros
  ⚠️ action     - Las búsquedas por tipo de acción serán lentas
  ⚠️ targetType - Las búsquedas por entidad serán lentas
  ⚠️ targetId   - Las búsquedas por ID de entidad serán lentas
  ⚠️ createdAt  - Las búsquedas por rango de fechas serán lentas
```

### 3. **RETENCIÓN DE DATOS MANUAL**
- Solo hay endpoint `/cleanup` para eliminar logs antiguos (> N días)
- No hay limpieza automática programada
- El usuario debe ejecutar manualmente la limpieza

### 4. **SIN LÍMITE EN CAMPO `details` (JSON)**
- El campo JSON puede ser tan grande como sea necesario
- Podría impactar rendimiento si contiene objetos muy grandes
- No hay validación de tamaño máximo

## 🚨 Recomendaciones para Producción

### Inmediatas (CRÍTICAS)

#### 1. **Agregar Índices a la Tabla**
```sql
-- Crear índices para búsquedas frecuentes
CREATE INDEX idx_activitylog_userid ON "ActivityLog"(userId);
CREATE INDEX idx_activitylog_action ON "ActivityLog"(action);
CREATE INDEX idx_activitylog_targettype_targetid ON "ActivityLog"(targetType, targetId);
CREATE INDEX idx_activitylog_createdat ON "ActivityLog"(createdAt);
CREATE INDEX idx_activitylog_createdat_desc ON "ActivityLog"(createdAt DESC);
```

**Por qué**: Sin índices, las queries a millones de registros serán O(n) y muy lentas.

#### 2. **Configurar Limpieza Automática**
Opción A: Job cron en backend
```typescript
// Ejecutar cada noche a las 2 AM
cron.schedule('0 2 * * *', async () => {
  await ActivityService.cleanupOldLogs(90); // Mantener 90 días
});
```

Opción B: Trigger en PostgreSQL
```sql
CREATE OR REPLACE FUNCTION cleanup_old_activity_logs()
RETURNS void AS $$
BEGIN
  DELETE FROM "ActivityLog"
  WHERE "createdAt" < NOW() - INTERVAL '90 days';
END;
$$ LANGUAGE plpgsql;

-- Ejecutar diariamente
SELECT cron.schedule('cleanup-activity-logs', '0 2 * * *', 'SELECT cleanup_old_activity_logs()');
```

#### 3. **Particionamiento por Fecha (si crece mucho)**
```sql
-- Para tablas muy grandes (>1 millón de registros)
-- PostgreSQL permite particionamiento por rango de fechas
CREATE TABLE activity_log_2025_01 PARTITION OF "ActivityLog"
  FOR VALUES FROM ('2025-01-01') TO ('2025-02-01');
```

### Mediano Plazo

#### 4. **Monitoreo de Crecimiento**
```sql
-- Consulta para monitorear tamaño
SELECT
  schemaname,
  tablename,
  pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) as size
FROM pg_tables
WHERE tablename = 'ActivityLog';
```

#### 5. **Archiving de Logs Antiguos**
Considerar archivar (en otra tabla o data warehouse) logs más antiguos que 1 año:
```sql
-- Crear tabla de archivo
CREATE TABLE activity_log_archive AS
SELECT * FROM "ActivityLog"
WHERE "createdAt" < NOW() - INTERVAL '1 year';

-- Eliminar de tabla principal
DELETE FROM "ActivityLog"
WHERE "createdAt" < NOW() - INTERVAL '1 year';
```

#### 6. **Definir Retención en Política**
Documentar en el equipo:
- Mantener 90 días en tabla activa
- Archivar años anteriores
- Eliminar después de 3 años

### Largo Plazo

#### 7. **Considerar Data Warehouse**
Para análisis históricos, exportar logs a:
- PostgreSQL data warehouse
- Elasticsearch (búsquedas rápidas)
- Data Lake (S3 + Athena)

#### 8. **Implementar Rotación de Logs**
Similar a log rotation en aplicaciones:
```
activity_log_2025_01
activity_log_2025_02
activity_log_2025_03
... etc
```

## 📈 Estimación de Crecimiento

### Asumiendo:
- Plataforma activa con 50+ operaciones/día
- 5 acciones per usuario por día
- ~250 logs por día

**Proyección**:
```
1 semana:     ~1,750 logs       (~50 KB)
1 mes:        ~7,500 logs       (~200 KB)
1 trimestre:  ~22,500 logs      (~600 KB)
1 año:        ~90,000 logs      (~2.4 MB)
3 años:       ~270,000 logs     (~7.2 MB)
5 años:       ~450,000 logs     (~12 MB)
```

**Conclusión**: Con índices, incluso 1 millón de logs es manejable. Sin índices, después de 100K logs verás degradación de performance.

## 🔧 Acciones Recomendadas Inmediatas

### Antes de Producción:

1. **✅ Crear Migration con Índices**
```sql
-- En una nueva migration
CREATE INDEX idx_activitylog_userid ON "ActivityLog"(userId);
CREATE INDEX idx_activitylog_action ON "ActivityLog"(action);
CREATE INDEX idx_activitylog_target ON "ActivityLog"(targetType, targetId);
CREATE INDEX idx_activitylog_createdat ON "ActivityLog"(createdAt DESC);
```

2. **✅ Agregar Jobs Cron**
Configurar en tu sistema de jobs:
```bash
0 2 * * * curl -X POST https://api.example.com/api/v1/activity-logs/cleanup \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"days": 90}'
```

3. **✅ Documentar en README**
Indicar que la limpieza debe ejecutarse regularmente.

4. **✅ Monitoreo**
Agregar alertas si la tabla crece más de 500K registros.

## 📋 Resumen de Restricciones

| Restricción | Valor Actual | Recomendado | Impacto |
|-------------|--------------|-------------|---------|
| **Límite de Registros** | Infinito | 90 días (rotación) | ⚠️ CRÍTICO |
| **Índices** | Ninguno | 4+ índices | ⚠️ CRÍTICO |
| **Retención** | Manual | Automática | ⚠️ MEDIO |
| **Tamaño Campo details** | Sin límite | 5KB máximo | ⚠️ BAJO |
| **Limpieza Automática** | No | Sí (cron) | ⚠️ MEDIO |

## ✅ Checklist Pre-Producción

- [ ] Crear índices en ActivityLog
- [ ] Configurar limpieza automática (cron job)
- [ ] Documentar política de retención
- [ ] Configurar monitoreo de tamaño de tabla
- [ ] Pruebas de carga (1M registros)
- [ ] Verificar rendimiento de queries
- [ ] Plan de archiving definido

---

**Nota**: Estas son recomendaciones estándar para tablas de auditoría. Sin estas medidas, el rendimiento degradará en 6-12 meses con uso en producción.
