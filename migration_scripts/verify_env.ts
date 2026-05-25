import * as dotenv from 'dotenv';

dotenv.config();

const dbUrl = process.env.DATABASE_URL;

console.log("\n==========================================");
console.log("🔍  VERIFICACIÓN DE ENTORNO               ");
console.log("==========================================\n");

if (!dbUrl) {
    console.error("❌ ERROR: No se encontró DATABASE_URL en el archivo .env");
    process.exit(1);
}

console.log(`📡 DATABASE_URL actual:`);
console.log(`👉 ${dbUrl}\n`);

if (dbUrl.includes("localhost") || dbUrl.includes("127.0.0.1")) {
    console.log("✅ ESTADO SEGURO: Apuntando a Base de Datos LOCAL.");
    console.log("Puedes continuar con el ensayo o pruebas destructivas (como wipe_db.js).");
} else if (dbUrl.includes("supabase.com") || dbUrl.includes("pooler.supabase")) {
    console.log("⚠️  ¡¡PELIGRO!!: Apuntando a Base de Datos en SUPABASE (Producción).");
    console.log("DETENTE: NO EJECUTES SCRIPTS DESTRUCTIVOS (wipe_db) A MENOS QUE ESTÉS 100% SEGURO.");
} else {
    console.log("⚠️  ESTADO DESCONOCIDO: Apuntando a un host no reconocido.");
}

console.log("\n==========================================\n");
