-- Generated from specs/postgres-backend.md §3 (rev 6.2). Never edit after release:
-- a change is a new migration (§6; migrations/CHECKSUMS).
-- 0001_tenancy
CREATE TABLE studio.org (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  slug        text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- The org id for a configured slug. `org` is itself under RLS, so the app
-- resolves its org once at boot through this (never through an RLS'd query).
CREATE FUNCTION studio.org_id_for(org_slug text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = studio, pg_temp
  AS $$ SELECT id FROM studio.org WHERE slug = org_slug $$;

-- The one org of a single-org deployment (v1), or NULL when there is none or
-- more than one: what the app acts for when WIREHUB_ORG is unset.
CREATE FUNCTION studio.sole_org_id() RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = studio, pg_temp
  AS $$ SELECT CASE WHEN count(*) = 1 THEN min(id::text)::uuid END FROM studio.org $$;

-- One row per org: the catalog version (what `catalogVersion()` answers) and
-- the writers' mutex — every commit takes this row FOR UPDATE first.
CREATE TABLE studio.catalog_head (
  org_id          uuid PRIMARY KEY REFERENCES studio.org,
  version         bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  schema_version  integer NOT NULL,           -- model CURRENT_SCHEMA_VERSION the rows are at
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- The catalog version of an org in one round trip, without a transaction:
-- what `catalogVersion()` asks on every request (S3: ≤ 2 ms p95). Reveals one
-- counter, and only for an org id the caller already knows.
CREATE FUNCTION studio.head_version(org uuid) RETURNS bigint
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = studio, pg_temp
  AS $$ SELECT version FROM studio.catalog_head WHERE org_id = org $$;

CREATE TABLE studio.person (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id        uuid NOT NULL REFERENCES studio.org,
  email         text NOT NULL CHECK (email = lower(email) AND email LIKE '%@%'),
  name          text NOT NULL,
  auth_user_id  text,                         -- auth."user".id (Better Auth ids are text)
  role          text NOT NULL DEFAULT 'editor' CHECK (role IN ('owner', 'editor', 'viewer', 'service')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, email),
  UNIQUE (org_id, auth_user_id)
);
