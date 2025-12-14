# Cambios en API de Cierre Operativo - Guía Frontend

## 📋 Resumen de Cambios

Se implementó un sistema mejorado de cierre operativo con las siguientes modificaciones:

### ✅ Cambios Implementados

1. **Filtros de tickets mejorados**: Solo se incluyen tickets y jugadas con `isActive = true`
2. **Soporte completo para REVENTADOS**: Incluye TICA (Reventado) y MULTI X NICA (Multi x Nica)
3. **Distribución de REVENTADOS por banda**: Ya NO existe banda 200 separada
4. **Nuevas loterías soportadas**: TICA, NICA, MULTI X NICA, HONDURAS, PRIMERA, MONAZOS
5. **Estructura jerárquica mejorada**: Banda → Día → Lotería → Turno → Tipo

---

## 🎯 Cambio Principal: REVENTADOS Distribuidos por Banda

### ANTES (❌ Incorrecto)
```typescript
// Todos los reventados en banda 200
bands['200'] = {
  loterias: {
    'TICA': { ... },
    'MULTI_X_NICA': { ... }
  }
}
```

### AHORA (✅ Correcto)
```typescript
// Reventados distribuidos en su banda correspondiente
bands['85'] = {
  dias: {
    '2025-12-10': {
      loterias: {
        'TICA': {
          turnos: {
            '19:30_NUMERO': { turno: '19:30', tipo: 'NUMERO', totalVendida: 5000, ... },
            '19:30_REVENTADO': { turno: '19:30', tipo: 'REVENTADO', totalVendida: 500, ... }
          }
        },
        'MULTI_X_NICA': {
          turnos: {
            '20:00_NUMERO': { turno: '20:00', tipo: 'NUMERO', totalVendida: 3000, ... },
            '20:00_REVENTADO': { turno: '20:00', tipo: 'REVENTADO', totalVendida: 300, ... }
          }
        }
      }
    }
  }
}
```

**Explicación**: Cada REVENTADO hereda la banda de su jugada NUMERO asociada (mismo ticket + mismo número).

---

## 🔑 Cambios en la Estructura de Datos

### 1. Nueva estructura de claves de turnos (⚠️ BREAKING CHANGE)

#### ANTES
```typescript
turnos['19:30'] = { turno: '19:30', totalVendida: 1000, ... }
```

#### AHORA
```typescript
turnos['19:30_NUMERO'] = { turno: '19:30', tipo: 'NUMERO', totalVendida: 800, ... }
turnos['19:30_REVENTADO'] = { turno: '19:30', tipo: 'REVENTADO', totalVendida: 200, ... }
```

**Razón**: Un mismo horario puede tener jugadas NUMERO y REVENTADO. La clave compuesta evita sobrescritura.

### 2. Nuevo campo `tipo` en TurnoMetrics

```typescript
interface TurnoMetrics {
  turno: string;              // "19:30"
  tipo: 'NUMERO' | 'REVENTADO';  // ← NUEVO
  totalVendida: number;
  ganado: number;
  comisionTotal: number;
  netoDespuesComision: number;
  ticketsCount: number;
  jugadasCount: number;
}
```

### 3. Nuevos tipos de lotería

```typescript
type LoteriaType =
  | 'TICA'
  | 'PANAMA'
  | 'HONDURAS'
  | 'PRIMERA'
  | 'NICA'           // ← NUEVO
  | 'MULTI_X_NICA'   // ← NUEVO (antes "MULTI X NICA")
  | 'MONAZOS';       // ← NUEVO
```

**Nota**: `MULTI X NICA` se normaliza a `MULTI_X_NICA` (con guiones bajos).

### 4. Estructura jerárquica completa

```typescript
interface CierreWeeklyData {
  totals: CeldaMetrics;  // Totales globales
  bands: Record<string, BandaMetrics>;  // Por banda (80, 85, 90, 92)
}

interface BandaMetrics {
  dias: Record<string, DiaMetrics>;  // ← NUEVO nivel jerárquico
  total: CeldaMetrics;
}

interface DiaMetrics {
  fecha: string;  // "YYYY-MM-DD"
  loterias: Record<LoteriaType, LoteriaMetrics>;
  totalDia: CeldaMetrics;  // ← Subtotal del día
}

interface LoteriaMetrics {
  turnos: Record<string, TurnoMetrics>;  // key: "19:30_NUMERO" o "19:30_REVENTADO"
  subtotal: CeldaMetrics;
}
```

