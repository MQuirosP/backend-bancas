# Quick Answer: Cuando Dices "es mío", ¿Cómo Sabe Quién Eres?

**Tu pregunta**:
> Yo digo "es mío" (`scope=mine`) pero ¿cómo sabe quién soy yo?

**Respuesta corta**:
El backend NO confía en lo que dices. Verifica quien eres con un **JWT token** que tu frontend envía en el header `Authorization`.

---

## La Respuesta en 30 Segundos

```
1. Frontend hace login
   → Backend crea un JWT token secreto con tu ID
   → Frontend guarda el token

2. Frontend pide: GET /api/v1/tickets?scope=mine
   → Envía el token en header: Authorization: Bearer {token}

3. Backend valida el token
   → Verifica que NO fue modificado (signature)
   → Extrae tu ID y role del token
   → req.user = { id: "tu-id-real", role: "VENDEDOR" }

4. Backend filtra automáticamente
   → WHERE userId = "tu-id-real"
   → Aunque digas scope=mine o scope=all, NO importa
   → Filtra por tu ID del token

5. Frontend recibe
   → Solo tus tickets
```

---

## Por Qué No Puede Hacker

```
Hacker intenta fingir ser otro usuario:

Hacker manda:
GET /api/v1/tickets?userId=user-456  ← Intenta cambiar el ID
Authorization: Bearer {su-token-real}

Backend valida:
- Decodifica el token
- req.user.id = "hacker-id"  ← La verdad está en el token
- WHERE userId = "hacker-id"
- Resultado: Solo ve sus tickets

❌ No puede engañar al backend porque el token lo delata
```

---

## La Cadena de Confianza

```
┌──────────────────────────────────────────────┐
│ INICIO: Frontend hace login                  │
│ POST /auth/login                             │
│ { email: "vendedor@example.com" }            │
└────────────────┬─────────────────────────────┘
                 │
                 ↓
┌──────────────────────────────────────────────┐
│ Backend valida credenciales                  │
│ Busca usuario en BD                          │
│ Obtiene: id = "user-123", role = "VENDEDOR" │
└────────────────┬─────────────────────────────┘
                 │
                 ↓
┌──────────────────────────────────────────────┐
│ Backend CREA un JWT token                    │
│ Contiene: id=user-123, role=VENDEDOR        │
│ Firma con clave secreta SOLO el backend sabe │
│ Devuelve el token al frontend                 │
└────────────────┬─────────────────────────────┘
                 │
                 ↓
┌──────────────────────────────────────────────┐
│ Frontend guarda el token                      │
│ localStorage.setItem('token', token)          │
└────────────────┬─────────────────────────────┘
                 │
                 ↓
┌──────────────────────────────────────────────┐
│ Frontend pide datos                          │
│ GET /api/v1/tickets                          │
│ Authorization: Bearer {token-guardado}       │
└────────────────┬─────────────────────────────┘
                 │
                 ↓
┌──────────────────────────────────────────────┐
│ Backend VALIDA el token                      │
│ ✓ Verifica la firma (no fue modificado)     │
│ ✓ Extrae: id=user-123, role=VENDEDOR       │
│ ✓ req.user = { id, role }                    │
│ ✓ Aplica RBAC: WHERE userId=user-123       │
└────────────────┬─────────────────────────────┘
                 │
                 ↓
┌──────────────────────────────────────────────┐
│ Response: Solo tickets de user-123          │
│ Aunque hayas enviado ?scope=all o ?userId=99 │
└──────────────────────────────────────────────┘
```

---

## El Token Es Como Una Credencial de Identidad

```
Tu pasaporte (JWT):
┌─────────────────────────────────────┐
│ Nombre: user-123                    │
│ Role: VENDEDOR                      │
│ Expira: 2025-10-28                  │
│ Firma: SflKxwRJSMeKKF2QT4fw... (solo backend puede hacer) │
└─────────────────────────────────────┘

Cuando lo presentas en cada request:
Authorization: Bearer {pasaporte}

El backend verifica:
✓ ¿Es un pasaporte válido?
✓ ¿Fue creado por nosotros?
✓ ¿No está expirado?
✓ ¿Quién es (name = user-123)?
✓ ¿Cuál es su rol (VENDEDOR)?

Entonces aplica RBAC basado en el pasaporte, NO en lo que dices
```

---

## Qué Pasaría Si No Enviaras el Token

```
GET /api/v1/tickets?scope=mine
(sin Authorization header)

Backend responde:
❌ 401 Unauthorized
"El token está faltando. No sé quién eres."
```

---

## Qué Pasaría Si Falsificaras el Token

```
GET /api/v1/tickets?scope=mine
Authorization: Bearer eyJhbGciOiJIUzI1NiIsIn... (MODIFICADO)

Backend:
1. Lee el token
2. Intenta validar la firma
3. La firma NO coincide (porque lo modificaste)
4. Responde: ❌ 401 Invalid token
5. Nunca llega al controller
```

**Es imposible falsificar porque**:
- El JWT tiene 3 partes: header.payload.signature
- La signature se calcula CON la clave secreta
- Si cambias el payload, la signature ya no es válida
- El backend SIEMPRE valida la signature

---

## Resumiendo

| Lo Que Dices | Lo Que Importa | Resultado |
|--------------|----------------|-----------|
| `?scope=mine` | El JWT token que enviaste | Se filtra por tu ID del token |
| `?scope=all` | El JWT token que enviaste | Se filtra por tu ID del token |
| `?userId=456` | El JWT token que enviaste | Se filtra por tu ID del token |

**El parámetro `scope=mine` es IGNORADO**.
Lo que importa es el **JWT token** que demuestra quién eres realmente.

---

**La conclusión**:
> No es que el backend confíe en lo que dices. Valida quién eres con un token criptográficamente firmado que es imposible falsificar.

---

## Para los Muy Técnicos

El flujo RBAC:

```typescript
// 1. Middleware: valida y extrae identidad del JWT
const decoded = jwt.verify(token, secret_key)
req.user = { id: decoded.sub, role: decoded.role }

// 2. Controller: filtra basado en req.user (del token, no del parámetro)
if (req.user.role === "VENDEDOR") {
  filters.userId = req.user.id  // ← req.user del token
}

// 3. Database: ejecuta la query con los filtros
SELECT * FROM tickets WHERE userId = filters.userId
// filters.userId viene del token, NO del parámetro scope
```

**El parámetro `scope` es un "hint" para la UI, NO para la seguridad.**
La seguridad viene del JWT token en el header.

