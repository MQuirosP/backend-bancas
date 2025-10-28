# 🔄 Flujo Completo: Crear Usuario → Realizar Pago

**Cómo funciona el sistema de pago de tiquetes de extremo a extremo**

---

## 1️⃣ REGISTRO DE USUARIO (POST /auth/register)

### Para VENTANA (Gerente de Ventana)

```javascript
POST /auth/register
{
  "name": "María García",
  "email": "maria@ventana.com",
  "username": "maria_ventana",
  "password": "secure-pass-123",
  "role": "VENTANA",
  "ventanaId": "550e8400-e29b-41d4-a716-446655440000"  // ✅ REQUERIDO
}
```

**Validación Backend**:
- ✅ Verifica que ventanaId existe en DB (FK check)
- ✅ Crea usuario con ventanaId asignado
- ❌ Si ventanaId falta → Error 400
- ❌ Si ventanaId no existe → Error 404

**Response 201**:
```json
{
  "message": "User registered successfully",
  "user": {
    "id": "user-maria-uuid",
    "email": "maria@ventana.com",
    "username": "maria_ventana",
    "role": "VENTANA"
  }
}
```

### Para VENDEDOR (Vendedor)

```javascript
POST /auth/register
{
  "name": "Juan Pérez",
  "email": "juan@vendedor.com",
  "username": "juan_vendedor",
  "password": "secure-pass-456",
  "role": "VENDEDOR",
  "ventanaId": "550e8400-e29b-41d4-a716-446655440000"  // ✅ REQUERIDO
}
```

**Validación Backend**:
- ✅ Verifica que ventanaId existe
- ✅ Crea usuario con ventanaId asignado
- ❌ Si ventanaId falta → Error 400
- ❌ Si ventanaId no existe → Error 404

### Para ADMIN (Administrador)

```javascript
POST /auth/register
{
  "name": "Administrador",
  "email": "admin@system.com",
  "username": "admin_user",
  "password": "admin-pass-789",
  "role": "ADMIN",
  "ventanaId": null  // ❌ NO REQUERIDO para ADMIN
}
```

**Validación Backend**:
- ✅ ventanaId es opcional para ADMIN
- ✅ Crea usuario sin asignar ventanaId

---

## 2️⃣ LOGIN (POST /auth/login)

```javascript
POST /auth/login
{
  "username": "maria_ventana",
  "password": "secure-pass-123"
}
```

**Response 200**:
```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

**JWT Decodificado** (accessToken):
```json
{
  "sub": "user-maria-uuid",
  "role": "VENTANA",
  "iat": 1635360000,
  "exp": 1635363600
}
```

⚠️ **PROBLEMA ANTERIOR**: El JWT **no incluía `ventanaId`**

✅ **AHORA**: El JWT se genera correctamente, pero necesita decodificarse con `/auth/me`

---

## 3️⃣ OBTENER USUARIO ACTUAL (GET /auth/me)

### Request

```javascript
GET /auth/me
Authorization: Bearer <accessToken>
```

### Response 200

**Para VENTANA**:
```json
{
  "id": "user-maria-uuid",
  "email": "maria@ventana.com",
  "username": "maria_ventana",
  "name": "María García",
  "role": "VENTANA",
  "vendedorId": null,
  "ventanaId": "550e8400-e29b-41d4-a716-446655440000"  // ✅ AQUÍ VIENE
}
```

**Para VENDEDOR**:
```json
{
  "id": "user-juan-uuid",
  "email": "juan@vendedor.com",
  "username": "juan_vendedor",
  "name": "Juan Pérez",
  "role": "VENDEDOR",
  "vendedorId": "user-juan-uuid",
  "ventanaId": "550e8400-e29b-41d4-a716-446655440000"  // ✅ AQUÍ VIENE
}
```

**Para ADMIN**:
```json
{
  "id": "user-admin-uuid",
  "email": "admin@system.com",
  "username": "admin_user",
  "name": "Administrador",
  "role": "ADMIN",
  "vendedorId": null,
  "ventanaId": null
}
```

### Frontend debe guardar en sessionStorage/localStorage

```javascript
// Después de /auth/me
localStorage.setItem('user', JSON.stringify({
  id: response.id,
  role: response.role,
  ventanaId: response.ventanaId,  // ✅ Guardar esto
  vendedorId: response.vendedorId
}));
```

---

## 4️⃣ REGISTRAR PAGO (POST /api/v1/ticket-payments)

### Request - VENTANA

```javascript
POST /api/v1/ticket-payments
Authorization: Bearer <accessToken>
Content-Type: application/json

{
  "ticketId": "tiquete-de-mi-ventana-uuid"
}
```

### Backend - VENTANA

Extrae del contexto:
```typescript
{
  id: "user-maria-uuid",          // De JWT
  role: "VENTANA",                 // De JWT
  ventanaId: "ventana-uuid"        // De JWT (via /auth/me)
}
```

Valida:
```typescript
if (!actor.ventanaId) {
  throw new AppError("TKT_PAY_006", 403);  // ❌ Falla si ventanaId = null
}

