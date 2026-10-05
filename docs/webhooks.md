# Webhooks: telling other systems what happened

An external system (a company ERP, a PLM, a chat bot, a script) does not need a WireHub module.
It **subscribes** to events, and WireHub POSTs it a signed JSON message when one happens. The
message says what happened, who did it, and where to fetch the details; the system then pulls
what it needs through the API with a token, and can push results back the same way. This replaces
most integration code modules (`docs/modules.md`, "Configuration or code").

```
 WireHub                                    your system
   |  version released (Rev 3 of de9-crossover)
   |------ POST signed JSON ------------------>|   verify the signature, note the event id
   |<----- 2xx -------------------------------|
   |<----- GET /api/designs/de9-crossover/exports/bom.csv?rev=3   (Authorization: Bearer <token>)
   |------ the BOM -------------------------->|   create or update the item
   |<----- PUT/POST /api/…  (a part number, a status)   (Authorization: Bearer <token>)
```

## Subscriptions

Settings, **Webhooks** (owners only, in a signed-in session): add a webhook with a URL and the
events it wants (or all), make its **signing secret** (shown once; the server makes it, or you
can type one of 16 to 256 characters through the API), **Send a test**, turn it on or off. At
most 20 subscriptions. The URL must be `https://` (or `http://` on a private network) with no
`user:password`; redirects are not followed.

