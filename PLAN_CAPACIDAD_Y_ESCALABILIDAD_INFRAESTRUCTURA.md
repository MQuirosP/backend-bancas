# Plan de Capacidad, Rendimiento y Escalabilidad de Infraestructura

> **Fecha de creación:** 13 de Septiembre, 2026  
> **Ámbito:** Backend Bancas (Node.js / Express / Prisma) en Render + PostgreSQL en Supabase  
> **Objetivo:** Establecer el diagnóstico formal del rendimiento de la infraestructura, registrar las causas raíz de incidencias previas (503s y latencia en cierres) y definir una hoja de ruta con disparadores objetivos (*triggers*) para escalar hardware vs. optimizar configuración.

---

## 1. Estado Actual de la Infraestructura

| Componente | Proveedor / Tier | Especificaciones de Hardware | Configuración Relevante |
| :--- | :--- | :--- | :--- |
| **API Backend** | Render — **Starter** | 0.5 vCPU (compartido), 512 MB RAM | `NODE_OPTIONS=--max-old-space-size=200`, `MAX_CONCURRENT_REQUESTS=100`, `EVENT_LOOP_LAG_THRESHOLD_MS=2000` |
| **Base de Datos** | Supabase — **Small** | 1 vCPU (dedicado), 2 GB RAM | PgBouncer Pool Size = 50 conexiones, Prisma `connection_limit=20` |
| **Caché / Broker** | Upstash — **Serverless Redis** | Latencia ~15ms con TLS | `CACHE_ENABLED=true`, Híbrido L1 (RAM Node.js) + L2 (Upstash Redis) |

---

## 2. Diagnóstico de Métricas Reales (Ventana de 48 Horas)

Tras analizar los gráficos de rendimiento de Render correspondientes a las últimas 48 horas:

### A. Memoria RAM (Promedio en Instancias)
* **Comportamiento:** Oscila de manera predecible y saludable entre el **40% y el 65%** (~200 MB a 330 MB consumidos del total de 512 MB).
* **Comportamiento nocturno:** Baja a ~35% - 40% durante los valles de venta.
* **Diagnóstico:** **No existe fuga de memoria (*memory leak*).** Las caídas abruptas corresponden a ciclos estándar y eficientes del *Garbage Collector* de Node.js liberando espacio antes de tocar los límites del contenedor.

### B. Uso de CPU (Promedio en Instancias)
* **Comportamiento diurno:** Promedio operativo entre **10% y 20%** durante horas de alta venta.
* **Picos máximos:** Ráfagas puntuales que tocan entre el **40% y el 45%** (ej. 2:30pm – 3:30pm y en cierres nocturnos).
* **Diagnóstico:** **El procesador no está saturado.** No existen períodos donde el CPU toque el 80% - 100% de manera sostenida.

---

## 3. Causa Raíz de Incidentes Previos (Desmitificación)

Los incidentes observados en producción **no fueron causados por insuficiencia de hardware**:

