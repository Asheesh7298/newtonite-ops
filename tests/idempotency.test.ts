import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/db";
import { World, as, makeWorld, resetDb } from "./helpers";

let w: World;
beforeEach(async () => {
  await resetDb();
  w = await makeWorld();
});
afterAll(() => pool.end());

const count = async () => (await pool.query("SELECT count(*)::int AS n FROM work_items")).rows[0].n as number;
const payload = () => ({ title: "Settlement mismatch", type: "payment", priority: "high", team_id: w.teams.payments });

describe("idempotency keys", () => {
  it("creates one item and replays the same response for a repeated key", async () => {
    const first = await as(w, "carol").post("/api/items", payload(), "key-1");
    const second = await as(w, "carol").post("/api/items", payload(), "key-1");
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(second.headers["idempotent-replayed"]).toBe("true");
    expect(first.headers["idempotent-replayed"]).toBeUndefined();
    expect(await count()).toBe(1);
  });

  it("creates one item when the same key is sent concurrently (double click)", async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => as(w, "carol").post("/api/items", payload(), "double-click")));
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(await count()).toBe(1);
    expect((await pool.query("SELECT count(*)::int AS n FROM activity_events")).rows[0].n).toBe(1);
  });

  it("rejects the same key reused for a different request", async () => {
    await as(w, "carol").post("/api/items", payload(), "key-2");
    const reuse = await as(w, "carol").post("/api/items", { ...payload(), title: "Something else" }, "key-2");
    expect(reuse.status).toBe(422);
    expect(reuse.body.code).toBe("idempotency_key_reuse");
    expect(await count()).toBe(1);
  });

  it("does not store failed requests, so a retry after fixing the cause works", async () => {
    // erin is a viewer: forbidden to create
    const denied = await as(w, "erin").post("/api/items", payload(), "key-3");
    expect(denied.status).toBe(403);
    expect((await pool.query("SELECT count(*)::int AS n FROM idempotency_keys")).rows[0].n).toBe(0);
    const ok = await as(w, "carol").post("/api/items", payload(), "key-3"); // keys are per user
    expect(ok.status).toBe(201);
  });

  it("scopes keys per user", async () => {
    const a = await as(w, "carol").post("/api/items", payload(), "shared-key");
    const b = await as(w, "dave").post("/api/items", payload(), "shared-key");
    expect(a.body.id).not.toBe(b.body.id);
    expect(await count()).toBe(2);
  });
});
