#!/usr/bin/env -S node --experimental-strip-types
/**
 * `mcp-probe`: talk to a WireHub's MCP endpoint with the official MCP client,
 * the way an agent would (`docs/mcp.md`).
 *
 *   WIREHUB_API_URL=http://127.0.0.1:5183 WIREHUB_API_TOKEN=cst_… \
 *     pnpm --filter studio mcp-probe                       list tools, who am I, a few designs
 *   … mcp-probe call <tool> '<json arguments>'             one tool call, its answer printed
 *   … mcp-probe draft-edit <design id> [label suffix]      a bounded draft change: dry run, write,
 *                                                         a stale write refused, a non-draft write refused
 *   … mcp-probe checkpoint <design id> <connector id>      an agent session of several edits (two design
 *                                                         saves, a copy, a library edit): one checkpoint
 *   … mcp-probe explore '<requirement json>' [pick]        ranked combinations; with "pick", the best
 *                                                         pickable one made a draft
 *
 * Nothing here holds rules: every answer is the server's.
 */

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const base = (process.env['WIREHUB_API_URL'] ?? 'http://127.0.0.1:5183').replace(/\/+$/, '');
const token = process.env['WIREHUB_API_TOKEN'] ?? '';

type ToolAnswer = { isError?: boolean; content: { type: string; text?: string; resource?: { uri: string; mimeType?: string; text?: string; blob?: string } }[] };

function show(label: string, answer: ToolAnswer): unknown {
  const first = answer.content.find((c) => c.type === 'text')?.text ?? '';
  let parsed: unknown = first;
  try {
    parsed = JSON.parse(first);
  } catch {
    // plain text
  }
  const text = typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2);
  console.log(`\n── ${label}${answer.isError === true ? '  (refused)' : ''}\n${text.length > 1500 ? `${text.slice(0, 1500)}\n…` : text}`);
  for (const c of answer.content) if (c.type === 'resource') console.log(`   + resource ${c.resource?.uri} (${c.resource?.mimeType}, ${(c.resource?.text ?? c.resource?.blob ?? '').length} chars)`);
  return parsed;
}

async function main(argv: string[]): Promise<number> {
  if (token === '') {
    console.error('Set WIREHUB_API_TOKEN to a personal API token (Account › API tokens).');
    return 2;
  }
  const client = new Client({ name: 'wirehub-mcp-probe', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/api/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<ToolAnswer> => (await client.callTool({ name, arguments: args })) as ToolAnswer;
  try {
    const [command, ...rest] = argv;
    if (command === 'call') {
      const [name, json] = rest;
      if (name === undefined) throw new Error('usage: mcp-probe call <tool> [json]');
      show(name, await call(name, json === undefined ? {} : (JSON.parse(json) as Record<string, unknown>)));
      return 0;
    }
    if (command === 'draft-edit') {
      const [id, suffix = '(agent draft)'] = rest;
      if (id === undefined) throw new Error('usage: mcp-probe draft-edit <design id> [label suffix]');
      show('whoami', await call('whoami'));
      const read = show('get_design (summary)', await call('get_design', { id, summaryOnly: true })) as { etag: string; label: string };
      const label = `${read.label} ${suffix}`;
      show('update_design dry run', await call('update_design', { id, ifMatch: read.etag, merge: { label }, dryRun: true }));
      const written = show('update_design', await call('update_design', { id, ifMatch: read.etag, merge: { label } })) as { etag?: string };
      show('update_design with the old etag (must be refused: 409)', await call('update_design', { id, ifMatch: read.etag, merge: { label: `${label}!` } }));
      show('apply_batch with a rename (not draft work: must be refused)', await call('apply_batch', { message: 'probe', requests: [{ method: 'POST', path: `/api/designs/${id}/rename`, body: { newId: `${id}-renamed` } }] }));
      show('validate_design', await call('validate_design', { id }));
      show('whoami (budget after)', await call('whoami'));
      console.log(`\nOpen ${base}/cables/${id} to see "${label}" (etag now ${written.etag ?? '?'}).`);
      return 0;
    }
    if (command === 'checkpoint') {
      const [id, connector] = rest;
      if (id === undefined || connector === undefined) throw new Error('usage: mcp-probe checkpoint <design id> <connector id>');
      show('whoami', await call('whoami'));
      const read = show('get_design (summary)', await call('get_design', { id, summaryOnly: true })) as { etag: string; label: string };
      const first = show('update_design: label', await call('update_design', { id, ifMatch: read.etag, merge: { label: `${read.label} (agent edit)` } })) as { etag: string };
      show('update_design: notes', await call('update_design', { id, ifMatch: first.etag, merge: { notes: 'Checked by an agent: synthetic example.' } }));
      show('create_design: a copy', await call('create_design', { duplicateOf: id, newId: `${id}-agent-copy`, newLabel: `${read.label} (agent copy)` }));
      const item = show('get_library_item', await call('get_library_item', { kind: 'connectors', id: connector })) as { etag: string; record: Record<string, unknown> };
      show('save_library_item: description', await call('save_library_item', { kind: 'connectors', ifMatch: item.etag, item: { ...item.record, description: `${String(item.record['description'] ?? '')} (agent note)`.trim() } }));
      show('whoami (budget after; the checkpoint to review)', await call('whoami'));
      return 0;
    }
    if (command === 'explore') {
      const [json, pick] = rest;
      if (json === undefined) throw new Error("usage: mcp-probe explore '<requirement json>' [pick]");
      const requirement = JSON.parse(json) as Record<string, unknown>;
      const found = show('explore', await call('explore', { requirement, limit: 5 })) as { combos?: { id: string; pickable: boolean }[] };
      const best = found.combos?.find((c) => c.pickable);
      if (pick === 'pick' && best !== undefined) {
        show('explore_pick dry run', await call('explore_pick', { requirement, combo: best.id, dryRun: true }));
        show('explore_pick', await call('explore_pick', { requirement, combo: best.id }));
      }
      return 0;
    }
    const { tools } = await client.listTools();
    console.log(`${tools.length} tools: ${tools.map((t) => t.name).join(', ')}`);
    const { resources } = await client.listResources();
    console.log(`resources: ${resources.map((r) => r.uri).join(', ')}`);
    show('whoami', await call('whoami'));
    show('list_designs', await call('list_designs', { limit: 5 }));
    return 0;
  } finally {
    await client.close();
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
