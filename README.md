# 🏦 Banca Management Backend

> **Proyecto backend modular y escalable** para la gestión integral de bancas de lotería.  
> Desarrollado con **TypeScript, Express y Prisma ORM**, bajo arquitectura modular, con trazabilidad completa mediante `ActivityLog`.

---

## 🚀 Tecnologías Base

| Componente | Tecnología |
|-------------|-------------|
| **Runtime** | Node.js (TypeScript strict) |
| **Framework HTTP** | Express.js |
| **ORM** | Prisma Client (PostgreSQL) |
| **Autenticación** | JWT clásico (Access + Refresh) |
| **Validación** | Zod |
| **Logger** | Winston + middleware `attachLogger` |
| **Configuración** | dotenv-safe |
| **Rate Limiting** | express-rate-limit |
| **Auditoría** | Modelo `ActivityLog` integrado |

---

## 🧩 Estructura del Proyecto

```bash

src/
├── api/
│   └── v1/
│       ├── controllers/
│       ├── dto/
│       ├── routes/
│       ├── services/
│       └── validators/
├── core/
├── config/
├── middlewares/
├── repositories/
├── server/
├── utils/
└── workers/
```

Cada capa tiene una responsabilidad clara:

| Capa | Responsabilidad |
|------|------------------|
| **Controller** | Orquesta la petición HTTP |
| **Service** | Contiene la lógica de negocio |
| **Repository** | Abstrae operaciones de datos con Prisma |
| **Middleware** | Seguridad, validación, logging |
| **Core** | Componentes críticos (logger, errores, Prisma, auditoría) |

---

## 🔐 Autenticación

- **JWT Access Token** (válido pocos minutos)
- **Refresh Token** persistente (revocable, registrado en DB)
- Middleware `protect` para rutas seguras
- Modelo `RefreshToken` con expiración y estado `revoked`

Rutas:

```bash
POST /api/v1/auth/register
POST /api/v1/auth/login
POST /api/v1/auth/refresh
POST /api/v1/auth/logout
GET  /api/v1/auth/me
```

---

## 👥 Usuarios

CRUD completo con soft-delete y roles basados en el enum `Role` (`ADMIN`, `VENTANA`, `VENDEDOR`).

Registro de actividad automática en `ActivityLog`:

- `USER_CREATE`
- `USER_UPDATE`
- `USER_DELETE`
- `USER_ROLE_CHANGE`
- `USER_RESTORE`

---

## 🎫 Tiquetes

Generación y gestión de tiquetes de venta.

- **Generador secuencial** con `TicketCounter`
- Cada tiquete contiene múltiples jugadas (`jugadas`)
- Soporte de cancelación con trazabilidad
- Log de actividad (`TICKET_CREATE`, `TICKET_CANCEL`)

---

## 🎲 Loterías

Administración de las loterías disponibles:

- CRUD completo (`LOTERIA_CREATE`, `LOTERIA_UPDATE`, etc.)
- Campo `rulesJson` con reglas configurables por banca
- Soft-delete y restauración

---

## 📊 Paginación Dinámica

Utilidad genérica en `src/utils/pagination.ts` con dos modos:

1. **Offset Pagination** (paginación tradicional)
2. **Cursor Pagination** (infinite scroll)

Incluye:

- Sanitización de `page` y `pageSize`
- Límite duro `maxPageSize`
- Metadatos estándar:

  ```json
  {
    "total": 120,
    "page": 2,
    "pageSize": 10,
    "totalPages": 12,
    "hasNextPage": true,
    "hasPrevPage": true
  }
  ```

Ejemplo de uso:

```ts
const { data, meta } = await paginateOffset(prisma.ticket, {
  where: { isDeleted: false },
  pagination: { page: 2, pageSize: 20 },
});
```

---

## 🧾 Auditoría Centralizada

Modelo `ActivityLog` registra automáticamente cada acción relevante del sistema.

```ts
await ActivityService.log({
  userId,
  action: ActivityType.USER_UPDATE,
  targetType: 'USER',
  targetId: user.id,
  details: { updatedFields: ['email'] },
});
```

---

## ⚙️ Configuración de entorno (.env)

Archivo `.env` basado en `.env.example`  
> ⚠️ **Nunca subir `.env` real al repositorio.**

Variables principales:

```bash
DATABASE_URL=postgresql://user:pass@localhost:5432/bancas
PORT=4000
JWT_ACCESS_SECRET=your-access-secret
JWT_REFRESH_SECRET=your-refresh-secret
JWT_ACCESS_EXPIRES=15m
JWT_REFRESH_EXPIRES=7d
RATE_LIMIT_WINDOW=60000
RATE_LIMIT_MAX=100
```

---

## 🧠 Scripts principales

```bash
# Iniciar en desarrollo
npm run dev

# Migrar base de datos
npx prisma migrate dev

# Generar cliente Prisma
npx prisma generate

# Ejecutar seed
npx ts-node prisma/seed.ts
```

---

## 🧰 Convenciones de commit

Usamos [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/)

Ejemplos:

```bash
feat(api): add user role management with activity log
fix(core): correct JWT refresh token validation
docs: update README with authentication section
```

---

## 🧱 Fases de desarrollo

| Fase | Descripción | Estado |
|------|--------------|--------|
| **1. Usuarios + Auth + Logs** | Implementado con validaciones y roles | ✅ |
| **2. Tickets + Loterías + Auditoría total** | Listado, creación y cancelación de tiquetes | ✅ |
| **3. Multipliers + Restricciones + Configuración** | Config. avanzada por banca | 🔜 |
| **4. Integración con banca y ventana** | Lógica multi-sucursal | 🔜 |
| **5. Refactor + Testing + Docs finales** | Documentación y pruebas | ⏳ |

---

## 👨‍💻 Autor

**Mario Quirós P.**  
Desarrollador Backend (Trainee)  
Repositorio: [github.com/MQuirosP](https://github.com/MQuirosP)

---

## 🧭 Licencia

Este proyecto está bajo la licencia **MIT**.  
Consulta el archivo `LICENSE` para más detalles.
