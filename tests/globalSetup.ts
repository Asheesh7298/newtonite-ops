import { Client } from "pg";

/** Creates the ops_test database if needed and applies migrations once before all test files. */
export default async function setup() {
  process.env.POSTGRES_DB = "ops_test";
  const { config } = await import("../src/config");
  const admin = new Client({ ...config.db, database: "postgres" });
  await admin.connect();
  const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = 'ops_test'");
  if (exists.rowCount === 0) await admin.query("CREATE DATABASE ops_test");
  await admin.end();

  const { migrate } = await import("../src/migrate");
  const { pool } = await import("../src/db");
  await migrate();
  await pool.end();
}
