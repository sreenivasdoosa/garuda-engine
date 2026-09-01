/**
 * The glyph for a currency code.
 *
 * Only the codes the engine's own `Currency` enum carries. Unknown codes get
 * the code back rather than a guess or a blank: a figure showing the wrong
 * currency symbol is worse than one showing none, because nothing about it
 * looks wrong.
 */
const SYMBOLS: Record<string, string> = {
  INR: '₹',
  USD: '$',
  EUR: '€',
  GBP: '£',
  JPY: '¥',
  AED: 'د.إ',
  SGD: 'S$',
  HKD: 'HK$',
  AUD: 'A$',
};

export function currencySymbol(code: string | null | undefined): string {
  if (!code) return '';
  return SYMBOLS[code.toUpperCase()] ?? code.toUpperCase();
}
