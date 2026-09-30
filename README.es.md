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

*   **🏢 Aislamiento Multi-Tenant Lógico:** Seguridad e integridad relacional garantizadas a nivel de aplicación mediante propagación de contexto con `AsyncLocalStorage`, reescritura automática de queries en Prisma Client por `bancaId`, y salas de WebSockets aisladas por inquilino.
*   **⚡ Pools de Conexiones Dedicados:** Separación física del pool de conexiones de base de datos (`salesPool` con máxima prioridad y timeouts reducidos frente a `generalPool` para reportes y dashboards), garantizando que la emisión de tiquetes nunca sufra inanición (*starvation*) frente a cargas analíticas pesadas.
*   **🛡️ Sistema de Resiliencia y Circuit Breaker de JWT:** Middleware centralizado (`ResilienceService`) que protege la base de datos contra ráfagas, combinado con un interruptor criptográfico (*circuit breaker*) de JWT que asegura la operación continua de terminales incluso ante latencias severas (>1,500 ms) en DB o Redis.
*   **🏎️ Caché Híbrida Multinivel con SingleFlight:** Mitigación del efecto *Thundering Herd* combinando memoria local (L1) y Redis (L2) con deduplicación de promesas en vuelo (`SingleFlight`), precalentamiento inmediato de sesiones en login/refresh (*write-through*), y TTLs de alta rotación (15s) para analítica en vivo.
*   **🔄 Sincronización Realtime por WebSockets:** Notificaciones inmediatas (`SORTEOS_UPDATED`, `DASHBOARD_UPDATED`) emitidas a los clientes ante cambios de estado en sorteos o evaluaciones concluidas, eliminando el polling agresivo y manteniendo los paneles actualizados en tiempo real.
*   **🌐 Blindaje TCP y Sincronización con Reverse Proxy:** Sockets HTTP en Node.js optimizados (`keepAliveTimeout = 65s`, `headersTimeout = 66s`, `backlog = 511`) para eliminar colisiones de conexión 502/503 y absorber ráfagas concurrentes detrás del Load Balancer de Render.
*   **📊 Analítica de Riesgo y Cierres Optimizados:** Exposición de riesgo calculada en tiempo real mediante consultas SQL consolidadas en una sola pasada (reduciendo la latencia de ~600 ms a ~60 ms) y liquidaciones contables agregadas directamente sin la sobrecarga de vistas materializadas.
*   **🛠️ Herramienta CLI de Operaciones:** Wizard interactivo de terminal (`npm run ops`) para tareas administrativas críticas: anulación de tiquetes fuera de gracia con registro forense, sincronización forzada de balances diarios y monitoreo de sorteos en vivo.
*   **💵 Comisiones Jerárquicas:** Resolución dinámica de comisiones en cascada: Vendedor (Listero) ➔ Ventana (Sucursal) ➔ Banca, persistiendo snapshots inmutables por jugada.

---

## 🛠️ Stack Tecnológico

| Componente | Tecnología | Propósito |
| :--- | :--- | :--- |
| **Runtime** | Node.js (v20.x) + TypeScript | Entorno asíncrono no bloqueante y tipado estricto. |
| **Framework** | Express.js (v4.21.2) | Ruteo HTTP rápido y tuberías de middlewares. |
| **Persistencia**| PostgreSQL (Supabase) + Prisma ORM | Almacenamiento seguro, llaves foráneas y migraciones declarativas. |
| **Pools de Conexión**| Doble `@prisma/adapter-pg` (`salesPool` + `generalPool`) | Pools dedicados para evitar inanición de ventas ante reportes pesados. |
| **Caché** | Redis (ioredis) + Caché en RAM (L1) | Estrategia híbrida de caché con coalescencia de promesas `SingleFlight`. |
| **Validación** | Zod + Enums | Validación estricta, eliminación de *magic strings* y tipado fuerte (Enums) desde la API hasta la DB. |
| **Realtime** | Socket.IO (WebSocket) | Sincronización de eventos en tiempo real con salas aisladas por banca. |
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
│   ├── services/      # Lógica pura de negocio, orquestación y exportación de reportes.
│   └── validators/    # Esquemas Zod para la capa de presentación de requests.
├── core/              # Clientes globales compartidos (Prisma, Redis, Logger, Circuit Breakers).
├── domain/            # Lógica de dominio modular (ticket, comisiones, sorteos, respaldos).
│   ├── ticket/        # Tubería de venta de tiquetes, idempotencia y render de imágenes.
│   ├── commission/    # Resolutor de comisiones y políticas jerárquicas.
│   └── backup/        # Servicio de respaldo automatizado a Google Drive.
├── middlewares/       # Seguridad (RBAC, Rate Limiting), Manejo de Errores y Contexto Multi-Tenant (AsyncLocalStorage).
├── repositories/      # Acceso exclusivo a base de datos y enrutamiento entre pools de conexión.
├── scripts/CLI/       # Wizard CLI interactivo de operaciones y monitoreo en vivo de evaluaciones.
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

