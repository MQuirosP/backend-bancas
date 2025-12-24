# Análisis Profundo de Restricciones y Creación de Tickets

## 📋 Resumen Ejecutivo

Análisis completo del sistema de restricciones y validaciones que se aplican **ANTES** de crear tickets. La exclusión de listas (`SorteoListaExclusion`) se aplica **DESPUÉS** de la creación y no forma parte de este análisis.

---

## ✅ Validaciones Preventivas que Funcionan Correctamente

### 1. **RestrictionRule - Límites de Montos**

#### 1.1. **maxAmount (Límite por número por ticket)**
- **Ubicación**: `src/repositories/ticket.repository.ts` líneas 921-963, 1007-1048
- **Funcionamiento**: 
  - Valida el monto total de un número específico en un ticket individual
  - Se aplica por número, no por total del ticket
  - Respeta `multiplierId` si está en la regla (solo cuenta jugadas con ese multiplicador)
  - Excluye jugadas inactivas (`isActive: false`)
  - Soporta límites dinámicos (baseAmount + salesPercentage)

**Ejemplo**:
```typescript
// Regla: maxAmount = 1000 para número "15" con multiplicador "Base"
// Ticket intenta: número "15" con multiplicador "Base" por 1500
// Resultado: ❌ BLOQUEADO - excede límite por ticket
```

#### 1.2. **maxTotal (Límite acumulado por número en el sorteo)**
- **Ubicación**: `src/repositories/ticket.repository.ts` líneas 967-995, 1052-1080
- **Funcionamiento**:
  - Valida el acumulado total de un número específico en el sorteo
  - Calcula: `acumulado previo + monto del ticket <= maxTotal`
  - Se aplica por número individual, NO por total del ticket
  - Soporta límites dinámicos
  - Respeta `multiplierId` si está en la regla

**Ejemplo**:
```typescript
// Regla: maxTotal = 5000 para número "20"
// Ya vendido en sorteo: 3000 para número "20"
// Ticket intenta: número "20" por 2500
// Resultado: ❌ BLOQUEADO - nuevo acumulado (5500) excede límite
```

**Implementación clave**: Usa `calculateAccumulatedByNumbersAndScope` que consulta directamente la BD para obtener acumulados precisos por sorteo.

#### 1.3. **Límites Dinámicos (baseAmount + salesPercentage)**
- **Ubicación**: `src/repositories/ticket.repository.ts` líneas 892-908
- **Funcionamiento**:
  - Calcula límite dinámico = `baseAmount + (ventas del sorteo * salesPercentage / 100)`
  - Las ventas se calculan sobre el **sorteo específico**, no el día completo
  - Soporta `appliesToVendedor` (calcular sobre ventas del vendedor vs ventana)
  - El límite efectivo es `min(staticLimit, dynamicLimit)`

**Ejemplo**:
```typescript
// Regla: baseAmount = 1000, salesPercentage = 10%, appliesToVendedor = false
// Ventas del sorteo (ventana): 5000
// Límite dinámico = 1000 + (5000 * 10 / 100) = 1500
// maxTotal estático = 2000
// Límite efectivo = min(2000, 1500) = 1500
```

#### 1.4. **Prioridad Jerárquica**
- **Ubicación**: `src/repositories/ticket.repository.ts` líneas 509-534
- **Orden de prioridad**: USER > VENTANA > BANCA
- **Cálculo de score**: 
  - USER: +100
  - VENTANA: +10
  - BANCA: +1
  - Número específico: +1000
  - Loteria/Multiplicador: +10000
- **Comportamiento**: Se aplican TODAS las reglas aplicables, no solo la de mayor prioridad

#### 1.5. **isAutoDate (Número automático por día)**
- **Ubicación**: `src/repositories/helpers/ticket-restriction.helper.ts` líneas 212-238
- **Funcionamiento**:
  - Si `isAutoDate = true`, el número se resuelve al día del mes actual (CR timezone)
  - Ejemplo: Si hoy es día 15, el número es "15"
  - Permite crear reglas que se aplican automáticamente según la fecha

