import { hashPassword } from "./auth";
import { pool } from "./db";

export const DEMO_PASSWORD = "demo1234";

const TEAMS = ["Payments", "Support", "Compliance", "Platform"];

type Role = "viewer" | "member" | "lead" | "admin";
// username -> [team, role]
const USERS: Record<string, [string, Role][]> = {
  admin: TEAMS.map((t) => [t, "admin"] as [string, Role]),
  alice: [["Payments", "lead"], ["Support", "lead"]],
  bob: [["Compliance", "lead"], ["Platform", "lead"]],
  carol: [["Payments", "member"], ["Support", "member"]],
  dave: [["Payments", "member"]],
  erin: [["Compliance", "member"]],
  frank: [["Payments", "viewer"], ["Compliance", "viewer"]],
  grace: [["Platform", "member"], ["Compliance", "member"]],
  heidi: [["Platform", "member"]],
  ivan: [["Support", "member"]],
};

// Small deterministic PRNG so every seed run produces the same data.
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function weighted<T>(rand: () => number, pairs: [T, number][]): T {
  const total = pairs.reduce((s, [, w]) => s + w, 0);
  let r = rand() * total;
  for (const [v, w] of pairs) if ((r -= w) <= 0) return v;
  return pairs[pairs.length - 1][0];
}

const TITLES: Record<string, string[]> = {
  incident: ["API latency spike", "Checkout service down", "Database failover", "Queue backlog growing"],
  customer_issue: ["Customer cannot log in", "Duplicate invoice emailed", "Refund not received", "Wrong plan displayed"],
  payment: ["Settlement mismatch", "Chargeback review", "Card decline rate up", "Payout delayed"],
  compliance: ["KYC document expired", "Audit evidence request", "Data retention review", "Policy attestation due"],
  task: ["Rotate API keys", "Update runbook", "Clean up stale accounts", "Review on-call schedule"],
};

export async function seed(itemCount = 5000): Promise<void> {
  const rand = rng(42);
  const pick = <T>(a: T[]) => a[Math.floor(rand() * a.length)];

  const passwordHash = hashPassword(DEMO_PASSWORD);
  const teamIds: Record<string, number> = {};
  for (const name of TEAMS) {
    const r = await pool.query("INSERT INTO teams (name) VALUES ($1) RETURNING id", [name]);
    teamIds[name] = r.rows[0].id;
  }
  const userIds: Record<string, number> = {};
  const staff: Record<number, number[]> = {}; // teamId -> users who are member+ (can own items)
  for (const [username, memberships] of Object.entries(USERS)) {
    const r = await pool.query("INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id", [username, passwordHash]);
    userIds[username] = r.rows[0].id;
    for (const [team, role] of memberships) {
      await pool.query("INSERT INTO memberships (user_id, team_id, role) VALUES ($1, $2, $3)", [userIds[username], teamIds[team], role]);
      if (role !== "viewer") (staff[teamIds[team]] ??= []).push(userIds[username]);
    }
  }

  const types = Object.keys(TITLES);
  const BATCH = 500;
  for (let start = 0; start < itemCount; start += BATCH) {
    const n = Math.min(BATCH, itemCount - start);
    const cols: Record<string, unknown[]> = {
      title: [], description: [], type: [], priority: [], status: [], team_id: [], assignee_id: [], created_by: [], due_date: [], created_at: [],
    };
    for (let i = 0; i < n; i++) {
      const type = pick(types);
      const team = teamIds[pick(TEAMS)];
      const status = weighted(rand, [["open", 30], ["in_progress", 28], ["awaiting_approval", 12], ["resolved", 15], ["closed", 15]] as [string, number][]);
      const assigned = status !== "open" || rand() < 0.5;
      const created = new Date(Date.now() - Math.floor(rand() * 60 * 86400000));
      const due = rand() < 0.7 ? new Date(Date.now() + Math.floor((rand() - 0.4) * 40 * 86400000)).toISOString().slice(0, 10) : null;
      cols.title.push(`${pick(TITLES[type])} #${start + i + 1}`);
      cols.description.push("Seeded demo item.");
      cols.type.push(type);
      cols.priority.push(weighted(rand, [["low", 25], ["medium", 40], ["high", 25], ["urgent", 10]] as [string, number][]));
      cols.status.push(status);
      cols.team_id.push(team);
      cols.assignee_id.push(assigned ? pick(staff[team]) : null);
      cols.created_by.push(pick(staff[team]));
      cols.due_date.push(due);
      cols.created_at.push(created.toISOString());
    }
    const ins = await pool.query(
      `INSERT INTO work_items (title, description, type, priority, status, team_id, assignee_id, created_by, due_date, created_at, updated_at)
       SELECT title, description, type, priority, status, team_id, assignee_id, created_by, due_date, created_at, created_at
       FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::int[], $7::int[], $8::int[], $9::date[], $10::timestamptz[])
            AS t(title, description, type, priority, status, team_id, assignee_id, created_by, due_date, created_at)
       RETURNING id, created_by, created_at`,
      [cols.title, cols.description, cols.type, cols.priority, cols.status, cols.team_id, cols.assignee_id, cols.created_by, cols.due_date, cols.created_at],
    );
    await pool.query(
      `INSERT INTO activity_events (item_id, actor_id, kind, data, created_at)
       SELECT id, actor, 'created', '{"seeded": true}'::jsonb, ts FROM unnest($1::bigint[], $2::int[], $3::timestamptz[]) AS t(id, actor, ts)`,
      [ins.rows.map((r) => r.id), ins.rows.map((r) => r.created_by), ins.rows.map((r) => r.created_at)],
    );
  }
  console.log(`seeded ${TEAMS.length} teams, ${Object.keys(USERS).length} users, ${itemCount} items (password for all users: ${DEMO_PASSWORD})`);
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const count = Number(args.find((a) => a.startsWith("--items="))?.split("=")[1] ?? 5000);
  (async () => {
    if (args.includes("--if-empty")) {
      const { rows } = await pool.query("SELECT count(*)::int AS n FROM teams");
      if (rows[0].n > 0) {
        console.log("database already seeded, skipping");
        return;
      }
    }
    await seed(count);
  })()
    .then(() => pool.end())
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
