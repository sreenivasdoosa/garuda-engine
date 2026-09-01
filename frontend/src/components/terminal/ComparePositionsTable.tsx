/**
 * ComparePositionsTable Component
 * Displays combined algo and broker positions in a single comparison table
 * Similar to the reference UI ComparePositionsComp
 */

import React, { useMemo, useState } from 'react';
import { BsArrowRepeat, BsExclamationTriangle, BsSearch } from 'react-icons/bs';
import { Badge, Button, Modal, Spinner } from '@/components/ui';

import type { TerminalPosition, PositionMismatch, ExitPositionsResponse } from '@/types/terminal';
import { PRODUCT_BROKER_PRODUCT_TYPE, type SquareOffProduct } from '@/types/product';
import PnLDisplay from './PnLDisplay';
import { usePermissions } from '@/hooks/usePermissions';

/**
 * Combined position for comparison view
 */
interface ComparedPosition {
  tradingSymbol: string;
  productType: string;
  exchange: string;
  segment: string;
  isPaperTrading: boolean;

  // Current market price
  cmp: number;

  // Algo data
  algoQty: number;
  algoAvgPrice: number;
  algoPnl: number;
  algoPnlByEOD: number;
  existsInAlgo: boolean;

  // Broker data
  brokerQty: number;
  brokerAvgPrice: number;
  brokerPnl: number;
  existsInBroker: boolean;

  // Calculated differences
  qtyDiff: number;
  pnlDiff: number;
  noOpenQty: boolean;

  // Mismatch flags (from WebSocket data)
  hasQtyMismatch: boolean;
  hasSymbolMismatch: boolean;
  hasPnlMismatch: boolean;
}

interface ComparePositionsTableProps {
  algoPositions: TerminalPosition[];
  brokerPositions: TerminalPosition[];
  mismatches: PositionMismatch[];
  /** Restrict to the broker product-type the given engine product trades in ('ALL' = no filter). */
  product?: SquareOffProduct;
  disableActions?: boolean;
  onExitDiff?: (positions: ComparedPosition[]) => Promise<ExitPositionsResponse | void>;
  onRefresh?: () => Promise<void>;
  isRefreshing?: boolean;
}

