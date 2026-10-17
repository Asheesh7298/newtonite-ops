import { PoolClient } from "pg";
import { Db, tx } from "./db";

export type JobHandler = (payload: any, db: Db) => Promise<void>;

/** Write a job row. Call it with the same client as the business change (transactional outbox). */
export async function enqueue(db: Db, kind: string, payload: Record<string, unknown>): Promise<void> {
  await db.query("INSERT INTO outbox (kind, payload) VALUES ($1, $2)", [kind, JSON.stringify(payload)]);
}

/**
 * Handlers are idempotent: the job may run more than once (at-least-once delivery),
 * so every side effect is guarded by a unique dedupe key.
 */
export const handlers: Record<string, JobHandler> = {
  async notify_assignee(p, db) {
    const { rows } = await db.query("SELECT title FROM work_items WHERE id = $1", [p.item_id]);
    await db.query(
      `INSERT INTO notifications (user_id, item_id, message, dedupe_key)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [p.assignee_id, p.item_id, `${p.by} assigned you: ${rows[0]?.title ?? "an item"}`, `assigned:${p.event_id}`],
    );
  },
};

/**
 * Process due jobs. Rows are locked with FOR UPDATE SKIP LOCKED so several workers never take the same job.
 * Each job runs in a savepoint: a failing handler rolls back only its own work, then the job is rescheduled
 * with exponential backoff, or marked 'failed' once max_attempts is reached.
 * If the worker process dies mid-batch, the transaction rolls back and the jobs simply become due again.
 */
export async function processBatch(opts: { limit?: number; now?: Date } = {}): Promise<number> {
  const limit = opts.limit ?? 20;
  const now = opts.now ?? new Date();
  return tx(async (c: PoolClient) => {
    const { rows: jobs } = await c.query(
      `SELECT * FROM outbox WHERE status = 'pending' AND next_attempt_at <= $1
       ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED`,
      [now, limit],
    );
    for (const job of jobs) {
      await c.query("SAVEPOINT job");
      try {
        const handler = handlers[job.kind];
        if (!handler) throw new Error(`no handler for job kind '${job.kind}'`);
        await handler(job.payload, c);
        await c.query("RELEASE SAVEPOINT job");
        await c.query("UPDATE outbox SET status = 'done', processed_at = now() WHERE id = $1", [job.id]);
      } catch (err) {
        await c.query("ROLLBACK TO SAVEPOINT job");
        const attempts = job.attempts + 1;
        const failed = attempts >= job.max_attempts;
        const backoffSeconds = 2 ** attempts;
        await c.query(
          `UPDATE outbox SET attempts = $2, last_error = $3, status = $4,
                  next_attempt_at = $5 WHERE id = $1`,
          [
            job.id,
            attempts,
            String((err as Error).message ?? err).slice(0, 500),
            failed ? "failed" : "pending",
            new Date(now.getTime() + backoffSeconds * 1000),
          ],
        );
      }
    }
    return jobs.length;
  });
}