#### 1.6. **Filtro por Multiplicador**
- **Ubicación**: `src/repositories/ticket.repository.ts` líneas 929, 975, 1015, 1064
- **Funcionamiento**:
  - Si la regla tiene `multiplierId`, solo se aplica a jugadas con ese multiplicador
  - Para jugadas NUMERO: filtra por `j.multiplierId === rule.multiplierId`
  - Para jugadas REVENTADO: se excluyen si la regla tiene `multiplierId` (REVENTADO no tiene multiplicador directo)

---

### 2. **LotteryMultiplierRule - Restricción de Multiplicadores**

#### 2.1. **Lógica de Bloqueo vs Límites**
- **Ubicación**: `src/repositories/ticket.repository.ts` líneas 766-869
- **Funcionamiento**:
  - Si la regla NO tiene `maxAmount` NI `maxTotal`: BLOQUEA completamente (rechaza la venta)
  - Si la regla tiene `maxAmount` O `maxTotal`: PERMITE la venta y valida límites después
  - Permite flexibilidad: se puede restringir un multiplicador completamente o solo limitarlo

**Ejemplo de bloqueo total**:
```typescript
// Regla: loteriaId + multiplierId (sin maxAmount ni maxTotal)
// Resultado: ❌ BLOQUEADO - multiplicador restringido completamente
```

**Ejemplo de límite**:
```typescript
// Regla: loteriaId + multiplierId + maxTotal = 5000
// Resultado: ✅ PERMITIDO - pero validará límite acumulado después
```

#### 2.2. **Bypass para ADMIN**
- **Ubicación**: `src/repositories/ticket.repository.ts` líneas 796-833
- **Funcionamiento**:
  - Si el `actorRole === Role.ADMIN`, no bloquea, solo emite warning
  - El ticket se crea pero con un warning en la respuesta
  - Útil para casos especiales donde un admin necesita forzar una venta

---

### 3. **Cutoff (salesCutoffMinutes) - Bloqueo por Tiempo**

#### 3.1. **Validación de Tiempo**
- **Ubicación**: `src/api/v1/services/ticket.service.ts` líneas 168-228
- **Funcionamiento**:
  - Calcula `limitTime = sorteo.scheduledAt - cutoffMinutes`
  - Aplica grace period: `effectiveLimitTime = limitTime + CUTOFF_GRACE_MS`
  - Si `now >= effectiveLimitTime`: ❌ BLOQUEADO

#### 3.2. **Resolución Jerárquica**
- **Ubicación**: `src/repositories/restrictionRule.repository.ts`
- **Orden de prioridad**: USER > VENTANA > BANCA > DEFAULT
- **Fuente DEFAULT**: `Banca.salesCutoffMinutes` o valor por defecto del sistema

#### 3.3. **Grace Period**
- **Constante**: `CUTOFF_GRACE_MS` (probablemente 1-2 minutos)
- **Propósito**: Permite pequeñas variaciones de tiempo sin bloquear ventas válidas

---

### 4. **RulesJson de Lotería - Reglas Globales**

#### 4.1. **Horarios de Venta (salesHours)**
- **Ubicación**: `src/api/v1/services/ticket.service.ts` línea 264
- **Funcionamiento**:
  - Valida que la hora actual esté dentro del rango permitido
  - Ejemplo: `salesHours: { start: "06:00", end: "22:00" }`
  - Usa timezone CR para comparar

#### 4.2. **Tipos de Apuesta Permitidos (allowedBetTypes)**
- **Ubicación**: `src/repositories/ticket.repository.ts` líneas 543-575
- **Funcionamiento**:
  - Si está definido, solo permite tipos en el array
  - Ejemplo: `allowedBetTypes: ["NUMERO"]` bloquea REVENTADO

#### 4.3. **REVENTADO Habilitado**
- **Ubicación**: `src/repositories/ticket.repository.ts` líneas 546, 579-588
- **Funcionamiento**:
  - Si `reventadoConfig.enabled = false`, bloquea todas las jugadas REVENTADO
  - Si `requiresMatchingNumber = true`, valida que `number === reventadoNumber`

