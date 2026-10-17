CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE users (
  id            SERIAL PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE teams (
  id   SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE memberships (
  user_id INT  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id INT  NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  role    TEXT NOT NULL CHECK (role IN ('viewer','member','lead','admin')),
  PRIMARY KEY (user_id, team_id)
);
CREATE INDEX memberships_team ON memberships (team_id);

CREATE TABLE tokens (
  token      TEXT PRIMARY KEY,
  user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE work_items (
  id          BIGSERIAL PRIMARY KEY,
  title       TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  description TEXT NOT NULL DEFAULT '',
  type        TEXT NOT NULL CHECK (type IN ('incident','customer_issue','payment','compliance','task')),
  priority    TEXT NOT NULL CHECK (priority IN ('low','medium','high','urgent')),
  status      TEXT NOT NULL CHECK (status IN ('open','in_progress','awaiting_approval','resolved','closed')),
  team_id     INT  NOT NULL REFERENCES teams(id),
  assignee_id INT  REFERENCES users(id),
  created_by  INT  NOT NULL REFERENCES users(id),
  due_date    DATE,
  version     INT  NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Invariant: only an open item may be unassigned.
  CONSTRAINT assignee_required_after_open CHECK (status = 'open' OR assignee_id IS NOT NULL)
);
-- Every list is ordered by id DESC (keyset pagination), so each index ends in id DESC.
CREATE INDEX wi_team_status_id     ON work_items (team_id, status, id DESC);
CREATE INDEX wi_assignee_status_id ON work_items (assignee_id, status, id DESC);
CREATE INDEX wi_status_id          ON work_items (status, id DESC);
CREATE INDEX wi_unassigned_urgent  ON work_items (id DESC) WHERE assignee_id IS NULL AND priority = 'urgent';
CREATE INDEX wi_title_trgm         ON work_items USING gin (title gin_trgm_ops);

CREATE TABLE activity_events (
  id         BIGSERIAL PRIMARY KEY,
  item_id    BIGINT NOT NULL REFERENCES work_items(id),
  actor_id   INT REFERENCES users(id),
  kind       TEXT NOT NULL,
  data       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ae_item_id ON activity_events (item_id, id DESC);

-- History is append-only: enforced by the database, not just by application code.
CREATE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'activity_events is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER activity_events_append_only
  BEFORE UPDATE OR DELETE ON activity_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE idempotency_keys (
  user_id         INT  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key             TEXT NOT NULL,
  fingerprint     TEXT NOT NULL,
  response_status INT,
  response_body   JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);

CREATE TABLE outbox (
  id              BIGSERIAL PRIMARY KEY,
  kind            TEXT NOT NULL,
  payload         JSONB NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','failed')),
  attempts        INT  NOT NULL DEFAULT 0,
  max_attempts    INT  NOT NULL DEFAULT 5,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at    TIMESTAMPTZ
);
CREATE INDEX outbox_due ON outbox (next_attempt_at) WHERE status = 'pending';

CREATE TABLE notifications (
  id         BIGSERIAL PRIMARY KEY,
  user_id    INT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id    BIGINT NOT NULL REFERENCES work_items(id),
  message    TEXT   NOT NULL,
  dedupe_key TEXT   NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user ON notifications (user_id, id DESC);
