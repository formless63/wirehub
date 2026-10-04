-- Generated from specs/postgres-backend.md §3 (rev 6.2). Never edit after release:
-- a change is a new migration (§6; migrations/CHECKSUMS).
-- 0013_api_tokens — personal API tokens (§4.5)
CREATE TABLE auth.api_token (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id        uuid NOT NULL,                  -- studio.org.id
  person_id     uuid NOT NULL,                  -- studio.person.id: the token acts as this person, and only as this person
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),   -- the person's label: "laptop scripts"
  env           text NOT NULL CHECK (env IN ('dev', 'prod')),          -- must equal WIREHUB_ENV; also the token's prefix
  token_sha256  text NOT NULL UNIQUE CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
  scopes        text[] NOT NULL CHECK ('read' = ANY (scopes)),        -- 'read', 'catalog:write', 'imports', and '<module>:<scope>'
  expires_at    timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid NOT NULL,                  -- = person_id; nobody creates a token for someone else
  last_used_at  timestamptz,                    -- updated at most once a minute
  revoked_at    timestamptz,
  revoked_by    uuid,                           -- the person, or an owner
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '90 days')
);
CREATE INDEX api_token_person ON auth.api_token (person_id) WHERE revoked_at IS NULL;
GRANT SELECT, INSERT, UPDATE ON auth.api_token TO studio_app;   -- no DELETE: a revoked token stays, for the audit
