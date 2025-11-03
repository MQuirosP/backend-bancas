# 📋 API de Mayorización de Saldos Pendientes - Documentación para FE

## Descripción General

La API de Mayorización permite calcular, visualizar y registrar pagos/cobros de saldos pendientes (CXC/CXP) entre la banca y los listeros/vendedores. Integra datos de Tickets y Jugadas del período para generar un resumen de deudas.

**Base URL:** `https://api.tudominio.com/api/v1/accounts`

---

## Estándar de Respuesta

Todas las respuestas siguen este formato:

```json
{
  "success": true,
  "data": {
    // ... contenido específico del endpoint
  }
}
```

En caso de error:

```json
{
  "success": false,
  "error": {
    "message": "Descripción del error",
    "code": "CODIGO_ERROR"
  }
}
```

---

## ENDPOINTS

### 1. Calcular Mayorización para un Período

**Método:** `POST`
**Ruta:** `/accounts/:accountId/majorization/calculate`
**Autenticación:** Requerida (Bearer Token)
**RBAC:** ADMIN, VENTANA (propia), VENDEDOR (propio)

#### Request

```bash
POST /api/v1/accounts/550e8400-e29b-41d4-a716-446655440000/majorization/calculate?fromDate=2025-11-01&toDate=2025-11-07&includeDesglose=false
```

**Query Parameters:**

| Parámetro | Tipo | Obligatorio | Descripción |
|-----------|------|-------------|-------------|
| `fromDate` | YYYY-MM-DD | Sí | Fecha inicio del período |
| `toDate` | YYYY-MM-DD | Sí | Fecha fin del período |
| `includeDesglose` | boolean | No | Si incluir desglose por lotería/banda (default: false) |

#### Response (201 Created)

```json
{
  "success": true,
  "data": {
    "id": "clnt1a2b3c4d5e6f",
    "accountId": "550e8400-e29b-41d4-a716-446655440000",
    "ownerType": "VENTANA",
    "ownerId": "vendor-uuid",
    "ownerName": "Listero X",
    "fromDate": "2025-11-01",
    "toDate": "2025-11-07",
    "totalSales": 500000,
    "totalPrizes": 420000,
    "totalCommission": 15000,
    "netOperative": 485000,
    "debtStatus": "CXC",
    "debtAmount": 485000,
    "debtDescription": "Le debemos 485,000 al listero",
    "isSettled": false,
    "computedAt": "2025-11-03T15:30:00Z",
    "entries": []
  }
}
```

**Códigos de error:**

- `404` - Cuenta no encontrada
- `500` - Error en cálculo de mayorización

---

### 2. Obtener Historial de Mayorizaciones

**Método:** `GET`
**Ruta:** `/accounts/mayorizations/history`
**Autenticación:** Requerida (Bearer Token)
**RBAC:** Aplicado automáticamente según rol

#### Request

```bash
GET /api/v1/accounts/mayorizations/history?period=week&debtStatus=CXC&isSettled=false&page=1&pageSize=20&orderBy=debtAmount&order=desc
```

**Query Parameters:**

| Parámetro | Tipo | Obligatorio | Opciones | Descripción |
|-----------|------|-------------|----------|-------------|
| `period` | string | No | today, yesterday, week, month, year, range | Período preestablecido (default: today) |
| `fromDate` | YYYY-MM-DD | Condicional | - | Fecha inicio si period=range |
| `toDate` | YYYY-MM-DD | Condicional | - | Fecha fin si period=range |
| `ownerType` | string | No | VENTANA, VENDEDOR | Filtrar por tipo |
| `ownerId` | UUID | No | - | Filtrar por listero/vendedor específico |
| `debtStatus` | string | No | CXC, CXP, BALANCE | Filtrar por estado de deuda |
| `isSettled` | boolean | No | true, false | Filtrar por si ya fue liquidado |
| `page` | integer | No | - | Página (default: 1) |
| `pageSize` | integer | No | - | Registros por página (default: 20) |
| `orderBy` | string | No | date, debtAmount, netOperative | Campo para ordenar (default: date) |
| `order` | string | No | asc, desc | Dirección (default: desc) |

#### Response (200 OK)

```json
{
  "success": true,
  "data": {
    "mayorizations": [
      {
        "id": "clnt1a2b3c4d5e6f",
        "accountId": "550e8400-e29b-41d4-a716-446655440000",
        "ownerType": "VENTANA",
        "ownerId": "vendor-uuid",
        "ownerName": "Listero X",
        "period": {
          "fromDate": "2025-11-01",
          "toDate": "2025-11-07"
        },
        "metrics": {
          "totalSales": 500000,
          "totalPrizes": 420000,
          "totalCommission": 15000,
          "netOperative": 485000
        },
        "debtStatus": {
          "status": "CXC",
          "amount": 485000,
          "description": "Le debemos 485,000 al listero"
        },
        "settlement": {
          "isSettled": false,
          "settledDate": null,
          "settledAmount": null,
          "type": null,
          "reference": null
        },
        "computedAt": "2025-11-03T15:30:00Z"
      }
    ],
    "pagination": {
      "page": 1,
      "pageSize": 20,
      "total": 15,
      "totalPages": 1
    },
    "summary": {
      "totalCXC": 2500000,
      "totalCXP": 150000,
      "balance": 2350000
    }
  }
}
```

