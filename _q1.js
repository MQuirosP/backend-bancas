const { Client } = require('pg');
const DIRECT_URL = 'postgresql://postgres.xhwxiofujvoaszojcoml:EAnS8hLM4rXZjayd@aws-1-us-east-1.pooler.supabase.com:5432/postgres?connection_limit=3';
async function main() {
  const client = new Client({ connectionString: DIRECT_URL });
  await client.connect();
  console.log('Conectado OK');
  const q = await client.query(SELECT relname AS tabla, n_live_tup AS filas, pg_size_pretty(pg_total_relation_size(c.oid)) AS size FROM pg_class c JOIN pg_stat_user_tables s ON s.relname = c.relname WHERE s.relname IN ('Ticket','Jugada','AccountStatement','AccountPayment','ResumenCierreDiario','Sorteo') ORDER BY n_live_tup DESC);
  for (const r of q.rows) console.log(  :  filas | );
  await client.end();
}
main().catch(e => console.error('ERR:', e.message));
