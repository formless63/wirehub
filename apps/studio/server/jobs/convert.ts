/**
 * The `convert` job: a person's STEP upload, converted by the worker
 * (`specs/postgres-backend.md` §5.2, §5.5). A STEP conversion peaks at about
 * 1.1 GB in its capped child — more than the studio's memory budget (S6) —
 * so on the database backend the studio hands it to the worker, whose
 * budget is sized for one conversion at a time, and waits for the answer.
 * The upload's request and response do not change. GLB and STL are cheap
 * and stay in the studio; the file backend converts everything in process,
 * as it always has.
 *
 * Bytes travel through the blob store, under the job's own keys
 * (`<org>/jobs/…`), which no row names: the studio deletes them once it has
 * the answer, and GC removes any left behind after a day (§5.4).
 */

import { createHash } from 'node:crypto';

import type { BlobStore } from '../blobs.ts';
import { convertModel, ModelRefusal, sniffModel, STEP_TIMEOUT_MS, type ConvertedModel } from '../models/convert.ts';
import type { ConversionStats } from '../models/finish.ts';
import type { JobContext, JobOutcome, JobService } from './types.ts';

const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

export function convertInputKey(orgId: string, sha: string): string {
  return `${orgId}/jobs/convert/${sha}.input`;
}

export function convertOutputKey(orgId: string, jobId: string): string {
  return `${orgId}/jobs/convert/${jobId}.glb`;
}

interface ConvertRequest {
  name: string;
  input: { key: string; sha256: string; size: number };
}

/** The worker's half: read the upload, convert it in the capped child, leave the GLB in the blob store. */
export async function runConvertJob(context: JobContext, options: { blobs: BlobStore; orgId: string; convert?: typeof convertModel }): Promise<JobOutcome> {
  const request = context.job.request as unknown as ConvertRequest;
  const bytes = await options.blobs.get(request.input.key);
  if (bytes === undefined) throw new Error('the uploaded file is gone from the blob store');
  if (sha256(bytes) !== request.input.sha256) throw new Error('the uploaded file does not match its checksum');
  await context.step(`converting ${request.name} (${bytes.byteLength} bytes)`);
  try {
    const converted = await (options.convert ?? convertModel)(new Uint8Array(bytes), request.name);
    const key = convertOutputKey(options.orgId, context.job.id);
    await options.blobs.put(key, Buffer.from(converted.glb), 'model/gltf-binary');
    return { result: { format: converted.format, stats: converted.stats, output: { key, sha256: sha256(converted.glb), size: converted.glb.byteLength } } };
  } catch (error) {
    // a refusal is an answer (the person reads it), not a failed job
    if (error instanceof ModelRefusal) return { result: { refused: { message: error.message, hint: error.hint } } };
    throw error;
  }
}

/** How long the studio waits for the worker: a queued conversion, then the child's own limit. */
export const REMOTE_CONVERT_TIMEOUT_MS = STEP_TIMEOUT_MS + 300_000;

/**
 * The studio's `convertModel` on the database backend: STEP goes to the
 * worker (`convert` job) and the request waits for it; everything else
 * converts here, as before.
 */
export function remoteConvert(options: { jobs: JobService; blobs: BlobStore; orgId: () => string; timeoutMs?: number; who?: string }): (bytes: Uint8Array, name: string) => Promise<ConvertedModel> {
  return async (bytes, name) => {
    if (sniffModel(bytes) !== 'step') return convertModel(bytes, name);
    // the same checks the in-process converter makes first: a refusal costs no job
    if (!/\.(step|stp)$/i.test(name)) return convertModel(bytes, name);
    const orgId = options.orgId();
    const input = { key: convertInputKey(orgId, sha256(bytes)), sha256: sha256(bytes), size: bytes.byteLength };
    await options.blobs.put(input.key, Buffer.from(bytes), 'application/octet-stream');
    const job = await options.jobs.enqueue('convert', { name, input });
    let done;
    try {
      done = await options.jobs.wait(job.id, options.timeoutMs ?? REMOTE_CONVERT_TIMEOUT_MS);
    } catch {
      throw new ModelRefusal(`${name} was not converted in time.`, 'The worker may be busy or stopped (docker compose ps worker); try again later, or upload STL/GLB.');
    } finally {
      await options.blobs.delete(input.key).catch(() => undefined);
    }
    if (done.status !== 'done') throw new ModelRefusal(`${name} could not be converted: ${done.error ?? done.status}.`, 'Check the file opens in a CAD tool, or export STL/GLB instead.');
    const result = done.result ?? {};
    const refused = result['refused'] as { message: string; hint: string } | undefined;
    if (refused !== undefined) throw new ModelRefusal(refused.message, refused.hint);
    const output = result['output'] as { key: string; sha256: string };
    const glb = await options.blobs.get(output.key);
    await options.blobs.delete(output.key).catch(() => undefined);
    if (glb === undefined || sha256(glb) !== output.sha256) throw new ModelRefusal(`${name} was converted, but the result went missing.`, 'Try the upload again.');
    return { glb: new Uint8Array(glb), format: 'step', stats: result['stats'] as ConversionStats };
  };
}