**Códigos de error:**

- `400` - Parámetros de validación inválidos
- `500` - Error en obtención de historial

---

### 3. Registrar Pago o Cobro (Settlement)

**Método:** `POST`
**Ruta:** `/accounts/mayorizations/settle`
**Autenticación:** Requerida (Bearer Token)
**RBAC:** ADMIN, VENTANA (si es su mayorización)
**Idempotencia:** Soportada via `requestId`

#### Request

```bash
POST /api/v1/accounts/mayorizations/settle
Content-Type: application/json

{
  "mayorizationId": "clnt1a2b3c4d5e6f",
  "amount": 250000,
  "settlementType": "PAYMENT",
  "date": "2025-11-03",
  "reference": "Cheque #12345",
  "note": "Pago parcial de CXC",
  "requestId": "req-unique-id-12345"
}
```

**Body Parameters:**

| Parámetro | Tipo | Obligatorio | Descripción |
|-----------|------|-------------|-------------|
| `mayorizationId` | UUID | Sí | ID de la mayorización a liquidar |
| `amount` | number | Sí | Monto (debe ser > 0) |
| `settlementType` | string | Sí | PAYMENT (pagamos) o COLLECTION (cobramos) |
| `date` | YYYY-MM-DD | Sí | Fecha del pago/cobro |
| `reference` | string | Sí | Referencia (cheque, transfer, etc) |
| `note` | string | No | Nota adicional |
| `requestId` | string | No | ID único para idempotencia |

#### Response (201 Created)

```json
{
  "success": true,
  "data": {
    "mayorization": {
      "id": "clnt1a2b3c4d5e6f",
      "accountId": "550e8400-e29b-41d4-a716-446655440000",
      "ownerType": "VENTANA",
      "ownerId": "vendor-uuid",
      "ownerName": "Listero X",
      "fromDate": "2025-11-01",
      "toDate": "2025-11-07",
      "totalSales": 500000,
      "totalPrizes": 420000,
      "totalCommission": 15000,
      "netOperative": 485000,
      "debtStatus": "CXC",
      "debtAmount": 485000,
      "debtDescription": "Le debemos 485,000 al listero",
      "isSettled": true,
      "settledDate": "2025-11-03",
      "settledAmount": 250000,
      "settlementType": "PAYMENT",
      "settlementRef": "Cheque #12345",
      "settledBy": "admin-uuid",
      "computedAt": "2025-11-03T15:30:00Z"
    },
    "ledgerEntry": {
      "id": "entry-uuid-123",
      "type": "ADJUSTMENT",
      "amount": -250000,
      "date": "2025-11-03",
      "createdAt": "2025-11-03T16:00:00Z"
    },
    "newBalance": 235000
  }
}
```

**Códigos de error:**

- `404` - Mayorización no encontrada
- `400` - Monto inválido o parámetros faltantes
- `409` - Conflicto (requestId duplicado)
- `500` - Error en registro de pago

---

## Flujo de Uso Recomendado (FE)

### Escenario: Panel de Mayorización de Saldos

```
1. Usuario entra a "Pantalla de Mayorización"
   ↓
2. FE hace GET /accounts/mayorizations/history?period=week
   ↓
3. FE muestra tabla de mayorizaciones:
   - Período
   - Listero/Vendedor
   - Total Ventas | Premios | Comisión | Neto
   - Estado (CXC/CXP/BALANCE)
   - Monto a pagar/cobrar
   - Si fue liquidado
   ↓
4. Usuario selecciona una fila para detalles
   ↓
5. FE abre panel lateral con:
   - Información de la mayorización
   - Botón "Registrar Pago/Cobro"
   ↓
6. Usuario hace clic en botón → abre modal
   ↓
7. Modal captura:
   - Tipo (PAYMENT/COLLECTION)
   - Monto
   - Fecha
   - Referencia
   - Nota (opcional)
   ↓
8. FE hace POST /accounts/mayorizations/settle
   ↓
9. Response actualiza tabla con isSettled=true
   ↓
10. FE muestra mensaje de éxito
```

---

## Ejemplos de Integración (JavaScript/React)

### 1. Obtener Historial de Mayorizaciones

