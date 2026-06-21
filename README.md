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

*   **🏢 Isolated Multi-Tenancy:** Data privacy and relation integrity are guaranteed at the application level via custom filters and mandatory query scopes linked to `bancaId`.
*   **⚡ Serializable ACID Transactions:** Robust concurrency control and race condition prevention (preventing ticket overselling) handled via backoff retry transaction loops (`withTransactionRetry`).
*   **🛡️ Core Resilience (Circuit Breakers):** Centralized middleware wrapper (`ResilienceService`) protecting the database pool against spikes and degrading secondary tasks if resources are low.
*   **🏎️ Hybrid L1/L2 Cache:** Mitigates the "Thundering Herd" effect by combining local memory caching (L1) and Redis (L2) with in-flight request coalescing (`_filterOptionsInFlight`).
*   **📊 Incremental Financial Rollups:** Daily settlements aggregated directly using raw SQL queries, removing the storage costs and update lag of Postgres Materialized Views.
*   **💵 Hierarchical Commissions:** Cascade commission resolution evaluated dynamically: Seller ➔ Window ➔ Banca, persisting immutable commission snapshots per play.

---

## 🛠️ Technology Stack

| Component | Technology | Purpose |
| :--- | :--- | :--- |
| **Runtime** | Node.js (v20.x) + TypeScript | Non-blocking asynchronous execution and strict compile-time typing. |
| **Framework** | Express.js (v4.21.2) | Fast HTTP request routing and custom middleware pipelines. |
| **Database** | PostgreSQL (Supabase) + Prisma ORM | Relational data integrity, migrations, and schema safety. |
| **Connection Pool** | `@prisma/adapter-pg` + `pg-pool` | Connection warm-up and raw PostgreSQL client adapter. |
| **Cache** | Redis (ioredis) + RAM cache | Hybrid cache-aside strategy (L1 local / L2 distributed). |
| **Validation** | Zod | Rigorous API payload schema parsing and sanitization. |
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
│   ├── services/      # Core business logic, transaction handling, and financial operations.
│   └── validators/    # Zod schemas for input validation.
├── core/              # Global shared clients (Prisma, Redis, Logger, Circuit Breakers).
├── middlewares/       # Security (RBAC, Rate Limiting), Error Handler, and Tenant Context.
├── repositories/      # DB layer abstraction (running raw SQL and Prisma queries).
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

### Cache-Aside Strategy and Request Coalescing
For expensive aggregation operations (like dynamically building the drawing search dropdowns), the backend uses:
1.  **In-Flight Request Coalescing:** If 10 sellers query the exact same filters simultaneously, only 1 database query is executed. The other 9 share the same pending promise in a local Map (`_filterOptionsInFlight`).
2.  **Cache Tagging:** Redis cache keys are grouped and programmatically evicted when write events (like selling a ticket) occur for the corresponding tenant.

### Production Indexing Catalog
The database indexes are heavily optimized to prevent read bottlenecks:
*   **Partial Indexes:** B-Tree trees are filtered to include only active rows. For example, `idx_ticket_banca_sorteo_winner_perf` only indexes rows where `isActive = true` and `isWinner = true`, saving RAM.
*   **Covering Indexes (`INCLUDE`):** Critical tables (like `Jugada`) cover `amount` and `payout` on their leaf nodes, allowing the optimizer to fetch data via **Index Only Scan** without reading the table pages from disk (Heap).

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
| `DATABASE_URL` | DB connection string for web requests (pooler port 6543) | `postgresql://...:6543/postgres` |
| `DIRECT_URL` | DB connection string for migrations and scripts (direct port 5432) | `postgresql://...:5432/postgres` |
| `REDIS_URL` | Connection URL for Redis | `redis://localhost:6379` |
| `JWT_ACCESS_SECRET` | Secret key for JWT signatures | `your_secure_secret` |
| `BUSINESS_CUTOFF_HOUR_CR` | Default business day cutoff time (CR local) | `23:59` |

### Installation Steps

```bash
# 1. Install dependencies
npm install

# 2. Generate Prisma Client
npx prisma generate

# 3. Apply migrations
npx prisma migrate dev

# 4. Start local development server with hot-reload
npm run dev
```

---

## 📄 License & Authors

Private software developed for restricted commercial usage. All rights reserved.

*   **Lead Architect and Developer:** [Mario Quirós P.](https://github.com/MQuirosP)
