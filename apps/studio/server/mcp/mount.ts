/**
 * `/api/mcp` — the Model Context Protocol endpoint (Streamable HTTP, the
 * official TypeScript SDK's `createMcpHandler`; `docs/mcp.md`).
 *
 * Stateless: every POST builds a fresh server whose tools call the API in
 * process as the caller (`api-client.ts`). Being under `/api/`, the endpoint
 * sits behind the login gate like every other route: with sign-in on it takes
 * a personal API token (`Authorization: Bearer cst_…`, any scope — each tool's
 * own requests are checked as themselves) or a session; with sign-in off it is
 * as open as the rest of the API on that host.
 */

import type { Hono } from 'hono';
import { createMcpHandler } from '@modelcontextprotocol/server';

import { crossSiteRefusal } from '../request-guard.ts';
import { inProcessClient, type Dispatch } from './api-client.ts';
import { createWireHubMcpServer } from './tools.ts';

export const MCP_PATH = '/api/mcp';
/** a whole design document fits; the API's own caps apply to each tool's requests */
const MAX_MCP_BODY = 8 * 1024 * 1024;

export function mountMcp(app: Hono, dispatch: Dispatch): void {
  // the factory runs once per request; the request's credentials ride along on `requestInfo`
  const handler = createMcpHandler(
    (ctx) => {
      if (ctx.requestInfo === undefined) throw new Error('The WireHub MCP endpoint serves HTTP requests only.');
      return createWireHubMcpServer(inProcessClient(dispatch, ctx.requestInfo));
    },
    {
      maxRequestBodySize: MAX_MCP_BODY,
      onerror: (error) => console.warn(`[mcp] ${error.message}`),
    },
  );
  app.all(MCP_PATH, async (c) => {
    // a session cookie is ambient: the API's cross-site rule (a bearer token is not, §4.5)
    if (!/^bearer\s/i.test(c.req.header('authorization') ?? '')) {
      const crossSite = crossSiteRefusal({
        method: c.req.method,
        origin: c.req.header('origin'),
        secFetchSite: c.req.header('sec-fetch-site'),
        host: c.req.header('x-forwarded-host') ?? c.req.header('host') ?? new URL(c.req.url).host,
      });
      if (crossSite !== undefined) return c.json(crossSite.body, crossSite.status as 403);
    }
    return handler.fetch(c.req.raw);
  });
}
