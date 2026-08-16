import { config } from 'dotenv';
import { resolve } from 'path';
// Load .env from monorepo root regardless of cwd
config({ path: resolve(__dirname, '..', '..', '..', '..', '.env') });

import { getPool } from '../client';
import { readFileSync } from 'fs';
import { join } from 'path';

async function runMigrations(): Promise<void> {
  const pool = getPool();
  const migrationsDir = join(__dirname, '..', '..', 'migrations');
  const files = ['001_init.sql', '002_fix_vector_dim.sql'];
  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    await pool.query(sql);
    console.log(`✓ ${file}`);
  }
  console.log('✓ All migrations applied');
  await pool.end();
}

runMigrations().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
