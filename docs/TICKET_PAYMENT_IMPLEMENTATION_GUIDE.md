# 🎫 Guía de Implementación - Módulo TicketPayment

**Audiencia**: Frontend team
**Versión**: 1.0
**Última actualización**: 2025-10-28

---

## Tabla de Contenidos

1. [Visión General](#visión-general)
2. [Conceptos Clave](#conceptos-clave)
3. [Flujos de Pago](#flujos-de-pago)
4. [Implementación por Rol](#implementación-por-rol)
5. [Componentes UI/UX](#componentes-uiux)
6. [Integración de API](#integración-de-api)
7. [Manejo de Errores](#manejo-de-errores)
8. [Testing](#testing)

---

## Visión General

### ¿Qué es el Módulo TicketPayment?

Sistema para registrar pagos (totales o parciales) a tiquetes ganadores. Permite:

- ✅ Registrar pagos completos de una vez
- ✅ Registrar pagos en múltiples entregas (parciales)
- ✅ Marcar pagos parciales como finales (aceptar deuda restante)
- ✅ Revertir pagos incorrectos
- ✅ Ver historial de pagos por tiquete
- ✅ Listar pagos con filtros y paginación

### Flujo General

```
[Tiquete Evaluado]
     ↓
  Ganador?
  ├─ NO  → Sin pago
  └─ YES ↓
     [Listo para Pago]
     ├─ Pago Completo ──→ [PAID]
     ├─ Pago Parcial   ──→ [EVALUATED] (pendiente)
     │  + isFinal      ──→ [PAID] (parcial aceptado)
     └─ Múltiples Pagos ──→ [EVALUATED] ──→ [PAID]
```

---

## Conceptos Clave

### 1. Estados de Tiquete

```typescript
enum TicketStatus {
  ACTIVE      // Creado, no evaluado
  EVALUATED   // Evaluado, ganador o perdedor
  PAID        // Completamente pagado
  CANCELLED   // Cancelado
  RESTORED    // Restaurado
}
```

**Transiciones válidas**:
- EVALUATED → PAID (después de pago)
- PAID → EVALUATED (si se reversa pago)

### 2. Campos de TicketPayment

```typescript
interface TicketPayment {
  id: string;                    // UUID del pago
  ticketId: string;              // FK al tiquete
  amountPaid: number;            // Monto pagado EN ESTE REGISTRO
  isPartial: boolean;            // true si < totalPayout
  remainingAmount?: number;      // totalPayout - amountPaid
  isFinal: boolean;              // true para finalizar parcial
  completedAt?: Date;            // Cuándo se completó (null si pendiente)
  isReversed: boolean;           // true si fue revertido
  method?: string;               // 'cash' | 'check' | 'transfer' | 'system'
  notes?: string;                // Comentarios (max 300 chars)
  idempotencyKey?: string;       // Para reintentos
  paymentDate: Date;             // Cuándo se registró el pago
  createdAt: Date;
  updatedAt: Date;
  paidBy: User;                  // Quién registró el pago
}
```

### 3. Estados de Pago

| Estado | Descripción | Puede ser Revertido |
|--------|-------------|-------------------|
| **Pendiente (partial)** | Pago parcial registrado, tiquete aún EVALUATED | Sí |
| **Completado (final)** | Pago completo o final parcial, tiquete PAID | Sí |
| **Revertido** | Pago marcado como revertido | No (ya reverted) |

---

## Flujos de Pago

### Flujo 1: Pago Completo Inmediato

**Caso**: Ganador de $100, pagamos $100

**Frontend**:
```javascript
const paymentData = {
  ticketId: "550e8400-e29b-41d4-a716-446655440000",
  amountPaid: 100,
  method: "cash",
  notes: "Pago completo entregado",
  idempotencyKey: `pago-${ticketId}-${Date.now()}`
};

const response = await fetch('/api/v1/ticket-payments', {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${token}` },
  body: JSON.stringify(paymentData)
});
```

**Backend**:
1. ✅ Valida precondiciones (ganador, EVALUATED, monto ≤ totalPayout)
2. ✅ Calcula `isPartial = false` (100 = totalPayout)
3. ✅ Marca como PAID automáticamente
4. ✅ Crea TicketPayment con `completedAt = now()`
5. ✅ Actualiza Ticket.status → `PAID`

**Frontend - Respuesta**:
```json
{
  "id": "pay-uuid",
  "ticketId": "ticket-uuid",
  "amountPaid": 100,
  "isPartial": false,
  "remainingAmount": 0,
  "isFinal": false,
  "completedAt": "2025-10-28T20:38:41Z",
  "ticketStatus": "PAID"
}
```

**UI/UX**:
- ✅ Mostrar "Pago registrado y completado"
- ✅ Cambiar status badge a PAID (verde)
- ✅ Deshabilitar botón de pago
- ✅ Mostrar fecha de pago en historial

---

### Flujo 2: Pago Parcial (Múltiples Entregas)

**Caso**: Ganador $100, primera entrega $30, segunda $70

#### Paso 1: Registrar Primer Pago Parcial

**Frontend**:
```javascript
// Primera entrega: $30
const firstPayment = {
  ticketId: "ticket-uuid",
  amountPaid: 30,
  method: "cash",
  notes: "Primer pago parcial",
  idempotencyKey: `pago-1-${ticketId}`
};

const response1 = await fetch('/api/v1/ticket-payments', {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${token}` },
  body: JSON.stringify(firstPayment)
});

const payment1 = await response1.json();
// {
//   "amountPaid": 30,
//   "isPartial": true,
//   "remainingAmount": 70,
//   "completedAt": null,
//   "ticketStatus": "EVALUATED"  ← Sigue pendiente
// }
```

**Backend**:
1. ✅ Valida precondiciones
2. ✅ Calcula `isPartial = true` (30 < 100)
3. ✅ Calcula `remainingAmount = 70`
4. ✅ NO marca como PAID (completedAt = null)
5. ✅ Ticket.status SE MANTIENE en EVALUATED

**Frontend - UI**:
```tsx
<PaymentStatus>
  <div>Total Pagado: $30</div>
  <div>Pendiente: $70</div>
  <ProgressBar value={30} max={100} />
  <Button>Registrar Siguiente Pago</Button>
</PaymentStatus>
```

#### Paso 2: Registrar Segundo Pago

**Opción A: Pago Exacto ($70)**
```javascript
const secondPayment = {
  ticketId: "ticket-uuid",
  amountPaid: 70,  // ← EXACTAMENTE lo que falta
  method: "cash",
  notes: "Segundo pago completa deuda",
  idempotencyKey: `pago-2-${ticketId}`
};

// Respuesta:
// {
//   "amountPaid": 70,
//   "isPartial": false,  ← Automáticamente completo
//   "remainingAmount": 0,
//   "completedAt": "2025-10-28T20:40:00Z",
//   "ticketStatus": "PAID"  ← Automáticamente PAID
// }
```

**Opción B: Pago Parcial + Final ($50)**
```javascript
const secondPayment = {
  ticketId: "ticket-uuid",
  amountPaid: 50,        // < 70 restantes
  isFinal: true,         // ← MARCA COMO FINAL
  notes: "Pago final, acepta $20 pendiente",
  idempotencyKey: `pago-2-final-${ticketId}`
};

// Respuesta:
// {
//   "amountPaid": 50,
//   "isPartial": true,   ← Sigue siendo parcial
//   "isFinal": true,     ← Pero es final
//   "remainingAmount": 20,  ← Deuda aceptada
//   "completedAt": "2025-10-28T20:40:00Z",
//   "ticketStatus": "PAID"  ← PAID con deuda
// }
```

**Frontend - Decisión**:
```tsx
<PaymentOptionsPanel>
  {remainingAmount === 0 && (
    <Alert type="success">Deuda completamente pagada</Alert>
  )}
  {remainingAmount > 0 && (
    <>
      <Alert type="warning">Deuda pendiente: ${remainingAmount}</Alert>
      <div>
        <Button onClick={payExact}>
          Pagar exacto (${remainingAmount})
        </Button>
        <Button onClick={openPartialDialog}>
          Pago final parcial
        </Button>
      </div>
    </>
  )}
</PaymentOptionsPanel>
```

---

### Flujo 3: Bloqueo de Múltiples Parciales Pendientes

**Caso**: Ya existe parcial sin cerrar, intenta registrar otro

**Frontend intenta**:
```javascript
// Ya existe: pago de $30 pendiente (isPartial=true, isFinal=false)
const secondAttempt = {
  ticketId: "ticket-uuid",
  amountPaid: 40,  // Otro parcial sin cerrar primero
  idempotencyKey: `pago-2-${ticketId}`
};

fetch('/api/v1/ticket-payments', { ... });
```

**Backend retorna**:
```json
{
  "statusCode": 409,
  "code": "TKT_PAY_005",
  "message": "Ya existe un pago parcial pendiente. Finalícelo primero o pague el monto exacto."
}
```

**Frontend - Manejo**:
```tsx
catch (error) {
  if (error.code === 'TKT_PAY_005') {
    showDialog(
      'Pago Pendiente',
      'Ya existe un pago parcial. Debe completarlo o finalizarlo.'
    );
    // Mostrar historial de pagos pendientes
    loadPaymentHistory();
  }
}
```

---

### Flujo 4: Reversión de Pago

**Caso**: Pago registrado incorrectamente, necesita revertirse

**Frontend**:
```javascript
const paymentId = "pay-uuid";

const response = await fetch(
  `/api/v1/ticket-payments/${paymentId}/reverse`,
  {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` }
  }
);

const reversedPayment = await response.json();
// {
//   "id": "pay-uuid",
//   "isReversed": true,
//   "reversedAt": "2025-10-28T20:45:00Z",
//   "ticketStatus": "EVALUATED"  ← Vuelve a EVALUATED
// }
```

**Backend**:
1. ✅ Busca pago por ID
2. ✅ Marca como `isReversed = true`
3. ✅ Si estaba PAID, revierte ticket a EVALUATED
4. ✅ Registra quién y cuándo fue revertido
5. ✅ **No borra registro** (auditoría conservada)

**Frontend - UI**:
```tsx
<PaymentHistoryRow payment={payment}>
  {payment.isReversed ? (
    <Badge color="red">Revertido</Badge>
  ) : (
    <Button onClick={handleReverse}>Revertir</Button>
  )}
</PaymentHistoryRow>
```

---

## Implementación por Rol

### ADMIN

**Permisos**:
- ✅ Registrar pagos a cualquier tiquete
- ✅ Listar pagos de cualquier ventana
- ✅ Revertir pagos de cualquier ventana
- ✅ Ver historial de cualquier tiquete

**Restricciones**: Ninguna

**Ejemplo**:
```javascript
// ADMIN puede pagar tiquete de cualquier ventana
const payment = {
  ticketId: "any-ticket",  // De cualquier ventana
  amountPaid: 100,
  ...
};
```

### VENTANA

**Permisos**:
- ✅ Registrar pagos solo a tiquetes de su ventana
- ✅ Listar pagos solo de su ventana
- ✅ Revertir pagos de su ventana
- ✅ Ver historial de su ventana

**Restricciones**:
- ❌ No puede pagar tiquete de otra ventana
- ❌ No puede revertir pago de otra ventana
- ❌ No puede listar pagos de otra ventana

**Ejemplo**:
```javascript
// VENTANA intenta pagar tiquete de otra ventana
const payment = {
  ticketId: "ticket-from-other-window",
  amountPaid: 100
};

// Response: 403 RBAC_001
// "No autorizado para editar este pago"
```

### VENDEDOR

**Permisos**: ❌ NINGUNO

- ❌ No puede registrar pagos
- ❌ No puede listar pagos
- ❌ No puede revertir pagos
- ❌ No puede ver historial

**Ejemplo**:
```javascript
// VENDEDOR intenta listar pagos
fetch('/api/v1/ticket-payments', { ... });

// Response: 403
// "No autorizado para listar pagos"
```

---

## Componentes UI/UX

### 1. Card de Resumen de Pagos

```tsx
interface PaymentSummaryCardProps {
  ticket: Ticket;
  totalPayout: number;
  totalPaid: number;
  remainingAmount: number;
  ticketStatus: TicketStatus;
}

export const PaymentSummaryCard: React.FC<PaymentSummaryCardProps> = ({
  ticket,
  totalPayout,
  totalPaid,
  remainingAmount,
  ticketStatus
}) => {
  const progressPercent = (totalPaid / totalPayout) * 100;

  return (
    <Card className="payment-summary">
      <CardHeader>
        <h3>Historial de Pago - {ticket.ticketNumber}</h3>
        <StatusBadge status={ticketStatus} />
      </CardHeader>

      <CardBody>
        <ProgressBar
          value={totalPaid}
          max={totalPayout}
          showLabel={`${totalPaid.toFixed(2)} / ${totalPayout.toFixed(2)}`}
        />

        <Grid cols={3}>
          <Stat label="Total Pagado" value={`$${totalPaid.toFixed(2)}`} />
          <Stat label="Pendiente" value={`$${remainingAmount.toFixed(2)}`} />
          <Stat label="Progreso" value={`${progressPercent.toFixed(1)}%`} />
        </Grid>

        {remainingAmount > 0 && ticketStatus === 'EVALUATED' && (
          <PaymentAction
            remaining={remainingAmount}
            onPayFull={() => submitPayment(remainingAmount, false)}
            onPayPartial={() => openPartialModal(remainingAmount)}
          />
        )}
      </CardBody>
    </Card>
  );
};
```

### 2. Modal de Pago Parcial

```tsx
interface PartialPaymentModalProps {
  remaining: number;
  ticketId: string;
  onSuccess: (payment: TicketPayment) => void;
  onCancel: () => void;
}

export const PartialPaymentModal: React.FC<PartialPaymentModalProps> = ({
  remaining,
  ticketId,
  onSuccess,
  onCancel
}) => {
  const [amount, setAmount] = useState(0);
  const [isFinal, setIsFinal] = useState(false);
  const [method, setMethod] = useState('cash');
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/v1/ticket-payments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ticketId,
          amountPaid: parseFloat(amount),
          isFinal,
          method,
          notes,
          idempotencyKey: `pago-${ticketId}-${Date.now()}`
        })
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message);
      }

      const payment = await response.json();
      onSuccess(payment);
    } catch (error) {
      showError(`Error al registrar pago: ${error.message}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal onClose={onCancel}>
      <ModalHeader>Pago Parcial</ModalHeader>
      <ModalBody>
        <FormGroup>
          <Label>Monto a Pagar</Label>
          <div className="input-group">
            <span>$</span>
            <input
              type="number"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              max={remaining}
              min={0}
              step={0.01}
            />
          </div>
          <Info>Máximo a pagar: ${remaining.toFixed(2)}</Info>
        </FormGroup>

        <FormGroup>
          <Label>Método de Pago</Label>
          <select value={method} onChange={(e) => setMethod(e.target.value)}>
            <option value="cash">Efectivo</option>
            <option value="check">Cheque</option>
            <option value="transfer">Transferencia</option>
            <option value="system">Sistema</option>
          </select>
        </FormGroup>

        <FormGroup>
          <Label>Notas</Label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            maxLength={300}
            placeholder="Comentarios sobre el pago..."
          />
          <Small>{notes.length}/300</Small>
        </FormGroup>

        <FormGroup>
          <Checkbox
            checked={isFinal}
            onChange={(e) => setIsFinal(e.target.checked)}
            label="Marcar como pago final (acepta deuda restante)"
          />
          {isFinal && remaining - parseFloat(amount) > 0 && (
            <Alert type="warning">
              Esta transacción aceptará una deuda de ${(remaining - parseFloat(amount)).toFixed(2)}
            </Alert>
          )}
        </FormGroup>
      </ModalBody>

      <ModalFooter>
        <Button variant="secondary" onClick={onCancel}>
          Cancelar
        </Button>
        <Button
          variant="primary"
          onClick={handleSubmit}
          disabled={!amount || amount <= 0 || loading}
          loading={loading}
        >
          Registrar Pago
        </Button>
      </ModalFooter>
    </Modal>
  );
};
```

### 3. Tabla de Historial de Pagos

```tsx
interface PaymentHistoryTableProps {
  ticketId: string;
  onReversed?: () => void;
}

export const PaymentHistoryTable: React.FC<PaymentHistoryTableProps> = ({
  ticketId,
  onReversed
}) => {
  const [payments, setPayments] = useState<TicketPayment[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadPaymentHistory();
  }, [ticketId]);

  const loadPaymentHistory = async () => {
    try {
      const response = await fetch(
        `/api/v1/tickets/${ticketId}/payment-history`
      );
      const data = await response.json();
      setPayments(data.payments);
    } finally {
      setLoading(false);
    }
  };

  const handleReverse = async (paymentId: string) => {
    if (!confirm('¿Revertir este pago?')) return;

    try {
      const response = await fetch(
        `/api/v1/ticket-payments/${paymentId}/reverse`,
        { method: 'POST' }
      );

      if (response.ok) {
        showSuccess('Pago revertido');
        loadPaymentHistory();
        onReversed?.();
      } else {
        const error = await response.json();
        showError(`Error: ${error.message}`);
      }
    } catch (error) {
      showError(`Error al revertir: ${error}`);
    }
  };

  if (loading) return <Skeleton />;

  return (
    <Table>
      <TableHead>
        <tr>
          <th>Fecha</th>
          <th>Monto</th>
          <th>Tipo</th>
          <th>Método</th>
          <th>Quién Pagó</th>
          <th>Estado</th>
          <th>Acciones</th>
        </tr>
      </TableHead>
      <TableBody>
        {payments.map((payment) => (
          <tr key={payment.id}>
            <td>{formatDate(payment.paymentDate)}</td>
            <td className="amount">${payment.amountPaid.toFixed(2)}</td>
            <td>
              {payment.isPartial ? (
                <Badge color="orange">Parcial</Badge>
              ) : (
                <Badge color="green">Completo</Badge>
              )}
            </td>
            <td>{payment.method || 'N/A'}</td>
            <td>{payment.paidBy.name}</td>
            <td>
              {payment.isReversed ? (
                <Badge color="red">Revertido</Badge>
              ) : (
                <Badge color="blue">Activo</Badge>
              )}
            </td>
            <td>
              {!payment.isReversed && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => handleReverse(payment.id)}
                >
                  Revertir
                </Button>
              )}
            </td>
          </tr>
        ))}
      </TableBody>
    </Table>
  );
};
```

---

## Integración de API

### Cliente HTTP Recomendado

```typescript
// httpClient.ts
import axios from 'axios';

const API_BASE = 'http://localhost:3000/api/v1';

export const ticketPaymentAPI = {
  // Crear pago
  create: (data: CreatePaymentInput) =>
    axios.post(`${API_BASE}/ticket-payments`, data),

  // Listar pagos
  list: (filters?: ListPaymentsFilters) =>
    axios.get(`${API_BASE}/ticket-payments`, { params: filters }),

  // Obtener detalle de pago
  getById: (id: string) =>
    axios.get(`${API_BASE}/ticket-payments/${id}`),

  // Actualizar pago
  update: (id: string, data: UpdatePaymentInput) =>
    axios.patch(`${API_BASE}/ticket-payments/${id}`, data),

  // Revertir pago
  reverse: (id: string) =>
    axios.post(`${API_BASE}/ticket-payments/${id}/reverse`),

  // Historial de pago de tiquete
  getPaymentHistory: (ticketId: string) =>
    axios.get(`${API_BASE}/tickets/${ticketId}/payment-history`)
};
```

### Ejemplo Completo: Hook React

```typescript
// useTicketPayment.ts
import { useState, useCallback } from 'react';
import { ticketPaymentAPI } from './httpClient';

interface UseTicketPaymentReturn {
  createPayment: (data: CreatePaymentInput) => Promise<TicketPayment>;
  listPayments: (filters?: any) => Promise<any>;
  getPaymentHistory: (ticketId: string) => Promise<any>;
  reversePayment: (id: string) => Promise<TicketPayment>;
  loading: boolean;
  error: string | null;
}

export const useTicketPayment = (): UseTicketPaymentReturn => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const createPayment = useCallback(
    async (data: CreatePaymentInput) => {
      setLoading(true);
      setError(null);
      try {
        const response = await ticketPaymentAPI.create(data);
        return response.data;
      } catch (err: any) {
        const message = err.response?.data?.message || 'Error al registrar pago';
        setError(message);
        throw err;
      } finally {
        setLoading(false);
      }
    },
    []
  );

  const listPayments = useCallback(
    async (filters?: any) => {
      setLoading(true);
      setError(null);
      try {
        const response = await ticketPaymentAPI.list(filters);
        return response.data;
      } catch (err: any) {
        const message = err.response?.data?.message || 'Error al listar pagos';
        setError(message);
        throw err;
      } finally {
        setLoading(false);
      }
    },
    []
  );

  const getPaymentHistory = useCallback(
    async (ticketId: string) => {
      setLoading(true);
      setError(null);
      try {
        const response = await ticketPaymentAPI.getPaymentHistory(ticketId);
        return response.data;
      } catch (err: any) {
        const message = err.response?.data?.message || 'Error al cargar historial';
        setError(message);
        throw err;
      } finally {
        setLoading(false);
      }
    },
    []
  );

  const reversePayment = useCallback(
    async (id: string) => {
      setLoading(true);
      setError(null);
      try {
        const response = await ticketPaymentAPI.reverse(id);
        return response.data;
      } catch (err: any) {
        const message = err.response?.data?.message || 'Error al revertir pago';
        setError(message);
        throw err;
      } finally {
        setLoading(false);
      }
    },
    []
  );

  return {
    createPayment,
    listPayments,
    getPaymentHistory,
    reversePayment,
    loading,
    error
  };
};
```

---

## Manejo de Errores

### Códigos de Error

| Código | Status | Causa | Solución |
|--------|--------|-------|----------|
| TKT_PAY_001 | 404 | Tiquete no existe | Verificar ID del tiquete |
| TKT_PAY_002 | 409 | Tiquete no es ganador | No puede pagar perdedor |
| TKT_PAY_003 | 409 | Tiquete no está EVALUATED | Debe estar evaluado |
| TKT_PAY_004 | 400 | Monto > totalPayout | Monto máximo excedido |
| TKT_PAY_005 | 409 | Pago parcial pendiente | Finalizar pago anterior |
| TKT_PAY_006 | 403 | Sin autorización | Validar rol/ventana |
| RBAC_001 | 403 | Violación RBAC | No puedes pagar esa ventana |

### Manejo en Frontend

```typescript
const handlePaymentError = (error: AxiosError) => {
  const code = error.response?.data?.code;
  const message = error.response?.data?.message;

  switch (code) {
    case 'TKT_PAY_001':
      showError('Tiquete no encontrado');
      break;
    case 'TKT_PAY_002':
      showError('Este tiquete no es ganador, no puede ser pagado');
      break;
    case 'TKT_PAY_003':
      showError('El tiquete aún no ha sido evaluado');
      break;
    case 'TKT_PAY_004':
      showError('El monto a pagar excede el premio total');
      break;
    case 'TKT_PAY_005':
      showError('Ya existe un pago parcial pendiente. Finalícelo primero.');
      // Opción: cargar historial y mostrar pago pendiente
      loadPaymentHistory();
      break;
    case 'TKT_PAY_006':
    case 'RBAC_001':
      showError('No tiene autorización para registrar este pago');
      break;
    default:
      showError(message || 'Error desconocido al registrar pago');
  }
};
```

---

## Testing

### 1. Test: Pago Completo

```typescript
describe('Pago Completo', () => {
  it('debe crear pago completo y marcar ticket como PAID', async () => {
    // Setup
    const ticketId = createWinnerTicket({ totalPayout: 100 });

    // Action
    const payment = await ticketPaymentAPI.create({
      ticketId,
      amountPaid: 100,
      idempotencyKey: 'test-full-payment'
    });

    // Assert
    expect(payment.amountPaid).toBe(100);
    expect(payment.isPartial).toBe(false);
    expect(payment.remainingAmount).toBe(0);
    expect(payment.completedAt).toBeDefined();

    // Verify ticket status
    const ticket = await ticketAPI.getById(ticketId);
    expect(ticket.status).toBe('PAID');
  });
});
```

### 2. Test: Pago Parcial

```typescript
describe('Pago Parcial', () => {
  it('debe crear pago parcial sin cambiar status a PAID', async () => {
    const ticketId = createWinnerTicket({ totalPayout: 100 });

    const payment = await ticketPaymentAPI.create({
      ticketId,
      amountPaid: 30,
      idempotencyKey: 'test-partial-payment'
    });

    expect(payment.amountPaid).toBe(30);
    expect(payment.isPartial).toBe(true);
    expect(payment.remainingAmount).toBe(70);
    expect(payment.completedAt).toBeNull();

    const ticket = await ticketAPI.getById(ticketId);
    expect(ticket.status).toBe('EVALUATED'); // Sigue pendiente
  });
});
```

### 3. Test: Bloqueo de Múltiples Parciales

```typescript
describe('Bloqueo de Múltiples Parciales', () => {
  it('debe rechazar segundo pago parcial mientras hay uno pendiente', async () => {
    const ticketId = createWinnerTicket({ totalPayout: 100 });

    // Primer pago parcial
    await ticketPaymentAPI.create({
      ticketId,
      amountPaid: 30
    });

    // Segundo pago parcial (debería fallar)
    try {
      await ticketPaymentAPI.create({
        ticketId,
        amountPaid: 40
      });
      expect.fail('Should have thrown error');
    } catch (error) {
      expect(error.response?.data?.code).toBe('TKT_PAY_005');
    }
  });
});
```

### 4. Test: Idempotencia

```typescript
describe('Idempotencia', () => {
  it('debe retornar el mismo pago si se reintenta con misma key', async () => {
    const ticketId = createWinnerTicket({ totalPayout: 100 });
    const idempotencyKey = 'unique-key-123';

    // Primer intento
    const payment1 = await ticketPaymentAPI.create({
      ticketId,
      amountPaid: 50,
      idempotencyKey
    });

    // Segundo intento con misma key
    const payment2 = await ticketPaymentAPI.create({
      ticketId,
      amountPaid: 50,
      idempotencyKey
    });

    expect(payment1.id).toBe(payment2.id);

    // Verificar que no se crearon 2 pagos
    const history = await ticketPaymentAPI.getPaymentHistory(ticketId);
    expect(history.payments.length).toBe(1);
  });
});
```

### 5. Test: Reversión

```typescript
describe('Reversión de Pago', () => {
  it('debe marcar como revertido y volver ticket a EVALUATED', async () => {
    const ticketId = createWinnerTicket({ totalPayout: 100 });

    // Pago completo
    const payment = await ticketPaymentAPI.create({
      ticketId,
      amountPaid: 100
    });

    // Verificar que ticket está PAID
    let ticket = await ticketAPI.getById(ticketId);
    expect(ticket.status).toBe('PAID');

    // Revertir pago
    await ticketPaymentAPI.reverse(payment.id);

    // Verificar reversión
    const reversedPayment = await ticketPaymentAPI.getById(payment.id);
    expect(reversedPayment.isReversed).toBe(true);

    // Verificar que ticket vuelve a EVALUATED
    ticket = await ticketAPI.getById(ticketId);
    expect(ticket.status).toBe('EVALUATED');
  });
});
```

### 6. Checklist QA Manual

- [ ] Crear pago completo → status PAID ✓
- [ ] Crear pago parcial → status EVALUATED ✓
- [ ] Bloquea 2do parcial sin cerrar ✓
- [ ] Pago final parcial → status PAID ✓
- [ ] Idempotencia funciona ✓
- [ ] Revertir pago completo → EVALUATED ✓
- [ ] Revertir pago parcial ✓
- [ ] VENTANA no puede pagar otra ventana ✓
- [ ] VENDEDOR no puede acceder ✓
- [ ] Historial de pagos correcto ✓
- [ ] Monto máximo validado ✓
- [ ] Métodos de pago listados ✓
- [ ] Notas guardadas ✓
- [ ] Timestamps correctos ✓
- [ ] Auditoría registrada ✓

---

## Resumen para Implementación

### Quick Start

1. **Usar Hook**: `useTicketPayment()`
2. **Componentes**: `PaymentSummaryCard`, `PartialPaymentModal`, `PaymentHistoryTable`
3. **Flujos**: Completo, Parcial, Final Parcial, Reversión
4. **Errores**: Mapear códigos a mensajes amigables
5. **Testing**: 6 test cases + checklist QA

### Homogeneidad

✅ Mismo patrón que módulos Ventas y Dashboard
✅ RBAC implementado consistentemente
✅ Paginación estándar
✅ Filtros y sorting uniformes
✅ Response format consistent

### Production Ready

✅ Transacciones atómicas
✅ Idempotencia soportada
✅ Auditoría completa
✅ Validaciones estrictas
✅ RBAC enforcement
✅ **LISTO PARA IMPLEMENTAR**

