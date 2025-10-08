# 🏦 Banca Management Backend

> **Proyecto backend modular y escalable** para la gestión integral de bancas de lotería.  
> Desarrollado con **TypeScript, Express y Prisma ORM**, bajo arquitectura por capas, validaciones estrictas (`Zod`) y trazabilidad total mediante `ActivityLog`.

---

## 🚀 Tecnologías Base

| Componente | Tecnología |
|-------------|-------------|
| **Runtime** | Node.js (TypeScript strict) |
| **Framework HTTP** | Express.js |
| **ORM** | Prisma Client (PostgreSQL) |
| **Autenticación** | JWT (Access + Refresh) |
| **Validación** | Zod |
| **Logger** | Pino (`src/core/logger.ts`) + middleware `attachLogger` |
| **Configuración** | dotenv-safe |
| **Rate Limiting** | express-rate-limit |
| **Auditoría** | Modelo `ActivityLog` con contexto (`layer`, `action`, `userId`, `requestId`) |

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
├── config/
├── core/
├── middlewares/
├── repositories/
├── utils/
└── tests/
```

### Responsabilidades por capa

| Capa | Rol |
|------|-----|
| **Controllers** | Gestionan la petición HTTP y respuesta |
| **Services** | Contienen la lógica de negocio y validaciones de dominio |
| **Repositories** | Acceso a datos con Prisma (sin lógica de dominio) |
| **Middlewares** | Seguridad, validación, logging y control de acceso |
| **Core** | Módulos críticos: logger, errores, Prisma, auditoría |
| **Utils** | Herramientas genéricas (paginación, transacciones, etc.) |

---

## 🔐 Autenticación y Roles

- **Tokens JWT**:
  - `Access Token` de corta duración.
  - `Refresh Token` persistente y revocable.
- **Flag de desarrollo**: `DISABLE_AUTH=true` permite simular un ADMIN.
- Middleware `protect` para proteger rutas privadas.

### Roles jerárquicos

| Rol | Descripción |
|------|-------------|
| **ADMIN** | Control total del sistema. |
| **VENTANA** | Administra vendedores y controla sus límites. |
| **VENDEDOR** | Ejecuta ventas y consulta sorteos activos. |

---

## 🏢 Bancas y 🪟 Ventanas

- **Banca:** define límites globales (`defaultMinBet`, `globalMaxPerNumber`).
- **Ventana:** comisiones (`commissionMarginX`), soft-delete, trazabilidad.
- Jerarquía: `Banca > Ventana > Vendedor`.
- Toda acción auditable mediante `ActivityLog`.

---

## 🎲 Loterías y 🧭 Sorteos

- `Loteria` (configuración general, multiplicadores, reglas).
- `Sorteo` con ciclo controlado:

| Estado | Descripción |
|---------|--------------|
| `SCHEDULED` | Aún no disponible para venta. |
| `OPEN` | Permite venta de tickets. |
| `CLOSED` | Cierre de venta, en espera de resultado. |
| `EVALUATED` | Resultado asignado, tickets evaluados. |

- Evaluación automática: `payout = jugada.amount × finalMultiplierX`.

### Rutas Sorteos

```http
POST   /api/v1/sorteos
PATCH  /api/v1/sorteos/:id/open
PATCH  /api/v1/sorteos/:id/close
PATCH  /api/v1/sorteos/:id/evaluate
GET    /api/v1/sorteos
```

---

## 🎫 Tickets

- Secuencia segura `ticket_number_seq` o `TicketCounter` atómico.
- Creación protegida por `prisma.$transaction` con retry automático.
- Restricciones jerárquicas (`RestrictionRule`) aplicadas dentro de la transacción.
- Cancelación con soft-delete y registro en `ActivityLog`.

### Validaciones automáticas

- Lotería, sorteo, ventana y usuario deben existir.
- Sorteo debe estar en estado `OPEN`.
- Cumplimiento de `maxAmount`, `maxTotal` y `defaultMinBet`.

### Ejemplo de flujo transaccional

1. Se obtiene número secuencial (`SELECT nextval('ticket_number_seq')`).
2. Se verifica límite diario del vendedor.
3. Se aplican reglas de restricción (`User → Ventana → Banca`).
4. Se crea el ticket y sus jugadas.
5. Se registra auditoría asincrónica (`TICKET_CREATE`).

---

## 🔢 Multipliers y RestrictionRules

### **LoteriaMultiplier**

- Define multiplicadores base (`valueX`) por lotería o sorteo.

### **UserMultiplierOverride**

- Multiplicadores personalizados por usuario y lotería.
- Roles permitidos: `ADMIN` y `VENTANA`.
- Control de validez temporal (`activeFrom`, `activeUntil`).

### **RestrictionRule**

- Limita montos por número o ticket.
- Jerarquía de prioridad:
  `User (100) > Ventana (10) > Banca (1)`.
- Compatible con horarios (`appliesToHour`) y fechas (`appliesToDate`).

---

## ⚙️ Concurrencia y Transacciones Seguras

- Wrapper `withTransactionRetry`:
  - Maneja *deadlocks* (`P2034`).
  - Reintenta con backoff exponencial.
  - Logging estructurado por intento.
- Evita overselling en ventas simultáneas.
- Tests concurrentes con `Promise.allSettled` (20 intentos simultáneos).

---

## 💳 Ticket Payments *(en progreso)*

- Módulo para registrar pagos de tickets ganadores.
- Validación de estado (`EVALUATED` y no pagado).
- Registro de auditoría (`PAYMENT_CREATE`, `PAYMENT_REVERSE`).
- Implementación pendiente de fase 2.

---

## 🧪 Pruebas Unitarias

| Suite | Objetivo | Estado |
|--------|-----------|--------|
| `tickets/concurrency.test.ts` | Prevención de overselling | ✅ Passed |
| `tickets/restrictionRules.test.ts` | Validación jerárquica de límites | ✅ Passed |
| `auth` y `users` | CRUD + roles | ✅ Passed |
| `payments` | Integración (fase 2) | ⏳ Pendiente |

---

## 🧾 Auditoría Centralizada

Modelo `ActivityLog`:

```ts
await prisma.activityLog.create({
  data: {
    userId,
    action: 'TICKET_CREATE',
    targetType: 'TICKET',
    targetId: ticket.id,
    details: { totalAmount: ticket.totalAmount },
  },
});
```

---

## 🧱 Fases del Proyecto

| Fase | Descripción | Estado |
|------|--------------|--------|
| **1. Usuarios + Auth + Logs** | Roles, validación, auditoría | ✅ |
| **2. Tickets + Loterías** | Ciclo completo de venta | ✅ |
| **3. Sorteos** | Ciclo completo y evaluación | ✅ |
| **4. Restricciones + Multipliers** | Reglas jerárquicas | ✅ |
| **5. Pagos y reportes** | Pago de ganadores, informes | 🚧 |
| **6. CI/CD + Docs** | Docker + Swagger + Tests finales | 🔜 |

---

## ⚙️ Scripts útiles

```bash
npm run dev              # Desarrollo
npm run build            # Compilación TypeScript
npm run test             # Ejecución de tests Jest
npm run prisma:generate  # Genera cliente Prisma
npm run prisma:deploy    # Ejecuta migraciones
```

---

## 📦 Variables de entorno (.env)

```bash
PORT=4000
NODE_ENV=development
DATABASE_URL=postgresql://user:pass@localhost:5432/bancas
JWT_ACCESS_SECRET=your-access-secret
JWT_REFRESH_SECRET=your-refresh-secret
JWT_ACCESS_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=7d
DISABLE_AUTH=false
LOG_LEVEL=info
```

---

## 👨‍💻 Autor

**Mario Quirós P.**  
Desarrollador Backend (Trainee)  
📧 [mquirosp78@gmail.com](mailto:mquirosp78@gmail.com)  
🌐 [github.com/MQuirosP](https://github.com/MQuirosP)

---

## 🧭 Licencia

Este proyecto está bajo la licencia **MIT**.  
Consulta el archivo `LICENSE` para más detalles.

---

> 💡 *Versión actual:* `v1.0.0-rc4`  
> *Próximo hito:* integración de pagos, reportes y despliegue CI/CD con Docker + GitHub Actions.
