/**
 * Money is always integer minor units (cents) + an ISO-4217 code — never a float. This mirrors the
 * invariant used throughout the production backend. The AI tools speak *major* units (what a person
 * says: "twenty-five dollars") and the conversion to minor units happens here, in one place.
 */

const ZERO_DECIMAL = new Set(["BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"]);
const THREE_DECIMAL = new Set(["BHD", "IQD", "JOD", "KWD", "OMR", "TND"]);

export function currencyDecimals(currency: string): number {
  return ZERO_DECIMAL.has(currency) ? 0 : THREE_DECIMAL.has(currency) ? 3 : 2;
}

/** Integer minor units → major-unit number + display string, e.g. 2900 USD → 29.00. */
export function minorToMajorParts(amountMinor: number, currency: string): { value: number; display: string } {
  const d = currencyDecimals(currency);
  const display = (amountMinor / 10 ** d).toFixed(d);
  return { value: Number(display), display };
}

/** Major-unit number → integer minor units, e.g. 29.00 USD → 2900. */
export function majorToMinor(amountMajor: number, currency: string): number {
  const d = currencyDecimals(currency);
  return Math.round(amountMajor * 10 ** d);
}

export function assertSafeInteger(amountMinor: number, name = "amount"): void {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}
