import crypto from "crypto";
import { NextFunction, Request, Response } from "express";
import { Db, pool } from "./db";
import { ApiError, unauthorized } from "./errors";

export interface AuthUser {
  id: number;
  username: string;
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(":");
  const expected = Buffer.from(hashHex, "hex");
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

const DUMMY_HASH = hashPassword("dummy-password-for-timing");

export async function login(db: Db, username: unknown, password: unknown) {
  if (typeof username !== "string" || typeof password !== "string") {
    throw new ApiError(400, "bad_request", "username and password are required");
  }
  const { rows } = await db.query("SELECT id, username, password_hash FROM users WHERE username = $1", [username]);
  const user = rows[0];
  // Always run one scrypt so "unknown user" and "wrong password" take similar time.
  const ok = verifyPassword(password, user ? user.password_hash : DUMMY_HASH) && !!user;
  if (!ok) throw new ApiError(401, "invalid_credentials", "Invalid username or password");
  const token = crypto.randomBytes(32).toString("hex");
  await db.query("INSERT INTO tokens (token, user_id) VALUES ($1, $2)", [token, user.id]);
  return { token, user: { id: user.id as number, username: user.username as string } };
}

/** Express middleware: resolves "Authorization: Bearer <token>" to res.locals.user or responds 401. */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const header = req.header("Authorization") ?? "";
    const match = /^Bearer (.+)$/.exec(header);
    if (!match) throw unauthorized();
    const { rows } = await pool.query(
      "SELECT u.id, u.username FROM tokens t JOIN users u ON u.id = t.user_id WHERE t.token = $1",
      [match[1]],
    );
    if (!rows[0]) throw unauthorized("Invalid or expired token");
    res.locals.user = { id: rows[0].id, username: rows[0].username } as AuthUser;
    next();
  } catch (e) {
    next(e);
  }
}
