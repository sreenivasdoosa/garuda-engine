/**
 * UserDetailsPanel Component
 * Expanded details view for a user-broker
 */

import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import clsx from 'clsx';
import { BsArrowUp, BsArrowDown, BsBoxArrowUpRight, BsCheckSquare, BsXSquare, BsLightningCharge, BsArrowRepeat, BsJournalText, BsSearch, BsArrowDownUp } from 'react-icons/bs';
import { format } from 'date-fns';
import { Spinner as UISpinner, Tooltip as UITooltip } from '@/components/ui';

import type { UserTradeDetails, ExitPositionRequest, TerminalSquareOffRequest, ExitPositionsResponse, TradeSignal, OrderDetails, TerminalBreakdown, StrategySummary, ExternalPnlLiveDetails } from '@/types/terminal';
import type { SquareOffProduct } from '@/types/product';
import { sortTrades, sortTradeSignals } from '@/utils';
import { terminalService } from '@/services/terminal/terminalService';
import HelpIcon from '@/components/common/HelpIcon';
import { terminalHelpContent } from '@/data/help/terminal-help';
import PnLDisplay from './PnLDisplay';
import { TradeModeBadge } from '@/components/common/TradeModeBadge';
import StrategyBreakdown from './StrategyBreakdown';
import RiskProfileChart from './RiskProfileChart';
import ComparePositionsTable from './ComparePositionsTable';
import TradeDetailsDrawer from './TradeDetailsDrawer';
import TradeSignalDetailsDrawer from './TradeSignalDetailsDrawer';
import UserStrategyStatesTab from './UserStrategyStatesTab';
import BreakoutWatchesTab from './BreakoutWatchesTab';
import OrderBookTable from './OrderBookTable';
import OrderDetailsDrawer from './OrderDetailsDrawer';
import { usePermissions } from '@/hooks/usePermissions';

// ---- Local token shims (react-bootstrap API surface -> design-system tokens) ----
// This 2000+ line panel is form/table/modal-heavy; shimming the Bootstrap API it
// uses keeps the large JSX bodies unchanged while dropping react-bootstrap.
const shimInput =
  'w-full rounded-control border border-hairline bg-card px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus-visible:outline-none focus:border-primary-500/60 disabled:bg-raised disabled:opacity-70';

const Row = ({ className = '', children }: { className?: string; children?: React.ReactNode }) => <div className={`-mx-2 flex flex-wrap ${className}`}>{children}</div>;
const Col = ({ className = '', children }: { md?: number | string; xs?: number | string; lg?: number | string; className?: string; children?: React.ReactNode }) => (
  <div className={`w-full px-2 md:w-auto md:flex-1 ${className}`}>{children}</div>
);

const CardRoot = ({ className = '', children, ...p }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={`rounded-card border border-hairline bg-card ${className}`} {...p}>{children}</div>
);
const CardHeader = ({ className = '', children }: { className?: string; children?: React.ReactNode }) => (
  <div className={`border-b border-hairline px-3 py-2 text-sm font-semibold text-ink ${className}`}>{children}</div>
);
const CardBody = ({ className = '', children }: { className?: string; children?: React.ReactNode }) => <div className={`p-3 ${className}`}>{children}</div>;
const Card = Object.assign(CardRoot, { Header: CardHeader, Body: CardBody });

const FormRoot = ({ className = '', children, ...p }: React.FormHTMLAttributes<HTMLFormElement>) => (
  <form className={className} {...p}>{children}</form>
);
const FormGroup = ({ className = '', children }: { className?: string; children?: React.ReactNode }) => <div className={`mb-3 ${className}`}>{children}</div>;
const FormLabel = ({ className = '', children, ...p }: React.LabelHTMLAttributes<HTMLLabelElement>) => (
  <label className={`mb-1 block text-xs font-medium text-ink-soft ${className}`} {...p}>{children}</label>
);
const FormControl = ({ as, className = '', size: _size, ...p }: { as?: 'textarea'; size?: 'sm' | 'lg' } & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> & Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'size'>) =>
  as === 'textarea' ? (
    <textarea className={`${shimInput} ${className}`} {...(p as React.TextareaHTMLAttributes<HTMLTextAreaElement>)} />
  ) : (
    <input className={`${shimInput} ${className}`} {...(p as React.InputHTMLAttributes<HTMLInputElement>)} />
  );
const FormText = ({ className = '', children }: { className?: string; children?: React.ReactNode }) => <div className={`mt-1 text-xs text-ink-faint ${className}`}>{children}</div>;
const Form = Object.assign(FormRoot, { Group: FormGroup, Label: FormLabel, Control: FormControl, Text: FormText });

const Table = ({ hover, bordered, className = '', children }: { hover?: boolean; size?: string; responsive?: boolean; bordered?: boolean; striped?: boolean; className?: string; children?: React.ReactNode }) => (
  <div className="overflow-x-auto">
    <table
      className={clsx(
        'w-full text-sm [&_td]:px-2 [&_td]:py-1.5 [&_th]:px-2 [&_th]:py-1.5 [&_tbody_tr]:border-b [&_tbody_tr]:border-hairline',
        hover && '[&_tbody_tr:hover]:bg-raised/50',
        bordered && '[&_td]:border [&_td]:border-hairline [&_th]:border [&_th]:border-hairline',
        className,
      )}
    >
      {children}
    </table>
  </div>
);

