import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { pool } from "../src/db";
import * as events from "../src/events";
import { World, as, eventKinds, insertItem, itemRow, makeWorld, resetDb } from "./helpers";

let w: World;
beforeEach(async () => {
  await resetDb();
  w = await makeWorld();
});
afterAll(() => pool.end());

const move = (who: string, id: number, to: string, version?: number) =>
  as(w, who).post(`/api/items/${id}/transition`, version ? { to, version } : { to });

describe("workflow rules", () => {
  it("walks the full happy path and records every step in the activity log", async () => {
    const id = await insertItem(w, { status: "open" });
    expect((await as(w, "carol").post(`/api/items/${id}/claim`)).status).toBe(200);
    expect((await move("carol", id, "in_progress")).status).toBe(200);
    expect((await move("carol", id, "awaiting_approval")).status).toBe(200);
    expect((await move("alice", id, "resolved")).status).toBe(200);
    const closed = await move("alice", id, "closed");
    expect(closed.status).toBe(200);
    expect(closed.body.status).toBe("closed");
    expect(closed.body.version).toBe(6);

    expect(await eventKinds(id)).toEqual(["created", "assigned", "status_changed", "status_changed", "status_changed", "status_changed"]);
    const last = (await pool.query("SELECT data FROM activity_events WHERE item_id=$1 ORDER BY id DESC LIMIT 1", [id])).rows[0];
    expect(last.data).toEqual({ from: "resolved", to: "closed" });
  });

  it("rejects invalid jumps (open -> closed, closed -> anything)", async () => {
    const id = await insertItem(w, { status: "open", assignee: "carol" });
    const jump = await move("alice", id, "closed");
    expect(jump.status).toBe(409);
    expect(jump.body.code).toBe("invalid_transition");
    expect((await itemRow(id)).status).toBe("open");

    const done = await insertItem(w, { status: "closed" });
    expect((await move("alice", done, "open")).status).toBe(409);
  });

  it("only a Lead of the team can pass the approval step", async () => {
    const id = await insertItem(w, { status: "awaiting_approval", assignee: "carol" });
    const byMember = await move("dave", id, "resolved");
    expect(byMember.status).toBe(403);
    expect(byMember.body.code).toBe("approval_requires_lead");
    const byAssignee = await move("carol", id, "resolved");
    expect(byAssignee.status).toBe(403);
    expect((await itemRow(id)).status).toBe("awaiting_approval");

    expect((await move("alice", id, "resolved")).status).toBe(200);
  });

  it("applies the four-eyes rule: a Lead cannot approve their own item, an Admin can", async () => {
    const id = await insertItem(w, { status: "awaiting_approval", assignee: "alice" });
    const self = await move("alice", id, "resolved");
    expect(self.status).toBe(403);
    expect(self.body.code).toBe("self_approval");
    expect((await move("bob", id, "resolved")).status).toBe(200);

    const id2 = await insertItem(w, { status: "awaiting_approval", assignee: "admin" });
    expect((await move("admin", id2, "resolved")).status).toBe(200);
  });

  it("lets a Member move only items assigned to them", async () => {
    const id = await insertItem(w, { status: "open", assignee: "carol" });
    const other = await move("dave", id, "in_progress");
    expect(other.status).toBe(403);
    expect(other.body.code).toBe("not_assignee");
    expect((await move("carol", id, "in_progress")).status).toBe(200);
  });

  it("will not start work on an unassigned item", async () => {
    const id = await insertItem(w, { status: "open", assignee: null });
    const r = await move("alice", id, "in_progress");
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("assignee_required");
  });

  it("checks the version when the client sends one", async () => {
    const id = await insertItem(w, { status: "open", assignee: "carol" });
    const r = await move("carol", id, "in_progress", 99);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("version_conflict");
  });

  it("tells the UI which transitions this user may perform", async () => {
    const id = await insertItem(w, { status: "awaiting_approval", assignee: "carol" });
    expect((await as(w, "alice").get(`/api/items/${id}`)).body.permissions.transitions).toEqual(["resolved", "in_progress"]);
    expect((await as(w, "carol").get(`/api/items/${id}`)).body.permissions.transitions).toEqual([]);
  });
});

describe("history is written in the same transaction as the change", () => {
  it("rolls the whole change back if writing the activity event fails", async () => {
    const id = await insertItem(w, { status: "open", assignee: "carol" });
    const spy = vi.spyOn(events, "logEvent").mockRejectedValue(new Error("boom"));
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {}); // the 500 is expected here
    try {
      const r = await move("carol", id, "in_progress");
      expect(r.status).toBe(500);
    } finally {
      spy.mockRestore();
      quiet.mockRestore();
    }
    const row = await itemRow(id);
    expect(row.status).toBe("open"); // the status UPDATE was rolled back with the failed event insert
    expect(row.version).toBe(1);
    expect(await eventKinds(id)).toEqual(["created"]);
  });

  it("makes the activity log append-only at the database level", async () => {
    const id = await insertItem(w);
    await expect(pool.query("UPDATE activity_events SET kind = 'x' WHERE item_id = $1", [id])).rejects.toThrow(/append-only/);
    await expect(pool.query("DELETE FROM activity_events WHERE item_id = $1", [id])).rejects.toThrow(/append-only/);
  });
});