#### 4.4. **Rango de Números (numberRange)**
- **Ubicación**: `src/repositories/ticket.repository.ts` líneas 549-618
- **Funcionamiento**:
  - Valida que todos los números estén en el rango `[min, max]`
  - Ejemplo: `numberRange: { min: 0, max: 99 }` bloquea números fuera de 0-99

#### 4.5. **Monto Mínimo/Máximo por Jugada**
- **Ubicación**: `src/repositories/ticket.repository.ts` líneas 556-637
- **Funcionamiento**:
  - `minBetAmount`: Valida que cada jugada >= minBetAmount
  - `maxBetAmount`: Valida que cada jugada <= maxBetAmount

#### 4.6. **Límite de Números por Ticket**
- **Ubicación**: `src/repositories/ticket.repository.ts` líneas 639-650
- **Funcionamiento**:
  - `maxNumbersPerTicket`: Cuenta solo jugadas NUMERO (únicas)
  - Bloquea si el ticket tiene más números únicos de los permitidos

---

### 5. **Validaciones de Estado y Entidades**

#### 5.1. **Sorteo Cerrado (CLOSED)**
- **Ubicación**: `src/api/v1/services/ticket.service.ts` líneas 129-135
- **Funcionamiento**: Bloquea creación de tickets si `sorteo.status === "CLOSED"`

#### 5.2. **Entidades Inactivas**
- **Ubicación**: `src/repositories/ticket.repository.ts` líneas 333-338
- **Validaciones**:
  - Lotería debe estar activa (`loteria.isActive === true`)
  - Sorteo debe existir
  - Ventana debe existir y estar activa
  - Vendedor debe existir

#### 5.3. **Coherencia de Datos**
- **Ubicación**: `src/repositories/ticket.repository.ts` líneas 340-347
- **Validaciones**:
  - `sorteo.loteriaId === loteriaId` (el sorteo debe pertenecer a la lotería indicada)

---

## 🔍 Observaciones y Detalles Técnicos

### 1. **Validación de Jugadas Inactivas**
- **Ubicación**: `src/repositories/ticket.repository.ts` líneas 927, 977, 1013, 1062
- **Comportamiento**:
  - Las jugadas con `isActive: false` se excluyen de las validaciones de límites
  - Esto permite crear tickets con jugadas inactivas sin violar límites
  - Útil para casos especiales donde se necesita crear un ticket pero marcar jugadas como inactivas

### 2. **Cálculo de Acumulados**
- **Ubicación**: `src/repositories/helpers/ticket-restriction.helper.ts` líneas 21-163
- **Optimización**:
  - Calcula acumulados para múltiples números en una sola query SQL
  - Incluye tanto jugadas NUMERO como REVENTADO (por `reventadoNumber`)
  - Filtra por sorteo específico (acumulados no se mezclan entre sorteos)
  - Respeta `multiplierFilter` si está presente

### 3. **Filtros de Fecha y Hora**
- **Ubicación**: `src/repositories/ticket.repository.ts` líneas 510-521
- **Funcionamiento**:
  - `appliesToDate`: Solo aplica la regla si la fecha coincide
  - `appliesToHour`: Solo aplica la regla si la hora coincide
  - Útil para crear reglas temporales (ej: límites más estrictos en horas pico)

### 4. **Mensajes de Error**
- **Ubicación**: Varias líneas en `ticket.repository.ts`
- **Características**:
  - Mensajes descriptivos con contexto
  - Incluyen montos, límites, acumulados
  - Códigos de error consistentes para el frontend
  - Metadatos adicionales (scope, isAutoDate, etc.)

### 5. **Transacciones Atómicas**
- **Ubicación**: `src/repositories/ticket.repository.ts` línea 273
- **Comportamiento**:
  - Todas las validaciones se hacen dentro de `prisma.$transaction()`
  - Garantiza atomicidad: si falla una validación, no se crea nada
  - Previene race conditions en acumulados

---

## ⚠️ Puntos de Atención