const badgeTones: Record<string, string> = {
  secondary: 'bg-raised text-ink-soft',
  light: 'bg-raised text-ink-soft',
  dark: 'bg-ink text-app',
  success: 'bg-success-500/15 text-success-600 dark:text-success-400',
  warning: 'bg-warning-500/15 text-warning-600 dark:text-warning-400',
  danger: 'bg-danger-500/15 text-danger-600 dark:text-danger-400',
  info: 'bg-accent-500/15 text-accent-600 dark:text-accent-400',
  primary: 'bg-primary-500/15 text-primary-500',
};
const Badge = ({ bg = 'secondary', className = '', children }: { bg?: string; text?: string; className?: string; children?: React.ReactNode }) => (
  <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${badgeTones[bg.replace('-subtle', '')] || badgeTones.secondary} ${className}`}>{children}</span>
);

const alertTones: Record<string, string> = {
  danger: 'border-danger-500/30 bg-danger-500/10 text-danger-600 dark:text-danger-400',
  info: 'border-accent-500/30 bg-accent-500/10 text-ink',
  warning: 'border-warning-500/30 bg-warning-500/10 text-ink',
  success: 'border-success-500/30 bg-success-500/10 text-success-600 dark:text-success-400',
};
const Alert = ({ variant = 'info', className = '', children }: { variant?: string; className?: string; children?: React.ReactNode }) => (
  <div className={`rounded border px-3 py-2 text-sm ${alertTones[variant] || alertTones.info} ${className}`}>{children}</div>
);

const Spinner = ({ size, className = '' }: { animation?: string; variant?: string; size?: 'sm'; className?: string }) => <UISpinner size={size === 'sm' ? 'sm' : 'md'} className={className} />;

const btnVariants: Record<string, string> = {
  primary: 'bg-accent-gradient text-white hover:brightness-110',
  secondary: 'border border-hairline text-ink hover:bg-raised',
  'outline-secondary': 'border border-hairline text-ink hover:bg-raised',
  'outline-primary': 'border border-primary-500/50 text-primary-500 hover:bg-primary-500/10',
  'outline-success': 'border border-success-500/50 text-success-500 hover:bg-success-500/10',
  'outline-danger': 'border border-danger-500/50 text-danger-500 hover:bg-danger-500/10',
  'outline-warning': 'border border-warning-500/50 text-warning-600 hover:bg-warning-500/10 dark:text-warning-400',
  danger: 'bg-danger-600 text-white hover:bg-danger-700',
  success: 'bg-success-600 text-white hover:bg-success-700',
  warning: 'bg-warning-500 text-black hover:bg-warning-600',
  link: 'text-primary-500 hover:underline',
};
const Button = ({ variant = 'primary', size, className = '', type = 'button', children, ...p }: { variant?: string; size?: string } & React.ButtonHTMLAttributes<HTMLButtonElement>) => (
  <button
    type={type as 'button' | 'submit' | 'reset'}
    className={clsx(
      'inline-flex items-center justify-center gap-1 rounded-control font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
      size === 'sm' ? 'px-3 py-1.5 text-xs' : 'px-4 py-2 text-sm',
      btnVariants[variant] || btnVariants.primary,
      className,
    )}
    {...p}
  >
    {children}
  </button>
);

const InputGroupText = ({ className = '', children }: { className?: string; children?: React.ReactNode }) => (
  <span className={`inline-flex items-center rounded-l-control border border-r-0 border-hairline bg-raised px-2 text-ink-faint ${className}`}>{children}</span>
);
const InputGroupRoot = ({ className = '', children }: { size?: string; className?: string; children?: React.ReactNode }) => (
  <div className={`flex items-stretch [&>input]:flex-1 [&>input]:rounded-l-none ${className}`}>{children}</div>
);
const InputGroup = Object.assign(InputGroupRoot, { Text: InputGroupText });

// Tooltip content is passed to OverlayTrigger's `overlay`; render nothing inline.
const Tooltip = ({ children }: { id?: string; children?: React.ReactNode }) => <>{children}</>;
const OverlayTrigger = ({ overlay, children }: { placement?: string; overlay: React.ReactElement<{ children?: React.ReactNode }>; children: React.ReactElement }) => (
  <UITooltip label={overlay.props.children} placement="top">
    {children}
  </UITooltip>
);

// ---- Tabs / Tab shim (controlled; reads Tab children props) ----
const Tab = ({ children }: { eventKey: string; title: React.ReactNode; children?: React.ReactNode }) => <>{children}</>;
const Tabs = ({ activeKey, onSelect, className = '', children }: { activeKey: string; onSelect: (k: string | null) => void; className?: string; children: React.ReactNode }) => {
  const panes = React.Children.toArray(children).filter(React.isValidElement) as React.ReactElement<{ eventKey: string; title: React.ReactNode; children: React.ReactNode }>[];
  return (
    <div className={className}>
      <div className="flex flex-wrap gap-1 border-b border-hairline">
        {panes.map((p) => (
          <button
            key={p.props.eventKey}
            type="button"
            onClick={() => onSelect(p.props.eventKey)}
            className={clsx(
              '-mb-px flex items-center gap-1 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors',
              activeKey === p.props.eventKey ? 'border-primary-500 text-primary-500' : 'border-transparent text-ink-soft hover:text-ink',
            )}
          >
            {p.props.title}
          </button>
        ))}
      </div>
      <div>{panes.find((p) => p.props.eventKey === activeKey)?.props.children}</div>
    </div>
  );
};

// ---- Modal shim (composed API; context-provides close to Header) ----
const ModalCloseCtx = React.createContext<(() => void) | undefined>(undefined);
const ModalRoot = ({ show, onHide, size, backdrop, children }: { show: boolean; onHide?: () => void; size?: 'sm' | 'lg' | 'xl'; centered?: boolean; backdrop?: 'static' | boolean; scrollable?: boolean; children?: React.ReactNode }) => {
  React.useEffect(() => {
    if (!show) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && backdrop !== 'static') onHide?.();
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [show, onHide, backdrop]);
  if (!show) return null;
  const sizeCls = size === 'sm' ? 'max-w-md' : size === 'lg' ? 'max-w-2xl' : size === 'xl' ? 'max-w-4xl' : 'max-w-lg';
  return createPortal(
    <div className="fixed inset-0 z-[1100] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={backdrop === 'static' ? undefined : onHide} />
      <div className={`relative w-full ${sizeCls} max-h-[90vh] overflow-y-auto rounded-card border border-hairline bg-card shadow-card dark:shadow-card-dark`}>
        <ModalCloseCtx.Provider value={onHide}>{children}</ModalCloseCtx.Provider>
      </div>
    </div>,
    document.body,
  );
};
const ModalHeader = ({ closeButton, className = '', children }: { closeButton?: boolean; className?: string; children?: React.ReactNode }) => {
  const onClose = React.useContext(ModalCloseCtx);
  return (
    <div className={`flex items-center justify-between gap-4 border-b border-hairline px-4 py-3 ${className}`}>
      <div className="min-w-0">{children}</div>
      {closeButton && (
        <button type="button" onClick={onClose} aria-label="Close" className="shrink-0 rounded p-1 text-lg leading-none hover:bg-raised">
          ×
        </button>
      )}
    </div>
  );
};
const ModalTitle = ({ className = '', children }: { className?: string; children?: React.ReactNode }) => <div className={`font-display text-lg font-semibold ${className}`}>{children}</div>;
const ModalBody = ({ className = '', children }: { className?: string; children?: React.ReactNode }) => <div className={`p-4 ${className}`}>{children}</div>;
const ModalFooter = ({ className = '', children }: { className?: string; children?: React.ReactNode }) => <div className={`flex items-center justify-end gap-2 border-t border-hairline px-4 py-3 ${className}`}>{children}</div>;
const Modal = Object.assign(ModalRoot, { Header: ModalHeader, Title: ModalTitle, Body: ModalBody, Footer: ModalFooter });

// Order status history entry
interface OrderStatusHistoryEntry {
  orderStatus: string;
  lastUpdatedTimestamp: number;
}

// Order interface matching server data
interface Order {
  orderId: string;
  username: string;
  broker: string;
  clientID: string;
  exchange: string;
  segment: string;
  productType: string;
  tradingSymbol: string;
  orderStatus: string;
  orderPrevStatus?: string;
  orderStatusHistory?: OrderStatusHistoryEntry[];
  orderType: string;
  prevOrderType?: string;
  tradeID: string;
  price: number;
  triggerPrice: number;
  averagePrice: number;
  direction: 'LONG' | 'SHORT';
  quantity: number;
  filledQuantity: number;
  pendingQuantity: number;
  disclosedQuantity: number;
  orderPlacedTimestamp: number;
  orderExecutedTimestamp?: number;
  parentOrderId?: string;
  message?: string;
  lastOrderUpdateTimestamp: number;
  exchangeOrderId: string;
  numModifyRequests: number;
  exchangeLastUpdateTimestamp?: number;
}

// Server trade data structure (different from Trade type)
interface ServerTrade {
  tradeID: string;
  strategy: string;
  product: string;  // INTRADAY, POSITIONAL, CASHBUY, MTF
  productType: string;  // MIS, NRML, CNC, MTF
  group?: string;
  tradingSymbol: string;
  exchange: string;
  segment: string;
  direction: 'LONG' | 'SHORT';
  quantity: number;
  filledQuantity: number;
  entry: number;
  exit: number;
  cmp: number;
  stopLoss: number;
  initialStopLoss: number;
  noStopLoss: boolean;
  target: number;
  requestedEntry: number;
  requestedExit: number;
  profitLoss: number;
  charges: number;
  netProfitLoss: number;
  plPercentage: number;
  exitReason?: string;
  remarks?: string;
  startTimestamp: number;
  endTimestamp?: number;
  state: 'OPEN' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
  orderFilled: boolean;
  isMarketOrder: boolean;
  isPaperTrading?: boolean;
  isMock?: boolean;
  order?: Order;
  slOrder?: Order;
  targetOrder?: Order;
  hedgeCorrelationID?: string;
  hedgeTradeID?: string;
  hedgeDistancePercentage?: number;
  pairTradeCorrelationID?: string;
  // Corporate-action adjustment state (split/bonus). caFactor 1 / absent = never adjusted.
  caFactor?: number;
  originalEntry?: number;
  originalQuantity?: number;
  originalFilledQuantity?: number;
}

interface UserDetailsPanelProps {
  details: UserTradeDetails | null;
  isLoading: boolean;
  error?: string;
  // riskProfile + strategySummaries are no longer passed from the summary — those tabs lazy-fetch
  // their own data (RISK_PROFILES / STRATEGY_SUMMARIES endpoints) when opened. Capital stays here.
  algoCapital?: number;
  externalCapital?: number;
  onExitPositions?: (request: ExitPositionRequest) => Promise<ExitPositionsResponse | void>;
  onSquareOff?: (request: TerminalSquareOffRequest) => Promise<void>;
  onRefresh?: () => Promise<void>;
  isRefreshing?: boolean;
  // Single trade actions
  onCompleteTrade?: (tradeID: string, exitPrice: number, exitDate?: string) => Promise<void>;
  onSquareOffTrade?: (tradeID: string, product?: SquareOffProduct) => Promise<void>;
  onCancelTrade?: (tradeID: string) => Promise<void>;
  // Top-level terminal mode — gates the Order Book mode dropdown.
  tradingMode?: 'live' | 'paper' | 'mixed';
}

type SortDirection = 'asc' | 'desc';

const UserDetailsPanel: React.FC<UserDetailsPanelProps> = ({
  details,
  isLoading,
  error,
  algoCapital = 0,
  externalCapital = 0,
  onExitPositions,
  onSquareOff,
  onRefresh,
  isRefreshing = false,
  onCompleteTrade,
  onSquareOffTrade,
  onCancelTrade,
  tradingMode = 'mixed',
}) => {
  const helpContent = terminalHelpContent;
  // Square off (per-trade / by-strategy) requires SQUARE_OFF Manage; set-to-complete
  // requires TRADES Edit. Hide each control when the right is missing.
  const { squareOff, trades, positions, margins, orders, breakoutWatches, strategySummaries: strategySummariesPerm, strategyEngine, riskProfiles, algoBrokerCompare } = usePermissions();
  // Algo-vs-broker comparison (mismatch badge + broker side of positions/risk) needs ALGO_BROKER_COMPARE View.
  const canViewAlgoBrokerCompare = algoBrokerCompare.canView;
  const canSquareOff = squareOff.canManage;
  const canEditTrades = trades.canEdit;
  // Each tab is gated by its own View right: trade tabs + Signals → TRADES, Positions → POSITIONS,
  // Margins → MARGINS, Strategy Summaries → STRATEGY_SUMMARIES, Strategy States → STRATEGY_ENGINE,
  // Breakout Watches → BREAKOUT_WATCHES, Order Book → ORDERS, Risk Profile → RISK_PROFILES. Without
  // the right the tab shows a "no permission" message instead of data (and its fetch never fires).
  const canViewTrades = trades.canView;
  const canViewPositions = positions.canView;
  const canViewMargins = margins.canView;
  const canViewStrategySummaries = strategySummariesPerm.canView;
  const canViewStrategyStates = strategyEngine.canView;
  const canViewBreakoutWatches = breakoutWatches.canView;
  const canViewOrders = orders.canView;
  const canViewRiskProfile = riskProfiles.canView;
  // Per-section fetch errors/timeouts (from the 3 scoped detail calls) to surface in each tab.
  const tradesError = details?.sectionStatus?.trades?.status === 'error'
    ? (details.sectionStatus.trades.message || 'Failed to load trades') : null;
  const positionsError = details?.sectionStatus?.positions?.status === 'error'
    ? (details.sectionStatus.positions.message || 'Failed to load positions') : null;
  const marginsError = details?.sectionStatus?.margins?.status === 'error'
    ? (details.sectionStatus.margins.message || 'Failed to load margins') : null;
  const [activeTab, setActiveTab] = useState('positions');
  const [tradeSearch, setTradeSearch] = useState('');
  const [signalSearch, setSignalSearch] = useState('');
  const [tradeSortKey, setTradeSortKey] = useState<string | null>(null);
  const [tradeSortDirection, setTradeSortDirection] = useState<SortDirection>('desc');
  const [selectedTrade, setSelectedTrade] = useState<ServerTrade | null>(null);
  const [showTradeDrawer, setShowTradeDrawer] = useState(false);

  // Complete trade modal state
  const [showCompleteModal, setShowCompleteModal] = useState(false);
  const [tradeToComplete, setTradeToComplete] = useState<ServerTrade | null>(null);
  const [exitPrice, setExitPrice] = useState<string>('');
  const [exitDate, setExitDate] = useState<string>(format(new Date(), 'yyyy-MM-dd'));
  const [isCompletingTrade, setIsCompletingTrade] = useState(false);

  // Square off confirmation state
  const [showSquareOffConfirm, setShowSquareOffConfirm] = useState(false);
  const [tradeToSquareOff, setTradeToSquareOff] = useState<ServerTrade | null>(null);
  const [isSquaringOffTrade, setIsSquaringOffTrade] = useState(false);

  // Cancel trade confirmation state
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [tradeToCancel, setTradeToCancel] = useState<ServerTrade | null>(null);
  const [isCancellingTrade, setIsCancellingTrade] = useState(false);

  // Trade signals state (loaded on demand)
  const [tradeSignals, setTradeSignals] = useState<TradeSignal[]>([]);
  const [isLoadingSignals, setIsLoadingSignals] = useState(false);
  const [signalsLoaded, setSignalsLoaded] = useState(false);
  const [signalsError, setSignalsError] = useState<string | null>(null);

  // Strategy Summaries tab — lazy (loaded when the tab is first opened, not eager).
  const [strategyData, setStrategyData] = useState<Record<string, StrategySummary> | null>(null);
  const [isLoadingStrategies, setIsLoadingStrategies] = useState(false);
  const [strategiesError, setStrategiesError] = useState<string | null>(null);

  // Risk Profile tab — lazy (loaded when the tab is first opened, not eager).
  const [riskData, setRiskData] = useState<TerminalBreakdown | null>(null);
  const [isLoadingRisk, setIsLoadingRisk] = useState(false);
  const [riskError, setRiskError] = useState<string | null>(null);

  // Trade signal details drawer state
  const [selectedSignal, setSelectedSignal] = useState<TradeSignal | null>(null);
  const [showSignalDrawer, setShowSignalDrawer] = useState(false);

  // Order book state (loaded on demand)
  const [orderBook, setOrderBook] = useState<OrderDetails[]>([]);
  const [isLoadingOrders, setIsLoadingOrders] = useState(false);
  const [ordersLoaded, setOrdersLoaded] = useState(false);
  const [ordersError, setOrdersError] = useState<string | null>(null);

  // Order details drawer state
  const [selectedOrder, setSelectedOrder] = useState<OrderDetails | null>(null);
  const [showOrderDrawer, setShowOrderDrawer] = useState(false);

  // External (manual) intraday P&L state (loaded on demand — force-fetches the broker order book)
  const [externalPnl, setExternalPnl] = useState<ExternalPnlLiveDetails | null>(null);
  const [isLoadingExternalPnl, setIsLoadingExternalPnl] = useState(false);
  const [externalPnlLoaded, setExternalPnlLoaded] = useState(false);
  const [externalPnlError, setExternalPnlError] = useState<string | null>(null);

  // Handle trade row click to open drawer
  const handleTradeClick = (trade: ServerTrade) => {
    setSelectedTrade(trade);
    setShowTradeDrawer(true);
  };

  // Close drawer
  const handleCloseDrawer = () => {
    setShowTradeDrawer(false);
  };

  // Handle trade signal row click to open drawer
  const handleSignalClick = (signal: TradeSignal) => {
    setSelectedSignal(signal);
    setShowSignalDrawer(true);
  };

  // Close signal drawer
  const handleCloseSignalDrawer = () => {
    setShowSignalDrawer(false);
  };

  // Handle order row click to open drawer
  const handleOrderClick = (order: OrderDetails) => {
    setSelectedOrder(order);
    setShowOrderDrawer(true);
  };

  // Close order drawer
  const handleCloseOrderDrawer = () => {
    setShowOrderDrawer(false);
  };

  // Load order book on demand
  const loadOrderBook = async () => {
    if (!details || isLoadingOrders) return;

    setIsLoadingOrders(true);
    setOrdersError(null);

    try {
      const orders = await terminalService.getOrderBook(details.username, details.broker);
      setOrderBook(orders);
      setOrdersLoaded(true);
    } catch (error) {
      console.error('Failed to load order book:', error);
      setOrdersError(error instanceof Error ? error.message : 'Failed to load order book');
    } finally {
      setIsLoadingOrders(false);
    }
  };

  // Refresh order book
  const refreshOrderBook = async () => {
    setOrdersLoaded(false);
    await loadOrderBook();
  };

  // Load live external (manual) intraday P&L on demand (server force-fetches the order book first)
  const loadExternalPnl = async () => {
    if (!details || isLoadingExternalPnl) return;

    setIsLoadingExternalPnl(true);
    setExternalPnlError(null);

    try {
      const data = await terminalService.getExternalPnl(details.username, details.broker);
      setExternalPnl(data);
      setExternalPnlLoaded(true);
    } catch (error) {
      console.error('Failed to load external P&L:', error);
      setExternalPnlError(error instanceof Error ? error.message : 'Failed to load external P&L');
    } finally {
      setIsLoadingExternalPnl(false);
    }
  };

  // Refresh external P&L (recompute from a fresh order book)
  const refreshExternalPnl = async () => {
    setExternalPnlLoaded(false);
    await loadExternalPnl();
  };

  // Refresh trade signals
  const refreshTradeSignals = async () => {
    setSignalsLoaded(false);
    await loadTradeSignals();
  };

  // Load trade signals on demand
  const loadTradeSignals = async () => {
    if (!details || isLoadingSignals) return;

    setIsLoadingSignals(true);
    setSignalsError(null);

    try {
      const signals = await terminalService.getTradeSignals(details.username, details.broker);
      // Sort signals by strategy, group, hedge correlation, and time (similar to trades)
      const sortedSignals = sortTradeSignals(signals);
      setTradeSignals(sortedSignals);
      setSignalsLoaded(true);
    } catch (error) {
      console.error('Failed to load trade signals:', error);
      setSignalsError(error instanceof Error ? error.message : 'Failed to load trade signals');
    } finally {
      setIsLoadingSignals(false);
    }
  };

  // Friendly message for a failed lazy fetch (server message verbatim; timeout → retry hint).
  const fetchErrorMessage = (e: unknown): string => {
    const msg = (e && typeof e === 'object' && 'message' in e)
      ? String((e as { message?: string }).message) : 'Failed to load';
    return /timeout|timed out|ECONNABORTED/i.test(msg) ? 'Request timed out. Please retry.' : msg;
  };

  // Load strategy summaries on demand (Strategy Summaries tab).
  const loadStrategySummaries = async () => {
    if (!details || isLoadingStrategies) return;
    setIsLoadingStrategies(true);
    setStrategiesError(null);
    try {
      const res = await terminalService.getStrategySummaries(details.username, details.broker);
      setStrategyData(res.strategySummaries || {});
    } catch (error) {
      setStrategiesError(fetchErrorMessage(error));
    } finally {
      setIsLoadingStrategies(false);
    }
  };

  // Load risk profiles on demand (Risk Profile tab). Uses cached broker positions (force=false).
  const loadRiskProfiles = async () => {
    if (!details || isLoadingRisk) return;
    setIsLoadingRisk(true);
    setRiskError(null);
    try {
      // Don't fetch broker positions for risk when the viewer can't compare (algo-only risk).
      const res = await terminalService.getRiskProfiles(details.username, details.broker, {
        fetchBrokerPositions: canViewAlgoBrokerCompare,
      });
      setRiskData(res);
    } catch (error) {
      setRiskError(fetchErrorMessage(error));
    } finally {
      setIsLoadingRisk(false);
    }
  };

  // Format signal time
  const formatSignalTime = (timestamp: number | undefined): string => {
    if (!timestamp) return '-';
    try {
      return format(new Date(timestamp), 'HH:mm:ss');
    } catch {
      return '-';
    }
  };

  // Render order details link
  const renderOrderDetailsLink = () => {
    return (
      <span className="flex items-center gap-1 text-primary-700 dark:text-primary-400 ms-2" style={{ cursor: 'pointer' }}>
        <BsBoxArrowUpRight size={12} />
        <span className="text-[0.875em]">Details</span>
      </span>
    );
  };

  // Get short trade ID (last segment after final hyphen)
  const getShortTradeId = (tradeId: string | undefined): string => {
    if (!tradeId) return '-';
    const parts = tradeId.split('-');
    return parts[parts.length - 1] || tradeId;
  };

  // Handler for exiting position differences
  const handleExitDiff = async (positions: Array<{
    tradingSymbol: string;
    productType: string;
    exchange: string;
    segment: string;
    qtyDiff: number;
    isPaperTrading?: boolean;
  }>): Promise<ExitPositionsResponse | void> => {
    if (!onExitPositions || !details) return;

    const request: ExitPositionRequest = {
      username: details.username,
      broker: details.broker,
      clientID: details.clientID,
      positions: positions.map((pos) => ({
        tradingSymbol: pos.tradingSymbol,
        direction: pos.qtyDiff > 0 ? 'LONG' : 'SHORT',
        qty: Math.abs(pos.qtyDiff),
        productType: pos.productType,
        exchange: pos.exchange,
        segment: pos.segment,
        // Route a paper position's exit to the virtual broker (never the real one).
        isPaperTrading: pos.isPaperTrading,
      })),
    };

    return await onExitPositions(request);
  };

  // Shown inside a tab when the user lacks the View right for that section — the tab stays
  // visible (so its existence is discoverable) but its data is withheld.
  const renderNoAccess = (what: string) => (
    <Alert variant="secondary" className="text-center mb-0">
      You don&apos;t have permission to view {what}.
    </Alert>
  );

  // Shown inside a tab when that section's fetch failed/timed out (server error message verbatim).
  const renderSectionError = (message: string) => (
    <Alert variant="danger" className="text-center mb-0">
      {message}
    </Alert>
  );

  // Gate a trade-data tab body: no-access (no TRADES View) → fetch error → the data node.
  const renderTradeTab = (node: React.ReactNode) =>
    !canViewTrades ? renderNoAccess('trades') : tradesError ? renderSectionError(tradesError) : node;

  // Handler for strategy square off
  const handleStrategySquareOff = async (strategy: string) => {
    if (!onSquareOff || !details) return;

    const request: TerminalSquareOffRequest = {
      username: details.username,
      broker: details.broker,
      clientID: details.clientID,
      product: 'ALL',
      strategies: [strategy],
    };

    await onSquareOff(request);
  };

  // Handler for opening complete trade modal
  const handleOpenCompleteModal = (trade: ServerTrade, e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent row click
    setTradeToComplete(trade);
    setExitPrice(trade.cmp?.toString() || '');
    setExitDate(format(new Date(), 'yyyy-MM-dd'));
    setShowCompleteModal(true);
  };

  // Handler for completing a trade
  const handleCompleteTrade = async () => {
    if (!onCompleteTrade || !tradeToComplete || !exitPrice) return;

    setIsCompletingTrade(true);
    try {
      const price = parseFloat(exitPrice);
      // For intraday, exitDate is optional; for positional/cashbuy it's required
      const needsExitDate = tradeToComplete.productType !== 'INTRADAY';
      await onCompleteTrade(
        tradeToComplete.tradeID,
        price,
        needsExitDate ? exitDate : undefined
      );
      setShowCompleteModal(false);
      setTradeToComplete(null);
    } finally {
      setIsCompletingTrade(false);
    }
  };

  // Handler for opening square off confirmation
  const handleOpenSquareOffConfirm = (trade: ServerTrade, e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent row click
    setTradeToSquareOff(trade);
    setShowSquareOffConfirm(true);
  };

  // Handler for squaring off a trade
  const handleSquareOffTrade = async () => {
    if (!onSquareOffTrade || !tradeToSquareOff) return;

    setIsSquaringOffTrade(true);
    try {
      await onSquareOffTrade(tradeToSquareOff.tradeID);
      setShowSquareOffConfirm(false);
      setTradeToSquareOff(null);
    } finally {
      setIsSquaringOffTrade(false);
    }
  };

  // Handler for opening cancel trade confirmation
  const handleOpenCancelConfirm = (trade: ServerTrade, e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent row click
    setTradeToCancel(trade);
    setShowCancelConfirm(true);
  };

  // Handler for cancelling a trade
  const handleCancelTrade = async () => {
    if (!onCancelTrade || !tradeToCancel) return;

    setIsCancellingTrade(true);
    try {
      await onCancelTrade(tradeToCancel.tradeID);
      setShowCancelConfirm(false);
      setTradeToCancel(null);
    } finally {
      setIsCancellingTrade(false);
    }
  };

  if (isLoading) {
    return (
      <div className="user-details-panel p-6 text-center">
        <Spinner animation="border" variant="primary" />
        <p className="mt-2 text-ink-soft">Loading details...</p>
      </div>
    );
  }

  if (error) {
    return (
      <Alert variant="danger" className="m-4">
        {error}
      </Alert>
    );
  }

  if (!details) {
    return (
      <div className="user-details-panel p-6 text-center text-ink-soft">
        No details available
      </div>
    );
  }

  // Format timestamp with date for non-intraday trades (dd-MMM HH:mm:ss format)
  const formatDateTime = (timestamp: number | null | undefined, product: string): string => {
    if (!timestamp) return '-';
    const date = new Date(timestamp);
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    const seconds = date.getSeconds().toString().padStart(2, '0');

    // For non-intraday trades (POSITIONAL, CASHBUY, MTF, ...), include date
    if (product !== 'INTRADAY') {
      const day = date.getDate().toString().padStart(2, '0');
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const month = months[date.getMonth()];
      return `${day}-${month} ${hours}:${minutes}:${seconds}`;
    }

    // For intraday, just show time with milliseconds
    const millis = date.getMilliseconds().toString().padStart(3, '0');
    return `${hours}:${minutes}:${seconds}.${millis}`;
  };

  // Calculate totals for trades
  const calculateTotals = (trades: ServerTrade[]) => {
    return trades.reduce(
      (acc, trade) => ({
        profitLoss: acc.profitLoss + (trade.profitLoss || 0),
        charges: acc.charges + (trade.charges || 0),
        netProfitLoss: acc.netProfitLoss + (trade.netProfitLoss || 0),
      }),
      { profitLoss: 0, charges: 0, netProfitLoss: 0 }
    );
  };

  const getSortableValue = (trade: ServerTrade, key: string): string | number => {
    switch (key) {
      case 'tradeID':
        return trade.tradeID || '';
      case 'startTimestamp':
        return trade.startTimestamp || 0;
      case 'endTimestamp':
        return trade.endTimestamp || 0;
      case 'tradingSymbol':
        return trade.tradingSymbol || '';
      case 'productType':
        return trade.productType || '';
      case 'strategy':
        return trade.strategy || '';
      case 'group':
        return trade.group || '';
      case 'direction':
        return trade.direction || '';
      case 'hedgeDistancePercentage':
        return trade.hedgeDistancePercentage || 0;
      case 'quantity':
        return trade.quantity || 0;
      case 'filledQuantity':
        return trade.filledQuantity || 0;
      case 'entry':
        return trade.entry || 0;
      case 'cmp':
        return trade.cmp || 0;
      case 'stopLoss':
        return trade.stopLoss || 0;
      case 'target':
        return trade.target || 0;
      case 'requestedEntry':
        return trade.requestedEntry || 0;
      case 'exit':
        return trade.exit || 0;
      case 'netProfitLoss':
        return trade.netProfitLoss || 0;
      case 'plPercentage':
        return trade.plPercentage || 0;
      case 'exitReason':
        return trade.exitReason || '';
      case 'remarks':
        return trade.remarks || '';
      default:
        return '';
    }
  };

  const getSearchableText = (trade: ServerTrade): string => {
    return [
      trade.tradeID,
      trade.strategy,
      trade.product,
      trade.productType,
      trade.group,
      trade.tradingSymbol,
      trade.exchange,
      trade.segment,
      trade.direction,
      trade.quantity,
      trade.filledQuantity,
      trade.entry,
      trade.exit,
      trade.cmp,
      trade.stopLoss,
      trade.target,
      trade.requestedEntry,
      trade.requestedExit,
      trade.profitLoss,
      trade.charges,
      trade.netProfitLoss,
      trade.plPercentage,
      trade.exitReason,
      trade.remarks,
      trade.hedgeCorrelationID,
      trade.hedgeTradeID,
      trade.pairTradeCorrelationID,
      trade.order?.orderId,
      trade.order?.orderStatus,
      trade.slOrder?.orderId,
      trade.targetOrder?.orderId,
    ]
      .filter((value) => value !== null && value !== undefined && value !== '')
      .join(' ')
      .toLowerCase();
  };

  const prepareTrades = (trades: ServerTrade[]) => {
    const normalizedSearch = tradeSearch.trim().toLowerCase();
    const filtered = !normalizedSearch
      ? trades
      : trades.filter((trade) => getSearchableText(trade).includes(normalizedSearch));

    if (!tradeSortKey) {
      return filtered;
    }

    return [...filtered].sort((a, b) => {
      const aValue = getSortableValue(a, tradeSortKey);
      const bValue = getSortableValue(b, tradeSortKey);
      let result = 0;

      if (typeof aValue === 'number' && typeof bValue === 'number') {
        result = aValue - bValue;
      } else {
        result = String(aValue).localeCompare(String(bValue), undefined, {
          numeric: true,
          sensitivity: 'base',
        });
      }

      return tradeSortDirection === 'asc' ? result : -result;
    });
  };

  const handleTradeSort = (key: string) => {
    if (tradeSortKey === key) {
      if (tradeSortDirection === 'desc') {
        setTradeSortKey(null);
        setTradeSortDirection('desc');
        return;
      }

      setTradeSortDirection('desc');
      return;
    }

    setTradeSortKey(key);
    setTradeSortDirection('asc');
  };

  const renderSortableHeader = (label: string, key: string, className?: string) => (
    <th
      className={className}
      style={{ cursor: 'pointer', userSelect: 'none' }}
      onClick={() => handleTradeSort(key)}
    >
      <span className="inline-flex items-center gap-1">
        <span>{label}</span>
        {tradeSortKey === key ? (
          tradeSortDirection === 'asc' ? <BsArrowUp size={10} /> : <BsArrowDown size={10} />
        ) : (
          <BsArrowDownUp size={10} className="text-ink-soft" />
        )}
      </span>
    </th>
  );

  const renderTradeSearchBox = (filteredCount: number, totalCount: number) => (
    <div className="mb-4">
      <InputGroup size="sm">
        <InputGroup.Text>
          <BsSearch />
        </InputGroup.Text>
        <Form.Control
          value={tradeSearch}
          onChange={(e) => setTradeSearch(e.target.value)}
          placeholder="Search symbol, strategy, exit reason, group, remarks..."
        />
      </InputGroup>
      <div className="mt-1 text-ink-soft text-[0.875em]">
        Showing {filteredCount} of {totalCount} trades
      </div>
    </div>
  );

  const handleTabSelect = (tabKey: string | null) => {
    const key = tabKey || 'positions';
    setActiveTab(key);
    // Lazy-load the summary-derived tabs the first time they're opened (only if permitted).
    if (key === 'strategies' && canViewStrategySummaries && strategyData === null && !isLoadingStrategies) {
      loadStrategySummaries();
    }
    if (key === 'risk' && canViewRiskProfile && riskData === null && !isLoadingRisk) {
      loadRiskProfiles();
    }
  };

  // Render Active Trades table
  // Columns: SNo, Trade ID, Trade Start, Symbol, Product, Strategy, Group, Direction, Qty, Entry, CMP, SL, Target, Net P/L, P/L %, Actions, Details
  const renderActiveTradesTable = (trades: ServerTrade[]) => {
    const visibleTrades = prepareTrades(trades);
    if (!trades || trades.length === 0) {
      return <p className="text-ink-soft text-center py-4">No active trades</p>;
    }

    if (visibleTrades.length === 0) {
      return (
        <>
          {renderTradeSearchBox(0, trades.length)}
          <p className="text-ink-soft text-center py-4 mb-0">No trades match the current search</p>
        </>
      );
    }

    const totals = calculateTotals(visibleTrades);

    return (
      <>
        {renderTradeSearchBox(visibleTrades.length, trades.length)}
      <Table size="sm" hover responsive className="mb-0">
        <thead className="sticky top-0 z-[1] bg-raised text-ink-faint">
          <tr>
            <th>#</th>
            {renderSortableHeader('Trade ID', 'tradeID')}
            {renderSortableHeader('Start Time', 'startTimestamp')}
            {renderSortableHeader('Symbol', 'tradingSymbol')}
            {renderSortableHeader('Product', 'productType')}
            {renderSortableHeader('Strategy', 'strategy')}
            {renderSortableHeader('Group', 'group')}
            {renderSortableHeader('Dir', 'direction')}
            {renderSortableHeader('Hedge %', 'hedgeDistancePercentage', 'text-center')}
            {renderSortableHeader('Qty', 'filledQuantity', 'text-end')}
            {renderSortableHeader('Entry', 'entry', 'text-end')}
            {renderSortableHeader('CMP', 'cmp', 'text-end')}
            {renderSortableHeader('SL', 'stopLoss', 'text-end')}
            {renderSortableHeader('Target', 'target', 'text-end')}
            {renderSortableHeader('Net P/L', 'netProfitLoss', 'text-end')}
            {renderSortableHeader('P/L %', 'plPercentage', 'text-end pe-4')}
            <th className="text-center">Actions</th>
            <th>Details</th>
          </tr>
        </thead>
        <tbody>
          {visibleTrades.map((trade, idx) => (
            <tr
              key={trade.tradeID || idx}
              onClick={() => handleTradeClick(trade)}
              style={{ cursor: 'pointer' }}
              className="trade-row"
            >
              <td>{idx + 1}</td>
              <td><code className="text-[0.875em]">{getShortTradeId(trade.tradeID)}</code></td>
              <td className="whitespace-nowrap">{formatDateTime(trade.startTimestamp, trade.product)}</td>
              <td>
                <span className="font-medium">{trade.tradingSymbol}</span>
                <small className="text-ink-soft ms-1">{trade.exchange}</small>
                <TradeModeBadge isMock={trade.isMock} isPaperTrading={trade.isPaperTrading} noun="trade" />
              </td>
              <td>{trade.productType}</td>
              <td>
                <Badge bg="secondary" className="text-[0.875em]">{trade.strategy}</Badge>
              </td>
              <td>{trade.group || '-'}</td>
              <td>
                {trade.direction === 'LONG' ? (
                  <Badge bg="success"><BsArrowUp /> L</Badge>
                ) : (
                  <Badge bg="danger"><BsArrowDown /> S</Badge>
                )}
              </td>
              <td className="text-center">
                {trade.hedgeDistancePercentage && trade.hedgeDistancePercentage > 0 ? (
                  <Badge bg="info">{trade.hedgeDistancePercentage}%</Badge>
                ) : '-'}
              </td>
              <td className="text-end">{trade.filledQuantity ?? 0}/{trade.quantity}{(trade.caFactor ?? 1) !== 1 && (<span className="ml-1 inline-block rounded bg-primary-100 dark:bg-primary-900/40 text-primary-700 dark:text-primary-300 text-[0.7em] font-semibold px-1 align-middle" title={`Corporate action applied: quantities ×${trade.caFactor} (original ${trade.originalFilledQuantity ?? trade.originalQuantity} @ ₹${trade.originalEntry})`}>⑂ ×{trade.caFactor}</span>)}</td>
              <td className="text-end">{trade.entry?.toFixed(2)}</td>
              <td className="text-end">{trade.cmp?.toFixed(2)}</td>
              <td className="text-end">{trade.stopLoss ? trade.stopLoss.toFixed(2) : '-'}</td>
              <td className="text-end">{trade.target ? trade.target.toFixed(2) : '-'}</td>
              <td className="text-end"><PnLDisplay value={trade.netProfitLoss} size="sm" fullFormat /></td>
              <td className="text-end pe-4"><PnLDisplay value={trade.plPercentage} size="sm" showSign={true} /></td>
              <td className="text-center">
                <div className="inline-flex gap-1">
                  {canEditTrades && (
                  <OverlayTrigger
                    placement="top"
                    overlay={<Tooltip>Set As Complete</Tooltip>}
                  >
                    <Button
                      variant="outline-success"
                      size="sm"
                      className="p-1"
                      onClick={(e) => handleOpenCompleteModal(trade, e)}
                      disabled={!onCompleteTrade}
                    >
                      <BsCheckSquare size={14} />
                    </Button>
                  </OverlayTrigger>
                  )}
                  {canSquareOff && (
                  <OverlayTrigger
                    placement="top"
                    overlay={<Tooltip>Square Off</Tooltip>}
                  >
                    <Button
                      variant="outline-danger"
                      size="sm"
                      className="p-1"
                      onClick={(e) => handleOpenSquareOffConfirm(trade, e)}
                      disabled={!onSquareOffTrade}
                    >
                      <BsXSquare size={14} />
                    </Button>
                  </OverlayTrigger>
                  )}
                </div>
              </td>
              <td>{renderOrderDetailsLink()}</td>
            </tr>
          ))}
          <tr className="bg-raised font-bold">
            <td colSpan={14}>TOTAL</td>
            <td className="text-end"><PnLDisplay value={totals.netProfitLoss} size="sm" fullFormat /></td>
            <td colSpan={3}></td>
          </tr>
        </tbody>
      </Table>
      </>
    );
  };

  // Render Completed Trades table
  // Columns: #, Trade ID, Start Time, End Time, Symbol, Product, Strategy, Group, Dir, Hedge %, Qty, Entry, Exit, Net P/L, P/L %, Exit Reason, Details
  const renderCompletedTradesTable = (trades: ServerTrade[]) => {
    const visibleTrades = prepareTrades(trades);
    if (!trades || trades.length === 0) {
      return <p className="text-ink-soft text-center py-4">No completed trades</p>;
    }

    if (visibleTrades.length === 0) {
      return (
        <>
          {renderTradeSearchBox(0, trades.length)}
          <p className="text-ink-soft text-center py-4 mb-0">No trades match the current search</p>
        </>
      );
    }

    const totals = calculateTotals(visibleTrades);

    return (
      <>
      {renderTradeSearchBox(visibleTrades.length, trades.length)}
      <Table size="sm" hover responsive className="mb-0">
        <thead className="sticky top-0 z-[1] bg-raised text-ink-faint">
          <tr>
            <th>#</th>
            {renderSortableHeader('Trade ID', 'tradeID')}
            {renderSortableHeader('Start Time', 'startTimestamp')}
            {renderSortableHeader('End Time', 'endTimestamp')}
            {renderSortableHeader('Symbol', 'tradingSymbol')}
            {renderSortableHeader('Product', 'productType')}
            {renderSortableHeader('Strategy', 'strategy')}
            {renderSortableHeader('Group', 'group')}
            {renderSortableHeader('Dir', 'direction')}
            {renderSortableHeader('Hedge %', 'hedgeDistancePercentage', 'text-center')}
            {renderSortableHeader('Qty', 'filledQuantity', 'text-end')}
            {renderSortableHeader('Entry', 'entry', 'text-end')}
            {renderSortableHeader('Exit', 'exit', 'text-end')}
            {renderSortableHeader('Net P/L', 'netProfitLoss', 'text-end')}
            {renderSortableHeader('P/L %', 'plPercentage', 'text-end')}
            {renderSortableHeader('Exit Reason', 'exitReason')}
            <th>Details</th>
          </tr>
        </thead>
        <tbody>
          {visibleTrades.map((trade, idx) => (
            <tr
              key={trade.tradeID || idx}
              onClick={() => handleTradeClick(trade)}
              style={{ cursor: 'pointer' }}
              className="trade-row"
            >
              <td>{idx + 1}</td>
              <td><code className="text-[0.875em]">{getShortTradeId(trade.tradeID)}</code></td>
              <td className="whitespace-nowrap">{formatDateTime(trade.startTimestamp, trade.product)}</td>
              <td className="whitespace-nowrap">{formatDateTime(trade.endTimestamp, trade.product)}</td>
              <td>
                <span className="font-medium">{trade.tradingSymbol}</span>
                <small className="text-ink-soft ms-1">{trade.exchange}</small>
                <TradeModeBadge isMock={trade.isMock} isPaperTrading={trade.isPaperTrading} noun="trade" />
              </td>
              <td>{trade.productType}</td>
              <td>
                <Badge bg="secondary" className="text-[0.875em]">{trade.strategy}</Badge>
              </td>
              <td>{trade.group || '-'}</td>
              <td>
                {trade.direction === 'LONG' ? (
                  <Badge bg="success"><BsArrowUp /> L</Badge>
                ) : (
                  <Badge bg="danger"><BsArrowDown /> S</Badge>
                )}
              </td>
              <td className="text-center">
                {trade.hedgeDistancePercentage && trade.hedgeDistancePercentage > 0 ? (
                  <Badge bg="info">{trade.hedgeDistancePercentage}%</Badge>
                ) : '-'}
              </td>
              <td className="text-end">{trade.filledQuantity ?? 0}/{trade.quantity}{(trade.caFactor ?? 1) !== 1 && (<span className="ml-1 inline-block rounded bg-primary-100 dark:bg-primary-900/40 text-primary-700 dark:text-primary-300 text-[0.7em] font-semibold px-1 align-middle" title={`Corporate action applied: quantities ×${trade.caFactor} (original ${trade.originalFilledQuantity ?? trade.originalQuantity} @ ₹${trade.originalEntry})`}>⑂ ×{trade.caFactor}</span>)}</td>
              <td className="text-end">{trade.entry?.toFixed(2)}</td>
              <td className="text-end">{trade.exit?.toFixed(2)}</td>
              <td className="text-end"><PnLDisplay value={trade.netProfitLoss} size="sm" fullFormat /></td>
              <td className="text-end"><span className="me-4"><PnLDisplay value={trade.plPercentage} size="sm" showSign={true} /></span></td>
              <td>{trade.exitReason || '-'}</td>
              <td>{renderOrderDetailsLink()}</td>
            </tr>
          ))}
          <tr className="bg-raised font-bold">
            <td colSpan={13}>TOTAL</td>
            <td className="text-end"><PnLDisplay value={totals.netProfitLoss} size="sm" fullFormat /></td>
            <td colSpan={3}></td>
          </tr>
        </tbody>
      </Table>
      </>
    );
  };

  // Render Open Trades table (orders placed but not filled)
  // Columns: #, Trade ID, Start Time, Symbol, Product, Strategy, Group, Dir, Hedge %, Qty, Req Entry, CMP, SL, Actions, Remarks, Details
  const renderOpenTradesTable = (trades: ServerTrade[]) => {
    const visibleTrades = prepareTrades(trades);
    if (!trades || trades.length === 0) {
      return <p className="text-ink-soft text-center py-4">No open trades</p>;
    }

    if (visibleTrades.length === 0) {
      return (
        <>
          {renderTradeSearchBox(0, trades.length)}
          <p className="text-ink-soft text-center py-4 mb-0">No trades match the current search</p>
        </>
      );
    }

    return (
      <>
      {renderTradeSearchBox(visibleTrades.length, trades.length)}
      <Table size="sm" hover responsive className="mb-0">
        <thead className="sticky top-0 z-[1] bg-raised text-ink-faint">
          <tr>
            <th>#</th>
            {renderSortableHeader('Trade ID', 'tradeID')}
            {renderSortableHeader('Start Time', 'startTimestamp')}
            {renderSortableHeader('Symbol', 'tradingSymbol')}
            {renderSortableHeader('Product', 'productType')}
            {renderSortableHeader('Strategy', 'strategy')}
            {renderSortableHeader('Group', 'group')}
            {renderSortableHeader('Dir', 'direction')}
            {renderSortableHeader('Hedge %', 'hedgeDistancePercentage', 'text-center')}
            {renderSortableHeader('Qty', 'quantity', 'text-end')}
            {renderSortableHeader('Req Entry', 'requestedEntry', 'text-end')}
            {renderSortableHeader('CMP', 'cmp', 'text-end')}
            {renderSortableHeader('SL', 'stopLoss', 'text-end')}
            <th className="text-center">Actions</th>
            {renderSortableHeader('Remarks', 'remarks')}
            <th>Details</th>
          </tr>
        </thead>
        <tbody>
          {visibleTrades.map((trade, idx) => (
            <tr
              key={trade.tradeID || idx}
              onClick={() => handleTradeClick(trade)}
              style={{ cursor: 'pointer' }}
              className="trade-row"
            >
              <td>{idx + 1}</td>
              <td><code className="text-[0.875em]">{getShortTradeId(trade.tradeID)}</code></td>
              <td className="whitespace-nowrap">{formatDateTime(trade.startTimestamp, trade.product)}</td>
              <td>
                <span className="font-medium">{trade.tradingSymbol}</span>
                <small className="text-ink-soft ms-1">{trade.exchange}</small>
                <TradeModeBadge isMock={trade.isMock} isPaperTrading={trade.isPaperTrading} noun="trade" />
              </td>
              <td>{trade.productType}</td>
              <td>
                <Badge bg="secondary" className="text-[0.875em]">{trade.strategy}</Badge>
              </td>
              <td>{trade.group || '-'}</td>
              <td>
                {trade.direction === 'LONG' ? (
                  <Badge bg="success"><BsArrowUp /> L</Badge>
                ) : (
                  <Badge bg="danger"><BsArrowDown /> S</Badge>
                )}
              </td>
              <td className="text-center">
                {trade.hedgeDistancePercentage && trade.hedgeDistancePercentage > 0 ? (
                  <Badge bg="info">{trade.hedgeDistancePercentage}%</Badge>
                ) : '-'}
              </td>
              <td className="text-end">{trade.quantity}</td>
              <td className="text-end">{trade.requestedEntry?.toFixed(2)}</td>
              <td className="text-end">{trade.cmp?.toFixed(2)}</td>
              <td className="text-end">{trade.stopLoss ? trade.stopLoss.toFixed(2) : '-'}</td>
              <td className="text-center">
                <OverlayTrigger
                  placement="top"
                  overlay={<Tooltip>Cancel Trade</Tooltip>}
                >
                  <Button
                    variant="outline-warning"
                    size="sm"
                    className="p-1"
                    onClick={(e) => handleOpenCancelConfirm(trade, e)}
                    disabled={!onCancelTrade}
                  >
                    <BsXSquare size={14} />
                  </Button>
                </OverlayTrigger>
              </td>
              <td>{trade.remarks || '-'}</td>
              <td>{renderOrderDetailsLink()}</td>
            </tr>
          ))}
        </tbody>
      </Table>
      </>
    );
  };

  // Render Cancelled Trades table
  // Columns: #, Trade ID, Start Time, Symbol, Product, Strategy, Group, Dir, Hedge %, Qty, Req Entry, Exit Reason, Remarks, Details
  const renderCancelledTradesTable = (trades: ServerTrade[]) => {
    const visibleTrades = prepareTrades(trades);
    if (!trades || trades.length === 0) {
      return <p className="text-ink-soft text-center py-4">No cancelled trades</p>;
    }

    if (visibleTrades.length === 0) {
      return (
        <>
          {renderTradeSearchBox(0, trades.length)}
          <p className="text-ink-soft text-center py-4 mb-0">No trades match the current search</p>
        </>
      );
    }

    return (
      <>
      {renderTradeSearchBox(visibleTrades.length, trades.length)}
      <Table size="sm" hover responsive className="mb-0">
        <thead className="sticky top-0 z-[1] bg-raised text-ink-faint">
          <tr>
            <th>#</th>
            {renderSortableHeader('Trade ID', 'tradeID')}
            {renderSortableHeader('Start Time', 'startTimestamp')}
            {renderSortableHeader('End Time', 'endTimestamp')}
            {renderSortableHeader('Symbol', 'tradingSymbol')}
            {renderSortableHeader('Product', 'productType')}
            {renderSortableHeader('Strategy', 'strategy')}
            {renderSortableHeader('Group', 'group')}
            {renderSortableHeader('Dir', 'direction')}
            {renderSortableHeader('Hedge %', 'hedgeDistancePercentage', 'text-center')}
            {renderSortableHeader('Qty', 'quantity', 'text-end')}
            {renderSortableHeader('Req Entry', 'requestedEntry', 'text-end')}
            {renderSortableHeader('Exit Reason', 'exitReason')}
            {renderSortableHeader('Remarks', 'remarks')}
            <th>Details</th>
          </tr>
        </thead>
        <tbody>
          {visibleTrades.map((trade, idx) => (
            <tr
              key={trade.tradeID || idx}
              onClick={() => handleTradeClick(trade)}
              style={{ cursor: 'pointer' }}
              className="trade-row"
            >
              <td>{idx + 1}</td>
              <td><code className="text-[0.875em]">{getShortTradeId(trade.tradeID)}</code></td>
              <td className="whitespace-nowrap">{formatDateTime(trade.startTimestamp, trade.product)}</td>
              <td className="whitespace-nowrap">{formatDateTime(trade.endTimestamp, trade.product)}</td>
              <td>
                <span className="font-medium">{trade.tradingSymbol}</span>
                <small className="text-ink-soft ms-1">{trade.exchange}</small>
                <TradeModeBadge isMock={trade.isMock} isPaperTrading={trade.isPaperTrading} noun="trade" />
              </td>
              <td>{trade.productType}</td>
              <td>
                <Badge bg="secondary" className="text-[0.875em]">{trade.strategy}</Badge>
              </td>
              <td>{trade.group || '-'}</td>
              <td>
                {trade.direction === 'LONG' ? (
                  <Badge bg="success"><BsArrowUp /> L</Badge>
                ) : (
                  <Badge bg="danger"><BsArrowDown /> S</Badge>
                )}
              </td>
              <td className="text-center">
                {trade.hedgeDistancePercentage && trade.hedgeDistancePercentage > 0 ? (
                  <Badge bg="info">{trade.hedgeDistancePercentage}%</Badge>
                ) : '-'}
              </td>
              <td className="text-end">{trade.quantity}</td>
              <td className="text-end">{trade.requestedEntry?.toFixed(2) || '-'}</td>
              <td>{trade.exitReason || '-'}</td>
              <td>{trade.remarks || '-'}</td>
              <td>{renderOrderDetailsLink()}</td>
            </tr>
          ))}
        </tbody>
      </Table>
      </>
    );
  };

  // Render Trade Signals table
  const renderTradeSignalsTable = () => {
    if (!signalsLoaded) {
      return (
        <div className="text-center py-6">
          <Button
            variant="primary"
            onClick={loadTradeSignals}
            disabled={isLoadingSignals}
          >
            {isLoadingSignals ? (
              <>
                <Spinner animation="border" size="sm" className="me-2" />
                Loading...
              </>
            ) : (
              <>
                <BsLightningCharge className="me-2" />
                Load Trade Signals
              </>
            )}
          </Button>
          <p className="text-ink-soft text-[0.875em] mt-2">Click to fetch today's trade signals</p>
        </div>
      );
    }

    if (signalsError) {
      return (
        <Alert variant="danger" className="m-4">
          {signalsError}
          <Button variant="link" className="p-0 ms-2" onClick={loadTradeSignals}>
            Retry
          </Button>
        </Alert>
      );
    }

    if (!tradeSignals || tradeSignals.length === 0) {
      return (
        <div>
          <div className="flex justify-end mb-2">
            <Button
              variant="outline-primary"
              size="sm"
              onClick={refreshTradeSignals}
              disabled={isLoadingSignals}
            >
              {isLoadingSignals ? (
                <Spinner animation="border" size="sm" />
              ) : (
                <BsArrowRepeat />
              )}
              <span className="ms-1">Refresh</span>
            </Button>
          </div>
          <p className="text-ink-soft text-center py-4">No trade signals for today</p>
        </div>
      );
    }

    const getSignalSearchableText = (signal: TradeSignal): string => {
      return [
        signal.tradeSignalID,
        signal.strategy,
        signal.group,
        signal.tradingSymbol,
        signal.exchange,
        signal.segment,
        signal.product,
        signal.productType,
        signal.direction,
        signal.tradeSignalType,
        signal.quantity,
        signal.trigger,
        signal.stopLoss,
        signal.target,
        signal.disabledReason,
        signal.disabled ? 'disabled' : signal.isTriggered ? 'triggered' : 'pending',
      ]
        .filter((value) => value !== null && value !== undefined && value !== '')
        .join(' ')
        .toLowerCase();
    };

    const normalizedSignalSearch = signalSearch.trim().toLowerCase();
    const visibleSignals = !normalizedSignalSearch
      ? tradeSignals
      : tradeSignals.filter((signal) => getSignalSearchableText(signal).includes(normalizedSignalSearch));

    return (
      <div>
        <div className="flex justify-between items-start gap-2 mb-2">
          <div className="grow" style={{ maxWidth: '420px' }}>
            <InputGroup size="sm">
              <InputGroup.Text>
                <BsSearch />
              </InputGroup.Text>
              <Form.Control
                value={signalSearch}
                onChange={(e) => setSignalSearch(e.target.value)}
                placeholder="Search symbol, strategy, group, status..."
              />
            </InputGroup>
            <div className="mt-1 text-ink-soft text-[0.875em]">
              Showing {visibleSignals.length} of {tradeSignals.length} signals
            </div>
          </div>
          <Button
            variant="outline-primary"
            size="sm"
            onClick={refreshTradeSignals}
            disabled={isLoadingSignals}
          >
            {isLoadingSignals ? (
              <Spinner animation="border" size="sm" />
            ) : (
              <BsArrowRepeat />
            )}
            <span className="ms-1">Refresh</span>
          </Button>
        </div>
        {visibleSignals.length === 0 && (
          <p className="text-ink-soft text-center py-4 mb-0">No trade signals match the current search</p>
        )}
        <Table size="sm" hover responsive className="mb-0">
          <thead className="sticky top-0 z-[1] bg-raised text-ink-faint">
            <tr>
              <th>#</th>
              <th>Signal ID</th>
              <th>Time</th>
              <th>Symbol</th>
              <th>Product</th>
              <th>Strategy</th>
              <th>Group</th>
              <th>Dir</th>
              <th>Type</th>
              <th className="text-end">Qty</th>
              <th className="text-end">Trigger</th>
              <th className="text-end">SL</th>
              <th className="text-end">Target</th>
              <th>Status</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {visibleSignals.map((signal, idx) => (
              <tr
                key={signal.tradeSignalID || idx}
                onClick={() => handleSignalClick(signal)}
                style={{ cursor: 'pointer' }}
                className={`signal-row ${signal.disabled ? 'bg-raised' : signal.isTriggered ? 'bg-success-500/10' : ''}`}
              >
                <td>{idx + 1}</td>
                <td><code className="text-[0.875em]">{getShortTradeId(signal.tradeSignalID)}</code></td>
                <td className="whitespace-nowrap">{formatSignalTime(signal.signalGenerationTime)}</td>
                <td>
                  <span className="font-medium">{signal.tradingSymbol}</span>
                  <small className="text-ink-soft ms-1">{signal.exchange}</small>
                  <TradeModeBadge isMock={signal.isMock} isPaperTrading={signal.isPaperTrading} noun="signal" />
                </td>
                <td>{signal.product}</td>
                <td>
                  <Badge bg="secondary" className="text-[0.875em]">{signal.strategy}</Badge>
                </td>
                <td>{signal.group || '-'}</td>
                <td>
                  {signal.direction === 'LONG' ? (
                    <Badge bg="success"><BsArrowUp /> L</Badge>
                  ) : (
                    <Badge bg="danger"><BsArrowDown /> S</Badge>
                  )}
                </td>
                <td>
                  <Badge bg={signal.tradeSignalType?.includes('ENTRY') ? 'info' : 'warning'}>
                    {signal.tradeSignalType?.replace('_', ' ')}
                  </Badge>
                </td>
                <td className="text-end">{signal.quantity}</td>
                <td className="text-end">{signal.trigger?.toFixed(2) || '-'}</td>
                <td className="text-end">{signal.stopLoss?.toFixed(2) || '-'}</td>
                <td className="text-end">{signal.target?.toFixed(2) || '-'}</td>
                <td>
                  {signal.disabled ? (
                    <OverlayTrigger
                      placement="top"
                      overlay={<Tooltip>{signal.disabledReason || 'Disabled'}</Tooltip>}
                    >
                      <Badge bg="secondary">Disabled</Badge>
                    </OverlayTrigger>
                  ) : signal.isTriggered ? (
                    <Badge bg="success">Triggered</Badge>
                  ) : (
                    <Badge bg="warning">Pending</Badge>
                  )}
                </td>
                <td>{renderOrderDetailsLink()}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      </div>
    );
  };

  // Render order book tab content
  const renderOrderBookTab = () => {
    if (!ordersLoaded) {
      return (
        <div className="text-center py-6">
          <Button
            variant="primary"
            onClick={loadOrderBook}
            disabled={isLoadingOrders}
          >
            {isLoadingOrders ? (
              <>
                <Spinner animation="border" size="sm" className="me-2" />
                Loading...
              </>
            ) : (
              <>
                <BsJournalText className="me-2" />
                Fetch Order Book
              </>
            )}
          </Button>
          <p className="text-ink-soft text-[0.875em] mt-2">Click to fetch today's order book from broker</p>
        </div>
      );
    }

    if (ordersError) {
      return (
        <Alert variant="danger" className="m-4">
          {ordersError}
          <Button variant="link" className="p-0 ms-2" onClick={loadOrderBook}>
            Retry
          </Button>
        </Alert>
      );
    }

    return (
      <div>
        <div className="flex justify-end mb-2">
          <Button
            variant="outline-primary"
            size="sm"
            onClick={refreshOrderBook}
            disabled={isLoadingOrders}
          >
            {isLoadingOrders ? (
              <Spinner animation="border" size="sm" />
            ) : (
              <BsArrowRepeat />
            )}
            <span className="ms-1">Refresh</span>
          </Button>
        </div>
        <OrderBookTable
          orders={orderBook}
          onOrderClick={handleOrderClick}
          tradingMode={tradingMode}
        />
      </div>
    );
  };

  const renderExternalPnlTab = () => {
    if (!externalPnlLoaded) {
      return (
        <div className="text-center py-6">
          <Button
            variant="primary"
            onClick={loadExternalPnl}
            disabled={isLoadingExternalPnl}
          >
            {isLoadingExternalPnl ? (
              <>
                <Spinner animation="border" size="sm" className="me-2" />
                Calculating...
              </>
            ) : (
              <>
                <BsJournalText className="me-2" />
                Fetch External P&L
              </>
            )}
          </Button>
          <p className="text-ink-soft text-[0.875em] mt-2">
            Computes live P&amp;L for externally (manually) traded intraday options from a freshly-fetched order book.
          </p>
        </div>
      );
    }

    if (externalPnlError) {
      return (
        <Alert variant="danger" className="m-4">
          {externalPnlError}
          <Button variant="link" className="p-0 ms-2" onClick={loadExternalPnl}>
            Retry
          </Button>
        </Alert>
      );
    }

    if (!externalPnl) {
      return <p className="text-ink-soft text-center py-4">No external P&L data available</p>;
    }

    const ep = externalPnl;
    const fmtMoney = (v: number) => `₹${(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    // P&L values in the summary panel: signed ₹ with 2 decimals so they right-align with the charges.
    const fmtPnl = (v: number) => `${(v || 0) < 0 ? '-' : ''}₹${Math.abs(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const pnlClass = (v: number) => ((v || 0) > 0 ? 'text-success-500 dark:text-success-400' : (v || 0) < 0 ? 'text-danger-600 dark:text-danger-400' : 'text-ink-soft');
    const returnsPct = ep.capital > 0 ? (ep.netPnl / ep.capital) * 100 : null;

    return (
      <div>
        <div className="flex justify-between items-center mb-2">
          <span className="text-ink-soft text-[0.875em]">
            External intraday (MIS) options · fetched {format(new Date(ep.fetchedAt), 'HH:mm:ss')}
          </span>
          <Button
            variant="outline-primary"
            size="sm"
            onClick={refreshExternalPnl}
            disabled={isLoadingExternalPnl}
          >
            {isLoadingExternalPnl ? <Spinner animation="border" size="sm" /> : <BsArrowRepeat />}
            <span className="ms-1">Refresh</span>
          </Button>
        </div>

        {ep.symbols.length === 0 && (
          <p className="text-ink-soft text-center py-4">No external intraday option orders found today.</p>
        )}

        {ep.warnings && ep.warnings.length > 0 && (
          <Alert variant="warning" className="py-2">
            {ep.warnings.map((w, i) => <div key={i} className="text-[0.875em]">{w}</div>)}
          </Alert>
        )}

        {ep.symbols.length > 0 && (
        <Row className="">
          <Col md={6} lg={5}>
            <Card className="border">
              <Card.Header className="py-2"><h6 className="mb-0">P&amp;L Summary</h6></Card.Header>
              <Card.Body>
                <div className="flex justify-between mb-2">
                  <span className="text-ink-soft">Realized P&amp;L</span>
                  <span className={`font-bold ${pnlClass(ep.realizedPnl)}`}>{fmtPnl(ep.realizedPnl)}</span>
                </div>
                <div className="flex justify-between mb-2">
                  <span className="text-ink-soft">Unrealized P&amp;L (MTM)</span>
                  <span className={`font-bold ${pnlClass(ep.unrealizedPnl)}`}>{fmtPnl(ep.unrealizedPnl)}</span>
                </div>
                <div className="flex justify-between mb-4 border-t pt-2">
                  <span className="font-bold">Gross P&amp;L</span>
                  <span className={`font-bold ${pnlClass(ep.grossPnl)}`}>{fmtPnl(ep.grossPnl)}</span>
                </div>
                <div className="flex justify-between mb-2">
                  <span className="text-ink-soft">Total Charges</span>
                  <span className="font-bold text-danger-600 dark:text-danger-400">-{fmtMoney(ep.totalCharges)}</span>
                </div>
                <div className="flex justify-between mb-2 border-t pt-2">
                  <span className="font-bold text-base">Net P&amp;L</span>
                  <span className={`font-bold text-base ${pnlClass(ep.netPnl)}`}>{fmtPnl(ep.netPnl)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-ink-soft">External Capital</span>
                  <span className="font-bold">
                    {fmtMoney(ep.capital)}
                    {returnsPct !== null && (
                      <span className={`ms-2 ${returnsPct >= 0 ? 'text-success-500 dark:text-success-400' : 'text-danger-600 dark:text-danger-400'}`}>
                        ({returnsPct >= 0 ? '+' : ''}{returnsPct.toFixed(2)}%)
                      </span>
                    )}
                  </span>
                </div>
              </Card.Body>
            </Card>
          </Col>

          <Col md={6} lg={4}>
            <Card className="border">
              <Card.Header className="py-2"><h6 className="mb-0">Charges Breakdown</h6></Card.Header>
              <Card.Body>
                <div className="flex justify-between mb-2">
                  <span className="text-ink-soft">Brokerage</span><span>{fmtMoney(ep.brokerage)}</span>
                </div>
                <div className="flex justify-between mb-2">
                  <span className="text-ink-soft">STT</span><span>{fmtMoney(ep.sttCharges)}</span>
                </div>
                <div className="flex justify-between mb-2">
                  <span className="text-ink-soft">Transaction (Exchange)</span><span>{fmtMoney(ep.transactionCharges)}</span>
                </div>
                <div className="flex justify-between mb-2">
                  <span className="text-ink-soft">SEBI Charges</span><span>{fmtMoney(ep.sebiCharges)}</span>
                </div>
                <div className="flex justify-between mb-2">
                  <span className="text-ink-soft">Stamp Duty</span><span>{fmtMoney(ep.stampDutyCharges)}</span>
                </div>
                <div className="flex justify-between mb-2">
                  <span className="text-ink-soft">GST</span><span>{fmtMoney(ep.gstCharges)}</span>
                </div>
                <div className="flex justify-between border-t pt-2">
                  <span className="font-bold">Total Charges</span>
                  <span className="font-bold text-danger-600 dark:text-danger-400">{fmtMoney(ep.totalCharges)}</span>
                </div>
              </Card.Body>
            </Card>
          </Col>
        </Row>
        )}

        {ep.symbols.length > 0 && (
          <div className="mt-4">
            <h6 className="mb-2">Per-Symbol Detail</h6>
            <Table size="sm" bordered hover responsive>
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th className="text-end">Open Qty</th>
                  <th className="text-end">CMP</th>
                  <th className="text-end">Realized</th>
                  <th className="text-end">Unrealized</th>
                  <th className="text-end">P&amp;L</th>
                  <th className="text-end">Charges</th>
                </tr>
              </thead>
              <tbody>
                {ep.symbols.map((s) => (
                  <tr key={s.tradingSymbol}>
                    <td>{s.tradingSymbol}</td>
                    <td className="text-end">{s.netOpenQty}</td>
                    <td className="text-end">{s.netOpenQty !== 0 ? s.cmp.toFixed(2) : '-'}</td>
                    <td className="text-end"><PnLDisplay value={s.realizedPnl} size="sm" fullFormat /></td>
                    <td className="text-end"><PnLDisplay value={s.unrealizedPnl} size="sm" fullFormat /></td>
                    <td className="text-end"><PnLDisplay value={s.pnl} size="sm" fullFormat /></td>
                    <td className="text-end">{fmtMoney(s.charges)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        )}
      </div>
    );
  };


  return (
    <div className="user-details-panel p-4">
      <Card>
        <Card.Body className="p-0">
          <Tabs
            activeKey={activeTab}
            onSelect={handleTabSelect}
            className="mb-0"
          >
            <Tab
              eventKey="positions"
              title={
                <span>
                  Positions
                  {canViewAlgoBrokerCompare && (details.mismatches?.length || 0) > 0 && (
                    <Badge bg="danger" className="ms-1">
                      {details.mismatches?.length}
                    </Badge>
                  )}
                </span>
              }
            >
              <div className="p-4">
                {!canViewPositions
                  ? renderNoAccess('positions')
                  : positionsError
                    ? renderSectionError(positionsError)
                    : (
                      <ComparePositionsTable
                        algoPositions={details.algoPositions || []}
                        brokerPositions={details.brokerPositions || []}
                        mismatches={details.mismatches || []}
                        disableActions={!onExitPositions}
                        onExitDiff={handleExitDiff}
                        onRefresh={onRefresh}
                        isRefreshing={isRefreshing}
                      />
                    )}
              </div>
            </Tab>

            <Tab
              eventKey="active"
              title={
                <span>
                  Active
                  <Badge bg="blue" className="ms-1">
                    {details.activeTrades?.length || 0}
                  </Badge>
                </span>
              }
            >
              <div className="p-4">
                {renderTradeTab(
                  <div className="terminal-tab-scroll">
                    {renderActiveTradesTable(sortTrades((details.activeTrades || []) as unknown as ServerTrade[]))}
                  </div>
                )}
              </div>
            </Tab>

            <Tab
              eventKey="completed"
              title={
                <span>
                  Completed
                  <Badge bg="success" className="ms-1">
                    {details.completedTrades?.length || 0}
                  </Badge>
                </span>
              }
            >
              <div className="p-4">
                {renderTradeTab(
                  <div className="terminal-tab-scroll">
                    {renderCompletedTradesTable(sortTrades((details.completedTrades || []) as unknown as ServerTrade[]))}
                  </div>
                )}
              </div>
            </Tab>

            <Tab
              eventKey="open"
              title={
                <span>
                  Open
                  <Badge bg="secondary" className="ms-1">
                    {details.openTrades?.length || 0}
                  </Badge>
                </span>
              }
            >
              <div className="p-4">
                {renderTradeTab(
                  <div className="terminal-tab-scroll">
                    {renderOpenTradesTable(sortTrades((details.openTrades || []) as unknown as ServerTrade[]))}
                  </div>
                )}
              </div>
            </Tab>

            <Tab
              eventKey="cancelled"
              title={
                <span>
                  Cancelled
                  <Badge bg="warning" className="ms-1">
                    {details.cancelledTrades?.length || 0}
                  </Badge>
                </span>
              }
            >
              <div className="p-4">
                {renderTradeTab(
                  <div className="terminal-tab-scroll">
                    {renderCancelledTradesTable(sortTrades((details.cancelledTrades || []) as unknown as ServerTrade[]))}
                  </div>
                )}
              </div>
            </Tab>

            {/* Tabs below are HIDDEN entirely without their respective View right (not shown with a
                no-access message like the trade/position tabs above). */}
            {canViewTrades && (
            <Tab
              eventKey="signals"
              title={
                <span>
                  Signals
                  {signalsLoaded && tradeSignals.length > 0 && (
                    <Badge bg="info" className="ms-1">
                      {tradeSignals.length}
                    </Badge>
                  )}
                </span>
              }
            >
              <div className="p-4">
                <div className="terminal-tab-scroll">
                  {renderTradeSignalsTable()}
                </div>
              </div>
            </Tab>
            )}

            {canViewStrategySummaries && (
            <Tab eventKey="strategies" title="Strategy Summaries">
              <div className="p-4">
                {isLoadingStrategies
                  ? <div className="text-center py-6"><Spinner animation="border" size="sm" /></div>
                  : strategiesError
                    ? renderSectionError(strategiesError)
                    : (
                      <div className="terminal-tab-scroll">
                        <StrategyBreakdown
                          strategies={strategyData || {}}
                          username={details.username}
                          broker={details.broker}
                          onSquareOff={onSquareOff && canSquareOff ? handleStrategySquareOff : undefined}
                          tradingMode={tradingMode}
                        />
                      </div>
                    )}
              </div>
            </Tab>
            )}

            {canViewStrategyStates && (
            <Tab eventKey="strategyStates" title="Strategy States">
              <div className="p-4">
                <div className="terminal-tab-scroll">
                  <UserStrategyStatesTab
                    username={details.username}
                    broker={details.broker}
                  />
                </div>
              </div>
            </Tab>
            )}

            {canViewBreakoutWatches && (
            <Tab eventKey="breakoutWatches" title="Breakout Watches">
              <div className="p-4">
                <div className="terminal-tab-scroll">
                  <BreakoutWatchesTab
                    username={details.username}
                    broker={details.broker}
                  />
                </div>
              </div>
            </Tab>
            )}

            {canViewRiskProfile && (
            <Tab eventKey="risk" title="Risk Profile">
              <div className="p-4">
                {isLoadingRisk
                  ? <div className="text-center py-6"><Spinner animation="border" size="sm" /></div>
                  : riskError
                    ? renderSectionError(riskError)
                    : (
                      <RiskProfileChart
                        id={`user-risk-${details.username}-${details.broker}`}
                        riskProfile={riskData?.riskProfile || {}}
                        brokerRiskProfile={riskData?.brokerRiskProfile}
                        algoCapital={algoCapital}
                        externalCapital={externalCapital}
                        height={200}
                        algoOnly={!canViewAlgoBrokerCompare}
                      />
                    )}
              </div>
            </Tab>
            )}

            {canViewMargins && (
            <Tab eventKey="margins" title="Margins">
              <div className="p-4">
                {marginsError
                  ? renderSectionError(marginsError)
                  : details.margins ? (
                  <Row className="">
                    <Col md={6} lg={4}>
                      <Card className="border">
                        <Card.Header className="py-2">
                          <h6 className="mb-0">Current Margins</h6>
                        </Card.Header>
                        <Card.Body>
                          <div className="flex justify-between mb-4">
                            <span className="text-ink-soft">Total Margin</span>
                            <span className="font-bold text-xl">
                              ₹{Math.round(details.margins.totalMargin || 0).toLocaleString('en-IN')}
                            </span>
                          </div>
                          <div className="flex justify-between mb-4">
                            <span className="text-ink-soft">Used Margin</span>
                            <span className="font-bold text-xl text-warning-700 dark:text-warning-400">
                              ₹{Math.round(details.margins.utilizedMargin || 0).toLocaleString('en-IN')}
                            </span>
                          </div>
                          <div className="flex justify-between mb-4">
                            <span className="text-ink-soft">Available Margin</span>
                            <span className="font-bold text-xl text-success-500 dark:text-success-400">
                              ₹{Math.round(details.margins.availableMargin || 0).toLocaleString('en-IN')}
                            </span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-ink-soft">Used %</span>
                            <span className="font-bold text-xl">
                              {details.margins.totalMargin
                                ? ((details.margins.utilizedMargin / details.margins.totalMargin) * 100).toFixed(1)
                                : 0}%
                            </span>
                          </div>
                        </Card.Body>
                      </Card>
                    </Col>
                    {details.peakMargins && (
                      <Col md={6} lg={4}>
                        <Card className="border">
                          <Card.Header className="py-2">
                            <h6 className="mb-0">Peak Margins</h6>
                          </Card.Header>
                          <Card.Body>
                            <div className="flex justify-between mb-4">
                              <span className="text-ink-soft">Total Margin</span>
                              <span className="font-bold text-xl">
                                ₹{Math.round(details.peakMargins.totalMargin || 0).toLocaleString('en-IN')}
                              </span>
                            </div>
                            <div className="flex justify-between mb-4">
                              <span className="text-ink-soft">Used Margin</span>
                              <span className="font-bold text-xl text-warning-700 dark:text-warning-400">
                                ₹{Math.round(details.peakMargins.utilizedMargin || 0).toLocaleString('en-IN')}
                              </span>
                            </div>
                            <div className="flex justify-between mb-4">
                              <span className="text-ink-soft">Available Margin</span>
                              <span className="font-bold text-xl text-success-500 dark:text-success-400">
                                ₹{Math.round(details.peakMargins.availableMargin || 0).toLocaleString('en-IN')}
                              </span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-ink-soft">Peak Used %</span>
                              <span className="font-bold text-xl">
                                {details.peakMargins.totalMargin
                                  ? ((details.peakMargins.utilizedMargin / details.peakMargins.totalMargin) * 100).toFixed(1)
                                  : 0}%
                              </span>
                            </div>
                          </Card.Body>
                        </Card>
                      </Col>
                    )}
                  </Row>
                ) : (
                  <p className="text-ink-soft text-center py-4">No margin data available</p>
                )}
              </div>
            </Tab>
            )}

            {canViewOrders && (
            <Tab eventKey="orders" title="Order Book">
              <div className="p-4">
                {renderOrderBookTab()}
              </div>
            </Tab>
            )}
            {canViewOrders && (
            <Tab eventKey="externalPnl" title="External PnL">
              <div className="p-4">
                {renderExternalPnlTab()}
              </div>
            </Tab>
            )}
          </Tabs>
        </Card.Body>
      </Card>

      {/* Trade Details Drawer */}
      <TradeDetailsDrawer
        show={showTradeDrawer}
        onHide={handleCloseDrawer}
        trade={selectedTrade}
      />

      {/* Trade Signal Details Drawer */}
      <TradeSignalDetailsDrawer
        show={showSignalDrawer}
        onHide={handleCloseSignalDrawer}
        signal={selectedSignal}
      />

      {/* Order Details Drawer */}
      <OrderDetailsDrawer
        show={showOrderDrawer}
        onHide={handleCloseOrderDrawer}
        order={selectedOrder}
      />

      {/* Complete Trade Modal */}
      <Modal
        show={showCompleteModal}
        onHide={() => {
          setShowCompleteModal(false);
          setTradeToComplete(null);
        }}
        centered
        backdrop="static"
      >
        <Modal.Header closeButton>
          <Modal.Title>Set Trade As Complete</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {tradeToComplete && (
            <>
              <div className="bg-raised p-4 rounded-md mb-4">
                <div className="flex justify-between mb-2">
                  <span className="text-ink-soft">Trade ID:</span>
                  <code>{getShortTradeId(tradeToComplete.tradeID)}</code>
                </div>
                <div className="flex justify-between mb-2">
                  <span className="text-ink-soft">Symbol:</span>
                  <strong>{tradeToComplete.tradingSymbol}</strong>
                </div>
                <div className="flex justify-between mb-2">
                  <span className="text-ink-soft">Direction:</span>
                  <Badge bg={tradeToComplete.direction === 'LONG' ? 'success' : 'danger'}>
                    {tradeToComplete.direction}
                  </Badge>
                </div>
                <div className="flex justify-between mb-2">
                  <span className="text-ink-soft">Entry Price:</span>
                  <span>{tradeToComplete.entry?.toFixed(2)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-ink-soft">Current Price:</span>
                  <span>{tradeToComplete.cmp?.toFixed(2)}</span>
                </div>
              </div>

              <Form.Group className="mb-4">
                <Form.Label className="flex items-center">Exit Price <span className="text-danger-600 dark:text-danger-400 ms-1">*</span> <HelpIcon article={helpContent['terminal.completeTrade.exitPrice']} /></Form.Label>
                <Form.Control
                  type="number"
                  step="0.05"
                  value={exitPrice}
                  onChange={(e) => setExitPrice(e.target.value)}
                  placeholder="Enter exit price"
                />
                <Form.Text className="text-ink-soft">
                  Default is current market price (CMP)
                </Form.Text>
              </Form.Group>

              {tradeToComplete.productType !== 'INTRADAY' && (
                <Form.Group className="mb-4">
                  <Form.Label className="flex items-center">Exit Date <span className="text-danger-600 dark:text-danger-400 ms-1">*</span> <HelpIcon article={helpContent['terminal.completeTrade.exitDate']} /></Form.Label>
                  <Form.Control
                    type="date"
                    value={exitDate}
                    onChange={(e) => setExitDate(e.target.value)}
                  />
                  <Form.Text className="text-ink-soft">
                    Required for positional/cashbuy trades
                  </Form.Text>
                </Form.Group>
              )}
            </>
          )}
        </Modal.Body>
        <Modal.Footer>
          <Button
            variant="secondary"
            onClick={() => {
              setShowCompleteModal(false);
              setTradeToComplete(null);
            }}
          >
            Cancel
          </Button>
          <Button
            variant="success"
            onClick={handleCompleteTrade}
            disabled={!exitPrice || isCompletingTrade}
          >
            {isCompletingTrade ? 'Completing...' : 'Set As Complete'}
          </Button>
        </Modal.Footer>
      </Modal>

      {/* Square Off Confirmation Modal */}
      <Modal
        show={showSquareOffConfirm}
        onHide={() => {
          setShowSquareOffConfirm(false);
          setTradeToSquareOff(null);
        }}
        centered
      >
        <Modal.Header closeButton className="bg-danger-600 text-white">
          <Modal.Title>Confirm Square Off</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {tradeToSquareOff && (
            <>
              <p>Are you sure you want to square off this trade?</p>
              <div className="bg-raised p-4 rounded-md">
                <div className="flex justify-between mb-2">
                  <span className="text-ink-soft">Trade ID:</span>
                  <code>{getShortTradeId(tradeToSquareOff.tradeID)}</code>
                </div>
                <div className="flex justify-between mb-2">
                  <span className="text-ink-soft">Symbol:</span>
                  <strong>{tradeToSquareOff.tradingSymbol}</strong>
                </div>
                <div className="flex justify-between mb-2">
                  <span className="text-ink-soft">Direction:</span>
                  <Badge bg={tradeToSquareOff.direction === 'LONG' ? 'success' : 'danger'}>
                    {tradeToSquareOff.direction}
                  </Badge>
                </div>
                <div className="flex justify-between mb-2">
                  <span className="text-ink-soft">Quantity:</span>
                  <span>{tradeToSquareOff.filledQuantity ?? 0}/{tradeToSquareOff.quantity}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-ink-soft">Current P&L:</span>
                  <PnLDisplay value={tradeToSquareOff.netProfitLoss} size="sm" fullFormat />
                </div>
              </div>
            </>
          )}
        </Modal.Body>
        <Modal.Footer>
          <Button
            variant="secondary"
            onClick={() => {
              setShowSquareOffConfirm(false);
              setTradeToSquareOff(null);
            }}
          >
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={handleSquareOffTrade}
            disabled={isSquaringOffTrade}
          >
            {isSquaringOffTrade ? 'Squaring Off...' : 'Square Off'}
          </Button>
        </Modal.Footer>
      </Modal>

      {/* Cancel Trade Confirmation Modal */}
      <Modal
        show={showCancelConfirm}
        onHide={() => {
          setShowCancelConfirm(false);
          setTradeToCancel(null);
        }}
        centered
      >
        <Modal.Header closeButton className="bg-warning-500">
          <Modal.Title>Confirm Cancel Trade</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {tradeToCancel && (
            <>
              <p>Are you sure you want to cancel this open trade?</p>
              <div className="bg-raised p-4 rounded-md">
                <div className="flex justify-between mb-2">
                  <span className="text-ink-soft">Trade ID:</span>
                  <code>{getShortTradeId(tradeToCancel.tradeID)}</code>
                </div>
                <div className="flex justify-between mb-2">
                  <span className="text-ink-soft">Symbol:</span>
                  <strong>{tradeToCancel.tradingSymbol}</strong>
                </div>
                <div className="flex justify-between mb-2">
                  <span className="text-ink-soft">Direction:</span>
                  <Badge bg={tradeToCancel.direction === 'LONG' ? 'success' : 'danger'}>
                    {tradeToCancel.direction}
                  </Badge>
                </div>
                <div className="flex justify-between mb-2">
                  <span className="text-ink-soft">Quantity:</span>
                  <span>{tradeToCancel.quantity}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-ink-soft">Requested Entry:</span>
                  <span>{tradeToCancel.requestedEntry?.toFixed(2)}</span>
                </div>
              </div>
              <Alert variant="info" className="mt-4 mb-0">
                <small>This will cancel the trade without placing any exit order. Use this only for trades that have not been filled yet.</small>
              </Alert>
            </>
          )}
        </Modal.Body>
        <Modal.Footer>
          <Button
            variant="secondary"
            onClick={() => {
              setShowCancelConfirm(false);
              setTradeToCancel(null);
            }}
          >
            Close
          </Button>
          <Button
            variant="warning"
            onClick={handleCancelTrade}
            disabled={isCancellingTrade}
          >
            {isCancellingTrade ? 'Cancelling...' : 'Cancel Trade'}
          </Button>
        </Modal.Footer>
      </Modal>
    </div>
  );
};

export default UserDetailsPanel;
