# Módulo Commission - Documentación Completa

## 📋 Índice

1. [Descripción General](#descripción-general)
2. [Arquitectura del Sistema](#arquitectura-del-sistema)
3. [Endpoints y Especificaciones](#endpoints-y-especificaciones)
4. [Información Esperada desde Frontend](#información-esperada-desde-frontend)
5. [Cómo Trabaja Internamente](#cómo-trabaja-internamente)
6. [Estructura de Datos JSON](#estructura-de-datos-json)
7. [Resolución Jerárquica](#resolución-jerárquica)
8. [Casos de Uso](#casos-de-uso)
9. [Posibles Mejoras](#posibles-mejoras)
10. [Dependencias y Relaciones](#dependencias-y-relaciones)

---

## Descripción General

El módulo Commission implementa un **sistema jerárquico de políticas de comisiones** basado en reglas JSON almacenadas en tres niveles: **USER → VENTANA → BANCA**.

### Características Principales

✅ **Políticas JSON Versioned (v1)**
- Almacenadas como JSONB en PostgreSQL
- Validación estricta con Zod schemas
- Versionado para evolución futura

✅ **Resolución Jerárquica**
- Orden de prioridad: USER → VENTANA → BANCA
- Primera regla que calza gana (first-match-wins)
- Fallback a `defaultPercent` si no hay match

✅ **Matching Flexible**
- Por lotería específica o todas (`loteriaId: null`)
- Por tipo de apuesta o ambos (`betType: null`)
- Por rango de multiplicador (min-max inclusivo)

✅ **Vigencia Temporal**
- `effectiveFrom` / `effectiveTo` (ISO 8601)
- Políticas pueden tener período de validez
- Null = sin límite temporal

✅ **Snapshot Inmutable**
- Al crear ticket, se calcula y guarda comisión en `Jugada`
- Campos: `commissionPercent`, `commissionAmount`, `commissionOrigin`, `commissionRuleId`
- **No se recalcula** si política cambia después

✅ **CRUD Completo (ADMIN only)**
- 6 endpoints: PUT/GET para Banca, Ventana, Usuario
- Auto-generación de UUIDs para reglas
- Validación estricta de estructura y valores

---

## Arquitectura del Sistema

```
┌─────────────────────────────────────────────────────────┐
│                    Frontend (ADMIN)                      │
│  - Configurar políticas de comisiones                   │
│  - PUT/GET para Banca, Ventana, Usuario                 │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│              CommissionController (CRUD)                 │
│  - Validar existencia de entidad                        │
│  - Actualizar commissionPolicyJson (JSONB)              │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│           Database (PostgreSQL JSONB)                    │
│  Banca.commissionPolicyJson                             │
│  Ventana.commissionPolicyJson                           │
│  User.commissionPolicyJson                              │
└────────────────────────────────────────────────────────┬┘
                                                          │
                                                          │ (Lectura durante creación de ticket)
                                                          │
                                                          ▼
┌─────────────────────────────────────────────────────────┐
│              ticket.repository.ts                        │
│  - Crear ticket con jugadas                             │
│  - Leer políticas de User, Ventana, Banca               │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│          commission.resolver.ts (Motor)                  │
│  1. Validar vigencia de políticas                       │
│  2. Buscar en orden: USER → VENTANA → BANCA             │
│  3. Aplicar first-match-wins en reglas                  │
│  4. Calcular commissionAmount                           │
│  5. Retornar snapshot inmutable                         │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│               Jugada (Database)                          │
│  - commissionPercent: 8.5                               │
│  - commissionAmount: 850.00                             │
│  - commissionOrigin: "USER" | "VENTANA" | "BANCA"       │
│  - commissionRuleId: "uuid-rule-123"                    │
└─────────────────────────────────────────────────────────┘
```

---

## Endpoints y Especificaciones

### Base URL

```
/api/v1
```

Todos los endpoints requieren:
- **Autenticación:** Bearer token
- **Autorización:** Role ADMIN

---

### 1. Políticas de BANCA

#### PUT `/api/v1/bancas/:id/commission-policy`

**Actualizar política de comisiones de una banca**

##### Headers
```http
Authorization: Bearer <token>
Content-Type: application/json
```

##### Path Parameters

| Parámetro | Tipo | Descripción |
|-----------|------|-------------|
| `id` | UUID | ID de la banca |

##### Request Body

```json
{
  "commissionPolicyJson": {
    "version": 1,
    "effectiveFrom": "2025-01-01T00:00:00.000Z",
    "effectiveTo": "2025-12-31T23:59:59.999Z",
    "defaultPercent": 5.0,
    "rules": [
      {
        "id": "550e8400-e29b-41d4-a716-446655440001",
        "loteriaId": null,
        "betType": "NUMERO",
        "multiplierRange": {
          "min": 70,
          "max": 100
        },
        "percent": 8.5
      },
      {
        "loteriaId": "660e8400-e29b-41d4-a716-446655440000",
        "betType": null,
        "multiplierRange": {
          "min": 0,
          "max": 1000
        },
        "percent": 10.0
      }
    ]
  }
}
```

**Nota:** Para **remover** la política, enviar `"commissionPolicyJson": null`

##### Response 200 OK

```json
{
  "success": true,
  "data": {
    "id": "440e8400-e29b-41d4-a716-446655440000",
    "name": "Banca Central",
    "code": "BC001",
    "commissionPolicyJson": {
      "version": 1,
      "effectiveFrom": "2025-01-01T00:00:00.000Z",
      "effectiveTo": "2025-12-31T23:59:59.999Z",
      "defaultPercent": 5.0,
      "rules": [
        {
          "id": "550e8400-e29b-41d4-a716-446655440001",
          "loteriaId": null,
          "betType": "NUMERO",
          "multiplierRange": { "min": 70, "max": 100 },
          "percent": 8.5
        }
      ]
    }
  }
}
```

##### Response 404 Not Found

```json
{
  "success": false,
  "message": "Banca no encontrada",
  "code": "BANCA_NOT_FOUND"
}
```

##### Response 403 Forbidden

```json
{
  "success": false,
  "message": "Forbidden"
}
```

---

#### GET `/api/v1/bancas/:id/commission-policy`

**Obtener política de comisiones de una banca**

##### Headers
```http
Authorization: Bearer <token>
```

##### Path Parameters

| Parámetro | Tipo | Descripción |
|-----------|------|-------------|
| `id` | UUID | ID de la banca |

##### Response 200 OK

```json
{
  "success": true,
  "data": {
    "id": "440e8400-e29b-41d4-a716-446655440000",
    "name": "Banca Central",
    "code": "BC001",
    "commissionPolicyJson": {
      "version": 1,
      "effectiveFrom": null,
      "effectiveTo": null,
      "defaultPercent": 5.0,
      "rules": []
    }
  }
}
```

**Si no tiene política:**
```json
{
  "success": true,
  "data": {
    "id": "440e8400-e29b-41d4-a716-446655440000",
    "name": "Banca Central",
    "code": "BC001",
    "commissionPolicyJson": null
  }
}
```

---

### 2. Políticas de VENTANA

#### PUT `/api/v1/ventanas/:id/commission-policy`

**Actualizar política de comisiones de una ventana**

##### Request Body

Misma estructura que Banca.

##### Response 200 OK

```json
{
  "success": true,
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "name": "Ventana Central",
    "code": "VC001",
    "commissionPolicyJson": { /* ... */ }
  }
}
```

##### Response 404 Not Found

```json
{
  "success": false,
  "message": "Ventana no encontrada",
  "code": "VENTANA_NOT_FOUND"
}
```

---

#### GET `/api/v1/ventanas/:id/commission-policy`

**Obtener política de comisiones de una ventana**

Misma estructura de respuesta que Banca.

---

### 3. Políticas de USUARIO

#### PUT `/api/v1/users/:id/commission-policy`

**Actualizar política de comisiones de un usuario**

##### Request Body

Misma estructura que Banca.

##### Response 200 OK

```json
{
  "success": true,
  "data": {
    "id": "770e8400-e29b-41d4-a716-446655440000",
    "name": "Juan Pérez",
    "username": "jperez",
    "role": "VENDEDOR",
    "commissionPolicyJson": { /* ... */ }
  }
}
```

##### Response 404 Not Found

```json
{
  "success": false,
  "message": "Usuario no encontrado",
  "code": "USER_NOT_FOUND"
}
```

---

#### GET `/api/v1/users/:id/commission-policy`

**Obtener política de comisiones de un usuario**

Misma estructura de respuesta.

---

## Información Esperada desde Frontend

### Flujo de Configuración (ADMIN)

```typescript
// 1. Listar loterías disponibles para selector
const loterias = await fetch('/api/v1/loterias');

// 2. Crear objeto de política
const policy: CommissionPolicy = {
  version: 1,
  effectiveFrom: "2025-01-01T00:00:00.000Z",
  effectiveTo: null, // Sin límite superior
  defaultPercent: 5.0,
  rules: [
    {
      // Si se omite 'id', el backend lo generará automáticamente
      loteriaId: "660e8400-e29b-41d4-a716-446655440000", // Tiempos Tica
      betType: "NUMERO",
      multiplierRange: { min: 70, max: 100 },
      percent: 8.5
    },
    {
      loteriaId: null, // Aplica a TODAS las loterías
      betType: "REVENTADO",
      multiplierRange: { min: 0, max: 1000 },
      percent: 10.0
    }
  ]
};

// 3. Enviar al backend
const response = await fetch('/api/v1/bancas/440e8400-e29b-41d4-a716-446655440000/commission-policy', {
  method: 'PUT',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ commissionPolicyJson: policy })
});
```

### Componentes Frontend Sugeridos

#### 1. Editor de Política de Comisiones

```typescript
interface CommissionPolicyEditorProps {
  entityType: 'banca' | 'ventana' | 'user';
  entityId: string;
  initialPolicy?: CommissionPolicy | null;
  loterias: Loteria[];
}

const CommissionPolicyEditor: React.FC<CommissionPolicyEditorProps> = ({
  entityType,
  entityId,
  initialPolicy,
  loterias
}) => {
  const [policy, setPolicy] = useState<CommissionPolicy>(
    initialPolicy || {
      version: 1,
      effectiveFrom: null,
      effectiveTo: null,
      defaultPercent: 5.0,
      rules: []
    }
  );

  const handleAddRule = () => {
    const newRule: CommissionRule = {
      id: crypto.randomUUID(), // Frontend genera UUID temporal
      loteriaId: null,
      betType: null,
      multiplierRange: { min: 0, max: 100 },
      percent: 5.0
    };
    setPolicy({
      ...policy,
      rules: [...policy.rules, newRule]
    });
  };

  const handleSave = async () => {
    const endpoint = `/api/v1/${entityType}s/${entityId}/commission-policy`;
    await fetch(endpoint, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ commissionPolicyJson: policy })
    });
  };

  return (
    <form>
      {/* Vigencia */}
      <DateRangePicker
        from={policy.effectiveFrom}
        to={policy.effectiveTo}
        onChange={(from, to) => setPolicy({ ...policy, effectiveFrom: from, effectiveTo: to })}
      />

      {/* Default Percent */}
      <NumberInput
        label="Comisión por defecto (%)"
        value={policy.defaultPercent}
        min={0}
        max={100}
        onChange={(val) => setPolicy({ ...policy, defaultPercent: val })}
      />

      {/* Reglas */}
      {policy.rules.map((rule, idx) => (
        <RuleEditor
          key={rule.id}
          rule={rule}
          loterias={loterias}
          onChange={(updatedRule) => {
            const newRules = [...policy.rules];
            newRules[idx] = updatedRule;
            setPolicy({ ...policy, rules: newRules });
          }}
          onDelete={() => {
            setPolicy({
              ...policy,
              rules: policy.rules.filter((_, i) => i !== idx)
            });
          }}
        />
      ))}

      <button onClick={handleAddRule}>+ Agregar Regla</button>
      <button onClick={handleSave}>Guardar Política</button>
    </form>
  );
};
```

#### 2. Editor de Regla Individual

```typescript
interface RuleEditorProps {
  rule: CommissionRule;
  loterias: Loteria[];
  onChange: (rule: CommissionRule) => void;
  onDelete: () => void;
}

const RuleEditor: React.FC<RuleEditorProps> = ({ rule, loterias, onChange, onDelete }) => {
  return (
    <div className="rule-editor">
      {/* Lotería */}
      <Select
        label="Lotería"
        value={rule.loteriaId || 'all'}
        onChange={(val) => onChange({ ...rule, loteriaId: val === 'all' ? null : val })}
      >
        <option value="all">Todas las loterías</option>
        {loterias.map(l => (
          <option key={l.id} value={l.id}>{l.name}</option>
        ))}
      </Select>

      {/* Tipo de apuesta */}
      <Select
        label="Tipo de apuesta"
        value={rule.betType || 'all'}
        onChange={(val) => onChange({ ...rule, betType: val === 'all' ? null : val as BetType })}
      >
        <option value="all">Todos los tipos</option>
        <option value="NUMERO">NUMERO</option>
        <option value="REVENTADO">REVENTADO</option>
      </Select>

      {/* Rango de multiplicador */}
      <div>
        <NumberInput
          label="Multiplicador mínimo"
          value={rule.multiplierRange.min}
          onChange={(val) => onChange({
            ...rule,
            multiplierRange: { ...rule.multiplierRange, min: val }
          })}
        />
        <NumberInput
          label="Multiplicador máximo"
          value={rule.multiplierRange.max}
          onChange={(val) => onChange({
            ...rule,
            multiplierRange: { ...rule.multiplierRange, max: val }
          })}
        />
      </div>

      {/* Porcentaje de comisión */}
      <NumberInput
        label="Comisión (%)"
        value={rule.percent}
        min={0}
        max={100}
        step={0.1}
        onChange={(val) => onChange({ ...rule, percent: val })}
      />

      <button onClick={onDelete}>🗑️ Eliminar</button>
    </div>
  );
};
```

#### 3. Visualizador de Política Activa

```typescript
interface PolicyViewerProps {
  entityType: 'banca' | 'ventana' | 'user';
  entityId: string;
}

const PolicyViewer: React.FC<PolicyViewerProps> = ({ entityType, entityId }) => {
  const [policy, setPolicy] = useState<CommissionPolicy | null>(null);

  useEffect(() => {
    fetch(`/api/v1/${entityType}s/${entityId}/commission-policy`, {
      headers: { 'Authorization': `Bearer ${token}` }
    })
      .then(res => res.json())
      .then(data => setPolicy(data.data.commissionPolicyJson));
  }, [entityType, entityId]);

  if (!policy) return <p>Sin política configurada</p>;

  return (
    <div>
      <h3>Política de Comisiones</h3>
      <p>Vigencia: {policy.effectiveFrom || '∞'} → {policy.effectiveTo || '∞'}</p>
      <p>Por defecto: {policy.defaultPercent}%</p>

      <h4>Reglas ({policy.rules.length})</h4>
      <table>
        <thead>
          <tr>
            <th>Lotería</th>
            <th>Tipo</th>
            <th>Multiplicador</th>
            <th>Comisión</th>
          </tr>
        </thead>
        <tbody>
          {policy.rules.map(rule => (
            <tr key={rule.id}>
              <td>{rule.loteriaId ? loteriaNames[rule.loteriaId] : 'Todas'}</td>
              <td>{rule.betType || 'Todos'}</td>
              <td>{rule.multiplierRange.min} - {rule.multiplierRange.max}</td>
              <td>{rule.percent}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
```

---

## Cómo Trabaja Internamente

### 1. Configuración de Políticas (CRUD)

**Ubicación:** [src/api/v1/controllers/commission.controller.ts](../../src/api/v1/controllers/commission.controller.ts)

**Flujo PUT (Actualizar):**

```typescript
async updateBancaCommissionPolicy(req: AuthenticatedRequest, res: Response) {
  const { id } = req.params;
  const { commissionPolicyJson } = req.body; // Ya validado por Zod

  // 1. Validar que la banca existe
  const banca = await prisma.banca.findUnique({ where: { id } });
  if (!banca) {
    throw new AppError("Banca no encontrada", 404, { code: "BANCA_NOT_FOUND" });
  }

  // 2. Actualizar (Zod ya validó estructura y generó UUIDs faltantes)
  const updated = await prisma.banca.update({
    where: { id },
    data: { commissionPolicyJson },
    select: {
      id: true,
      name: true,
      code: true,
      commissionPolicyJson: true,
    },
  });

  // 3. Log
  req.logger?.info({
    layer: "controller",
    action: "UPDATE_BANCA_COMMISSION_POLICY",
    payload: { bancaId: id, policySet: commissionPolicyJson !== null },
  });

  return success(res, updated);
}
```

**Validación Zod:**

Ubicación: [src/api/v1/validators/commission.validator.ts](../../src/api/v1/validators/commission.validator.ts)

```typescript
const CommissionPolicySchema = z
  .object({
    version: z.literal(1),
    effectiveFrom: z.string().datetime().nullable(),
    effectiveTo: z.string().datetime().nullable(),
    defaultPercent: z.number().min(0).max(100),
    rules: z.array(CommissionRuleSchema),
  })
  .strict()
  .refine(
    (data) => {
      if (data.effectiveFrom && data.effectiveTo) {
        return new Date(data.effectiveFrom) <= new Date(data.effectiveTo);
      }
      return true;
    },
    {
      message: "effectiveFrom must be before or equal to effectiveTo",
      path: ["effectiveFrom"],
    }
  )
  .transform((data) => {
    // Auto-generar UUIDs para reglas sin ID
    return {
      ...data,
      rules: data.rules.map((rule) => ({
        ...rule,
        id: rule.id || uuidv4(), // ← Generación automática
      })),
    };
  });
```

**Transformación:**
- Si una regla viene sin `id`, Zod automáticamente genera un UUID v4
- Esto simplifica el frontend: puede omitir IDs al crear reglas nuevas

---

### 2. Resolución de Comisiones (Motor)

**Ubicación:** [src/services/commission.resolver.ts](../../src/services/commission.resolver.ts)

**Llamado desde:** [src/repositories/ticket.repository.ts](../../src/repositories/ticket.repository.ts:6)

**Función Principal:**

```typescript
export function resolveCommission(
  input: CommissionMatchInput,
  userPolicyJson: any,
  ventanaPolicyJson: any,
  bancaPolicyJson: any
): CommissionSnapshot
```

#### Paso 1: Validar Vigencia

```typescript
function parseCommissionPolicy(
  policyJson: any,
  origin: "USER" | "VENTANA" | "BANCA"
): CommissionPolicy | null {
  if (!policyJson) return null;

  // Validar estructura básica
  if (policyJson.version !== 1) return null;
  if (typeof policyJson.defaultPercent !== 'number') return null;
  if (!Array.isArray(policyJson.rules)) return null;

  // Verificar vigencia temporal
  const now = new Date();
  if (policyJson.effectiveFrom && new Date(policyJson.effectiveFrom) > now) {
    logger.info({ action: "COMMISSION_POLICY_NOT_EFFECTIVE", origin });
    return null; // Aún no vigente
  }
  if (policyJson.effectiveTo && new Date(policyJson.effectiveTo) < now) {
    logger.info({ action: "COMMISSION_POLICY_EXPIRED", origin });
    return null; // Ya expirada
  }

  return policyJson as CommissionPolicy;
}
```

#### Paso 2: Matching de Reglas

```typescript
function ruleMatches(rule: CommissionRule, input: CommissionMatchInput): boolean {
  // 1. Si la regla especifica loteriaId (no null), debe coincidir
  if (rule.loteriaId !== null && rule.loteriaId !== input.loteriaId) {
    return false;
  }

  // 2. Si la regla especifica betType (no null), debe coincidir
  if (rule.betType !== null && rule.betType !== input.betType) {
    return false;
  }

  // 3. El multiplicador debe estar dentro del rango (inclusivo)
  const { min, max } = rule.multiplierRange;
  if (input.finalMultiplierX < min || input.finalMultiplierX > max) {
    return false;
  }

  return true; // ✅ Regla aplica
}
```

#### Paso 3: First-Match-Wins

```typescript
function findMatchingRule(
  policy: CommissionPolicy,
  input: CommissionMatchInput
): { percent: number; ruleId: string | null } | null {
  // Recorrer reglas en orden (IMPORTANTE: orden del array)
  for (const rule of policy.rules) {
    if (ruleMatches(rule, input)) {
      return { percent: rule.percent, ruleId: rule.id };
    }
  }

  // Si ninguna regla calza, usar defaultPercent
  return { percent: policy.defaultPercent, ruleId: null };
}
```

#### Paso 4: Resolución Jerárquica

```typescript
export function resolveCommission(
  input: CommissionMatchInput,
  userPolicyJson: any,
  ventanaPolicyJson: any,
  bancaPolicyJson: any
): CommissionSnapshot {
  // 1. Intentar resolver desde USER (máxima prioridad)
  const userPolicy = parseCommissionPolicy(userPolicyJson, "USER");
  if (userPolicy) {
    const match = findMatchingRule(userPolicy, input);
    if (match) {
      const commissionAmount = parseFloat(
        ((input.amount * match.percent) / 100).toFixed(2)
      );
      return {
        commissionPercent: match.percent,
        commissionAmount,
        commissionOrigin: "USER",
        commissionRuleId: match.ruleId,
      };
    }
  }

  // 2. Intentar resolver desde VENTANA
  const ventanaPolicy = parseCommissionPolicy(ventanaPolicyJson, "VENTANA");
  if (ventanaPolicy) {
    const match = findMatchingRule(ventanaPolicy, input);
    if (match) {
      const commissionAmount = parseFloat(
        ((input.amount * match.percent) / 100).toFixed(2)
      );
      return {
        commissionPercent: match.percent,
        commissionAmount,
        commissionOrigin: "VENTANA",
        commissionRuleId: match.ruleId,
      };
    }
  }

  // 3. Intentar resolver desde BANCA
  const bancaPolicy = parseCommissionPolicy(bancaPolicyJson, "BANCA");
  if (bancaPolicy) {
    const match = findMatchingRule(bancaPolicy, input);
    if (match) {
      const commissionAmount = parseFloat(
        ((input.amount * match.percent) / 100).toFixed(2)
      );
      return {
        commissionPercent: match.percent,
        commissionAmount,
        commissionOrigin: "BANCA",
        commissionRuleId: match.ruleId,
      };
    }
  }

  // 4. Fallback: Sin comisión (0%)
  logger.info({
    action: "COMMISSION_RESOLVED",
    origin: null,
    percent: 0,
    note: "No commission policy found, defaulting to 0%",
  });

  return {
    commissionPercent: 0,
    commissionAmount: 0,
    commissionOrigin: null,
    commissionRuleId: null,
  };
}
```

---

### 3. Integración en Creación de Tickets

**Ubicación:** [src/repositories/ticket.repository.ts](../../src/repositories/ticket.repository.ts)

```typescript
import { resolveCommission } from "../services/commission.resolver";

async function createTicket(input: CreateTicketInput) {
  return await withTransactionRetry(async (tx) => {
    // 1. Leer entidades relacionadas
    const user = await tx.user.findUnique({
      where: { id: input.vendedorId },
      select: { commissionPolicyJson: true },
    });

    const ventana = await tx.ventana.findUnique({
      where: { id: input.ventanaId },
      select: {
        commissionPolicyJson: true,
        banca: {
          select: { commissionPolicyJson: true },
        },
      },
    });

    // 2. Crear ticket
    const ticket = await tx.ticket.create({ /* ... */ });

    // 3. Crear jugadas con comisión calculada
    for (const jugadaInput of input.jugadas) {
      // Resolver comisión para esta jugada
      const commissionSnapshot = resolveCommission(
        {
          loteriaId: input.loteriaId,
          betType: jugadaInput.type,
          finalMultiplierX: jugadaInput.finalMultiplierX,
          amount: jugadaInput.amount,
        },
        user.commissionPolicyJson,         // USER
        ventana.commissionPolicyJson,      // VENTANA
        ventana.banca.commissionPolicyJson // BANCA
      );

      // Crear jugada con snapshot inmutable
      await tx.jugada.create({
        data: {
          ticketId: ticket.id,
          type: jugadaInput.type,
          number: jugadaInput.number,
          amount: jugadaInput.amount,
          // ... otros campos
          commissionPercent: commissionSnapshot.commissionPercent,
          commissionAmount: commissionSnapshot.commissionAmount,
          commissionOrigin: commissionSnapshot.commissionOrigin,
          commissionRuleId: commissionSnapshot.commissionRuleId,
        },
      });
    }

    return ticket;
  });
}
```

**Importante:**
- La comisión se calcula **una sola vez** al crear el ticket
- Se guarda como **snapshot inmutable** en `Jugada`
- Si las políticas cambian después, NO afecta tickets ya creados

---

## Estructura de Datos JSON

### Esquema Completo (Version 1)

```typescript
interface CommissionPolicy {
  version: 1; // Literal
  effectiveFrom: string | null; // ISO 8601 datetime o null
  effectiveTo: string | null;   // ISO 8601 datetime o null
  defaultPercent: number;        // 0..100
  rules: CommissionRule[];       // Array de reglas
}

interface CommissionRule {
  id: string;                    // UUID (auto-generado si falta)
  loteriaId: string | null;      // UUID de lotería o null (todas)
  betType: "NUMERO" | "REVENTADO" | null; // Tipo de apuesta o null (ambos)
  multiplierRange: {
    min: number;                 // Mínimo inclusivo
    max: number;                 // Máximo inclusivo (min <= max)
  };
  percent: number;               // 0..100 (porcentaje de comisión)
}
```

### Validaciones Zod

```typescript
// Rango de multiplicador
const MultiplierRangeSchema = z
  .object({
    min: z.number(),
    max: z.number(),
  })
  .strict()
  .refine((data) => data.min <= data.max, {
    message: "min must be less than or equal to max",
    path: ["min"],
  });

// Regla individual
const CommissionRuleSchema = z
  .object({
    id: z.string().min(1).optional(), // Opcional, se genera si falta
    loteriaId: z.string().uuid().nullable(),
    betType: z.nativeEnum(BetType).nullable(),
    multiplierRange: MultiplierRangeSchema,
    percent: z.number().min(0).max(100),
  })
  .strict();

// Política completa
const CommissionPolicySchema = z
  .object({
    version: z.literal(1),
    effectiveFrom: z.string().datetime().nullable(),
    effectiveTo: z.string().datetime().nullable(),
    defaultPercent: z.number().min(0).max(100),
    rules: z.array(CommissionRuleSchema),
  })
  .strict()
  .refine(
    (data) => {
      if (data.effectiveFrom && data.effectiveTo) {
        return new Date(data.effectiveFrom) <= new Date(data.effectiveTo);
      }
      return true;
    },
    {
      message: "effectiveFrom must be before or equal to effectiveTo",
      path: ["effectiveFrom"],
    }
  )
  .transform((data) => {
    // Auto-generar UUIDs para reglas sin ID
    return {
      ...data,
      rules: data.rules.map((rule) => ({
        ...rule,
        id: rule.id || uuidv4(),
      })),
    };
  });
```

---

## Resolución Jerárquica

### Orden de Prioridad

```
USER → VENTANA → BANCA → Fallback (0%)
```

**Ejemplo:**

```
Usuario "Juan" (VENDEDOR):
  commissionPolicyJson: {
    version: 1,
    defaultPercent: 8.0,
    rules: [
      { loteriaId: "loteria-A", percent: 10.0, ... }
    ]
  }

Ventana "Central":
  commissionPolicyJson: {
    version: 1,
    defaultPercent: 6.0,
    rules: [
      { loteriaId: "loteria-B", percent: 9.0, ... }
    ]
  }

Banca "BC":
  commissionPolicyJson: {
    version: 1,
    defaultPercent: 5.0,
    rules: []
  }
```

**Escenario 1: Venta de lotería-A por Juan**
- ✅ Política de USER tiene regla para lotería-A → **10%**
- ❌ No se consulta Ventana ni Banca

**Escenario 2: Venta de lotería-B por Juan**
- ❌ Política de USER no tiene regla para lotería-B → usa defaultPercent (8%)
- ✅ Devuelve **8%** (USER)
- ❌ No se consulta Ventana ni Banca

**Escenario 3: Venta de lotería-C por Juan**
- ❌ Política de USER no tiene regla para lotería-C → defaultPercent (8%)
- ✅ Devuelve **8%** (USER)

**Escenario 4: Juan no tiene política, vende lotería-B**
- ❌ USER no tiene política
- ✅ Política de VENTANA tiene regla para lotería-B → **9%**
- ❌ No se consulta Banca

**Escenario 5: Ni USER ni VENTANA tienen política**
- ❌ USER no tiene política
- ❌ VENTANA no tiene política
- ✅ Política de BANCA → defaultPercent → **5%**

**Escenario 6: Ninguna entidad tiene política**
- ❌ USER no tiene política
- ❌ VENTANA no tiene política
- ❌ BANCA no tiene política
- ✅ Fallback → **0%**

---

### First-Match-Wins

**Las reglas se evalúan en el orden del array. La PRIMERA que calza gana.**

**Ejemplo:**

```json
{
  "rules": [
    {
      "id": "rule-1",
      "loteriaId": "loteria-A",
      "betType": "NUMERO",
      "multiplierRange": { "min": 70, "max": 100 },
      "percent": 10.0
    },
    {
      "id": "rule-2",
      "loteriaId": "loteria-A",
      "betType": null,
      "multiplierRange": { "min": 0, "max": 100 },
      "percent": 5.0
    }
  ]
}
```

**Input:** `{ loteriaId: "loteria-A", betType: "NUMERO", finalMultiplierX: 80 }`

**Evaluación:**
1. rule-1: loteriaId ✅, betType ✅, multiplier ✅ → **MATCH** → 10%
2. rule-2: **NO SE EVALÚA** (rule-1 ya ganó)

**Resultado:** 10%

---

**Input:** `{ loteriaId: "loteria-A", betType: "REVENTADO", finalMultiplierX: 50 }`

**Evaluación:**
1. rule-1: loteriaId ✅, betType ❌ (espera NUMERO, recibe REVENTADO) → NO MATCH
2. rule-2: loteriaId ✅, betType ✅ (null acepta ambos), multiplier ✅ → **MATCH** → 5%

**Resultado:** 5%

---

## Casos de Uso

### Caso 1: Comisión Base por Banca

**Objetivo:** Todas las ventas de la banca tienen 5% de comisión por defecto.

**Configuración:**
```json
// PUT /api/v1/bancas/{id}/commission-policy
{
  "commissionPolicyJson": {
    "version": 1,
    "effectiveFrom": null,
    "effectiveTo": null,
    "defaultPercent": 5.0,
    "rules": []
  }
}
```

**Resultado:**
- Cualquier venta sin política en USER o VENTANA → 5%

---

### Caso 2: Comisión Especial para Lotería Premium

**Objetivo:** "Tiempos Tica" da 8% de comisión, el resto 5%.

**Configuración:**
```json
{
  "version": 1,
  "defaultPercent": 5.0,
  "rules": [
    {
      "loteriaId": "uuid-tiempos-tica",
      "betType": null,
      "multiplierRange": { "min": 0, "max": 1000 },
      "percent": 8.0
    }
  ]
}
```

**Resultado:**
- Venta de Tiempos Tica → 8%
- Venta de cualquier otra lotería → 5%

---

### Caso 3: Comisión por Tipo de Apuesta

**Objetivo:** REVENTADO da más comisión (10%) que NUMERO (5%).

**Configuración:**
```json
{
  "version": 1,
  "defaultPercent": 5.0,
  "rules": [
    {
      "loteriaId": null,
      "betType": "REVENTADO",
      "multiplierRange": { "min": 0, "max": 1000 },
      "percent": 10.0
    }
  ]
}
```

**Resultado:**
- Venta de REVENTADO (cualquier lotería) → 10%
- Venta de NUMERO → 5% (defaultPercent)

---

### Caso 4: Comisión por Rango de Multiplicador

**Objetivo:** Multiplicadores altos (≥70) dan más comisión.

**Configuración:**
```json
{
  "version": 1,
  "defaultPercent": 5.0,
  "rules": [
    {
      "loteriaId": null,
      "betType": "NUMERO",
      "multiplierRange": { "min": 70, "max": 100 },
      "percent": 8.0
    }
  ]
}
```

**Resultado:**
- NUMERO con multiplicador ≥70 → 8%
- NUMERO con multiplicador <70 → 5%
- REVENTADO → 5%

---

### Caso 5: Política Temporal (Promoción)

**Objetivo:** Durante enero 2025, aumentar comisión de REVENTADO a 12%.

**Configuración:**
```json
{
  "version": 1,
  "effectiveFrom": "2025-01-01T00:00:00.000Z",
  "effectiveTo": "2025-01-31T23:59:59.999Z",
  "defaultPercent": 5.0,
  "rules": [
    {
      "loteriaId": null,
      "betType": "REVENTADO",
      "multiplierRange": { "min": 0, "max": 1000 },
      "percent": 12.0
    }
  ]
}
```

**Resultado:**
- Durante enero 2025: REVENTADO → 12%, NUMERO → 5%
- Fuera de enero: Política no vigente, usa nivel inferior (VENTANA o BANCA)

---

### Caso 6: Vendedor Estrella con Comisión Premium

**Objetivo:** "Juan Pérez" tiene comisión especial de 10% en todo.

**Configuración:**
```json
// PUT /api/v1/users/{id-juan}/commission-policy
{
  "commissionPolicyJson": {
    "version": 1,
    "effectiveFrom": null,
    "effectiveTo": null,
    "defaultPercent": 10.0,
    "rules": []
  }
}
```

**Resultado:**
- Todas las ventas de Juan → 10%
- Las políticas de VENTANA y BANCA NO se consultan (USER tiene prioridad)

---

## Posibles Mejoras

### 1. Dashboard de Políticas Activas

**Frontend:**
- Vista consolidada de todas las políticas vigentes
- Comparación entre USER/VENTANA/BANCA
- Simulador: "¿Qué comisión aplicaría en este escenario?"

**Backend:**
```http
GET /api/v1/commission/policies/active
```

**Response:**
```json
{
  "bancas": [
    { "id": "...", "name": "Banca Central", "hasPolicy": true, "defaultPercent": 5.0 }
  ],
  "ventanas": [
    { "id": "...", "name": "Ventana Norte", "hasPolicy": false }
  ],
  "users": [
    { "id": "...", "name": "Juan Pérez", "hasPolicy": true, "defaultPercent": 10.0 }
  ]
}
```

---

### 2. Simulador de Comisiones

**Endpoint:**
```http
POST /api/v1/commission/simulate
```

**Request:**
```json
{
  "userId": "uuid-juan",
  "ventanaId": "uuid-ventana-central",
  "bancaId": "uuid-banca-central",
  "loteriaId": "uuid-tiempos-tica",
  "betType": "NUMERO",
  "finalMultiplierX": 80,
  "amount": 10000
}
```

**Response:**
```json
{
  "commissionPercent": 10.0,
  "commissionAmount": 1000.00,
  "commissionOrigin": "USER",
  "commissionRuleId": "uuid-rule-123",
  "appliedRule": {
    "loteriaId": null,
    "betType": "NUMERO",
    "multiplierRange": { "min": 70, "max": 100 },
    "percent": 10.0
  }
}
```

**Uso:** Frontend puede probar diferentes configuraciones antes de guardar.

---

### 3. Historial de Cambios (Audit Log)

**Tabla nueva:**
```sql
CREATE TABLE "CommissionPolicyHistory" (
  "id" UUID PRIMARY KEY,
  "entityType" VARCHAR(10), -- 'BANCA' | 'VENTANA' | 'USER'
  "entityId" UUID,
  "policyJson" JSONB,
  "changedBy" UUID REFERENCES "User"("id"),
  "changedAt" TIMESTAMP DEFAULT NOW()
);
```

**Beneficio:** Auditoría completa de cambios en políticas.

---

### 4. Plantillas de Políticas

**Objetivo:** Facilitar creación de políticas comunes.

**Endpoint:**
```http
GET /api/v1/commission/templates
```

**Response:**
```json
{
  "templates": [
    {
      "id": "flat-5",
      "name": "Comisión plana 5%",
      "description": "5% en todas las ventas",
      "policy": {
        "version": 1,
        "defaultPercent": 5.0,
        "rules": []
      }
    },
    {
      "id": "reventado-premium",
      "name": "REVENTADO premium",
      "description": "10% en REVENTADO, 5% en NUMERO",
      "policy": {
        "version": 1,
        "defaultPercent": 5.0,
        "rules": [
          {
            "loteriaId": null,
            "betType": "REVENTADO",
            "multiplierRange": { "min": 0, "max": 1000 },
            "percent": 10.0
          }
        ]
      }
    }
  ]
}
```

**Frontend:** Selector de plantillas al crear política.

---

### 5. Validación de Conflictos

**Objetivo:** Detectar reglas contradictorias o redundantes.

**Ejemplo de conflicto:**
```json
{
  "rules": [
    { "loteriaId": "A", "percent": 5.0, "multiplierRange": { "min": 0, "max": 100 } },
    { "loteriaId": "A", "percent": 10.0, "multiplierRange": { "min": 50, "max": 150 } }
  ]
}
```

**Problema:** Rango 50-100 está cubierto por ambas reglas (ambigüedad).

**Mejora:**
```typescript
function validatePolicyForConflicts(policy: CommissionPolicy): string[] {
  const warnings: string[] = [];

  for (let i = 0; i < policy.rules.length; i++) {
    for (let j = i + 1; j < policy.rules.length; j++) {
      const rule1 = policy.rules[i];
      const rule2 = policy.rules[j];

      // Detectar overlap de rangos con misma lotería/betType
      if (
        rule1.loteriaId === rule2.loteriaId &&
        rule1.betType === rule2.betType &&
        rangesOverlap(rule1.multiplierRange, rule2.multiplierRange)
      ) {
        warnings.push(
          `Reglas ${rule1.id} y ${rule2.id} tienen overlap de rangos`
        );
      }
    }
  }

  return warnings;
}
```

---

### 6. Copiar Política entre Entidades

**Endpoint:**
```http
POST /api/v1/commission/copy
```

**Request:**
```json
{
  "sourceType": "banca",
  "sourceId": "uuid-banca-central",
  "targetType": "ventana",
  "targetId": "uuid-ventana-norte"
}
```

**Beneficio:** Reutilizar configuraciones probadas.

---

### 7. Política por Defecto Global

**Configuración en env:**
```env
DEFAULT_COMMISSION_PERCENT=5.0
```

**Uso:** Si ninguna entidad tiene política, usar este valor en vez de 0%.

**Código:**
```typescript
const DEFAULT_COMMISSION = parseFloat(process.env.DEFAULT_COMMISSION_PERCENT || '0');

// En resolveCommission():
return {
  commissionPercent: DEFAULT_COMMISSION,
  commissionAmount: parseFloat(((input.amount * DEFAULT_COMMISSION) / 100).toFixed(2)),
  commissionOrigin: null,
  commissionRuleId: null,
};
```

---

### 8. Notificaciones de Cambios

**Objetivo:** Notificar a usuarios afectados cuando su política cambia.

**Implementación:**
```typescript
async updateUserCommissionPolicy(req, res) {
  // ... actualizar política

  // Enviar notificación
  await notifyUser(userId, {
    type: 'COMMISSION_POLICY_UPDATED',
    message: 'Tu política de comisiones ha sido actualizada',
    newPolicy: commissionPolicyJson,
  });
}
```

---

### 9. Versioning de Políticas

**Objetivo:** Soportar múltiples versiones del schema.

**Futuro (v2):**
```typescript
interface CommissionPolicyV2 {
  version: 2;
  // ... nuevos campos
  tieredRules: TieredRule[]; // Comisiones escalonadas por volumen
}
```

**Migración automática:**
```typescript
function migratePolicy(policy: any): CommissionPolicy {
  if (policy.version === 1) {
    return policy;
  }
  if (policy.version === 2) {
    return convertV2toV1(policy);
  }
  throw new Error('Unsupported policy version');
}
```

---

### 10. Analytics de Comisiones

**Endpoint:**
```http
GET /api/v1/commission/analytics
```

**Response:**
```json
{
  "totalCommissions": 75000.00,
  "byOrigin": {
    "USER": 45000.00,
    "VENTANA": 20000.00,
    "BANCA": 10000.00
  },
  "byUser": [
    { "userId": "...", "userName": "Juan Pérez", "totalCommission": 12000.00 }
  ],
  "averagePercent": 7.5
}
```

**Uso:** Analizar efectividad de políticas.

---

## Dependencias y Relaciones

### Dependencias Directas

**Core:**
- [src/core/prismaClient.ts](../../src/core/prismaClient.ts) - Cliente de Prisma
- [src/core/errors.ts](../../src/core/errors.ts) - `AppError`
- [src/core/types.ts](../../src/core/types.ts) - `AuthenticatedRequest`
- [src/core/logger.ts](../../src/core/logger.ts) - Logging

**Utilities:**
- [src/utils/responses.ts](../../src/utils/responses.ts) - `success()`

**Middlewares:**
- [src/middlewares/auth.middleware.ts](../../src/middlewares/auth.middleware.ts) - `protect`, `restrictTo`
- [src/middlewares/validate.middleware.ts](../../src/middlewares/validate.middleware.ts) - `validateBody`

**Validación:**
- `zod` - Schemas de validación
- `uuid` - Generación de UUIDs

### Modelos de Base de Datos

**Almacenamiento (JSONB):**
- `Banca.commissionPolicyJson`
- `Ventana.commissionPolicyJson`
- `User.commissionPolicyJson`

**Snapshot Inmutable:**
- `Jugada.commissionPercent`
- `Jugada.commissionAmount`
- `Jugada.commissionOrigin`
- `Jugada.commissionRuleId`

### Relaciones con Otros Módulos

#### 1. ticket.repository.ts (Consumidor Principal)
- **Relación:** Usa `resolveCommission()` durante creación de tickets
- **Flujo:**
  1. Lee políticas de USER, VENTANA, BANCA
  2. Llama a `resolveCommission()` por cada jugada
  3. Guarda snapshot en `Jugada`

#### 2. dashboard.service.ts (Consumidor de Datos)
- **Relación:** Lee `Jugada.commissionAmount` para métricas
- **NO resuelve comisiones**, solo agrega datos históricos

#### 3. commission.resolver.ts (Motor de Resolución)
- **Ubicación:** [src/services/commission.resolver.ts](../../src/services/commission.resolver.ts)
- **Responsabilidad:** Lógica completa de resolución jerárquica
- **Función principal:** `resolveCommission()`

---

## Estructura de Archivos

```
src/api/v1/
├── controllers/
│   └── commission.controller.ts     # 6 endpoints CRUD (PUT/GET × 3)
├── routes/
│   └── commission.routes.ts         # Rutas + auth middleware
└── validators/
    └── commission.validator.ts      # Zod schemas + transformaciones

src/services/
└── commission.resolver.ts           # Motor de resolución jerárquica

src/repositories/
└── ticket.repository.ts             # Integración con creación de tickets
```

---

## Seguridad

### Autenticación
✅ Middleware `protect` en todas las rutas
- Valida JWT token
- Adjunta `req.user` con datos del usuario autenticado

### Autorización
✅ Middleware `restrictTo(Role.ADMIN)` en todas las rutas
- Solo administradores pueden configurar políticas
- VENTANA y VENDEDOR → 403 Forbidden

### Validación de Inputs
✅ Zod schemas estrictos:
- UUIDs válidos
- Rangos coherentes (min ≤ max)
- Fechas válidas (effectiveFrom ≤ effectiveTo)
- Porcentajes 0-100
- Estructura JSON correcta

### Protección de Datos
✅ JSONB en PostgreSQL:
- Validación a nivel de schema
- Indexable para queries eficientes
- Almacenamiento compacto

---

## Testing

### Tests Unitarios Sugeridos

#### commission.resolver.ts
```typescript
describe('resolveCommission', () => {
  it('should return USER policy when available', () => {
    const userPolicy = { version: 1, defaultPercent: 10, rules: [] };
    const result = resolveCommission(
      { loteriaId: 'A', betType: 'NUMERO', finalMultiplierX: 80, amount: 1000 },
      userPolicy,
      null,
      null
    );
    expect(result.commissionOrigin).toBe('USER');
    expect(result.commissionPercent).toBe(10);
    expect(result.commissionAmount).toBe(100);
  });

  it('should fall back to VENTANA when USER has no policy', () => {
    const ventanaPolicy = { version: 1, defaultPercent: 7, rules: [] };
    const result = resolveCommission(
      { loteriaId: 'A', betType: 'NUMERO', finalMultiplierX: 80, amount: 1000 },
      null,
      ventanaPolicy,
      null
    );
    expect(result.commissionOrigin).toBe('VENTANA');
    expect(result.commissionPercent).toBe(7);
  });

  it('should apply first matching rule', () => {
    const policy = {
      version: 1,
      defaultPercent: 5,
      rules: [
        {
          id: 'rule-1',
          loteriaId: 'A',
          betType: 'NUMERO',
          multiplierRange: { min: 70, max: 100 },
          percent: 10,
        },
        {
          id: 'rule-2',
          loteriaId: 'A',
          betType: null,
          multiplierRange: { min: 0, max: 100 },
          percent: 5,
        },
      ],
    };
    const result = resolveCommission(
      { loteriaId: 'A', betType: 'NUMERO', finalMultiplierX: 80, amount: 1000 },
      policy,
      null,
      null
    );
    expect(result.commissionRuleId).toBe('rule-1');
    expect(result.commissionPercent).toBe(10);
  });
});
```

#### commission.controller.ts
```typescript
describe('CommissionController.updateBancaCommissionPolicy', () => {
  it('should update policy successfully', async () => {
    const req = mockRequest({
      params: { id: 'banca-uuid' },
      body: {
        commissionPolicyJson: {
          version: 1,
          defaultPercent: 5,
          rules: [],
        },
      },
    });
    const res = mockResponse();

    await CommissionController.updateBancaCommissionPolicy(req, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          commissionPolicyJson: expect.any(Object),
        }),
      })
    );
  });

  it('should throw 404 if banca not found', async () => {
    const req = mockRequest({
      params: { id: 'invalid-uuid' },
      body: { commissionPolicyJson: null },
    });

    await expect(
      CommissionController.updateBancaCommissionPolicy(req, res)
    ).rejects.toThrow('Banca no encontrada');
  });
});
```

---

## Documentación Relacionada

- [Commission System](../COMMISSION_SYSTEM.md) - Documentación original del sistema
- [Dashboard Module](./DASHBOARD_MODULE.md) - Módulo que consume datos de comisiones
- [Ticket Repository](../../src/repositories/ticket.repository.ts) - Integración con tickets
- [Schema Prisma](../../src/prisma/schema.prisma) - Modelos de base de datos

---

## Changelog

| Fecha | Versión | Cambios |
|-------|---------|---------|
| 2025-10-29 | 1.0.0 | Documentación inicial completa |

---

**Autor:** AI Assistant
**Revisado por:** Mario Quirós Pizarro
**Última actualización:** 2025-10-29
