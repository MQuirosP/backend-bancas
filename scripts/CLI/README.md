# Suite de Soporte Técnico y Operaciones CLI

Esta carpeta contiene la suite oficial de herramientas interactivas de consola para el equipo de desarrollo, soporte técnico y mantenimiento en producción (Render Shell / GitHub).

---

## 🚀 Punto de Entrada Principal (Orquestador)

En el Shell SSH de Render o en consola local:

```bash
npx tsx scripts/CLI/main-wizard.ts
```

---

## 🛠️ Módulos Disponibles

### 1. 🎰 Operaciones sobre Sorteos (`sorteos-cli.ts`)
* Permite filtrar por **Fecha**, **Banca Multi-Tenant** y **Lotería**.
* Muestra la lista limpia de sorteos con sus IDs y multiplicadores reventados disponibles.
* Permite **Evaluar**, **Revertir** o **Cerrar** sorteos interactivamente omitiendo el límite REST web de 7 días.

### 2. 📊 Auditoría y Chequeo de Saldos (`check-statements-cli.ts`)
* Chequeo 100% solo lectura de integridad de `AccountStatement` por **Banca** y **Rango de Fechas**.
* Silencia logs de depuración ruidosos y muestra un resumen ejecutivo por **Vendedores**, **Ventanas** y **Bancas** (`✅ OK` / `⚠️ FAIL`).

### 3. 🔧 Corrección y Re-Sincronización de Saldos (`fix-statements-cli.ts`)
* Recalcula y sincroniza estados de cuenta de forma segura por **Banca** y **Rango de Fechas**.
* Aplica la propagación día a día hasta la fecha actual.

### 4. 📈 Auditoría de Cierres Diarios (`check-cierres-cli.ts`)
* Auditoría 100% solo lectura de `ResumenCierreDiario` comparado contra tickets y jugadas reales evaluadas en vivo.
* Permite filtrar por **Banca** y **Rango de Fechas**.

---

## 📌 Guía de Uso Directo por Comando

Si se prefiere ejecutar un módulo directamente sin pasar por el menú principal:

```bash
# Sorteos:
npx tsx scripts/CLI/sorteos-cli.ts

# Chequeo de Saldos por Fecha/Banca:
npx tsx scripts/CLI/check-statements-cli.ts

# Corrección de Saldos:
npx tsx scripts/CLI/fix-statements-cli.ts

# Chequeo de Cierres Diarios:
npx tsx scripts/CLI/check-cierres-cli.ts
```
