import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";

const { Client } = pg;
const connectionString =
  process.env.HOST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://reddwarf:reddwarf@127.0.0.1:55432/reddwarf";

const migrationsDir = resolve(process.cwd(), "packages/evidence/drizzle");

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS reddwarf_schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function getPendingMigrationFiles(client) {
  const files = (await readdir(migrationsDir))
    .filter((name) => name.endsWith(".sql"))
    .sort((left, right) => left.localeCompare(right));

  const appliedResult = await client.query("SELECT filename FROM reddwarf_schema_migrations");
  const applied = new Set(appliedResult.rows.map((row) => row.filename));

  return files.filter((file) => !applied.has(file));
}

async function applyMigration(client, filename) {
  const sql = await readFile(resolve(migrationsDir, filename), "utf8");

  await client.query("BEGIN");

  try {
    await client.query(sql);
    await client.query("INSERT INTO reddwarf_schema_migrations (filename) VALUES ($1)", [filename]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function main() {
  const client = new Client({ connectionString });
  await client.connect();

  try {
    await ensureMigrationsTable(client);
    const pending = await getPendingMigrationFiles(client);

    for (const filename of pending) {
      await applyMigration(client, filename);
    }

    console.log(`Applied ${pending.length} migration(s).`);
  } finally {
    await client.end();
  }
}

await main();
