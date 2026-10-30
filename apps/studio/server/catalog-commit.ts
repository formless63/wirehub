/**
 * Committing a unit of work and telling the event stream the catalog moved:
 * the two helpers feature handlers (jobs, enclosures, code modules, setup)
 * call after a write. They live here, not in `api.ts`, so those handlers
 * need no runtime import of the router that imports them.
 */

import type { ApiRequest, ApiResponse, WorkbenchDeps } from './api.ts';
import { staleWriteResponse } from './etag.ts';
import { CommitRefusedError, ReadOnlyBackendError, StaleRecordError } from './storage/change-set.ts';
import type { UnitOfWork } from './storage/unit-of-work.ts';

function fail(status: number, error: string, hint?: string): ApiResponse {
  return { status, body: { error, ...(hint === undefined ? {} : { hint }) } };
}

/** Tell the event stream the catalog moved (a backend that hears its own NOTIFY drops this). */
export async function publishCatalog(deps: WorkbenchDeps): Promise<void> {
  if (deps.events === undefined) return;
  deps.events.publish({ type: 'catalog', version: String((await deps.catalogVersion?.()) ?? '') });
}

/**
 * Commit what a unit of work staged when the handler answered < 400, mapping
 * a stale precondition to the 409 and a read-only backend to 503 — nothing
 * is written in either case.
 */
export async function commitUnit(uow: UnitOfWork, request: Pick<ApiRequest, 'method' | 'path' | 'user' | 'body'>, response: ApiResponse): Promise<ApiResponse> {
  if (response.status >= 400) return response;
  try {
    await uow.commit({
      method: request.method.toUpperCase(),
      path: request.path,
      ...(request.user === undefined ? {} : { user: request.user }),
      ...(request.body === undefined ? {} : { body: request.body }),
      ...(request.user?.apiTokenId === undefined ? {} : { apiTokenId: request.user.apiTokenId }),
    });
  } catch (error) {
    if (error instanceof StaleRecordError) return staleWriteResponse(error.kind, error.key);
    if (error instanceof CommitRefusedError) return fail(error.status, error.message, error.hint);
    if (error instanceof ReadOnlyBackendError) return fail(503, error.message, 'Nothing was written. This hub serves its catalog read-only for now.');
    throw error;
  }
  return response;
}