### 1. **Límites Dinámicos y Ventas del Sorteo**
- **Comportamiento actual**: Las ventas se calculan sobre el sorteo específico
- **Consideración**: Si se excluyen jugadas después (`isExcluded = true`), el límite dinámico NO se recalcula
- **Impacto**: Los límites dinámicos pueden ser menos restrictivos de lo esperado si hay exclusiones

### 2. **Prioridad de Reglas**
- **Comportamiento actual**: Se aplican TODAS las reglas aplicables
- **Consideración**: Si hay múltiples reglas, todas validan
- **Ejemplo**: Si hay una regla de USER con maxAmount=1000 y otra de VENTANA con maxAmount=500, ambas se validan (puede ser confuso)

### 3. **Validación de REVENTADO con Multiplicadores**
- **Comportamiento actual**: Las jugadas REVENTADO se excluyen si la regla tiene `multiplierId`
- **Consideración**: REVENTADO no tiene `multiplierId` directo, pero puede heredar el multiplicador base
- **Lógica**: No está claro si las reglas con `multiplierId` deberían aplicarse a REVENTADO que hereda ese multiplicador

### 4. **Cache de Restricciones**
- **Ubicación**: `src/utils/restrictionCache.ts`
- **Comportamiento**: Se cachean restricciones para mejorar performance
- **Consideración**: El cache se invalida cuando se crean/actualizan reglas, pero podría haber race conditions en alta concurrencia

---

## 📊 Flujo Completo de Validación

### Orden de Ejecución (dentro de la transacción):

1. **Validación de entidades** (líneas 327-347)
   - Usuario, lotería, sorteo, ventana existen y están activos
   - Sorteo pertenece a la lotería indicada

2. **Generación de número de ticket** (líneas 354-469)
   - Incremento atómico de contador
   - Manejo de colisiones con reintentos

3. **Resolución de multiplicador base** (líneas 471-488)
   - Jerarquía: USER override > VENTANA override > BANCA setting > Loteria multiplier > rulesJson > env

4. **Obtención de reglas aplicables** (líneas 490-534)
   - Búsqueda de RestrictionRule con filtros de fecha/hora
   - Ordenamiento por prioridad (score)

5. **Validación de LotteryMultiplierRule** (líneas 766-869)
   - Bloqueo total si no tiene límites
   - Warning para ADMIN si está bloqueado

6. **Validación de RulesJson** (líneas 540-650)
   - Tipos permitidos, REVENTADO habilitado, rango de números
   - Monto min/max por jugada, límite de números por ticket

7. **Validación de RestrictionRule** (líneas 890-1083)
   - maxAmount por número por ticket
   - maxTotal acumulado por número en el sorteo
   - Límites dinámicos (baseAmount + salesPercentage)

8. **Cálculo de comisiones** (líneas 1086-1140)
   - Comisión de vendedor y listero
   - Resolución jerárquica de políticas

9. **Creación de ticket y jugadas** (líneas 1142-1260)
   - Creación atómica con todas las validaciones pasadas

---

## ✅ Conclusiones

### Validaciones que Funcionan Correctamente:
1. ✅ RestrictionRule (maxAmount, maxTotal, límites dinámicos)
2. ✅ LotteryMultiplierRule (bloqueo vs límites)
3. ✅ Cutoff (salesCutoffMinutes)
4. ✅ RulesJson de Lotería (horarios, tipos, rangos, etc.)
5. ✅ Validaciones de estado (sorteo cerrado, entidades inactivas)
6. ✅ Prioridad jerárquica (USER > VENTANA > BANCA)
7. ✅ Filtros por multiplicador
8. ✅ isAutoDate (números automáticos por fecha)
9. ✅ Exclusión de jugadas inactivas de validaciones
10. ✅ Atomicidad transaccional

### Puntos que Requieren Atención (pero no son bugs):

#### 1. ⚠️ Límites Dinámicos No se Recalculan Después de Exclusiones

**Descripción del Comportamiento Actual:**
- Los límites dinámicos se calculan sobre las ventas del sorteo **en el momento de crear el ticket**
- Si después se excluyen jugadas (`isExcluded = true`), las ventas del sorteo disminuyen
- Sin embargo, los límites dinámicos **NO se recalculan** automáticamente

