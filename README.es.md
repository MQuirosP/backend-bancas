# 🏦 Motor Backend para Gestión de Bancas (Multi-Tenant Edition)

🌎 **[English](README.md) | Español**

---

> **Motor transaccional y analítico de alto rendimiento para la administración integral de loterías, sucursales (ventanas) y terminales de venta.**

Este repositorio contiene el backend core del sistema de bancas. Diseñado bajo una arquitectura **Multi-Tenant** aislada, permite alojar múltiples organizaciones (Bancas) compartiendo de forma segura una única infraestructura lógica de base de datos. Está optimizado para procesar transacciones concurrentes con latencias de consulta mínimas y alta tolerancia a fallos.

---

## 📌 Índice de Contenidos

1. [🚀 Características Principales](#-características-principales)
2. [🛠️ Stack Tecnológico](#%EF%B8%8F-stack-tecnológico)
3. [🏗️ Estructura y Capas de Código](#%EF%B8%8F-estructura-y-capas-de-código)
4. [🔒 Aislamiento y Control de Acceso (RBAC)](#-aislamiento-y-control-de-acceso-rbac)
5. [📈 Optimización de Base de Datos y Caché](#-optimización-de-base-de-datos-y-caché)
6. [⏰ Manejo del Tiempo y Timezones (GMT-6)](#-manejo-del-tiempo-y-timezones-gmt-6)
7. [💻 Configuración y Despliegue Local](#-configuración-y-despliegue-local)
8. [📄 Licencia y Autores](#-licencia-y-autores)

---

## 🚀 Características Principales

*   **🏢 Aislamiento Multi-Tenant Lógico:** Seguridad e integridad relacional garantizadas mediante políticas de control a nivel de aplicación (RBAC y filtros obligatorios por `bancaId`).
*   **⚡ Transaccionalidad ACID Robusta:** Control estricto de concurrencia y protección contra condiciones de carrera en ventas masivas mediante reintentos de transacciones serializables (`withTransactionRetry`).
*   **🛡️ Sistema de Resiliencia Centralizado:** Middleware con Circuit Breakers (`ResilienceService`) que protege el pool de conexiones frente a sobrecargas y degrada las funciones secundarias si es necesario.
*   **🏎️ Caché Híbrida L1/L2:** Mitigación del efecto "Thundering Herd" mediante una capa in-memory (L1) y Redis (L2) con deduplicación de promesas en vuelo (Request Coalescing).
*   **📊 Analítica Incremental (Rollups):** Cierres diarios mediante agregaciones directas SQL sin el costo de almacenamiento ni latencia de vistas materializadas.
*   **💵 Comisiones Jerárquicas:** Resolución dinámica de comisiones en cascada: Vendedor (Listero) ➔ Ventana (Sucursal) ➔ Banca, persistiendo snapshots inmutables por jugada.

---

## 🛠️ Stack Tecnológico

| Componente | Tecnología | Propósito |
| :--- | :--- | :--- |
| **Runtime** | Node.js (v20.x) + TypeScript | Entorno asíncrono no bloqueante y tipado estricto. |
| **Framework** | Express.js (v4.21.2) | Ruteo HTTP rápido y tuberías de middlewares. |
| **Persistencia**| PostgreSQL (Supabase) + Prisma ORM | Almacenamiento seguro, llaves foráneas y migraciones declarativas. |
| **Conectividad**| `@prisma/adapter-pg` + `pg-pool` | Manejo y calentamiento dinámico del pool de conexiones. |
| **Caché** | Redis (ioredis) + Caché en RAM | Caché de segundo nivel distribuido y primer nivel local. |
| **Validación** | Zod | Validación estricta y tipado dinámico en la entrada de datos. |
| **Logging** | Pino Logger | Bitácora estructurada JSON ultrarrápida para auditoría forense. |

---

## 🏗️ Estructura y Capas de Código

La arquitectura sigue una convención estricta de separación de responsabilidades:
`Controller ➔ Service ➔ Repository ➔ Prisma/PostgreSQL`

```text
src/
├── api/v1/
│   ├── controllers/   # Manejo de entradas/salidas HTTP, códigos de estado y respuestas.
│   ├── routes/        # Definición de endpoints HTTP y asociación de middlewares.
│   ├── services/      # Lógica pura de negocio, orquestación y transacciones financieras.
│   └── validators/    # Esquemas Zod para la capa de presentación de requests.
├── core/              # Clientes globales compartidos (Prisma, Redis, Logger, Circuit Breakers).
├── middlewares/       # Seguridad (RBAC, Rate Limiting), Manejo de Errores y Contexto Multi-Tenant.
├── repositories/      # Acceso exclusivo a la base de datos y helpers de transacciones.
└── utils/             # Funciones utilitarias (fechas timezone Costa Rica, RBAC, etc.).
```

---

## 🔒 Aislamiento y Control de Acceso (RBAC)

El acceso a los recursos sigue una jerarquía de cuatro niveles, donde el middleware de filtrado RBAC (`applyRbacFilters`) inyecta los límites en cada consulta:

1.  **ADMIN:** Superadministrador global. Control de todas las bancas, auditoría del sistema y configuraciones base.
2.  **BANCA (Tenant):** Dueño de la organización. Acceso completo a sus sucursales (Ventanas), vendedores y reportes de comisiones consolidados.
3.  **VENTANA (Branch):** Supervisor local. Controla un grupo de vendedores y sus límites de ventas asignados.
4.  **VENDEDOR (Terminal):** Transaccional. Solo puede vender tiquetes, anular en tiempo de gracia y consultar sus propios saldos de turno.

---

## 📈 Optimización de Base de Datos y Caché

### Estrategia de Caché-Aside y Request Coalescing
Para los endpoints de alto costo computacional (como las opciones de filtrado dinámico en la lista de tiquetes), el backend implementa:
1.  **Deduplicación en vuelo (Coalescing):** Si entran 10 peticiones concurrentes del mismo vendedor solicitando los mismos filtros, solo se realiza una consulta a la base de datos. Las otras 9 esperan la misma promesa activa en un mapa local (`_filterOptionsInFlight`).
2.  **Caché L2 con tags:** Claves de caché distribuidas en Redis con invalidación controlada por etiquetas de eventos (ej. cuando se crea un tiquete, se invalidan los filtros asociados al usuario).

### Catálogo de Indexación de Producción
La base de datos cuenta con una estrategia de indexación selectiva para mitigar el costo de lectura:
*   **Índices Compuestos Parciales:** Se usan para restringir los árboles B-Tree a datos activos. Por ejemplo, `idx_ticket_banca_sorteo_winner_perf` solo indexa registros donde `isActive = true` y `isWinner = true`, manteniendo el índice en memoria RAM.
*   **Índices de Cobertura (`INCLUDE`):** Índices en la tabla `Jugada` (como `idx_jugada_maestro_final`) incluyen los valores de `amount` y `payout` en sus páginas hoja, permitiendo realizar consultas mediante **Index Only Scan** sin leer la tabla en disco (Heap).

---

## ⏰ Manejo del Tiempo y Timezones (GMT-6)

El backend tiene como **única fuente de verdad** comercial la hora de **Costa Rica (UTC-6)**.
*   **Almacenamiento:** Los timestamps en base de datos se guardan en formato UTC.
*   **Business Date:** Las operaciones diarias se segmentan por la fecha comercial de Costa Rica utilizando `businessDate` (columna `DATE`). Si un sorteo ocurre a las 11:30 PM de hoy en Costa Rica (5:30 AM del día siguiente en UTC), pertenece comercialmente al día de hoy.
*   **Fecha de Corte:** Las reglas de negocio impiden vender tiquetes una vez alcanzada la hora de corte del sorteo (`scheduledAt` - minutos de gracia del listero).

---

## 💻 Configuración y Despliegue Local

### Requisitos Previos
*   Node.js v20.x
*   PostgreSQL 15+ (o Supabase local)
*   Redis 6+ (o Upstash)

### Variables de Entorno (.env)
Crea un archivo `.env` en la raíz guiándote por el archivo `.env.example`:

| Variable | Descripción | Ejemplo |
| :--- | :--- | :--- |
| `DATABASE_URL` | URL de conexión para peticiones web (puerto pooler 6543) | `postgresql://...:6543/postgres` |
| `DIRECT_URL` | URL de conexión directa para migraciones y scripts (puerto 5432) | `postgresql://...:5432/postgres` |
| `REDIS_URL` | URL de conexión de Redis | `redis://localhost:6379` |
| `JWT_ACCESS_SECRET` | Llave secreta para firmar tokens de acceso | `tu_secreto_seguro` |
| `BUSINESS_CUTOFF_HOUR_CR` | Hora por defecto de corte comercial (CR) | `23:59` |

### Pasos de Instalación

```bash
# 1. Instalar dependencias del proyecto
npm install

# 2. Generar el cliente de base de datos Prisma
npx prisma generate

# 3. Aplicar migraciones pendientes
npx prisma migrate dev

# 4. Iniciar servidor de desarrollo (Hot reload con Nodemon)
npm run dev
```

---

## 📄 Licencia y Autores

Software propietario desarrollado de uso privado y comercial restringido.

*   **Creador y Desarrollador Principal:** [Mario Quirós P.](https://github.com/MQuirosP)
