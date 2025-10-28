# User Module Analysis - ventanaId Assignment & Role Management

## 📋 Overview

This document provides a comprehensive analysis of the user module, specifically examining how `ventanaId` is assigned when users are created with different roles (ADMIN, VENTANA, VENDEDOR).

**Status**: ✅ MOSTLY CORRECT with minor gaps

---

## 1. Current Implementation Analysis

### 1.1 User Creation Methods

The system has **TWO** endpoints for creating users:

#### Method 1: Public Registration (`POST /api/v1/auth/register`)
- **File**: `src/api/v1/services/auth.service.ts` (lines 14-48)
- **Requirements**: No authentication needed
- **DTO**: `RegisterDTO`
- **Validation**: auth.validator.ts (registerSchema)

#### Method 2: Admin User Creation (`POST /api/v1/users`)
- **File**: `src/api/v1/services/user.service.ts` (lines 19-75)
- **Requirements**: Admin authentication only
- **DTO**: `CreateUserDTO`
- **Validation**: user.validator.ts (createUserSchema)

---

## 2. Role & ventanaId Assignment Rules

### Current Rules Implementation

**In user.service.ts (lines 27-33):**
```typescript
if (role === Role.ADMIN) {
  dto.ventanaId = null as any;  // Force null for ADMIN
} else {
  if (!dto.ventanaId) throw new AppError('ventanaId is required for role ' + role, 400);
  await ensureVentanaActiveOrThrow(dto.ventanaId);  // Validate ventana exists AND is active
}
```

**Rule Summary:**
| Role | ventanaId Required? | Notes |
|------|-------|-------|
| **ADMIN** | ❌ NO (forced null) | Manages system, no window association |
| **VENTANA** | ✅ YES (required) | User manages a specific window |
| **VENDEDOR** | ✅ YES (required) | User sells through a specific window |

### ventanaId Assignment Storage

**In user.service.ts (line 60):**
```typescript
ventanaId: role === Role.ADMIN ? null : dto.ventanaId!,
```

This correctly assigns:
- `null` for ADMIN users
- The provided `ventanaId` for VENTANA/VENDEDOR users

---

## 3. Detailed Comparison: Public Register vs Admin Create

### Issue 1: ⚠️ INCONSISTENT VALIDATION BETWEEN ENDPOINTS

#### In auth.service.ts (register method):

**What it does correctly:**
```typescript
// Line 24-26: Validates ventanaId presence for non-ADMIN roles
if ((role === 'VENTANA' || role === 'VENDEDOR') && !data.ventanaId) {
  throw new AppError('ventanaId is required for VENTANA and VENDEDOR roles', 400);
}

// Line 29-34: Validates ventanaId exists in database
if (data.ventanaId) {
  const ventana = await prisma.ventana.findUnique({ where: { id: data.ventanaId } });
  if (!ventana) {
    throw new AppError('ventana not found', 404);
  }
}
```

**What it's MISSING:**
```typescript
// ❌ MISSING: Does NOT validate that ventana is ACTIVE
// ✅ user.service.ts DOES have this check:
await ensureVentanaActiveOrThrow(dto.ventanaId);  // Also checks parent Banca is active
```

#### Key Difference:
| Check | auth.service.ts | user.service.ts |
|-------|---|---|
| ventanaId existence | ✅ YES | ✅ YES |
| ventana.isActive | ❌ NO | ✅ YES |
| Parent banca.isActive | ❌ NO | ✅ YES |

---

### Issue 2: ⚠️ MISSING ventanaId VALIDATION IN AUTH VALIDATOR

**auth.validator.ts (registerSchema) - lines 6-18:**
```typescript
export const registerSchema = z.object({
  username: z.string().regex(usernameRegex, "..."),
  name: z.string().min(2, "...").max(100, "..."),
  password: z.string().min(6, "...").max(100, "..."),
  email: z.string().email("...").optional(),
  role: z.enum(["ADMIN", "VENTANA", "VENDEDOR"]).optional(),
  // ❌ MISSING: ventanaId validation
});
```

**Comparison with user.validator.ts (createUserSchema) - lines 27-58:**
```typescript
export const createUserSchema = z
  .object({
    // ... other fields ...
    ventanaId: z.uuid('ventanaId inválido').nullable().optional(),
  })
  .superRefine((val, ctx) => {
    const role = val.role ?? 'VENTANA'
    if (role !== 'ADMIN') {
      if (!val.ventanaId || typeof val.ventanaId !== 'string' || val.ventanaId.trim().length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['ventanaId'],
          message: 'Selecciona una ventana',
        })
      }
    }
  })
  .strict()
```

**Problem**: The auth validator doesn't validate `ventanaId` at all. This means invalid UUIDs can reach the service layer.

