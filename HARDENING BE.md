# Informe de Hardening Backend - Resiliencia Estructural (Marzo 2025)

Este documento detalla la implementación de medidas de resiliencia avanzada para garantizar la supervivencia del sistema bajo condiciones de estrés extremo, fallos de infraestructura y saturación de recursos.

---

## 1. Arquitectura de Resiliencia (Hardening BE)

Se ha implementado una defensa en profundidad dividida en capas críticas:

### **Capa 1: Global Admission Control (Middleware Maestro)**

* **Propósito:** Evitar la saturación del proceso de Node.js y el agotamiento del pool de conexiones.
* **Implementación:** ([./src/middlewares/resilience.middleware.ts](./src/middlewares/resilience.middleware.ts))
  * **Límite de Concurrencia:** Máximo de **6 requests simultáneos**. Dado que el `connection_limit` de Prisma es 8, esto garantiza un margen de seguridad de 2 slots para health checks y tareas internas.
  * **Monitoreo del Event Loop:** Integración con `toobusy-js` para rechazar peticiones (503) si el lag del loop supera los **70ms**.
  * **Request Timeout:** Per-request timeout de **15s** con limpieza automática de recursos mediante un `guard flag` para evitar dobles decrementos en el contador de operaciones.

### **Capa 2: Circuit Breaker Prisma (Base de Datos)**

* **Propósito:** Prevenir que la aplicación siga golpeando una base de datos degradada o lenta.
* **Implementación:** ([./src/core/resilience.service.ts](./src/core/resilience.service.ts))
  * **Clasificación de Errores Transitorios:** Solo fallan ante errores de infraestructura (`P1001`, `P1002`, `P1008`, `P1017`, `P2024`) o Timeouts. Los errores de lógica de negocio (como `P2002` Unique Constraint) se reportan como éxito de infraestructura.
  * **Umbrales de Apertura:** 5% de error rate en ventana de 10s o **3 timeouts consecutivos**.
  * **Integración:** Envolviendo transacciones críticas mediante `ResilienceService.runPrisma()` dentro de `withTransactionRetry`.

### **Capa 3: Circuit Breaker Redis & L1 Cache**

* **Propósito:** Evitar la amplificación de carga a la base de datos si Redis falla (Cache Stampede).
* **Implementación:** ([./src/core/resilience.service.ts](./src/core/resilience.service.ts))
  * **Anti-Stampede (Promise Coalescing):** Garantiza que solo viaje **una petición por red** para una misma clave de caché; las peticiones concurrentes esperan la misma promesa.
  * **L1 Fallback:** Cache en memoria de **3 segundos** que actúa como salvaguarda si el breaker de Redis se abre, evitando el colapso de la DB.

### **Capa 4: Observabilidad de Hardening**

* **Propósito:** Detección temprana de riesgos mediante métricas precisas.
* **Implementación:** ([./src/core/metrics.service.ts](./src/core/metrics.service.ts))
  * **Sliding Window:** Cálculo de error rate basado en una ventana deslizante de **10 segundos** (array de timestamps), eliminando los puntos ciegos de los resets por intervalo.
  * **Métricas Expuestas:** `activeRequests`, `dbQueryDuration`, `eventLoopLag`, `dbErrorRate` y `redisErrorRate`.
  * **Endpoint:** `/metrics` (público para monitoreo básico).

---

## 2. Refactorizaciones y Correcciones Críticas

| Acción | Descripción |
|---|---|
| **Migración de Servicios** | Se eliminó el método genérico `.wrap()` y se migraron todos los servicios de exportación (Excel/PDF) al nuevo patrón `.runPrisma()`. |
| **Desacoplamiento de Caché** | En `CacheService.wrap`, se separó la ejecución del `fetcher` del breaker de Redis para no contaminar métricas con errores de negocio. |
| **TS Hardening** | Corrección de errores de tipado en `ResilienceService` (acceso a `.code` y casts de promesas). |
| **Fix Rate Limit** | Implementación de `ipKeyGenerator` para resolver el warning `ERR_ERL_KEY_GEN_IPV6` y mejorar la validación de IPs IPv6. |
| **Initialization Lock** | El sistema ahora lanza un error explícito si se intenta usar la resiliencia antes de la inicialización de los breakers. |

---

## 3. Flujo de Request Protegido

El orden de evaluación garantiza que no se consuman recursos (slots de pool, memoria) si el sistema ya está bajo presión:

1. **Incoming Request**
2. **toobusy check** (Lag del Event Loop) → `503` si lag > 70ms.
3. **Concurrency check** (Admission Control) → `503` si > 6 reqs.
4. **CB Prisma check** (Estado del Circuito) → `503` si el circuito está Abierto.
5. **Slot Consumption** (Registro en `activeOperationsService`).
6. **Handler execution** (Servicios, Repositorios, etc.).
7. **Release** (Limpieza automática al finalizar/cerrar la respuesta).

---

## 4. Beneficios Finales

1. **Resiliencia Estructural:** El sistema ya no entra en "Death Spiral" por reintentos infinitos o esperas indefinidas en el pool.
2. **Falla Rápida (Fail-Fast):** El sistema detecta degradación en milisegundos y protege la base de datos Supabase.
3. **Métricas Confiables:** Diferenciación clara entre errores lógicos (bugs) y errores de infraestructura (caídas).
4. **Protección de Recursos:** Margen de seguridad constante para operaciones administrativas y de mantenimiento.

**Informe actualizado.**
*Fecha: 03-Mar-2026*
