import { conflict, forbidden } from "./errors";
import { RANK, Role, hasRole } from "./permissions";

export const STATUSES = ["open", "in_progress", "awaiting_approval", "resolved", "closed"] as const;
export type Status = (typeof STATUSES)[number];

/** Allowed transitions. Anything not listed here is rejected by the server. */
export const TRANSITIONS: Record<Status, Status[]> = {
  open: ["in_progress"],
  in_progress: ["open", "awaiting_approval"],
  awaiting_approval: ["resolved", "in_progress"], // approve / send back
  resolved: ["closed", "in_progress"], // close / reopen
  closed: [],
};

/** Transitions that only a Lead (or Admin) of the item's team may perform. */
const APPROVAL_STEPS = new Set(["awaiting_approval>resolved", "awaiting_approval>in_progress", "resolved>closed"]);
export const isApprovalStep = (from: Status, to: Status) => APPROVAL_STEPS.has(`${from}>${to}`);

interface ItemForWorkflow {
  status: Status;
  assignee_id: number | null;
}

/**
 * Single source of truth for "may this user move this item to `to`?".
 * Used by the transition endpoint AND to compute which buttons the UI shows.
 */
export function checkTransition(userId: number, item: ItemForWorkflow, role: Role, to: Status): void {
  if (!hasRole(role, "transition")) throw forbidden(`Your role (${role}) cannot change item status`);
  if (!TRANSITIONS[item.status].includes(to)) {
    throw conflict("invalid_transition", `Cannot move an item from '${item.status}' to '${to}'`);
  }
  if (isApprovalStep(item.status, to)) {
    if (!hasRole(role, "approve")) {
      throw forbidden("Only a Lead of this team can approve, reject or close", "approval_requires_lead");
    }
    // Four-eyes rule: you cannot approve work you are assigned to (Admins are exempt).
    if (item.status === "awaiting_approval" && to === "resolved" && item.assignee_id === userId && role !== "admin") {
      throw forbidden("You cannot approve an item assigned to you", "self_approval");
    }
  } else if (RANK[role] < RANK.lead && item.assignee_id !== userId) {
    throw forbidden("Only the assignee or a Lead can move this item", "not_assignee");
  }
  if (item.status === "open" && to === "in_progress" && item.assignee_id === null) {
    throw conflict("assignee_required", "Assign or claim the item before starting work");
  }
}

export function permissionsFor(userId: number, item: ItemForWorkflow, role: Role) {
  const transitions = TRANSITIONS[item.status].filter((to) => {
    try {
      checkTransition(userId, item, role, to);
      return true;
    } catch {
      return false;
    }
  });
  return {
    edit: hasRole(role, "edit"),
    comment: hasRole(role, "comment"),
    claim: hasRole(role, "claim") && item.status === "open" && item.assignee_id === null,
    assign: hasRole(role, "assign"),
    transitions,
  };
}
