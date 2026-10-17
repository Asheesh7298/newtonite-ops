import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/db";
import { World, as, eventKinds, insertItem, itemRow, makeWorld, resetDb } from "./helpers";

let w: World;
beforeEach(async () => {
  await resetDb();
  w = await makeWorld();
});
afterAll(() => pool.end());

describe("concurrent claim", () => {
  it("lets exactly one of several simultaneous claimers win (10 rounds)", async () => {
    for (let round = 0; round < 10; round++) {
      const id = await insertItem(w, { status: "open" });
      const claimers = ["alice", "carol", "dave", "admin"];
      const results = await Promise.all(claimers.map((n) => as(w, n).post(`/api/items/${id}/claim`)));

      expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409, 409]);
      const winner = results.find((r) => r.status === 200)!;
      for (const loser of results.filter((r) => r.status === 409)) expect(loser.body.code).toBe("already_claimed");

      const row = await itemRow(id);
      expect(row.assignee_id).toBe(winner.body.assignee.id);
      expect(row.version).toBe(2);
      // exactly one "assigned" event: history agrees with the item
      expect((await eventKinds(id)).filter((k) => k === "assigned")).toHaveLength(1);
    }
  });
});

describe("stale edits (optimistic locking)", () => {
  it("rejects an update that carries an old version and leaves data untouched", async () => {
    const id = await insertItem(w, { status: "open", title: "Original" });
    const first = await as(w, "carol").patch(`/api/items/${id}`, { version: 1, title: "Carol's title" });
    expect(first.status).toBe(200);
    expect(first.body.version).toBe(2);

    const stale = await as(w, "dave").patch(`/api/items/${id}`, { version: 1, title: "Dave's title" });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("version_conflict");
    expect(stale.body.latest.title).toBe("Carol's title");
    expect(stale.body.latest.version).toBe(2);

    const row = await itemRow(id);
    expect(row.title).toBe("Carol's title");
    expect(row.version).toBe(2);
    expect(await eventKinds(id)).toEqual(["created", "edited"]); // Dave's rejected edit left no history
  });

  it("lets only one of two simultaneous edits with the same version win", async () => {
    for (let round = 0; round < 5; round++) {
      const id = await insertItem(w, { status: "open" });
      const [a, b] = await Promise.all([
        as(w, "carol").patch(`/api/items/${id}`, { version: 1, priority: "high" }),
        as(w, "dave").patch(`/api/items/${id}`, { version: 1, priority: "urgent" }),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      const row = await itemRow(id);
      expect(row.version).toBe(2);
      expect((await eventKinds(id)).filter((k) => k === "priority_changed")).toHaveLength(1);
    }
  });
});
