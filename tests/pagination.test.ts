import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/db";
import { World, as, insertItem, makeWorld, resetDb } from "./helpers";

let w: World;
beforeEach(async () => {
  await resetDb();
  w = await makeWorld();
  // 130 payments items: every 3rd in_progress+assigned, rest open+unassigned; priorities rotate
  await pool.query(
    `INSERT INTO work_items (title, type, priority, status, team_id, assignee_id, created_by)
     SELECT 'Item ' || g, 'task', (ARRAY['low','medium','high','urgent'])[1 + g % 4],
            CASE WHEN g % 3 = 0 THEN 'in_progress' ELSE 'open' END, $1,
            CASE WHEN g % 3 = 0 THEN $2::int ELSE NULL END, $3
     FROM generate_series(1, 130) g`,
    [w.teams.payments, w.users.carol.id, w.users.alice.id],
  );
  for (let i = 0; i < 5; i++) await insertItem(w, { team: "support", title: `Support ${i}`, createdBy: "ivan" });
});
afterAll(() => pool.end());

async function walk(who: string, query = "", limit = 25) {
  const seen: number[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const r: any = await as(w, who).get(`/api/items?limit=${limit}${query}${cursor ? `&cursor=${cursor}` : ""}`);
    expect(r.status).toBe(200);
    seen.push(...r.body.items.map((i: any) => i.id));
    cursor = r.body.next_cursor;
    pages++;
  } while (cursor);
  return { seen, pages };
}

describe("server-side pagination and filtering", () => {
  it("pages through every item exactly once, newest first", async () => {
    const { seen, pages } = await walk("carol");
    expect(seen).toHaveLength(130);
    expect(new Set(seen).size).toBe(130);
    expect(pages).toBe(6);
    expect([...seen].sort((a, b) => b - a)).toEqual(seen);
  });

  it("stays consistent when new items arrive between pages (keyset cursor)", async () => {
    const first: any = await as(w, "carol").get("/api/items?limit=50");
    await insertItem(w, { title: "Arrived mid-scroll" });
    const second: any = await as(w, "carol").get(`/api/items?limit=50&cursor=${first.body.next_cursor}`);
    const ids = [...first.body.items, ...second.body.items].map((i: any) => i.id);
    expect(new Set(ids).size).toBe(100); // no duplicates, nothing skipped
  });

  it("caps the page size", async () => {
    const r = await as(w, "carol").get("/api/items?limit=100000");
    expect(r.body.items).toHaveLength(100);
    expect((await as(w, "carol").get("/api/items?limit=0")).status).toBe(400);
    expect((await as(w, "carol").get("/api/items?cursor=garbage")).status).toBe(400);
  });

  it("filters on the server", async () => {
    const inProgress = await walk("carol", "&status=in_progress");
    expect(inProgress.seen).toHaveLength(43);
    const urgent = await as(w, "carol").get("/api/items?priority=urgent&limit=100");
    expect(urgent.body.items.every((i: any) => i.priority === "urgent")).toBe(true);
    expect((await as(w, "carol").get("/api/items?status=bogus")).status).toBe(400);

    const search = await as(w, "carol").get("/api/items?q=item%2012");
    expect(search.body.items.map((i: any) => i.title).sort()).toEqual(["Item 12", "Item 120", "Item 121", "Item 122", "Item 123", "Item 124", "Item 125", "Item 126", "Item 127", "Item 128", "Item 129"].sort());
    // LIKE wildcards in the search box are treated literally
    expect((await as(w, "carol").get("/api/items?q=%25")).body.items).toHaveLength(0);
  });

  it("builds the dashboard views", async () => {
    const counts = (await as(w, "carol").get("/api/dashboard")).body;
    const expectAssigned = (await pool.query("SELECT count(*)::int n FROM work_items WHERE assignee_id=$1 AND status NOT IN ('resolved','closed')", [w.users.carol.id])).rows[0].n;
    expect(counts.assigned_to_me).toBe(expectAssigned);
    const expectUrgent = (await pool.query("SELECT count(*)::int n FROM work_items WHERE assignee_id IS NULL AND priority='urgent' AND status='open' AND team_id=$1", [w.teams.payments])).rows[0].n;
    expect(counts.unassigned_urgent).toBe(expectUrgent);
    expect(counts.awaiting_my_approval).toBe(0); // carol is a member, not a lead

    await pool.query("UPDATE work_items SET status='awaiting_approval', assignee_id=$1 WHERE id IN (SELECT id FROM work_items WHERE status='open' AND assignee_id IS NULL ORDER BY id LIMIT 3)", [w.users.carol.id]);
    expect((await as(w, "alice").get("/api/dashboard")).body.awaiting_my_approval).toBe(3);
    const list = await as(w, "alice").get("/api/items?view=awaiting_my_approval");
    expect(list.body.items).toHaveLength(3);
    expect((await as(w, "ivan").get("/api/dashboard")).body.unassigned_urgent).toBeGreaterThanOrEqual(0);
  });

  it("uses indexes for the hot queries (explain)", async () => {
    // Make the planner's choice meaningful on a bigger table.
    await pool.query(
      `INSERT INTO work_items (title, type, priority, status, team_id, assignee_id, created_by)
       SELECT 'Bulk ' || g, 'task', 'low', 'closed', $1, $2, $2 FROM generate_series(1, 30000) g`,
      [w.teams.payments, w.users.carol.id],
    );
    await pool.query("ANALYZE work_items");
    const plan = (await pool.query(
      `EXPLAIN SELECT id FROM work_items WHERE team_id = $1 AND status = 'open' ORDER BY id DESC LIMIT 26`, [w.teams.payments],
    )).rows.map((r) => r["QUERY PLAN"]).join("\n");
    expect(plan).toMatch(/Index/);
    expect(plan).not.toMatch(/Seq Scan/);
  });
});