---

### Issue 3: ✅ CORRECT: User Update Endpoint (PATCH /api/v1/users/:id)

**In user.service.ts (lines 157-182):**

The update method correctly handles role changes and ventanaId reassignment:

```typescript
if (dto.role) {
  const newRole = dto.role as Role;
  toUpdate.role = newRole;

  if (newRole === Role.ADMIN) {
    // ✅ Force ventanaId to null when changing to ADMIN
    toUpdate.ventanaId = null;
  } else {
    // ✅ For VENTANA/VENDEDOR: use new ventanaId OR keep existing
    const effectiveVentanaId = dto.ventanaId ?? current.ventanaId;
    if (!effectiveVentanaId) throw new AppError('ventanaId is required for role ' + newRole, 400);
    await ensureVentanaActiveOrThrow(effectiveVentanaId);
    toUpdate.ventanaId = effectiveVentanaId;
  }
} else if (dto.ventanaId !== undefined) {
  // ✅ Also handles case where only ventanaId changes (without role change)
  if (current.role === Role.ADMIN) {
    toUpdate.ventanaId = null;
  } else {
    if (!dto.ventanaId) throw new AppError('ventanaId is required for role ' + current.role, 400);
    await ensureVentanaActiveOrThrow(dto.ventanaId);
    toUpdate.ventanaId = dto.ventanaId;
  }
}
```

**Status**: ✅ Correct implementation

---

## 4. Identified Gaps & Issues

### Gap 1: ❌ Missing ventanaId Validation in auth.validator.ts

**Problem**: The public registration endpoint doesn't validate `ventanaId` at the schema level.

**Current Flow**:
1. Frontend sends registration request with invalid ventanaId (e.g., empty string, non-UUID)
2. Validator doesn't catch it (ventanaId not in schema)
3. Service catches it at runtime
4. Returns error to client

**Improved Flow**:
1. Frontend sends registration request
2. ✅ Validator catches invalid ventanaId early
3. Service applies additional business logic
4. User created successfully

**Fix Needed**: Add `ventanaId` validation to `registerSchema`

---

### Gap 2: ❌ Missing Ventana Active Validation in auth.service.ts

**Problem**: Public registration only checks if ventana exists, but doesn't check if it's active (or if parent banca is active).

**Current Scenario**:
```
1. User registers with ventanaId pointing to an inactive ventana
2. auth.service.ts doesn't check ventana.isActive
3. User is created successfully with inactive ventana association
4. When user tries to create payments → RBAC validation fails mysteriously
5. Root cause: ventana was inactive but registration didn't prevent it
```

**Fix Needed**: Add `ensureVentanaActiveOrThrow()` call to `auth.service.ts`

---

### Gap 3: ⚠️ Inconsistency: public register allows role selection

**Problem**: Public registration endpoint allows clients to specify ANY role.

**Current Code (auth.service.ts, line 21):**
```typescript
const role = data.role ?? 'VENTANA';
```

**Risk**:
- Frontend could send `role: 'ADMIN'` during public registration
- System would create an ADMIN user without authorization
- This bypasses normal admin-only user creation flow

**Mitigated By**: `ensureVentanaActiveOrThrow()` check (which only happens for non-ADMIN roles)
- If role = ADMIN, ventanaId check is skipped
- User created as ADMIN without ventana association
- **This is a security risk**