**Ejemplo Concreto:**
```typescript
// Estado inicial del sorteo:
// - Ventas totales: 10,000
// - Regla: baseAmount = 1000, salesPercentage = 10%
// - Límite dinámico = 1000 + (10,000 * 10 / 100) = 2,000

// Ticket 1 intenta: número "15" por 1,500
// ✅ PERMITIDO (1,500 < 2,000)

// Después, se excluyen jugadas que suman 3,000 en ventas
// - Ventas reales del sorteo ahora: 7,000
// - Límite dinámico debería ser: 1000 + (7,000 * 10 / 100) = 1,700

// Ticket 2 intenta: número "15" por 1,500
// ❌ BLOQUEADO (1,500 < 1,700) - PERO el sistema usa el límite viejo (2,000)
// ✅ PERMITIDO (incorrectamente, porque no recalcula)
```

**Ubicación del Código:**
- `src/repositories/ticket.repository.ts` líneas 19-85 (`calculateDynamicLimit`)
- La función calcula sobre `status: { notIn: [TicketStatus.CANCELLED, TicketStatus.EXCLUDED] }`
- Pero esto solo excluye tickets EXCLUDED, no jugadas excluidas individuales

**Impacto:**
- **Bajo**: Los límites dinámicos pueden ser menos restrictivos de lo esperado
- **Mitigación**: Las jugadas excluidas no cuentan en acumulados (`isExcluded = true` se filtra en queries)
- **Consideración**: Si se excluyen muchas jugadas, el límite dinámico podría ser más permisivo de lo necesario

**Recomendación:**
- Considerar recalcular límites dinámicos si se excluyen jugadas significativas
- O documentar que los límites dinámicos se calculan sobre ventas brutas (antes de exclusiones)

---

#### 2. ⚠️ Múltiples Reglas Aplicables Pueden Ser Confusas

**Descripción del Comportamiento Actual:**
- El sistema aplica **TODAS las reglas aplicables** de forma acumulativa
- No hay un mecanismo de "override" o "prioridad" que cancele reglas de menor nivel
- Todas las reglas validan independientemente

**Ejemplo Concreto:**
```typescript
// Configuración:
// - Regla USER: maxAmount = 1000 para número "15"
// - Regla VENTANA: maxAmount = 500 para número "15"
// - Regla BANCA: maxAmount = 2000 para número "15"

// Ticket intenta: número "15" por 600
// ✅ Regla USER: 600 < 1000 → PERMITIDO
// ❌ Regla VENTANA: 600 > 500 → BLOQUEADO
// ✅ Regla BANCA: 600 < 2000 → PERMITIDO

// Resultado: ❌ BLOQUEADO (por regla VENTANA)
// Mensaje: "El número 15 excede el límite de ventana por ticket..."
```

**Problema de Confusión:**
1. **Usuario ve múltiples límites**: No está claro cuál es el límite "real"
2. **Mensaje de error**: Solo muestra la regla que falló, no todas las aplicables
3. **Debugging difícil**: Si hay 5 reglas aplicables, todas se evalúan pero solo se reporta una

**Ubicación del Código:**
- `src/repositories/ticket.repository.ts` líneas 890-1083
- Loop `for (const rule of applicable)` aplica todas las reglas
- El primer error lanzado detiene el proceso

**Ejemplo de Múltiples Reglas:**
```typescript
// Regla 1 (USER): maxAmount = 1000, número "15", multiplicador "Base"
// Regla 2 (USER): maxTotal = 5000, número "15", sin multiplicador
// Regla 3 (VENTANA): maxAmount = 500, número "15", sin multiplicador
// Regla 4 (VENTANA): maxTotal = 3000, número "15", multiplicador "Base"
// Regla 5 (BANCA): maxAmount = 2000, número "15", sin multiplicador

// Ticket: número "15" con multiplicador "Base" por 600
// - Regla 1: 600 < 1000 → ✅
// - Regla 2: (acumulado + 600) <= 5000 → ✅ (si acumulado < 4400)
// - Regla 3: 600 > 500 → ❌ BLOQUEADO
// - Regla 4: (acumulado + 600) <= 3000 → ✅ (si acumulado < 2400)
// - Regla 5: 600 < 2000 → ✅

// Resultado: ❌ BLOQUEADO por Regla 3
// Usuario solo ve: "El número 15 excede el límite de ventana por ticket..."
// No sabe que hay otras 4 reglas también aplicables
```

