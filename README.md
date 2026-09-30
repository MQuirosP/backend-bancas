# 🏦 Banca Management Backend (Multi-Tenant Edition)

🌎 **English | [Español](README.es.md)**

---

> **High-performance transactional and analytical core engine for managing lotteries, branches (windows), and sales terminals.**

This repository contains the core backend of the lottery management system. Architected with strict **Multi-Tenant logical isolation**, it allows hosting multiple organizations (Bancas) securely sharing a single logical database cluster. It is optimized to process concurrent ticket sales with minimal query latencies and high availability.

---

## 📌 Table of Contents

1. [🚀 Key Features](#-key-features)
2. [🛠️ Technology Stack](#%EF%B8%8F-technology-stack)
3. [🏗️ Architecture & Code Layout](#%EF%B8%8F-architecture--code-layout)
4. [🔒 Security and Access Control (RBAC)](#-security-and-access-control-rbac)
5. [📈 Database & Cache Optimizations](#-database--cache-optimizations)
6. [⏰ Timezone & Drawing Logic (GMT-6)](#-timezone--drawing-logic-gmt-6)
7. [💻 Installation & Local Deployment](#-installation--local-deployment)
8. [📄 License & Authors](#-license--authors)

---

## 🚀 Key Features

*   **🏢 Isolated Multi-Tenancy:** Data privacy and relation integrity are guaranteed at the application level via `AsyncLocalStorage` context propagation, automatic Prisma Client query filter rewriting by `bancaId`, and tenant-isolated WebSocket rooms.
*   **⚡ Dual Dedicated Connection Pools:** Segregated database connection pools (`salesPool` with high priority and fast timeouts vs. `generalPool` for reports and dashboards), guaranteeing that ticket issuance never suffers connection starvation during heavy analytical workloads.
*   **🛡️ Core Resilience & JWT Circuit Breaker:** Centralized `ResilienceService` protecting database pools against bursts, coupled with a cryptographic JWT fallback circuit breaker that guarantees terminal uptime even during extreme database or Redis latency (>1,500 ms).
*   **🏎️ Hybrid Multi-Tier Cache with SingleFlight:** Mitigates the "Thundering Herd" effect combining local memory (L1) and Redis (L2) with `SingleFlight` in-flight request coalescing, write-through session pre-warming on login/refresh, and short-TTL (15s) caching for high-rotation live analytics.
*   **🔄 Realtime WebSocket Event-Driven Sync:** Instant push notifications (`SORTEOS_UPDATED`, `DASHBOARD_UPDATED`) to clients when draw states change or evaluations complete, eliminating aggressive polling and keeping frontend widgets synchronized.
*   **🌐 Reverse Proxy & TCP Hardening:** Optimized Node.js HTTP server sockets (`keepAliveTimeout = 65s`, `headersTimeout = 66s`, `backlog = 511`) eliminating 502/503 race conditions and absorbing concurrent bursts behind Render Load Balancer.
*   **📊 Optimized Risk & Financial Rollups:** Realtime exposure risk calculated via consolidated single-pass SQL queries (reducing latency from ~600 ms to ~60 ms) and daily settlements aggregated directly via raw SQL without materialized view overhead.
*   **🛠️ Operations CLI Wizard:** Built-in interactive CLI terminal (`npm run ops`) for operations such as out-of-grace ticket cancellation with audit logs, forced statement synchronization, and real-time draw evaluation monitoring.
*   **💵 Hierarchical Commissions:** Cascade commission resolution evaluated dynamically: Seller ➔ Window ➔ Banca, persisting immutable commission snapshots per play.

---

## 🛠️ Technology Stack

| Component | Technology | Purpose |
| :--- | :--- | :--- |
| **Runtime** | Node.js (v20.x) + TypeScript | Non-blocking asynchronous execution and strict compile-time typing. |
| **Framework** | Express.js (v4.21.2) | Fast HTTP request routing and custom middleware pipelines. |
| **Database** | PostgreSQL (Supabase) + Prisma ORM | Relational data integrity, migrations, and schema safety. |
| **Connection Pools**| Dual `@prisma/adapter-pg` (`salesPool` + `generalPool`) | Dedicated pools preventing ticket starvation during heavy reporting. |
| **Cache** | Redis (ioredis) + RAM cache (L1) | Hybrid cache-aside strategy with `SingleFlight` promise sharing. |
| **Validation** | Zod + Enums | Strict API payload schema parsing, eliminating *magic strings* with strong TS Enum typing. |
| **Realtime** | Socket.IO (WebSocket) | Tenant-isolated real-time state synchronization. |
| **Logging** | Pino Logger | Ultra-fast structured JSON logging for auditing and forensics. |

---

## 🏗️ Architecture & Code Layout

The project follows a strict layered architecture pattern:
`Controller ➔ Service ➔ Repository ➔ Prisma/PostgreSQL`

```text
src/
├── api/v1/
│   ├── controllers/   # Processes HTTP requests, maps DTOs, and returns response codes.
│   ├── routes/        # Maps endpoints and wires middleware filters.
│   ├── services/      # HTTP-layer coordinators: export formatters (PDF, Excel, CSV).
│   └── validators/    # Zod schemas for input validation.
├── core/              # Global shared clients (Prisma, Redis, Logger, Circuit Breakers).
├── domain/            # Business logic grouped by domain (ticket, commission, sorteo, backup).
│   ├── ticket/        # Ticket pipeline services, idempotency, image generator.
│   ├── commission/    # Commission resolver, rules engine, policy parser.
│   └── backup/        # Google Drive backup service.
├── middlewares/       # Security (RBAC, Rate Limiting), Error Handler, and Tenant Context (AsyncLocalStorage).
├── repositories/      # DB layer abstraction (running raw SQL and Prisma queries across pools).
├── scripts/CLI/       # Interactive Operations CLI wizard and live evaluation monitors.
└── utils/             # Helper utilities (Costa Rica timezones, formats, RBAC queries).
```

---

## 🔒 Security and Access Control (RBAC)

Access levels follow a strict hierarchical role-based access control (RBAC) model injected automatically via query decorators:

1.  **ADMIN:** Global platform supervisor. Unrestricted access to all Bancas, platform-wide metrics, and core rules.
2.  **BANCA (Tenant):** Organization owner. Full access to their assigned Windows, Sellers, commission settings, and balance history.
3.  **VENTANA (Branch):** Local branch supervisor. Manages assigned sellers, local drawing limits, and branch settlements.
4.  **VENDEDOR (Terminal):** Transaction-only level. Restricted to printing tickets, short-grace cancellations, and checking personal shift balances.

---

## 📈 Database & Cache Optimizations

### Dual Dedicated Connection Pools
To guarantee high availability and sub-100ms response times for ticket sales, database connections are physically partitioned:
1.  **Sales Pool (`salesPool`):** Reserved exclusively for ticket issuance, cancellation, and time-critical validations. Operates with aggressive acquire timeouts and guaranteed headroom.
2.  **General Pool (`generalPool`):** Handles analytics, exports (Excel, PDF), user management, and administrative dashboards without ever starving the sales pool.

### Cache-Aside Strategy, SingleFlight & Session Pre-Warming
*   **SingleFlight Promise Coalescing:** Identical concurrent requests (e.g. user authentication or numbers analytics) coalesce into a single pending promise, querying the database only once and distributing the result to all callers.
*   **Session Pre-Warming:** Successful logins and token refreshes immediately hydrate user session data into both L1 (RAM) and L2 (Redis) via write-through caching.
*   **High-Rotation Analytical Caching:** Expensive analytical endpoints (such as `calculateExposure` and `numbers-analysis`) utilize short 15-second TTL caches to handle multi-client dashboard traffic with near-zero database overhead.

### Production Indexing Catalog
The database indexes are heavily optimized to prevent read bottlenecks:
*   **Partial Indexes:** B-Tree trees are filtered to include only active rows. For example, `idx_ticket_banca_sorteo_winner_perf` only indexes rows where `isActive = true` and `isWinner = true`, saving RAM.
*   **Covering Indexes (`INCLUDE`):** Critical lookup queries use covering indexes on `Jugada` leaf nodes to allow PostgreSQL to satisfy queries via **Index Only Scan** without reading heap pages from disk.
*   **Index Pruning:** Obsolete and redundant indexes (such as `idx_jugada_maestro_final`) have been removed to minimize write amplification and I/O latency during ticket creation.

---

## ⏰ Timezone & Drawing Logic (GMT-6)

The backend runs on **Costa Rica (UTC-6)** timezone as its single source of truth for all business operations:
*   **Storage:** Database timestamps are persisted as UTC ISO-8601 strings.
*   **Business Date:** Aggregations and closures split the day at local midnight (CR), not UTC midnight.
*   **Drawing Cutoff:** Sellers are prevented from issuing tickets when the drawing cutoff time is reached (`scheduledAt` - seller grace minutes).

---

## 💻 Installation & Local Deployment

### Prerequisites
*   Node.js v20.x
*   PostgreSQL 15+
*   Redis 6+

### Environment Variables (.env)
Create a `.env` file in the root directory (use `.env.example` as a template):

| Variable | Description | Example |
| :--- | :--- | :--- |
| `DATABASE_URL` | General connection string for web requests (pooler port 6543) | `postgresql://...:6543/postgres` |
| `SALES_DATABASE_URL` | *(Optional)* Dedicated DB connection string for ticket sales | `postgresql://...:6543/postgres` |
| `DIRECT_URL` | Direct connection string for migrations and scripts (direct port 5432) | `postgresql://...:5432/postgres` |
| `REDIS_URL` | Connection URL for Redis | `redis://localhost:6379` |
| `JWT_ACCESS_SECRET` | Secret key for JWT signatures | `your_secure_secret` |
| `BUSINESS_CUTOFF_HOUR_CR` | Default business day cutoff time (CR local) | `23:59` |
| `ENABLE_RESOURCE_MONITOR` | Enable diagnostic resource monitoring daemon (`true`/`false`) | `false` |

### Installation & Operations Steps

```bash
# 1. Install dependencies
npm install

# 2. Generate Prisma Client
npm run prisma:generate

# 3. Apply migrations
npx prisma migrate dev

# 4. Start local development server with hot-reload
npm run dev

# 5. Launch interactive Operations CLI wizard
npm run ops

---

## 📄 License & Authors

Private software developed for restricted commercial usage. All rights reserved.

*   **Lead Architect and Developer:** [Mario Quirós P.](https://github.com/MQuirosP)