### Pools de Conexiones Dedicados
Para asegurar disponibilidad continua y latencias inferiores a 100 ms en la venta de tiquetes, las conexiones a PostgreSQL están segregadas físicamente:
1.  **Pool de Ventas (`salesPool`):** Dedicado exclusivamente a la emisión, anulación y validaciones críticas de tiquetes. Posee timeouts estrictos y margen garantizado de conexiones.
2.  **Pool General (`generalPool`):** Destinado a analítica, exportaciones (Excel, PDF), gestión de usuarios y dashboards administrativos, evitando que degraden las ventas.

### Estrategia de Caché-Aside, SingleFlight y Precalentamiento
*   **Deduplicación en Vuelo (`SingleFlight`):** Consultas idénticas simultáneas (autenticación de usuario, analítica de números) comparten una única promesa activa, realizando una sola petición a la base de datos y entregando el resultado a todos los clientes concurrentes.
*   **Precalentamiento de Sesiones (*Session Pre-Warming*):** Al autenticarse o refrescar token, la sesión se escribe inmediatamente en L1 (RAM) y L2 (Redis) mediante escritura directa (*write-through*).
*   **Caché de Alta Rotación en Analítica:** Endpoints analíticos exigentes (`calculateExposure`, `numbers-analysis`) utilizan TTLs cortos de 15 segundos para absorber tráfico masivo en dashboards con carga prácticamente nula en la base de datos.

### Catálogo de Indexación de Producción
La base de datos cuenta con una estrategia de indexación selectiva para mitigar el costo de lectura:
*   **Índices Compuestos Parciales:** Se usan para restringir los árboles B-Tree a datos activos. Por ejemplo, `idx_ticket_banca_sorteo_winner_perf` solo indexa registros donde `isActive = true` y `isWinner = true`, manteniendo el índice en memoria RAM.
*   **Índices de Cobertura (`INCLUDE`):** Consultas clave emplean índices de cobertura sobre hojas de `Jugada` para resolver peticiones vía **Index Only Scan** sin acceder a disco (Heap).
*   **Depuración de Índices:** Índices redundantes u obsoletos (como `idx_jugada_maestro_final`) fueron eliminados para reducir la amplificación de escrituras y la latencia de I/O en la creación de tiquetes.

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
| `SALES_DATABASE_URL` | *(Opcional)* URL de base de datos dedicada a emisión de ventas | `postgresql://...:6543/postgres` |
| `DIRECT_URL` | URL de conexión directa para migraciones y scripts (puerto 5432) | `postgresql://...:5432/postgres` |
| `REDIS_URL` | URL de conexión de Redis | `redis://localhost:6379` |
| `JWT_ACCESS_SECRET` | Llave secreta para firmar tokens de acceso | `tu_secreto_seguro` |
| `BUSINESS_CUTOFF_HOUR_CR` | Hora por defecto de corte comercial (CR) | `23:59` |
| `ENABLE_RESOURCE_MONITOR` | Activar daemon de monitoreo de recursos (`true`/`false`) | `false` |

### Pasos de Instalación y Operación

```bash
# 1. Instalar dependencias del proyecto
npm install

# 2. Generar el cliente de base de datos Prisma
npm run prisma:generate

# 3. Aplicar migraciones pendientes
npx prisma migrate dev

# 4. Iniciar servidor de desarrollo (Hot reload con Nodemon)
npm run dev

# 5. Iniciar el Wizard CLI de operaciones interactivas
npm run ops

---

## 📄 Licencia y Autores

Software propietario desarrollado de uso privado y comercial restringido.

*   **Creador y Desarrollador Principal:** [Mario Quirós P.](https://github.com/MQuirosP)
