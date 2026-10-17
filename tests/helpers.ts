import crypto from "crypto";
import request from "supertest";
import { createApp } from "../src/app";
import { hashPassword } from "../src/auth";
import { pool } from "../src/db";

export const app = createApp();
const PASSWORD_HASH = hashPassword("pw");

export type TeamName = "payments" | "support";
export interface World {
  teams: Record<TeamName, number>;
  users: Record<string, { id: number; username: string; token: string }>;
}

export async function resetDb() {
  await pool.query(
    `TRUNCATE notifications, outbox, idempotency_keys, activity_events, work_items, tokens, memberships, users, teams RESTART IDENTITY CASCADE`,
  );
}

/**
 * payments team: alice (lead), bob (lead), carol (member), dave (member), erin (viewer), admin (admin)
 * support team : ivan (member)  <- has no access to payments at all
 */
export async function makeWorld(): Promise<World> {
  const teams = {} as World["teams"];
  for (const name of ["payments", "support"] as TeamName[]) {
    teams[name] = (await pool.query("INSERT INTO teams (name) VALUES ($1) RETURNING id", [name])).rows[0].id;
  }
  const spec: Record<string, [TeamName, string][]> = {
    alice: [["payments", "lead"]],
    bob: [["payments", "lead"]],
    carol: [["payments", "member"]],
    dave: [["payments", "member"]],
    erin: [["payments", "viewer"]],
    admin: [["payments", "admin"]],
    ivan: [["support", "member"]],
  };
  const users: World["users"] = {};
  for (const [username, memberships] of Object.entries(spec)) {
    const id = (await pool.query("INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id", [username, PASSWORD_HASH])).rows[0].id;
    const token = crypto.randomBytes(16).toString("hex");
    await pool.query("INSERT INTO tokens (token, user_id) VALUES ($1, $2)", [token, id]);
    for (const [team, role] of memberships) {
      await pool.query("INSERT INTO memberships (user_id, team_id, role) VALUES ($1, $2, $3)", [id, teams[team], role]);
    }
    users[username] = { id, username, token };
  }
  return { teams, users };
}

/** Tiny supertest wrapper bound to one user's token. */
export function as(w: World, name: string) {
  const auth = `Bearer ${w.users[name].token}`;
  return {
    get: (path: string) => request(app).get(path).set("Authorization", auth),
    post: (path: string, body?: object, key?: string) => {
      const r = request(app).post(path).set("Authorization", auth);
      if (key) r.set("Idempotency-Key", key);
      return r.send(body ?? {});
    },
    patch: (path: string, body: object, key?: string) => {
      const r = request(app).patch(path).set("Authorization", auth);
      if (key) r.set("Idempotency-Key", key);
      return r.send(body);
    },
  };
}

export async function insertItem(
  w: World,
  o: { team?: TeamName; status?: string; assignee?: string | null; priority?: string; createdBy?: string; title?: string } = {},
): Promise<number> {
  const status = o.status ?? "open";
  const assignee = o.assignee === undefined ? (status === "open" ? null : "carol") : o.assignee;
  const { rows } = await pool.query(
    `INSERT INTO work_items (title, type, priority, status, team_id, assignee_id, created_by)
     VALUES ($1, 'task', $2, $3, $4, $5, $6) RETURNING id`,
    [o.title ?? "Test item", o.priority ?? "medium", status, w.teams[o.team ?? "payments"], assignee ? w.users[assignee].id : null, w.users[o.createdBy ?? "alice"].id],
  );
  await pool.query(`INSERT INTO activity_events (item_id, actor_id, kind) VALUES ($1, $2, 'created')`, [rows[0].id, w.users[o.createdBy ?? "alice"].id]);
  return rows[0].id;
}

export const itemRow = async (id: number) => (await pool.query("SELECT * FROM work_items WHERE id = $1", [id])).rows[0];
export const eventKinds = async (id: number) =>
  (await pool.query("SELECT kind FROM activity_events WHERE item_id = $1 ORDER BY id", [id])).rows.map((r) => r.kind as string);
