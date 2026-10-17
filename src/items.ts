import { z } from "zod";
import type { AuthUser } from "./auth";
import { config } from "./config";
import { Db } from "./db";
import { badRequest, conflict, forbidden, notFound } from "./errors";
import { logEvent } from "./events";
import { enqueue } from "./outbox";
import { RANK, Role, authorizeTeam, requireRole } from "./permissions";
import { STATUSES, Status, checkTransition, permissionsFor } from "./workflow";

export interface Result {
  status: number;
  body: unknown;
}

const TYPES = ["incident", "customer_issue", "payment", "compliance", "task"] as const;
const PRIORITIES = ["low", "medium", "high", "urgent"] as const;
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");

// ---------------------------------------------------------------- reading items

const ITEM_COLS = `w.id, w.title, w.description, w.type, w.priority, w.status, w.team_id, t.name AS team_name,
  w.assignee_id, a.username AS assignee_name, w.created_by, cb.username AS created_by_name,
  w.due_date, w.version, w.created_at, w.updated_at`;
const ITEM_FROM = `FROM work_items w
  JOIN teams t ON t.id = w.team_id
  LEFT JOIN users a ON a.id = w.assignee_id
  JOIN users cb ON cb.id = w.created_by`;

function toItem(r: any) {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    type: r.type,
    priority: r.priority,
    status: r.status,
    team: { id: r.team_id, name: r.team_name },
    assignee: r.assignee_id ? { id: r.assignee_id, username: r.assignee_name } : null,
    created_by: { id: r.created_by, username: r.created_by_name },
    due_date: r.due_date,
    version: r.version,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

/** Load an item the user is allowed to see. Items of other teams look exactly like missing items (404). */
async function loadItem(db: Db, userId: number, id: number) {
  const { rows } = await db.query(
    `SELECT ${ITEM_COLS}, m.role ${ITEM_FROM}
     JOIN memberships m ON m.team_id = w.team_id AND m.user_id = $2
     WHERE w.id = $1`,
    [id, userId],
  );
  if (!rows[0]) throw notFound("Work item not found");
  return { row: rows[0], role: rows[0].role as Role };
}

async function latestItem(db: Db, id: number) {
  const { rows } = await db.query(`SELECT ${ITEM_COLS} ${ITEM_FROM} WHERE w.id = $1`, [id]);
  return rows[0] ? toItem(rows[0]) : null;
}

function detail(user: AuthUser, row: any, role: Role) {
  return { ...toItem(row), role, permissions: permissionsFor(user.id, row, role) };
}

export async function getItem(db: Db, user: AuthUser, id: number) {
  const { row, role } = await loadItem(db, user.id, id);
  return detail(user, row, role);
}

async function staleError(db: Db, id: number, message?: string) {
  return conflict("version_conflict", message ?? "This item was changed by someone else. Reload and try again.", {
    latest: await latestItem(db, id),
  });
}

// ---------------------------------------------------------------- create

const createSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().max(10000).default(""),
    type: z.enum(TYPES),
    priority: z.enum(PRIORITIES).default("medium"),
    team_id: z.number().int().positive(),
    due_date: DATE.nullable().optional(),
  })
  .strict();

export async function createItem(c: Db, user: AuthUser, input: unknown): Promise<Result> {
  const d = createSchema.parse(input);
  await authorizeTeam(c, user, d.team_id, "create");
  const { rows } = await c.query(
    `INSERT INTO work_items (title, description, type, priority, status, team_id, created_by, due_date)
     VALUES ($1, $2, $3, $4, 'open', $5, $6, $7) RETURNING id`,
    [d.title, d.description, d.type, d.priority, d.team_id, user.id, d.due_date ?? null],
  );
  const id = rows[0].id as number;
  await logEvent(c, id, user.id, "created", { title: d.title, type: d.type, priority: d.priority });
  return { status: 201, body: await getItem(c, user, id) };
}

// ---------------------------------------------------------------- update (optimistic locking)

const patchSchema = z
  .object({
    version: z.number().int().min(1),
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(10000).optional(),
    type: z.enum(TYPES).optional(),
    priority: z.enum(PRIORITIES).optional(),
    due_date: DATE.nullable().optional(),
  })
  .strict();

const EDITABLE = ["title", "description", "type", "priority", "due_date"] as const;

