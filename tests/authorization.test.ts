import { afterAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { pool } from "../src/db";
import { app, World, as, insertItem, itemRow, makeWorld, resetDb } from "./helpers";

let w: World;
beforeEach(async () => {
  await resetDb();
  w = await makeWorld();
});
afterAll(() => pool.end());

describe("authentication", () => {
  it("rejects missing and bad tokens with 401", async () => {
    expect((await request(app).get("/api/items")).status).toBe(401);
    expect((await request(app).get("/api/items").set("Authorization", "Bearer nope")).status).toBe(401);
  });

  it("logs in with username and password", async () => {
    const hash = (await pool.query("SELECT password_hash FROM users WHERE username='carol'")).rows[0].password_hash;
    expect(hash).toContain(":");
    const bad = await request(app).post("/api/auth/login").send({ username: "carol", password: "wrong" });
    expect(bad.status).toBe(401);
    const ok = await request(app).post("/api/auth/login").send({ username: "carol", password: "pw" });
    expect(ok.status).toBe(200);
    const me = await request(app).get("/api/me").set("Authorization", `Bearer ${ok.body.token}`);
    expect(me.body.memberships[0].role).toBe("member");
  });
});

describe("resource-level authorization (enforced on the server)", () => {
  it("hides items of other teams: read and every write return 404", async () => {
    const id = await insertItem(w, { team: "payments", status: "open" });
    const ivan = as(w, "ivan"); // member of 'support' only
    expect((await ivan.get(`/api/items/${id}`)).status).toBe(404);
    expect((await ivan.get(`/api/items/${id}/activity`)).status).toBe(404);
    expect((await ivan.patch(`/api/items/${id}`, { version: 1, title: "hacked" })).status).toBe(404);
    expect((await ivan.post(`/api/items/${id}/claim`)).status).toBe(404);
    expect((await ivan.post(`/api/items/${id}/comments`, { text: "hi" })).status).toBe(404);
    expect((await ivan.post(`/api/items/${id}/assign`, { assignee_id: w.users.ivan.id, version: 1 })).status).toBe(404);
    expect((await ivan.post(`/api/items/${id}/transition`, { to: "in_progress" })).status).toBe(404);
    expect((await ivan.get(`/api/teams/${w.teams.payments}/members`)).status).toBe(404);

    const row = await itemRow(id);
    expect(row.version).toBe(1);
    expect(row.assignee_id).toBeNull();
    expect(row.title).toBe("Test item");
  });

  it("returns 403 when creating an item in a team you do not belong to", async () => {
    const r = await as(w, "ivan").post("/api/items", { title: "x", type: "task", team_id: w.teams.payments });
    expect(r.status).toBe(403);
  });

  it("scopes lists to the caller's teams", async () => {
    await insertItem(w, { team: "payments", title: "Payments item" });
    await insertItem(w, { team: "support", title: "Support item" });
    const carol = await as(w, "carol").get("/api/items");
    expect(carol.body.items.map((i: any) => i.title)).toEqual(["Payments item"]);
    const ivan = await as(w, "ivan").get("/api/items");
    expect(ivan.body.items.map((i: any) => i.title)).toEqual(["Support item"]);
    // even an explicit filter for another team's id cannot widen the scope
    const sneaky = await as(w, "ivan").get(`/api/items?team_id=${w.teams.payments}`);
    expect(sneaky.body.items).toEqual([]);
  });

  it("lets a Viewer read but not write", async () => {
    const id = await insertItem(w, { status: "open" });
    const erin = as(w, "erin");
    expect((await erin.get(`/api/items/${id}`)).status).toBe(200);
    expect((await erin.patch(`/api/items/${id}`, { version: 1, title: "x" })).status).toBe(403);
    expect((await erin.post(`/api/items/${id}/claim`)).status).toBe(403);
    expect((await erin.post(`/api/items/${id}/comments`, { text: "x" })).status).toBe(403);
    expect((await erin.post(`/api/items`, { title: "x", type: "task", team_id: w.teams.payments })).status).toBe(403);
    expect((await itemRow(id)).version).toBe(1);
  });

  it("lets only Leads assign work, and only to team staff", async () => {
    const id = await insertItem(w, { status: "open" });
    expect((await as(w, "carol").post(`/api/items/${id}/assign`, { assignee_id: w.users.dave.id, version: 1 })).status).toBe(403);
    expect((await as(w, "alice").post(`/api/items/${id}/assign`, { assignee_id: w.users.ivan.id, version: 1 })).status).toBe(400); // not in team
    expect((await as(w, "alice").post(`/api/items/${id}/assign`, { assignee_id: w.users.erin.id, version: 1 })).status).toBe(400); // viewer
    const ok = await as(w, "alice").post(`/api/items/${id}/assign`, { assignee_id: w.users.dave.id, version: 1 });
    expect(ok.status).toBe(200);
    expect(ok.body.assignee.username).toBe("dave");
  });

  it("validates input", async () => {
    const r = await as(w, "carol").post("/api/items", { title: "", type: "nope", team_id: w.teams.payments });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("validation_error");
  });
});