**Fix Needed**: Force `role = 'VENTANA'` for public registration (don't allow clients to specify role)

---

### Gap 4: ✅ CORRECT: DTO Interfaces Are Consistent

**auth.dto.ts (RegisterDTO):**
```typescript
export interface RegisterDTO {
    name: string,
    email: string,
    username: string,
    password: string,
    role?: 'ADMIN' | 'VENTANA' | 'VENDEDOR',
    ventanaId?: string,  // UUID de ventana (requerido para VENTANA y VENDEDOR)
}
```

**user.dto.ts (CreateUserDTO):**
```typescript
export interface CreateUserDTO {
  name: string;
  email?: string | null;
  phone?: string | null;
  username: string;
  password: string;
  role?: Role;
  ventanaId?: string | null;  // requerido si role != ADMIN
  code?: string | null;
  isActive?: boolean;
}
```

✅ Both include `ventanaId` field - Correct

---

## 5. User Role & Window Assignment Scenarios

### Scenario 1: Create VENTANA User ✅

**Flow**:
1. Admin calls `POST /api/v1/users`
2. Sends: `{ role: 'VENTANA', ventanaId: 'uuid-of-window-1' }`
3. Service validates:
   - ✅ role = VENTANA
   - ✅ ventanaId provided
   - ✅ ventana exists
   - ✅ ventana.isActive = true
   - ✅ parent banca.isActive = true
4. User created with `ventanaId = 'uuid-of-window-1'`
5. `/auth/me` returns `ventanaId: 'uuid-of-window-1'`

**Status**: ✅ Works correctly

---

### Scenario 2: Create VENDEDOR User ✅

**Flow**:
1. VENTANA user calls `POST /api/v1/users` (filtered to create only VENDEDOR)
2. Sends: `{ role: 'VENDEDOR', ventanaId: 'uuid-of-their-window' }`
3. Service validates:
   - ✅ role = VENDEDOR
   - ✅ ventanaId provided
   - ✅ ventana exists and is active
4. User created with `ventanaId = 'uuid-of-their-window'`
5. VENDEDOR can only sell through that window

**Status**: ✅ Works correctly

---

### Scenario 3: Create ADMIN User via Secure Endpoint ✅

**Flow**:
1. Admin calls `POST /api/v1/users`
2. Sends: `{ role: 'ADMIN' }`
3. Service validates:
   - ✅ role = ADMIN
   - ✅ No ventanaId required
   - ✅ ventanaId forced to null
4. User created with `ventanaId = null`

**Status**: ✅ Works correctly

---

### Scenario 4: Public Registration (Security Risk) ⚠️

**Current Flow**:
1. Public user calls `POST /api/v1/auth/register`
2. Sends: `{ role: 'ADMIN', name: '...', username: '...', password: '...', email: '...' }`
3. Service validates:
   - ✅ role = ADMIN (allowed!)
   - ✅ No ventanaId required for ADMIN
   - ❌ No authorization check (it's a public endpoint)
4. ADMIN user created without any authorization

**Problem**: Anyone can create ADMIN users via public registration

**Status**: ⚠️ **SECURITY RISK - Needs Fix**

---

### Scenario 5: Change Role from VENTANA → ADMIN ✅

**Flow**:
1. Admin calls `PATCH /api/v1/users/:id`
2. Sends: `{ role: 'ADMIN' }`
3. Service validates:
   - ✅ role changing to ADMIN
   - ✅ ventanaId forced to null
4. User updated: `ventanaId = null`, `role = 'ADMIN'`

**Status**: ✅ Works correctly

---

### Scenario 6: Change ventanaId (without role change) ✅

**Flow**:
1. Admin calls `PATCH /api/v1/users/:id`
2. Sends: `{ ventanaId: 'uuid-of-new-window' }`
3. Service validates:
   - ✅ Current role is VENTANA or VENDEDOR
   - ✅ New ventanaId provided and active
4. User updated to new window

**Status**: ✅ Works correctly

---

## 6. Issues Summary Table

| # | Issue | Severity | Location | Status |
|---|-------|----------|----------|--------|
| 1 | Missing ventanaId validation in auth.validator.ts | 🟡 Medium | registerSchema | ⚠️ Needs Fix |
| 2 | Missing ventana active check in auth.service.ts | 🟡 Medium | register() | ⚠️ Needs Fix |
| 3 | Public register allows any role (including ADMIN) | 🔴 High | auth.service.ts | ⚠️ Security Risk |
| 4 | Inconsistency between auth & user validators | 🟡 Medium | auth/user validators | ⚠️ Needs Fix |
| 5 | No phone field in auth.dto.ts | 🟢 Low | auth.dto.ts | ℹ️ Info Only |

---

## 7. Recommended Fixes

### Fix 1: Add ventanaId Validation to auth.validator.ts

**File**: `src/api/v1/validators/auth.validator.ts`

**Change**:
```typescript
export const registerSchema = z
  .object({
    username: z.string().regex(usernameRegex, "Invalid username format (e.g. adm.sys.root)"),
    name: z.string().min(2, "Name is too short").max(100, "Name is too long"),
    password: z.string().min(6, "Password must be at least 6 characters long").max(100, "Password must be at most 100 characters long"),
    email: z.string().email("Invalid email address").optional(),
    role: z.enum(["VENTANA", "VENDEDOR"]).optional(),  // ← Remove ADMIN from public registration
    ventanaId: z.uuid('ventanaId inválido').nullable().optional(),  // ← Add this field
  })
  .superRefine((val, ctx) => {
    const role = val.role ?? 'VENTANA';
    // Public registration only allows VENTANA/VENDEDOR, so ventanaId is always required
    if (!val.ventanaId || typeof val.ventanaId !== 'string' || val.ventanaId.trim().length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['ventanaId'],
        message: 'Selecciona una ventana',
      });
    }
  })
  .strict();
```

---

### Fix 2: Add ensureVentanaActiveOrThrow to auth.service.ts

**File**: `src/api/v1/services/auth.service.ts`

**Changes**:

1. Import the validation function at the top:
```typescript
import { ensureVentanaActiveOrThrow } from './user.service';  // Import from user.service
```

OR create a shared utility:
```typescript
// In src/api/v1/utils/ventanaValidator.ts
export async function ensureVentanaActiveOrThrow(ventanaId: string) {
  const v = await prisma.ventana.findUnique({
    where: { id: ventanaId },
    select: { id: true, isActive: true, banca: { select: { id: true, isActive: true } } },
  });
  if (!v || !v.isActive) throw new AppError('Ventana not found or inactive', 404);
  if (!v.banca || !v.banca.isActive) throw new AppError('Parent Banca inactive', 409);
}
```

2. Update auth.service.ts register() method:
```typescript
// Validar que ventanaId existe Y está activo
if (data.ventanaId) {
  const ventana = await prisma.ventana.findUnique({ where: { id: data.ventanaId } });
  if (!ventana) {
    throw new AppError('ventana not found', 404);
  }
  // ← ADD THIS CHECK:
  if (!ventana.isActive) {
    throw new AppError('Ventana is inactive', 409);
  }
  // Also check parent banca
  if (ventana.banca && !ventana.banca.isActive) {
    throw new AppError('Parent Banca is inactive', 409);
  }
}
```

OR simply call the shared function:
```typescript
if (data.ventanaId) {
  await ensureVentanaActiveOrThrow(data.ventanaId);
}
```

---

### Fix 3: Restrict Public Registration to VENTANA/VENDEDOR Only

**File**: `src/api/v1/services/auth.service.ts`

**Change**:
```typescript
async register(data: RegisterDTO) {
  // ... existing checks ...

  const hashed = await hashPassword(data.password);
  const role = data.role ?? 'VENTANA';  // Default to VENTANA

  // ← ADD THIS: Prevent public registration from creating ADMIN users
  if (role === 'ADMIN') {
    throw new AppError('ADMIN users must be created by system administrator', 403);
  }

  // ... rest of validation ...
}
```

Also update the validator to reflect this:
```typescript
// In auth.validator.ts
role: z.enum(["VENTANA", "VENDEDOR"]).optional(),  // Remove ADMIN
```

---

## 8. Testing Checklist

After implementing fixes, test these scenarios:

- [ ] Create VENTANA user via admin endpoint → ventanaId assigned ✅
- [ ] Create VENDEDOR user via admin endpoint → ventanaId assigned ✅
- [ ] Create ADMIN user via admin endpoint → ventanaId = null ✅
- [ ] Public register with VENTANA role + valid ventanaId → Success ✅
- [ ] Public register with invalid ventanaId → 400 error ✅
- [ ] Public register with inactive ventana → 409 error ✅
- [ ] Public register with inactive parent banca → 409 error ✅
- [ ] Public register trying to create ADMIN → 403 error ✅
- [ ] Update user: VENTANA → ADMIN → ventanaId becomes null ✅
- [ ] Update user: Change ventanaId only → Validates new ventana is active ✅
- [ ] VENTANA user calls /auth/me → returns correct ventanaId ✅
- [ ] VENDEDOR user calls /auth/me → returns correct ventanaId ✅
- [ ] ADMIN user calls /auth/me → returns ventanaId = null ✅

---

## 9. Files to Modify

| File | Changes | Priority |
|------|---------|----------|
| `src/api/v1/validators/auth.validator.ts` | Add ventanaId field, restrict role to VENTANA/VENDEDOR | High |
| `src/api/v1/services/auth.service.ts` | Add ventana active check, prevent ADMIN creation | High |
| `src/api/v1/utils/ventanaValidator.ts` | Create shared validation function (optional) | Medium |

---

## 10. Summary

### ✅ What's Working Correctly
- User creation via admin endpoint with proper ventanaId assignment
- User update with role changes and ventanaId reassignment
- Enforcement of ventanaId for VENTANA/VENDEDOR roles
- Forcing ventanaId = null for ADMIN users
- Database constraints and relationships

### ⚠️ What Needs Fixing
1. **auth.validator.ts** missing ventanaId validation
2. **auth.service.ts** missing ventana active check
3. **auth.service.ts** allows ADMIN creation via public registration (security risk)
4. Inconsistency between auth and user validators

### 🎯 Impact
Implementing these fixes will ensure:
- ✅ Consistent validation across both registration endpoints
- ✅ Users cannot be created with inactive ventanas
- ✅ Public registration cannot create privileged users
- ✅ Better error messages and early validation
- ✅ Aligned behavior between public and admin registration

---

**Document Version**: 1.0
**Last Updated**: 2025-10-28
**Status**: ⚠️ Gaps Identified - Ready for Implementation