export async function updateItem(c: Db, user: AuthUser, id: number, input: unknown): Promise<Result> {
  const d = patchSchema.parse(input);
  const { row, role } = await loadItem(c, user.id, id);
  requireRole(role, "edit");
  if (row.version !== d.version) throw await staleError(c, id);

  const changes: Record<string, [unknown, unknown]> = {};
  for (const f of EDITABLE) {
    if (d[f] !== undefined && d[f] !== row[f]) changes[f] = [row[f], d[f]];
  }
  const fields = Object.keys(changes);
  if (fields.length === 0) return { status: 200, body: detail(user, row, role) };

  // Optimistic lock: succeeds only if nobody changed the row since the client read it.
  const sets = fields.map((f, i) => `${f} = $${i + 3}`).join(", ");
  const res = await c.query(
    `UPDATE work_items SET ${sets}, version = version + 1, updated_at = now() WHERE id = $1 AND version = $2`,
    [id, d.version, ...fields.map((f) => changes[f][1])],
  );
  if (res.rowCount === 0) throw await staleError(c, id);

  if (changes.priority) {
    await logEvent(c, id, user.id, "priority_changed", { from: changes.priority[0], to: changes.priority[1] });
  }
  const others = fields.filter((f) => f !== "priority");
  if (others.length) {
    await logEvent(c, id, user.id, "edited", {
      fields: others,
      ...(changes.title ? { title: changes.title } : {}),
    });
  }
  return { status: 200, body: await getItem(c, user, id) };
}

// ---------------------------------------------------------------- claim (atomic)

export async function claimItem(c: Db, user: AuthUser, id: number): Promise<Result> {
  const { role } = await loadItem(c, user.id, id);
  requireRole(role, "claim");
  // The whole race is decided by this one statement: only one UPDATE can match "assignee_id IS NULL".
  const res = await c.query(
    `UPDATE work_items SET assignee_id = $2, version = version + 1, updated_at = now()
     WHERE id = $1 AND assignee_id IS NULL AND status = 'open'`,
    [id, user.id],
  );
  if (res.rowCount === 0) {
    throw conflict("already_claimed", "This item was already claimed or is no longer open", {
      latest: await latestItem(c, id),
    });
  }
  await logEvent(c, id, user.id, "assigned", { from: null, to: { id: user.id, username: user.username } });
  return { status: 200, body: await getItem(c, user, id) };
}

// ---------------------------------------------------------------- assign (Lead+)

const assignSchema = z
  .object({ assignee_id: z.number().int().positive().nullable(), version: z.number().int().min(1) })
  .strict();

export async function assignItem(c: Db, user: AuthUser, id: number, input: unknown): Promise<Result> {
  const d = assignSchema.parse(input);
  const { row, role } = await loadItem(c, user.id, id);
  requireRole(role, "assign");
  if (row.version !== d.version) throw await staleError(c, id);

  let target: { id: number; username: string } | null = null;
  if (d.assignee_id !== null) {
    const m = await c.query(
      `SELECT u.id, u.username, m.role FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.team_id = $1 AND m.user_id = $2`,
      [row.team_id, d.assignee_id],
    );
    if (!m.rows[0] || RANK[m.rows[0].role as Role] < RANK.member) {
      throw badRequest("Assignee must be a Member, Lead or Admin of the item's team", "invalid_assignee");
    }
    target = { id: m.rows[0].id, username: m.rows[0].username };
  } else if (row.status !== "open") {
    throw conflict("assignee_required", "Only open items can be unassigned");
  }
  if ((row.assignee_id ?? null) === (target?.id ?? null)) return { status: 200, body: detail(user, row, role) };

  const res = await c.query(
    `UPDATE work_items SET assignee_id = $3, version = version + 1, updated_at = now()
     WHERE id = $1 AND version = $2`,
    [id, d.version, target?.id ?? null],
  );
  if (res.rowCount === 0) throw await staleError(c, id);

  const from = row.assignee_id ? { id: row.assignee_id, username: row.assignee_name } : null;
  const eventId = await logEvent(c, id, user.id, "assigned", { from, to: target });
  if (target && target.id !== user.id) {
    // Same transaction as the change: either both the assignment and its notification job exist, or neither.
    await enqueue(c, "notify_assignee", { item_id: id, assignee_id: target.id, event_id: eventId, by: user.username });
  }
  return { status: 200, body: await getItem(c, user, id) };
}

