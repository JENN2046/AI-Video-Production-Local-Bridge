/**
 * Director Grants store money in integer minor units while the existing
 * RunningHub preflight stores its official estimate in the provider's normal
 * display unit. Keep the conversion deliberately small and closed: adding a
 * currency needs an explicit precision decision and test.
 */
export const DIRECTOR_SUPPORTED_CURRENCIES = ["CNY", "RH_COINS"] as const;

export type DirectorSupportedCurrency = (typeof DIRECTOR_SUPPORTED_CURRENCIES)[number];

const MINOR_UNIT_SCALE: Readonly<Record<DirectorSupportedCurrency, number>> = Object.freeze({
  CNY: 100,
  RH_COINS: 1
});

function scaleFor(currency: string): number | null {
  const normalized = currency.trim().toUpperCase();
  if (!DIRECTOR_SUPPORTED_CURRENCIES.includes(normalized as DirectorSupportedCurrency)) return null;
  return MINOR_UNIT_SCALE[normalized as DirectorSupportedCurrency];
}

export function directorProviderAmountToMinor(amount: number, currency: string): number | null {
  const scale = scaleFor(currency);
  if (scale === null || !Number.isFinite(amount) || amount <= 0) return null;
  const rounded = Math.round(amount * scale);
  // JSON numeric values are binary floats. Permit only the representation
  // noise introduced by parsing a value with the configured minor precision.
  if (!Number.isSafeInteger(rounded) || Math.abs((rounded / scale) - amount) > 1e-9) return null;
  return rounded;
}

export function directorMinorToProviderAmount(amountMinor: number, currency: string): number | null {
  const scale = scaleFor(currency);
  if (scale === null || !Number.isSafeInteger(amountMinor) || amountMinor <= 0) return null;
  return amountMinor / scale;
}
