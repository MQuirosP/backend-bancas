# 🚀 Guía de Escalado de Arquitectura (Bancas)

Esta guía define exactamente cuándo y cómo escalar tu infraestructura (Render + Supabase) basándose en métricas reales, para garantizar el máximo rendimiento al menor costo.

---

## 🟢 Etapa 0: Estado Actual (Talla Óptima)
*Tu configuración actual es la mejor relación costo-beneficio para arrancar y crecer.*

- **Render (Node.js):** Plan 512 MB RAM
- **Supabase (PostgreSQL):** Tier Small (2 vCPU, 2GB RAM)
- **Variables Óptimas:**
  - `MAX_CONCURRENT_REQUESTS = 35` (Render)
  - `--max-old-space-size=200` (`package.json`)
  - `connection_limit = 25` (Supabase URL)

**✅ Síntomas de Salud:** 
Memoria de Render plana en ~360 MB. CPU de Supabase por debajo del 10%. Soporta cientos de ventas estables por minuto.

---

## 🟡 Etapa 1: El Límite de la RAM (Escalando Render)
*Tu negocio crece. Muchos vendedores se quejan de que el botón de vender les dice "Error de conexión" o "Servidor ocupado" (Error 503) durante los 5 minutos antes del sorteo.*

**El Problema:** Estás rebotando mucho tráfico válido porque tu límite de 35 es muy estricto para la nueva demanda.
**La Solución:** Hay que aprovechar la CPU "dormida" de Supabase, pero Node.js necesita más RAM para sostener más peticiones.

**Acciones (Qué comprar y cambiar):**
1. **Pagar en Render:** Sube tu plan a **1 GB de RAM**. (Mantienes Supabase en Small).
2. **Ajustar Código (`package.json`):** Cambia a `"start": "node --max-old-space-size=600 dist/index.js"`.
3. **Ajustar Dashboard Supabase:** Entra a "Connection pooling" y sube el "Connection pool size" de 25 a **50**.
4. **Ajustar Variables (Render `.env`):**
   - Cambia la URL de Prisma a: `connection_limit=50`
   - Cambia `MAX_CONCURRENT_REQUESTS = 65`

**✅ Síntomas de Éxito Post-Ajuste:**
Render usará unos ~700 MB de RAM. La CPU de Supabase despertará y operará entre el 30% y 50%. Cero errores 503 para los vendedores.

---

## 🟠 Etapa 2: El Límite de la CPU (Escalando la Base de Datos)
*Meses después, eres el líder del mercado. Has ajustado las variables hasta llevar el pool a 75 u 80 conexiones. Empiezas a notar que las ventas tardan mucho (2 o 3 segundos en lugar de milisegundos).*

**El Problema:** Render va sobrado de RAM, pero si miras la métrica de Supabase, verás que la **CPU se mantiene en 85% - 95%** durante los cierres de sorteo. El Tier Small ya no da para más.
**La Solución:** Necesitas más fuerza bruta de procesamiento de base de datos.

**Acciones (Qué comprar y cambiar):**
1. **Pagar en Supabase:** Sube tu plan a **Tier Medium** (Más CPU y 4GB de RAM).
2. **Ajustar Dashboard Supabase:** Sube el "Connection pool size" de 75 a **120**.
3. **Ajustar Variables (Render `.env`):**
   - Cambia la URL de Prisma a: `connection_limit=120`
   - Cambia `MAX_CONCURRENT_REQUESTS = 140`

*(Opcional: Si Render supera 1 GB de RAM al manejar 140 conexiones, deberás subir a 2 GB en Render).*

---

## 🔴 Etapa 3: Ultra Escala (Tier Large y Redis)
*Estás manejando tráfico de nivel nacional constante.*

**Indicadores:** CPU de Tier Medium superando el 80%.
**Solución:** Escalar Supabase a Tier Large. Sin embargo, en esta etapa es mejor invertir en **Software antes que Hardware**:
1. Habilitar **Redis** para almacenar en caché las consultas pesadas de lectura (ej. estado de loterías y límites) para que Prisma no golpee a Postgres en transacciones de solo lectura.
2. Dividir la infraestructura: Un contenedor en Render solo para Lecturas (Consultas) y otro solo para Escrituras (Ventas).

---

> [!TIP]
> **Tu Regla de Arquitectura para el Futuro:**
> Siempre revisa la CPU de Supabase antes de sacar la billetera. Si la CPU está baja, necesitas RAM en Render. Si la CPU está alta, necesitas escalar Supabase.
