/**
 * Client-side algo-vs-broker position mismatch computation (doc §5.6, Q18) — the TS
 * counterpart of the server's calculatePositionMismatches, fed by the two position
 * lists already in the live store.
 *
 * The worthless-qty business rule itself stays SERVER-side: algo rows arrive with
 * worthlessQty stamped (signed residual qty of system-completed worthless option legs
 * that legitimately remain at the broker until expiry settlement). Here it is plain
 * arithmetic: expected broker qty = algoQty + worthlessQty.
 *
 * Paper rows never reconcile against the broker and are excluded.
 *
 * The flag math here is a faithful port of the server's
 * PositionMismatch.calculateMismatch (qtyDiff, pnlDiff%, explainedByCompleted, and the
 * 10% P&L threshold) so the client and server agree on what is/ isn't a mismatch. The
 * ONLY difference is presentation: the server returns just the flagged rows, whereas this
 * returns every reconciled row too (the live terminal shows all positions with an OK/
 * mismatch status), so callers filter with hasQtyMismatch/hasSymbolMismatch as needed.
 */

import type { LivePosition } from '@/types/user-live';

export interface ComputedMismatch {
  tradingSymbol: string;
  productType: string;
  existsInAlgo: boolean;
  existsInBroker: boolean;
  algoQty: number;
  brokerQty: number;
  /** Signed residual qty explained by system-completed worthless legs (server-stamped). */
  worthlessQty: number;
  /** brokerQty - worthlessQty — what the broker SHOULD show if algo and broker agree. */
  adjustedBrokerQty: number;
  qtyDifference: number;
  hasQtyMismatch: boolean;
  hasSymbolMismatch: boolean;
  algoAvgPrice: number;
  brokerAvgPrice: number;
  algoPnl: number;
  brokerPnl: number;
  pnlDifference: number;
  /** Server parity: pnlDiff% (relative to |algoPnl|) exceeds PNL_MISMATCH_THRESHOLD_PERCENT. */
  hasPnlMismatch: boolean;
}

/**
 * P&L mismatch threshold — must mirror UserTradeSummaryService.PNL_MISMATCH_THRESHOLD_PERCENT
 * on the server (a row is flagged when broker-vs-algo P&L diverges by more than this %).
 */
const PNL_MISMATCH_THRESHOLD_PERCENT = 10.0;

const keyOf = (pos: LivePosition): string => `${pos.tradingSymbol}|${pos.productType}`;

export function computeMismatches(
  algoPositions: LivePosition[],
  brokerPositions: LivePosition[],
): ComputedMismatch[] {
  const algoByKey = new Map<string, LivePosition>();
  for (const pos of algoPositions) {
    if (!pos.isPaperTrading) algoByKey.set(keyOf(pos), pos);
  }
  const brokerByKey = new Map<string, LivePosition>();
  for (const pos of brokerPositions) {
    if (!pos.isPaperTrading) brokerByKey.set(keyOf(pos), pos);
  }

  const keys = new Set<string>([...algoByKey.keys(), ...brokerByKey.keys()]);
  const result: ComputedMismatch[] = [];

  for (const key of keys) {
    const algo = algoByKey.get(key);
    const broker = brokerByKey.get(key);
    const worthlessQty = algo?.worthlessQty ?? 0;

    const algoQty = algo?.netQty ?? 0;
    const brokerQty = broker?.netQty ?? 0;
    const adjustedBrokerQty = brokerQty - worthlessQty;
    // Server parity (PositionMismatch.calculateMismatch): qtyDiff subtracts the
    // system-completed worthless qty so only the genuine gap remains.
    const qtyDifference = brokerQty - algoQty - worthlessQty; // == adjustedBrokerQty - algoQty

    const existsInAlgo = !!algo;
    const existsInBroker = !!broker;

    const algoPnl = algo?.totalPnl ?? 0;
    const brokerPnl = broker?.totalPnl ?? 0;
    const pnlDifference = Math.round((brokerPnl - algoPnl) * 100) / 100;
    // P&L mismatch % — server convention: relative to |algoPnl|; if algo has no
    // P&L but broker does, it's a full 100% divergence.
    let pnlDiffPercent: number;
    if (algoPnl !== 0) {
      pnlDiffPercent = Math.abs(pnlDifference / Math.abs(algoPnl)) * 100;
    } else if (brokerPnl !== 0) {
      pnlDiffPercent = 100;
    } else {
      pnlDiffPercent = 0;
    }

    // When the broker overhang is fully explained by system-completed worthless
    // legs (qtyDiff nets to 0 after subtracting them), the row is reconciled:
    // symbol-presence and P&L noise are expected and must NOT raise flags.
    const explainedByCompleted = worthlessQty !== 0 && qtyDifference === 0;

    // Pure existence-XOR, gated by explainedByCompleted — identical to the server.
    const hasSymbolMismatch =
      !explainedByCompleted &&
      ((existsInAlgo && !existsInBroker) || (!existsInAlgo && existsInBroker));
    const hasPnlMismatch = !explainedByCompleted && pnlDiffPercent > PNL_MISMATCH_THRESHOLD_PERCENT;

    const mismatch: ComputedMismatch = {
      tradingSymbol: (algo ?? broker)!.tradingSymbol,
      productType: (algo ?? broker)!.productType,
      existsInAlgo,
      existsInBroker,
      algoQty,
      brokerQty,
      worthlessQty,
      adjustedBrokerQty,
      qtyDifference,
      hasQtyMismatch: qtyDifference !== 0,
      hasSymbolMismatch,
      algoAvgPrice: algo?.netAvgPrice ?? 0,
      brokerAvgPrice: broker?.netAvgPrice ?? 0,
      algoPnl,
      brokerPnl,
      pnlDifference,
      hasPnlMismatch,
    };
    result.push(mismatch);
  }

  // Mismatches first, then by symbol — matches the existing compare-table ordering.
  result.sort((a, b) => {
    const aBad = a.hasQtyMismatch || a.hasSymbolMismatch;
    const bBad = b.hasQtyMismatch || b.hasSymbolMismatch;
    if (aBad !== bBad) return aBad ? -1 : 1;
    return a.tradingSymbol.localeCompare(b.tradingSymbol);
  });
  return result;
}

/** Count of rows that should light the mismatch badge. */
export function mismatchCount(mismatches: ComputedMismatch[]): number {
  return mismatches.filter((m) => m.hasQtyMismatch || m.hasSymbolMismatch).length;
}
