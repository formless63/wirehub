# Agents over MCP

WireHub serves the [Model Context Protocol](https://modelcontextprotocol.io) at **`/api/mcp`**
(Streamable HTTP, built with the official TypeScript SDK). An agent client — Claude Code, another
MCP client, or your own script — connects with a **personal API token** and works through the same
operations the editor uses: the same permission checks, edit locks, `If-Match` concurrency, dry
runs, batches and change sets. No AI service runs inside WireHub, and none is needed to use it.

## Connect

1. In WireHub open **Account › API tokens** (`/account/tokens`) and create a token for the agent.
   For an agent doing a bounded piece of work, tick **draft work only** (scope `drafts:write`),
   give it a **write budget** and a short expiry (1 or 8 hours). The token is shown once.
2. Point the client at `https://<your hub>/api/mcp` with the header
   `Authorization: Bearer <token>`.

Claude Code:

```sh
claude mcp add --transport http wirehub https://wirehub.example.com/api/mcp \
  --header "Authorization: Bearer $WIREHUB_API_TOKEN"
```

Any client that takes a JSON server list:

```json
{ "mcpServers": { "wirehub": { "type": "http", "url": "https://wirehub.example.com/api/mcp",
  "headers": { "Authorization": "Bearer ${WIREHUB_API_TOKEN}" } } } }
```

From the repository, the bundled probe uses the SDK's own client:

```sh
WIREHUB_API_URL=http://localhost:5183 WIREHUB_API_TOKEN=cst_… pnpm --filter studio mcp-probe
WIREHUB_API_URL=… WIREHUB_API_TOKEN=… pnpm --filter studio mcp-probe call get_design '{"id":"de9-crossover"}'
WIREHUB_API_URL=… WIREHUB_API_TOKEN=… pnpm --filter studio mcp-probe draft-edit de9-crossover
```

The endpoint is served by the standalone server (`pnpm --filter studio start`, the container
image). With sign-in off it is as open as the rest of that host's API; keep such a host private.

## Tools

| Tool | Does |
| --- | --- |
| `whoami` | The person the token acts as, their role, its scopes and remaining write budget |
| `list_designs`, `search_library` | Find designs and library items (connectors, components, wires, boards, bodies, interfaces, mechanicals, kits) by words |
| `get_design` | A design's JSON, its `etag`, check counts, its resolved cover and the documents it renders |
| `get_library_item` | A record with its `etag`, where it is used, its 3D model link and, for a board, its resolved cover |
| `create_design`, `update_design` | Create (or duplicate) a working design; change one by JSON merge patch or whole document |
| `save_library_item` | Create a library record, or replace one quoting its `etag` |
| `validate_design` | The design checks on the stored copy, or on a candidate without saving it |
| `list_documents`, `generate_document` | Render a schematic, build sheet, BOM, test spec, drawing, labels or formboard |
| `apply_batch` | Several writes as one change set: all or nothing |
| `list_jobs`, `get_job`, `submit_job`, `cancel_job` | Background jobs |
| `explore` | Ranked combinations of what the library has for a requirement (connect two devices, or enclose a board): valid, invalid (why) or unknown (which facts), with choices, facts and shortages (`docs/explore.md`) |
| `explore_pick` | One combination made a working draft (a design, or a shell part) and the pick kept on the saved exploration, as one change set |

Resources: `wirehub://guide` (how the tools fit together) and `wirehub://designs/{id}`.

## Rules the agent works under

- **It is the token's person.** Their current role and the token's scopes apply to every tool call;
  a viewer's token only reads. Each tool's requests are checked as ordinary API requests, so
  nothing is reachable through MCP that the token could not do over HTTP.
- **Read, then write with the `etag`.** A write quotes the `etag` it read; if the record changed in
  between, it is refused (409) and nothing is written. A record a person holds open is refused
  (423). The agent reads again rather than overwriting.
- **Preview freely.** Every write tool takes `dryRun: true`: the answer is the would-be change set
  (per record: before/after version, RFC 6902 patch, line diff) and what it would derive. Nothing is
  written, and no budget is spent.
- **Draft-work grants** (`drafts:write`) create and edit working designs and library items, run and
  cancel jobs, and take edit-lock leases. They never delete, rename, save, approve or release a
  version, publish an import, or change settings, packs or modules — those stay a person's
  deliberate act in the app. A batch from such a token may only hold draft writes.
- **Budgets.** A token may carry a write budget (1–10 000). Each real write spends one (a batch one
  per request in it); dry runs and lock leases are free; a refused write is given back. When it is
  spent, writes are refused and reads keep working. The token list shows writes used.
- **Every change is reviewable and reversible.** Each committed write is a change set in
  **History**, attributed to the token's person; any record can be restored from there. All of a
  token's change sets form one **agent checkpoint** (History › Agent, or `whoami`'s `checkpoint`):
  a person reviews them together and **undoes them together** in one new change set — unless
  someone else changed one of those records since, in which case nothing is undone and the page
  names the record. The agent's own token cannot undo (it is not draft work). Revoke the
  token at any time in Account › API tokens; the next request is refused.
