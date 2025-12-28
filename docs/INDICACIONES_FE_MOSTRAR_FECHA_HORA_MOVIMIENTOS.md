# Indicaciones FE: Mostrar Fecha y Hora de Movimientos

## Problema Actual

El FE está mostrando la fecha y hora de `createdAt` en lugar de usar los campos `date` y `time` que el backend envía en la respuesta intercalada.

## Solución

### Campos Disponibles en la Respuesta

El backend envía en cada movimiento intercalado:

```typescript
{
  sorteoId: string;
  sorteoName: string;
  scheduledAt: string; // ISO string UTC (para ordenamiento)
  date: string;        // ✅ USAR ESTE: "YYYY-MM-DD" (fecha del movimiento)
  time: string;        // ✅ USAR ESTE: "6:00PM " o "1:17AM " (hora formateada 12h)
  balance: number;
  accumulated: number;
  // ... otros campos
}
```

### Cambios Requeridos en el FE

#### 1. **Usar `date` en lugar de `createdAt`**

**❌ INCORRECTO:**
```typescript
// NO usar createdAt para mostrar la fecha
const displayDate = formatDate(movement.createdAt);
```

**✅ CORRECTO:**
```typescript
// Usar el campo date que viene del backend
const displayDate = formatDate(movement.date); // "2025-12-27"
```

#### 2. **Usar `time` tal cual viene del backend**

**❌ INCORRECTO:**
```typescript
// NO formatear desde createdAt
const displayTime = formatTime(movement.createdAt);
```

**✅ CORRECTO:**
```typescript
// Usar el campo time que ya viene formateado del backend
const displayTime = movement.time; // "6:00PM " o "1:17AM "
```

#### 3. **Formatear `date` de YYYY-MM-DD a DD/MM/YYYY**

El backend envía `date` en formato `"YYYY-MM-DD"` (ej: `"2025-12-27"`). El FE debe convertirlo a `"DD/MM/YYYY"` para mostrar:

```typescript
function formatDateForDisplay(dateStr: string): string {
  // dateStr viene como "2025-12-27"
  const [year, month, day] = dateStr.split('-');
  return `${day}/${month}/${year}`; // "27/12/2025"
}

// Uso:
const displayDate = formatDateForDisplay(movement.date);
const displayTime = movement.time.trim(); // Remover espacio final si existe
```

### Ejemplo Completo

```typescript
// Componente que muestra movimientos intercalados
function MovementItem({ movement }: { movement: SorteoOrMovement }) {
  // ✅ Usar date del movimiento (NO createdAt)
  const displayDate = formatDateForDisplay(movement.date);
  
  // ✅ Usar time del movimiento (ya viene formateado)
  const displayTime = movement.time.trim();
  
  return (
    <div>
      <span>{movement.sorteoName}</span>
      <span>{displayDate} {displayTime}</span>
      {/* Ejemplo: "27/12/2025 6:00PM" */}
    </div>
  );
}
```

### Validación

Para verificar que está funcionando correctamente:

1. **Registrar un pago/cobro con fecha y hora específicas:**
   - Fecha: `2025-12-27`
   - Hora: `18:00`

2. **Verificar en el FE:**
   - Debe mostrar: `27/12/2025 6:00PM`
   - NO debe mostrar: `28/12/2025 1:17AM` (que sería createdAt)

3. **Verificar en la respuesta del backend:**
   ```json
   {
     "date": "2025-12-27",
     "time": "6:00PM ",
     "scheduledAt": "2025-12-28T00:00:00.000Z"
   }
   ```

### Notas Importantes

1. **`scheduledAt`**: Es solo para ordenamiento interno, NO debe usarse para mostrar fecha/hora al usuario.

2. **`time` ya viene formateado**: El backend ya convierte `"18:00"` a `"6:00PM "`, no es necesario formatear en el FE.

3. **Espacio final en `time`**: El backend puede incluir un espacio al final (`"6:00PM "`), usar `.trim()` si es necesario.

4. **Cuando no hay `time`**: Si el movimiento no tiene `time` especificado, el backend usa `createdAt` convertido a CR y lo formatea. En ese caso, `time` será algo como `"1:17AM "`.

### Checklist de Implementación

- [ ] Reemplazar uso de `createdAt` por `date` para mostrar fecha
- [ ] Reemplazar formateo de `createdAt` por uso directo de `time`
- [ ] Implementar función `formatDateForDisplay` para convertir `YYYY-MM-DD` a `DD/MM/YYYY`
- [ ] Verificar que se muestre correctamente: `27/12/2025 6:00PM` para el ejemplo
- [ ] Probar con movimientos que tienen `time` especificado
- [ ] Probar con movimientos que NO tienen `time` (debe usar createdAt convertido)

### Ejemplo de Respuesta del Backend

```json
{
  "sorteoId": "mov-dd569641-a62b-466a-9fa2-b1ede76b5910",
  "sorteoName": "Cobro realizado",
  "scheduledAt": "2025-12-28T00:00:00.000Z",
  "date": "2025-12-27",
  "time": "6:00PM ",
  "balance": -89775,
  "accumulated": 0,
  "chronologicalIndex": 1,
  "totalChronological": 10
}
```

El FE debe mostrar: **"27/12/2025 6:00PM"**