---

## 💻 Código de Migración para el Frontend

### Opción 1: Iterar todos los turnos (NUMERO + REVENTADO juntos)

```typescript
// Obtener datos de una banda específica
const banda85 = data.bands['85'];

// Iterar por cada día
Object.keys(banda85.dias).forEach(fecha => {
  const diaData = banda85.dias[fecha];

  console.log(`📅 Fecha: ${fecha}`);

  // Iterar por cada lotería
  Object.keys(diaData.loterias).forEach(loteriaKey => {
    const loteriaData = diaData.loterias[loteriaKey];

    console.log(`  🎰 Lotería: ${loteriaKey}`);

    // Iterar por cada turno (incluye NUMERO y REVENTADO)
    Object.keys(loteriaData.turnos).forEach(turnoKey => {
      const turnoData = loteriaData.turnos[turnoKey];

      console.log(`    🕐 ${turnoData.turno} (${turnoData.tipo}): ₡${turnoData.totalVendida}`);
    });

    // Subtotal de la lotería
    console.log(`    ✅ Subtotal ${loteriaKey}: ₡${loteriaData.subtotal.totalVendida}`);
  });

  // Total del día
  console.log(`  📊 Total día: ₡${diaData.totalDia.totalVendida}`);
});

// Total de la banda
console.log(`🏆 Total banda 85: ₡${banda85.total.totalVendida}`);
```

### Opción 2: Agrupar NUMERO y REVENTADO por horario

```typescript
function agruparPorHorario(loteriaData: LoteriaMetrics) {
  const turnosPorHorario: Record<string, {
    NUMERO?: TurnoMetrics;
    REVENTADO?: TurnoMetrics
  }> = {};

  Object.keys(loteriaData.turnos).forEach(turnoKey => {
    const turnoData = loteriaData.turnos[turnoKey];
    const horario = turnoData.turno;  // "19:30"

    if (!turnosPorHorario[horario]) {
      turnosPorHorario[horario] = {};
    }

    turnosPorHorario[horario][turnoData.tipo] = turnoData;
  });

  return turnosPorHorario;
}

// Uso
const turnos = agruparPorHorario(loteriaData);

// Mostrar en tabla
Object.keys(turnos).sort().forEach(horario => {
  const { NUMERO, REVENTADO } = turnos[horario];

  console.log(`
    Horario: ${horario}
    - NUMERO:    ${NUMERO ? '₡' + NUMERO.totalVendida : 'N/A'}
    - REVENTADO: ${REVENTADO ? '₡' + REVENTADO.totalVendida : 'N/A'}
  `);
});
```

### Opción 3: Mostrar solo NUMERO o solo REVENTADO

```typescript
// Filtrar solo jugadas NUMERO
const turnosNumero = Object.keys(loteriaData.turnos)
  .filter(key => loteriaData.turnos[key].tipo === 'NUMERO')
  .map(key => loteriaData.turnos[key]);

console.log('Turnos NUMERO:', turnosNumero);

// Filtrar solo jugadas REVENTADO
const turnosReventado = Object.keys(loteriaData.turnos)
  .filter(key => loteriaData.turnos[key].tipo === 'REVENTADO')
  .map(key => loteriaData.turnos[key]);

console.log('Turnos REVENTADO:', turnosReventado);
```

---

## 📊 Ejemplo de Respuesta Completa