**Impacto:**
- **Medio**: Puede ser confuso para usuarios y administradores
- **Debugging**: Difícil entender por qué se bloquea cuando hay múltiples reglas
- **UX**: El mensaje de error no muestra el panorama completo

**Recomendación:**
- Mejorar logging para mostrar todas las reglas aplicables y sus resultados
- Considerar mostrar en el mensaje de error todas las reglas que fallaron
- Documentar que todas las reglas aplicables se validan (no solo la de mayor prioridad)

---

#### 3. ⚠️ REVENTADO con Multiplicadores Tiene Lógica Compleja

**Descripción del Problema:**
- Las jugadas REVENTADO **no tienen `multiplierId` directo** en la mayoría de casos
- Sin embargo, pueden "heredar" el multiplicador de la jugada NUMERO base del mismo ticket
- La lógica de exclusión y restricciones maneja esto de forma especial

**Comportamiento Actual:**

**A) En RestrictionRule con `multiplierId`:**
```typescript
// Regla: maxAmount = 1000, número "15", multiplierId = "base-multiplier-id"

// Ticket tiene:
// - Jugada NUMERO: número "15", multiplierId = "base-multiplier-id", amount = 500
// - Jugada REVENTADO: número "15", reventadoNumber = "15", multiplierId = null, amount = 300

// Validación:
// - Jugada NUMERO: 500 < 1000 → ✅
// - Jugada REVENTADO: Se EXCLUYE de la validación porque rule.multiplierId existe
//   (línea 932: `if (rule.multiplierId) return false;`)
// - Total del número "15": 500 (solo NUMERO cuenta)
// - Resultado: ✅ PERMITIDO (500 < 1000)
```

**B) En RestrictionRule sin `multiplierId`:**
```typescript
// Regla: maxAmount = 1000, número "15", sin multiplierId

// Ticket tiene:
// - Jugada NUMERO: número "15", multiplierId = "base-multiplier-id", amount = 500
// - Jugada REVENTADO: número "15", reventadoNumber = "15", multiplierId = null, amount = 300

// Validación:
// - Jugada NUMERO: cuenta (500)
// - Jugada REVENTADO: cuenta (300) porque no hay filtro de multiplicador
// - Total del número "15": 800 (NUMERO + REVENTADO)
// - Resultado: ✅ PERMITIDO (800 < 1000)
```

**C) En ListaExclusion (post-creación):**
```typescript
// Exclusión: sorteoId, ventanaId, multiplierId = "base-multiplier-id"

// Ticket tiene:
// - Jugada NUMERO: número "15", multiplierId = "base-multiplier-id"
// - Jugada REVENTADO: número "15", reventadoNumber = "15", multiplierId = null

// Exclusión aplicada:
// - Jugada NUMERO: Se excluye (multiplierId coincide)
// - Jugada REVENTADO: Se excluye si su número base tiene jugada NUMERO con ese multiplierId
//   (línea 691 en sorteo-listas.service.ts: `numeroBaseMultiplierMap.has(jugada.number)`)
```

**Ubicación del Código:**
- `src/repositories/ticket.repository.ts` líneas 931-933, 1017-1019, 1064
- `src/api/v1/services/sorteo-listas.service.ts` líneas 673-695 (exclusión post-creación)
- `src/repositories/helpers/ticket-restriction.helper.ts` líneas 58-64 (cálculo de acumulados)

**Problemas de Complejidad:**

1. **Inconsistencia en Validación:**
   - Si la regla tiene `multiplierId`, REVENTADO se excluye de la validación
   - Pero en exclusión post-creación, REVENTADO SÍ se excluye si hereda el multiplicador
   - Esto puede ser confuso: ¿por qué se valida diferente que se excluye?

