---
description: Repository Information Overview
alwaysApply: true
---

# Lottery Banking Backend - Repository Information

## Summary

**Banca Management Backend** — A modular, scalable Node.js/TypeScript backend for comprehensive lottery banking platform management. Implements layered architecture with strict validation (Zod), complete audit trails (ActivityLog), role-based access control, ticket management, commission systems, and automated jobs. Built with Express.js, Prisma ORM, PostgreSQL, and JWT authentication.

## Structure

```
src/
├── api/v1/                    # API routes, controllers, DTOs, services, validators
├── config/                    # Configuration and environment schema
├── core/                      # Critical modules: logger, Prisma, Redis, errors, auditing
├── jobs/                      # Automated background jobs (sorteos, settlements, closing)
├── middlewares/               # Security, validation, logging, authentication
├── repositories/              # Data access layer with Prisma
├── services/                  # Business logic and domain validations
├── utils/                     # Utilities (pagination, dates, commission, caching, RBAC)
├── tools/                     # Maintenance and utility tools
├── types/                     # TypeScript type definitions
├── assets/                    # Fonts and static resources
├── workers/                   # Background workers/queue support
└── index.ts                   # Entry point (imports server)

prisma/                        # Database schema, migrations, seeds
tests/                         # Test suites, helpers, setup
docker-compose.yml             # Dev and test PostgreSQL containers
```

## Language & Runtime

**Language**: TypeScript (strict mode)  
**Runtime**: Node.js `20.x` (defined in `.nvmrc`)  
**Build System**: TypeScript Compiler (`tsc`)  
**Package Manager**: npm  
**Target**: ES2020  
**Entry Point**: `src/index.ts` → `src/server/server.ts` → Express HTTP server on port 3000

## Dependencies

**Main Dependencies**:
- **Express.js** (`^4.21.2`) — HTTP framework
- **Prisma Client** (`^6.18.0`) — PostgreSQL ORM
- **PostgreSQL** (`pg ^8.16.3`) — Database driver
- **JWT** (`jsonwebtoken ^9.0.2`) — Authentication
- **Zod** (`^4.1.11`) — Validation
- **Pino** (`^10.0.0`) — Structured logging
- **Redis** (`ioredis ^5.8.2`) — Caching (optional)
- **bcryptjs** (`^2.4.3`) — Password hashing
- **Helmet** (`^8.1.0`) — Security headers
- **CORS** (`^2.8.5`) — Cross-origin support
- **date-fns** (`^4.1.0`) — Date utilities
- **Morgan** (`^1.10.1`) — HTTP request logging
- **Sentry** (`@sentry/node ^10.17.0`) — Error monitoring
- **ExcelJS** (`^4.4.0`) — Excel export
- **PDFKit** (`^0.17.2`) — PDF generation
- **Canvas** (`^3.2.0`) — Image rendering
- **UUID** (`^13.0.0`) — ID generation

**Development Dependencies**:
- **Jest** (`^30.2.0`) — Testing framework
- **ts-jest** (`^29.4.4`) — TypeScript support for Jest
- **Supertest** (`^7.1.4`) — HTTP testing
- **TypeScript** (`^5.9.3`)
- **ESLint** + **Prettier** — Code quality
- **Nodemon** (`^3.1.0`) — Development server
- **ts-node** (`^10.9.2`) — TypeScript execution
- **Husky** + **lint-staged** — Git hooks
- **dotenv-cli** (`^11.0.0`) — Environment variable management

## Build & Installation

**Install dependencies**:
```bash
npm install
```

**Build TypeScript**:
```bash
npm run build
```

**Type checking** (no emit):
```bash
npm run typecheck
```

**Development server** (with auto-reload via Nodemon):
```bash
npm run dev
```

**Production start**:
```bash
npm start
```

**Prisma setup**:
```bash
npm run prisma:generate              # Generate Prisma Client
npm run prisma:format                # Format schema
npm run migrate:dev                  # Run migrations (dev)
npm run migrate:deploy               # Deploy migrations (production)
npm run prisma:seed                  # Seed database
npm run studio                       # Open Prisma Studio UI
```

## Docker

**Docker Compose**: `docker-compose.yml`

**Services**:
1. **postgres-dev** (Image: `postgres:15`)
   - Container: `bancas_dev_db`
   - Port: `5432:5432`
   - Database: `bancas_dev`
   - Credentials: `postgres / dev_password_123`
   - Volume: `postgres_dev_data:/var/lib/postgresql/data`

2. **postgres-test** (Image: `postgres:15`)
   - Container: `bancas_test_db`
   - Port: `5433:5432`
   - Database: `bancas_test`
   - Credentials: `postgres / test_password_123`
   - Volume: `postgres_test_data:/var/lib/postgresql/data`

**Run Docker Compose**:
```bash
docker-compose up -d
```

## Configuration

**Environment Files**:
- `.env.local` — Development environment variables
- `.env.test` — Test environment variables
- `.env.example` — Example configuration template

