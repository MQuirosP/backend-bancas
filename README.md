# 🏦 Banca Management Backend (Multi-Tenant Edition)

[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue.svg)](https://www.typescriptlang.org/)
[![Express](https://img.shields.io/badge/Express.js-4.18-green.svg)](https://expressjs.com/)
[![Prisma](https://img.shields.io/badge/Prisma-ORM-1B222D.svg)](https://www.prisma.io/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-15.0-336791.svg)](https://www.postgresql.org/)
[![Redis](https://img.shields.io/badge/Redis-Cache-DC382D.svg)](https://redis.io/)

> **Motor transaccional de alto rendimiento para la administración integral de loterías y bancas.**

Este repositorio contiene el backend core del sistema. Construido con arquitectura Multi-Tenant, permite alojar múltiples bancas de manera aislada sobre una misma infraestructura, procesando miles de transacciones concurrentes con latencias mínimas y alta disponibilidad.

---

## 🚀 Características Principales

*   **🏢 Arquitectura Multi-Tenant Aislada:** Un solo clúster de base de datos sirve a múltiples clientes (Bancas) asegurando el particionamiento de datos mediante políticas de acceso a nivel de aplicación (RBAC y filtros `bancaId`).
*   **⚡ Motor Transaccional Anti-Fraude:** Soporta altas cargas de concurrencia usando control de transacciones ACID y bloqueos optimistas para evitar *overselling* y condiciones de carrera en la venta de tickets.
*   **🛡️ Sistema de Resiliencia (Circuit Breakers):** Middleware maestro (`ResilienceService`) que protege el pool de conexiones a la base de datos implementando reintentos exponenciales (backoff) y control de concurrencia.
*   **📊 Analítica en Tiempo Real (Rollups):** Generación de reportes instantáneos mediante agregación matemática incremental (`CierreRollupService`), eliminando la necesidad de costosas vistas materializadas (Materialized Views).
*   **💰 Motor de Comisiones Jerárquico:** Resolución dinámica de comisiones, pagos y límites de riesgo evaluando reglas en cascada a nivel Usuario > Ventana > Banca.

---

## 🛠️ Stack Tecnológico

| Componente | Tecnología | Propósito |
| :--- | :--- | :--- |
| **Runtime** | Node.js + TypeScript | Tipado estático estricto y ejecución asíncrona no bloqueante. |
| **API Framework** | Express.js | Enrutamiento HTTP eficiente y middlewares personalizados. |
| **Persistencia** | PostgreSQL + Prisma | Integridad relacional, migraciones declarativas y seguridad de tipos. |
| **Caché** | Redis (L2) + RAM (L1) | Sistema de caché híbrida para la mitigación del efecto "Thundering Herd". |
| **Validación** | Zod | Validación rigurosa de esquemas y sanitización de payloads HTTP. |
| **Observabilidad**| Pino Logger | Logging estructurado JSON de alta velocidad para trazabilidad y auditoría. |

---

## 🏗️ Estructura del Código

El proyecto sigue una **Arquitectura de Capas Lógicas**, asegurando la separación de responsabilidades:

```text
src/
├── api/v1/
│   ├── controllers/   # Manejo de peticiones HTTP, respuestas y mapeo de DTOs.
│   ├── routes/        # Definición de endpoints y aserción de middlewares.
│   ├── services/      # Lógica de negocio core y orquestación de operaciones.
│   └── validators/    # Esquemas Zod para la capa de presentación.
├── core/              # Configuraciones maestras (Prisma, Redis, Sentry, Logger).
├── middlewares/       # Seguridad (RBAC, Rate Limiting), Resiliencia y Headers.
├── repositories/      # Acceso a base de datos abstracto (consultas raw y ORM).
└── utils/             # Funciones puras, matemáticas de precisión y lógica temporal.
```

---

## 🔒 Seguridad y Control de Acceso (RBAC)

El acceso al sistema está jerarquizado en 3 niveles de autoridad:

1.  **ADMIN:** Control absoluto de la plataforma, auditoría y parametrización global.
2.  **VENTANA:** Gestión de operaciones comerciales, límites de riesgo y reportes de sucursal.
3.  **VENDEDOR:** Nivel transaccional. Creación de tickets y liquidación de turnos operativos.

> **Criptografía:** JWT asimétrico (Access & Refresh tokens) rotativos. Trazabilidad inmutable de eventos críticos financieros a través de `ActivityLog`.

---

## ⏰ Manejo de Zonas Horarias (CRÍTICO)

Todas las transacciones financieras y programaciones de sorteos operan estrictamente atadas a la zona horaria comercial **(GMT-6, Costa Rica)**.  
El sistema convierte de manera transparente las programaciones relativas en instantes UTC ISO-8601 antes de la persistencia.
> **Atención Desarrolladores:** Los cierres matemáticos (`businessDate`) dividen la jornada respetando la medianoche de la zona local, no del servidor Cloud subyacente. Consultar guía interna de estandarización temporal.

---

## 📖 Instrucciones de Despliegue Local

### Requisitos Previos
* Node.js v18+
* PostgreSQL 15+
* Redis 6+

### Configuración Inicial
Crea un archivo `.env` en la raíz (usa `.env.example` como plantilla):
```env
PORT=4000
NODE_ENV=development
DATABASE_URL="postgresql://user:password@localhost:5432/bancas?schema=public"
JWT_ACCESS_SECRET="tu-secreto-seguro"
REDIS_URL="redis://localhost:6379"
```

### Ejecución
```bash
# 1. Instalar dependencias
npm install

# 2. Construir base de datos y esquemas ORM
npx prisma generate
npx prisma migrate dev

# 3. Iniciar el servidor local con Hot-Reload
npm run dev
```

---

## 📄 Licencia

Sistema desarrollado como infraestructura Backend privada.  
Todos los derechos reservados.

**Autor Principal:** [Mario Quirós P.](https://github.com/MQuirosP)