2. **Lógica de Herencia:**
   - REVENTADO "hereda" el multiplicador del NUMERO base del mismo ticket
   - Pero esto solo se aplica en exclusión post-creación, no en validación preventiva
   - No hay un campo explícito que indique esta herencia

3. **Filtro en Acumulados:**
   - `calculateAccumulatedByNumbersAndScope` tiene lógica especial para REVENTADO
   - Si `multiplierFilter.kind === 'REVENTADO'`, filtra por tipo de jugada
   - Si `multiplierFilter.kind === 'NUMERO'`, filtra por `multiplierId`
   - Pero REVENTADO no tiene `multiplierId` directo, solo heredado

**Ejemplo de Confusión:**
```typescript
// Regla: maxTotal = 5000, número "15", multiplierId = "base-multiplier-id"

// Sorteo ya tiene:
// - Ticket 1: NUMERO "15" con "base-multiplier-id" = 2000
// - Ticket 1: REVENTADO "15" (hereda multiplicador) = 1000
// - Ticket 2: NUMERO "15" con "base-multiplier-id" = 1500

// Acumulado para validación:
// - ¿Cuenta REVENTADO? Depende de multiplierFilter
// - Si multiplierFilter = { id: "base-multiplier-id", kind: "NUMERO" }
//   → Solo cuenta NUMERO: 2000 + 1500 = 3500
// - Si multiplierFilter = { id: "base-multiplier-id", kind: "REVENTADO" }
//   → Solo cuenta REVENTADO: 1000
// - Si no hay multiplierFilter
//   → Cuenta ambos: 2000 + 1000 + 1500 = 4500

// Ticket 3 intenta: NUMERO "15" con "base-multiplier-id" = 2000
// - Con multiplierFilter NUMERO: 3500 + 2000 = 5500 > 5000 → ❌ BLOQUEADO
// - Sin multiplierFilter: 4500 + 2000 = 6500 > 5000 → ❌ BLOQUEADO
```

**Impacto:**
- **Alto**: La lógica es compleja y puede llevar a comportamientos inesperados
- **Debugging**: Difícil entender por qué REVENTADO se cuenta o no se cuenta
- **Mantenimiento**: Cualquier cambio en esta lógica requiere revisar múltiples lugares

**Recomendación:**
- Documentar explícitamente cómo REVENTADO hereda multiplicadores
- Considerar agregar un campo `inheritedMultiplierId` en jugadas REVENTADO para claridad
- Unificar la lógica de validación preventiva con exclusión post-creación
- Mejorar logging para mostrar cuando REVENTADO hereda multiplicador

---

#### 4. ⚠️ Cache Podría Tener Race Conditions en Alta Concurrencia

**Descripción del Problema:**
- El sistema usa caché (Redis) para almacenar restricciones y cutoff
- Cuando se crea/actualiza una restricción, se invalida el caché
- Pero hay una ventana de tiempo donde el caché puede estar desactualizado

**Flujo Actual:**

**A) Lectura de Restricciones:**
```typescript
// 1. Intentar leer del caché
const cached = await getCachedRestrictions({ bancaId, ventanaId, userId, number });

// 2. Si no está en caché, consultar BD y guardar en caché
if (!cached) {
  const restrictions = await prisma.restrictionRule.findMany(...);
  await setCachedRestrictions({ bancaId, ventanaId, userId, number }, restrictions);
  return restrictions;
}

// 3. Retornar del caché
return cached;
```

**B) Invalidación de Caché:**
```typescript
// Cuando se crea/actualiza una restricción:
await prisma.restrictionRule.create(...);
await invalidateRestrictionCaches({ bancaId, ventanaId, userId });
```

**Escenario de Race Condition:**