const ComparePositionsTable: React.FC<ComparePositionsTableProps> = ({
  algoPositions,
  brokerPositions,
  mismatches,
  product = 'ALL',
  disableActions = false,
  onExitDiff,
  onRefresh,
  isRefreshing = false,
}) => {
  // Exiting the position diff requires POSITIONS Manage; the broker/diff comparison columns require
  // ALGO_BROKER_COMPARE View. Without compare, the table is algo-only (no broker/diff/exit columns,
  // no mismatch highlight) — and the caller also stops fetching broker positions entirely.
  const { positions, algoBrokerCompare } = usePermissions();
  const canCompare = algoBrokerCompare.canView;
  const exitActionsHidden = disableActions || !positions.canManage || !canCompare;
  const [search, setSearch] = useState('');
  const [exitingPositions, setExitingPositions] = useState<Set<string>>(new Set());
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showExitAllModal, setShowExitAllModal] = useState(false);
  const [isExitingAll, setIsExitingAll] = useState(false);

  // Create a lookup map from mismatches for quick access
  const mismatchMap = useMemo(() => {
    const map = new Map<string, PositionMismatch>();
    mismatches.forEach((mm) => {
      const key = `${mm.tradingSymbol}-${mm.productType || 'NRML'}-${mm.isPaperTrading ? 'P' : 'L'}`;
      map.set(key, mm);
    });
    return map;
  }, [mismatches]);

  // Merge algo and broker positions into a combined view
  const comparedPositions = useMemo(() => {
    const positionsMap = new Map<string, ComparedPosition>();

    // Process algo positions (same structure as broker positions)
    algoPositions.forEach((ap) => {
      // Filter by product type if specified
      const apProductType = ap.productType || 'NRML';
      if (product !== 'ALL' && apProductType !== PRODUCT_BROKER_PRODUCT_TYPE[product]) return;

      const key = `${ap.tradingSymbol}-${apProductType}-${ap.isPaperTrading ? 'P' : 'L'}`;
      const mismatch = mismatchMap.get(key);

      // Calculate avg price based on position direction
      const algoAvgPrice = ap.netQty > 0 ? ap.buyAvgPrice : (ap.netQty < 0 ? ap.sellAvgPrice : 0);

      positionsMap.set(key, {
        tradingSymbol: ap.tradingSymbol,
        productType: apProductType,
        exchange: ap.exchange,
        segment: ap.segment,
        isPaperTrading: !!ap.isPaperTrading,
        cmp: ap.cmp || 0,
        algoQty: ap.netQty,
        algoAvgPrice: algoAvgPrice,
        algoPnl: ap.totalPnl,
        algoPnlByEOD: ap.totalPnlByEOD || 0,
        existsInAlgo: true,
        brokerQty: 0,
        brokerAvgPrice: 0,
        brokerPnl: 0,
        existsInBroker: false,
        qtyDiff: 0 - ap.netQty,
        pnlDiff: 0 - ap.totalPnl,
        noOpenQty: ap.netQty === 0,
        hasQtyMismatch: mismatch?.hasQtyMismatch || false,
        hasSymbolMismatch: mismatch?.hasSymbolMismatch || !mismatch,
        hasPnlMismatch: mismatch?.hasPnlMismatch || false,
      });
    });

    // Process broker positions
    brokerPositions.forEach((bp) => {
      // Filter by product type if specified
      if (product !== 'ALL' && bp.productType !== PRODUCT_BROKER_PRODUCT_TYPE[product]) return;

      const key = `${bp.tradingSymbol}-${bp.productType}-${bp.isPaperTrading ? 'P' : 'L'}`;
      const existing = positionsMap.get(key);
      const mismatch = mismatchMap.get(key);

      if (existing) {
        // Symbol exists in both algo and broker
        existing.brokerQty = bp.netQty;
        existing.brokerAvgPrice = bp.netQty > 0 ? bp.buyAvgPrice : bp.netQty < 0 ? bp.sellAvgPrice : 0;
        existing.brokerPnl = bp.totalPnl;
        existing.existsInBroker = true;
        // Worthless legs the system auto-completed post-close are still open at
        // the broker — subtract them so only the genuine gap is flagged.
        existing.qtyDiff = bp.netQty - existing.algoQty - (mismatch?.systemCompletedQty || 0);
        existing.pnlDiff = bp.totalPnl - existing.algoPnl;
        existing.noOpenQty = existing.algoQty === 0 && bp.netQty === 0;
        existing.hasQtyMismatch = mismatch?.hasQtyMismatch || existing.qtyDiff !== 0;
        existing.hasSymbolMismatch = false;
        existing.hasPnlMismatch = mismatch?.hasPnlMismatch || false;
      } else {
        // Symbol only exists in broker (not in algo)
        positionsMap.set(key, {
          tradingSymbol: bp.tradingSymbol,
          productType: bp.productType,
          exchange: bp.exchange,
          segment: bp.segment,
          isPaperTrading: !!bp.isPaperTrading,
          cmp: bp.cmp || 0,
          algoQty: 0,
          algoAvgPrice: 0,
          algoPnl: 0,
          algoPnlByEOD: 0,
          existsInAlgo: false,
          brokerQty: bp.netQty,
          brokerAvgPrice: bp.netQty > 0 ? bp.buyAvgPrice : bp.netQty < 0 ? bp.sellAvgPrice : 0,
          brokerPnl: bp.totalPnl,
          existsInBroker: true,
          qtyDiff: bp.netQty - (mismatch?.systemCompletedQty || 0),
          pnlDiff: bp.totalPnl,
          noOpenQty: bp.netQty === 0,
          hasQtyMismatch: mismatch?.hasQtyMismatch || (bp.netQty - (mismatch?.systemCompletedQty || 0)) !== 0,
          hasSymbolMismatch: true,
          hasPnlMismatch: mismatch?.hasPnlMismatch || false,
        });
      }
    });

    // Convert to array and sort
    const positions = Array.from(positionsMap.values());
    positions.sort((p1, p2) => {
      const symbol1 = p1.tradingSymbol || '';
      const symbol2 = p2.tradingSymbol || '';
      const product1 = p1.productType || '';
      const product2 = p2.productType || '';

      // Sort by product type first
      if (product1 !== product2) {
        return product1.localeCompare(product2);
      }

      // Mismatches first
      const p1HasMismatch = !p1.existsInAlgo || !p1.existsInBroker || p1.qtyDiff !== 0;
      const p2HasMismatch = !p2.existsInAlgo || !p2.existsInBroker || p2.qtyDiff !== 0;
      if (p1HasMismatch !== p2HasMismatch) {
        return p1HasMismatch ? -1 : 1;
      }

      // Then positions with open qty before closed ones
      if (p1.noOpenQty !== p2.noOpenQty) {
        return p1.noOpenQty ? 1 : -1;
      }

      // Then by symbol name
      const startChars1 = symbol1.substring(0, 5);
      const startChars2 = symbol2.substring(0, 5);
      if (startChars1 !== startChars2) {
        return startChars1.localeCompare(startChars2);
      }

      const direction1 = p1.algoQty > 0 ? 'B' : p1.algoQty < 0 ? 'S' : '';
      const direction2 = p2.algoQty > 0 ? 'B' : p2.algoQty < 0 ? 'S' : '';
      return `${direction1}-${symbol1}`.localeCompare(`${direction2}-${symbol2}`);
    });

    return positions;
  }, [algoPositions, brokerPositions, mismatchMap, product]);

  // Search-filtered view of the compared positions (same pattern as the
  // Trades tab search). Matching is against symbol / product / exchange /
  // segment / direction / live-paper.
  const visiblePositions = useMemo(() => {
    const normalized = search.trim().toLowerCase();
    if (!normalized) {
      return comparedPositions;
    }
    return comparedPositions.filter((pos) =>
      [
        pos.tradingSymbol,
        pos.productType,
        pos.exchange,
        pos.segment,
        pos.algoQty || pos.brokerQty ? ((pos.algoQty || pos.brokerQty) > 0 ? 'long' : 'short') : '',
        pos.isPaperTrading ? 'paper' : 'live',
      ]
        .filter((value) => value !== null && value !== undefined && value !== '')
        .join(' ')
        .toLowerCase()
        .includes(normalized)
    );
  }, [comparedPositions, search]);

  // Calculate totals (over the VISIBLE rows so the footer matches the view)
  const totals = useMemo(() => {
    let totalAlgoPnl = 0;
    let totalAlgoPnlByEOD = 0;
    let totalBrokerPnl = 0;

    visiblePositions.forEach((pos) => {
      totalAlgoPnl += pos.algoPnl;
      totalAlgoPnlByEOD += pos.algoPnlByEOD;
      totalBrokerPnl += pos.brokerPnl;
    });

    return {
      algoPnl: totalAlgoPnl,
      algoPnlByEOD: totalAlgoPnlByEOD,
      brokerPnl: totalBrokerPnl,
      pnlDiff: totalBrokerPnl - totalAlgoPnl,
    };
  }, [visiblePositions]);

  // Get positions with qty difference
  const positionsWithDiffQty = useMemo(() => {
    return comparedPositions.filter((pos) => pos.qtyDiff !== 0);
  }, [comparedPositions]);

  const handleExitDiff = async (positions: ComparedPosition[]) => {
    if (!onExitDiff) return;

    const keys = positions.map((p) => `${p.tradingSymbol}-${p.productType}-${p.isPaperTrading ? 'P' : 'L'}`);
    setExitingPositions(new Set(keys));
    setError(null);
    setStatusMessage(null);

    try {
      const results = await onExitDiff(positions);
      if (results) {
        // Analyze results
        const successCount = results.filter(r => r.status === 'success').length;
        const errorCount = results.filter(r => r.status === 'error').length;
        const partialCount = results.filter(r => r.status === 'partial').length;

        if (errorCount === 0 && partialCount === 0) {
          const totalOrders = results.reduce((sum, r) => sum + (r.orderIds?.length || 0), 0);
          setStatusMessage(`Exit orders placed successfully: ${totalOrders} order(s) for ${results.length} position(s). Please refresh after some time.`);
        } else if (successCount === 0 && partialCount === 0) {
          // All failed
          const errorMessages = results.map(r => `${r.tradingSymbol}: ${r.message}`).join('\n');
          setError(`All exit orders failed:\n${errorMessages}`);
        } else {
          // Mixed results
          const successMessages: string[] = [];
          const errorMessages: string[] = [];

          results.forEach(r => {
            if (r.status === 'success') {
              successMessages.push(`${r.tradingSymbol}: ${r.orderIds?.length || 0} order(s)`);
            } else {
              errorMessages.push(`${r.tradingSymbol}: ${r.message}`);
            }
          });

          setStatusMessage(`Partial success: ${successCount} succeeded, ${errorCount + partialCount} failed`);
          if (errorMessages.length > 0) {
            setError(`Failed positions:\n${errorMessages.join('\n')}`);
          }
        }
      } else {
        setStatusMessage('Exit order placed. Please refresh after some time.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to exit positions');
    } finally {
      setExitingPositions(new Set());
    }
  };

  // Handle Exit All Diff with confirmation
  const handleExitAllDiff = async () => {
    if (!onExitDiff || positionsWithDiffQty.length === 0) return;

    setIsExitingAll(true);
    setError(null);
    setStatusMessage(null);

    try {
      const results = await onExitDiff(positionsWithDiffQty);
      if (results) {
        // Analyze results
        const successCount = results.filter(r => r.status === 'success').length;
        const errorCount = results.filter(r => r.status === 'error').length;
        const partialCount = results.filter(r => r.status === 'partial').length;

        if (errorCount === 0 && partialCount === 0) {
          const totalOrders = results.reduce((sum, r) => sum + (r.orderIds?.length || 0), 0);
          setStatusMessage(`All exit orders placed successfully: ${totalOrders} order(s) for ${results.length} position(s). Please refresh after some time.`);
        } else if (successCount === 0 && partialCount === 0) {
          // All failed
          const errorMessages = results.map(r => `${r.tradingSymbol}: ${r.message}`).join('\n');
          setError(`All exit orders failed:\n${errorMessages}`);
        } else {
          // Mixed results
          const errorMessages = results
            .filter(r => r.status !== 'success')
            .map(r => `${r.tradingSymbol}: ${r.message}`);

          setStatusMessage(`Partial success: ${successCount} succeeded, ${errorCount + partialCount} failed`);
          if (errorMessages.length > 0) {
            setError(`Failed positions:\n${errorMessages.join('\n')}`);
          }
        }
      } else {
        setStatusMessage(`Exit orders placed for ${positionsWithDiffQty.length} positions. Please refresh after some time.`);
      }
      setShowExitAllModal(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to exit positions');
    } finally {
      setIsExitingAll(false);
    }
  };

  // Get direction text for exit - shows what will be exited
  const getExitDirectionText = (qtyDiff: number): string => {
    if (qtyDiff > 0) return 'LONG';  // Broker has more long, exit long
    if (qtyDiff < 0) return 'SHORT'; // Broker has more short, exit short
    return '';
  };

  const getRowClassName = (pos: ComparedPosition): string => {
    if (canCompare && (!pos.existsInAlgo || !pos.existsInBroker)) {
      return 'bg-warning-500/10';
    }
    if (pos.noOpenQty) {
      return 'bg-raised/40';
    }
    return '';
  };

  const getDirectionText = (qty: number): string => {
    if (qty > 0) return 'B';
    if (qty < 0) return 'S';
    return '';
  };

  const getDirectionClass = (qty: number): string => {
    if (qty > 0) return 'text-success-500';
    if (qty < 0) return 'text-danger-500';
    return '';
  };

  const cell = 'px-2 py-1.5';

  const formatNumber = (value: number | undefined | null): string => {
    if (value == null) return '0.00';
    return value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  return (
    <div>
      {/* Action buttons */}
      {!exitActionsHidden && (
        <div className="mb-3 flex items-center gap-2">
          <Button variant="danger" size="sm" disabled={positionsWithDiffQty.length === 0 || exitingPositions.size > 0 || isExitingAll} onClick={() => setShowExitAllModal(true)}>
            <BsExclamationTriangle />
            Exit All Diff ({positionsWithDiffQty.length})
          </Button>
          {onRefresh && (
            <Button variant="secondary" size="sm" onClick={onRefresh} disabled={isRefreshing}>
              <BsArrowRepeat className={isRefreshing ? 'animate-spin' : ''} />
            </Button>
          )}
        </div>
      )}

      {/* Status messages */}
      {(error || statusMessage) && (
        <div
          className={`mb-3 flex items-start justify-between gap-2 whitespace-pre-line rounded border px-3 py-2 text-sm ${
            error ? 'border-danger-500/30 bg-danger-500/10 text-danger-600 dark:text-danger-400' : 'border-success-500/30 bg-success-500/10 text-success-600 dark:text-success-400'
          }`}
        >
          <span>{error || statusMessage}</span>
          <button
            type="button"
            className="shrink-0 text-lg leading-none"
            onClick={() => {
              setError(null);
              setStatusMessage(null);
            }}
          >
            ×
          </button>
        </div>
      )}

      {/* Search */}
      <div className="mb-3" style={{ maxWidth: '420px' }}>
        <div className="relative">
          <BsSearch className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-ink-faint" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search symbol, product, exchange..."
            className="h-8 w-full rounded border border-hairline bg-card pl-8 pr-2 text-sm text-ink placeholder:text-ink-faint focus-visible:outline-none focus:border-primary-500/60"
          />
        </div>
        <div className="mt-1 text-xs text-ink-faint">
          Showing {visiblePositions.length} of {comparedPositions.length} positions
        </div>
      </div>

      {/* Positions table */}
      <div style={{ maxHeight: '70vh', overflowY: 'auto' }} className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 z-[1] bg-raised text-ink-faint">
            <tr>
              <th className={`${cell} text-left`}>Symbol</th>
              <th className={`${cell} text-left`}>Product</th>
              <th className={`${cell} text-right`}>CMP</th>
              <th className={`${cell} text-right`}>Algo Avg</th>
              {canCompare && <th className={`${cell} text-right`}>Broker Avg</th>}
              <th className={`${cell} text-right`}>Algo P&L</th>
              <th className={`${cell} text-right`}>Algo P&L (EOD)</th>
              {canCompare && <th className={`${cell} text-right`}>Broker P&L</th>}
              {canCompare && <th className={`${cell} text-right`}>P&L Diff</th>}
              <th className={`${cell} text-right`}>Algo Qty</th>
              {canCompare && <th className={`${cell} text-right`}>Broker Qty</th>}
              {canCompare && <th className={`${cell} text-right`}>Qty Diff</th>}
              {!exitActionsHidden && <th className={`${cell} text-right`}>Exit Diff</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-hairline">
            {comparedPositions.length === 0 ? (
              <tr>
                <td colSpan={canCompare ? (exitActionsHidden ? 12 : 13) : 7} className="py-4 text-center text-ink-soft">
                  No positions to compare
                </td>
              </tr>
            ) : (
              <>
                {visiblePositions.map((pos) => {
                  const direction = getDirectionText(pos.algoQty || pos.brokerQty);
                  const directionClass = getDirectionClass(pos.algoQty || pos.brokerQty);
                  const posKey = `${pos.tradingSymbol}-${pos.productType}-${pos.isPaperTrading ? 'P' : 'L'}`;
                  const isExiting = exitingPositions.has(posKey);

                  return (
                    <tr key={posKey} className={getRowClassName(pos)}>
                      <td className={`${cell} ${directionClass}`}>
                        <span className="font-medium">{pos.tradingSymbol}</span>
                        {direction && <span className="ml-1">({direction})</span>}
                        <Badge tone={pos.isPaperTrading ? 'info' : 'neutral'} className="ml-1">
                          {pos.isPaperTrading ? 'P' : 'L'}
                        </Badge>
                        {canCompare && !pos.existsInAlgo && (
                          <Badge tone="warning" className="ml-1">
                            !A
                          </Badge>
                        )}
                        {canCompare && !pos.existsInBroker && (
                          <Badge tone="warning" className="ml-1">
                            !B
                          </Badge>
                        )}
                      </td>
                      <td className={cell}>
                        <Badge tone="neutral">{pos.productType}</Badge>
                      </td>
                      <td className={`${cell} text-right tabular-nums text-ink`}>{formatNumber(pos.cmp)}</td>
                      <td className={`${cell} text-right tabular-nums text-ink`}>{formatNumber(pos.algoAvgPrice)}</td>
                      {canCompare && <td className={`${cell} text-right tabular-nums text-ink`}>{formatNumber(pos.brokerAvgPrice)}</td>}
                      <td className={`${cell} text-right`}>
                        <PnLDisplay value={pos.algoPnl} size="sm" fullFormat />
                      </td>
                      <td className={`${cell} text-right`}>
                        <PnLDisplay value={pos.algoPnlByEOD} size="sm" fullFormat />
                      </td>
                      {canCompare && (
                        <td className={`${cell} text-right`}>
                          <PnLDisplay value={pos.brokerPnl} size="sm" fullFormat />
                        </td>
                      )}
                      {canCompare && (
                        <td className={`${cell} text-right`}>
                          <PnLDisplay value={pos.pnlDiff} size="sm" fullFormat />
                        </td>
                      )}
                      <td className={`${cell} text-right tabular-nums text-ink`}>{pos.algoQty}</td>
                      {canCompare && <td className={`${cell} text-right tabular-nums text-ink`}>{pos.brokerQty}</td>}
                      {canCompare && <td className={`${cell} text-right tabular-nums ${pos.qtyDiff !== 0 ? 'font-bold text-danger-500' : 'text-ink'}`}>{pos.qtyDiff}</td>}
                      {!exitActionsHidden && (
                        <td className={`${cell} text-right`}>
                          {pos.qtyDiff !== 0 ? (
                            <Button variant="danger" size="sm" disabled={isExiting} onClick={() => handleExitDiff([pos])} title={`Exit ${Math.abs(pos.qtyDiff)} ${getExitDirectionText(pos.qtyDiff)}`}>
                              {isExiting ? (
                                <Spinner size="sm" />
                              ) : (
                                <span className="inline-flex items-center gap-1">
                                  {Math.abs(pos.qtyDiff)} {pos.qtyDiff > 0 ? 'L' : 'S'}
                                </span>
                              )}
                            </Button>
                          ) : (
                            <span className="text-ink-faint">-</span>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}

                {/* Totals row */}
                <tr className="bg-raised font-bold">
                  <td colSpan={canCompare ? 5 : 4} className={cell}>
                    TOTAL
                  </td>
                  <td className={`${cell} text-right`}>
                    <PnLDisplay value={totals.algoPnl} size="sm" fullFormat />
                  </td>
                  <td className={`${cell} text-right`}>
                    <PnLDisplay value={totals.algoPnlByEOD} size="sm" fullFormat />
                  </td>
                  {canCompare && (
                    <td className={`${cell} text-right`}>
                      <PnLDisplay value={totals.brokerPnl} size="sm" fullFormat />
                    </td>
                  )}
                  {canCompare && (
                    <td className={`${cell} text-right`}>
                      <PnLDisplay value={totals.pnlDiff} size="sm" fullFormat />
                    </td>
                  )}
                  <td colSpan={canCompare ? (exitActionsHidden ? 3 : 4) : 1}></td>
                </tr>
              </>
            )}
          </tbody>
        </table>
      </div>

      {/* Exit All Diff Confirmation Modal */}
      <Modal
        open={showExitAllModal}
        onClose={() => setShowExitAllModal(false)}
        title={<span className="text-danger-500">Confirm Exit All Differences</span>}
        footer={
          <>
            <Button variant="secondary" onClick={() => setShowExitAllModal(false)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={handleExitAllDiff} disabled={isExitingAll}>
              {isExitingAll ? (
                <>
                  <Spinner size="sm" /> Exiting...
                </>
              ) : (
                `Exit All ${positionsWithDiffQty.length} Differences`
              )}
            </Button>
          </>
        }
      >
        <div className="mb-3 flex items-center gap-2 rounded border border-warning-500/30 bg-warning-500/10 px-3 py-2 text-sm text-ink">
          <BsExclamationTriangle className="text-warning-500" />
          This will place market orders to exit all position differences.
        </div>
        <p className="text-ink">
          You are about to exit <strong>{positionsWithDiffQty.length}</strong> position difference(s):
        </p>
        <div className="rounded bg-raised p-3" style={{ maxHeight: '200px', overflowY: 'auto' }}>
          <table className="w-full text-sm">
            <thead className="text-xs uppercase text-ink-faint">
              <tr>
                <th className="px-2 py-1 text-left">Symbol</th>
                <th className="px-2 py-1 text-right">Exit Qty</th>
                <th className="px-2 py-1 text-left">Direction</th>
              </tr>
            </thead>
            <tbody>
              {positionsWithDiffQty.map((pos) => (
                <tr key={`${pos.tradingSymbol}-${pos.productType}`}>
                  <td className="px-2 py-1">
                    <span className="font-medium text-ink">{pos.tradingSymbol}</span>
                    <Badge tone="neutral" className="ml-1">
                      {pos.productType}
                    </Badge>
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums text-ink">{Math.abs(pos.qtyDiff)}</td>
                  <td className="px-2 py-1">
                    <Badge tone={pos.qtyDiff > 0 ? 'success' : 'danger'}>{getExitDirectionText(pos.qtyDiff)}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Modal>
    </div>
  );
};

export default ComparePositionsTable;
