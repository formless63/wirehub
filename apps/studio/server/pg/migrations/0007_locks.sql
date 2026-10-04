-- Generated from specs/postgres-backend.md §3 (rev 6.2). Never edit after release:
-- a change is a new migration (§6; migrations/CHECKSUMS).
-- 0007_locks
CREATE TABLE studio.edit_lock (
  org_id     uuid NOT NULL REFERENCES studio.org,
  record     text NOT NULL CHECK (length(record) <= 200 AND record ~ '^(design|definition|build|vocab):'),
  token      uuid NOT NULL,
  holder     jsonb NOT NULL,                  -- LockHolder {name, clientId, tabId, email?}
  since_ms   bigint NOT NULL,                 -- epoch ms, from the caller's clock (LockStore takes `now`)
  seen_ms    bigint NOT NULL,
  request    jsonb,                           -- {name, clientId, tabId, at}
  declined   jsonb,                           -- {name, tabId, at}
  PRIMARY KEY (org_id, record)
);
CREATE INDEX edit_lock_seen ON studio.edit_lock (seen_ms);

-- tokens displaced by a take-over, until their lease would have lapsed
CREATE TABLE studio.edit_lock_displaced (
  org_id     uuid NOT NULL REFERENCES studio.org,
  token      uuid NOT NULL,
  record     text NOT NULL,
  at_ms      bigint NOT NULL,
  until_ms   bigint NOT NULL,
  PRIMARY KEY (org_id, token)
);
CREATE INDEX edit_lock_displaced_until ON studio.edit_lock_displaced (until_ms);
