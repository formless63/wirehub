-- Generated from specs/postgres-backend.md §3 (rev 6.13). Never edit after release:
-- a change is a new migration (§6; migrations/CHECKSUMS).
-- 0025_api_token_budget — a token's write budget (draft-work grants for agents, docs/mcp.md)
-- A token may cap its real writes: an agent's draft-work grant (`drafts:write`) gets a budget
-- and a short life. Dry runs and edit-lock leases are not counted; a refused write is given back.
ALTER TABLE auth.api_token
  ADD COLUMN write_budget integer CHECK (write_budget IS NULL OR write_budget BETWEEN 1 AND 10000),
  ADD COLUMN writes_used  integer NOT NULL DEFAULT 0 CHECK (writes_used >= 0);
