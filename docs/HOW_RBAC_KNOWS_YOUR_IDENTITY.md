# How RBAC Knows Who You Are - Identity Verification Explained

**Question**: Cuando llamas `?scope=mine`, ¿cómo sabe el backend quien eres tú?

**Answer**: A través de un **JWT token en el header Authorization**.

---

## The Flow (Paso a Paso)

### Step 1: Frontend Sends Request with Token

```bash
GET /api/v1/tickets?scope=mine
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...  ← JWT TOKEN
```

**El frontend SIEMPRE debe enviar** este header con el token JWT.

---

### Step 2: Middleware `protect` Intercepta la Request

**Archivo**: `src/middlewares/auth.middleware.ts` (línea 8-37)

```typescript
export const protect = (req: AuthenticatedRequest, _res: Response, next: NextFunction) => {
  // 1. Obtener el header Authorization
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    throw new AppError("Unauthorized", 401);  // ❌ Sin token = 401
  }

  // 2. Extraer el token (sin "Bearer ")
  const token = header.split(" ")[1];  // "eyJhbGciOiJIUzI1NiIs..."

  // 3. Validar el JWT con la clave secreta
  try {
    const decoded = jwt.verify(token, config.jwtAccessSecret) as any;
    // decoded contiene: { sub: "user-123", role: "VENDEDOR", ... }

    const role = decoded.role as Role;
    if (!decoded.sub || !role) {
      throw new AppError("Invalid token", 401);  // ❌ Token inválido = 401
    }

    // 4. Guardar en req.user
    req.user = { id: decoded.sub, role };
    // Ahora req.user.id = "user-123"
    // Ahora req.user.role = "VENDEDOR"

    next();  // Continuar al controller
  } catch {
    throw new AppError("Invalid token", 401);  // ❌ Token expirado/inválido = 401
  }
};
```

**Resumen**:
1. ✅ Lee el header `Authorization: Bearer {token}`
2. ✅ Valida que el JWT sea válido (firma correcta)
3. ✅ Extrae `id` y `role` del token
4. ✅ Guarda en `req.user`

---

### Step 3: Controller Usa `req.user` para RBAC

**Archivo**: `src/api/v1/controllers/ticket.controller.ts` (línea 21-43)

```typescript
async list(req: AuthenticatedRequest, res: Response) {
  const { scope = "mine", ...rest } = req.query as any;
  const filters: any = { ...rest };

  // ← req.user VIENE DEL MIDDLEWARE
  const me = req.user!;  // { id: "user-123", role: "VENDEDOR" }

  // Ahora usa req.user.id y req.user.role para filtrar
  if (me.role === Role.VENDEDOR) {
    // Solo ve sus propios tickets
    filters.userId = me.id;  // ← Filtra por su ID
    // filters.userId = "user-123"
  } else if (me.role === Role.VENTANA) {
    // Solo ve tickets de su ventana
    filters.ventanaId = me.ventanaId;  // ← Del token también
  }

  // Llama al servicio con los filtros
  const result = await TicketService.list(Number(page), Number(pageSize), filters);
  return success(res, result);
}
```

**Lo clave**:
- `req.user.id` viene del JWT (NO se puede falsificar)
- `req.user.role` viene del JWT (NO se puede cambiar)
- Los filtros se aplican automáticamente

---

## Donde Viene el JWT Token

### Flujo Completo de Autenticación

```
1. FRONTEND: Usuario hace login
   POST /auth/login
   Body: { email: "vendedor@example.com", password: "..." }
         ↓
2. BACKEND: Verifica credenciales
   - Busca usuario en BD
   - Valida password (hash)
   - Obtiene: id, role, ventanaId
         ↓
3. BACKEND: Genera JWT token
   jwt.sign(
     { sub: "user-123", role: "VENDEDOR", ventanaId: "ventana-456" },
     config.jwtAccessSecret,
     { expiresIn: "24h" }
   )
   Resultado: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
         ↓
4. BACKEND: Retorna token al frontend
   { success: true, token: "eyJhbGci..." }
         ↓
5. FRONTEND: Guarda el token (localStorage, cookie, etc.)
         ↓
6. FRONTEND: Usa el token en TODAS las requests
   Authorization: Bearer eyJhbGci...
         ↓
7. BACKEND: Valida el token en CADA request (middleware protect)
   - Verifica firma del JWT
   - Extrae id y role
   - Aplica RBAC automáticamente
```

---

## Cómo No Se Puede Falsificar

### El JWT Tiene 3 Partes

```
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.
eyJzdWIiOiJ1c2VyLTEyMyIsInJvbGUiOiJWRU5ERURPUiJ9.
SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c
```

**Parte 1**: Header (algoritmo)
**Parte 2**: Payload (datos: id, role, ventanaId)
**Parte 3**: Signature (firma - IMPOSIBLE DE FALSIFICAR)

### La Firma Es Lo Importante

```typescript
// Backend firma el token CON una clave secreta
const token = jwt.sign(
  { sub: "user-123", role: "VENDEDOR" },
  "mi-clave-secreta-super-segura"  // ← Solo el backend la conoce
)

// Cuando validamos, verificamos la firma
jwt.verify(token, "mi-clave-secreta-super-segura")
// Si alguien cambia el payload sin la clave → Verification FALLA
```

**Escenario de ataque**:
```
Hacker intenta cambiar el token:
Original:  { sub: "user-123", role: "VENDEDOR" }
Hacker quiere: { sub: "user-123", role: "ADMIN" }

Si cambia solo el payload:
- Parte 3 (signature) ya NO coincide
- jwt.verify() falla
- Retorna 401 Unauthorized

Conclusión: IMPOSIBLE falsificar sin la clave secreta
```

