import fs from "fs";
import path from "path";
import { pool } from "./db";

/** Minimal migration runner: applies migrations/*.sql in order, once each. */
export async function migrate(): Promise<void> {
  const dir = path.resolve(__dirname, "../migrations");
  const client = await pool.connect();
  try {
    // Advisory lock so two processes starting at once don't both run migrations.
    await client.query("SELECT pg_advisory_lock(727001)");
    try {
      await client.query(
        "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())",
      );
      const done = new Set((await client.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
      for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
        if (done.has(file)) continue;
        await client.query("BEGIN");
        try {
          await client.query(fs.readFileSync(path.join(dir, file), "utf8"));
          await client.query("INSERT INTO schema_migrations(name) VALUES ($1)", [file]);
          await client.query("COMMIT");
          console.log(`applied ${file}`);
        } catch (e) {
          await client.query("ROLLBACK");
          throw e;
        }
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock(727001)");
    }
  } finally {
    client.release();
  }
}

if (require.main === module) {
  migrate()
    .then(() => pool.end())
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
