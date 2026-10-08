/**
 * Board and adapter proposals over the API (`@wirehub/model` `proposals.ts`, `docs/resolver.md`):
 *
 *   GET  /api/proposals                       every recorded proposal and its state (open, declined, accepted)
 *   GET  /api/proposals?source=&destination=  the drafts for a device pair the resolver cannot complete,
 *        [&sourcePort=&destinationPort=]      each with its state (a declined one is marked, not offered again)
 *   POST /api/proposals                       { proposal } — file one from elsewhere (a board importer, a module, a script)
 *   POST /api/proposals/decline               { key, reason?, proposal? } — decline it
 *   POST /api/proposals/reopen                { key } — offer it again
 *   POST /api/proposals/accept                { key, id, partNumber?, proposal? } — start a development PCBA from it
 *                                             (numbered by the scheme when no number is given)
 *
 * Decisions are the catalog document `data/proposals.json`, written through the unit of work on both
 * backends; accepting writes the PCBA through the definitions' own checks in the same change set.
 */

import { knownPartNumbers, proposalPcba, proposalProblems, proposeBoards, resolve, type BoardProposal, type ProposalDecision, type ResolveQuery } from '@wirehub/model';

import type { ApiResponse, WorkbenchDeps } from './api.ts';
import { handleDefinitionRequest } from './definitions.ts';
import { readAllDesigns } from './designs.ts';
import { LOCAL_FALLBACK, type StudioUser } from './me.ts';
import { partNumberSchemeOf } from './part-number-scheme.ts';

export const PROPOSALS_PATH = 'data/proposals.json';

export const PROPOSAL_ROUTES = [
  'GET    /api/proposals',
  'POST   /api/proposals',
  'POST   /api/proposals/decline',
  'POST   /api/proposals/reopen',
  'POST   /api/proposals/accept',
] as const;

export const isProposalsPath = (parts: string[]): boolean => parts[0] === 'api' && parts[1] === 'proposals';

const fail = (status: number, error: string, hint?: string, extra?: object): ApiResponse => ({ status, body: { error, ...(hint === undefined ? {} : { hint }), ...(extra ?? {}) } });

async function decisions(deps: WorkbenchDeps): Promise<ProposalDecision[]> {
  const stored = await deps.docs?.read(PROPOSALS_PATH);
  return Array.isArray(stored) ? (stored as ProposalDecision[]) : [];
}

function queryOf(params: URLSearchParams): ResolveQuery | undefined {
  const source = params.get('source');
  const destination = params.get('destination');
  if (source === null || destination === null || source === '' || destination === '') return undefined;
  const sp = params.get('sourcePort');
  const dp = params.get('destinationPort');
  return { source: { device: source, ...(sp === null || sp === '' ? {} : { port: sp }) }, destination: { device: destination, ...(dp === null || dp === '' ? {} : { port: dp }) } };
}

export async function handleProposalsRequest(method: string, parts: string[], path: string, body: unknown, deps: WorkbenchDeps, user: StudioUser | undefined): Promise<ApiResponse> {
  if (deps.docs === undefined) return fail(501, 'This hub does not keep catalog documents by path.');
  const action = parts[2];
  if (parts.length > 3) return fail(404, `${parts.join('/')} is not part of the server API.`, `Try ${PROPOSAL_ROUTES.join('; ')}.`);
  const list = await decisions(deps);

  if (action === undefined && method === 'GET') {
    const query = queryOf(new URLSearchParams(path.split('?')[1] ?? ''));
    if (query === undefined) return { status: 200, body: { proposals: list } };
    const db = await deps.loadDb();
    const resolution = resolve(db, query);
    const state = new Map(list.map((d) => [d.key, d]));
    return {
      status: 200,
      body: {
        proposals: proposeBoards(db, resolution).map((p) => {
          const d = state.get(p.key);
          return { proposal: p, state: d?.state ?? 'open', ...(d?.reason === undefined ? {} : { reason: d.reason }), ...(d?.pcba === undefined ? {} : { pcba: d.pcba }) };
        }),
      },
    };
  }
  if (method !== 'POST') return fail(405, `${method} is not something this address accepts.`, 'GET lists; POST files and decides.');

  const request = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const who = (user ?? deps.localUser ?? LOCAL_FALLBACK).name;
  const at = deps.now?.() ?? new Date().toISOString();
  const put = async (next: ProposalDecision): Promise<ApiResponse> => {
    const rest = list.filter((d) => d.key !== next.key);
    await deps.docs!.write(PROPOSALS_PATH, [...rest, next]);
    return { status: 200, body: { proposals: [...rest, next], decision: next } };
  };
  const proposalOf = (key: string): BoardProposal | undefined => {
    const given = request['proposal'];
    if (given !== undefined && proposalProblems(given).length === 0 && (given as BoardProposal).key === key) return given as BoardProposal;
    return list.find((d) => d.key === key)?.proposal;
  };

  if (action === undefined) {
    const problems = proposalProblems(request['proposal']);
    if (problems.length > 0) return fail(422, `That proposal cannot be filed: ${problems[0]}.`, 'Nothing was saved.', { problems });
    const proposal = request['proposal'] as BoardProposal;
    if (list.some((d) => d.key === proposal.key)) return fail(409, `A proposal '${proposal.key}' is recorded already.`);
    return put({ key: proposal.key, state: 'open', by: who, at, proposal });
  }
  const key = typeof request['key'] === 'string' ? request['key'] : '';
  if (key === '') return fail(400, 'Name the proposal: { "key": … }.');
  const proposal = proposalOf(key);
  if (proposal === undefined) return fail(404, `There is no proposal '${key}'.`, 'Send the proposal with the decision when it was never filed.');
  const reason = typeof request['reason'] === 'string' && request['reason'].trim() !== '' ? request['reason'].trim() : undefined;
  if (action === 'decline') return put({ key, state: 'declined', ...(reason === undefined ? {} : { reason }), by: who, at, proposal });
  if (action === 'reopen') return put({ key, state: 'open', by: who, at, proposal });
  if (action === 'accept') {
    const id = typeof request['id'] === 'string' ? request['id'] : '';
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) return fail(400, 'Give the new board a kebab-case id: { "id": … }.');
    const db = await deps.loadDb();
    // a board needs a number: the one given, else the scheme's next free board number (a proposal a person can change later)
    const given = typeof request['partNumber'] === 'string' && request['partNumber'].trim() !== '' ? request['partNumber'].trim() : undefined;
    const partNumber = given ?? (await partNumberSchemeOf(deps)).suggest({ kind: 'pcba', label: proposal.title, id }, knownPartNumbers(db, await readAllDesigns(deps.designs)))?.pn;
    if (partNumber === undefined) return fail(400, 'Give the new board a number: { "partNumber": … } (the scheme proposes none).');
    const pcba = { ...proposalPcba(db, proposal, id), partNumber };
    const created = await handleDefinitionRequest('POST', ['api', 'definitions', 'pcbas'], pcba, deps);
    if (created === undefined || created.status >= 300) return created ?? fail(409, 'The board could not be created.');
    const answer = await put({ key, state: 'accepted', ...(reason === undefined ? {} : { reason }), by: who, at, pcba: id, proposal });
    return { ...answer, status: 201, body: { ...(answer.body as object), pcba: created.body } };
  }
  return fail(404, `${parts.join('/')} is not part of the server API.`, `Try ${PROPOSAL_ROUTES.join('; ')}.`);
}
