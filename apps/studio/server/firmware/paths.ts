/** Document paths of firmware commissioning, with no imports (the API router reads them). */

/** The generic document routes must not write these: a commission goes through its own route. */
export const isCommissionDocPath = (path: string): boolean => /^(data\/)?firmware\/commissions\//.test(path);