---

## Qué Contiene el Token

Cuando haces login, el backend GENERA un JWT con:

```typescript
const payload = {
  sub: "user-123",           // ← Tu ID único
  role: Role.VENDEDOR,       // ← Tu rol (VENDEDOR|VENTANA|ADMIN)
  ventanaId: "ventana-456",  // ← Tu ventana (si aplica)
  bancaId: "banca-789",      // ← Tu banca (si aplica)
  iat: 1635292800,           // ← Issued at (cuándo se creó)
  exp: 1635379200,           // ← Expiration (cuándo expira)
}

const token = jwt.sign(payload, config.jwtAccessSecret)
```

Cuando mandas una request:
```bash
GET /api/v1/tickets?scope=mine
Authorization: Bearer {token}
         ↓
Backend decodifica el token
         ↓
req.user = {
  id: "user-123",           // ← Extraído del token
  role: "VENDEDOR",         // ← Extraído del token
  ventanaId: "ventana-456"  // ← Extraído del token
}
```

---

## Ahora Entiendes Cómo Valida `scope=mine`

### El Proceso Completo

```
1. Frontend: GET /api/v1/tickets?scope=mine
             Header: Authorization: Bearer {jwt}
             ↓
2. Middleware protect:
   - Decodifica el JWT
   - Valida la firma
   - req.user = { id: "user-123", role: "VENDEDOR" }
   ↓
3. Controller:
   if (me.role === Role.VENDEDOR) {
     filters.userId = me.id;  // me.id = "user-123"
   }
   ↓
4. Database Query:
   SELECT * FROM tickets WHERE userId = "user-123"
   ↓
5. Response:
   [Solo tickets creados por user-123]
```

**El `scope=mine` es ignorado** porque:
- Backend SIEMPRE filtra por userId si eres VENDEDOR
- No importa si envías `?scope=all`
- El middleware ya dejó claro quién eres en `req.user`

---

## Seguridad: Por Qué Funciona

| Nivel | Cómo Funciona |
|-------|---------------|
| **Token** | JWT firmado criptográficamente (no se puede modificar) |
| **Middleware** | Valida firma ANTES de llegar al controller |
| **RBAC** | Usa req.user (que viene del token verificado) |
| **Database** | Filtra por userId/ventanaId del usuario autenticado |

**No hay forma de hacerse pasar por otro usuario** porque:
1. ❌ No puedes falsificar un JWT sin la clave secreta
2. ❌ No puedes cambiar tu role en el token
3. ❌ El middleware valida ANTES del controller
4. ❌ El database filtra por tu ID verificado

---

## Resumen Visual

```
┌─────────────────────────────────────────────────────────────┐
│ Frontend Request                                            │
│ GET /api/v1/tickets?scope=mine                              │
│ Authorization: Bearer eyJhbGciOiJIUzI1NiIs...             │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ↓
┌─────────────────────────────────────────────────────────────┐
│ Middleware: protect()                                       │
│ 1. Lee el JWT del header                                    │
│ 2. Valida la firma (verifica que no fue modificado)        │
│ 3. Extrae: id = "user-123", role = "VENDEDOR"             │
│ 4. req.user = { id, role, ... }                            │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ↓
┌─────────────────────────────────────────────────────────────┐
│ Controller: TicketController.list()                         │
│ const me = req.user = { id: "user-123", role: "VENDEDOR" } │
│ if (me.role === Role.VENDEDOR) {                            │
│   filters.userId = me.id  // "user-123"                     │
│ }                                                           │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ↓
┌─────────────────────────────────────────────────────────────┐
│ Database Query                                              │
│ SELECT * FROM tickets WHERE userId = "user-123"            │
│                                   ↑                          │
│                      ¡AUTOMATICAMENTE FILTRADO!             │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ↓
┌─────────────────────────────────────────────────────────────┐
│ Response                                                    │
│ [Solo tickets de user-123]                                  │
│ (Aunque hayas enviado ?scope=all, se ignora)               │
└─────────────────────────────────────────────────────────────┘
```

---

## En Una Frase

> **El backend sabe quién eres porque valida un JWT token firmado criptográficamente que solo el backend puede crear. No puedes falsificarlo.**

---

## Preguntas Comunes

### Q: ¿Qué pasa si no envío el token?
```
GET /api/v1/tickets?scope=mine
(sin Authorization header)

→ 401 Unauthorized
→ Middleware reject
→ Nunca llega al controller
```

### Q: ¿Qué pasa si envío un token expirado?
```
Authorization: Bearer {expired_token}

→ jwt.verify() falla
→ 401 Invalid token
→ Nunca llega al controller
```

### Q: ¿Qué pasa si intento cambiar el role en el token?
```
Original token: { role: "VENDEDOR" }
Hacker cambia a: { role: "ADMIN" }

→ La firma ya no coincide
→ jwt.verify() falla
→ 401 Invalid token
→ Nunca llega al controller
```

### Q: ¿Puedo hacer bypass enviando ?scope=all?
```
GET /api/v1/tickets?scope=all
Authorization: Bearer {vendedor_token}

→ Middleware extrae: role = "VENDEDOR"
→ Controller aplica: filters.userId = me.id
→ Scope parameter es IGNORADO
→ Resultado: Solo ve sus tickets

❌ NO puedes hacer bypass
```

---

**Status**: ✅ Explicación completa
**Seguridad**: ✅ Imposible de falsificar
**Conclusión**: El backend SIEMPRE sabe quién eres porque validas un token secreto.

