import type { SupplierId } from './types.ts';

const domains: Record<SupplierId, readonly string[]> = {
  mouser: ['mouser.com', 'mouser.co.uk'],
  digikey: ['digikey.com', 'digikey.ca', 'digikey.co.uk', 'digikey.de', 'digikey.fr', 'digikey.jp', 'digikey.cn', 'digikey.hk', 'digikey.tw', 'digikey.sg', 'digikey.com.au', 'digikey.co.nz'],
  lcsc: ['lcsc.com'],
};

/** Shared supplier-specific safelist for display, persisted quotes and reviewed adoption. */
export function supplierUrl(value: unknown, provider: SupplierId): string | undefined {
  if (typeof value !== 'string' || value.length > 1000) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') && domains[provider]?.some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`)) ? url.href : undefined;
  } catch { return undefined; }
}
