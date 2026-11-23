require('dotenv').config();
delete process.env.SUPABASE_DB_PASSWORD;
const crypto = require('node:crypto');
const { migrate, openDatabase, seed } = require('./db');
const { createApp } = require('./app');
const { createSupabaseClient } = require('./supabase-client');

const dataBackend = process.env.DATA_BACKEND || 'sqlite';
if (!['sqlite', 'supabase'].includes(dataBackend)) {
  throw new Error('DATA_BACKEND debe ser sqlite o supabase.');
}
const supabaseMode = dataBackend === 'supabase';
if (supabaseMode) createSupabaseClient();
const db = openDatabase();
migrate(db);
if (!supabaseMode) seed(db);
if (!process.env.SESSION_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('SESSION_SECRET es obligatorio en producción.');
  }
  process.env.SESSION_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('SESSION_SECRET no está configurado; se generó uno temporal para esta ejecución local.');
}
const app = createApp({ db, supabaseMode });
const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || '127.0.0.1';
const server = app.listen(port, host, () => {
  console.log(`BurgerFlow disponible en http://${host}:${port}`);
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