if (ticket.ventanaId !== actor.ventanaId) {
  throw new AppError("TKT_PAY_006", 403);  // ❌ Falla si ventana no coincide
}
```

### Response 201 - Éxito

```json
{
  "id": "payment-uuid",
  "ticketId": "tiquete-uuid",
  "amountPaid": 100,
  "isPartial": false,
  "remainingAmount": 0,
  "completedAt": "2025-10-28T16:00:00Z",
  "paidById": "user-maria-uuid"
}
```

### Response 403 - Fracaso

```json
{
  "statusCode": 403,
  "code": "TKT_PAY_006",
  "message": "Unauthorized"
}
```

**Causas**:
- `ventanaId = null` en JWT (usuario no fue registrado con ventanaId)
- `ticket.ventanaId ≠ actor.ventanaId` (tiquete pertenece a otra ventana)

---

## 📊 Flujo Completo - Diagrama

```
┌─────────────────────────────────────────────────────────────┐
│ 1. REGISTRO (POST /auth/register)                          │
│                                                             │
│ Frontend envía:                                            │
│ {                                                          │
│   role: "VENTANA",                                         │
│   ventanaId: "uuid"  ← CRÍTICO                             │
│ }                                                          │
│                                                             │
│ Backend:                                                    │
│ - Valida que ventanaId existe                              │
│ - Crea usuario CON ventanaId asignado                      │
└─────────────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────────────┐
│ 2. LOGIN (POST /auth/login)                                 │
│                                                             │
│ Frontend envía:                                            │
│ { username, password }                                     │
│                                                             │
│ Backend:                                                    │
│ - Valida credenciales                                       │
│ - Genera JWT con: { sub, role }                            │
│ - Devuelve accessToken + refreshToken                      │
└─────────────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────────────┐
│ 3. OBTENER USUARIO (GET /auth/me)                           │
│                                                             │
│ Frontend envía:                                            │
│ Authorization: Bearer <accessToken>                        │
│                                                             │
│ Backend:                                                    │
│ - Lee JWT (extrae userId)                                   │
│ - Busca usuario en DB                                       │
│ - Devuelve: { id, role, ventanaId, ... }                  │
│                                                             │
│ Frontend:                                                   │
│ - Guarda en sessionStorage: { role, ventanaId }            │
└─────────────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────────────┐
│ 4. REGISTRAR PAGO (POST /api/v1/ticket-payments)            │
│                                                             │
│ Frontend envía:                                            │
│ {                                                          │
│   ticketId: "uuid"                                         │
│ }                                                          │
│ + Authorization: Bearer <accessToken>                      │
│                                                             │
│ Backend:                                                    │
│ - Extrae actor: { id, role, ventanaId }                    │
│ - Valida: actor.ventanaId !== null ✅                      │
│ - Valida: ticket.ventanaId === actor.ventanaId ✅          │
│ - Crea pago                                                │
│                                                             │
│ Response: 201 ✅ o 403 ❌                                   │
└─────────────────────────────────────────────────────────────┘
```

---

## 🔑 Puntos Críticos

### ✅ Lo Que Funciona Ahora

1. **Registro**: VENTANA **DEBE** enviar `ventanaId`
2. **DB**: Usuario se crea con `ventanaId` asignado
3. **JWT**: Incluye `sub` y `role`
4. **/auth/me**: Devuelve `ventanaId` basado en la DB
5. **Pago**: Extrae `ventanaId` del actor (viene de `/auth/me`)

### ❌ Lo Que Fallaba Antes

1. **Registro**: `ventanaId` era ignorado (quedaba NULL)
2. **DB**: Usuario se creaba sin `ventanaId`
3. **JWT**: No incluía `ventanaId` (pero el token no lo necesita)
4. **/auth/me**: Devolvía `ventanaId: null`
5. **Pago**: Fallaba porque `actor.ventanaId = null`

---

## 📝 Cambios en el Código

### auth.dto.ts
```typescript
export interface RegisterDTO {
  // ...
  ventanaId?: string;  // ← AGREGADO
}
```

### auth.service.ts (register)
```typescript
// Validar VENTANA y VENDEDOR
if ((role === 'VENTANA' || role === 'VENDEDOR') && !data.ventanaId) {
  throw new AppError('ventanaId is required', 400);
}

// Validar que ventanaId existe
if (data.ventanaId) {
  const ventana = await prisma.ventana.findUnique({ where: { id: data.ventanaId } });
  if (!ventana) {
    throw new AppError('ventana not found', 404);
  }
}

// Asignar ventanaId
const user = await prisma.user.create({
  data: {
    // ...
    ventanaId: data.ventanaId ?? null,  // ← AGREGADO
  },
});
```

---

## ✅ Resumen

| Paso | Antes | Ahora |
|------|-------|-------|
| **Registro** | ventanaId ignorado | ventanaId requerido para VENTANA/VENDEDOR |
| **DB** | User.ventanaId = NULL | User.ventanaId = uuid |
| **/auth/me** | Devuelve ventanaId: null | Devuelve ventanaId: uuid |
| **Pago** | 403 (actor.ventanaId = null) | 201 (actor.ventanaId = uuid) |

---

## 🚀 Ahora Funciona

```bash
# 1. Registrar VENTANA con ventanaId
curl -X POST http://localhost:3000/auth/register \
  -d '{"role":"VENTANA", "ventanaId":"uuid", ...}'
# ✅ 201

# 2. Login
curl -X POST http://localhost:3000/auth/login \
  -d '{"username":"...", "password":"..."}'
# ✅ 200 { accessToken, refreshToken }

# 3. /auth/me (con token)
curl -X GET http://localhost:3000/auth/me \
  -H "Authorization: Bearer <token>"
# ✅ 200 { ..., ventanaId: "uuid" }

# 4. Registrar pago (con token)
curl -X POST http://localhost:3000/api/v1/ticket-payments \
  -H "Authorization: Bearer <token>" \
  -d '{"ticketId":"uuid"}'
# ✅ 201 Pago registrado
```