```typescript
// Tiempo T0: Estado inicial
// - Caché: { restrictions: [regla1, regla2] }
// - BD: { regla1, regla2 }

// T1: Usuario A crea ticket
// - Lee caché: [regla1, regla2] ✅
// - Valida con reglas viejas

// T2: Admin actualiza regla2 (mismo momento, ~10ms después)
// - Actualiza BD: regla2 modificada
// - Invalida caché: elimina clave del caché

// T3: Usuario B crea ticket (mismo momento, ~20ms después)
// - Lee caché: ❌ NO EXISTE (fue invalidado)
// - Consulta BD: [regla1, regla2_actualizada] ✅
// - Guarda en caché: [regla1, regla2_actualizada]

// T4: Usuario A todavía validando (dentro de transacción)
// - Usa reglas viejas del caché (ya leídas en T1)
// - Crea ticket con reglas desactualizadas ⚠️
```

**Ubicación del Código:**
- `src/utils/restrictionCache.ts` - Funciones de caché
- `src/repositories/restrictionRule.repository.ts` líneas 78-85, 95-100 - Invalidación
- `src/repositories/ticket.repository.ts` línea 492 - Lectura de reglas (NO usa caché directamente, pero podría)

**Problemas Potenciales:**

1. **Ventana de Inconsistencia:**
   - Entre invalidar caché y que se actualice, hay un tiempo donde el caché está vacío
   - Múltiples requests pueden leer BD y escribir al caché simultáneamente
   - Puede haber "thundering herd" si muchos requests leen BD al mismo tiempo

2. **TTL vs Invalidación:**
   - El caché tiene TTL de 5 minutos (300s)
   - Si se invalida manualmente, se elimina inmediatamente
   - Pero si Redis falla, el sistema funciona sin caché (fallback correcto)

3. **Transacciones y Caché:**
   - Las validaciones de tickets están dentro de transacciones
   - El caché se lee FUERA de la transacción
   - Si se actualiza una regla durante la validación, puede haber inconsistencia

**Ejemplo de Race Condition:**
```typescript
// Request 1 (Usuario A): Crear ticket
// T0: Lee caché → [regla1: maxAmount=1000]
// T1: Inicia transacción
// T2: Valida con regla1 (maxAmount=1000)
// T3: Ticket tiene amount=800 → ✅ PERMITIDO

// Request 2 (Admin): Actualizar regla1
// T0: Actualiza BD → regla1: maxAmount=500
// T1: Invalida caché

// Request 3 (Usuario B): Crear ticket
// T0: Lee caché → ❌ NO EXISTE
// T1: Consulta BD → [regla1: maxAmount=500]
// T2: Guarda en caché → [regla1: maxAmount=500]
// T3: Inicia transacción
// T4: Valida con regla1 (maxAmount=500)
// T5: Ticket tiene amount=800 → ❌ BLOQUEADO

// Request 1 continúa:
// T4: Crea ticket con reglas viejas (maxAmount=1000)
// ✅ Ticket creado con reglas desactualizadas
```

**Impacto:**
- **Bajo-Medio**: Solo afecta si hay alta concurrencia y actualizaciones frecuentes
- **Mitigación**: Las transacciones son cortas (< 1 segundo típicamente)
- **TTL**: El caché expira en 5 minutos, limitando el tiempo de inconsistencia

**Recomendación:**
- Considerar usar "write-through" cache: actualizar caché al mismo tiempo que BD
- Implementar "cache stampede" protection: solo un request consulta BD, otros esperan
- Considerar usar versionado de caché: incluir timestamp en la clave
- Documentar que el caché puede tener pequeñas inconsistencias en alta concurrencia

### Nota sobre ListaExclusion:
- **NO** es una validación preventiva
- Se aplica **DESPUÉS** de crear tickets
- Marca jugadas como `isExcluded = true`
- No afecta la creación de tickets, solo el procesamiento posterior

---

## 📝 Recomendaciones

1. **Documentar claramente** que ListaExclusion es post-creación
2. **Considerar** recalcular límites dinámicos después de exclusiones si es necesario
3. **Mejorar logging** cuando se aplican múltiples reglas para debugging
4. **Considerar** validación explícita de REVENTADO con multiplicadores heredados

---

**Fecha del análisis**: 2025-01-XX
**Versión analizada**: Estado actual del código (post-reversión de cambios)