**Key Environment Variables**:
```
NODE_ENV=development|test|production
PORT=3000
DATABASE_URL=postgresql://...  # Primary connection
DIRECT_URL=postgresql://...    # Direct connection (Supabase)
JWT_ACCESS_SECRET=...
JWT_REFRESH_SECRET=...
DISABLE_AUTH=false             # Dev flag to simulate ADMIN
REDIS_URL=...                  # Optional cache
SUPABASE_KEY=...
SALES_DAILY_MAX=100000
MULTIPLIER_BASE_DEFAULT_X=90
LOG_LEVEL=info
```

## Testing

**Framework**: Jest (`^30.2.0`)  
**TypeScript Support**: ts-jest (`^29.4.4`)  
**HTTP Testing**: Supertest (`^7.1.4`)

**Test Location**: `tests/` directory  
**Setup File**: `tests/setup.ts` (enforces test environment safety — no production DB)  
**Test Files**: `*.test.ts` and `*.spec.ts` pattern

**Configuration**: Inline in `package.json` (no `jest.config.js` file)

**Run Tests**:
```bash
npm test                   # Run all tests (serial, detect open handles)
npm run test:watch        # Watch mode
npm run test:coverage     # Coverage report
```

**Test Commands**: 
- Configured to use `.env.test` environment
- Runs with `--runInBand` flag (serial execution)
- Includes `--detectOpenHandles` for debugging
- Safety checks: Must use local database (localhost), not production

## Prisma & Database

**Schema**: `prisma/schema.prisma`  
**Database Provider**: PostgreSQL  
**ORM**: Prisma Client (`^6.18.0`)

**Key Models**:
- **Banca** — Banking entity with sales limits and commission policies
- **Ventana** — Window/branch under a Banca with commission margins
- **User** — Users (ADMIN, VENTANA, VENDEDOR roles)
- **Loteria** — Lottery configuration with rules and multipliers
- **Sorteo** — Drawing/draw (SCHEDULED → OPEN → CLOSED → EVALUATED)
- **Ticket** — Lottery tickets with plays/jugadas
- **ActivityLog** — Complete audit trail of all actions
- **RestrictionRule** — Sales restrictions (per User, Ventana, Banca)
- **LoteriaMultiplier** — Multiplier configurations per lottery
- **CommissionPolicy** — Hierarchical commission rules (JSON-based)
- **AccountStatement** & **AccountPayment** — Financial tracking

**Migrations**: `prisma/migrations/`  
**Seed Script**: `prisma/seed.ts`

## API Architecture

**API Version**: v1 (prefix: `/api/v1/`)  
**Authentication**: JWT (Access + Refresh tokens)  
**Authorization**: Role-based (ADMIN, VENTANA, VENDEDOR)  
**Validation**: Zod schemas  
**Error Handling**: Centralized middleware with custom error types

**Main Routes**:
- `/api/v1/loterias` — Lottery management
- `/api/v1/sorteos` — Drawing management
- `/api/v1/tickets` — Ticket sales and management
- `/api/v1/bancas` — Banking entities
- `/api/v1/ventanas` — Windows/branches
- `/api/v1/users` — User management
- `/api/v1/ventas` — Sales analytics
- `/api/v1/admin/dashboard` — Admin dashboard and KPIs

## Background Jobs

Automated jobs managed in `src/jobs/`:

1. **sorteosAuto.job.ts** — Auto-create drawings based on lottery schedules
2. **accountStatementSettlement.job.ts** — Automatic settlement of account statements
3. **monthlyClosing.job.ts** — Monthly closing and balance reconciliation
4. **activityLogCleanup.job.ts** — Cleanup old activity logs

**Job Management**: Start/stop on server startup/shutdown (graceful shutdown implemented)

## Key Features

-  **Layered Architecture** — Controllers → Services → Repositories → Prisma
-  **Audit Trails** — Complete ActivityLog for all actions
-  **Role-Based Access Control** — ADMIN, VENTANA, VENDEDOR with fine-grained permissions
-  **Transaction Management** — Retry logic for deadlocks/timeouts
-  **Commission System** — Hierarchical JSON-based policies with snapshots
-  **Validation** — Zod schemas throughout API
-  **Structured Logging** — Pino with context (layer, action, requestId, userId)
-  **Rate Limiting** — express-rate-limit middleware
-  **Security** — Helmet, CORS, bcrypt passwords, JWT tokens
-  **Caching** — Redis support (optional) for restrictions, commissions, sorteos
-  **Timezone Handling** — Costa Rica (UTC-6) timezone conversion utilities
-  **Error Monitoring** — Sentry integration
-  **Graceful Shutdown** — Proper cleanup of connections and jobs on SIGTERM/SIGINT

## Scripts Summary

Key npm scripts:
- **Dev**: `npm run dev` (nodemon with TypeScript)
- **Build**: `npm run build` (compile TypeScript)
- **Test**: `npm test` (Jest with .env.test)
- **Migrations**: `npm run migrate:dev|deploy|status`
- **Database**: `npm run studio` (Prisma UI), `npm run db:push|pull`
- **Maintenance**: `npm run maintenance` (utility tools)
- **Backfill/Migration Scripts**: Various data migration utilities
