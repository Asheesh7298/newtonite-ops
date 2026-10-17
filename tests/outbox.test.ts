import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/db";
import { handlers, processBatch } from "../src/outbox";
import { World, as, insertItem, makeWorld, resetDb } from "./helpers";

let w: World;
beforeEach(async () => {
  await resetDb();
  w = await makeWorld();
});
afterAll(() => pool.end());

const jobs = async () => (await pool.query("SELECT * FROM outbox ORDER BY id")).rows;
const notifications = async () => (await pool.query("SELECT * FROM notifications")).rows;

describe("transactional outbox", () => {
  it("writes the job in the same transaction as the assignment", async () => {
    const id = await insertItem(w, { status: "open" });
    const stale = await as(w, "alice").post(`/api/items/${id}/assign`, { assignee_id: w.users.carol.id, version: 7 });
    expect(stale.status).toBe(409);
    expect(await jobs()).toHaveLength(0); // failed request -> no job

    const ok = await as(w, "alice").post(`/api/items/${id}/assign`, { assignee_id: w.users.carol.id, version: 1 });
    expect(ok.status).toBe(200);
    const [job] = await jobs();
    expect(job.kind).toBe("notify_assignee");
    expect(job.payload.assignee_id).toBe(w.users.carol.id);
    expect(job.status).toBe("pending");
  });

  it("does not notify when you assign work to yourself", async () => {
    const id = await insertItem(w, { status: "open" });
    await as(w, "alice").post(`/api/items/${id}/assign`, { assignee_id: w.users.alice.id, version: 1 });
    expect(await jobs()).toHaveLength(0);
  });

  it("processes a job once, and processing it twice still yields one notification", async () => {
    const id = await insertItem(w, { status: "open" });
    await as(w, "alice").post(`/api/items/${id}/assign`, { assignee_id: w.users.carol.id, version: 1 });

    expect(await processBatch()).toBe(1);
    expect((await jobs())[0].status).toBe("done");
    expect(await notifications()).toHaveLength(1);

    // simulate at-least-once delivery: the same job runs again
    await pool.query("UPDATE outbox SET status = 'pending'");
    expect(await processBatch()).toBe(1);
    expect(await notifications()).toHaveLength(1);

    const mine = await as(w, "carol").get("/api/notifications");
    expect(mine.body).toHaveLength(1);
    expect(mine.body[0].message).toContain("alice assigned you");
  });

  it("retries a failing job with backoff, then marks it failed after max attempts", async () => {
    const id = await insertItem(w, { status: "open" });
    await as(w, "alice").post(`/api/items/${id}/assign`, { assignee_id: w.users.carol.id, version: 1 });

    const original = handlers.notify_assignee;
    handlers.notify_assignee = async () => {
      throw new Error("smtp down");
    };
    try {
      const t0 = new Date();
      await processBatch({ now: t0 });
      let [job] = await jobs();
      expect(job.attempts).toBe(1);
      expect(job.status).toBe("pending");
      expect(job.last_error).toBe("smtp down");
      expect(new Date(job.next_attempt_at).getTime()).toBeGreaterThan(t0.getTime());

      // not due yet -> not picked up
      expect(await processBatch({ now: t0 })).toBe(0);

      // time travel past each backoff window
      for (let i = 0; i < 4; i++) await processBatch({ now: new Date(Date.now() + 3600_000 * (i + 1)) });
      [job] = await jobs();
      expect(job.attempts).toBe(5);
      expect(job.status).toBe("failed");
      expect(await notifications()).toHaveLength(0);
      // failed jobs are never picked up again
      expect(await processBatch({ now: new Date(Date.now() + 86400_000) })).toBe(0);
    } finally {
      handlers.notify_assignee = original;
    }
  });

  it("recovers: a job that failed once succeeds on retry", async () => {
    const id = await insertItem(w, { status: "open" });
    await as(w, "alice").post(`/api/items/${id}/assign`, { assignee_id: w.users.carol.id, version: 1 });
    const original = handlers.notify_assignee;
    let calls = 0;
    handlers.notify_assignee = async (p, db) => {
      if (++calls === 1) throw new Error("flaky");
      return original(p, db);
    };
    try {
      await processBatch();
      await processBatch({ now: new Date(Date.now() + 60_000) });
      expect((await jobs())[0].status).toBe("done");
      expect(await notifications()).toHaveLength(1);
    } finally {
      handlers.notify_assignee = original;
    }
  });
});
