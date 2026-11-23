const path = require('node:path');
const { spawnSync } = require('node:child_process');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const args = process.argv.slice(2);
if (!args.length) {
  throw new Error('Indica un comando de Supabase CLI.');
}

if (args.includes('--remote') && ['db', 'migration'].includes(args[0]) &&
    (!process.env.SUPABASE_DB_PASSWORD ||
     process.env.SUPABASE_DB_PASSWORD.startsWith('replace_'))) {
  throw new Error('Configura un valor real de SUPABASE_DB_PASSWORD en el archivo .env local.');
}

const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const result = spawnSync(command, ['supabase', ...args], {
  stdio: 'inherit',
  shell: process.platform === 'win32'
});

if (result.error) throw result.error;
process.exit(typeof result.status === 'number' ? result.status : 1);