The subscriptions are `data/settings/webhooks.json` (owner-only, like the other settings that
name outside systems: not in an editor's export, history or the git mirror). **The secret is not in
it**: it is kept encrypted (AES-256-GCM, the install key `WIREHUB_SETTINGS_KEY`) in the settings
secrets store under `webhook.wh<id>`, write-only, never read back, never in a catalog document,
the export or the history. Without a settings key a secret cannot be kept, and **nothing is ever
sent unsigned**. Removing a subscription removes its secret.

The API (owner, session): `GET`/`PUT /api/settings/webhooks`, `PUT`/`DELETE
/api/settings/webhooks/:id/secret`, `POST /api/settings/webhooks/:id/test`, `GET
/api/settings/webhooks/deliveries`, `POST /api/settings/webhooks/deliveries/:job/redeliver`.

## Events

| Event | When |
| --- | --- |
| `design.saved` | a cable was created, saved, duplicated or renamed (the working copy) |
| `design.deleted` | a cable was deleted |
| `version.saved` | a revision was saved and locked |
| `version.submitted` / `version.approved` / `version.rejected` | the release approval steps (approvals on) |
| `version.released` | a version became the released revision: on save with approvals off, on approve with them on |
| `part-number.assigned` | a number was set or changed on a cable (`productRef`), a drawing, or a library part |
| `product.changed` | a product family was created, changed, merged, split or removed (`docs/products.md`); the payload links the family and the lineup |
| `pack.installed` | a catalog pack was installed, updated or disabled |
| `job.finished` | a background job finished or failed (not a webhook delivery itself) |
| `catalog.changed` | any committed change: the records it touched |
| `webhook.test` | only from **Send a test** |

A save raises its specific event and `catalog.changed`; subscribe to the ones you want.

## The payload

`Content-Type: application/json`, schema `wirehub.event/1` (a new field may be added; a change that
could break a receiver becomes `/2`):

```json
{
  "schema": "wirehub.event/1",
  "id": "6f1c0c0e-…",                       "type": "version.released",
  "occurredAt": "2026-10-05T14:03:11.000Z",
  "hub": { "url": "https://wirehub.example.com", "env": "prod", "version": "0.3.0" },
  "actor": { "name": "Olive Owner", "email": "olive@example.com", "via": "session" },
  "subject": { "kind": "design", "id": "de9-crossover", "label": "DE-9 crossover", "rev": 3 },
  "summary": { "rev": 3, "note": "moved sync to pin 20", "approved": false },
  "links": { "ui": "https://wirehub.example.com/cables/de9-crossover", "api": "https://wirehub.example.com/api/designs/de9-crossover" },
  "fetch": {
    "auth": "GET these with the header \"Authorization: Bearer <API token>\" (Settings, API tokens)",
    "design": "https://wirehub.example.com/api/designs/de9-crossover",
    "version": "https://wirehub.example.com/api/designs/de9-crossover/versions/3",
    "exports": { "bom.csv": "https://wirehub.example.com/api/designs/de9-crossover/exports/bom.csv?rev=3", "production.xlsx": "…", "continuity.json": "…" }
  }
}
```

- `actor.via` is `session`, `token`, `local` or `system`. `subject.kind` is `design`, a library kind
  (`connectors`, `wires` …), `product`, `pack`, `job` or `catalog`.
- `summary` is the **diff summary**, small by construction: for `design.saved`, `changes` (change
  lines such as joints added or moved, at most 30) and counts; for `catalog.changed`, the `records`
  touched (`{ kind, key, op }`, at most 50); for `part-number.assigned`, the field, the number and
  the previous one. The full data is never in the payload: fetch it.
- Links are absolute when the hub knows its public address (`WIREHUB_PUBLIC_URL`), else paths.
- The `fetch` URLs need an **API token** (a person's token from the account page, with their role;
  read tokens are enough to pull). The base API is the same one the exports page and the CLI use
  (`docs/exports.md`).

## Verifying a delivery

Every delivery carries:

```
X-WireHub-Signature: t=1791208991,v1=<hex>
X-WireHub-Event: version.released
X-WireHub-Event-Id: <the event's id>       (the same for a redelivery)
X-WireHub-Delivery: <this delivery's id>   (the same across retries)
```

`v1` is HMAC-SHA256, hex, over `"<t>.<raw request body>"` with the subscription's secret. Recompute
it over the exact bytes you received, compare in constant time, and reject a `t` more than five
minutes from your clock. For example (Node):

```js
import { createHmac, timingSafeEqual } from 'node:crypto';
function verify(secret, rawBody, header, now = Date.now() / 1000) {
  const p = Object.fromEntries(header.split(',').map((x) => x.split('=')));
  if (Math.abs(now - Number(p.t)) > 300) return false;
  const want = createHmac('sha256', secret).update(`${p.t}.${rawBody}`).digest();
  const got = Buffer.from(p.v1 ?? '', 'hex');
  return got.length === want.length && timingSafeEqual(got, want);
}
```

Answer with a 2xx within 10 seconds. Treat the event id as an idempotency key.

## Delivery, retries and the log

A delivery attempt is a job (`webhook`), run by the worker on Postgres and in the server process on
files, so it is recorded like any job (`GET /api/jobs?kind=webhook`; the Jobs page leaves them out, the log below is theirs). A network error, a timeout, `408`,
`425`, `429` or any `5xx` is retried after 30 s, 2 min, 10 min, 1 h and 6 h (six attempts in all;
`WIREHUB_WEBHOOK_BACKOFF` takes other waits in seconds, comma-separated, at most five). Any other
answer (a `4xx` you mean, a redirect) fails at once. On Postgres the waits survive a restart (the
queue holds them); on the file backend a pending retry is held in the process and lost if it
restarts, so use Postgres where delivery must be certain.

Settings, Webhooks shows the **delivery log**: each attempt with its state (`queued`, `running`,
`delivered`, `retrying`, `failed`), the HTTP status and the error. **Redeliver** sends the same
event again as a fresh delivery (same event id, new delivery id). The log keeps the newest 200
attempts on files and what the job history keeps on Postgres.

## The ERP pattern

1. In the ERP, make an API token for a WireHub person with the role it needs (an editor to push back).
2. In Settings, Webhooks, add the ERP's receiver URL for **Version released** (and
   **Part number assigned** if it should hear numbers), make the secret, paste it into the ERP.
3. When a version is released the receiver gets `version.released`, verifies it, then
   `GET <fetch.exports["bom.csv"]>` (and the wire list, cut list or `continuity.json`) with its
   token, and creates or updates its item.
4. To write back (an ERP item number, a status), it calls the API with the same token: `PUT
   /api/designs/:id`, `PUT /api/drawings/:id`, `PUT /api/definitions/…`, or `POST /api/batch` for
   several records as one change set (`docs/self-hosting.md`, "API tokens").

No module, no deployment, no restart. A module is only needed for what the API and these events
cannot do: a custom screen inside WireHub, a new export format, code that must run inside a save.

## Not the alert webhook

Settings, **Notifications** (`WIREHUB_NOTIFY_URL`) is the hub's own **alert** channel: a stale backup,
a failing blob store, failed jobs, an API token created. It is one URL for the operator, in a chat
or ntfy format, unsigned, best effort, and it does not retry. It is deliberately **not folded into**
event webhooks: its payloads are free-form monitoring text, and an operator's phone is a different
audience from an integration. Use event webhooks for systems, the alert URL for people.