// ---------------------------------------------------------------- workflow transition

const transitionSchema = z
  .object({ to: z.enum(STATUSES), version: z.number().int().min(1).optional() })
  .strict();

export async function transitionItem(c: Db, user: AuthUser, id: number, input: unknown): Promise<Result> {
  const d = transitionSchema.parse(input);
  const { row, role } = await loadItem(c, user.id, id);
  checkTransition(user.id, row, role, d.to as Status);
  if (d.version !== undefined && d.version !== row.version) throw await staleError(c, id);

  // Guarded on the version we validated against, so a concurrent change makes this match 0 rows.
  const res = await c.query(
    `UPDATE work_items SET status = $3, version = version + 1, updated_at = now()
     WHERE id = $1 AND version = $2`,
    [id, row.version, d.to],
  );
  if (res.rowCount === 0) throw await staleError(c, id);
  await logEvent(c, id, user.id, "status_changed", { from: row.status, to: d.to });
  return { status: 200, body: await getItem(c, user, id) };
}

// ---------------------------------------------------------------- comments & activity

const commentSchema = z.object({ text: z.string().trim().min(1).max(2000) }).strict();

function toEvent(r: any) {
  return {
    id: r.id,
    kind: r.kind,
    data: r.data,
    actor: r.actor_id ? { id: r.actor_id, username: r.actor_name } : null,
    created_at: r.created_at,
  };
}

export async function addComment(c: Db, user: AuthUser, id: number, input: unknown): Promise<Result> {
  const d = commentSchema.parse(input);
  const { role } = await loadItem(c, user.id, id);
  requireRole(role, "comment");
  const eventId = await logEvent(c, id, user.id, "comment", { text: d.text });
  const { rows } = await c.query(
    `SELECT e.*, u.username AS actor_name FROM activity_events e LEFT JOIN users u ON u.id = e.actor_id WHERE e.id = $1`,
    [eventId],
  );
  return { status: 201, body: toEvent(rows[0]) };
}

function pageSize(raw: unknown): number {
  if (raw === undefined || raw === "") return config.defaultPageSize;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw badRequest("limit must be a positive integer");
  return Math.min(n, config.maxPageSize);
}

const encodeCursor = (id: number) => Buffer.from(JSON.stringify({ id })).toString("base64url");
function decodeCursor(raw: unknown): number | null {
  if (raw === undefined || raw === "") return null;
  try {
    const { id } = JSON.parse(Buffer.from(String(raw), "base64url").toString());
    if (Number.isSafeInteger(id) && id > 0) return id;
  } catch {
    /* fall through */
  }
  throw badRequest("Invalid cursor");
}

export async function listActivity(db: Db, user: AuthUser, id: number, q: Record<string, unknown>) {
  await loadItem(db, user.id, id); // 404 if the item is outside the user's teams
  const limit = pageSize(q.limit);
  const cursor = decodeCursor(q.cursor);
  const params: unknown[] = [id, limit + 1];
  let where = "e.item_id = $1";
  if (cursor) {
    params.push(cursor);
    where += " AND e.id < $3";
  }
  const { rows } = await db.query(
    `SELECT e.*, u.username AS actor_name FROM activity_events e
     LEFT JOIN users u ON u.id = e.actor_id
     WHERE ${where} ORDER BY e.id DESC LIMIT $2`,
    params,
  );
  const page = rows.slice(0, limit);
  return { events: page.map(toEvent), next_cursor: rows.length > limit ? encodeCursor(page[page.length - 1].id) : null };
}

// ---------------------------------------------------------------- list / dashboard

type Filters = Record<string, unknown>;
const oneOf = <T extends readonly string[]>(name: string, v: unknown, allowed: T): T[number] => {
  if (typeof v !== "string" || !allowed.includes(v)) throw badRequest(`${name} must be one of: ${allowed.join(", ")}`);
  return v;
};
const VIEWS = ["assigned_to_me", "unassigned_urgent", "awaiting_my_approval"] as const;

