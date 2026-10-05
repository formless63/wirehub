/**
 * The signature of a webhook delivery: HMAC-SHA256 over `<t>.<raw body>` with the
 * subscription's secret, sent as
 *
 *     X-WireHub-Signature: t=<unix seconds>,v1=<hex>
 *
 * The receiver recomputes it over the exact bytes it received, compares in constant
 * time and rejects a timestamp too far from its clock (replay). `verifySignature` is
 * the reference implementation, and what the tests use.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'x-wirehub-signature';

export function signBody(secret: string, body: string, unixSeconds: number): string {
  const mac = createHmac('sha256', secret).update(`${unixSeconds}.${body}`, 'utf8').digest('hex');
  return `t=${unixSeconds},v1=${mac}`;
}

/** Whether `header` is a valid signature of `body` under `secret`, made within `toleranceSeconds` of `nowSeconds`. */
export function verifySignature(secret: string, body: string, header: string | undefined, nowSeconds: number, toleranceSeconds = 300): boolean {
  if (header === undefined) return false;
  const parts = Object.fromEntries(header.split(',').map((p) => {
    const [k, ...v] = p.trim().split('=');
    return [k ?? '', v.join('=')] as const;
  }));
  const t = Number(parts['t']);
  const given = parts['v1'];
  if (!Number.isInteger(t) || given === undefined || Math.abs(nowSeconds - t) > toleranceSeconds) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${body}`, 'utf8').digest();
  const got = Buffer.from(given, 'hex');
  return got.length === expected.length && timingSafeEqual(got, expected);
}
