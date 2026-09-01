/**
 * Trading products — the single source of truth for the UI.
 *
 * hand-writing `'INTRADAY' | 'POSITIONAL'` unions: those hand-written lists were INTRADAY/POSITIONAL
 * for years, gained CASHBUY when equity delivery landed, and then silently skipped MTF — so a
 * square-off dropdown offered no way to exit MTF and a CASHBUY strategy showed up in the
 * "Intraday Strategies" bucket.
 */

/** Every product the backend enum defines. */
export type Product = 'INTRADAY' | 'POSITIONAL' | 'CASHBUY' | 'MTF';

/**
 * The products the engine actually opens and squares off positions in — the set every
 * "do this for all products" fan-out must iterate (backend `Product.tradableProducts()`).
 * Every product here is tradable: the book-keeping buckets were retired — INVESTING in V304
 * (duplicated CASHBUY, never traded) and CAPITAL in V305 (moved to CAPITAL_CHANGE_HISTORY).
 */
export type TradableProduct = 'INTRADAY' | 'POSITIONAL' | 'CASHBUY' | 'MTF';

/** Ordered list of the engine-managed products — use for dropdowns, grouping and fan-outs. */
export const TRADABLE_PRODUCTS: readonly TradableProduct[] = ['INTRADAY', 'POSITIONAL', 'CASHBUY', 'MTF'] as const;

/** Human labels for every product. */
export const PRODUCT_LABELS: Record<Product, string> = {
  INTRADAY: 'Intraday',
  POSITIONAL: 'Positional',
  CASHBUY: 'CashBuy (CNC)',
  MTF: 'MTF',
};

/** Label for a product coming off the wire as a plain string (unknown values pass through). */
export const productLabel = (product: string | null | undefined): string => {
  if (!product) return '-';
  return PRODUCT_LABELS[product.toUpperCase() as Product] ?? product;
};

/**
 * Badge tone per product (the `tone` prop of components/ui/Badge). Kept as literals rather than
 * importing the Tone type so this module stays dependency-free.
 */
export const PRODUCT_BADGE_TONE: Record<Product, 'primary' | 'info' | 'success' | 'warning' | 'neutral'> = {
  INTRADAY: 'primary',
  POSITIONAL: 'info',
  CASHBUY: 'success',
  MTF: 'warning',
};

/** Same palette expressed as the legacy react-bootstrap-shim `bg` name. */
export const PRODUCT_BADGE_BG: Record<Product, string> = {
  INTRADAY: 'primary',
  POSITIONAL: 'info',
  CASHBUY: 'success',
  MTF: 'warning',
};

/** Tone for a product string off the wire (unknown → neutral). */
export const productBadgeTone = (product: string | null | undefined) =>
  PRODUCT_BADGE_TONE[(product || '').toUpperCase() as Product] ?? 'neutral';

/** Bootstrap-shim badge colour for a product string off the wire (unknown → secondary). */
export const productBadgeBg = (product: string | null | undefined) =>
  PRODUCT_BADGE_BG[(product || '').toUpperCase() as Product] ?? 'secondary';

/**
 * Broker product-type code each engine product places orders with (the OTHER product concept —
 * `productType` on positions/orders: MIS / NRML / CNC / MTF).
 */
export const PRODUCT_BROKER_PRODUCT_TYPE: Record<TradableProduct, string> = {
  INTRADAY: 'MIS',
  POSITIONAL: 'NRML',
  CASHBUY: 'CNC',
  MTF: 'MTF',
};

/** True for products that carry a position across trading days — mirrors `Product.isCarryForward()`. */
export const isCarryForwardProduct = (product: string | null | undefined): boolean => {
  const p = (product || '').toUpperCase();
  return p === 'POSITIONAL' || p === 'CASHBUY' || p === 'MTF';
};

/** True for the cash-equity delivery products — mirrors `Product.isEquityDelivery()`. */
export const isEquityDeliveryProduct = (product: string | null | undefined): boolean => {
  const p = (product || '').toUpperCase();
  return p === 'CASHBUY' || p === 'MTF';
};

/** Normalise a wire string to a TradableProduct, or undefined when it is not engine-managed. */
export const toTradableProduct = (product: string | null | undefined): TradableProduct | undefined => {
  const p = (product || '').toUpperCase() as TradableProduct;
  return TRADABLE_PRODUCTS.includes(p) ? p : undefined;
};

/**
 * Scope of a square-off request: one tradable product, or ALL of them.
 * Sent to POST /api/v2/trades/squareoff/{product} lower-cased.
 */
export type SquareOffProduct = TradableProduct | 'ALL';

/** Options for a square-off product picker, in menu order (ALL is rendered separately). */
export const SQUARE_OFF_PRODUCT_OPTIONS: { value: TradableProduct; label: string }[] =
  TRADABLE_PRODUCTS.map((value) => ({ value, label: PRODUCT_LABELS[value] }));

/** "You are about to square off <…>" phrasing for a square-off scope. */
export const squareOffScopeLabel = (product: SquareOffProduct): string =>
  product === 'ALL' ? 'all positions' : `${PRODUCT_LABELS[product]} positions`;
