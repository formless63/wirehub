/** The environment guard (plan §8.7): every refusal, as a table. */

import { describe, expect, it } from 'vitest';

import { environmentRefusal } from '../server/env-guard.ts';

const cases: [string, Record<string, string>, RegExp | undefined][] = [
  ['unset: development from source', {}, undefined],
  ['an unknown environment', { WIREHUB_ENV: 'staging' }, /must be 'dev' or 'prod'/],
  ['prod on the database', { WIREHUB_ENV: 'prod', WIREHUB_BACKEND: 'pg' }, undefined],
  ['prod on files', { WIREHUB_ENV: 'prod', WIREHUB_BACKEND: 'files' }, /WIREHUB_ALLOW_FILES_IN_PROD/],
  ['prod on files by default backend', { WIREHUB_ENV: 'prod' }, /WIREHUB_ALLOW_FILES_IN_PROD/],
  ['prod on files, on purpose', { WIREHUB_ENV: 'prod', WIREHUB_BACKEND: 'files', WIREHUB_ALLOW_FILES_IN_PROD: '1' }, undefined],
  ['dev on its own database', { WIREHUB_ENV: 'dev', WIREHUB_BACKEND: 'pg', DATABASE_URL: 'postgres://u:p@db-dev:5432/wirehub_dev', WIREHUB_PROD_MARKERS: 'db-prod,wirehub-prod' }, undefined],
  ['dev pointed at the production database', { WIREHUB_ENV: 'dev', DATABASE_URL: 'postgres://u:p@db-prod:5432/wirehub', WIREHUB_PROD_MARKERS: 'db-prod' }, /the database matches the production marker 'db-prod'/],
  ['dev pointed at the production bucket', { WIREHUB_ENV: 'dev', S3_BUCKET: 'wirehub-prod', WIREHUB_PROD_MARKERS: 'db-prod, wirehub-prod' }, /the bucket matches/],
  ['dev with no markers', { WIREHUB_ENV: 'dev', DATABASE_URL: 'postgres://u:p@db-prod:5432/x' }, undefined],
];

describe('environment guard', () => {
  for (const [name, env, refusal] of cases) {
    it(name, () => {
      const answer = environmentRefusal(env);
      if (refusal === undefined) expect(answer).toBeUndefined();
      else expect(answer).toMatch(refusal);
    });
  }
});