```json
{
  "success": true,
  "data": {
    "totals": {
      "totalVendida": 50000,
      "ganado": 15000,
      "comisionTotal": 5000,
      "netoDespuesComision": 45000,
      "refuerzos": 0,
      "ticketsCount": 250,
      "jugadasCount": 1200
    },
    "bands": {
      "85": {
        "dias": {
          "2025-12-10": {
            "fecha": "2025-12-10",
            "loterias": {
              "TICA": {
                "turnos": {
                  "19:30_NUMERO": {
                    "turno": "19:30",
                    "tipo": "NUMERO",
                    "totalVendida": 8000,
                    "ganado": 2400,
                    "comisionTotal": 800,
                    "netoDespuesComision": 7200,
                    "refuerzos": 0,
                    "ticketsCount": 50,
                    "jugadasCount": 200
                  },
                  "19:30_REVENTADO": {
                    "turno": "19:30",
                    "tipo": "REVENTADO",
                    "totalVendida": 800,
                    "ganado": 240,
                    "comisionTotal": 80,
                    "netoDespuesComision": 720,
                    "refuerzos": 0,
                    "ticketsCount": 10,
                    "jugadasCount": 20
                  }
                },
                "subtotal": {
                  "totalVendida": 8800,
                  "ganado": 2640,
                  "comisionTotal": 880,
                  "netoDespuesComision": 7920,
                  "refuerzos": 0,
                  "ticketsCount": 60,
                  "jugadasCount": 220
                }
              },
              "MULTI_X_NICA": {
                "turnos": {
                  "20:00_NUMERO": {
                    "turno": "20:00",
                    "tipo": "NUMERO",
                    "totalVendida": 3000,
                    "ganado": 900,
                    "comisionTotal": 300,
                    "netoDespuesComision": 2700,
                    "refuerzos": 0,
                    "ticketsCount": 20,
                    "jugadasCount": 80
                  },
                  "20:00_REVENTADO": {
                    "turno": "20:00",
                    "tipo": "REVENTADO",
                    "totalVendida": 300,
                    "ganado": 90,
                    "comisionTotal": 30,
                    "netoDespuesComision": 270,
                    "refuerzos": 0,
                    "ticketsCount": 5,
                    "jugadasCount": 10
                  }
                },
                "subtotal": {
                  "totalVendida": 3300,
                  "ganado": 990,
                  "comisionTotal": 330,
                  "netoDespuesComision": 2970,
                  "refuerzos": 0,
                  "ticketsCount": 25,
                  "jugadasCount": 90
                }
              }
            },
            "totalDia": {
              "totalVendida": 12100,
              "ganado": 3630,
              "comisionTotal": 1210,
              "netoDespuesComision": 10890,
              "refuerzos": 0,
              "ticketsCount": 85,
              "jugadasCount": 310
            }
          }
        },
        "total": {
          "totalVendida": 12100,
          "ganado": 3630,
          "comisionTotal": 1210,
          "netoDespuesComision": 10890,
          "refuerzos": 0,
          "ticketsCount": 85,
          "jugadasCount": 310
        }
      }
    }
  },
  "meta": {
    "filters": {
      "fromDate": "2025-12-10",
      "toDate": "2025-12-10",
      "scope": "all"
    },
    "bandsUsed": {
      "byLoteria": {
        "30bc554e-281b-4b72-b241-0904f7583e68": [85],
        "6b0ee3f3-e236-45be-87d6-6481a2bf8eac": [85]
      },
      "global": [85],
      "details": [...]
    },
    "configHash": "abc123...",
    "anomalies": {
      "outOfBandCount": 0,
      "examples": []
    }
  }
}
```

---

## 📁 Cambios en Excel Export

### Estructura de hojas generadas

1. **Hoja por cada banda presente** (ej: "Banda 80", "Banda 85", "Banda 90")
   - Columnas: Fecha | Lotería | Turno | **Tipo** | Total Vendido | Premios | Comisión | Neto
   - Filas de datos separadas para NUMERO y REVENTADO del mismo horario
   - Subtotales por lotería
   - Total por día (solo si es multi-día)
   - Total de la banda

2. **Hoja "Cierre Total"**
   - Resumen consolidado por banda
   - Total global

### Ejemplo de hoja "Banda 85"

| Fecha      | Lotería      | Turno | Tipo      | Total Vendido | Premios | Comisión | Neto          |
|------------|--------------|-------|-----------|---------------|---------|----------|---------------|
| 2025-12-10 | TICA         | 19:30 | NUMERO    | ₡8,000.00     | ₡2,400  | ₡800     | ₡7,200.00     |
| 2025-12-10 | TICA         | 19:30 | REVENTADO | ₡800.00       | ₡240    | ₡80      | ₡720.00       |
| 2025-12-10 | SUBTOTAL TICA|       |           | ₡8,800.00     | ₡2,640  | ₡880     | ₡7,920.00     |
| 2025-12-10 | MULTI X NICA | 20:00 | NUMERO    | ₡3,000.00     | ₡900    | ₡300     | ₡2,700.00     |
| 2025-12-10 | MULTI X NICA | 20:00 | REVENTADO | ₡300.00       | ₡90     | ₡30      | ₡270.00       |
| 2025-12-10 | SUBTOTAL MULTI X NICA |     |     | ₡3,300.00     | ₡990    | ₡330     | ₡2,970.00     |
| TOTAL BANDA|              |       |           | ₡12,100.00    | ₡3,630  | ₡1,210   | ₡10,890.00    |

