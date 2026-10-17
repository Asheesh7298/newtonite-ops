import { Db } from "./db";

export type EventKind = "created" | "status_changed" | "assigned" | "priority_changed" | "edited" | "comment";

/**
 * Append one history event. Always called with the SAME client/transaction that changes the item,
 * so history can never disagree with the item (both commit, or neither does).
 */
export async function logEvent(
  db: Db,
  itemId: number,
  actorId: number | null,
  kind: EventKind,
  data: Record<string, unknown> = {},
): Promise<number> {
  const { rows } = await db.query(
    "INSERT INTO activity_events (item_id, actor_id, kind, data) VALUES ($1, $2, $3, $4) RETURNING id",
    [itemId, actorId, kind, JSON.stringify(data)],
  );
  return rows[0].id as number;
}