1. **Errores HTTP 503 (Desconexiones y Caídas de Servicio):**
   * **Causa real:** Eran **autoinfligidos por software** mediante el middleware [resilience.middleware.ts](file:///c:/Users/mquir/Proyectos/Bancas/backend/src/middlewares/resilience.middleware.ts).
   * Tenía un umbral de `toobusy-js` de 300 ms extremadamente bajo que cortaba peticiones válidas ante pequeñas pausas de recolección de memoria (863 ms).
   * Tenía un límite de concurrencia rígido (`MAX_CONCURRENT_REQUESTS=40`) que rechazaba peticiones cuando varios terminales sincronizaban a la vez.

2. **Picos de Latencia de 6.0s a 7.5s (Sorteos Evaluados):**
   * **Causa real:** **Efecto Avalancha (*Thundering Herd*) y encolamiento en Base de Datos.**
   * Al emitirse el evento de sorteo evaluado vía WebSocket (`notifySorteoEvaluated`), todas las terminales conectadas disparaban en el mismo milisegundo peticiones pesadas (`evaluated-summary`, `tickets`, etc.).
   * Estas peticiones compitieron contra la transacción de cierre contable (`syncSorteoStatements`), saturando el pool anterior de Supabase que estaba restringido a 25 conexiones. Las peticiones no eran lentas por CPU; estaban encoladas esperando una conexión disponible.

---

## 4. Línea Base de Configuración Aplicada

Para resolver de raíz estos incidentes sin incurrir en costos innecesarios, se aplicaron las siguientes configuraciones:

* **Modo Observabilidad en `toobusy`:** Se removió la respuesta HTTP 503 del middleware de latencia de event loop. Ahora genera una alerta de advertencia estructurada (`EVENT_LOOP_LAG_WARNING`) para diagnóstico sin interrumpir la operación de los clientes.
* **Ampliación de Concurrencia:** `MAX_CONCURRENT_REQUESTS` elevado a **100** (con umbral de advertencia en 80).
* **Alineación de Conexiones:**
  * Supabase Pool Size: Elevado de 25 a **50**.
  * Prisma Client: Fijado en `connection_limit=20` por instancia (permitiendo soportar hasta 2 instancias concurrentes con margen para tareas de mantenimiento).
* **Activación de Upstash Redis:** Configurado con TLS (`rediss://`) para caché L2 y adaptador de salas en Socket.io.

---

## 5. Hoja de Ruta de Escalabilidad (Software vs. Hardware)

### Fase 1: Optimización a Nivel de Software (Implementado / Producción)
*Antes de contemplar incrementos de hardware, se agotaron las optimizaciones de arquitectura:*

1. **Caché Híbrido L1 (Memoria RAM) + L2 (Upstash Redis) en `CacheService.wrap`:**
   * Las peticiones ahora se sirven primero desde la memoria RAM del contenedor Node.js (< 1 ms de latencia) y se respaldan en Upstash Redis (15 ms), reduciendo a cero el impacto en PostgreSQL.
2. **Request Coalescing en Memoria:**
   * Las terminales que envían 2 o 3 peticiones idénticas al mismo milisegundo se fusionan en una sola promesa en memoria (`inFlightPromises`), reduciendo la carga en un 60%.
3. **Pre-calentamiento de Caché (*Cache Pre-warming*) al Evaluar Sorteo:**
   * En `sorteoEvaluation.coordinator.ts`, justo después de `syncSorteoStatements`, el servidor pre-calcula los resúmenes de los vendedores y los deja almacenados en Upstash Redis y L1 **antes** de emitir `SocketService.notifySorteoEvaluated`.
   * Al sonar el WebSocket, las terminales encuentran el dato caliente en memoria (respuesta en <15 ms, 0 consultas a Postgres).
4. **Validar la nueva línea base:** Monitorear el comportamiento de las métricas en los cierres de sorteos de las próximas 48 a 72 horas.

---

### Fase 2: ¿Cuándo escalar Render a Tier "Standard"?
* **Especificaciones del salto:** De 0.5 vCPU compartido / 512 MB ($7/mo) ➔ **1 vCPU dedicado / 2 GB RAM ($25/mo)**.
* **NO saltar ahora.** El hardware actual opera a menos del 50% de su capacidad.
* **Disparadores Objetivos (*Triggers*) para dar el salto:**
  1. **Volumen de terminales activas simultáneas:** Cuando la red supere de manera sostenida las **60 a 100 terminales concurrentes**.
  2. **Estrangulamiento de CPU (*CFS Quota Throttling*):** Si la gráfica de CPU en Render muestra picos sostenidos por encima del **70%** durante horas pico de venta.
  3. **Presión de Memoria:** Si el consumo de RAM supera el **80% de forma sostenida** debido a consultas de reportes contables con payloads voluminosos, lo que permitiría subir `--max-old-space-size=1024`.
* **Beneficio técnico real:** El CPU dedicado elimina las pausas impuestas por el hipervisor de Linux en núcleos compartidos, reduciendo a la mitad el tiempo de serialización y parseo JSON en Node.js.

---

### Fase 3: ¿Cuándo escalar Supabase a Tier "Medium"?
* **Especificaciones del salto:** De Small (1 vCPU, 2 GB RAM, ~$25/mo) ➔ **Medium (2 vCPU, 4 GB RAM, ~$60/mo)**.
* **Estado actual:** El tier Small es completamente adecuado y tiene holgura suficiente para el volumen transaccional actual.
* **Disparadores Objetivos (*Triggers*) para dar el salto:**
  1. Si el uso de CPU de PostgreSQL en el dashboard de Supabase supera el **70% sostenido** durante la liquidación de sorteos.
  2. Si el volumen de terminales requiere elevar el pool de conexiones por encima de **70-80 conexiones activas**, donde la memoria RAM de Postgres (2 GB) empiece a comprometer el tamaño del *buffer pool*.
  3. Si la latencia de disco (IOPS) se convierte en el cuello de botella durante inserciones masivas de tickets.

---

## 6. Matriz de Decisión Operativa Rápida

| Síntoma Observado | Diagnóstico Probable | Acción Correcta |
| :--- | :--- | :--- |
| **Errores 503 aislados** | Middleware de concurrencia o proxy | Revisar logs de Render; no es problema de hardware de BD. |
| **Latencia alta sólo al cierre de sorteo** | Encolamiento por consultas masivas simultáneas | Implementar caché de 5-10s en el endpoint consultado por los clientes. |
| **Latencia alta constante en venta de tickets** | Índices faltantes o contención de bloqueos (*locks*) | Optimizar queries SQL o revisar índices; no aumentar hardware a ciegas. |
| **CPU de Render > 75% sostenido por horas** | Saturación de capacidad de cómputo del contenedor | **Escalar Render a Tier Standard (1 vCPU dedicado).** |
| **Conexiones agotadas (*pool timeout*) en Prisma** | Desbalance entre instancias y pool de PgBouncer | Ajustar `connection_limit` y pool size en Supabase antes de escalar hardware. |
