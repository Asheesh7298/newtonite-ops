import { Db } from "./db";
import { forbidden } from "./errors";
import type { AuthUser } from "./auth";

export type Role = "viewer" | "member" | "lead" | "admin";
export const RANK: Record<Role, number> = { viewer: 0, member: 1, lead: 2, admin: 3 };

export type Action = "view" | "create" | "comment" | "edit" | "claim" | "transition" | "approve" | "assign";

/** The role x action matrix: minimum role (per team) needed for each action. */
export const REQUIRED_ROLE: Record<Action, Role> = {
  view: "viewer",
  create: "member",
  comment: "member",
  edit: "member",
  claim: "member",
  transition: "member",
  approve: "lead",
  assign: "lead",
};

export function hasRole(role: Role, action: Action): boolean {
  return RANK[role] >= RANK[REQUIRED_ROLE[action]];
}

/** The single permission check used by every endpoint. Throws 403 if the role is too low. */
export function requireRole(role: Role, action: Action): void {
  if (!hasRole(role, action)) {
    throw forbidden(`Your role in this team (${role}) is not allowed to ${action} items`);
  }
}

export async function roleInTeam(db: Db, userId: number, teamId: number): Promise<Role | null> {
  const { rows } = await db.query("SELECT role FROM memberships WHERE user_id = $1 AND team_id = $2", [userId, teamId]);
  return (rows[0]?.role as Role) ?? null;
}

/** For team-level actions (e.g. create): non-members get 403, members need a sufficient role. */
export async function authorizeTeam(db: Db, user: AuthUser, teamId: number, action: Action): Promise<Role> {
  const role = await roleInTeam(db, user.id, teamId);
  if (!role) throw forbidden("You are not a member of this team");
  requireRole(role, action);
  return role;
}
