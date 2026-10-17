# Engineering Decisions

Each decision lists the context, the options considered, what I chose, and the trade-off.

## 1. Concurrency control: guarded `UPDATE`s and a version column

**Context.** Two people can claim the same item, edit it from stale screens, or move it through the workflow at the same moment.

**Options.** (a) `SELECT ... FOR UPDATE`, then update; (b) `SERIALIZABLE` isolation with retry loops; (c) a single guarded `UPDATE` whose
`WHERE` clause encodes the precondition.

**Choice.** (c). Claiming is `UPDATE ... WHERE id = $1 AND assignee_id IS NULL AND status = 'open'`; zero rows updated means someone else won, and
the API answers 409. Edits, assignments and transitions read or send a `version` and update `WHERE id = $1 AND version = $2`, incrementing it. A
mismatch answers 409 with the latest item so the UI can show "this item changed, reload".

**Trade-off.** The decision is made by one statement inside Postgres, so it is correct at the default `READ COMMITTED` level with no explicit
locks and no retry loops, and it is easy to test with parallel requests. The cost is that users get an explicit conflict instead of
the system silently merging edits; for this domain that is the safer behaviour (nobody's priority change is silently overwritten).

## 2. Idempotency keys stored in the same transaction as the work

**Context.** Double-clicks and network retries must not create two items or apply an action twice.

**Options.** (a) Disable the button only (not safe against retries); (b) a separate "seen keys" cache or table written before or after the
work; (c) insert the key row inside the same transaction as the business change.

**Choice.** (c). `INSERT ... ON CONFLICT DO NOTHING` on `(user_id, key)` is the first statement of the transaction. If it inserts, the handler runs
and the response is stored with the key before commit. If a duplicate arrives while the first request is still running, its insert waits for
that transaction and then replays the stored response. A failed request rolls back the key too, so a retry executes normally. The key is
bound to a fingerprint of method, path and body; reuse with a different body returns 422.

**Trade-off.** No race windows, but only successful responses are remembered, and keys are not purged yet (listed as a
limitation). Keys are per user, so one user cannot replay another's response.

## 3. Authorization: scope every query, one role matrix, one workflow check

**Context.** Permissions must hold on the server, per team and per resource, not just by hiding buttons.

**Options.** (a) Check roles in each route handler; (b) filter after loading; (c) make team membership part of every query and centralise the rules.

**Choice.** (c). Items are always loaded with a join on the caller's membership, so items of other teams are indistinguishable from missing ones
(404, no information leak). `REQUIRED_ROLE` in `permissions.ts` is the role-by-action matrix. All workflow rules live in one function,
`checkTransition`, used by the transition endpoint and also to compute which buttons the UI shows (`permissions` in the item detail), so the UI
cannot disagree with the server. Rules: only a Lead/Admin passes the approval steps; a Member moves only items assigned to them; a Lead cannot approve
an item assigned to themselves (four-eyes; Admin exempt).

**Trade-off.** I return 404 for other teams' items (hides existence) and 403 for insufficient role inside a team you can see. The
four-eyes rule can block a one-lead team, which is why Admins are exempt. This is the first thing I would confirm with a product manager.

## 4. History and consistency: events in the same transaction, append-only in the database

**Context.** Owner, priority and state changes must be recorded and visible, and history must never disagree with the item.

**Options.** (a) Write history after the update in a separate step; (b) database triggers that copy changes; (c) the service writes the event
inside the same transaction.

**Choice.** (c), plus a database trigger that rejects `UPDATE` and `DELETE` on `activity_events`. Comments are events of kind `comment`, so one
timeline covers everything. A test makes the event insert fail and proves the item change rolls back with it.

**Trade-off.** Events are written by application code rather than triggers, so a new code path must remember to log; I mitigated that by keeping
all mutations in `items.ts`. Storing comments as events keeps one table and one pagination path, at the cost of a JSONB payload instead of a typed
comments table.

## 5. Async work: transactional outbox with an idempotent worker

**Context.** Assigning work should notify the new assignee, but a slow or failing notifier must not block or break the assignment.

**Options.** (a) Call the notifier inline; (b) enqueue to Redis after commit (the job is lost if the process dies between commit and enqueue);
(c) write a job row in the same transaction (outbox) and process it from a worker.

**Choice.** (c). The job row commits with the assignment. The worker selects due jobs with `FOR UPDATE SKIP LOCKED` (so several workers are safe), runs
each in a savepoint, retries with exponential backoff, and marks the job `failed` after `max_attempts` (5). The handler is idempotent via a unique
`dedupe_key`, so at-least-once delivery produces one notification. If the worker crashes mid-batch the transaction rolls back and the jobs are still
due.

**Trade-off.** No extra infrastructure and no lost jobs, at the cost of polling (2 s latency) and a table that needs periodic cleanup. At much
higher throughput I would move to a dedicated queue.

## 6. Listing at scale: keyset pagination, composite indexes, server-side filters

**Context.** Tens of thousands of items and a growing history must stay fast.

**Options.** `OFFSET` vs keyset pagination; filtering in the browser vs on the server.

**Choice.** Keyset (cursor) pagination on `id DESC`, which gives stable pages while new items arrive and constant cost per page. Composite indexes end
in `id DESC` so filtered, ordered, limited queries are index scans: `(team_id, status, id DESC)`, `(assignee_id, status, id DESC)`,
`(status, id DESC)`, a partial index for unassigned urgent items, and a trigram GIN index on `title` for search. The page size is capped at 100.
A test checks that the hot query uses an index.

**Trade-off.** Ordering by id means "newest first" only; sorting by priority or due date would need other indexes. Search covers titles, not full text.

## 7. Plain Express and raw SQL instead of NestJS or an ORM

**Context.** I must be able to explain every line live, and the interesting behaviour is in SQL (conditional updates, locks, savepoints).

**Choice.** Express + `pg` + zod. SQL is visible exactly where the correctness arguments are made, and the whole backend is about 1,100 lines.

**Trade-off.** No ORM migrations or generated types, and some hand-written SQL strings. I kept the schema in one reviewed migration file and wrote a
small migration runner with an advisory lock.

## What I chose not to build

Email delivery, attachments, SSO, websockets (polling is enough), sign-up, user and team administration, and fancy styling, as allowed by the brief.
I preferred fewer screens and well-tested behaviour under contention.

## Scaling to 10x

Add read replicas for list and search queries; partition `activity_events` by time and archive old partitions; move search to `tsvector` or a
search engine; replace the polling worker with `LISTEN/NOTIFY` or a dedicated queue; add websockets or SSE for live updates; cache team membership
per request; add rate limiting at the edge.
