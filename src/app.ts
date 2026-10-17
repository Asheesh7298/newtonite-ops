import crypto from "crypto";
import express, { NextFunction, Request, RequestHandler, Response } from "express";
import path from "path";
import { PoolClient } from "pg";
import { ZodError } from "zod";
import { AuthUser, login, requireAuth } from "./auth";
import { pool, tx } from "./db";
import { ApiError, badRequest } from "./errors";
import * as items from "./items";

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

const userOf = (res: Response) => res.locals.user as AuthUser;

function idParam(req: Request, name = "id"): number {
  const n = Number(req.params[name]);
  if (!Number.isSafeInteger(n) || n < 1) throw badRequest(`Invalid ${name}`);
  return n;
}

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

/**
 * Runs a mutating handler in ONE transaction. If the client sent an Idempotency-Key, the key row is
 * inserted in that same transaction:
 *  - first request: runs the handler, stores the response with the key, commits both together;
 *  - retry / double click: finds the key, returns the stored response, runs nothing;
 *  - concurrent duplicate: INSERT ... ON CONFLICT waits for the first transaction to finish, then replays it;
 *  - failed request: the transaction rolls back, key included, so a retry runs normally.
 */
async function mutate(
  req: Request,
  res: Response,
  handler: (c: PoolClient) => Promise<items.Result>,
): Promise<void> {
  const user = userOf(res);
  const key = req.header("Idempotency-Key");
  if (key !== undefined && (key.length < 1 || key.length > 200)) throw badRequest("Idempotency-Key must be 1-200 characters");

  const out = await tx(async (c) => {
    if (!key) return { ...(await handler(c)), replayed: false };

    const fingerprint = crypto
      .createHash("sha256")
      .update(`${req.method} ${req.path} ${stableStringify(req.body ?? {})}`)
      .digest("hex");
    const ins = await c.query(
      "INSERT INTO idempotency_keys (user_id, key, fingerprint) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING key",
      [user.id, key, fingerprint],
    );
    if (ins.rowCount === 0) {
      const { rows } = await c.query(
        "SELECT fingerprint, response_status, response_body FROM idempotency_keys WHERE user_id = $1 AND key = $2",
        [user.id, key],
      );
      if (rows[0].fingerprint !== fingerprint) {
        throw new ApiError(422, "idempotency_key_reuse", "This Idempotency-Key was already used with a different request");
      }
      return { status: rows[0].response_status as number, body: rows[0].response_body, replayed: true };
    }
    const result = await handler(c);
    await c.query("UPDATE idempotency_keys SET response_status = $3, response_body = $4 WHERE user_id = $1 AND key = $2", [
      user.id,
      key,
      result.status,
      JSON.stringify(result.body),
    ]);
    return { ...result, replayed: false };
  });

  if (out.replayed) res.setHeader("Idempotent-Replayed", "true");
  res.status(out.status).json(out.body);
}

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "100kb" }));

  // ---- public
  app.get("/healthz", wrap(async (_req, res) => {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  }));
  app.post("/api/auth/login", wrap(async (req, res) => {
    res.json(await login(pool, req.body?.username, req.body?.password));
  }));

  // ---- everything below requires a token
  app.use("/api", requireAuth);

  app.get("/api/me", wrap(async (_req, res) => {
    res.json(await items.myProfile(pool, userOf(res)));
  }));
  app.get("/api/teams/:id/members", wrap(async (req, res) => {
    res.json(await items.teamMembers(pool, userOf(res), idParam(req)));
  }));
  app.get("/api/dashboard", wrap(async (_req, res) => {
    res.json(await items.dashboard(pool, userOf(res)));
  }));
  app.get("/api/notifications", wrap(async (_req, res) => {
    res.json(await items.myNotifications(pool, userOf(res)));
  }));

  app.get("/api/items", wrap(async (req, res) => {
    res.json(await items.listItems(pool, userOf(res), req.query));
  }));
  app.post("/api/items", wrap((req, res) => mutate(req, res, (c) => items.createItem(c, userOf(res), req.body))));

  app.get("/api/items/:id", wrap(async (req, res) => {
    res.json(await items.getItem(pool, userOf(res), idParam(req)));
  }));
  app.patch("/api/items/:id", wrap((req, res) =>
    mutate(req, res, (c) => items.updateItem(c, userOf(res), idParam(req), req.body))));
  app.post("/api/items/:id/claim", wrap((req, res) =>
    mutate(req, res, (c) => items.claimItem(c, userOf(res), idParam(req)))));
  app.post("/api/items/:id/assign", wrap((req, res) =>
    mutate(req, res, (c) => items.assignItem(c, userOf(res), idParam(req), req.body))));
  app.post("/api/items/:id/transition", wrap((req, res) =>
    mutate(req, res, (c) => items.transitionItem(c, userOf(res), idParam(req), req.body))));
  app.post("/api/items/:id/comments", wrap((req, res) =>
    mutate(req, res, (c) => items.addComment(c, userOf(res), idParam(req), req.body))));
  app.get("/api/items/:id/activity", wrap(async (req, res) => {
    res.json(await items.listActivity(pool, userOf(res), idParam(req), req.query));
  }));

  app.use("/api", (_req, res) => {
    res.status(404).json({ code: "not_found", message: "Unknown endpoint" });
  });

  // ---- minimal single-page UI
  app.use(express.static(path.resolve(__dirname, "../public")));

  // ---- error handler
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ApiError) {
      res.status(err.status).json({ code: err.code, message: err.message, ...err.extra });
    } else if (err instanceof ZodError) {
      const first = err.issues[0];
      res.status(400).json({ code: "validation_error", message: `${first.path.join(".") || "body"}: ${first.message}`, issues: err.issues });
    } else if (err?.type === "entity.parse.failed" || err?.type === "entity.too.large") {
      res.status(err.status ?? 400).json({ code: "bad_request", message: "Invalid JSON body" });
    } else {
      console.error(err);
      res.status(500).json({ code: "internal_error", message: "Internal server error" });
    }
  });

  return app;
}
