/**
 * TerminalActions Component
 * Action buttons for terminal operations. Tailwind design system.
 */

import React, { useState, useRef, useEffect } from 'react';
import ReactDOM from 'react-dom';
import { BsArrowRepeat, BsXSquare, BsCheckSquare, BsPencilSquare, BsThreeDotsVertical } from 'react-icons/bs';
import { Button, Modal, Spinner } from '@/components/ui';
import { SQUARE_OFF_PRODUCT_OPTIONS, squareOffScopeLabel, type SquareOffProduct } from '@/types/product';

interface TerminalActionsProps {
  username: string;
  broker: string;
  clientID?: string;
  hasActiveTrades: boolean;
  isRefreshing?: boolean;
  isSquaringOff?: boolean;
  onRefresh: () => void;
  onSquareOff: (product: SquareOffProduct) => void;
  onCompleteTrades?: () => void;
  onAlterTrades?: () => void;
}

const ddItem =
  'flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-ink transition-colors hover:bg-raised disabled:cursor-not-allowed disabled:opacity-50';

const TerminalActions: React.FC<TerminalActionsProps> = ({
  username,
  broker,
  hasActiveTrades,
  isRefreshing = false,
  isSquaringOff = false,
  onRefresh,
  onSquareOff,
  onCompleteTrades,
  onAlterTrades,
}) => {
  const [showSquareOffModal, setShowSquareOffModal] = useState(false);
  const [squareOffProduct, setSquareOffProduct] = useState<SquareOffProduct>('ALL');
  const [confirmText, setConfirmText] = useState('');
  const [showDropdown, setShowDropdown] = useState(false);
  const [dropdownPosition, setDropdownPosition] = useState({ top: 0, left: 0 });
  const toggleRef = useRef<HTMLButtonElement>(null);

  const hasMenuActions = ((!!onCompleteTrades || !!onAlterTrades)) || true;

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (showDropdown && toggleRef.current && !toggleRef.current.contains(event.target as Node)) {
        const menu = document.getElementById(`dropdown-menu-${username}-${broker}`);
        if (menu && !menu.contains(event.target as Node)) {
          setShowDropdown(false);
        }
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showDropdown, username, broker]);

  const handleToggleDropdown = () => {
    if (!showDropdown && toggleRef.current) {
      const rect = toggleRef.current.getBoundingClientRect();
      setDropdownPosition({ top: rect.bottom + 4, left: rect.right });
    }
    setShowDropdown(!showDropdown);
  };

  const handleSquareOffConfirm = () => {
    if (confirmText.toUpperCase() === 'SQUAREOFF') {
      onSquareOff(squareOffProduct);
      setShowSquareOffModal(false);
      setConfirmText('');
    }
  };

  return (
    <>
      <div className="flex gap-1">
        {/* Refresh Button */}
        <Button variant="secondary" size="sm" onClick={onRefresh} disabled={isRefreshing} title="Refresh">
          {isRefreshing ? <Spinner size="sm" /> : <BsArrowRepeat />}
        </Button>

        {/* More Actions Dropdown */}
        {hasMenuActions && (
          <Button ref={toggleRef} variant="secondary" size="sm" onClick={handleToggleDropdown} aria-expanded={showDropdown}>
            <BsThreeDotsVertical />
          </Button>
        )}

        {/* Portal-rendered dropdown menu */}
        {showDropdown &&
          ReactDOM.createPortal(
            <div
              id={`dropdown-menu-${username}-${broker}`}
              className="fixed z-[1050] min-w-[12rem] rounded-card border border-hairline bg-card py-1 shadow-card dark:shadow-card-dark"
              style={{ top: `${dropdownPosition.top}px`, right: `${window.innerWidth - dropdownPosition.left}px` }}
            >
              {onCompleteTrades && (
                <button
                  className={ddItem}
                  onClick={() => {
                    onCompleteTrades();
                    setShowDropdown(false);
                  }}
                >
                  <BsCheckSquare />
                  Complete Trades
                </button>
              )}
              {onAlterTrades && (
                <button
                  className={ddItem}
                  onClick={() => {
                    onAlterTrades();
                    setShowDropdown(false);
                  }}
                >
                  <BsPencilSquare />
                  Alter Trades
                </button>
              )}
                              <>
                  <h6 className="px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-ink-faint">Square Off</h6>
                  {/* One entry per engine-managed product (TRADABLE_PRODUCTS), so CashBuy and MTF
                      positions are reachable here too — not just intraday/positional. */}
                  {SQUARE_OFF_PRODUCT_OPTIONS.map(({ value, label }) => (
                    <button
                      key={value}
                      className={ddItem}
                      onClick={() => {
                        setSquareOffProduct(value);
                        setShowSquareOffModal(true);
                        setShowDropdown(false);
                      }}
                      disabled={isSquaringOff || !hasActiveTrades}
                    >
                      <BsXSquare />
                      {label} Only
                    </button>
                  ))}
                  <button
                    className={`${ddItem} text-danger-500`}
                    onClick={() => {
                      setSquareOffProduct('ALL');
                      setShowSquareOffModal(true);
                      setShowDropdown(false);
                    }}
                    disabled={isSquaringOff || !hasActiveTrades}
                  >
                    <BsXSquare />
                    All Positions
                  </button>
                </>
              
            </div>,
            document.body,
          )}
      </div>

      {/* Square Off Confirmation Modal */}
      <Modal
        open={showSquareOffModal}
        onClose={() => setShowSquareOffModal(false)}
        title={<span className="text-danger-500">Confirm Square Off</span>}
        footer={
          <>
            <Button variant="secondary" onClick={() => setShowSquareOffModal(false)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={handleSquareOffConfirm} disabled={confirmText.toUpperCase() !== 'SQUAREOFF' || isSquaringOff}>
              {isSquaringOff ? (
                <>
                  <Spinner size="sm" />
                  Squaring Off...
                </>
              ) : (
                'Confirm Square Off'
              )}
            </Button>
          </>
        }
      >
        <p className="text-ink">
          You are about to square off <strong>{squareOffScopeLabel(squareOffProduct)}</strong> for:
        </p>
        <div className="mb-3 rounded bg-raised p-3 text-sm text-ink">
          <div>
            <strong>User:</strong> {username}
          </div>
          <div>
            <strong>Broker:</strong> {broker}
          </div>
        </div>
        <label className="mb-1 block text-sm text-ink-soft">
          Type <strong className="text-ink">SQUAREOFF</strong> to confirm:
        </label>
        <input
          type="text"
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          placeholder="SQUAREOFF"
          autoFocus
          className="w-full rounded-control border border-hairline bg-card px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus-visible:outline-none focus:border-primary-500/60"
        />
      </Modal>
    </>
  );
};

export default TerminalActions;