```javascript
const fetchMayorizations = async (filters = {}) => {
  const params = new URLSearchParams({
    period: filters.period || 'week',
    page: filters.page || 1,
    pageSize: filters.pageSize || 20,
    ...filters,
  });

  const response = await fetch(
    `/api/v1/accounts/mayorizations/history?${params}`,
    {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
    }
  );

  if (!response.ok) {
    throw new Error('Error fetching mayorizations');
  }

  return response.json();
};

// Uso:
try {
  const data = await fetchMayorizations({
    period: 'week',
    debtStatus: 'CXC',
    page: 1,
  });

  setMayorizations(data.data.mayorizations);
  setSummary(data.data.summary);
  setPagination(data.data.pagination);
} catch (error) {
  console.error(error);
  showError('No se pudo cargar las mayorizaciones');
}
```

### 2. Calcular Mayorización

```javascript
const calculateMajorization = async (accountId, fromDate, toDate) => {
  const response = await fetch(
    `/api/v1/accounts/${accountId}/majorization/calculate?fromDate=${fromDate}&toDate=${toDate}`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
    }
  );

  if (!response.ok) {
    throw new Error('Error calculating majorization');
  }

  return response.json();
};
```

### 3. Registrar Pago/Cobro

```javascript
const settleMajorization = async (paymentData) => {
  const response = await fetch(
    `/api/v1/accounts/mayorizations/settle`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        mayorizationId: paymentData.mayorizationId,
        amount: parseFloat(paymentData.amount),
        settlementType: paymentData.settlementType, // 'PAYMENT' o 'COLLECTION'
        date: paymentData.date, // YYYY-MM-DD
        reference: paymentData.reference,
        note: paymentData.note,
        requestId: generateUniqueId(), // Para idempotencia
      }),
    }
  );

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error?.message || 'Error settling majorization');
  }

  return response.json();
};

// Uso en form de pago:
const handlePayment = async (formData) => {
  try {
    const result = await settleMajorization({
      mayorizationId: selectedMajorization.id,
      amount: formData.amount,
      settlementType: formData.type, // PAYMENT
      date: formData.date,
      reference: formData.reference,
      note: formData.note,
    });

    showSuccess('Pago registrado correctamente');
    refreshMayorizations();
  } catch (error) {
    showError(error.message);
  }
};
```

---

## Mapeo de Conceptos

| Concepto | Valor | Significado |
|----------|-------|-------------|
| **debtStatus** | CXC | Cuentas por Cobrar = nosotros les debemos |
| **debtStatus** | CXP | Cuentas por Pagar = ellos nos deben |
| **debtStatus** | BALANCE | Balance cuadrado = no hay deuda |
| **settlementType** | PAYMENT | Pagamos (reduce CXC) |
| **settlementType** | COLLECTION | Cobramos (reduce CXP) |
| **netOperative** | totalSales - totalCommission | Neto a pagar/cobrar |
| **isSettled** | true | La mayorización ya fue liquidada |
| **isSettled** | false | La mayorización está pendiente |

---

## Notas Importantes

### RBAC (Control de Acceso)

- **ADMIN**: Ve todas las mayorizaciones de todas las ventanas/vendedores
- **VENTANA**: Solo ve mayoraciones de su ventana y sus vendedores
- **VENDEDOR**: Solo ve sus propias mayoraciones

### Precisión Decimal

Todos los montos se manejan con precisión decimal en el backend. El FE debe:
- Mostrar con 0-2 decimales según locale
- NO hacer cálculos aritméticos en el cliente
- Enviar como `number` en JSON (backend lo convierte a Decimal)

### Idempotencia

El campo `requestId` previene duplicados en pagos:
- Generar UUID único por cada pago
- Si el servidor recibe el mismo `requestId`, retorna la respuesta anterior sin procesar nuevamente

### Auditoría

Cada mayorización y pago queda registrado en `ActivityLog`:
- Usuario que calculó/pagó
- Timestamp exacto
- Detalles de la operación
- Referencia de comprobante

---

## Troubleshooting

### Error 404 - Account Not Found

**Causa:** El accountId no existe o el usuario no tiene acceso

**Solución:** Verificar que:
1. El UUID sea válido
2. El usuario tenga permisos RBAC

### Error 400 - Invalid Parameters

**Causa:** Parámetros de fecha mal formados o faltantes

**Solución:** Asegurar que:
1. Fechas estén en formato YYYY-MM-DD
2. amount > 0
3. settlementType sea PAYMENT o COLLECTION

### Error 500 - Internal Server Error

**Causa:** Error en BD o cálculo

**Solución:**
1. Revisar logs del servidor
2. Asegurar que Tickets/Jugadas tengan datos válidos

---

## Support

Para reportar problemas o sugerencias, contactar al equipo de Backend.