/** Builds the WHERE clause. Everything is scoped to the caller's teams first, then narrowed by filters. */
function buildWhere(userId: number, f: Filters) {
  const params: unknown[] = [userId];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const where = ["w.team_id IN (SELECT team_id FROM memberships WHERE user_id = $1)"];

  if (f.view !== undefined && f.view !== "") {
    switch (oneOf("view", f.view, VIEWS)) {
      case "assigned_to_me":
        where.push("w.assignee_id = $1 AND w.status NOT IN ('resolved','closed')");
        break;
      case "unassigned_urgent":
        where.push("w.assignee_id IS NULL AND w.priority = 'urgent' AND w.status = 'open'");
        break;
      case "awaiting_my_approval":
        where.push(`w.status = 'awaiting_approval'
          AND w.team_id IN (SELECT team_id FROM memberships WHERE user_id = $1 AND role IN ('lead','admin'))
          AND (w.assignee_id IS DISTINCT FROM $1
               OR EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = $1 AND m.team_id = w.team_id AND m.role = 'admin'))`);
        break;
    }
  }
  if (f.status) where.push(`w.status = ${p(oneOf("status", f.status, STATUSES))}`);
  if (f.priority) where.push(`w.priority = ${p(oneOf("priority", f.priority, PRIORITIES))}`);
  if (f.type) where.push(`w.type = ${p(oneOf("type", f.type, TYPES))}`);
  if (f.team_id) {
    const t = Number(f.team_id);
    if (!Number.isInteger(t)) throw badRequest("team_id must be an integer");
    where.push(`w.team_id = ${p(t)}`);
  }
  if (f.assignee) {
    if (f.assignee === "me") where.push("w.assignee_id = $1");
    else if (f.assignee === "none") where.push("w.assignee_id IS NULL");
    else {
      const a = Number(f.assignee);
      if (!Number.isInteger(a)) throw badRequest("assignee must be 'me', 'none' or a user id");
      where.push(`w.assignee_id = ${p(a)}`);
    }
  }
  if (typeof f.q === "string" && f.q.trim()) {
    const term = f.q.trim().slice(0, 100);
    const like = `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    const byId = /^#?\d+$/.test(term) ? ` OR w.id = ${p(Number(term.replace("#", "")))}` : "";
    where.push(`(w.title ILIKE ${p(like)}${byId})`);
  }
  return { where, params, p };
}

export async function listItems(db: Db, user: AuthUser, f: Filters) {
  const limit = pageSize(f.limit);
  const cursor = decodeCursor(f.cursor);
  const { where, params, p } = buildWhere(user.id, f);
  if (cursor) where.push(`w.id < ${p(cursor)}`);
  const limitParam = p(limit + 1);
  const { rows } = await db.query(
    `SELECT ${ITEM_COLS} ${ITEM_FROM} WHERE ${where.join(" AND ")} ORDER BY w.id DESC LIMIT ${limitParam}`,
    params,
  );
  const page = rows.slice(0, limit);
  return { items: page.map(toItem), next_cursor: rows.length > limit ? encodeCursor(page[page.length - 1].id) : null };
}

export async function dashboard(db: Db, user: AuthUser) {
  const counts: Record<string, number> = {};
  for (const view of VIEWS) {
    const { where, params } = buildWhere(user.id, { view });
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM work_items w WHERE ${where.join(" AND ")}`, params);
    counts[view] = rows[0].n;
  }
  return counts;
}

// ---------------------------------------------------------------- teams / users / notifications

export async function myProfile(db: Db, user: AuthUser) {
  const { rows } = await db.query(
    `SELECT t.id, t.name, m.role FROM memberships m JOIN teams t ON t.id = m.team_id WHERE m.user_id = $1 ORDER BY t.name`,
    [user.id],
  );
  return { id: user.id, username: user.username, memberships: rows.map((r) => ({ team: { id: r.id, name: r.name }, role: r.role })) };
}

export async function teamMembers(db: Db, user: AuthUser, teamId: number) {
  const mine = await db.query("SELECT 1 FROM memberships WHERE user_id = $1 AND team_id = $2", [user.id, teamId]);
  if (!mine.rows[0]) throw notFound("Team not found");
  const { rows } = await db.query(
    `SELECT u.id, u.username, m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.team_id = $1 ORDER BY u.username`,
    [teamId],
  );
  return rows;
}

export async function myNotifications(db: Db, user: AuthUser) {
  const { rows } = await db.query(
    `SELECT id, item_id, message, created_at FROM notifications WHERE user_id = $1 ORDER BY id DESC LIMIT 50`,
    [user.id],
  );
  return rows;
}

export { forbidden };