---

## ⚠️ Puntos Críticos de Migración

### 1. Cambio de acceso a datos

```typescript
// ❌ ANTES (no funciona más)
const ticaTurnos = data.bands['85'].loterias['TICA'].turnos;

// ✅ AHORA (correcto)
const fecha = '2025-12-10';
const ticaTurnos = data.bands['85'].dias[fecha].loterias['TICA'].turnos;
```

### 2. Iteración de turnos

```typescript
// ❌ ANTES
Object.keys(turnos).forEach(turno => {
  const data = turnos[turno];
  console.log(turno, data.totalVendida);  // "19:30", 1000
});

// ✅ AHORA
Object.keys(turnos).forEach(turnoKey => {
  const data = turnos[turnoKey];
  console.log(data.turno, data.tipo, data.totalVendida);  // "19:30", "NUMERO", 800
});
```

### 3. No buscar banda 200

```typescript
// ❌ ANTES
const reventados = data.bands['200'];  // Existía

// ✅ AHORA
// Los reventados están distribuidos en sus bandas correspondientes
// NO existe bands['200']
```

---

## 🧪 Endpoints Disponibles

### GET `/api/v1/cierres/weekly`
Obtiene cierre semanal con estructura jerárquica completa.

**Query params**:
- `from`: Fecha inicio (YYYY-MM-DD)
- `to`: Fecha fin (YYYY-MM-DD)
- `scope`: `mine` | `all`
- `ventanaId`: UUID (opcional, para ADMIN)

### GET `/api/v1/cierres/by-seller`
Obtiene cierre agrupado por vendedor.

**Query params**: Mismos que weekly + `top` y `orderBy`

### GET `/api/v1/cierres/export.xlsx`
Descarga Excel con todas las hojas y la columna Tipo.

**Query params**: Mismos que weekly + `view` (total | seller)

---

## 🎯 Loterías Soportadas

Según datos en BD (todas activas):

| Nombre BD      | Tipo normalizado | Tiene REVENTADO |
|----------------|------------------|-----------------|
| TICA           | TICA             | ✅ Sí           |
| MULTI X NICA   | MULTI_X_NICA     | ✅ Sí           |
| NICA           | NICA             | ❌ No (aún)     |
| HONDURAS       | HONDURAS         | ❌ No (aún)     |
| PRIMERA        | PRIMERA          | ❌ No (aún)     |
| MONAZOS        | MONAZOS          | ❌ No (aún)     |

**Nota**: Solo TICA y MULTI X NICA tienen jugadas REVENTADO actualmente (según datos de prueba).

---

## 📝 Validaciones del Backend

El backend ahora valida:

1. ✅ `t.isActive = true` (solo tickets activos)
2. ✅ `j.isActive = true` (solo jugadas activas)
3. ✅ `t.deletedAt IS NULL` (no eliminados)
4. ✅ `j.deletedAt IS NULL` (no eliminados)
5. ✅ `t.status != 'CANCELLED'` (no cancelados)
6. ✅ REVENTADO hereda banda de NUMERO asociado (mismo ticket + número)
7. ✅ Cada REVENTADO mantiene su propia franja horaria

---

## 🚀 Checklist de Migración Frontend

- [ ] Actualizar tipos TypeScript con nueva estructura jerárquica
- [ ] Cambiar acceso a datos: `bands[X].dias[fecha].loterias[L].turnos`
- [ ] Actualizar iteración de turnos para usar claves compuestas (`turno_tipo`)
- [ ] Añadir campo `tipo` en interfaces de TurnoMetrics
- [ ] Actualizar tipos de lotería (agregar NICA, MULTI_X_NICA, MONAZOS)
- [ ] Eliminar referencias a banda 200
- [ ] Actualizar visualización para mostrar NUMERO y REVENTADO
- [ ] Probar con datos reales del endpoint `/api/v1/cierres/weekly`
- [ ] Verificar descarga de Excel y validar columna "Tipo"

---

## 📞 Soporte

Si encuentras algún problema con la migración o los datos no coinciden con lo esperado:

1. Verificar respuesta del endpoint con datos reales
2. Validar que el frontend está usando las nuevas claves compuestas
3. Confirmar que no se está buscando banda 200

**Fecha de cambio**: 2025-12-14
**Versión API**: v1
