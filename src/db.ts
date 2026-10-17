import { Pool, PoolClient, QueryResult, types } from "pg";
import { config } from "./config";

// BIGINT (int8) -> number, DATE -> 'YYYY-MM-DD' string (no timezone surprises).
types.setTypeParser(20, (v) => parseInt(v, 10));
types.setTypeParser(1082, (v) => v);

export const pool = new Pool({ ...config.db, max: 20 });

/** Anything we can run SQL on: the pool itself or a client inside a transaction. */
export interface Db {
  query(text: string, params?: unknown[]): Promise<QueryResult<any>>;
}

/** Run fn inside one transaction (READ COMMITTED). Commit on success, roll back on any throw. */
export async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* connection may already be broken; nothing more to do */
    }
    throw err;
  } finally {
    client.release();
  }
}
