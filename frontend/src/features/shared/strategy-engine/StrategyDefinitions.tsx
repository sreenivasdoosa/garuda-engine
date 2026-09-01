import { useState, useMemo, useEffect } from 'react';
import { Card, Table, Button, Form, Modal, Badge, InputGroup, Spinner, Alert, Row, Col, Dropdown } from '@/components/ui/rbShim';
import Select from 'react-select';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  BsPlus,
  BsPencil,
  BsTrash,
  BsSearch,
  BsArrowClockwise,
  BsGear,
  BsCheckCircle,
  BsXCircle,
  BsPause,
  BsGlobe,
  BsLock,
  BsEye,
  BsSortUp,
  BsSortDown,
  BsArrowDownUp,
  BsDownload,
  BsUpload,
} from 'react-icons/bs';
import { toast } from 'react-toastify';

import { useAuthStore } from '@/store/authStore';
import { useConfigStore } from '@/store/configStore';
import { usePermissions } from '@/hooks/usePermissions';
import { strategyDefinitionService, strategyTemplateService, indicatorRulesService, strategyDefinitionTransferService } from '@/services/admin/strategyEngineService';
import { symbolService } from '@/services/admin/v2AdminService';
import { stockUniverseService } from '@/services/admin/stockUniverseService';
import { SimplifiedRuleSetEditor, DirectionRulesOnlyEditor } from './IndicatorRuleBuilder';
import ComboSpecEditor, { COMBO_SHAPES, defaultsByType } from './ComboSpecEditor';
import NBarsBreakoutParamsEditor from './NBarsBreakoutParamsEditor';
import HelpIcon from '@/components/common/HelpIcon';
import { strategyDefinitionHelpContent } from '@/data/help/strategy-definition-help';
import type {
  StrategyDefinition,
  CreateStrategyDefinitionRequest,
  UpdateStrategyDefinitionRequest,
  Product,
  TradeMode,
  ExpiryType,
  UnderlyingType,
  TradableDay,
  StrategyStatus,
  DirectionProviderType,
  CandleComparisonMode,
  CandlePriceType,
  IndicatorRuleSet,
  RuleNode,
  EquitySizingModel,
  OnIndexRemoval,
} from '@/types/strategy-engine';
import { TRADABLE_DAYS, TRADE_MODES, DIRECTION_PROVIDER_TYPES } from '@/types/strategy-engine';
import { TRADABLE_PRODUCTS, PRODUCT_LABELS, PRODUCT_BADGE_BG } from '@/types/product';
import type { StockUniverse } from '@/types/stock-universe';

const STRATEGY_STATUSES: { value: StrategyStatus; label: string; bg: string; description: string }[] = [
  { value: 'ACTIVE', label: 'Active', bg: 'success', description: 'Full operation - new trades + hedge replace + exits' },
  { value: 'WIND_DOWN', label: 'Wind Down', bg: 'warning', description: 'No new trades, but hedge replace + exits continue' },
  { value: 'INACTIVE', label: 'Inactive', bg: 'secondary', description: 'Completely stopped - no processing' },
];

// Engine-managed products, labels and badge colours all come from @/types/product so this screen,
// the terminal square-off menus and the reports/analytics badges never drift apart.
const PRODUCTS: { value: Product; label: string; bg: string }[] = TRADABLE_PRODUCTS.map((value) => ({
  value,
  label: PRODUCT_LABELS[value],
  bg: PRODUCT_BADGE_BG[value],
}));

// Products valid per trade mode: equity trades cash products (delivery/MTF/intraday);
// F&O modes trade INTRADAY/POSITIONAL derivatives.
const EQUITY_PRODUCT_VALUES: Product[] = ['INTRADAY', 'CASHBUY', 'MTF'];
const FNO_PRODUCT_VALUES: Product[] = ['INTRADAY', 'POSITIONAL'];

const EQUITY_SIZING_MODELS: { value: EquitySizingModel; label: string; description: string }[] = [
  { value: 'FIXED_AMOUNT_PER_STOCK', label: 'Fixed Amount Per Stock', description: 'Invest a fixed rupee amount in every stock entered' },
  { value: 'MAX_POSITIONS_EQUAL_SPLIT', label: 'Max Positions Equal Split', description: 'Split buying power equally across a max number of concurrent positions' },
  { value: 'MAX_RISK_PER_TRADE', label: 'Max Risk Per Trade', description: 'Size from a per-trade risk budget and the stop distance' },
];

const ON_INDEX_REMOVAL_OPTIONS: { value: OnIndexRemoval; label: string; description: string }[] = [
  { value: 'HOLD_UNTIL_EXIT', label: 'Hold Until Exit', description: 'Keep open positions; normal exit logic runs its course' },
  { value: 'EXIT_IMMEDIATELY', label: 'Exit Immediately', description: 'Square off open positions on the refresh that detects the removal' },
];

const EXPIRY_TYPES: { value: ExpiryType; label: string }[] = [
  { value: 'WEEKLY', label: 'Weekly' },
  { value: 'MONTHLY', label: 'Monthly' },
];

const UNDERLYING_TYPES: { value: UnderlyingType; label: string; description: string }[] = [
  { value: 'INDEX', label: 'Index', description: 'Use spot/index price for strike selection' },
  { value: 'FUTURE', label: 'Future', description: 'Use futures price for strike selection' },
  { value: 'SYNTHETIC_FUTURE', label: 'Synthetic Future', description: 'Use synthetic future price (reserved)' },
];

const EXCHANGES = ['NSE', 'BSE', 'MCX', 'CDS'];

// Form data type - extends CreateStrategyDefinitionRequest but uses object for directionProviderParams
// (we stringify before sending to API)
interface StrategyDefinitionFormData extends Omit<CreateStrategyDefinitionRequest, 'directionProviderParams'> {
  directionProviderParams?: Record<string, string>;
}

// Candle direction provider options
const CANDLE_COMPARISON_MODES: { value: CandleComparisonMode; label: string; description: string }[] = [
  { value: 'CMP_VS_REF', label: 'Current vs Reference', description: 'Compare current price with a reference price' },
  { value: 'REF_VS_REF', label: 'Reference vs Reference', description: 'Compare two reference prices (e.g., gap direction)' },
];

const CANDLE_REFERENCE_TIMES: { value: string; label: string }[] = [
  { value: 'MARKET_OPEN', label: 'Market Open' },
  { value: 'MARKET_CLOSE', label: 'Market Close' },
  { value: 'CUSTOM', label: 'Custom Time' },
];

const CANDLE_PRICE_TYPES: { value: CandlePriceType; label: string }[] = [
  { value: 'OPEN', label: 'Open' },
  { value: 'HIGH', label: 'High' },
  { value: 'LOW', label: 'Low' },
  { value: 'CLOSE', label: 'Close' },
];

const DAY_OFFSETS: { value: string; label: string }[] = [
  { value: '0', label: 'Today' },
  { value: '-1', label: 'Previous Day' },
  { value: '-2', label: '2 Days Back' },
  { value: '-3', label: '3 Days Back' },
  { value: 'CUSTOM', label: 'Custom' },
];

// Helper to check if a reference time value is custom (HH:mm:ss format)
const isCustomTime = (value: string | undefined): boolean => {
  if (!value) return false;
  return value !== 'MARKET_OPEN' && value !== 'MARKET_CLOSE' && value !== 'CUSTOM';
};

// Helper to get the select value for reference time
const getRefTimeSelectValue = (value: string | undefined): string => {
  if (!value) return '';
  if (value === 'MARKET_OPEN' || value === 'MARKET_CLOSE') return value;
  return 'CUSTOM'; // Any other value (HH:mm:ss) maps to CUSTOM in dropdown
};

// Helper to check if day offset is custom
const isCustomDayOffset = (value: string | undefined): boolean => {
  if (!value) return false;
  const predefined = ['0', '-1', '-2', '-3'];
  return !predefined.includes(value);
};

// Helper to get the select value for day offset
const getDayOffsetSelectValue = (value: string | undefined): string => {
  if (!value) return '';
  const predefined = ['0', '-1', '-2', '-3'];
  if (predefined.includes(value)) return value;
  return 'CUSTOM';
};

// Helper to format time for display
const formatTimeDisplay = (time: string | undefined): string => {
  if (!time) return '(not set)';
  if (time === 'MARKET_OPEN') return 'Market Open';
  if (time === 'MARKET_CLOSE') return 'Market Close';
  return time; // Custom time like "09:15:00"
};

// Helper to format day offset for display
const formatDayOffsetDisplay = (offset: string | undefined): string => {
  if (!offset) return '(not set)';
  const num = parseInt(offset);
  if (num === 0) return "Today's";
  if (num === -1) return "Yesterday's";
  if (num === -2) return "2 Days Back";
  return `${Math.abs(num)} Days Back`;
};

// Helper to format reference description
const formatReferenceDisplay = (time: string | undefined, dayOffset: string | undefined, priceType?: string): string => {
  const timeStr = formatTimeDisplay(time);
  const dayStr = formatDayOffsetDisplay(dayOffset);

  // For MARKET_OPEN/MARKET_CLOSE, don't show price type as it's implied
  if (time === 'MARKET_OPEN' || time === 'MARKET_CLOSE' || !time) {
    return `${dayStr} ${timeStr}`;
  }

  // For custom time, show price type
  const priceStr = priceType || 'Close';
  return `${dayStr} ${timeStr} ${priceStr}`;
};

// Generate summary for CANDLE direction provider
const getCandleDirectionSummary = (params: Record<string, string> | undefined): { condition: string; longDesc: string; shortDesc: string } | null => {
  if (!params) return null;

  const mode = params.comparisonMode;
  const longWhen = params.longWhen;
  if (!mode || !longWhen) return null;

  if (mode === 'CMP_VS_REF') {
    if (!params.refTime || !params.refDayOffset) return null;
    const refDisplay = formatReferenceDisplay(params.refTime, params.refDayOffset, params.refPriceType);
    if (longWhen === 'GREATER') {
      return {
        condition: `Current Price vs ${refDisplay}`,
        longDesc: `CMP > ${refDisplay}`,
        shortDesc: `CMP ≤ ${refDisplay}`,
      };
    } else {
      return {
        condition: `Current Price vs ${refDisplay}`,
        longDesc: `CMP < ${refDisplay}`,
        shortDesc: `CMP ≥ ${refDisplay}`,
      };
    }
  } else {
    // REF_VS_REF
    if (!params.ref1Time || !params.ref1DayOffset || !params.ref2Time || !params.ref2DayOffset) return null;
    const ref1Display = formatReferenceDisplay(params.ref1Time, params.ref1DayOffset, params.ref1PriceType);
    const ref2Display = formatReferenceDisplay(params.ref2Time, params.ref2DayOffset, params.ref2PriceType);
    if (longWhen === 'GREATER') {
      return {
        condition: `${ref1Display} vs ${ref2Display}`,
        longDesc: `${ref1Display} ≥ ${ref2Display}`,
        shortDesc: `${ref1Display} < ${ref2Display}`,
      };
    } else {
      return {
        condition: `${ref1Display} vs ${ref2Display}`,
        longDesc: `${ref1Display} < ${ref2Display}`,
        shortDesc: `${ref1Display} ≥ ${ref2Display}`,
      };
    }
  }
};

// Direction action labels based on trade mode
const getDirectionLabels = (tradeMode?: string): { longAction: string; shortAction: string } => {
  if (tradeMode === 'OPTION_BUYING') {
    return { longAction: 'Buy CE', shortAction: 'Buy PE' };
  }
  return { longAction: 'Sell PE', shortAction: 'Sell CE' };
};

const supportsHedging = (tradeMode?: TradeMode): boolean => {
  // Futures hedging is not supported in backend yet. Enable this for FUTURES later
  // when entry/hedge generation supports that trade mode end-to-end.
  return tradeMode === 'OPTION_SELLING';
};

// True for any trade mode that places at least one options leg — covers
// buying, selling, and the futures+options combo. Gates fields that are
// options-specific (strike selection, expiry handling, premium-balanced
// ATM math) but not hedging-specific.
const hasOptionsLeg = (tradeMode?: TradeMode): boolean => {
  return tradeMode === 'OPTION_SELLING'
      || tradeMode === 'OPTION_BUYING'
      || tradeMode === 'FUTURES_OPTIONS';
};

// Equity (cash/stock-universe) strategies hide all FnO-only controls
// (expiry, strikes, hedging, capital-per-lot) and add leverage/sizing/universe.
const isEquityMode = (tradeMode?: TradeMode): boolean => tradeMode === 'EQUITY';

const productsForTradeMode = (tradeMode?: TradeMode): { value: Product; label: string; bg: string }[] =>
  PRODUCTS.filter((p) => (isEquityMode(tradeMode) ? EQUITY_PRODUCT_VALUES : FNO_PRODUCT_VALUES).includes(p.value));

// Strategy name validation helpers
const STRATEGY_NAME_CHAR_REGEX = /^[A-Za-z0-9_-]*$/;

const validateStrategyName = (name: string): { isValid: boolean; error?: string } => {
  if (!name.trim()) {
    return { isValid: false, error: 'Strategy name is required' };
  }
  if (!STRATEGY_NAME_CHAR_REGEX.test(name)) {
    return { isValid: false, error: 'Only alphanumeric characters, hyphens (-) and underscores (_) are allowed' };
  }
  if (name.startsWith('-') || name.startsWith('_')) {
    return { isValid: false, error: 'Strategy name cannot start with hyphen or underscore' };
  }
  if (name.endsWith('-') || name.endsWith('_')) {
    return { isValid: false, error: 'Strategy name cannot end with hyphen or underscore' };
  }
  return { isValid: true };
};

const StrategyDefinitions: React.FC = () => {
  const queryClient = useQueryClient();
  const { user } = useAuthStore();
  const permissions = usePermissions();
  const { supportsEquity, supportsFnO } = useConfigStore();

  // Trade modes available in this deployment (app.trading.mode)
  const availableTradeModes = TRADE_MODES.filter((m) =>
    m.value === 'EQUITY' ? supportsEquity() : supportsFnO(),
  );
  const currentUsername = user?.username || '';

  // Check if user has admin/manager role (can manage SYSTEM scope strategies)
  const isAdminOrManager = user?.isSysadmin ||
    ['ADMIN', 'MANAGER'].includes(user?.roleCode?.toUpperCase() || '');

  // Ownership-based permission checks
  const canEditDefinition = (def: StrategyDefinition): boolean => {
    // Owner can always edit
    if (def.username === currentUsername) return true;

    // For SYSTEM scope strategies, only sysadmin/admin/manager roles can edit
    if (def.scope === 'SYSTEM') {
      // Must be admin/manager AND have edit permission
      return isAdminOrManager && permissions.strategyDefinitions.canEdit;
    }

    // For USER scope strategies, non-owner can edit only if public and has EDIT rights
    if (def.isPublic) return permissions.strategyDefinitions.canEdit;
    // Private USER scope - non-owner cannot edit
    return false;
  };

  const canDeleteDefinition = (def: StrategyDefinition): boolean => {
    // Owner can always delete
    if (def.username === currentUsername) return true;

    // For SYSTEM scope strategies, only sysadmin/admin/manager roles can delete
    if (def.scope === 'SYSTEM') {
      // Must be admin/manager AND have manage permission
      return isAdminOrManager && permissions.strategyDefinitions.canManage;
    }

    // For USER scope strategies, non-owner can delete only if public and has MANAGE rights
    if (def.isPublic) return permissions.strategyDefinitions.canManage;
    // Private USER scope - non-owner cannot delete
    return false;
  };

  const [searchTerm, setSearchTerm] = useState('');
  const [filterTemplate, setFilterTemplate] = useState('');
  const [filterExchange, setFilterExchange] = useState<string>('');
  const [filterProduct, setFilterProduct] = useState<string>('');
  const [filterStatus, setFilterStatus] = useState<string>('');

  // Sorting state
  type SortColumn = 'strategyName' | 'fnoSymbolName' | 'exchange' | 'product' | 'tradableDays';
  type SortDirection = 'asc' | 'desc';
  const [sortColumn, setSortColumn] = useState<SortColumn | null>(null);
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [showAddModal, setShowAddModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [editModalReadOnly, setEditModalReadOnly] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [selectedDefinition, setSelectedDefinition] = useState<StrategyDefinition | null>(null);
  const [selectedDays, setSelectedDays] = useState<TradableDay[]>([]);
  const [selectedExcludedDays, setSelectedExcludedDays] = useState<TradableDay[]>([]);

  // Form state - uses object for directionProviderParams (stringified before API call)
  const [formData, setFormData] = useState<StrategyDefinitionFormData>({
    strategyName: '',
    displayName: '',
    displayOrder: 0,
    templateName: '',
    fnoSymbolName: '',
    exchange: '',
    product: 'INTRADAY',
    tradeMode: 'OPTION_SELLING',
    // Trigger type flags - default to scheduled only
    tickTriggerEnabled: false,
    scheduledTriggerEnabled: true,
    signalTriggerEnabled: false,
    periodicTriggerEnabled: false,
    startTime: '',
    stopTime: '',
    tradableDays: '',
    excludedDays: '',
    capitalPerLot: 0,
    capitalPerLotHedged: 0,
    capitalPerLotNaked: 0,
    isOverlapCapital: false,
    expiryType: 'WEEKLY',
    excludeMonthlyExpiry: false,
    usePremiumBalancing: true,
    underlyingType: 'INDEX',
    hedgeDistancePercentageIntraday: 0,
    hedgeDistancePercentagePositional: 0,
    isDirectional: false,
    directionProviderType: undefined,
    directionProviderParams: undefined,
    isPublic: false,
    isMock: false,
    scope: 'SYSTEM',
    catchUpMissedTranches: true,
    adaptiveTranchesEnabled: false,
    periodicIntervalMinutes: undefined,
    periodicOffsetSeconds: undefined,
    hedgeReplaceEnabled: false,
    hedgeMorningStartOffset: undefined,
    hedgeMorningEndOffset: undefined,
    hedgeEveningStartOffset: undefined,
    hedgeEveningEndOffset: undefined,
    riskPercentage: undefined,
    absoluteMaxRisk: undefined,
    minRiskPercentage: undefined,
    maxRiskPercentage: undefined,
  });

  // Sanitize a RuleNode: return undefined only if the node is truly empty
  // (e.g., empty operator node with no children and no condition from UI draft state)
  // Note: API responses may not include a 'type' field — detect leaf nodes by checking
  // for the 'condition' property instead.
  const sanitizeRuleNode = (node: RuleNode | undefined | null): RuleNode | undefined => {
    if (!node) return undefined;
    // Leaf/condition node — has a condition object (API may not set type='condition')
    if (node.type === 'condition' || node.condition != null) return node;
    // Operator node — must have children with actual conditions
    if (!node.children || node.children.length === 0) return undefined;
    const sanitizedChildren = node.children
      .map(child => sanitizeRuleNode(child))
      .filter((child): child is RuleNode => child != null);
    if (sanitizedChildren.length === 0) return undefined;
    return { ...node, children: sanitizedChildren };
  };

  const sanitizeIndicatorRules = (rules: IndicatorRuleSet): IndicatorRuleSet => ({
    ...rules,
    entryRules: sanitizeRuleNode(rules.entryRules),
    directionRules: rules.directionRules ? {
      longRules: sanitizeRuleNode(rules.directionRules.longRules),
      shortRules: sanitizeRuleNode(rules.directionRules.shortRules),
    } : undefined,
    exitRules: sanitizeRuleNode(rules.exitRules),
  });

  // Indicator rules state (for INDICATOR_ADVANCED_OPTIONS template)
  // New simplified design: entryRules (WHEN), directionRules (WHICH side), exitRules (optional)
  const [indicatorRules, setIndicatorRules] = useState<IndicatorRuleSet>({
    strategyName: '',
    entryRules: undefined,
    directionRules: undefined,
    exitRules: undefined,
    useIndicatorExit: false,
  });
  const [indicatorRulesLoading, setIndicatorRulesLoading] = useState(false);

  // Validation errors state
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});

  // ==================== Export/Import State ====================
  const [selectedStrategies, setSelectedStrategies] = useState<Set<string>>(new Set());
  const [showImportModal, setShowImportModal] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importPreview, setImportPreview] = useState<import('@/services/admin/strategyEngineService').ImportPreviewResult | null>(null);
  const [importResolutions, setImportResolutions] = useState<Record<string, 'OVERRIDE' | 'SKIP'>>({});
  const [importStep, setImportStep] = useState<1 | 2 | 3>(1);
  const [importLoading, setImportLoading] = useState(false);
  const [importResult, setImportResult] = useState<import('@/services/admin/strategyEngineService').ImportApplyResult | null>(null);

  // Fetch all definitions
  const {
    data: definitions = [],
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ['strategy-definitions', filterTemplate, filterExchange, filterStatus],
    queryFn: () => strategyDefinitionService.getAll({
      template: filterTemplate || undefined,
      exchange: filterExchange || undefined,
      status: (filterStatus || undefined) as StrategyStatus | undefined,
    }),
  });

  // Fetch templates for dropdown
  const { data: templates = [] } = useQuery({
    queryKey: ['strategy-templates'],
    queryFn: () => strategyTemplateService.getAll(),
  });

  // ===== W4: the template is DERIVED, not chosen =====
  // The admin describes what the strategy does (trade mode, direction, indicators, combo legs);
  // the server's TemplateResolver says which engine runs it. Generic templates never appear in
  // the UI — only custom-logic ones (isUserSelectable) can be picked, and even those are
  // validated against the rest of the intent by the same resolver.
  const [customTemplate, setCustomTemplate] = useState('');
  const [indicatorEntryIntent, setIndicatorEntryIntent] = useState(false);

  const anyFormOpen = showAddModal || (showEditModal && !editModalReadOnly);
  const { data: templateResolution } = useQuery({
    queryKey: ['template-resolution', formData.tradeMode, formData.isDirectional,
      formData.directionProviderType, JSON.stringify(formData.directionProviderParams ?? {}),
      indicatorEntryIntent, customTemplate],
    queryFn: () => strategyDefinitionService.resolveTemplate({
      strategyName: formData.strategyName || 'draft',
      tradeMode: formData.tradeMode,
      isDirectional: formData.isDirectional,
      directionProviderType: formData.directionProviderType,
      directionProviderParams: formData.directionProviderParams
        ? JSON.stringify(formData.directionProviderParams) : undefined,
      templateName: customTemplate || undefined,
    } as Partial<CreateStrategyDefinitionRequest>, indicatorEntryIntent, false),
    enabled: anyFormOpen,
    staleTime: 60_000,
  });

  // Keep formData.templateName in lock-step with the resolution, so every downstream consumer
  // (the H12 flag-sync effect, the ZERODT panels, needsIndicatorRules in the submit handlers)
  // keeps working off templateName exactly as before — only the SOURCE of the name changed.
  useEffect(() => {
    if (!anyFormOpen || !templateResolution) return;
    const next = templateResolution.resolved ? (templateResolution.templateName ?? '') : '';
    setFormData((prev) => (prev.templateName === next ? prev : { ...prev, templateName: next }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateResolution, anyFormOpen]);

  const customTemplateOptions = templates.filter((t) => t.isUserSelectable);

  // ===== the combo TYPE is the trade mode, as far as the admin is concerned =====
  // A combo's legs declare products and instruments per leg, so no single TradeMode value
  // describes the strategy — the engine routes combos by the spec, never by mode. The form
  // therefore shows the SHAPE in the Trade Mode position, and the stored tradeMode enum is
  // derived from it (it still drives form plumbing: FUTURES hides Expiry Type, FUTURES_OPTIONS
  // keeps it visible for the option leg).
  const comboShapeType = useMemo(() => {
    if (!formData.comboSpecJson) return null;
    try {
      return (JSON.parse(formData.comboSpecJson) as { type?: string }).type ?? null;
    } catch {
      return null;
    }
  }, [formData.comboSpecJson]);

  // Keep the stored tradeMode in lock-step with the shape (covers ticking the combo checkbox in
  // the editor, whose default shape is LONG_SHORT).
  useEffect(() => {
    if (!comboShapeType) return;
    const shape = COMBO_SHAPES.find((s) => s.value === comboShapeType);
    if (shape && formData.tradeMode !== shape.storedTradeMode) {
      setFormData((prev) => ({ ...prev, tradeMode: shape.storedTradeMode as TradeMode }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [comboShapeType]);

  /**
   * ONE Trade Mode dropdown for plain modes AND combo shapes, in the operator's order:
   * Option Selling · Option Buying · Futures · Futures + Options · Equity ·
   * Long Equity + Short Futures · Covered Call · Protective Put.
   *
   * A combo shape IS a trade mode as far as the admin is concerned. Picking one creates the
   * combo spec (that shape's default legs) and derives the stored enum; picking a plain mode
   * CLEARS any combo spec. "Futures + Options" is a combo pick on purpose — the plain enum value
   * exists but no non-combo path implements it (it would silently behave like option selling).
   */
  // A combo's products live on its LEGS (a long/short pair holds CASHBUY and INTRADAY at
  // once), so the strategy-level Product Type field is hidden for combos and its stored value
  // is derived: POSITIONAL if any leg is positional, else INTRADAY. The stored value still
  // matters — it picks the hedge-distance flavour and the square-off timing.
  useEffect(() => {
    if (!formData.comboSpecJson) return;
    try {
      const spec = JSON.parse(formData.comboSpecJson) as { legs?: { product?: string }[] };
      const derived = (spec.legs?.some((l) => l.product === 'POSITIONAL') ? 'POSITIONAL' : 'INTRADAY') as Product;
      if (formData.product !== derived) {
        setFormData((prev) => ({ ...prev, product: derived }));
      }
    } catch { /* unparsable spec — the combo editor surfaces the error */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formData.comboSpecJson]);

  // ===== Underlyings: Indices/Contracts vs Stocks (watchlist) =====
  // Any trade mode can now run over a stock watchlist (universe) instead of a single index/
  // contract underlying — stock options, stock futures, combos across a watchlist. The shapes
  // with a cash-equity leg (and EQUITY itself) have no index form at all, so they lock to Stocks.
  const STOCKS_LOCKED_COMBOS = ['LONG_SHORT', 'COVERED_CALL', 'PROTECTIVE_PUT'];
  const [fnoUnderlyingSource, setFnoUnderlyingSource] = useState<'INDICES' | 'STOCKS'>('INDICES');
  const stocksLocked = isEquityMode(formData.tradeMode)
    || (comboShapeType != null && STOCKS_LOCKED_COMBOS.includes(comboShapeType));
  const underlyingSource: 'INDICES' | 'STOCKS' =
    stocksLocked || formData.universeId != null || fnoUnderlyingSource === 'STOCKS' ? 'STOCKS' : 'INDICES';

  // Expiry choices follow what the selection actually lists: per-symbol weekly/monthly flags
  // from SYMBOL_INFO (synced from market-data, auto-detected from the instruments master), and
  // monthly-only for stock watchlists. Stops WEEKLY on CRUDEOIL or RELIANCE — neither exists.
  const expiryTypesForSelection = (): { value: ExpiryType; label: string }[] => {
    if (underlyingSource === 'STOCKS') return EXPIRY_TYPES.filter((et) => et.value === 'MONTHLY');
    const si = symbols.find((s) => s.symbol === formData.fnoSymbolName);
    if (!si) return EXPIRY_TYPES;
    return EXPIRY_TYPES.filter((et) =>
      et.value === 'WEEKLY' ? si.hasOptionsWeeklyExpiry
        : et.value === 'MONTHLY' ? si.hasOptionsMonthlyExpiry : true);
  };

  // Auto-correct a stored expiry the new selection cannot serve, instead of leaving an
  // invalid value that the server now rejects.
  useEffect(() => {
    const allowed = expiryTypesForSelection();
    if (formData.expiryType && allowed.length > 0 && !allowed.some((et) => et.value === formData.expiryType)) {
      setFormData((prev) => ({ ...prev, expiryType: allowed[0].value }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formData.fnoSymbolName, underlyingSource]);

  /**
   * "What does it trade on" — one field for both modals. A radio picks the source (hidden when the
   * shape locks it), then either the watchlist picker or the index/contract symbol dropdown. A
   * watchlist on an F&O/combo strategy additionally needs Max Active Positions: the engine caps
   * member entries per tranch with it and sizes each member with capital ÷ cap (mirrors the
   * server-side validateUniverseBinding rule).
   */
  const renderUnderlyingsField = (required: boolean, idPrefix: string) => (
    <>
      {!stocksLocked && (
        <Form.Group className="mb-2">
          <Form.Label className="flex items-center">Underlyings <HelpIcon article={strategyDefinitionHelpContent['strategyDef.underlyingSource']} /></Form.Label>
          <div>
            <Form.Check
              inline
              type="radio"
              id={`${idPrefix}-underlyings-indices`}
              name={`${idPrefix}-underlyings`}
              label="Indices / Contracts"
              checked={underlyingSource === 'INDICES'}
              onChange={() => {
                setFnoUnderlyingSource('INDICES');
                setFormData({ ...formData, universeId: undefined });
              }}
            />
            <Form.Check
              inline
              type="radio"
              id={`${idPrefix}-underlyings-stocks`}
              name={`${idPrefix}-underlyings`}
              label="Stocks (watchlist)"
              checked={underlyingSource === 'STOCKS'}
              onChange={() => {
                setFnoUnderlyingSource('STOCKS');
                // Stock derivatives only have monthly expiries.
                setFormData({ ...formData, expiryType: 'MONTHLY' });
              }}
            />
          </div>
        </Form.Group>
      )}
      {underlyingSource === 'STOCKS' ? (
        <>
          <Form.Group className="mb-4">
            <Form.Label className="flex items-center">Stock Watchlist {required && <span className="text-danger-600 dark:text-danger-400">*</span>} <HelpIcon article={strategyDefinitionHelpContent['strategyDef.universeId']} /></Form.Label>
            <Form.Select
              value={formData.universeId ?? ''}
              onChange={(e) => {
                const id = e.target.value ? parseInt(e.target.value) : undefined;
                const universe = universes.find((u: StockUniverse) => u.universeId === id);
                setFormData({ ...formData, universeId: id, exchange: universe?.exchange || 'NSE' });
              }}
              required={required}
              isInvalid={!!validationErrors.universeId}
            >
              <option value="">Select Watchlist...</option>
              {universes.map((u: StockUniverse) => (
                <option key={u.universeId} value={u.universeId}>
                  {u.name}{u.universeType === 'PREDEFINED_INDEX' ? ' (index)' : ''}
                </option>
              ))}
            </Form.Select>
            {validationErrors.universeId && <Form.Control.Feedback type="invalid">{validationErrors.universeId}</Form.Control.Feedback>}
            <Form.Text className="text-ink-soft">The watchlist of stocks this strategy trades — manage lists on the Stock Universes page</Form.Text>
          </Form.Group>
          {!isEquityMode(formData.tradeMode) && (
            <Form.Group className="mb-4">
              <Form.Label className="flex items-center">Max Active Positions {required && <span className="text-danger-600 dark:text-danger-400">*</span>} <HelpIcon article={strategyDefinitionHelpContent['strategyDef.maxActivePositions']} /></Form.Label>
              <Form.Control
                type="number"
                min={1}
                value={formData.maxActivePositions ?? ''}
                onChange={(e) => setFormData({ ...formData, maxActivePositions: e.target.value ? parseInt(e.target.value) : undefined })}
                isInvalid={!!validationErrors.maxActivePositions}
              />
              {validationErrors.maxActivePositions && <Form.Control.Feedback type="invalid">{validationErrors.maxActivePositions}</Form.Control.Feedback>}
              <Form.Text className="text-ink-soft">At most this many stocks enter per tranch; each entered stock is sized with capital ÷ this</Form.Text>
            </Form.Group>
          )}
        </>
      ) : (
        <Form.Group className="mb-4">
          <Form.Label className="flex items-center">Underlying Symbol {required && <span className="text-danger-600 dark:text-danger-400">*</span>} <HelpIcon article={strategyDefinitionHelpContent['strategyDef.fnoSymbolName']} /></Form.Label>
          <Form.Select
            value={formData.fnoSymbolName}
            onChange={(e) => {
              const selectedSymbol = symbols.find((s) => s.symbol === e.target.value);
              setFormData({
                ...formData,
                fnoSymbolName: e.target.value,
                exchange: selectedSymbol?.exchange || formData.exchange,
              });
            }}
            required={required}
            isInvalid={!!validationErrors.fnoSymbolName}
          >
            <option value="">Select Symbol...</option>
            {symbols.filter((s) => s.segment !== 'NSE_EQ').map((s) => (
              <option key={s.symbol} value={s.symbol}>{s.symbol}</option>
            ))}
          </Form.Select>
          {validationErrors.fnoSymbolName && <Form.Control.Feedback type="invalid">{validationErrors.fnoSymbolName}</Form.Control.Feedback>}
        </Form.Group>
      )}
    </>
  );

  const renderTradeModeField = () => {
    const comboEnabled = supportsFnO();
    const selected = comboShapeType ? `combo:${comboShapeType}` : (formData.tradeMode || 'OPTION_SELLING');
    const plainOf = (v: string) => availableTradeModes.find((m) => m.value === v);
    return (
      <Form.Group className="mb-4">
        <Form.Label className="flex items-center">Trade Mode <HelpIcon article={strategyDefinitionHelpContent['strategyDef.tradeMode']} /></Form.Label>
        <Form.Select
          value={selected}
          onChange={(e) => {
            const v = e.target.value;
            if (v.startsWith('combo:')) {
              const shape = COMBO_SHAPES.find((s) => s.value === v.slice(6));
              if (!shape) return;
              const mapped = shape.storedTradeMode as TradeMode;
              const validProducts = isEquityMode(mapped) ? EQUITY_PRODUCT_VALUES : FNO_PRODUCT_VALUES;
              setFormData({
                ...formData,
                comboSpecJson: JSON.stringify(defaultsByType[shape.value]()),
                tradeMode: mapped,
                product: formData.product && validProducts.includes(formData.product) ? formData.product : ('' as Product),
              });
              return;
            }
            const newMode = v as TradeMode;
            const validProducts = isEquityMode(newMode) ? EQUITY_PRODUCT_VALUES : FNO_PRODUCT_VALUES;
            setFormData({
              ...formData,
              // A plain mode is a single-shape strategy — leaving a combo drops its spec.
              comboSpecJson: undefined,
              tradeMode: newMode,
              product: formData.product && validProducts.includes(formData.product) ? formData.product : ('' as Product),
              ...(isEquityMode(newMode) ? { exchange: 'NSE' } : {}),
            });
          }}
        >
          {plainOf('OPTION_SELLING') && <option value="OPTION_SELLING">Option Selling</option>}
          {plainOf('OPTION_BUYING') && <option value="OPTION_BUYING">Option Buying</option>}
          {plainOf('FUTURES') && <option value="FUTURES">Futures</option>}
          {comboEnabled && COMBO_SHAPES.filter((s) => s.value === 'FUTURES_OPTIONS').map((s) => (
            <option key={s.value} value={`combo:${s.value}`}>{s.label}</option>
          ))}
          {plainOf('EQUITY') && <option value="EQUITY">Equity</option>}
          {comboEnabled && COMBO_SHAPES.filter((s) => s.value !== 'FUTURES_OPTIONS').map((s) => (
            <option key={s.value} value={`combo:${s.value}`}>{s.label}</option>
          ))}
          {/* Legacy fallback: keep an out-of-catalogue stored mode visible rather than blanking it */}
          {/* Legacy fallback incl. a plain FUTURES_OPTIONS stored without a combo spec — it must
              stay visible as itself, not silently render as the first option. */}
          {!comboShapeType && formData.tradeMode
            && (formData.tradeMode === 'FUTURES_OPTIONS'
                || !availableTradeModes.some((m) => m.value === formData.tradeMode)) && (
            <option value={formData.tradeMode}>{TRADE_MODES.find((m) => m.value === formData.tradeMode)?.label || formData.tradeMode} (plain)</option>
          )}
        </Form.Select>
        {comboShapeType && (
          <Form.Text className="text-ink-soft">
            {COMBO_SHAPES.find((s) => s.value === comboShapeType)?.hint}
          </Form.Text>
        )}
      </Form.Group>
    );
  };

  /** The one field that replaces the template dropdown in both modals. */
  const renderEngineField = () => (
    <Form.Group className="mb-4">
      <Form.Label className="flex items-center">Strategy Engine <HelpIcon article={strategyDefinitionHelpContent['strategyDef.templateName']} /></Form.Label>
      {/* Derived, read-only. The admin should never have to know template names. */}
      <div className="rounded border border-hairline bg-card px-2 py-2 text-sm">
        {templateResolution?.resolved ? (
          <span><strong>{templateResolution.displayName}</strong> <span className="text-ink-soft">(derived from the settings below)</span></span>
        ) : (
          <span className="text-warning-600 dark:text-warning-400">
            {templateResolution?.reason || 'Fill in the fields below — the engine is derived automatically.'}
          </span>
        )}
      </div>
      <Form.Check
        type="switch"
        className="mt-2"
        label="Gate entries on indicator rules"
        checked={indicatorEntryIntent}
        onChange={(e) => setIndicatorEntryIntent(e.target.checked)}
      />
      {customTemplateOptions.length > 0 && (
        <>
          <Form.Select
            className="mt-2"
            value={customTemplate}
            onChange={(e) => {
              const chosen = e.target.value;
              setCustomTemplate(chosen);
              if (chosen === 'ZERODT_OPTIONS') {
                // ZeroDT's whole purpose is adaptive tranch advancement via onTranchComplete;
                // TradeExitHandler only dispatches TranchCompleteEvent when these are on.
                setFormData((prev) => ({
                  ...prev,
                  periodicTriggerEnabled: true,
                  adaptiveTranchesEnabled: true,
                }));
              }
            }}
          >
            <option value="">Custom logic: none — derive automatically</option>
            {customTemplateOptions.map((t) => (
              <option key={t.templateName} value={t.templateName}>{t.displayName}</option>
            ))}
          </Form.Select>
          <Form.Text className="text-ink-soft">
            Only strategies with bespoke logic need a custom pick; everything else derives.
          </Form.Text>
        </>
      )}
    </Form.Group>
  );

  // Fetch symbols for dropdown
  const { data: symbols = [] } = useQuery({
    queryKey: ['symbols'],
    queryFn: () => symbolService.getAll(),
  });

  // Stock universes for the equity universe picker (equity deployments only)
  const { data: universes = [] } = useQuery({
    queryKey: ['stock-universes', 'active'],
    queryFn: () => stockUniverseService.getActive(),
    enabled: supportsEquity() || supportsFnO(),
  });

  const universeName = (universeId?: number): string | undefined =>
    universes.find((u: StockUniverse) => u.universeId === universeId)?.name;

  // Real-time duplicate validation for Strategy Name
  useEffect(() => {
    // Only validate when Add modal is open and strategy name is entered
    if (!showAddModal || !formData.strategyName) {
      // Clear duplicate error
      setValidationErrors((prev) => {
        if (prev.duplicateStrategyName) {
          const { duplicateStrategyName, ...rest } = prev;
          return rest;
        }
        return prev;
      });
      return;
    }

    // Check if strategy name already exists (case-insensitive)
    const duplicateDefinition = definitions.find(
      (d) => d.strategyName.toLowerCase() === formData.strategyName.toLowerCase()
    );

    if (duplicateDefinition) {
      setValidationErrors((prev) => ({
        ...prev,
        duplicateStrategyName: `Strategy "${formData.strategyName}" already exists`,
      }));
    } else {
      // Clear duplicate error if no duplicate found
      setValidationErrors((prev) => {
        if (prev.duplicateStrategyName) {
          const { duplicateStrategyName, ...rest } = prev;
          return rest;
        }
        return prev;
      });
    }
  }, [showAddModal, formData.strategyName, definitions]);

  // H12 Layer 1 — for templates whose backend evaluator hard-requires both
  // periodicTriggerEnabled and adaptiveTranchesEnabled, force them on
  // whenever the form holds one of those templates. Template-select handlers
  // already set them on a fresh template pick, but this catches the
  // Edit-modal load case for strategies that were saved before this UI fix
  // landed (or via direct DB / API) and have one or both flags off. Without
  // this safety net the disabled checkboxes would show unchecked-and-locked
  // and a save would silently push the bad state through to the backend.
  // Backend H12 (validateConfig at dispatcher gate) is the last line of
  // defense -- this useEffect is the cooperating first line on the UI.
  useEffect(() => {
    if (formData.templateName !== 'ZERODT_OPTIONS' && formData.templateName !== 'ADAPTIVE_OPTIONS') {
      return;
    }
    if (formData.periodicTriggerEnabled && formData.adaptiveTranchesEnabled) {
      return;
    }
    setFormData((prev) => ({
      ...prev,
      periodicTriggerEnabled: true,
      adaptiveTranchesEnabled: true,
    }));
  }, [
    formData.templateName,
    formData.periodicTriggerEnabled,
    formData.adaptiveTranchesEnabled,
  ]);

  // Inline field-level validation — runs on every form change
  useEffect(() => {
    setValidationErrors((prev) => {
      const errors: Record<string, string> = {};

      // Preserve duplicate error (managed by the other useEffect)
      if (prev.duplicateStrategyName) {
        errors.duplicateStrategyName = prev.duplicateStrategyName;
      }

      // Strategy name
      if (formData.strategyName && !validateStrategyName(formData.strategyName).isValid) {
        errors.strategyName = validateStrategyName(formData.strategyName).error || 'Invalid strategy name';
      }

      // Required fields (only flag if user has interacted — non-empty then cleared)
      if (showAddModal || showEditModal) {
        const equity = isEquityMode(formData.tradeMode);
        // W4: templateName derives from intent; empty means the resolver found no engine for
        // the described strategy (the reason is shown in the Strategy Engine field).
        if (!formData.templateName && !customTemplate) errors.templateName = 'No engine matches these settings — see the Strategy Engine field';
        if (!equity && formData.universeId == null && underlyingSource === 'INDICES'
            && formData.fnoSymbolName !== undefined && formData.fnoSymbolName !== null && !formData.fnoSymbolName.trim()) {
          errors.fnoSymbolName = 'Underlying symbol is required';
        }

        // Watchlist-driven strategies (any trade mode): the universe is the underlying source,
        // and F&O/combo ones need the per-tranch cap that also defines the capital split
        // (mirrors the server-side validateUniverseBinding rule).
        if (!equity && underlyingSource === 'STOCKS') {
          if (!formData.universeId) errors.universeId = 'A stock watchlist is required';
          if (!formData.maxActivePositions || formData.maxActivePositions < 1) {
            errors.maxActivePositions = 'Max active positions is required for watchlist-driven strategies';
          }
        }

        // Trigger check
        const hasTrigger = formData.tickTriggerEnabled || formData.scheduledTriggerEnabled ||
                           formData.signalTriggerEnabled || formData.periodicTriggerEnabled;
        if (!hasTrigger) errors.trigger = 'At least one trigger type must be enabled';

        // Start/Stop time
        if (!formData.startTime) errors.startTime = 'Start time is required';
        if (!formData.stopTime) errors.stopTime = 'Stop time is required';

        // Capital per lot (FnO only — equity sizes via leverage/sizing models)
        if (!equity && (formData.capitalPerLot === undefined || formData.capitalPerLot === null)) {
          errors.capitalPerLot = 'Capital per lot is required';
        }

        // Equity: universe binding + leverage bounds + sizing-model params
        if (equity) {
          if (!formData.universeId) errors.universeId = 'A stock watchlist is required';
          if (formData.leverage !== undefined && formData.leverage !== null && formData.leverage < 1) {
            errors.leverage = 'Leverage must be at least 1';
          }
          if (formData.minLeverage != null && formData.maxLeverage != null && formData.minLeverage > formData.maxLeverage) {
            errors.minLeverage = 'Min leverage cannot exceed max leverage';
          }
          if (formData.leverage != null && formData.minLeverage != null && formData.leverage < formData.minLeverage) {
            errors.leverage = 'Leverage is below the min-leverage floor';
          }
          if (formData.leverage != null && formData.maxLeverage != null && formData.leverage > formData.maxLeverage) {
            errors.leverage = 'Leverage is above the max-leverage ceiling';
          }
          if (formData.equitySizingModel === 'FIXED_AMOUNT_PER_STOCK' && !formData.fixedAmountPerStock) {
            errors.fixedAmountPerStock = 'Fixed amount per stock is required for this sizing model';
          }
          if (formData.equitySizingModel === 'MAX_POSITIONS_EQUAL_SPLIT' && !formData.maxActivePositions) {
            errors.maxActivePositions = 'Max active positions is required for this sizing model';
          }
          if (formData.equitySizingModel === 'MAX_RISK_PER_TRADE' && !formData.maxRiskPctPerTrade) {
            errors.maxRiskPctPerTrade = 'Max risk % per trade is required for this sizing model';
          }
        }

        // Hedge percentage (not applicable for FUTURES)
        if (supportsHedging(formData.tradeMode)) {
          if (formData.product === 'INTRADAY' || formData.product === 'POSITIONAL') {
            if (formData.hedgeDistancePercentageIntraday === undefined || formData.hedgeDistancePercentageIntraday === null) {
              errors.hedgeDistancePercentageIntraday = formData.product === 'POSITIONAL' && formData.hedgeReplaceEnabled
                ? 'Hedge % (Intraday) is required'
                : 'Hedge Distance is required';
            }
          }
          if (formData.product === 'POSITIONAL' && formData.hedgeReplaceEnabled) {
            if (formData.hedgeDistancePercentagePositional === undefined || formData.hedgeDistancePercentagePositional === null) {
              errors.hedgeDistancePercentagePositional = 'Hedge % (Positional) is required';
            }
          }
        }

        // CANDLE direction provider params
        if (formData.directionProviderType === 'CANDLE') {
          const p = formData.directionProviderParams;
          if (!p?.comparisonMode) errors.comparisonMode = 'Comparison Mode is required';
          if (!p?.longWhen) errors.longWhen = 'LONG when condition is required';
          if (p?.comparisonMode === 'CMP_VS_REF') {
            if (!p.refTime) errors.refTime = 'Reference Time is required';
            if (!p.refDayOffset) errors.refDayOffset = 'Day Offset is required';
            if (isCustomTime(p.refTime) && !p.refPriceType) errors.refPriceType = 'Price Type is required';
          } else if (p?.comparisonMode === 'REF_VS_REF') {
            if (!p.ref1Time) errors.ref1Time = 'Reference 1 Time is required';
            if (!p.ref1DayOffset) errors.ref1DayOffset = 'Reference 1 Day Offset is required';
            if (isCustomTime(p.ref1Time) && !p.ref1PriceType) errors.ref1PriceType = 'Reference 1 Price Type is required';
            if (!p.ref2Time) errors.ref2Time = 'Reference 2 Time is required';
            if (!p.ref2DayOffset) errors.ref2DayOffset = 'Reference 2 Day Offset is required';
            if (isCustomTime(p.ref2Time) && !p.ref2PriceType) errors.ref2PriceType = 'Reference 2 Price Type is required';
          }
        }
      }

      if (Object.keys(errors).length > 0) {
        console.debug('[StrategyDef] validationErrors:', errors, 'formData:', formData);
      }
      return errors;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formData, showAddModal, showEditModal]);

  // Create mutation - pass indicator rules as part of variables to avoid stale closure issue
  const createMutation = useMutation({
    mutationFn: async ({ definitionData, rules, needsRules }: {
      definitionData: CreateStrategyDefinitionRequest;
      rules: IndicatorRuleSet;
      needsRules: boolean;
    }) => {
      // First create the strategy definition
      const createdDef = await strategyDefinitionService.create(definitionData);

      // Then save indicator rules if needed
      if (needsRules) {
        const hasRules = rules.entryRules != null ||
          rules.directionRules?.longRules != null ||
          rules.directionRules?.shortRules != null;

        if (hasRules) {
          try {
            await indicatorRulesService.save({
              ...rules,
              strategyName: createdDef.strategyName,
            });
          } catch (rulesError) {
            console.error('Failed to save indicator rules:', rulesError);
            toast.warning('Strategy created but indicator rules could not be saved');
          }
        }
      }

      return createdDef;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['strategy-definitions'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'strategyDefinitions', 'active'] });
      toast.success('Definition created successfully');
      handleCloseAddModal();
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to create definition');
    },
  });

  // Update mutation - pass indicator rules as part of variables to avoid stale closure issue
  const updateMutation = useMutation({
    mutationFn: async ({ id, data, rules, needsRules, strategyName }: {
      id: number;
      data: UpdateStrategyDefinitionRequest;
      rules: IndicatorRuleSet;
      needsRules: boolean;
      strategyName: string;
    }) => {
      // First update the strategy definition
      const updatedDef = await strategyDefinitionService.update(id, data);

      // Then save indicator rules if needed (skip if rules are empty to avoid overwriting)
      if (needsRules) {
        const hasRules = rules.entryRules != null ||
          rules.directionRules?.longRules != null ||
          rules.directionRules?.shortRules != null ||
          rules.exitRules != null;

        if (hasRules) {
          try {
            await indicatorRulesService.save({
              ...rules,
              strategyName: strategyName,
            });
          } catch (rulesError) {
            console.error('Failed to save indicator rules:', rulesError);
            toast.warning('Strategy updated but indicator rules could not be saved');
          }
        }
        // If no rules in state, skip silently — don't delete existing rules on server
      }

      return updatedDef;
    },
    onSuccess: (updatedDef) => {
      queryClient.setQueryData<StrategyDefinition[]>(['strategy-definitions'], (prev = []) =>
        prev.map((def) => def.strategyId === updatedDef.strategyId ? updatedDef : def)
      );
      queryClient.setQueryData<StrategyDefinition[]>(['admin', 'strategyDefinitions', 'active'], (prev = []) =>
        prev.map((def) => def.strategyId === updatedDef.strategyId ? updatedDef : def)
      );
      queryClient.invalidateQueries({ queryKey: ['strategy-definitions'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'strategyDefinitions', 'active'] });
      toast.success('Definition updated successfully');
      handleCloseEditModal();
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to update definition');
    },
  });

  // Change status mutation
  const changeStatusMutation = useMutation({
    mutationFn: ({ id, status }: { id: number; status: StrategyStatus }) =>
      strategyDefinitionService.changeStatus(id, status),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['strategy-definitions'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'strategyDefinitions', 'active'] });
      toast.success(`Status changed to ${variables.status}`);
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to change status');
    },
  });

  // Delete mutation
  const deleteMutation = useMutation({
    mutationFn: (id: number) => strategyDefinitionService.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['strategy-definitions'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'strategyDefinitions', 'active'] });
      toast.success('Definition deleted successfully');
      handleCloseDeleteModal();
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to delete definition');
    },
  });

  // Filter definitions based on search term and local UI filters
  const filteredDefinitions = definitions.filter(
    (def) => {
      // Status filter
      if (filterStatus && def.status !== filterStatus) {
        return false;
      }
      // Product filter
      if (filterProduct && def.product !== filterProduct) {
        return false;
      }
      // Search filter
      return (
        def.strategyName.toLowerCase().includes(searchTerm.toLowerCase()) ||
        def.templateName.toLowerCase().includes(searchTerm.toLowerCase()) ||
        def.fnoSymbolName.toLowerCase().includes(searchTerm.toLowerCase()) ||
        def.exchange.toLowerCase().includes(searchTerm.toLowerCase())
      );
    }
  );

  // Sort definitions
  const sortedDefinitions = useMemo(() => {
    if (!sortColumn) return filteredDefinitions;

    return [...filteredDefinitions].sort((a, b) => {
      let aVal: string;
      let bVal: string;

      switch (sortColumn) {
        case 'strategyName':
          aVal = a.strategyName.toLowerCase();
          bVal = b.strategyName.toLowerCase();
          break;
        case 'fnoSymbolName':
          aVal = a.fnoSymbolName.toLowerCase();
          bVal = b.fnoSymbolName.toLowerCase();
          break;
        case 'exchange':
          aVal = a.exchange.toLowerCase();
          bVal = b.exchange.toLowerCase();
          break;
        case 'product':
          aVal = a.product.toLowerCase();
          bVal = b.product.toLowerCase();
          break;
        case 'tradableDays':
          aVal = a.tradableDays?.toLowerCase() || '';
          bVal = b.tradableDays?.toLowerCase() || '';
          break;
        default:
          return 0;
      }

      if (aVal < bVal) return sortDirection === 'asc' ? -1 : 1;
      if (aVal > bVal) return sortDirection === 'asc' ? 1 : -1;
      return 0;
    });
  }, [filteredDefinitions, sortColumn, sortDirection]);

  // Handle column sort click
  const handleSort = (column: SortColumn) => {
    if (sortColumn === column) {
      // Toggle direction if same column
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      // New column, default to ascending
      setSortColumn(column);
      setSortDirection('asc');
    }
  };

  // Render sort icon for column header
  const renderSortIcon = (column: SortColumn) => {
    if (sortColumn !== column) {
      return <BsArrowDownUp className="ms-1 text-ink-soft" style={{ opacity: 0.5 }} />;
    }
    return sortDirection === 'asc' ? (
      <BsSortUp className="ms-1 text-primary-700 dark:text-primary-400" />
    ) : (
      <BsSortDown className="ms-1 text-primary-700 dark:text-primary-400" />
    );
  };

  // Prepare options for Clone From dropdown
  const cloneFromOptions = useMemo(() => {
    return definitions.map((def) => ({
      value: def.strategyName,
      label: `${def.displayName || def.strategyName} (${def.strategyName})`,
    }));
  }, [definitions]);

  // Modal handlers
  const handleOpenAddModal = () => {
    setSelectedDays([]);
    setSelectedExcludedDays([]);
    setFormData({
      strategyName: '',
      displayName: '',
      displayOrder: 0,
      templateName: '',
      fnoSymbolName: '',
      exchange: '',
      product: '' as Product,
      tradeMode: supportsFnO() ? 'OPTION_SELLING' : 'EQUITY',
      // Trigger type flags - none selected initially
      tickTriggerEnabled: false,
      scheduledTriggerEnabled: false,
      signalTriggerEnabled: false,
      periodicTriggerEnabled: false,
      startTime: '',
      stopTime: '',
      tradableDays: '',
      excludedDays: '',
      capitalPerLot: undefined,
      isOverlapCapital: false,
      expiryType: '' as ExpiryType,
      excludeMonthlyExpiry: false,
      usePremiumBalancing: true,
      underlyingType: 'INDEX',
      hedgeDistancePercentageIntraday: 0,
      hedgeDistancePercentagePositional: 0,
      isDirectional: false,
      directionProviderType: undefined,
      directionProviderParams: undefined,
      comboSpecJson: undefined,
      entryLegOrder: undefined,
      exitLegOrder: undefined,
      isPublic: false,
      isMock: false,
      catchUpMissedTranches: undefined,
      adaptiveTranchesEnabled: false,
      periodicIntervalMinutes: undefined,
      periodicOffsetSeconds: undefined,
      hedgeReplaceEnabled: false,
      hedgeMorningStartOffset: undefined,
      hedgeMorningEndOffset: undefined,
      hedgeEveningStartOffset: undefined,
      hedgeEveningEndOffset: undefined,
      universeId: undefined,
      leverage: undefined,
      minLeverage: undefined,
      maxLeverage: undefined,
      equitySizingModel: undefined,
      fixedAmountPerStock: undefined,
      maxActivePositions: undefined,
      maxRiskPctPerTrade: undefined,
      onIndexRemoval: undefined,
    });
    setFnoUnderlyingSource('INDICES');
    setShowAddModal(true);
  };

  const handleCloseAddModal = () => {
    setShowAddModal(false);
    setValidationErrors({});
    setCustomTemplate('');
    setIndicatorEntryIntent(false);

    // Reset indicator rules to new simplified structure
    setIndicatorRules({
      strategyName: '',
      entryRules: undefined,
      directionRules: undefined,
      exitRules: undefined,
      useIndicatorExit: false,
    });
  };

  // Handle cloning from an existing strategy
  const handleCloneFrom = (strategyName: string) => {
    if (!strategyName) {
      // Reset to empty values when "Select..." is chosen
      setSelectedDays([]);
      setSelectedExcludedDays([]);
      setFormData({
        strategyName: '',
        displayName: '',
        displayOrder: 0,
        templateName: '',
        fnoSymbolName: '',
        exchange: '',
        product: '' as Product,
        tradeMode: supportsFnO() ? 'OPTION_SELLING' : 'EQUITY',
        // Trigger type flags - none selected initially
        tickTriggerEnabled: false,
        scheduledTriggerEnabled: false,
        signalTriggerEnabled: false,
        periodicTriggerEnabled: false,
        startTime: '',
        stopTime: '',
        tradableDays: '',
        excludedDays: '',
        capitalPerLot: undefined,
        isOverlapCapital: false,
        expiryType: '' as ExpiryType,
        excludeMonthlyExpiry: false,
        usePremiumBalancing: true,
        underlyingType: 'INDEX',
        hedgeDistancePercentageIntraday: 0,
        hedgeDistancePercentagePositional: 0,
        isDirectional: false,
        directionProviderType: undefined,
        directionProviderParams: undefined,
        comboSpecJson: undefined,
        entryLegOrder: undefined,
        exitLegOrder: undefined,
        isPublic: false,
      isMock: false,
        catchUpMissedTranches: undefined,
        adaptiveTranchesEnabled: false,
        periodicIntervalMinutes: undefined,
        periodicOffsetSeconds: undefined,
        hedgeReplaceEnabled: false,
        hedgeMorningStartOffset: undefined,
        hedgeMorningEndOffset: undefined,
        hedgeEveningStartOffset: undefined,
        hedgeEveningEndOffset: undefined,
        universeId: undefined,
        leverage: undefined,
        minLeverage: undefined,
        maxLeverage: undefined,
        equitySizingModel: undefined,
        fixedAmountPerStock: undefined,
        maxActivePositions: undefined,
        maxRiskPctPerTrade: undefined,
        onIndexRemoval: undefined,
      });
      return;
    }

    const sourceStrategy = definitions.find((d) => d.strategyName === strategyName);
    if (!sourceStrategy) return;

    // Parse tradable days
    let days: TradableDay[] = [];
    if (sourceStrategy.tradableDays) {
      try {
        days = JSON.parse(sourceStrategy.tradableDays) as TradableDay[];
      } catch {
        days = [];
      }
    }
    setSelectedDays(days);

    // Parse excluded days
    let excludedDays: TradableDay[] = [];
    if (sourceStrategy.excludedDays) {
      try {
        excludedDays = JSON.parse(sourceStrategy.excludedDays) as TradableDay[];
      } catch {
        excludedDays = [];
      }
    }
    setSelectedExcludedDays(excludedDays);

    // Parse direction provider params
    let providerParams: Record<string, string> | undefined;
    if (sourceStrategy.directionProviderParams) {
      if (typeof sourceStrategy.directionProviderParams === 'string') {
        try {
          providerParams = JSON.parse(sourceStrategy.directionProviderParams);
        } catch {
          providerParams = undefined;
        }
      } else {
        providerParams = sourceStrategy.directionProviderParams as unknown as Record<string, string>;
      }
    }

    // Clone all fields EXCEPT strategyName, displayName, and fnoSymbolName
    setFormData({
      strategyName: '', // Keep empty - user must provide new name
      displayName: '', // Keep empty - user must provide new name
      displayOrder: sourceStrategy.displayOrder || 0,
      templateName: sourceStrategy.templateName,
      fnoSymbolName: '', // Keep empty - user must select
      exchange: '', // Keep empty - will be set when symbol is selected
      product: sourceStrategy.product,
      tradeMode: sourceStrategy.tradeMode || 'OPTION_SELLING',
      // Trigger type flags
      tickTriggerEnabled: sourceStrategy.tickTriggerEnabled,
      scheduledTriggerEnabled: sourceStrategy.scheduledTriggerEnabled,
      signalTriggerEnabled: sourceStrategy.signalTriggerEnabled,
      periodicTriggerEnabled: sourceStrategy.periodicTriggerEnabled,
      startTime: sourceStrategy.startTime || '09:20:00',
      stopTime: sourceStrategy.stopTime || '15:15:00',
      tradableDays: sourceStrategy.tradableDays || JSON.stringify(days),
      excludedDays: sourceStrategy.excludedDays || JSON.stringify(excludedDays),
      capitalPerLot: sourceStrategy.capitalPerLot || 0,
      capitalPerLotHedged: sourceStrategy.capitalPerLotHedged || 0,
      capitalPerLotNaked: sourceStrategy.capitalPerLotNaked || 0,
      isOverlapCapital: sourceStrategy.isOverlapCapital,
      expiryType: sourceStrategy.expiryType || 'WEEKLY',
      excludeMonthlyExpiry: sourceStrategy.excludeMonthlyExpiry ?? false,
      usePremiumBalancing: sourceStrategy.usePremiumBalancing ?? true,
      underlyingType: sourceStrategy.underlyingType || 'INDEX',
      hedgeDistancePercentageIntraday: sourceStrategy.hedgeDistancePercentageIntraday || 0,
      hedgeDistancePercentagePositional: sourceStrategy.hedgeDistancePercentagePositional || 0,
      isDirectional: sourceStrategy.isDirectional,
      directionProviderType: sourceStrategy.directionProviderType,
      directionProviderParams: providerParams,
      comboSpecJson: sourceStrategy.comboSpecJson,
      entryLegOrder: sourceStrategy.entryLegOrder,
      exitLegOrder: sourceStrategy.exitLegOrder,
      isPublic: false,
      isMock: false,
      catchUpMissedTranches: sourceStrategy.catchUpMissedTranches ?? true,
      adaptiveTranchesEnabled: sourceStrategy.adaptiveTranchesEnabled ?? false,
      periodicIntervalMinutes: sourceStrategy.periodicIntervalMinutes,
      periodicOffsetSeconds: sourceStrategy.periodicOffsetSeconds,
      hedgeReplaceEnabled: sourceStrategy.hedgeReplaceEnabled ?? false,
      hedgeMorningStartOffset: sourceStrategy.hedgeMorningStartOffset,
      hedgeMorningEndOffset: sourceStrategy.hedgeMorningEndOffset,
      hedgeEveningStartOffset: sourceStrategy.hedgeEveningStartOffset,
      hedgeEveningEndOffset: sourceStrategy.hedgeEveningEndOffset,
      riskPercentage: sourceStrategy.riskPercentage,
      absoluteMaxRisk: sourceStrategy.absoluteMaxRisk,
      minRiskPercentage: sourceStrategy.minRiskPercentage,
      maxRiskPercentage: sourceStrategy.maxRiskPercentage,
      // Equity leverage & sizing
      universeId: sourceStrategy.universeId,
      leverage: sourceStrategy.leverage,
      minLeverage: sourceStrategy.minLeverage,
      maxLeverage: sourceStrategy.maxLeverage,
      equitySizingModel: sourceStrategy.equitySizingModel,
      fixedAmountPerStock: sourceStrategy.fixedAmountPerStock,
      maxActivePositions: sourceStrategy.maxActivePositions,
      maxRiskPctPerTrade: sourceStrategy.maxRiskPctPerTrade,
      onIndexRemoval: sourceStrategy.onIndexRemoval,
    });

    // W4: seed derivation inputs from the source strategy (see the edit-open note).
    setCustomTemplate(
      templates.find((tpl) => tpl.templateName === sourceStrategy.templateName)?.isUserSelectable
        ? sourceStrategy.templateName : '');
    setIndicatorEntryIntent(sourceStrategy.templateName === 'INDICATOR_ADVANCED_OPTIONS');

    // Clone indicator rules from source strategy
    const needsIndicatorRules = sourceStrategy.templateName === 'INDICATOR_ADVANCED_OPTIONS' ||
      sourceStrategy.directionProviderType === 'INDICATOR';

    if (needsIndicatorRules) {
      indicatorRulesService.getByStrategy(sourceStrategy.strategyName).then((rules) => {
        if (rules) {
          setIndicatorRules({
            strategyName: '', // Will be set to new strategy name on save
            entryRules: rules.entryRules,
            directionRules: rules.directionRules,
            exitRules: rules.exitRules,
            useIndicatorExit: rules.useIndicatorExit ?? false,
          });
        } else {
          setIndicatorRules({
            strategyName: '',
            entryRules: undefined,
            directionRules: undefined,
            exitRules: undefined,
            useIndicatorExit: false,
          });
        }
      }).catch(() => {
        setIndicatorRules({
          strategyName: '',
          entryRules: undefined,
          directionRules: undefined,
          exitRules: undefined,
          useIndicatorExit: false,
        });
      });
    } else {
      setIndicatorRules({
        strategyName: '',
        entryRules: undefined,
        directionRules: undefined,
        exitRules: undefined,
        useIndicatorExit: false,
      });
    }
  };

  const handleOpenEditModal = (definition: StrategyDefinition) => {
    setSelectedDefinition(definition);
    // Parse tradableDays JSON string to array
    let days: TradableDay[] = [];
    if (definition.tradableDays) {
      try {
        days = JSON.parse(definition.tradableDays) as TradableDay[];
      } catch {
        days = [];
      }
    }
    setSelectedDays(days);
    // Parse excludedDays JSON string to array
    let excludedDays: TradableDay[] = [];
    if (definition.excludedDays) {
      try {
        excludedDays = JSON.parse(definition.excludedDays) as TradableDay[];
      } catch {
        excludedDays = [];
      }
    }
    setSelectedExcludedDays(excludedDays);
    // Parse directionProviderParams if it's a JSON string
    let providerParams: Record<string, string> | undefined;
    if (definition.directionProviderParams) {
      if (typeof definition.directionProviderParams === 'string') {
        try {
          providerParams = JSON.parse(definition.directionProviderParams);
        } catch {
          providerParams = undefined;
        }
      } else {
        providerParams = definition.directionProviderParams;
      }
    }
    setFormData({
      strategyName: definition.strategyName,
      displayName: definition.displayName || '',
      displayOrder: definition.displayOrder || 0,
      templateName: definition.templateName,
      fnoSymbolName: definition.fnoSymbolName,
      exchange: definition.exchange,
      product: definition.product || 'INTRADAY',
      tradeMode: definition.tradeMode || 'OPTION_SELLING',
      // Trigger type flags
      tickTriggerEnabled: definition.tickTriggerEnabled,
      scheduledTriggerEnabled: definition.scheduledTriggerEnabled,
      signalTriggerEnabled: definition.signalTriggerEnabled,
      periodicTriggerEnabled: definition.periodicTriggerEnabled,
      startTime: definition.startTime || '',
      stopTime: definition.stopTime || '',
      tradableDays: definition.tradableDays || '',
      excludedDays: definition.excludedDays || '',
      capitalPerLot: definition.capitalPerLot || 0,
      capitalPerLotHedged: definition.capitalPerLotHedged || 0,
      capitalPerLotNaked: definition.capitalPerLotNaked || 0,
      isOverlapCapital: definition.isOverlapCapital || false,
      expiryType: definition.expiryType || 'WEEKLY',
      excludeMonthlyExpiry: definition.excludeMonthlyExpiry ?? false,
      usePremiumBalancing: definition.usePremiumBalancing ?? true,
      underlyingType: definition.underlyingType || 'INDEX',
      hedgeDistancePercentageIntraday: definition.hedgeDistancePercentageIntraday || 0,
      hedgeDistancePercentagePositional: definition.hedgeDistancePercentagePositional || 0,
      isDirectional: definition.isDirectional || false,
      directionProviderType: definition.directionProviderType,
      directionProviderParams: providerParams,
      comboSpecJson: definition.comboSpecJson,
      entryLegOrder: definition.entryLegOrder,
      exitLegOrder: definition.exitLegOrder,
      isPublic: definition.isPublic || false,
      isMock: definition.isMock || false,
      scope: definition.scope || 'SYSTEM',
      catchUpMissedTranches: definition.catchUpMissedTranches ?? true,
      adaptiveTranchesEnabled: definition.adaptiveTranchesEnabled ?? false,
      periodicIntervalMinutes: definition.periodicIntervalMinutes,
      periodicOffsetSeconds: definition.periodicOffsetSeconds,
      hedgeReplaceEnabled: definition.hedgeReplaceEnabled ?? false,
      hedgeMorningStartOffset: definition.hedgeMorningStartOffset,
      hedgeMorningEndOffset: definition.hedgeMorningEndOffset,
      hedgeEveningStartOffset: definition.hedgeEveningStartOffset,
      hedgeEveningEndOffset: definition.hedgeEveningEndOffset,
      // Risk allocation settings
      riskPercentage: definition.riskPercentage,
      absoluteMaxRisk: definition.absoluteMaxRisk,
      minRiskPercentage: definition.minRiskPercentage,
      maxRiskPercentage: definition.maxRiskPercentage,
      // Equity leverage & sizing
      universeId: definition.universeId,
      leverage: definition.leverage,
      minLeverage: definition.minLeverage,
      maxLeverage: definition.maxLeverage,
      equitySizingModel: definition.equitySizingModel,
      fixedAmountPerStock: definition.fixedAmountPerStock,
      maxActivePositions: definition.maxActivePositions,
      maxRiskPctPerTrade: definition.maxRiskPctPerTrade,
      onIndexRemoval: definition.onIndexRemoval,
    });

    // Load indicator rules if:
    // 1. Template is INDICATOR_ADVANCED_OPTIONS (full entry/direction/exit rules), OR
    // 2. Direction provider is INDICATOR (direction rules only)
    const needsIndicatorRules = definition.templateName === 'INDICATOR_ADVANCED_OPTIONS' ||
      definition.directionProviderType === 'INDICATOR';

    if (needsIndicatorRules) {
      setIndicatorRulesLoading(true);
      indicatorRulesService.getByStrategy(definition.strategyName).then((rules) => {
        if (rules) {
          setIndicatorRules({
            strategyName: rules.strategyName,
            entryRules: rules.entryRules,
            directionRules: rules.directionRules,
            exitRules: rules.exitRules,
            useIndicatorExit: rules.useIndicatorExit ?? false,
          });
        } else {
          setIndicatorRules({
            strategyName: definition.strategyName,
            entryRules: undefined,
            directionRules: undefined,
            exitRules: undefined,
            useIndicatorExit: false,
          });
        }
      }).catch(() => {
        setIndicatorRules({
          strategyName: definition.strategyName,
          entryRules: undefined,
          directionRules: undefined,
          exitRules: undefined,
          useIndicatorExit: false,
        });
      }).finally(() => {
        setIndicatorRulesLoading(false);
      });
    } else {
      setIndicatorRules({
        strategyName: '',
        entryRules: undefined,
        directionRules: undefined,
        exitRules: undefined,
        useIndicatorExit: false,
      });
    }

    // W4: seed the derivation inputs from the stored definition. A custom-logic template stays
    // an explicit pick; a generic one is re-derived (W3 verified the round-trip on all live
    // definitions, so the derived engine equals the stored one).
    setCustomTemplate(
      templates.find((tpl) => tpl.templateName === definition.templateName)?.isUserSelectable
        ? definition.templateName : '');
    setIndicatorEntryIntent(definition.templateName === 'INDICATOR_ADVANCED_OPTIONS');
    setEditModalReadOnly(!canEditDefinition(definition));
    setFnoUnderlyingSource(definition.universeId != null ? 'STOCKS' : 'INDICES');
    setShowEditModal(true);
  };

  const handleCloseEditModal = () => {
    setShowEditModal(false);
    setEditModalReadOnly(false);
    setSelectedDefinition(null);
    setCustomTemplate('');
    setIndicatorEntryIntent(false);

    setIndicatorRulesLoading(false);
    // Reset indicator rules to new simplified structure
    setIndicatorRules({
      strategyName: '',
      entryRules: undefined,
      directionRules: undefined,
      exitRules: undefined,
      useIndicatorExit: false,
    });
  };

  const handleOpenDeleteModal = (definition: StrategyDefinition) => {
    setSelectedDefinition(definition);
    setShowDeleteModal(true);
  };

  const handleCloseDeleteModal = () => {
    setShowDeleteModal(false);
    setSelectedDefinition(null);
  };

  // Form validation helper
  // Inline validation keeps validationErrors up to date in real-time.
  // This helper checks if the form is currently valid.
  const isFormValid = (): boolean => {
    return Object.keys(validationErrors).length === 0;
  };

  // Form submission handlers
  // Universe-bound definitions (equity AND watchlist-driven F&O/combos) bind a watchlist, not a
  // single symbol, but the backend's UNDERLYING_SYMBOL column is NOT NULL — derive a stable
  // placeholder from the selected universe (indexKey/name) and default the exchange to the
  // universe's. The engine never trades the placeholder: the universe fan-out swaps the real
  // member symbol into every evaluation.
  const universeSubmitOverrides = (): Partial<StrategyDefinitionFormData> => {
    if (formData.universeId == null) return {};
    const universe = universes.find((u: StockUniverse) => u.universeId === formData.universeId);
    return {
      fnoSymbolName: formData.fnoSymbolName?.trim() || universe?.indexKey || universe?.name || 'EQUITY',
      exchange: formData.exchange || universe?.exchange || 'NSE',
    };
  };

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();


    // Safety net — inline validation should have caught everything
    if (!isFormValid()) {
      const firstError = Object.values(validationErrors)[0];
      toast.error(firstError || 'Please fix validation errors');
      return;
    }

    // Convert selectedDays array, excludedDays array, and directionProviderParams to JSON strings
    const submitData = {
      ...formData,
      ...universeSubmitOverrides(),
      tradableDays: selectedDays.length > 0 ? JSON.stringify(selectedDays) : '',
      excludedDays: selectedExcludedDays.length > 0 ? JSON.stringify(selectedExcludedDays) : '',
      directionProviderParams: formData.directionProviderParams && Object.keys(formData.directionProviderParams).length > 0
        ? JSON.stringify(formData.directionProviderParams)
        : undefined,
      // A combo declares direction per leg; the strategy-level flag and provider are ignored by
      // the engine and rejected by the server, so never submit them alongside a spec.
      ...(formData.comboSpecJson ? {
        isDirectional: false,
        directionProviderType: undefined,
        directionProviderParams: undefined,
      } : {}),
    };

    // Determine if indicator rules need to be saved
    const needsIndicatorRules = formData.templateName === 'INDICATOR_ADVANCED_OPTIONS' ||
      formData.directionProviderType === 'INDICATOR';

    createMutation.mutate({
      definitionData: submitData as CreateStrategyDefinitionRequest,
      rules: sanitizeIndicatorRules(indicatorRules),
      needsRules: needsIndicatorRules,
    });
  };

  const handleUpdate = (e: React.FormEvent) => {
    e.preventDefault();

    if (!selectedDefinition?.strategyId) return;

    if (indicatorRulesLoading) {
      toast.warning('Indicator rules are still loading, please wait...');
      return;
    }

    // Safety net — inline validation should have caught everything
    if (!isFormValid()) {
      const firstError = Object.values(validationErrors)[0];
      toast.error(firstError || 'Please fix validation errors');
      return;
    }

    // Convert selectedDays array, excludedDays array, and directionProviderParams to JSON strings
    const submitData = {
      ...formData,
      ...universeSubmitOverrides(),
      tradableDays: selectedDays.length > 0 ? JSON.stringify(selectedDays) : '',
      excludedDays: selectedExcludedDays.length > 0 ? JSON.stringify(selectedExcludedDays) : '',
      directionProviderParams: formData.directionProviderParams && Object.keys(formData.directionProviderParams).length > 0
        ? JSON.stringify(formData.directionProviderParams)
        : undefined,
      // A combo declares direction per leg; the strategy-level flag and provider are ignored by
      // the engine and rejected by the server, so never submit them alongside a spec.
      ...(formData.comboSpecJson ? {
        isDirectional: false,
        directionProviderType: undefined,
        directionProviderParams: undefined,
      } : {}),
    };

    // Determine if indicator rules need to be saved
    const needsIndicatorRules = formData.templateName === 'INDICATOR_ADVANCED_OPTIONS' ||
      formData.directionProviderType === 'INDICATOR';

    updateMutation.mutate({
      id: selectedDefinition.strategyId,
      data: submitData as UpdateStrategyDefinitionRequest,
      rules: sanitizeIndicatorRules(indicatorRules),
      needsRules: needsIndicatorRules,
      strategyName: selectedDefinition.strategyName,
    });
  };

  const handleDelete = () => {
    if (!selectedDefinition?.strategyId) return;
    deleteMutation.mutate(selectedDefinition.strategyId);
  };

  // Helper to render trigger badges from boolean flags
  const getTriggerBadges = (def: StrategyDefinition) => {
    const badges = [];
    if (def.tickTriggerEnabled) badges.push(<Badge key="tick" bg="primary" className="me-1">Tick</Badge>);
    if (def.scheduledTriggerEnabled) badges.push(<Badge key="sched" bg="info" className="me-1">Scheduled</Badge>);
    if (def.signalTriggerEnabled) badges.push(<Badge key="signal" bg="warning" className="me-1">Signal</Badge>);
    if (def.periodicTriggerEnabled) badges.push(<Badge key="periodic" bg="secondary" className="me-1">Periodic</Badge>);
    return badges.length > 0 ? badges : <Badge bg="secondary">None</Badge>;
  };

  const getProductBadge = (product: Product) => {
    const prod = PRODUCTS.find((p) => p.value === product);
    return <Badge bg={prod?.bg || 'secondary'}>{prod?.label || product}</Badge>;
  };

  const getTradeModeBadge = (tradeMode?: TradeMode) => {
    const mode = TRADE_MODES.find((m) => m.value === tradeMode);
    if (!mode || tradeMode === 'OPTION_SELLING') return null; // Don't show badge for default
    const bg = tradeMode === 'OPTION_BUYING' ? 'warning' : tradeMode === 'FUTURES' ? 'danger' : 'dark';
    return <Badge bg={bg} className="ms-1">{mode.label}</Badge>;
  };

  const getStatusBadge = (status: StrategyStatus) => {
    const statusInfo = STRATEGY_STATUSES.find((s) => s.value === status);
    const icon = status === 'ACTIVE' ? <BsCheckCircle className="me-1" /> :
                 status === 'WIND_DOWN' ? <BsPause className="me-1" /> :
                 <BsXCircle className="me-1" />;
    return (
      <Badge bg={statusInfo?.bg || 'secondary'} title={statusInfo?.description}>
        {icon}{statusInfo?.label || status}
      </Badge>
    );
  };

  // ==================== Export/Import Handlers ====================

  const handleToggleSelect = (strategyName: string) => {
    setSelectedStrategies(prev => {
      const next = new Set(prev);
      if (next.has(strategyName)) next.delete(strategyName);
      else next.add(strategyName);
      return next;
    });
  };

  const handleSelectAll = () => {
    if (selectedStrategies.size === sortedDefinitions.length) {
      setSelectedStrategies(new Set());
    } else {
      setSelectedStrategies(new Set(sortedDefinitions.map(d => d.strategyName)));
    }
  };

  const handleExport = async (mode: 'selected' | 'all') => {
    try {
      const names = mode === 'all' ? 'all' : Array.from(selectedStrategies);
      const blob = await strategyDefinitionTransferService.exportDefinitions(names);
      const url = window.URL.createObjectURL(new Blob([blob]));
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', `strategy-export-${new Date().toISOString().slice(0,10).replace(/-/g,'')}.xlsx`);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
      toast.success(`Exported ${mode === 'all' ? 'all' : selectedStrategies.size} strategies`);
    } catch (err) {
      toast.error('Export failed: ' + (err as Error).message);
    }
  };

  const handleImportPreview = async () => {
    if (!importFile) return;
    setImportLoading(true);
    try {
      const preview = await strategyDefinitionTransferService.importPreview(importFile);
      setImportPreview(preview);
      // Initialize resolutions for conflicts as SKIP
      const resolutions: Record<string, 'OVERRIDE' | 'SKIP'> = {};
      preview.conflictingStrategies.forEach(name => { resolutions[name] = 'SKIP'; });
      setImportResolutions(resolutions);
      setImportStep(2);
    } catch (err) {
      toast.error('Preview failed: ' + (err as Error).message);
    } finally {
      setImportLoading(false);
    }
  };

  const handleImportApply = async () => {
    if (!importFile) return;
    setImportLoading(true);
    try {
      const result = await strategyDefinitionTransferService.importApply(importFile, importResolutions, 'SKIP');
      setImportResult(result);
      setImportStep(3);
      // Refresh definitions
      refetch();
      if (result.errors.length === 0) {
        toast.success(`Import complete: ${result.imported} new, ${result.overridden} overridden, ${result.skipped} skipped`);
      } else {
        toast.warning(`Import complete with ${result.errors.length} error(s)`);
      }
    } catch (err) {
      toast.error('Import failed: ' + (err as Error).message);
    } finally {
      setImportLoading(false);
    }
  };

  const handleBulkResolution = (resolution: 'OVERRIDE' | 'SKIP') => {
    if (!importPreview) return;
    const resolutions: Record<string, 'OVERRIDE' | 'SKIP'> = {};
    importPreview.conflictingStrategies.forEach(name => { resolutions[name] = resolution; });
    setImportResolutions(resolutions);
  };

  const resetImportModal = () => {
    setShowImportModal(false);
    setImportFile(null);
    setImportPreview(null);
    setImportResolutions({});
    setImportStep(1);
    setImportResult(null);
  };

  if (error) {
    return (
      <Alert variant="danger">
        Failed to load strategy definitions: {(error as Error).message}
      </Alert>
    );
  }

  return (
    <Card>
      {/* flex-wrap: the filter/action toolbar is wider than small screens —
          controls must wrap inside the panel, not overflow past its edge. */}
      <Card.Header className="flex flex-wrap justify-between items-center gap-2">
        <div className="flex items-center gap-4">
          <h6 className="mb-0">
            <BsGear className="me-2" />
            Strategy Definitions ({filteredDefinitions.length})
          </h6>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <InputGroup style={{ width: '200px' }}>
            <InputGroup.Text>
              <BsSearch />
            </InputGroup.Text>
            <Form.Control
              type="text"
              placeholder="Search..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </InputGroup>
          <Form.Select
            style={{ width: '150px' }}
            value={filterTemplate}
            onChange={(e) => setFilterTemplate(e.target.value)}
          >
            <option value="">All Templates</option>
            {templates.map((t) => (
              <option key={t.templateName} value={t.templateName}>{t.displayName}</option>
            ))}
          </Form.Select>
          <Form.Select
            style={{ width: '130px' }}
            value={filterExchange}
            onChange={(e) => setFilterExchange(e.target.value)}
          >
            <option value="">All Exchanges</option>
            {EXCHANGES.map((ex) => (
              <option key={ex} value={ex}>{ex}</option>
            ))}
          </Form.Select>
          <Form.Select
            style={{ width: '130px' }}
            value={filterProduct}
            onChange={(e) => setFilterProduct(e.target.value)}
          >
            <option value="">All Products</option>
            {PRODUCTS.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </Form.Select>
          <Form.Select
            style={{ width: '130px' }}
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
          >
            <option value="">All Statuses</option>
            {STRATEGY_STATUSES.map((status) => (
              <option key={status.value} value={status.value}>{status.label}</option>
            ))}
          </Form.Select>
          <Button variant="outline-secondary" onClick={() => refetch()} title="Refresh">
            <BsArrowClockwise />
          </Button>
          {(permissions.strategyDefinitions.canEdit || user?.isSysadmin) && (
            <>
              <Dropdown>
                <Dropdown.Toggle variant="outline-success" className="inline-flex items-center">
                  <BsDownload className="me-1" />
                  Export
                </Dropdown.Toggle>
                <Dropdown.Menu>
                  <Dropdown.Item
                    onClick={() => handleExport('selected')}
                    disabled={selectedStrategies.size === 0}
                  >
                    Export Selected ({selectedStrategies.size})
                  </Dropdown.Item>
                  <Dropdown.Item onClick={() => handleExport('all')}>
                    Export All
                  </Dropdown.Item>
                </Dropdown.Menu>
              </Dropdown>
              <Button variant="outline-info" className="inline-flex items-center" onClick={() => { resetImportModal(); setShowImportModal(true); }}>
                <BsUpload className="me-1" />
                Import
              </Button>
            </>
          )}
          {permissions.strategyDefinitions.canEdit && (
            <Button variant="primary" onClick={handleOpenAddModal}>
              <BsPlus className="me-1" />
              Add Definition
            </Button>
          )}
        </div>
      </Card.Header>
      <Card.Body className="p-0">
        {isLoading ? (
          <div className="text-center py-12">
            <Spinner animation="border" variant="primary" />
            <p className="mt-2 text-ink-soft">Loading definitions...</p>
          </div>
        ) : sortedDefinitions.length === 0 ? (
          <div className="text-center py-12 text-ink-soft">
            {searchTerm || filterTemplate || filterExchange || filterProduct || filterStatus
              ? 'No definitions match your filters.'
              : permissions.strategyDefinitions.canEdit
                ? 'No definitions found. Click "Add Definition" to create one.'
                : 'No definitions found.'}
          </div>
        ) : (
          <Table hover responsive className="mb-0">
            <thead>
              <tr>
                {(permissions.strategyDefinitions.canEdit || user?.isSysadmin) && (
                  <th style={{ width: '40px' }}>
                    <Form.Check
                      type="checkbox"
                      checked={sortedDefinitions.length > 0 && selectedStrategies.size === sortedDefinitions.length}
                      onChange={handleSelectAll}
                    />
                  </th>
                )}
                <th
                  onClick={() => handleSort('strategyName')}
                  style={{ cursor: 'pointer', userSelect: 'none' }}
                >
                  Strategy Name {renderSortIcon('strategyName')}
                </th>
                <th>Template</th>
                <th
                  onClick={() => handleSort('fnoSymbolName')}
                  style={{ cursor: 'pointer', userSelect: 'none' }}
                >
                  Symbol {renderSortIcon('fnoSymbolName')}
                </th>
                <th
                  onClick={() => handleSort('exchange')}
                  style={{ cursor: 'pointer', userSelect: 'none' }}
                >
                  Exchange {renderSortIcon('exchange')}
                </th>
                <th
                  onClick={() => handleSort('product')}
                  style={{ cursor: 'pointer', userSelect: 'none' }}
                >
                  Product {renderSortIcon('product')}
                </th>
                <th>Trigger</th>
                <th
                  onClick={() => handleSort('tradableDays')}
                  style={{ cursor: 'pointer', userSelect: 'none' }}
                >
                  Tradable Days {renderSortIcon('tradableDays')}
                </th>
                <th>Owner</th>
                <th>Visibility</th>
                <th>Status</th>
                <th className="text-end">Actions</th>
              </tr>
            </thead>
            <tbody>
              {sortedDefinitions.map((def) => (
                <tr key={def.strategyId}>
                  {(permissions.strategyDefinitions.canEdit || user?.isSysadmin) && (
                    <td>
                      <Form.Check
                        type="checkbox"
                        checked={selectedStrategies.has(def.strategyName)}
                        onChange={() => handleToggleSelect(def.strategyName)}
                      />
                    </td>
                  )}
                  <td>
                    <code className="text-primary-700 dark:text-primary-400">{def.strategyName}</code>
                    <Badge bg={def.scope === 'SYSTEM' ? 'secondary' : 'info'} className="ms-2">
                      {def.scope || 'SYSTEM'}
                    </Badge>
                  </td>
                  <td>{def.templateName}</td>
                  <td>
                    {isEquityMode(def.tradeMode) && def.universeId
                      ? <span title="Stock universe"><Badge bg="info" className="me-1">U</Badge><code>{universeName(def.universeId) || def.fnoSymbolName}</code></span>
                      : <code>{def.fnoSymbolName}</code>}
                  </td>
                  <td><Badge bg="secondary">{def.exchange}</Badge></td>
                  <td>{getProductBadge(def.product)}{getTradeModeBadge(def.tradeMode)}</td>
                  <td>{getTriggerBadges(def)}</td>
                  <td>
                    {def.tradableDays ? (
                      <small className="text-success-500 dark:text-success-400">
                        {(() => {
                          try {
                            const days = JSON.parse(def.tradableDays) as string[];
                            return days.join(', ');
                          } catch {
                            return def.tradableDays;
                          }
                        })()}
                      </small>
                    ) : (
                      <small className="text-ink-soft">All</small>
                    )}
                    {def.excludedDays && (
                      <>
                        <br />
                        <small className="text-danger-600 dark:text-danger-400">
                          <strong>Excl:</strong>{' '}
                          {(() => {
                            try {
                              const days = JSON.parse(def.excludedDays) as string[];
                              return days.join(', ');
                            } catch {
                              return def.excludedDays;
                            }
                          })()}
                        </small>
                      </>
                    )}
                  </td>
                  <td>
                    <code className={def.username === currentUsername ? 'text-primary-700 dark:text-primary-400' : 'text-ink-soft'}>
                      {def.username || 'N/A'}
                    </code>
                    {def.username === currentUsername && (
                      <Badge bg="info" className="ms-1">You</Badge>
                    )}
                  </td>
                  <td>
                    {def.isPublic ? (
                      <Badge bg="success"><BsGlobe className="me-1" />Public</Badge>
                    ) : (
                      <Badge bg="secondary"><BsLock className="me-1" />Private</Badge>
                    )}
                  </td>
                  <td>{getStatusBadge(def.status)}</td>
                  <td className="text-end">
                    {canEditDefinition(def) && (
                      <Form.Select
                        size="sm"
                        style={{ width: '120px', display: 'inline-block' }}
                        className="me-1"
                        value={def.status}
                        onChange={(e) => {
                          if (def.strategyId) {
                            changeStatusMutation.mutate({
                              id: def.strategyId,
                              status: e.target.value as StrategyStatus,
                            });
                          }
                        }}
                        disabled={changeStatusMutation.isPending}
                      >
                        {STRATEGY_STATUSES.map((s) => (
                          <option key={s.value} value={s.value}>{s.label}</option>
                        ))}
                      </Form.Select>
                    )}
                    <Button
                      variant="outline-primary"
                      size="sm"
                      className="me-1"
                      onClick={() => handleOpenEditModal(def)}
                      title={canEditDefinition(def) ? 'Edit' : 'View'}
                    >
                      {canEditDefinition(def) ? <BsPencil /> : <BsEye />}
                    </Button>
                    {canDeleteDefinition(def) && (
                      <Button
                        variant="outline-danger"
                        size="sm"
                        onClick={() => handleOpenDeleteModal(def)}
                        title="Delete"
                      >
                        <BsTrash />
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card.Body>

      {/* Add Modal */}
      <Modal show={showAddModal} onHide={handleCloseAddModal} size="xl" backdrop="static">
        <Modal.Header closeButton>
          <Modal.Title>
            <BsPlus className="me-2" />
            Add Strategy Definition
          </Modal.Title>
        </Modal.Header>
        <Form onSubmit={handleCreate}>
          <Modal.Body>
            {/* Clone From */}
            <Row className="mb-6">
              <Col md={12}>
                <Form.Group>
                  <Form.Label>Clone From:</Form.Label>
                  <Select
                    options={cloneFromOptions}
                    value={null}
                    onChange={(selected) => handleCloneFrom(selected?.value || '')}
                    placeholder="Search and select strategy to clone..."
                    isClearable
                    isSearchable
                    classNamePrefix="react-select"
                  />
                  <Form.Text className="text-ink-soft">
                    Select a strategy to copy its settings. Strategy Name, Display Name, and Underlying Symbol will not be copied.
                  </Form.Text>
                </Form.Group>
              </Col>
            </Row>

            <hr className="mb-6" />

            {/* Basic Info */}
            <div className="border rounded-md p-4 mb-4" style={{ borderColor: 'rgb(var(--c-hairline))' }}>
              <div className="text-ink-soft text-[0.875em] font-semibold mb-2" style={{ marginTop: '-1.5rem', background: 'rgb(var(--c-card))', width: 'fit-content', padding: '0 0.5rem' }}>
                Basic Information
              </div>
              <Row>
              <Col md={6}>
                <Form.Group className="mb-4">
                  <Form.Label className="flex items-center">Strategy Name <span className="text-danger-600 dark:text-danger-400">*</span> <HelpIcon article={strategyDefinitionHelpContent['strategyDef.strategyName']} /></Form.Label>
                  <Form.Control
                    type="text"
                    placeholder="e.g., NIFTY_MOMENTUM_INTRADAY"
                    value={formData.strategyName}
                    onChange={(e) => {
                      // Auto-uppercase and only allow valid characters
                      const value = e.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, '');
                      setFormData({ ...formData, strategyName: value });
                    }}
                    isInvalid={
                      (formData.strategyName.length > 0 && !validateStrategyName(formData.strategyName).isValid) ||
                      !!validationErrors.duplicateStrategyName
                    }
                    required
                  />
                  {formData.strategyName.length > 0 && !validateStrategyName(formData.strategyName).isValid && (
                    <Form.Control.Feedback type="invalid">
                      {validateStrategyName(formData.strategyName).error}
                    </Form.Control.Feedback>
                  )}
                  {validationErrors.duplicateStrategyName && validateStrategyName(formData.strategyName).isValid && (
                    <Form.Control.Feedback type="invalid">
                      {validationErrors.duplicateStrategyName}
                    </Form.Control.Feedback>
                  )}
                  <Form.Text className="text-ink-soft">
                    Alphanumeric, hyphens (-) and underscores (_) only. Cannot start or end with - or _.
                  </Form.Text>
                </Form.Group>
              </Col>
              <Col md={6}>
                <Form.Group className="mb-4">
                  <Form.Label className="flex items-center">Display Name <HelpIcon article={strategyDefinitionHelpContent['strategyDef.displayName']} /></Form.Label>
                  <Form.Control
                    type="text"
                    placeholder="e.g., Nifty Momentum Intraday"
                    value={formData.displayName}
                    onChange={(e) => setFormData({ ...formData, displayName: e.target.value })}
                  />
                </Form.Group>
              </Col>
            </Row>


            </div>

            {/* Section: What It Trades - Trade Mode first: it reshapes everything below. */}
            <div className="border rounded-md p-4 mb-4" style={{ borderColor: 'rgb(var(--c-hairline))' }}>
              <div className="text-ink-soft text-[0.875em] font-semibold mb-2" style={{ marginTop: '-1.5rem', background: 'rgb(var(--c-card))', width: 'fit-content', padding: '0 0.5rem' }}>
                What It Trades
              </div>
              <Row>
              <Col md={3}>
                {renderTradeModeField()}
              </Col>
              </Row>
              <Row>
              <Col md={6}>
                {renderUnderlyingsField(true, 'add')}
              </Col>
              <Col md={3}>
                <Form.Group className="mb-4">
                  <Form.Label className="flex items-center">Exchange <HelpIcon article={strategyDefinitionHelpContent['strategyDef.exchange']} /></Form.Label>
                  <Form.Select
                    value={formData.exchange}
                    onChange={(e) => setFormData({ ...formData, exchange: e.target.value })}
                    disabled
                  >
                    {EXCHANGES.map((ex) => (
                      <option key={ex} value={ex}>{ex}</option>
                    ))}
                  </Form.Select>
                </Form.Group>
              </Col>
              {/* A combo declares product PER LEG in the editor below; the strategy-level
                  value is derived from the legs and the field is hidden. */}
              {!comboShapeType && (
              <Col md={3}>
                <Form.Group className="mb-4">
                  <Form.Label className="flex items-center">Product Type <HelpIcon article={strategyDefinitionHelpContent['strategyDef.product']} /></Form.Label>
                  <Form.Select
                    value={formData.product}
                    onChange={(e) => setFormData({ ...formData, product: e.target.value as Product })}
                    disabled={!!formData.isMock}
                  >
                    <option value="">Select Product Type...</option>
                    {productsForTradeMode(formData.tradeMode).map((p) => (
                      <option key={p.value} value={p.value}>{p.label}</option>
                    ))}
                    {/* Keep a legacy value visible/selectable if it no longer fits the trade mode */}
                    {formData.product && !productsForTradeMode(formData.tradeMode).some((p) => p.value === formData.product) && (
                      <option value={formData.product}>{PRODUCTS.find((p) => p.value === formData.product)?.label || formData.product}</option>
                    )}
                  </Form.Select>
                  {formData.isMock && (
                    <Form.Text className="text-ink-soft">
                      Locked to INTRADAY for mock-trading strategies.
                    </Form.Text>
                  )}
                </Form.Group>
              </Col>
              )}

            </Row>
                {/* Multi-leg combo shape — absent for a normal strategy (see ComboSpecEditor) */}
                <ComboSpecEditor
                  value={formData.comboSpecJson}
                  disabled={editModalReadOnly}
                  onChange={(next) => setFormData({ ...formData, comboSpecJson: next })}
                />

            {!isEquityMode(formData.tradeMode) && (
            <Row>
              {formData.tradeMode !== 'FUTURES' && !isEquityMode(formData.tradeMode) && (
                <Col md={3}>
                  <Form.Group className="mb-4">
                    <Form.Label className="flex items-center">Expiry Type <HelpIcon article={strategyDefinitionHelpContent['strategyDef.expiryType']} /></Form.Label>
                    <Form.Select
                      value={formData.expiryType}
                      onChange={(e) => setFormData({ ...formData, expiryType: e.target.value as ExpiryType })}
                    >
                      <option value="">Select Expiry Type...</option>
                      {expiryTypesForSelection().map((et) => (
                        <option key={et.value} value={et.value}>{et.label}</option>
                      ))}
                    </Form.Select>
                    {expiryTypesForSelection().length === 1 && (
                      <Form.Text className="text-ink-soft">
                        {underlyingSource === 'STOCKS'
                          ? 'Stock derivatives list monthly expiries only'
                          : `${formData.fnoSymbolName} lists ${expiryTypesForSelection()[0].label.toLowerCase()} expiries only`}
                      </Form.Text>
                    )}
                  </Form.Group>
                </Col>
              )}
            </Row>
            )}
            {hasOptionsLeg(formData.tradeMode) && (
            <Row>
              <Col md={4}>
                <Form.Group className="mb-4">
                  <Form.Label className="flex items-center">Underlying Type <HelpIcon article={strategyDefinitionHelpContent['strategyDef.underlyingType']} /></Form.Label>
                  <Form.Select
                    value={formData.underlyingType}
                    onChange={(e) => setFormData({ ...formData, underlyingType: e.target.value as UnderlyingType })}
                  >
                    {UNDERLYING_TYPES.map((ut) => (
                      <option key={ut.value} value={ut.value} title={ut.description}>{ut.label}</option>
                    ))}
                  </Form.Select>
                  <Form.Text className="text-ink-soft">Price type for strike selection</Form.Text>
                </Form.Group>
              </Col>
              {formData.expiryType === 'WEEKLY' && (
                <Col md={4}>
                  <Form.Group className="mb-4">
                    <Form.Check
                      type="switch"
                      id="excludeMonthlyExpiry-add"
                      label={<span className="flex items-center">Exclude Monthly Expiry Week <HelpIcon article={strategyDefinitionHelpContent['strategyDef.excludeMonthlyExpiry']} /></span>}
                      checked={formData.excludeMonthlyExpiry || false}
                      onChange={(e) => setFormData({ ...formData, excludeMonthlyExpiry: e.target.checked })}
                    />
                    <Form.Text className="text-ink-soft">
                      Skip trading when weekly expiry coincides with monthly expiry
                    </Form.Text>
                  </Form.Group>
                </Col>
              )}
            </Row>
            )}
            {hasOptionsLeg(formData.tradeMode) && (
            <Row>
              <Col md={4}>
                <Form.Group className="mb-4">
                  <Form.Check
                    type="switch"
                    id="usePremiumBalancing-add"
                    label={<span className="flex items-center">Premium Balanced Selection <HelpIcon article={strategyDefinitionHelpContent['strategyDef.usePremiumBalancing']} /></span>}
                    checked={formData.usePremiumBalancing ?? true}
                    onChange={(e) => setFormData({ ...formData, usePremiumBalancing: e.target.checked })}
                  />
                  <Form.Text className="text-ink-soft">
                    Use 3-step premium-balanced algorithm for strike selection. When off, uses simple ATM.
                  </Form.Text>
                </Form.Group>
              </Col>
            </Row>
            )}
            </div>

            {/* Section: Strategy Engine - derived from the sections around it; read-only. */}
            <div className="border rounded-md p-4 mb-4" style={{ borderColor: 'rgb(var(--c-hairline))' }}>
              <div className="text-ink-soft text-[0.875em] font-semibold mb-2" style={{ marginTop: '-1.5rem', background: 'rgb(var(--c-card))', width: 'fit-content', padding: '0 0.5rem' }}>
                Strategy Engine
              </div>
              <Row>
              <Col md={6}>
                {/* W4: template dropdown replaced — the engine derives from intent; only
                      custom-logic templates are selectable. Create modal. */}
                  {renderEngineField()}
              </Col>
              </Row>
            </div>
            {/* Section: Direction & Execution Order */}
            <div className="border rounded-md p-4 mb-4" style={{ borderColor: 'rgb(var(--c-hairline))' }}>
              <div className="text-ink-soft text-[0.875em] font-semibold mb-2" style={{ marginTop: '-1.5rem', background: 'rgb(var(--c-card))', width: 'fit-content', padding: '0 0.5rem' }}>
                Direction & Execution Order
              </div>
              <Row>
                <Col md={3}>
                  <Form.Group className="mb-0">
                    <Form.Check
                      type="switch"
                      label={<span className="flex items-center">Directional <HelpIcon article={strategyDefinitionHelpContent['strategyDef.isDirectional']} /></span>}
                      checked={formData.isDirectional}
                      disabled={formData.templateName === 'ADAPTIVE_OPTIONS' || Boolean(formData.comboSpecJson)}
                      onChange={(e) => setFormData({ ...formData, isDirectional: e.target.checked })}
                    />
                    {formData.templateName === 'ADAPTIVE_OPTIONS' && !formData.comboSpecJson && (
                      <Form.Text className="text-ink-soft">Required by Adaptive Options template.</Form.Text>
                    )}
                    {/* A combo takes a view, but its direction is declared PER LEG in the spec —
                        a long/short pair holds both directions at once, so this strategy-level
                        flag is meaningless for it and the engine ignores it. Disabled (not forced
                        on) so no dead provider config can be entered; server rejects it too. */}
                    {formData.comboSpecJson && (
                      <Form.Text className="text-ink-soft">
                        Combo: direction is fixed per leg by the combo spec. Direction providers for
                        combos are a planned later feature.
                      </Form.Text>
                    )}
                  </Form.Group>
                </Col>
              </Row>
            </div>
            {/* Direction Provider Configuration - shown when Directional is enabled */}
            {formData.isDirectional && (
              <div className="border rounded-md p-4 mb-4" style={{ borderColor: 'rgb(var(--c-hairline))' }}>
                <div className="text-ink-soft text-[0.875em] font-semibold mb-2" style={{ marginTop: '-1.5rem', background: 'rgb(var(--c-card))', width: 'fit-content', padding: '0 0.5rem' }}>
                  Direction Provider Configuration
                </div>
                <Row>
                  <Col md={4}>
                    <Form.Group className="mb-4">
                      <Form.Label className="flex items-center">Provider Type <HelpIcon article={strategyDefinitionHelpContent['strategyDef.directionProviderType']} /></Form.Label>
                      <Form.Select
                        value={formData.directionProviderType || ''}
                        disabled={formData.templateName === 'ADAPTIVE_OPTIONS'}
                        onChange={(e) => {
                          const newType = e.target.value as DirectionProviderType | '';
                          setFormData({
                            ...formData,
                            directionProviderType: newType || undefined,
                            directionProviderParams: newType ? {} : undefined,
                          });
                        }}
                      >
                        <option value="">Select Provider...</option>
                        {DIRECTION_PROVIDER_TYPES.map((p) => (
                          <option key={p.value} value={p.value}>{p.label}</option>
                        ))}
                      </Form.Select>
                      <Form.Text className="text-ink-soft">
                        {formData.templateName === 'ADAPTIVE_OPTIONS'
                          ? 'Locked to N_BARS_BREAKOUT for Adaptive Options template.'
                          : DIRECTION_PROVIDER_TYPES.find(p => p.value === formData.directionProviderType)?.description}
                      </Form.Text>
                    </Form.Group>
                  </Col>
                  {formData.directionProviderType && (
                  <Col md={4}>
                    <Form.Group className="mb-4">
                      <Form.Label>Applicable Direction</Form.Label>
                      <Form.Select
                        value={formData.directionProviderParams?.applicableDirection || 'BOTH'}
                        onChange={(e) => setFormData({
                          ...formData,
                          directionProviderParams: {
                            ...formData.directionProviderParams,
                            applicableDirection: e.target.value,
                          },
                        })}
                      >
                        <option value="BOTH">Both</option>
                        <option value="LONG">LONG only ({getDirectionLabels(formData.tradeMode).longAction})</option>
                        <option value="SHORT">SHORT only ({getDirectionLabels(formData.tradeMode).shortAction})</option>
                      </Form.Select>
                      <Form.Text className="text-ink-soft">
                        Restrict which side generates signals. Default Both — the disallowed side is skipped even when its rule triggers.
                      </Form.Text>
                    </Form.Group>
                  </Col>
                  )}
                </Row>

                {/* N_BARS_BREAKOUT provider params (shared by ADAPTIVE_OPTIONS template) */}
                {formData.directionProviderType === 'N_BARS_BREAKOUT' && (
                  <NBarsBreakoutParamsEditor
                    value={formData.directionProviderParams || {}}
                    tradeMode={formData.tradeMode}
                    disabled={editModalReadOnly}
                    onChange={(next) => setFormData({ ...formData, directionProviderParams: next })}
                  />
                )}

                {/* CANDLE provider specific fields */}
                {formData.directionProviderType === 'CANDLE' && (
                  <>
                    <Row>
                      <Col md={4}>
                        <Form.Group className="mb-4">
                          <Form.Label>Comparison Mode</Form.Label>
                          <Form.Select
                            value={formData.directionProviderParams?.comparisonMode || ''}
                            isInvalid={!!validationErrors.comparisonMode}
                            onChange={(e) => setFormData({
                              ...formData,
                              directionProviderParams: {
                                ...formData.directionProviderParams,
                                comparisonMode: e.target.value,
                              },
                            })}
                          >
                            <option value="" disabled>-- Select --</option>
                            {CANDLE_COMPARISON_MODES.map((m) => (
                              <option key={m.value} value={m.value}>{m.label}</option>
                            ))}
                          </Form.Select>
                          {validationErrors.comparisonMode
                            ? <Form.Control.Feedback type="invalid">{validationErrors.comparisonMode}</Form.Control.Feedback>
                            : <Form.Text className="text-ink-soft">
                                {CANDLE_COMPARISON_MODES.find(m => m.value === formData.directionProviderParams?.comparisonMode)?.description}
                              </Form.Text>}
                        </Form.Group>
                      </Col>
                      <Col md={4}>
                        <Form.Group className="mb-4">
                          <Form.Label>LONG when</Form.Label>
                          <Form.Select
                            value={formData.directionProviderParams?.longWhen || ''}
                            isInvalid={!!validationErrors.longWhen}
                            onChange={(e) => setFormData({
                              ...formData,
                              directionProviderParams: {
                                ...formData.directionProviderParams,
                                longWhen: e.target.value,
                              },
                            })}
                          >
                            <option value="" disabled>-- Select --</option>
                            <option value="GREATER">Price is Higher (Bullish)</option>
                            <option value="LESS">Price is Lower (Bearish)</option>
                          </Form.Select>
                          {validationErrors.longWhen
                            ? <Form.Control.Feedback type="invalid">{validationErrors.longWhen}</Form.Control.Feedback>
                            : <Form.Text className="text-ink-soft">
                                When should direction be LONG?
                              </Form.Text>}
                        </Form.Group>
                      </Col>
                    </Row>

                    {/* CMP_VS_REF mode: single reference */}
                    {formData.directionProviderParams?.comparisonMode === 'CMP_VS_REF' && (
                      <Row>
                        <Col md={2}>
                          <Form.Group className="mb-4">
                            <Form.Label>Reference Time</Form.Label>
                            <Form.Select
                              value={getRefTimeSelectValue(formData.directionProviderParams?.refTime)}
                              onChange={(e) => setFormData({
                                ...formData,
                                directionProviderParams: {
                                  ...formData.directionProviderParams,
                                  refTime: e.target.value === 'CUSTOM' ? '09:15:00' : e.target.value,
                                },
                              })}
                            >
                              <option value="" disabled>-- Select --</option>
                              {CANDLE_REFERENCE_TIMES.map((t) => (
                                <option key={t.value} value={t.value}>{t.label}</option>
                              ))}
                            </Form.Select>
                          </Form.Group>
                        </Col>
                        {(getRefTimeSelectValue(formData.directionProviderParams?.refTime) === 'CUSTOM' || isCustomTime(formData.directionProviderParams?.refTime)) && (
                          <Col md={2}>
                            <Form.Group className="mb-4">
                              <Form.Label>Time (HH:mm:ss)</Form.Label>
                              <Form.Control
                                type="text"
                                placeholder="09:15:00"
                                value={formData.directionProviderParams?.refTime || ''}
                                onChange={(e) => setFormData({
                                  ...formData,
                                  directionProviderParams: {
                                    ...formData.directionProviderParams,
                                    refTime: e.target.value,
                                  },
                                })}
                              />
                            </Form.Group>
                          </Col>
                        )}
                        <Col md={2}>
                          <Form.Group className="mb-4">
                            <Form.Label>Day Offset</Form.Label>
                            <Form.Select
                              value={getDayOffsetSelectValue(formData.directionProviderParams?.refDayOffset)}
                              isInvalid={!!validationErrors.refDayOffset}
                              onChange={(e) => setFormData({
                                ...formData,
                                directionProviderParams: {
                                  ...formData.directionProviderParams,
                                  refDayOffset: e.target.value === 'CUSTOM' ? '-5' : e.target.value,
                                },
                              })}
                            >
                              <option value="" disabled>-- Select --</option>
                              {DAY_OFFSETS.map((d) => (
                                <option key={d.value} value={d.value}>{d.label}</option>
                              ))}
                            </Form.Select>
                            {validationErrors.refDayOffset && <Form.Control.Feedback type="invalid">{validationErrors.refDayOffset}</Form.Control.Feedback>}
                          </Form.Group>
                        </Col>
                        {(getDayOffsetSelectValue(formData.directionProviderParams?.refDayOffset) === 'CUSTOM' || isCustomDayOffset(formData.directionProviderParams?.refDayOffset)) && (
                          <Col md={3}>
                            <Form.Group className="mb-4">
                              <Form.Label>Custom Offset</Form.Label>
                              <Form.Control
                                type="number"
                                max={0}
                                value={formData.directionProviderParams?.refDayOffset || ''}
                                onChange={(e) => {
                                  const val = parseInt(e.target.value) || 0;
                                  setFormData({
                                    ...formData,
                                    directionProviderParams: {
                                      ...formData.directionProviderParams,
                                      refDayOffset: String(Math.min(0, val)),
                                    },
                                  });
                                }}
                              />
                            </Form.Group>
                          </Col>
                        )}
                        {isCustomTime(formData.directionProviderParams?.refTime) && (
                          <Col md={2}>
                            <Form.Group className="mb-4">
                              <Form.Label>Price Type</Form.Label>
                              <Form.Select
                                value={formData.directionProviderParams?.refPriceType || ''}
                                isInvalid={!!validationErrors.refPriceType}
                                onChange={(e) => setFormData({
                                  ...formData,
                                  directionProviderParams: {
                                    ...formData.directionProviderParams,
                                    refPriceType: e.target.value,
                                  },
                                })}
                              >
                                <option value="" disabled>-- Select --</option>
                                {CANDLE_PRICE_TYPES.map((p) => (
                                  <option key={p.value} value={p.value}>{p.label}</option>
                                ))}
                              </Form.Select>
                              {validationErrors.refPriceType && <Form.Control.Feedback type="invalid">{validationErrors.refPriceType}</Form.Control.Feedback>}
                            </Form.Group>
                          </Col>
                        )}
                      </Row>
                    )}

                    {/* REF_VS_REF mode: two references */}
                    {formData.directionProviderParams?.comparisonMode === 'REF_VS_REF' && (
                      <>
                        <Row>
                          <Col md={12}><Form.Label className="font-bold">Reference 1 (compared against Reference 2)</Form.Label></Col>
                        </Row>
                        <Row>
                          <Col md={2}>
                            <Form.Group className="mb-4">
                              <Form.Label>Time</Form.Label>
                              <Form.Select
                                value={getRefTimeSelectValue(formData.directionProviderParams?.ref1Time)}
                                onChange={(e) => setFormData({
                                  ...formData,
                                  directionProviderParams: {
                                    ...formData.directionProviderParams,
                                    ref1Time: e.target.value === 'CUSTOM' ? '09:15:00' : e.target.value,
                                  },
                                })}
                              >
                                <option value="" disabled>-- Select --</option>
                                {CANDLE_REFERENCE_TIMES.map((t) => (
                                  <option key={t.value} value={t.value}>{t.label}</option>
                                ))}
                              </Form.Select>
                            </Form.Group>
                          </Col>
                          {(getRefTimeSelectValue(formData.directionProviderParams?.ref1Time) === 'CUSTOM' || isCustomTime(formData.directionProviderParams?.ref1Time)) && (
                            <Col md={2}>
                              <Form.Group className="mb-4">
                                <Form.Label>Time (HH:mm:ss)</Form.Label>
                                <Form.Control
                                  type="text"
                                  placeholder="09:15:00"
                                  value={formData.directionProviderParams?.ref1Time || ''}
                                  onChange={(e) => setFormData({
                                    ...formData,
                                    directionProviderParams: {
                                      ...formData.directionProviderParams,
                                      ref1Time: e.target.value,
                                    },
                                  })}
                                />
                              </Form.Group>
                            </Col>
                          )}
                          <Col md={2}>
                            <Form.Group className="mb-4">
                              <Form.Label>Day Offset</Form.Label>
                              <Form.Select
                                value={getDayOffsetSelectValue(formData.directionProviderParams?.ref1DayOffset)}
                                isInvalid={!!validationErrors.ref1DayOffset}
                                onChange={(e) => setFormData({
                                  ...formData,
                                  directionProviderParams: {
                                    ...formData.directionProviderParams,
                                    ref1DayOffset: e.target.value === 'CUSTOM' ? '-5' : e.target.value,
                                  },
                                })}
                              >
                                <option value="" disabled>-- Select --</option>
                                {DAY_OFFSETS.map((d) => (
                                  <option key={d.value} value={d.value}>{d.label}</option>
                                ))}
                              </Form.Select>
                              {validationErrors.ref1DayOffset && <Form.Control.Feedback type="invalid">{validationErrors.ref1DayOffset}</Form.Control.Feedback>}
                            </Form.Group>
                          </Col>
                          {(getDayOffsetSelectValue(formData.directionProviderParams?.ref1DayOffset) === 'CUSTOM' || isCustomDayOffset(formData.directionProviderParams?.ref1DayOffset)) && (
                            <Col md={3}>
                              <Form.Group className="mb-4">
                                <Form.Label>Custom Offset</Form.Label>
                                <Form.Control
                                  type="number"
                                  max={0}
                                  value={formData.directionProviderParams?.ref1DayOffset || ''}
                                  onChange={(e) => {
                                    const val = parseInt(e.target.value) || 0;
                                    setFormData({
                                      ...formData,
                                      directionProviderParams: {
                                        ...formData.directionProviderParams,
                                        ref1DayOffset: String(Math.min(0, val)),
                                      },
                                    });
                                  }}
                                />
                              </Form.Group>
                            </Col>
                          )}
                          {isCustomTime(formData.directionProviderParams?.ref1Time) && (
                            <Col md={2}>
                              <Form.Group className="mb-4">
                                <Form.Label>Price Type</Form.Label>
                                <Form.Select
                                  value={formData.directionProviderParams?.ref1PriceType || ''}
                                  isInvalid={!!validationErrors.ref1PriceType}
                                  onChange={(e) => setFormData({
                                    ...formData,
                                    directionProviderParams: {
                                      ...formData.directionProviderParams,
                                      ref1PriceType: e.target.value,
                                    },
                                  })}
                                >
                                  <option value="" disabled>-- Select --</option>
                                  {CANDLE_PRICE_TYPES.map((p) => (
                                    <option key={p.value} value={p.value}>{p.label}</option>
                                  ))}
                                </Form.Select>
                                {validationErrors.ref1PriceType && <Form.Control.Feedback type="invalid">{validationErrors.ref1PriceType}</Form.Control.Feedback>}
                              </Form.Group>
                            </Col>
                          )}
                        </Row>
                        <Row>
                          <Col md={12}><Form.Label className="font-bold">Reference 2</Form.Label></Col>
                        </Row>
                        <Row>
                          <Col md={2}>
                            <Form.Group className="mb-4">
                              <Form.Label>Time</Form.Label>
                              <Form.Select
                                value={getRefTimeSelectValue(formData.directionProviderParams?.ref2Time)}
                                onChange={(e) => setFormData({
                                  ...formData,
                                  directionProviderParams: {
                                    ...formData.directionProviderParams,
                                    ref2Time: e.target.value === 'CUSTOM' ? '15:30:00' : e.target.value,
                                  },
                                })}
                              >
                                <option value="" disabled>-- Select --</option>
                                {CANDLE_REFERENCE_TIMES.map((t) => (
                                  <option key={t.value} value={t.value}>{t.label}</option>
                                ))}
                              </Form.Select>
                            </Form.Group>
                          </Col>
                          {(getRefTimeSelectValue(formData.directionProviderParams?.ref2Time) === 'CUSTOM' || isCustomTime(formData.directionProviderParams?.ref2Time)) && (
                            <Col md={2}>
                              <Form.Group className="mb-4">
                                <Form.Label>Time (HH:mm:ss)</Form.Label>
                                <Form.Control
                                  type="text"
                                  placeholder="15:30:00"
                                  value={formData.directionProviderParams?.ref2Time || ''}
                                  onChange={(e) => setFormData({
                                    ...formData,
                                    directionProviderParams: {
                                      ...formData.directionProviderParams,
                                      ref2Time: e.target.value,
                                    },
                                  })}
                                />
                              </Form.Group>
                            </Col>
                          )}
                          <Col md={2}>
                            <Form.Group className="mb-4">
                              <Form.Label>Day Offset</Form.Label>
                              <Form.Select
                                value={getDayOffsetSelectValue(formData.directionProviderParams?.ref2DayOffset)}
                                isInvalid={!!validationErrors.ref2DayOffset}
                                onChange={(e) => setFormData({
                                  ...formData,
                                  directionProviderParams: {
                                    ...formData.directionProviderParams,
                                    ref2DayOffset: e.target.value === 'CUSTOM' ? '-5' : e.target.value,
                                  },
                                })}
                              >
                                <option value="" disabled>-- Select --</option>
                                {DAY_OFFSETS.map((d) => (
                                  <option key={d.value} value={d.value}>{d.label}</option>
                                ))}
                              </Form.Select>
                              {validationErrors.ref2DayOffset && <Form.Control.Feedback type="invalid">{validationErrors.ref2DayOffset}</Form.Control.Feedback>}
                            </Form.Group>
                          </Col>
                          {(getDayOffsetSelectValue(formData.directionProviderParams?.ref2DayOffset) === 'CUSTOM' || isCustomDayOffset(formData.directionProviderParams?.ref2DayOffset)) && (
                            <Col md={3}>
                              <Form.Group className="mb-4">
                                <Form.Label>Custom Offset</Form.Label>
                                <Form.Control
                                  type="number"
                                  max={0}
                                  value={formData.directionProviderParams?.ref2DayOffset || ''}
                                  onChange={(e) => {
                                    const val = parseInt(e.target.value) || 0;
                                    setFormData({
                                      ...formData,
                                      directionProviderParams: {
                                        ...formData.directionProviderParams,
                                        ref2DayOffset: String(Math.min(0, val)),
                                      },
                                    });
                                  }}
                                />
                              </Form.Group>
                            </Col>
                          )}
                          {isCustomTime(formData.directionProviderParams?.ref2Time) && (
                            <Col md={2}>
                              <Form.Group className="mb-4">
                                <Form.Label>Price Type</Form.Label>
                                <Form.Select
                                  value={formData.directionProviderParams?.ref2PriceType || ''}
                                  isInvalid={!!validationErrors.ref2PriceType}
                                  onChange={(e) => setFormData({
                                    ...formData,
                                    directionProviderParams: {
                                      ...formData.directionProviderParams,
                                      ref2PriceType: e.target.value,
                                    },
                                  })}
                                >
                                  <option value="" disabled>-- Select --</option>
                                  {CANDLE_PRICE_TYPES.map((p) => (
                                    <option key={p.value} value={p.value}>{p.label}</option>
                                  ))}
                                </Form.Select>
                                {validationErrors.ref2PriceType && <Form.Control.Feedback type="invalid">{validationErrors.ref2PriceType}</Form.Control.Feedback>}
                              </Form.Group>
                            </Col>
                          )}
                        </Row>
                      </>
                    )}

                    {/* Direction Summary */}
                    {getCandleDirectionSummary(formData.directionProviderParams as Record<string, string>) && (
                      <Row className="mt-2">
                        <Col md={12}>
                          <div className="p-4 bg-raised rounded-md border">
                            <div className="font-bold mb-2">Direction Logic Summary:</div>
                            <div className="flex gap-6">
                              <div>
                                <span className="inline-block rounded-md px-[.55em] py-[.35em] text-center text-[.75em] font-semibold leading-none whitespace-nowrap text-white bg-success-500 me-2">LONG</span>
                                <span className="text-ink-soft">({getDirectionLabels(formData.tradeMode).longAction})</span>
                                <div className="mt-1 text-[0.875em]">
                                  {getCandleDirectionSummary(formData.directionProviderParams as Record<string, string>)?.longDesc}
                                </div>
                              </div>
                              <div>
                                <span className="inline-block rounded-md px-[.55em] py-[.35em] text-center text-[.75em] font-semibold leading-none whitespace-nowrap text-white bg-danger-600 me-2">SHORT</span>
                                <span className="text-ink-soft">({getDirectionLabels(formData.tradeMode).shortAction})</span>
                                <div className="mt-1 text-[0.875em]">
                                  {getCandleDirectionSummary(formData.directionProviderParams as Record<string, string>)?.shortDesc}
                                </div>
                              </div>
                            </div>
                          </div>
                        </Col>
                      </Row>
                    )}

                    <Row className="mt-4">
                      <Col md={3}>
                        <Form.Group className="mb-4">
                          <Form.Label>Cache Minutes</Form.Label>
                          <Form.Control
                            type="number"
                            value={formData.directionProviderParams?.cacheMinutes ?? '60'}
                            onChange={(e) => setFormData({
                              ...formData,
                              directionProviderParams: {
                                ...formData.directionProviderParams,
                                cacheMinutes: e.target.value,
                              },
                            })}
                          />
                          <Form.Text className="text-ink-soft">How long to cache the direction</Form.Text>
                        </Form.Group>
                      </Col>
                    </Row>
                  </>
                )}

                {/* FIXED provider specific fields */}
                {formData.directionProviderType === 'FIXED' && (
                  <>
                    <Row>
                      <Col md={4}>
                        <Form.Group className="mb-4">
                          <Form.Label>Fixed Direction</Form.Label>
                          <Form.Select
                            value={formData.directionProviderParams?.direction || 'LONG'}
                            onChange={(e) => setFormData({
                              ...formData,
                              directionProviderParams: {
                                ...formData.directionProviderParams,
                                direction: e.target.value,
                              },
                            })}
                          >
                            <option value="LONG">LONG ({getDirectionLabels(formData.tradeMode).longAction})</option>
                            <option value="SHORT">SHORT ({getDirectionLabels(formData.tradeMode).shortAction})</option>
                          </Form.Select>
                        </Form.Group>
                      </Col>
                    </Row>
                    <Row className="mt-2">
                      <Col md={12}>
                        <div className="p-4 bg-raised rounded-md border">
                          <div className="font-bold mb-2">Direction Logic Summary:</div>
                          <div className="flex gap-6">
                            <div>
                              <span className={`inline-block rounded-md px-[.55em] py-[.35em] text-center text-[.75em] font-semibold leading-none whitespace-nowrap text-white bg-ink-soft ${formData.directionProviderParams?.direction === 'SHORT' ? 'bg-danger-600' : 'bg-success-500'} me-2`}>
                                {formData.directionProviderParams?.direction || 'LONG'}
                              </span>
                              <span className="text-ink-soft">
                                ({formData.directionProviderParams?.direction === 'SHORT' ? getDirectionLabels(formData.tradeMode).shortAction : getDirectionLabels(formData.tradeMode).longAction})
                              </span>
                              <div className="mt-1 text-[0.875em]">
                                Always use {formData.directionProviderParams?.direction || 'LONG'} direction regardless of market conditions
                              </div>
                            </div>
                          </div>
                        </div>
                      </Col>
                    </Row>
                  </>
                )}

                {/* PCR provider specific fields */}
                {formData.directionProviderType === 'PCR' && (
                  <>
                    <Row>
                      <Col md={3}>
                        <Form.Group className="mb-4">
                          <Form.Label>Comparison Mode</Form.Label>
                          <Form.Select
                            value={formData.directionProviderParams?.comparisonMode || 'THRESHOLD'}
                            onChange={(e) => setFormData({
                              ...formData,
                              directionProviderParams: {
                                ...formData.directionProviderParams,
                                comparisonMode: e.target.value,
                              },
                            })}
                          >
                            <option value="THRESHOLD">Threshold (PCR vs value)</option>
                            <option value="TREND">Trend (PCR now vs N min ago)</option>
                          </Form.Select>
                        </Form.Group>
                      </Col>
                      {(!formData.directionProviderParams?.comparisonMode || formData.directionProviderParams?.comparisonMode === 'THRESHOLD') && (
                        <Col md={3}>
                          <Form.Group className="mb-4">
                            <Form.Label>PCR Threshold</Form.Label>
                            <Form.Control
                              type="number"
                              step="0.1"
                              value={formData.directionProviderParams?.threshold || '1.0'}
                              onChange={(e) => setFormData({
                                ...formData,
                                directionProviderParams: {
                                  ...formData.directionProviderParams,
                                  threshold: e.target.value,
                                },
                              })}
                            />
                          </Form.Group>
                        </Col>
                      )}
                      {formData.directionProviderParams?.comparisonMode === 'TREND' && (
                        <>
                          <Col md={3}>
                            <Form.Group className="mb-4">
                              <Form.Label>Lookback Minutes</Form.Label>
                              <Form.Control
                                type="number"
                                min="1"
                                max="120"
                                value={formData.directionProviderParams?.lookbackMinutes || '15'}
                                onChange={(e) => setFormData({
                                  ...formData,
                                  directionProviderParams: {
                                    ...formData.directionProviderParams,
                                    lookbackMinutes: e.target.value,
                                  },
                                })}
                              />
                            </Form.Group>
                          </Col>
                          <Col md={3}>
                            <Form.Group className="mb-4">
                              <Form.Label>LONG When</Form.Label>
                              <Form.Select
                                value={formData.directionProviderParams?.longWhen || 'INCREASING'}
                                onChange={(e) => setFormData({
                                  ...formData,
                                  directionProviderParams: {
                                    ...formData.directionProviderParams,
                                    longWhen: e.target.value,
                                  },
                                })}
                              >
                                <option value="INCREASING">PCR Rising (Bullish)</option>
                                <option value="DECREASING">PCR Falling (Bearish)</option>
                              </Form.Select>
                            </Form.Group>
                          </Col>
                        </>
                      )}
                    </Row>
                    <Row className="mt-2">
                      <Col md={12}>
                        <div className="p-4 bg-raised rounded-md border">
                          <div className="font-bold mb-2">Direction Logic Summary:</div>
                          <div className="text-[0.875em] text-ink-soft mb-2">PCR = Put OI / Call OI. High PCR = More puts = Bullish sentiment</div>
                          {(!formData.directionProviderParams?.comparisonMode || formData.directionProviderParams?.comparisonMode === 'THRESHOLD') && (
                            <div className="flex gap-6">
                              <div>
                                <span className="inline-block rounded-md px-[.55em] py-[.35em] text-center text-[.75em] font-semibold leading-none whitespace-nowrap text-white bg-success-500 me-2">LONG</span>
                                <span className="text-ink-soft">({getDirectionLabels(formData.tradeMode).longAction})</span>
                                <div className="mt-1 text-[0.875em]">
                                  PCR ≥ {formData.directionProviderParams?.threshold || '1.0'} (More puts than calls = Bullish)
                                </div>
                              </div>
                              <div>
                                <span className="inline-block rounded-md px-[.55em] py-[.35em] text-center text-[.75em] font-semibold leading-none whitespace-nowrap text-white bg-danger-600 me-2">SHORT</span>
                                <span className="text-ink-soft">({getDirectionLabels(formData.tradeMode).shortAction})</span>
                                <div className="mt-1 text-[0.875em]">
                                  PCR &lt; {formData.directionProviderParams?.threshold || '1.0'} (More calls than puts = Bearish)
                                </div>
                              </div>
                            </div>
                          )}
                          {formData.directionProviderParams?.comparisonMode === 'TREND' && (
                            <div className="flex gap-6">
                              <div>
                                <span className="inline-block rounded-md px-[.55em] py-[.35em] text-center text-[.75em] font-semibold leading-none whitespace-nowrap text-white bg-success-500 me-2">LONG</span>
                                <span className="text-ink-soft">({getDirectionLabels(formData.tradeMode).longAction})</span>
                                <div className="mt-1 text-[0.875em]">
                                  {(formData.directionProviderParams?.longWhen || 'INCREASING') === 'INCREASING'
                                    ? <>Current PCR &gt; PCR from {formData.directionProviderParams?.lookbackMinutes || '15'} min ago (PCR rising = Bullish)</>
                                    : <>Current PCR &lt; PCR from {formData.directionProviderParams?.lookbackMinutes || '15'} min ago (PCR falling)</>
                                  }
                                </div>
                              </div>
                              <div>
                                <span className="inline-block rounded-md px-[.55em] py-[.35em] text-center text-[.75em] font-semibold leading-none whitespace-nowrap text-white bg-danger-600 me-2">SHORT</span>
                                <span className="text-ink-soft">({getDirectionLabels(formData.tradeMode).shortAction})</span>
                                <div className="mt-1 text-[0.875em]">
                                  {(formData.directionProviderParams?.longWhen || 'INCREASING') === 'INCREASING'
                                    ? <>Current PCR ≤ PCR from {formData.directionProviderParams?.lookbackMinutes || '15'} min ago (PCR falling = Bearish)</>
                                    : <>Current PCR ≥ PCR from {formData.directionProviderParams?.lookbackMinutes || '15'} min ago (PCR rising)</>
                                  }
                                </div>
                              </div>
                            </div>
                          )}
                        </div>
                      </Col>
                    </Row>
                  </>
                )}

                {/* IV_SKEW provider specific fields */}
                {formData.directionProviderType === 'IV_SKEW' && (
                  <>
                    <Row>
                      <Col md={3}>
                        <Form.Group className="mb-4">
                          <Form.Label>Default Direction</Form.Label>
                          <Form.Select
                            value={formData.directionProviderParams?.defaultDirection || 'LONG'}
                            onChange={(e) => setFormData({
                              ...formData,
                              directionProviderParams: {
                                ...formData.directionProviderParams,
                                defaultDirection: e.target.value,
                              },
                            })}
                          >
                            <option value="LONG">LONG</option>
                            <option value="SHORT">SHORT</option>
                          </Form.Select>
                        </Form.Group>
                      </Col>
                    </Row>
                    <Row className="mt-2">
                      <Col md={12}>
                        <div className="p-4 bg-raised rounded-md border">
                          <div className="font-bold mb-2">Direction Logic Summary:</div>
                          <div className="text-[0.875em] text-ink-soft mb-2">Higher IV = Higher expected move. Market prices in expected direction.</div>
                          <div className="flex gap-6">
                            <div>
                              <span className="inline-block rounded-md px-[.55em] py-[.35em] text-center text-[.75em] font-semibold leading-none whitespace-nowrap text-white bg-success-500 me-2">LONG</span>
                              <span className="text-ink-soft">({getDirectionLabels(formData.tradeMode).longAction})</span>
                              <div className="mt-1 text-[0.875em]">
                                CE IV &lt; PE IV → {getDirectionLabels(formData.tradeMode).longAction}
                              </div>
                            </div>
                            <div>
                              <span className="inline-block rounded-md px-[.55em] py-[.35em] text-center text-[.75em] font-semibold leading-none whitespace-nowrap text-white bg-danger-600 me-2">SHORT</span>
                              <span className="text-ink-soft">({getDirectionLabels(formData.tradeMode).shortAction})</span>
                              <div className="mt-1 text-[0.875em]">
                                CE IV &gt; PE IV → {getDirectionLabels(formData.tradeMode).shortAction}
                              </div>
                            </div>
                            <div>
                              <span className="inline-block rounded-md px-[.55em] py-[.35em] text-center text-[.75em] font-semibold leading-none whitespace-nowrap text-white bg-ink-soft me-2">{formData.directionProviderParams?.defaultDirection || 'LONG'}</span>
                              <span className="text-ink-soft">(Default)</span>
                              <div className="mt-1 text-[0.875em]">
                                CE IV = PE IV (No skew, use default)
                              </div>
                            </div>
                          </div>
                        </div>
                      </Col>
                    </Row>
                  </>
                )}

                {/* INDICATOR provider - show direction rules editor */}
                {formData.directionProviderType === 'INDICATOR' && formData.templateName !== 'INDICATOR_ADVANCED_OPTIONS' && (
                  <div className="mt-4 border rounded-md p-4" style={{ borderColor: '#17a2b8' }}>
                    <div className="text-accent-600 dark:text-accent-400 text-[0.875em] font-semibold mb-2" style={{ marginTop: '-1.5rem', background: 'rgb(var(--c-card))', width: 'fit-content', padding: '0 0.5rem' }}>
                      Indicator Direction Rules
                    </div>
                    <DirectionRulesOnlyEditor
                      ruleSet={indicatorRules}
                      onChange={setIndicatorRules}
                      tradeMode={formData.tradeMode}
                    />
                  </div>
                )}

              </div>
            )}

                {/* Leg ordering — applies to hedged option entries and to combos alike. Blank
                    keeps the long-standing default, which differs by shape, so it is resolved in
                    the engine rather than pre-filled here. */}
                <Row>
                  <Col md={4}>
                    <Form.Group className="mb-4">
                      <Form.Label className="flex items-center">Entry Leg Order <HelpIcon article={strategyDefinitionHelpContent['strategyDef.entryLegOrder']} /></Form.Label>
                      <Form.Select
                        value={formData.entryLegOrder ?? ''}
                        disabled={editModalReadOnly}
                        onChange={(e) => setFormData({
                          ...formData,
                          entryLegOrder: (e.target.value || undefined) as typeof formData.entryLegOrder,
                        })}
                      >
                        <option value="">Default (protection first; derivative first for combos)</option>
                        <option value="PROTECTION_FIRST">PROTECTION_FIRST — hedge buy before the sold leg</option>
                        <option value="EXPOSURE_FIRST">EXPOSURE_FIRST — sold leg first, hedge after</option>
                        <option value="DERIVATIVE_FIRST">DERIVATIVE_FIRST — future/option before cash</option>
                        <option value="CASH_FIRST">CASH_FIRST — cash before future/option</option>
                      </Form.Select>
                      <Form.Text className="text-ink-soft">
                        Which leg goes on the book first. Protection-first keeps a sold option from
                        ever being naked; derivative-first puts the uncertain fill on while the book
                        is still flat.
                      </Form.Text>
                    </Form.Group>
                  </Col>
                  <Col md={4}>
                    <Form.Group className="mb-4">
                      <Form.Label className="flex items-center">Exit Leg Order <HelpIcon article={strategyDefinitionHelpContent['strategyDef.exitLegOrder']} /></Form.Label>
                      <Form.Select
                        value={formData.exitLegOrder ?? ''}
                        disabled={editModalReadOnly}
                        onChange={(e) => setFormData({
                          ...formData,
                          exitLegOrder: (e.target.value || undefined) as typeof formData.exitLegOrder,
                        })}
                      >
                        <option value="">Default (reverse of entry)</option>
                        <option value="REVERSE_ENTRY">REVERSE_ENTRY — last on, first off</option>
                        <option value="SAME_AS_ENTRY">SAME_AS_ENTRY — first on, first off</option>
                        <option value="PROTECTION_LAST">PROTECTION_LAST — hedge legs exit last</option>
                      </Form.Select>
                      <Form.Text className="text-ink-soft">
                        Reverse-entry is right when one leg protects another. For a long/short pair
                        prefer SAME_AS_ENTRY, so the illiquid leg is not left behind.
                      </Form.Text>
                    </Form.Group>
                  </Col>
                </Row>

            {/* Indicator Rules Section - only for INDICATOR_ADVANCED_OPTIONS template */}
            {formData.templateName === 'INDICATOR_ADVANCED_OPTIONS' && (
              <div className="border rounded-md p-4 mb-4" style={{ borderColor: 'rgb(var(--c-hairline))' }}>
                <div className="text-ink-soft text-[0.875em] font-semibold mb-2" style={{ marginTop: '-1.5rem', background: 'rgb(var(--c-card))', width: 'fit-content', padding: '0 0.5rem' }}>
                  Indicator Rules
                </div>

                <SimplifiedRuleSetEditor
                  ruleSet={indicatorRules}
                  onChange={setIndicatorRules}
                  isDirectional={formData.isDirectional ?? false}
                  tradeMode={formData.tradeMode}
                />
              </div>
            )}
            {/* Trigger Types */}
            <div className="border rounded-md p-4 mb-4" style={{ borderColor: 'rgb(var(--c-hairline))' }}>
              <div className="text-ink-soft text-[0.875em] font-semibold mb-2" style={{ marginTop: '-1.5rem', background: 'rgb(var(--c-card))', width: 'fit-content', padding: '0 0.5rem' }}>
                Trigger Types <span className="text-danger-600 dark:text-danger-400">*</span>
              </div>
              <Row>
              <Col md={12}>
                <Form.Group className="mb-4">
                  <div className="flex flex-wrap gap-6">
                    <Form.Check
                      type="checkbox"
                      id="tickTriggerEnabled"
                      label={<span className="flex items-center">Tick Trigger <HelpIcon article={strategyDefinitionHelpContent['strategyDef.tickTriggerEnabled']} /></span>}
                      checked={formData.tickTriggerEnabled}
                      onChange={(e) => setFormData({ ...formData, tickTriggerEnabled: e.target.checked })}
                    />
                    <Form.Check
                      type="checkbox"
                      id="scheduledTriggerEnabled"
                      label={<span className="flex items-center">Scheduled Trigger <HelpIcon article={strategyDefinitionHelpContent['strategyDef.scheduledTriggerEnabled']} /></span>}
                      checked={formData.scheduledTriggerEnabled}
                      onChange={(e) => setFormData({ ...formData, scheduledTriggerEnabled: e.target.checked })}
                    />
                    <Form.Check
                      type="checkbox"
                      id="signalTriggerEnabled"
                      label={<span className="flex items-center">Signal Trigger <HelpIcon article={strategyDefinitionHelpContent['strategyDef.signalTriggerEnabled']} /></span>}
                      checked={formData.signalTriggerEnabled}
                      onChange={(e) => setFormData({ ...formData, signalTriggerEnabled: e.target.checked })}
                    />
                    <Form.Check
                      type="checkbox"
                      id="periodicTriggerEnabled"
                      label={<span className="flex items-center">Periodic Trigger <HelpIcon article={strategyDefinitionHelpContent['strategyDef.periodicTriggerEnabled']} /></span>}
                      checked={formData.periodicTriggerEnabled}
                      disabled={formData.templateName === 'ADAPTIVE_OPTIONS' || formData.templateName === 'ZERODT_OPTIONS'}
                      onChange={(e) => setFormData({
                        ...formData,
                        periodicTriggerEnabled: e.target.checked,
                      })}
                    />
                  </div>
                  {validationErrors.trigger ? (
                    <div className="text-danger-600 dark:text-danger-400 text-[0.875em] mt-1">{validationErrors.trigger}</div>
                  ) : (
                    <Form.Text className="text-ink-soft">
                      {formData.templateName === 'ADAPTIVE_OPTIONS'
                        ? 'Periodic Trigger required for Adaptive Options — drives the candle-close heartbeat that detects breakouts.'
                        : formData.templateName === 'ZERODT_OPTIONS'
                        ? 'Periodic Trigger required for ZeroDT Options — drives the stuck-state recovery heartbeat between tranches.'
                        : 'Select at least one trigger type for the strategy'}
                    </Form.Text>
                  )}
                </Form.Group>
              </Col>
            </Row>
            {/* Periodic Settings - show when periodic trigger is enabled */}
            {formData.periodicTriggerEnabled && (
              <Row>
                <Col md={6}>
                  <Form.Group className="mb-4">
                    <Form.Label className="flex items-center">Periodic Interval (minutes) <HelpIcon article={strategyDefinitionHelpContent['strategyDef.periodicIntervalMinutes']} /></Form.Label>
                    <Form.Control
                      type="number"
                      min={1}
                      max={240}
                      placeholder="e.g., 5"
                      value={formData.periodicIntervalMinutes ?? ''}
                      onChange={(e) => setFormData({ ...formData, periodicIntervalMinutes: e.target.value ? parseInt(e.target.value) : undefined })}
                    />
                    <Form.Text className="text-ink-soft">1-240 minutes, clock-aligned</Form.Text>
                  </Form.Group>
                </Col>
                <Col md={6}>
                  <Form.Group className="mb-4">
                    <Form.Label className="flex items-center">Periodic Offset (seconds) <HelpIcon article={strategyDefinitionHelpContent['strategyDef.periodicOffsetSeconds']} /></Form.Label>
                    <Form.Control
                      type="number"
                      min={0}
                      max={15}
                      placeholder="0"
                      value={formData.periodicOffsetSeconds ?? ''}
                      onChange={(e) => setFormData({ ...formData, periodicOffsetSeconds: e.target.value ? parseInt(e.target.value) : undefined })}
                    />
                    <Form.Text className="text-ink-soft">0-15s delay for candle data availability</Form.Text>
                  </Form.Group>
                </Col>
              </Row>
            )}
            </div>

            {/* Timing */}
            <div className="border rounded-md p-4 mb-4" style={{ borderColor: 'rgb(var(--c-hairline))' }}>
              <div className="text-ink-soft text-[0.875em] font-semibold mb-2" style={{ marginTop: '-1.5rem', background: 'rgb(var(--c-card))', width: 'fit-content', padding: '0 0.5rem' }}>
                Timing
              </div>
              <Row>
              <Col md={6}>
                <Form.Group className="mb-4">
                  <Form.Label className="flex items-center">Start Time <span className="text-danger-600 dark:text-danger-400">*</span> <HelpIcon article={strategyDefinitionHelpContent['strategyDef.startTime']} /></Form.Label>
                  <Form.Control
                    type="text"
                    placeholder="HH:mm:ss"
                    value={formData.startTime}
                    onChange={(e) => setFormData({ ...formData, startTime: e.target.value })}
                    required
                    isInvalid={!!validationErrors.startTime}
                  />
                  {validationErrors.startTime && <Form.Control.Feedback type="invalid">{validationErrors.startTime}</Form.Control.Feedback>}
                </Form.Group>
              </Col>
              <Col md={4}>
                <Form.Group className="mb-4">
                  <Form.Label className="flex items-center">Stop Time <span className="text-danger-600 dark:text-danger-400">*</span> <HelpIcon article={strategyDefinitionHelpContent['strategyDef.stopTime']} /></Form.Label>
                  <Form.Control
                    type="text"
                    placeholder="HH:mm:ss"
                    value={formData.stopTime}
                    onChange={(e) => setFormData({ ...formData, stopTime: e.target.value })}
                    required
                    isInvalid={!!validationErrors.stopTime}
                  />
                  {validationErrors.stopTime && <Form.Control.Feedback type="invalid">{validationErrors.stopTime}</Form.Control.Feedback>}
                </Form.Group>
              </Col>
            </Row>
            <Row>
              <Col md={12}>
                <Form.Group className="mb-4">
                  <Form.Label className="flex items-center">Tradable Days <HelpIcon article={strategyDefinitionHelpContent['strategyDef.tradableDays']} /></Form.Label>
                  <div className="flex flex-wrap gap-2">
                    {TRADABLE_DAYS.map((day) => (
                      <Form.Check
                        key={day.value}
                        type="checkbox"
                        id={`tradable-day-${day.value}`}
                        label={day.label}
                        checked={selectedDays.includes(day.value)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedDays([...selectedDays, day.value]);
                          } else {
                            setSelectedDays(selectedDays.filter(d => d !== day.value));
                          }
                        }}
                        className={day.group === 'expiry' ? 'text-warning-700 dark:text-warning-400' : ''}
                      />
                    ))}
                  </div>
                  <Form.Text className="text-ink-soft">Leave all unchecked to allow trading on all days</Form.Text>
                </Form.Group>
              </Col>
            </Row>
            <Row>
              <Col md={12}>
                <Form.Group className="mb-4">
                  <Form.Label className="flex items-center">Excluded Days <Badge bg="danger" className="ms-2">Blacklist</Badge> <HelpIcon article={strategyDefinitionHelpContent['strategyDef.excludedDays']} /></Form.Label>
                  <div className="flex flex-wrap gap-2">
                    {TRADABLE_DAYS.map((day) => (
                      <Form.Check
                        key={`excluded-${day.value}`}
                        type="checkbox"
                        id={`excluded-day-${day.value}`}
                        label={day.label}
                        checked={selectedExcludedDays.includes(day.value)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedExcludedDays([...selectedExcludedDays, day.value]);
                          } else {
                            setSelectedExcludedDays(selectedExcludedDays.filter(d => d !== day.value));
                          }
                        }}
                        className={day.group === 'expiry' ? 'text-warning-700 dark:text-warning-400' : ''}
                      />
                    ))}
                  </div>
                  <Form.Text className="text-ink-soft">Days to exclude from trading (takes precedence over tradable days)</Form.Text>
                </Form.Group>
              </Col>
            </Row>
            </div>

            {/* Capital & Hedge (FnO only) */}
            {!isEquityMode(formData.tradeMode) && (
            <div className="border rounded-md p-4 mb-4" style={{ borderColor: 'rgb(var(--c-hairline))' }}>
              <div className="text-ink-soft text-[0.875em] font-semibold mb-2" style={{ marginTop: '-1.5rem', background: 'rgb(var(--c-card))', width: 'fit-content', padding: '0 0.5rem' }}>
                Capital & Hedge
              </div>
              <Row>
              <Col md={4}>
                <Form.Group className="mb-4">
                  <Form.Label className="flex items-center">Capital Per Lot (Default) <span className="text-danger-600 dark:text-danger-400">*</span> <HelpIcon article={strategyDefinitionHelpContent['strategyDef.capitalPerLot']} /></Form.Label>
                  <Form.Control
                    type="number"
                    value={formData.capitalPerLot ?? ''}
                    onChange={(e) => setFormData({ ...formData, capitalPerLot: e.target.value ? parseInt(e.target.value) : undefined })}
                    required
                    isInvalid={!!validationErrors.capitalPerLot}
                  />
                  {validationErrors.capitalPerLot ? <Form.Control.Feedback type="invalid">{validationErrors.capitalPerLot}</Form.Control.Feedback> : <Form.Text className="text-ink-soft">Fallback value</Form.Text>}
                                  {underlyingSource === 'STOCKS' && !isEquityMode(formData.tradeMode) && (
                    <Form.Text className="text-ink-soft">
                      Watchlist strategy: set this ≈ the highest per-lot margin among the member stocks
                      (stock futures margins mostly run ₹1–3L per lot) — cheaper members just leave headroom idle.
                      Each member is sized from capital ÷ Max Active Positions.
                    </Form.Text>
                  )}
                </Form.Group>
              </Col>
              <Col md={4}>
                <Form.Group className="mb-4">
                  <Form.Label className="flex items-center">Capital Per Lot (Hedged) <HelpIcon article={strategyDefinitionHelpContent['strategyDef.capitalPerLotHedged']} /></Form.Label>
                  <Form.Control
                    type="number"
                    value={formData.capitalPerLotHedged}
                    onChange={(e) => setFormData({ ...formData, capitalPerLotHedged: parseInt(e.target.value) || 0 })}
                  />
                  <Form.Text className="text-ink-soft">When hedge is enabled</Form.Text>
                </Form.Group>
              </Col>
              <Col md={4}>
                <Form.Group className="mb-4">
                  <Form.Label className="flex items-center">Capital Per Lot (Naked) <HelpIcon article={strategyDefinitionHelpContent['strategyDef.capitalPerLotNaked']} /></Form.Label>
                  <Form.Control
                    type="number"
                    value={formData.capitalPerLotNaked}
                    onChange={(e) => setFormData({ ...formData, capitalPerLotNaked: parseInt(e.target.value) || 0 })}
                  />
                  <Form.Text className="text-ink-soft">When hedge is disabled</Form.Text>
                </Form.Group>
              </Col>
            </Row>
            {formData.product === 'POSITIONAL' && supportsHedging(formData.tradeMode) && (
            <Row>
              <Col md={6}>
                <Form.Group className="mb-4">
                  <Form.Check
                    type="switch"
                    label={<span className="flex items-center">Hedge Replace Enabled <HelpIcon article={strategyDefinitionHelpContent['strategyDef.hedgeReplaceEnabled']} /></span>}
                    checked={formData.hedgeReplaceEnabled}
                    onChange={(e) => setFormData({ ...formData, hedgeReplaceEnabled: e.target.checked })}
                  />
                  <Form.Text className="text-ink-soft">Enable automatic hedge replacement windows (morning/evening)</Form.Text>
                </Form.Group>
              </Col>
            </Row>
            )}
            {supportsHedging(formData.tradeMode) && (
            <Row>
              <Col md={6}>
                <Form.Group className="mb-4">
                  <Form.Label className="flex items-center">
                    {formData.product === 'POSITIONAL' && formData.hedgeReplaceEnabled ? 'Hedge % (Intraday)' : 'Hedge Distance'}
                    {(formData.product === 'INTRADAY' || formData.product === 'POSITIONAL') && <span className="text-danger-600 dark:text-danger-400"> *</span>}
                    {' '}<HelpIcon article={strategyDefinitionHelpContent[
                      formData.product === 'POSITIONAL' && formData.hedgeReplaceEnabled
                        ? 'strategyDef.hedgeDistancePercentageIntraday'
                        : 'strategyDef.hedgeDistancePercentage'
                    ]} />
                  </Form.Label>
                  <Form.Control
                    type="number"
                    step="0.01"
                    value={formData.hedgeDistancePercentageIntraday ?? ''}
                    onChange={(e) => setFormData({ ...formData, hedgeDistancePercentageIntraday: e.target.value ? parseFloat(e.target.value) : undefined })}
                    required={formData.product === 'INTRADAY' || formData.product === 'POSITIONAL'}
                    isInvalid={!!validationErrors.hedgeDistancePercentageIntraday}
                  />
                  {validationErrors.hedgeDistancePercentageIntraday && <Form.Control.Feedback type="invalid">{validationErrors.hedgeDistancePercentageIntraday}</Form.Control.Feedback>}
                </Form.Group>
              </Col>
              {formData.product === 'POSITIONAL' && formData.hedgeReplaceEnabled && (
              <Col md={6}>
                <Form.Group className="mb-4">
                  <Form.Label className="flex items-center">
                    Hedge % (Positional)
                    <span className="text-danger-600 dark:text-danger-400"> *</span>
                    {' '}<HelpIcon article={strategyDefinitionHelpContent['strategyDef.hedgeDistancePercentagePositional']} />
                  </Form.Label>
                  <Form.Control
                    type="number"
                    step="0.01"
                    value={formData.hedgeDistancePercentagePositional ?? ''}
                    onChange={(e) => setFormData({ ...formData, hedgeDistancePercentagePositional: e.target.value ? parseFloat(e.target.value) : undefined })}
                    required
                    isInvalid={!!validationErrors.hedgeDistancePercentagePositional}
                  />
                  {validationErrors.hedgeDistancePercentagePositional && <Form.Control.Feedback type="invalid">{validationErrors.hedgeDistancePercentagePositional}</Form.Control.Feedback>}
                </Form.Group>
              </Col>
              )}
            </Row>
            )}
            </div>
            )}

            {/* Risk Allocation Settings */}
            <div className="border rounded-md p-4 mb-4" style={{ borderColor: 'rgb(var(--c-hairline))' }}>
              <div className="text-ink-soft text-[0.875em] font-semibold mb-2" style={{ marginTop: '-1.5rem', background: 'rgb(var(--c-card))', width: 'fit-content', padding: '0 0.5rem' }}>
                Risk Allocation Settings
              </div>
              <Row>
                <Col md={3}>
                  <Form.Group className="mb-4">
                    <Form.Label className="flex items-center">Risk % of Capital <HelpIcon article={strategyDefinitionHelpContent['strategyDef.riskPercentage']} /></Form.Label>
                    <Form.Control
                      type="number"
                      step="0.1"
                      min={0}
                      max={100}
                      placeholder="e.g., 1.5 for 1.5%"
                      value={formData.riskPercentage ?? ''}
                      onChange={(e) => setFormData({ ...formData, riskPercentage: e.target.value ? parseFloat(e.target.value) : undefined })}
                    />
                    <Form.Text className="text-ink-soft">Default risk % per day for lot allocation</Form.Text>
                  </Form.Group>
                </Col>
                <Col md={3}>
                  <Form.Group className="mb-4">
                    <Form.Label className="flex items-center">Absolute Max Risk (₹) <HelpIcon article={strategyDefinitionHelpContent['strategyDef.absoluteMaxRisk']} /></Form.Label>
                    <Form.Control
                      type="number"
                      min={0}
                      placeholder="e.g., 15000"
                      value={formData.absoluteMaxRisk ?? ''}
                      onChange={(e) => setFormData({ ...formData, absoluteMaxRisk: e.target.value ? parseFloat(e.target.value) : undefined })}
                    />
                    <Form.Text className="text-ink-soft">Alternative: absolute max risk amount</Form.Text>
                  </Form.Group>
                </Col>
                <Col md={3}>
                  <Form.Group className="mb-4">
                    <Form.Label className="flex items-center">Min Risk % <HelpIcon article={strategyDefinitionHelpContent['strategyDef.minRiskPercentage']} /></Form.Label>
                    <Form.Control
                      type="number"
                      step="0.1"
                      min={0}
                      max={100}
                      placeholder="e.g., 0.5"
                      value={formData.minRiskPercentage ?? ''}
                      onChange={(e) => setFormData({ ...formData, minRiskPercentage: e.target.value ? parseFloat(e.target.value) : undefined })}
                    />
                    <Form.Text className="text-ink-soft">Floor for user override</Form.Text>
                  </Form.Group>
                </Col>
                <Col md={3}>
                  <Form.Group className="mb-4">
                    <Form.Label className="flex items-center">Max Risk % <HelpIcon article={strategyDefinitionHelpContent['strategyDef.maxRiskPercentage']} /></Form.Label>
                    <Form.Control
                      type="number"
                      step="0.1"
                      min={0}
                      max={100}
                      placeholder="e.g., 5.0"
                      value={formData.maxRiskPercentage ?? ''}
                      onChange={(e) => setFormData({ ...formData, maxRiskPercentage: e.target.value ? parseFloat(e.target.value) : undefined })}
                    />
                    <Form.Text className="text-ink-soft">Ceiling for user override</Form.Text>
                  </Form.Group>
                </Col>
              </Row>
              <Row>
                <Col md={3}>
                  <Form.Group className="mb-0">
                    <Form.Check
                      type="switch"
                      label={<span className="flex items-center">Overlap Capital <HelpIcon article={strategyDefinitionHelpContent['strategyDef.isOverlapCapital']} /></span>}
                      checked={formData.isOverlapCapital}
                      onChange={(e) => setFormData({ ...formData, isOverlapCapital: e.target.checked })}
                    />
                  </Form.Group>
                </Col>
              </Row>
            </div>

            {/* Equity Sizing & Leverage — replaces Capital & Hedge for equity strategies */}
            {isEquityMode(formData.tradeMode) && (
            <div className="border rounded-md p-4 mb-4" style={{ borderColor: 'rgb(var(--c-hairline))' }}>
              <div className="text-ink-soft text-[0.875em] font-semibold mb-2" style={{ marginTop: '-1.5rem', background: 'rgb(var(--c-card))', width: 'fit-content', padding: '0 0.5rem' }}>
                Equity Sizing &amp; Leverage
              </div>
              <Row>
                <Col md={4}>
                  <Form.Group className="mb-4">
                    <Form.Label className="flex items-center">Leverage <HelpIcon article={strategyDefinitionHelpContent['strategyDef.leverage']} /></Form.Label>
                    <Form.Control
                      type="number"
                      step="0.5"
                      min={1}
                      placeholder="1 (no leverage)"
                      value={formData.leverage ?? ''}
                      onChange={(e) => setFormData({ ...formData, leverage: e.target.value ? parseFloat(e.target.value) : undefined })}
                      isInvalid={!!validationErrors.leverage}
                    />
                    {validationErrors.leverage
                      ? <Form.Control.Feedback type="invalid">{validationErrors.leverage}</Form.Control.Feedback>
                      : <Form.Text className="text-ink-soft">{formData.product === 'CASHBUY' ? 'Cash Buy (CNC) always runs at 1× regardless of this value' : 'Buying power = capital × leverage'}</Form.Text>}
                  </Form.Group>
                </Col>
                <Col md={4}>
                  <Form.Group className="mb-4">
                    <Form.Label className="flex items-center">Min Leverage <HelpIcon article={strategyDefinitionHelpContent['strategyDef.minLeverage']} /></Form.Label>
                    <Form.Control
                      type="number"
                      step="0.5"
                      min={1}
                      value={formData.minLeverage ?? ''}
                      onChange={(e) => setFormData({ ...formData, minLeverage: e.target.value ? parseFloat(e.target.value) : undefined })}
                      isInvalid={!!validationErrors.minLeverage}
                    />
                    {validationErrors.minLeverage
                      ? <Form.Control.Feedback type="invalid">{validationErrors.minLeverage}</Form.Control.Feedback>
                      : <Form.Text className="text-ink-soft">Floor for user override</Form.Text>}
                  </Form.Group>
                </Col>
                <Col md={4}>
                  <Form.Group className="mb-4">
                    <Form.Label className="flex items-center">Max Leverage <HelpIcon article={strategyDefinitionHelpContent['strategyDef.maxLeverage']} /></Form.Label>
                    <Form.Control
                      type="number"
                      step="0.5"
                      min={1}
                      value={formData.maxLeverage ?? ''}
                      onChange={(e) => setFormData({ ...formData, maxLeverage: e.target.value ? parseFloat(e.target.value) : undefined })}
                    />
                    <Form.Text className="text-ink-soft">Ceiling for user override</Form.Text>
                  </Form.Group>
                </Col>
              </Row>
              <Row>
                <Col md={6}>
                  <Form.Group className="mb-4">
                    <Form.Label className="flex items-center">Sizing Model <HelpIcon article={strategyDefinitionHelpContent['strategyDef.equitySizingModel']} /></Form.Label>
                    <Form.Select
                      value={formData.equitySizingModel ?? ''}
                      onChange={(e) => setFormData({ ...formData, equitySizingModel: (e.target.value || undefined) as EquitySizingModel | undefined })}
                    >
                      <option value="">Select Sizing Model...</option>
                      {EQUITY_SIZING_MODELS.map((m) => (
                        <option key={m.value} value={m.value} title={m.description}>{m.label}</option>
                      ))}
                    </Form.Select>
                    <Form.Text className="text-ink-soft">
                      {EQUITY_SIZING_MODELS.find((m) => m.value === formData.equitySizingModel)?.description || 'How the per-stock quantity is computed'}
                    </Form.Text>
                  </Form.Group>
                </Col>
                {formData.equitySizingModel === 'FIXED_AMOUNT_PER_STOCK' && (
                  <Col md={6}>
                    <Form.Group className="mb-4">
                      <Form.Label className="flex items-center">Fixed Amount Per Stock (₹) <span className="text-danger-600 dark:text-danger-400">*</span> <HelpIcon article={strategyDefinitionHelpContent['strategyDef.fixedAmountPerStock']} /></Form.Label>
                      <Form.Control
                        type="number"
                        min={0}
                        value={formData.fixedAmountPerStock ?? ''}
                        onChange={(e) => setFormData({ ...formData, fixedAmountPerStock: e.target.value ? parseFloat(e.target.value) : undefined })}
                        isInvalid={!!validationErrors.fixedAmountPerStock}
                      />
                      {validationErrors.fixedAmountPerStock && <Form.Control.Feedback type="invalid">{validationErrors.fixedAmountPerStock}</Form.Control.Feedback>}
                    </Form.Group>
                  </Col>
                )}
                {formData.equitySizingModel === 'MAX_POSITIONS_EQUAL_SPLIT' && (
                  <Col md={6}>
                    <Form.Group className="mb-4">
                      <Form.Label className="flex items-center">Max Active Positions <span className="text-danger-600 dark:text-danger-400">*</span> <HelpIcon article={strategyDefinitionHelpContent['strategyDef.maxActivePositions']} /></Form.Label>
                      <Form.Control
                        type="number"
                        min={1}
                        value={formData.maxActivePositions ?? ''}
                        onChange={(e) => setFormData({ ...formData, maxActivePositions: e.target.value ? parseInt(e.target.value) : undefined })}
                        isInvalid={!!validationErrors.maxActivePositions}
                      />
                      {validationErrors.maxActivePositions
                        ? <Form.Control.Feedback type="invalid">{validationErrors.maxActivePositions}</Form.Control.Feedback>
                        : <Form.Text className="text-ink-soft">Buying power is split equally across this many slots</Form.Text>}
                    </Form.Group>
                  </Col>
                )}
                {formData.equitySizingModel === 'MAX_RISK_PER_TRADE' && (
                  <Col md={6}>
                    <Form.Group className="mb-4">
                      <Form.Label className="flex items-center">Max Risk % Per Trade <span className="text-danger-600 dark:text-danger-400">*</span> <HelpIcon article={strategyDefinitionHelpContent['strategyDef.maxRiskPctPerTrade']} /></Form.Label>
                      <Form.Control
                        type="number"
                        step="0.1"
                        min={0}
                        max={100}
                        placeholder="e.g., 1 for 1%"
                        value={formData.maxRiskPctPerTrade ?? ''}
                        onChange={(e) => setFormData({ ...formData, maxRiskPctPerTrade: e.target.value ? parseFloat(e.target.value) : undefined })}
                        isInvalid={!!validationErrors.maxRiskPctPerTrade}
                      />
                      {validationErrors.maxRiskPctPerTrade
                        ? <Form.Control.Feedback type="invalid">{validationErrors.maxRiskPctPerTrade}</Form.Control.Feedback>
                        : <Form.Text className="text-ink-soft">Quantity = risk budget / stop distance, capped by buying power</Form.Text>}
                    </Form.Group>
                  </Col>
                )}
              </Row>

            </div>
            )}

            {/* Section: Lifecycle */}
            <div className="border rounded-md p-4 mb-4" style={{ borderColor: 'rgb(var(--c-hairline))' }}>
              <div className="text-ink-soft text-[0.875em] font-semibold mb-2" style={{ marginTop: '-1.5rem', background: 'rgb(var(--c-card))', width: 'fit-content', padding: '0 0.5rem' }}>
                Lifecycle
              </div>
              <Row>
              <Col md={6}>
                <Form.Group className="mb-4">
                  <Form.Check
                    type="switch"
                    label={<span className="flex items-center">Catch Up Missed Tranches <HelpIcon article={strategyDefinitionHelpContent['strategyDef.catchUpMissedTranches']} /></span>}
                    checked={formData.catchUpMissedTranches}
                    onChange={(e) => setFormData({ ...formData, catchUpMissedTranches: e.target.checked })}
                  />
                  <Form.Text className="text-ink-soft">When reactivated, schedule missed tranches with 1-min gaps</Form.Text>
                </Form.Group>
              </Col>
              <Col md={6}>
                <Form.Group className="mb-4">
                  <Form.Check
                    type="switch"
                    label={<span className="flex items-center">Adaptive Tranches Enabled <HelpIcon article={strategyDefinitionHelpContent['strategyDef.adaptiveTranchesEnabled']} /></span>}
                    checked={formData.adaptiveTranchesEnabled}
                    disabled={formData.templateName === 'ADAPTIVE_OPTIONS' || formData.templateName === 'ZERODT_OPTIONS'}
                    onChange={(e) => setFormData({ ...formData, adaptiveTranchesEnabled: e.target.checked })}
                  />
                  <Form.Text className="text-ink-soft">
                    {formData.templateName === 'ADAPTIVE_OPTIONS'
                      ? 'Required for Adaptive Options — drives re-entry / signal-flip recovery via TranchCompleteEvent.'
                      : formData.templateName === 'ZERODT_OPTIONS'
                      ? 'Required for ZeroDT Options — drives adaptive tranch advancement (loss/profit/max-tranches caps) via TranchCompleteEvent.'
                      : 'Tranch 2+ triggered when previous tranch exits'}
                  </Form.Text>
                </Form.Group>
              </Col>
            </Row>
              {isEquityMode(formData.tradeMode) && (
              <Row>
                <Col md={6}>
                  <Form.Group className="mb-4">
                    <Form.Label className="flex items-center">On Index Removal <HelpIcon article={strategyDefinitionHelpContent['strategyDef.onIndexRemoval']} /></Form.Label>
                    <Form.Select
                      value={formData.onIndexRemoval ?? ''}
                      onChange={(e) => setFormData({ ...formData, onIndexRemoval: (e.target.value || undefined) as OnIndexRemoval | undefined })}
                    >
                      <option value="">Default (Hold Until Exit)</option>
                      {ON_INDEX_REMOVAL_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value} title={o.description}>{o.label}</option>
                      ))}
                    </Form.Select>
                    <Form.Text className="text-ink-soft">Open-position policy when a stock drops out of a predefined index universe</Form.Text>
                  </Form.Group>
                </Col>
              </Row>
              )}
            </div>
            {/* Hedge Replace - only for POSITIONAL options (not FUTURES) */}
            {formData.product === 'POSITIONAL' && supportsHedging(formData.tradeMode) && (
              <div className="border rounded-md p-4 mb-4" style={{ borderColor: 'rgb(var(--c-hairline))' }}>
                <div className="text-ink-soft text-[0.875em] font-semibold mb-2" style={{ marginTop: '-1.5rem', background: 'rgb(var(--c-card))', width: 'fit-content', padding: '0 0.5rem' }}>
                  Hedge Replace Settings
                </div>
                {formData.hedgeReplaceEnabled && (
                  <Row>
                    <Col md={3}>
                      <Form.Group className="mb-0">
                        <Form.Label className="flex items-center">Morning Start (min after open) <HelpIcon article={strategyDefinitionHelpContent['strategyDef.hedgeMorningStartOffset']} /></Form.Label>
                        <Form.Control
                          type="number"
                          min={0}
                          max={60}
                          placeholder="1 (default)"
                          value={formData.hedgeMorningStartOffset ?? ''}
                          onChange={(e) => setFormData({ ...formData, hedgeMorningStartOffset: e.target.value ? parseInt(e.target.value) : undefined })}
                        />
                      </Form.Group>
                    </Col>
                    <Col md={3}>
                      <Form.Group className="mb-0">
                        <Form.Label className="flex items-center">Morning End (min after open) <HelpIcon article={strategyDefinitionHelpContent['strategyDef.hedgeMorningEndOffset']} /></Form.Label>
                        <Form.Control
                          type="number"
                          min={0}
                          max={60}
                          placeholder="15 (default)"
                          value={formData.hedgeMorningEndOffset ?? ''}
                          onChange={(e) => setFormData({ ...formData, hedgeMorningEndOffset: e.target.value ? parseInt(e.target.value) : undefined })}
                        />
                      </Form.Group>
                    </Col>
                    <Col md={3}>
                      <Form.Group className="mb-0">
                        <Form.Label className="flex items-center">Evening Start (min before close) <HelpIcon article={strategyDefinitionHelpContent['strategyDef.hedgeEveningStartOffset']} /></Form.Label>
                        <Form.Control
                          type="number"
                          min={0}
                          max={60}
                          placeholder="10 (default)"
                          value={formData.hedgeEveningStartOffset ?? ''}
                          onChange={(e) => setFormData({ ...formData, hedgeEveningStartOffset: e.target.value ? parseInt(e.target.value) : undefined })}
                        />
                      </Form.Group>
                    </Col>
                    <Col md={3}>
                      <Form.Group className="mb-0">
                        <Form.Label className="flex items-center">Evening End (min before close) <HelpIcon article={strategyDefinitionHelpContent['strategyDef.hedgeEveningEndOffset']} /></Form.Label>
                        <Form.Control
                          type="number"
                          min={0}
                          max={60}
                          placeholder="2 (default)"
                          value={formData.hedgeEveningEndOffset ?? ''}
                          onChange={(e) => setFormData({ ...formData, hedgeEveningEndOffset: e.target.value ? parseInt(e.target.value) : undefined })}
                        />
                      </Form.Group>
                    </Col>
                  </Row>
                )}
              </div>
            )}

            {/* Section: Visibility & Admin */}
            <div className="border rounded-md p-4 mb-4" style={{ borderColor: 'rgb(var(--c-hairline))' }}>
              <div className="text-ink-soft text-[0.875em] font-semibold mb-2" style={{ marginTop: '-1.5rem', background: 'rgb(var(--c-card))', width: 'fit-content', padding: '0 0.5rem' }}>
                Visibility & Admin
              </div>
              <Row>
                <Col md={3}>
                  <Form.Group className="mb-0">
                    <Form.Check
                      type="switch"
                      label={<span className="flex items-center"><BsGlobe className="me-1" />Public <HelpIcon article={strategyDefinitionHelpContent['strategyDef.isPublic']} /></span>}
                      checked={formData.isPublic}
                      onChange={(e) => setFormData({ ...formData, isPublic: e.target.checked })}
                    />
                    <Form.Text className="text-ink-soft">Visible to all users</Form.Text>
                  </Form.Group>
                </Col>
                <Col md={3}>
                  <Form.Group className="mb-0">
                    <Form.Label className="flex items-center">Scope <HelpIcon article={strategyDefinitionHelpContent['strategyDef.scope']} /></Form.Label>
                    <Form.Select
                      value={formData.scope || 'SYSTEM'}
                      onChange={(e) => setFormData({ ...formData, scope: e.target.value as 'SYSTEM' | 'USER' })}
                    >
                      <option value="SYSTEM">SYSTEM</option>
                      <option value="USER">USER</option>
                    </Form.Select>
                    <Form.Text className="text-ink-soft">
                      SYSTEM: Admin-assigned only. USER: Self-subscribe allowed
                    </Form.Text>
                  </Form.Group>
                </Col>
                <Col md={3}>
                  <Form.Group className="mb-0">
                    <Form.Check
                      type="switch"
                      label={<span className="flex items-center">Mock Strategy</span>}
                      checked={!!formData.isMock}
                      onChange={(e) => {
                        const isMock = e.target.checked;
                        // Mock sessions are always intraday — auto-set
                        // product when the toggle goes on. The Product
                        // dropdown is then disabled while isMock=true.
                        setFormData({
                          ...formData,
                          isMock,
                          product: isMock ? 'INTRADAY' : formData.product,
                        });
                      }}
                    />
                    <Form.Text className="text-ink-soft">Runs only during admin-toggled mock sessions</Form.Text>
                  </Form.Group>
                </Col>
              <Col md={3}>
                <Form.Group className="mb-4">
                  <Form.Label className="flex items-center">Display Order <HelpIcon article={strategyDefinitionHelpContent['strategyDef.displayOrder']} /></Form.Label>
                  <Form.Control
                    type="number"
                    value={formData.displayOrder}
                    onChange={(e) => setFormData({ ...formData, displayOrder: parseInt(e.target.value) || 0 })}
                  />
                </Form.Group>
              </Col>
              </Row>
            </div>

          </Modal.Body>
          <Modal.Footer>
            <Button variant="secondary" onClick={handleCloseAddModal}>Cancel</Button>
            <Button variant="primary" type="submit" disabled={createMutation.isPending || !isFormValid()}>
              {createMutation.isPending ? <><Spinner size="sm" className="me-2" />Creating...</> : 'Create'}
            </Button>
          </Modal.Footer>
        </Form>
      </Modal>

      {/* View/Edit Modal */}
      <Modal show={showEditModal} onHide={handleCloseEditModal} size="xl" backdrop={editModalReadOnly ? true : 'static'}>
        <Modal.Header closeButton>
          <Modal.Title>
            {editModalReadOnly ? <BsEye className="me-2" /> : <BsPencil className="me-2" />}
            {editModalReadOnly ? 'View' : 'Edit'} Strategy Definition
          </Modal.Title>
        </Modal.Header>
        <Form onSubmit={handleUpdate}>
          <Modal.Body>
          <fieldset disabled={editModalReadOnly}>
            {/* Basic Info */}
            <div className="border rounded-md p-4 mb-4" style={{ borderColor: 'rgb(var(--c-hairline))' }}>
              <div className="text-ink-soft text-[0.875em] font-semibold mb-2" style={{ marginTop: '-1.5rem', background: 'rgb(var(--c-card))', width: 'fit-content', padding: '0 0.5rem' }}>
                Basic Information
              </div>
              <Row>
              <Col md={6}>
                <Form.Group className="mb-4">
                  <Form.Label className="flex items-center">Strategy Name <HelpIcon article={strategyDefinitionHelpContent['strategyDef.strategyName']} /></Form.Label>
                  <Form.Control type="text" value={selectedDefinition?.strategyName || ''} disabled />
                </Form.Group>
              </Col>
              <Col md={6}>
                <Form.Group className="mb-4">
                  <Form.Label className="flex items-center">Display Name <HelpIcon article={strategyDefinitionHelpContent['strategyDef.displayName']} /></Form.Label>
                  <Form.Control
                    type="text"
                    placeholder="e.g., Nifty Momentum Intraday"
                    value={formData.displayName}
                    onChange={(e) => setFormData({ ...formData, displayName: e.target.value })}
                  />
                </Form.Group>
              </Col>
            </Row>


            </div>

            {/* Section: What It Trades - Trade Mode first: it reshapes everything below. */}
            <div className="border rounded-md p-4 mb-4" style={{ borderColor: 'rgb(var(--c-hairline))' }}>
              <div className="text-ink-soft text-[0.875em] font-semibold mb-2" style={{ marginTop: '-1.5rem', background: 'rgb(var(--c-card))', width: 'fit-content', padding: '0 0.5rem' }}>
                What It Trades
              </div>
              <Row>
              <Col md={3}>
                {renderTradeModeField()}
              </Col>
              </Row>
              <Row>
              <Col md={6}>
                {renderUnderlyingsField(false, 'edit')}
              </Col>
              <Col md={3}>
                <Form.Group className="mb-4">
                  <Form.Label className="flex items-center">Exchange <HelpIcon article={strategyDefinitionHelpContent['strategyDef.exchange']} /></Form.Label>
                  <Form.Select
                    value={formData.exchange}
                    onChange={(e) => setFormData({ ...formData, exchange: e.target.value })}
                    disabled
                  >
                    {EXCHANGES.map((ex) => (
                      <option key={ex} value={ex}>{ex}</option>
                    ))}
                  </Form.Select>
                </Form.Group>
              </Col>
              {/* A combo declares product PER LEG in the editor below; the strategy-level
                  value is derived from the legs and the field is hidden. */}
              {!comboShapeType && (
              <Col md={3}>
                <Form.Group className="mb-4">
                  <Form.Label className="flex items-center">Product Type <HelpIcon article={strategyDefinitionHelpContent['strategyDef.product']} /></Form.Label>
                  <Form.Select
                    value={formData.product}
                    onChange={(e) => setFormData({ ...formData, product: e.target.value as Product })}
                    disabled={!!formData.isMock}
                  >
                    <option value="">Select Product Type...</option>
                    {productsForTradeMode(formData.tradeMode).map((p) => (
                      <option key={p.value} value={p.value}>{p.label}</option>
                    ))}
                    {/* Keep a legacy value visible/selectable if it no longer fits the trade mode */}
                    {formData.product && !productsForTradeMode(formData.tradeMode).some((p) => p.value === formData.product) && (
                      <option value={formData.product}>{PRODUCTS.find((p) => p.value === formData.product)?.label || formData.product}</option>
                    )}
                  </Form.Select>
                  {formData.isMock && (
                    <Form.Text className="text-ink-soft">
                      Locked to INTRADAY for mock-trading strategies.
                    </Form.Text>
                  )}
                </Form.Group>
              </Col>
              )}

            </Row>
                {/* Multi-leg combo shape — absent for a normal strategy (see ComboSpecEditor) */}
                <ComboSpecEditor
                  value={formData.comboSpecJson}
                  disabled={editModalReadOnly}
                  onChange={(next) => setFormData({ ...formData, comboSpecJson: next })}
                />

            {!isEquityMode(formData.tradeMode) && (
            <Row>
              {formData.tradeMode !== 'FUTURES' && !isEquityMode(formData.tradeMode) && (
                <Col md={3}>
                  <Form.Group className="mb-4">
                    <Form.Label className="flex items-center">Expiry Type <HelpIcon article={strategyDefinitionHelpContent['strategyDef.expiryType']} /></Form.Label>
                    <Form.Select
                      value={formData.expiryType}
                      onChange={(e) => setFormData({ ...formData, expiryType: e.target.value as ExpiryType })}
                    >
                      <option value="">Select Expiry Type...</option>
                      {expiryTypesForSelection().map((et) => (
                        <option key={et.value} value={et.value}>{et.label}</option>
                      ))}
                    </Form.Select>
                    {expiryTypesForSelection().length === 1 && (
                      <Form.Text className="text-ink-soft">
                        {underlyingSource === 'STOCKS'
                          ? 'Stock derivatives list monthly expiries only'
                          : `${formData.fnoSymbolName} lists ${expiryTypesForSelection()[0].label.toLowerCase()} expiries only`}
                      </Form.Text>
                    )}
                  </Form.Group>
                </Col>
              )}
            </Row>
            )}
            {hasOptionsLeg(formData.tradeMode) && (
            <Row>
              <Col md={4}>
                <Form.Group className="mb-4">
                  <Form.Label className="flex items-center">Underlying Type <HelpIcon article={strategyDefinitionHelpContent['strategyDef.underlyingType']} /></Form.Label>
                  <Form.Select
                    value={formData.underlyingType}
                    onChange={(e) => setFormData({ ...formData, underlyingType: e.target.value as UnderlyingType })}
                  >
                    {UNDERLYING_TYPES.map((ut) => (
                      <option key={ut.value} value={ut.value} title={ut.description}>{ut.label}</option>
                    ))}
                  </Form.Select>
                  <Form.Text className="text-ink-soft">Price type for strike selection</Form.Text>
                </Form.Group>
              </Col>
              {formData.expiryType === 'WEEKLY' && (
                <Col md={4}>
                  <Form.Group className="mb-4">
                    <Form.Check
                      type="switch"
                      id="excludeMonthlyExpiry-edit"
                      label={<span className="flex items-center">Exclude Monthly Expiry Week <HelpIcon article={strategyDefinitionHelpContent['strategyDef.excludeMonthlyExpiry']} /></span>}
                      checked={formData.excludeMonthlyExpiry || false}
                      onChange={(e) => setFormData({ ...formData, excludeMonthlyExpiry: e.target.checked })}
                    />
                    <Form.Text className="text-ink-soft">
                      Skip trading when weekly expiry coincides with monthly expiry
                    </Form.Text>
                  </Form.Group>
                </Col>
              )}
            </Row>
            )}
            {hasOptionsLeg(formData.tradeMode) && (
            <Row>
              <Col md={4}>
                <Form.Group className="mb-4">
                  <Form.Check
                    type="switch"
                    id="usePremiumBalancing-edit"
                    label={<span className="flex items-center">Premium Balanced Selection <HelpIcon article={strategyDefinitionHelpContent['strategyDef.usePremiumBalancing']} /></span>}
                    checked={formData.usePremiumBalancing ?? true}
                    onChange={(e) => setFormData({ ...formData, usePremiumBalancing: e.target.checked })}
                  />
                  <Form.Text className="text-ink-soft">
                    Use 3-step premium-balanced algorithm for strike selection. When off, uses simple ATM.
                  </Form.Text>
                </Form.Group>
              </Col>
            </Row>
            )}
            </div>

            {/* Section: Strategy Engine - derived from the sections around it; read-only. */}
            <div className="border rounded-md p-4 mb-4" style={{ borderColor: 'rgb(var(--c-hairline))' }}>
              <div className="text-ink-soft text-[0.875em] font-semibold mb-2" style={{ marginTop: '-1.5rem', background: 'rgb(var(--c-card))', width: 'fit-content', padding: '0 0.5rem' }}>
                Strategy Engine
              </div>
              <Row>
              <Col md={6}>
                {/* W4: template dropdown replaced — the engine derives from intent; only
                      custom-logic templates are selectable. Edit modal. */}
                  {renderEngineField()}
              </Col>
              </Row>
            </div>
            {/* Section: Direction & Execution Order */}
            <div className="border rounded-md p-4 mb-4" style={{ borderColor: 'rgb(var(--c-hairline))' }}>
              <div className="text-ink-soft text-[0.875em] font-semibold mb-2" style={{ marginTop: '-1.5rem', background: 'rgb(var(--c-card))', width: 'fit-content', padding: '0 0.5rem' }}>
                Direction & Execution Order
              </div>
              <Row>
                <Col md={3}>
                  <Form.Group className="mb-0">
                    <Form.Check
                      type="switch"
                      label={<span className="flex items-center">Directional <HelpIcon article={strategyDefinitionHelpContent['strategyDef.isDirectional']} /></span>}
                      checked={formData.isDirectional}
                      disabled={formData.templateName === 'ADAPTIVE_OPTIONS' || Boolean(formData.comboSpecJson)}
                      onChange={(e) => setFormData({ ...formData, isDirectional: e.target.checked })}
                    />
                    {formData.templateName === 'ADAPTIVE_OPTIONS' && !formData.comboSpecJson && (
                      <Form.Text className="text-ink-soft">Required by Adaptive Options template.</Form.Text>
                    )}
                    {/* A combo takes a view, but its direction is declared PER LEG in the spec —
                        a long/short pair holds both directions at once, so this strategy-level
                        flag is meaningless for it and the engine ignores it. Disabled (not forced
                        on) so no dead provider config can be entered; server rejects it too. */}
                    {formData.comboSpecJson && (
                      <Form.Text className="text-ink-soft">
                        Combo: direction is fixed per leg by the combo spec. Direction providers for
                        combos are a planned later feature.
                      </Form.Text>
                    )}
                  </Form.Group>
                </Col>
              </Row>
            </div>
            {/* Direction Provider Configuration - shown when Directional is enabled */}
            {formData.isDirectional && (
              <div className="border rounded-md p-4 mb-4" style={{ borderColor: 'rgb(var(--c-hairline))' }}>
                <div className="text-ink-soft text-[0.875em] font-semibold mb-2" style={{ marginTop: '-1.5rem', background: 'rgb(var(--c-card))', width: 'fit-content', padding: '0 0.5rem' }}>
                  Direction Provider Configuration
                </div>
                <Row>
                  <Col md={4}>
                    <Form.Group className="mb-4">
                      <Form.Label className="flex items-center">Provider Type <HelpIcon article={strategyDefinitionHelpContent['strategyDef.directionProviderType']} /></Form.Label>
                      <Form.Select
                        value={formData.directionProviderType || ''}
                        disabled={formData.templateName === 'ADAPTIVE_OPTIONS'}
                        onChange={(e) => {
                          const newType = e.target.value as DirectionProviderType | '';
                          setFormData({
                            ...formData,
                            directionProviderType: newType || undefined,
                            directionProviderParams: newType ? {} : undefined,
                          });
                        }}
                      >
                        <option value="">Select Provider...</option>
                        {DIRECTION_PROVIDER_TYPES.map((p) => (
                          <option key={p.value} value={p.value}>{p.label}</option>
                        ))}
                      </Form.Select>
                      <Form.Text className="text-ink-soft">
                        {formData.templateName === 'ADAPTIVE_OPTIONS'
                          ? 'Locked to N_BARS_BREAKOUT for Adaptive Options template.'
                          : DIRECTION_PROVIDER_TYPES.find(p => p.value === formData.directionProviderType)?.description}
                      </Form.Text>
                    </Form.Group>
                  </Col>
                  {formData.directionProviderType && (
                  <Col md={4}>
                    <Form.Group className="mb-4">
                      <Form.Label>Applicable Direction</Form.Label>
                      <Form.Select
                        value={formData.directionProviderParams?.applicableDirection || 'BOTH'}
                        onChange={(e) => setFormData({
                          ...formData,
                          directionProviderParams: {
                            ...formData.directionProviderParams,
                            applicableDirection: e.target.value,
                          },
                        })}
                      >
                        <option value="BOTH">Both</option>
                        <option value="LONG">LONG only ({getDirectionLabels(formData.tradeMode).longAction})</option>
                        <option value="SHORT">SHORT only ({getDirectionLabels(formData.tradeMode).shortAction})</option>
                      </Form.Select>
                      <Form.Text className="text-ink-soft">
                        Restrict which side generates signals. Default Both — the disallowed side is skipped even when its rule triggers.
                      </Form.Text>
                    </Form.Group>
                  </Col>
                  )}
                </Row>

                {/* N_BARS_BREAKOUT provider params (shared by ADAPTIVE_OPTIONS template) */}
                {formData.directionProviderType === 'N_BARS_BREAKOUT' && (
                  <NBarsBreakoutParamsEditor
                    value={formData.directionProviderParams || {}}
                    tradeMode={formData.tradeMode}
                    disabled={editModalReadOnly}
                    onChange={(next) => setFormData({ ...formData, directionProviderParams: next })}
                  />
                )}

                {/* CANDLE provider specific fields */}
                {formData.directionProviderType === 'CANDLE' && (
                  <>
                    <Row>
                      <Col md={4}>
                        <Form.Group className="mb-4">
                          <Form.Label>Comparison Mode</Form.Label>
                          <Form.Select
                            value={formData.directionProviderParams?.comparisonMode || ''}
                            isInvalid={!!validationErrors.comparisonMode}
                            onChange={(e) => setFormData({
                              ...formData,
                              directionProviderParams: {
                                ...formData.directionProviderParams,
                                comparisonMode: e.target.value,
                              },
                            })}
                          >
                            <option value="" disabled>-- Select --</option>
                            {CANDLE_COMPARISON_MODES.map((m) => (
                              <option key={m.value} value={m.value}>{m.label}</option>
                            ))}
                          </Form.Select>
                          {validationErrors.comparisonMode
                            ? <Form.Control.Feedback type="invalid">{validationErrors.comparisonMode}</Form.Control.Feedback>
                            : <Form.Text className="text-ink-soft">
                                {CANDLE_COMPARISON_MODES.find(m => m.value === formData.directionProviderParams?.comparisonMode)?.description}
                              </Form.Text>}
                        </Form.Group>
                      </Col>
                      <Col md={4}>
                        <Form.Group className="mb-4">
                          <Form.Label>LONG when</Form.Label>
                          <Form.Select
                            value={formData.directionProviderParams?.longWhen || ''}
                            isInvalid={!!validationErrors.longWhen}
                            onChange={(e) => setFormData({
                              ...formData,
                              directionProviderParams: {
                                ...formData.directionProviderParams,
                                longWhen: e.target.value,
                              },
                            })}
                          >
                            <option value="" disabled>-- Select --</option>
                            <option value="GREATER">Price is Higher (Bullish)</option>
                            <option value="LESS">Price is Lower (Bearish)</option>
                          </Form.Select>
                          {validationErrors.longWhen
                            ? <Form.Control.Feedback type="invalid">{validationErrors.longWhen}</Form.Control.Feedback>
                            : <Form.Text className="text-ink-soft">
                                When should direction be LONG?
                              </Form.Text>}
                        </Form.Group>
                      </Col>
                    </Row>

                    {/* CMP_VS_REF mode: single reference */}
                    {formData.directionProviderParams?.comparisonMode === 'CMP_VS_REF' && (
                      <Row>
                        <Col md={2}>
                          <Form.Group className="mb-4">
                            <Form.Label>Reference Time</Form.Label>
                            <Form.Select
                              value={getRefTimeSelectValue(formData.directionProviderParams?.refTime)}
                              onChange={(e) => setFormData({
                                ...formData,
                                directionProviderParams: {
                                  ...formData.directionProviderParams,
                                  refTime: e.target.value === 'CUSTOM' ? '09:15:00' : e.target.value,
                                },
                              })}
                            >
                              <option value="" disabled>-- Select --</option>
                              {CANDLE_REFERENCE_TIMES.map((t) => (
                                <option key={t.value} value={t.value}>{t.label}</option>
                              ))}
                            </Form.Select>
                          </Form.Group>
                        </Col>
                        {(getRefTimeSelectValue(formData.directionProviderParams?.refTime) === 'CUSTOM' || isCustomTime(formData.directionProviderParams?.refTime)) && (
                          <Col md={2}>
                            <Form.Group className="mb-4">
                              <Form.Label>Time (HH:mm:ss)</Form.Label>
                              <Form.Control
                                type="text"
                                placeholder="09:15:00"
                                value={formData.directionProviderParams?.refTime || ''}
                                onChange={(e) => setFormData({
                                  ...formData,
                                  directionProviderParams: {
                                    ...formData.directionProviderParams,
                                    refTime: e.target.value,
                                  },
                                })}
                              />
                            </Form.Group>
                          </Col>
                        )}
                        <Col md={2}>
                          <Form.Group className="mb-4">
                            <Form.Label>Day Offset</Form.Label>
                            <Form.Select
                              value={getDayOffsetSelectValue(formData.directionProviderParams?.refDayOffset)}
                              isInvalid={!!validationErrors.refDayOffset}
                              onChange={(e) => setFormData({
                                ...formData,
                                directionProviderParams: {
                                  ...formData.directionProviderParams,
                                  refDayOffset: e.target.value === 'CUSTOM' ? '-5' : e.target.value,
                                },
                              })}
                            >
                              <option value="" disabled>-- Select --</option>
                              {DAY_OFFSETS.map((d) => (
                                <option key={d.value} value={d.value}>{d.label}</option>
                              ))}
                            </Form.Select>
                            {validationErrors.refDayOffset && <Form.Control.Feedback type="invalid">{validationErrors.refDayOffset}</Form.Control.Feedback>}
                          </Form.Group>
                        </Col>
                        {(getDayOffsetSelectValue(formData.directionProviderParams?.refDayOffset) === 'CUSTOM' || isCustomDayOffset(formData.directionProviderParams?.refDayOffset)) && (
                          <Col md={3}>
                            <Form.Group className="mb-4">
                              <Form.Label>Custom Offset</Form.Label>
                              <Form.Control
                                type="number"
                                max={0}
                                value={formData.directionProviderParams?.refDayOffset || ''}
                                onChange={(e) => {
                                  const val = parseInt(e.target.value) || 0;
                                  setFormData({
                                    ...formData,
                                    directionProviderParams: {
                                      ...formData.directionProviderParams,
                                      refDayOffset: String(Math.min(0, val)),
                                    },
                                  });
                                }}
                              />
                            </Form.Group>
                          </Col>
                        )}
                        {isCustomTime(formData.directionProviderParams?.refTime) && (
                          <Col md={2}>
                            <Form.Group className="mb-4">
                              <Form.Label>Price Type</Form.Label>
                              <Form.Select
                                value={formData.directionProviderParams?.refPriceType || ''}
                                isInvalid={!!validationErrors.refPriceType}
                                onChange={(e) => setFormData({
                                  ...formData,
                                  directionProviderParams: {
                                    ...formData.directionProviderParams,
                                    refPriceType: e.target.value,
                                  },
                                })}
                              >
                                <option value="" disabled>-- Select --</option>
                                {CANDLE_PRICE_TYPES.map((p) => (
                                  <option key={p.value} value={p.value}>{p.label}</option>
                                ))}
                              </Form.Select>
                              {validationErrors.refPriceType && <Form.Control.Feedback type="invalid">{validationErrors.refPriceType}</Form.Control.Feedback>}
                            </Form.Group>
                          </Col>
                        )}
                      </Row>
                    )}

                    {/* REF_VS_REF mode: two references */}
                    {formData.directionProviderParams?.comparisonMode === 'REF_VS_REF' && (
                      <>
                        <Row>
                          <Col md={12}><Form.Label className="font-bold">Reference 1 (compared against Reference 2)</Form.Label></Col>
                        </Row>
                        <Row>
                          <Col md={2}>
                            <Form.Group className="mb-4">
                              <Form.Label>Time</Form.Label>
                              <Form.Select
                                value={getRefTimeSelectValue(formData.directionProviderParams?.ref1Time)}
                                onChange={(e) => setFormData({
                                  ...formData,
                                  directionProviderParams: {
                                    ...formData.directionProviderParams,
                                    ref1Time: e.target.value === 'CUSTOM' ? '09:15:00' : e.target.value,
                                  },
                                })}
                              >
                                <option value="" disabled>-- Select --</option>
                                {CANDLE_REFERENCE_TIMES.map((t) => (
                                  <option key={t.value} value={t.value}>{t.label}</option>
                                ))}
                              </Form.Select>
                            </Form.Group>
                          </Col>
                          {(getRefTimeSelectValue(formData.directionProviderParams?.ref1Time) === 'CUSTOM' || isCustomTime(formData.directionProviderParams?.ref1Time)) && (
                            <Col md={2}>
                              <Form.Group className="mb-4">
                                <Form.Label>Time (HH:mm:ss)</Form.Label>
                                <Form.Control
                                  type="text"
                                  placeholder="09:15:00"
                                  value={formData.directionProviderParams?.ref1Time || ''}
                                  onChange={(e) => setFormData({
                                    ...formData,
                                    directionProviderParams: {
                                      ...formData.directionProviderParams,
                                      ref1Time: e.target.value,
                                    },
                                  })}
                                />
                              </Form.Group>
                            </Col>
                          )}
                          <Col md={2}>
                            <Form.Group className="mb-4">
                              <Form.Label>Day Offset</Form.Label>
                              <Form.Select
                                value={getDayOffsetSelectValue(formData.directionProviderParams?.ref1DayOffset)}
                                isInvalid={!!validationErrors.ref1DayOffset}
                                onChange={(e) => setFormData({
                                  ...formData,
                                  directionProviderParams: {
                                    ...formData.directionProviderParams,
                                    ref1DayOffset: e.target.value === 'CUSTOM' ? '-5' : e.target.value,
                                  },
                                })}
                              >
                                <option value="" disabled>-- Select --</option>
                                {DAY_OFFSETS.map((d) => (
                                  <option key={d.value} value={d.value}>{d.label}</option>
                                ))}
                              </Form.Select>
                              {validationErrors.ref1DayOffset && <Form.Control.Feedback type="invalid">{validationErrors.ref1DayOffset}</Form.Control.Feedback>}
                            </Form.Group>
                          </Col>
                          {(getDayOffsetSelectValue(formData.directionProviderParams?.ref1DayOffset) === 'CUSTOM' || isCustomDayOffset(formData.directionProviderParams?.ref1DayOffset)) && (
                            <Col md={3}>
                              <Form.Group className="mb-4">
                                <Form.Label>Custom Offset</Form.Label>
                                <Form.Control
                                  type="number"
                                  max={0}
                                  value={formData.directionProviderParams?.ref1DayOffset || ''}
                                  onChange={(e) => {
                                    const val = parseInt(e.target.value) || 0;
                                    setFormData({
                                      ...formData,
                                      directionProviderParams: {
                                        ...formData.directionProviderParams,
                                        ref1DayOffset: String(Math.min(0, val)),
                                      },
                                    });
                                  }}
                                />
                              </Form.Group>
                            </Col>
                          )}
                          {isCustomTime(formData.directionProviderParams?.ref1Time) && (
                            <Col md={2}>
                              <Form.Group className="mb-4">
                                <Form.Label>Price Type</Form.Label>
                                <Form.Select
                                  value={formData.directionProviderParams?.ref1PriceType || ''}
                                  isInvalid={!!validationErrors.ref1PriceType}
                                  onChange={(e) => setFormData({
                                    ...formData,
                                    directionProviderParams: {
                                      ...formData.directionProviderParams,
                                      ref1PriceType: e.target.value,
                                    },
                                  })}
                                >
                                  <option value="" disabled>-- Select --</option>
                                  {CANDLE_PRICE_TYPES.map((p) => (
                                    <option key={p.value} value={p.value}>{p.label}</option>
                                  ))}
                                </Form.Select>
                                {validationErrors.ref1PriceType && <Form.Control.Feedback type="invalid">{validationErrors.ref1PriceType}</Form.Control.Feedback>}
                              </Form.Group>
                            </Col>
                          )}
                        </Row>
                        <Row>
                          <Col md={12}><Form.Label className="font-bold">Reference 2</Form.Label></Col>
                        </Row>
                        <Row>
                          <Col md={2}>
                            <Form.Group className="mb-4">
                              <Form.Label>Time</Form.Label>
                              <Form.Select
                                value={getRefTimeSelectValue(formData.directionProviderParams?.ref2Time)}
                                onChange={(e) => setFormData({
                                  ...formData,
                                  directionProviderParams: {
                                    ...formData.directionProviderParams,
                                    ref2Time: e.target.value === 'CUSTOM' ? '15:30:00' : e.target.value,
                                  },
                                })}
                              >
                                <option value="" disabled>-- Select --</option>
                                {CANDLE_REFERENCE_TIMES.map((t) => (
                                  <option key={t.value} value={t.value}>{t.label}</option>
                                ))}
                              </Form.Select>
                            </Form.Group>
                          </Col>
                          {(getRefTimeSelectValue(formData.directionProviderParams?.ref2Time) === 'CUSTOM' || isCustomTime(formData.directionProviderParams?.ref2Time)) && (
                            <Col md={2}>
                              <Form.Group className="mb-4">
                                <Form.Label>Time (HH:mm:ss)</Form.Label>
                                <Form.Control
                                  type="text"
                                  placeholder="15:30:00"
                                  value={formData.directionProviderParams?.ref2Time || ''}
                                  onChange={(e) => setFormData({
                                    ...formData,
                                    directionProviderParams: {
                                      ...formData.directionProviderParams,
                                      ref2Time: e.target.value,
                                    },
                                  })}
                                />
                              </Form.Group>
                            </Col>
                          )}
                          <Col md={2}>
                            <Form.Group className="mb-4">
                              <Form.Label>Day Offset</Form.Label>
                              <Form.Select
                                value={getDayOffsetSelectValue(formData.directionProviderParams?.ref2DayOffset)}
                                isInvalid={!!validationErrors.ref2DayOffset}
                                onChange={(e) => setFormData({
                                  ...formData,
                                  directionProviderParams: {
                                    ...formData.directionProviderParams,
                                    ref2DayOffset: e.target.value === 'CUSTOM' ? '-5' : e.target.value,
                                  },
                                })}
                              >
                                <option value="" disabled>-- Select --</option>
                                {DAY_OFFSETS.map((d) => (
                                  <option key={d.value} value={d.value}>{d.label}</option>
                                ))}
                              </Form.Select>
                              {validationErrors.ref2DayOffset && <Form.Control.Feedback type="invalid">{validationErrors.ref2DayOffset}</Form.Control.Feedback>}
                            </Form.Group>
                          </Col>
                          {(getDayOffsetSelectValue(formData.directionProviderParams?.ref2DayOffset) === 'CUSTOM' || isCustomDayOffset(formData.directionProviderParams?.ref2DayOffset)) && (
                            <Col md={3}>
                              <Form.Group className="mb-4">
                                <Form.Label>Custom Offset</Form.Label>
                                <Form.Control
                                  type="number"
                                  max={0}
                                  value={formData.directionProviderParams?.ref2DayOffset || ''}
                                  onChange={(e) => {
                                    const val = parseInt(e.target.value) || 0;
                                    setFormData({
                                      ...formData,
                                      directionProviderParams: {
                                        ...formData.directionProviderParams,
                                        ref2DayOffset: String(Math.min(0, val)),
                                      },
                                    });
                                  }}
                                />
                              </Form.Group>
                            </Col>
                          )}
                          {isCustomTime(formData.directionProviderParams?.ref2Time) && (
                            <Col md={2}>
                              <Form.Group className="mb-4">
                                <Form.Label>Price Type</Form.Label>
                                <Form.Select
                                  value={formData.directionProviderParams?.ref2PriceType || ''}
                                  isInvalid={!!validationErrors.ref2PriceType}
                                  onChange={(e) => setFormData({
                                    ...formData,
                                    directionProviderParams: {
                                      ...formData.directionProviderParams,
                                      ref2PriceType: e.target.value,
                                    },
                                  })}
                                >
                                  <option value="" disabled>-- Select --</option>
                                  {CANDLE_PRICE_TYPES.map((p) => (
                                    <option key={p.value} value={p.value}>{p.label}</option>
                                  ))}
                                </Form.Select>
                                {validationErrors.ref2PriceType && <Form.Control.Feedback type="invalid">{validationErrors.ref2PriceType}</Form.Control.Feedback>}
                              </Form.Group>
                            </Col>
                          )}
                        </Row>
                      </>
                    )}

                    {/* Direction Summary */}
                    {getCandleDirectionSummary(formData.directionProviderParams as Record<string, string>) && (
                      <Row className="mt-2">
                        <Col md={12}>
                          <div className="p-4 bg-raised rounded-md border">
                            <div className="font-bold mb-2">Direction Logic Summary:</div>
                            <div className="flex gap-6">
                              <div>
                                <span className="inline-block rounded-md px-[.55em] py-[.35em] text-center text-[.75em] font-semibold leading-none whitespace-nowrap text-white bg-success-500 me-2">LONG</span>
                                <span className="text-ink-soft">({getDirectionLabels(formData.tradeMode).longAction})</span>
                                <div className="mt-1 text-[0.875em]">
                                  {getCandleDirectionSummary(formData.directionProviderParams as Record<string, string>)?.longDesc}
                                </div>
                              </div>
                              <div>
                                <span className="inline-block rounded-md px-[.55em] py-[.35em] text-center text-[.75em] font-semibold leading-none whitespace-nowrap text-white bg-danger-600 me-2">SHORT</span>
                                <span className="text-ink-soft">({getDirectionLabels(formData.tradeMode).shortAction})</span>
                                <div className="mt-1 text-[0.875em]">
                                  {getCandleDirectionSummary(formData.directionProviderParams as Record<string, string>)?.shortDesc}
                                </div>
                              </div>
                            </div>
                          </div>
                        </Col>
                      </Row>
                    )}

                    <Row className="mt-4">
                      <Col md={3}>
                        <Form.Group className="mb-4">
                          <Form.Label>Cache Minutes</Form.Label>
                          <Form.Control
                            type="number"
                            value={formData.directionProviderParams?.cacheMinutes ?? '60'}
                            onChange={(e) => setFormData({
                              ...formData,
                              directionProviderParams: {
                                ...formData.directionProviderParams,
                                cacheMinutes: e.target.value,
                              },
                            })}
                          />
                          <Form.Text className="text-ink-soft">How long to cache the direction</Form.Text>
                        </Form.Group>
                      </Col>
                    </Row>
                  </>
                )}

                {/* FIXED provider specific fields */}
                {formData.directionProviderType === 'FIXED' && (
                  <>
                    <Row>
                      <Col md={4}>
                        <Form.Group className="mb-4">
                          <Form.Label>Fixed Direction</Form.Label>
                          <Form.Select
                            value={formData.directionProviderParams?.direction || 'LONG'}
                            onChange={(e) => setFormData({
                              ...formData,
                              directionProviderParams: {
                                ...formData.directionProviderParams,
                                direction: e.target.value,
                              },
                            })}
                          >
                            <option value="LONG">LONG ({getDirectionLabels(formData.tradeMode).longAction})</option>
                            <option value="SHORT">SHORT ({getDirectionLabels(formData.tradeMode).shortAction})</option>
                          </Form.Select>
                        </Form.Group>
                      </Col>
                    </Row>
                    <Row className="mt-2">
                      <Col md={12}>
                        <div className="p-4 bg-raised rounded-md border">
                          <div className="font-bold mb-2">Direction Logic Summary:</div>
                          <div className="flex gap-6">
                            <div>
                              <span className={`inline-block rounded-md px-[.55em] py-[.35em] text-center text-[.75em] font-semibold leading-none whitespace-nowrap text-white bg-ink-soft ${formData.directionProviderParams?.direction === 'SHORT' ? 'bg-danger-600' : 'bg-success-500'} me-2`}>
                                {formData.directionProviderParams?.direction || 'LONG'}
                              </span>
                              <span className="text-ink-soft">
                                ({formData.directionProviderParams?.direction === 'SHORT' ? getDirectionLabels(formData.tradeMode).shortAction : getDirectionLabels(formData.tradeMode).longAction})
                              </span>
                              <div className="mt-1 text-[0.875em]">
                                Always use {formData.directionProviderParams?.direction || 'LONG'} direction regardless of market conditions
                              </div>
                            </div>
                          </div>
                        </div>
                      </Col>
                    </Row>
                  </>
                )}

                {/* PCR provider specific fields */}
                {formData.directionProviderType === 'PCR' && (
                  <>
                    <Row>
                      <Col md={3}>
                        <Form.Group className="mb-4">
                          <Form.Label>Comparison Mode</Form.Label>
                          <Form.Select
                            value={formData.directionProviderParams?.comparisonMode || 'THRESHOLD'}
                            onChange={(e) => setFormData({
                              ...formData,
                              directionProviderParams: {
                                ...formData.directionProviderParams,
                                comparisonMode: e.target.value,
                              },
                            })}
                          >
                            <option value="THRESHOLD">Threshold (PCR vs value)</option>
                            <option value="TREND">Trend (PCR now vs N min ago)</option>
                          </Form.Select>
                        </Form.Group>
                      </Col>
                      {(!formData.directionProviderParams?.comparisonMode || formData.directionProviderParams?.comparisonMode === 'THRESHOLD') && (
                        <Col md={3}>
                          <Form.Group className="mb-4">
                            <Form.Label>PCR Threshold</Form.Label>
                            <Form.Control
                              type="number"
                              step="0.1"
                              value={formData.directionProviderParams?.threshold || '1.0'}
                              onChange={(e) => setFormData({
                                ...formData,
                                directionProviderParams: {
                                  ...formData.directionProviderParams,
                                  threshold: e.target.value,
                                },
                              })}
                            />
                          </Form.Group>
                        </Col>
                      )}
                      {formData.directionProviderParams?.comparisonMode === 'TREND' && (
                        <>
                          <Col md={3}>
                            <Form.Group className="mb-4">
                              <Form.Label>Lookback Minutes</Form.Label>
                              <Form.Control
                                type="number"
                                min="1"
                                max="120"
                                value={formData.directionProviderParams?.lookbackMinutes || '15'}
                                onChange={(e) => setFormData({
                                  ...formData,
                                  directionProviderParams: {
                                    ...formData.directionProviderParams,
                                    lookbackMinutes: e.target.value,
                                  },
                                })}
                              />
                            </Form.Group>
                          </Col>
                          <Col md={3}>
                            <Form.Group className="mb-4">
                              <Form.Label>LONG When</Form.Label>
                              <Form.Select
                                value={formData.directionProviderParams?.longWhen || 'INCREASING'}
                                onChange={(e) => setFormData({
                                  ...formData,
                                  directionProviderParams: {
                                    ...formData.directionProviderParams,
                                    longWhen: e.target.value,
                                  },
                                })}
                              >
                                <option value="INCREASING">PCR Rising (Bullish)</option>
                                <option value="DECREASING">PCR Falling (Bearish)</option>
                              </Form.Select>
                            </Form.Group>
                          </Col>
                        </>
                      )}
                    </Row>
                    <Row className="mt-2">
                      <Col md={12}>
                        <div className="p-4 bg-raised rounded-md border">
                          <div className="font-bold mb-2">Direction Logic Summary:</div>
                          <div className="text-[0.875em] text-ink-soft mb-2">PCR = Put OI / Call OI. High PCR = More puts = Bullish sentiment</div>
                          {(!formData.directionProviderParams?.comparisonMode || formData.directionProviderParams?.comparisonMode === 'THRESHOLD') && (
                            <div className="flex gap-6">
                              <div>
                                <span className="inline-block rounded-md px-[.55em] py-[.35em] text-center text-[.75em] font-semibold leading-none whitespace-nowrap text-white bg-success-500 me-2">LONG</span>
                                <span className="text-ink-soft">({getDirectionLabels(formData.tradeMode).longAction})</span>
                                <div className="mt-1 text-[0.875em]">
                                  PCR ≥ {formData.directionProviderParams?.threshold || '1.0'} (More puts than calls = Bullish)
                                </div>
                              </div>
                              <div>
                                <span className="inline-block rounded-md px-[.55em] py-[.35em] text-center text-[.75em] font-semibold leading-none whitespace-nowrap text-white bg-danger-600 me-2">SHORT</span>
                                <span className="text-ink-soft">({getDirectionLabels(formData.tradeMode).shortAction})</span>
                                <div className="mt-1 text-[0.875em]">
                                  PCR &lt; {formData.directionProviderParams?.threshold || '1.0'} (More calls than puts = Bearish)
                                </div>
                              </div>
                            </div>
                          )}
                          {formData.directionProviderParams?.comparisonMode === 'TREND' && (
                            <div className="flex gap-6">
                              <div>
                                <span className="inline-block rounded-md px-[.55em] py-[.35em] text-center text-[.75em] font-semibold leading-none whitespace-nowrap text-white bg-success-500 me-2">LONG</span>
                                <span className="text-ink-soft">({getDirectionLabels(formData.tradeMode).longAction})</span>
                                <div className="mt-1 text-[0.875em]">
                                  {(formData.directionProviderParams?.longWhen || 'INCREASING') === 'INCREASING'
                                    ? <>Current PCR &gt; PCR from {formData.directionProviderParams?.lookbackMinutes || '15'} min ago (PCR rising = Bullish)</>
                                    : <>Current PCR &lt; PCR from {formData.directionProviderParams?.lookbackMinutes || '15'} min ago (PCR falling)</>
                                  }
                                </div>
                              </div>
                              <div>
                                <span className="inline-block rounded-md px-[.55em] py-[.35em] text-center text-[.75em] font-semibold leading-none whitespace-nowrap text-white bg-danger-600 me-2">SHORT</span>
                                <span className="text-ink-soft">({getDirectionLabels(formData.tradeMode).shortAction})</span>
                                <div className="mt-1 text-[0.875em]">
                                  {(formData.directionProviderParams?.longWhen || 'INCREASING') === 'INCREASING'
                                    ? <>Current PCR ≤ PCR from {formData.directionProviderParams?.lookbackMinutes || '15'} min ago (PCR falling = Bearish)</>
                                    : <>Current PCR ≥ PCR from {formData.directionProviderParams?.lookbackMinutes || '15'} min ago (PCR rising)</>
                                  }
                                </div>
                              </div>
                            </div>
                          )}
                        </div>
                      </Col>
                    </Row>
                  </>
                )}

                {/* IV_SKEW provider specific fields */}
                {formData.directionProviderType === 'IV_SKEW' && (
                  <>
                    <Row>
                      <Col md={3}>
                        <Form.Group className="mb-4">
                          <Form.Label>Default Direction</Form.Label>
                          <Form.Select
                            value={formData.directionProviderParams?.defaultDirection || 'LONG'}
                            onChange={(e) => setFormData({
                              ...formData,
                              directionProviderParams: {
                                ...formData.directionProviderParams,
                                defaultDirection: e.target.value,
                              },
                            })}
                          >
                            <option value="LONG">LONG</option>
                            <option value="SHORT">SHORT</option>
                          </Form.Select>
                        </Form.Group>
                      </Col>
                    </Row>
                    <Row className="mt-2">
                      <Col md={12}>
                        <div className="p-4 bg-raised rounded-md border">
                          <div className="font-bold mb-2">Direction Logic Summary:</div>
                          <div className="text-[0.875em] text-ink-soft mb-2">Higher IV = Higher expected move. Market prices in expected direction.</div>
                          <div className="flex gap-6">
                            <div>
                              <span className="inline-block rounded-md px-[.55em] py-[.35em] text-center text-[.75em] font-semibold leading-none whitespace-nowrap text-white bg-success-500 me-2">LONG</span>
                              <span className="text-ink-soft">({getDirectionLabels(formData.tradeMode).longAction})</span>
                              <div className="mt-1 text-[0.875em]">
                                CE IV &lt; PE IV → {getDirectionLabels(formData.tradeMode).longAction}
                              </div>
                            </div>
                            <div>
                              <span className="inline-block rounded-md px-[.55em] py-[.35em] text-center text-[.75em] font-semibold leading-none whitespace-nowrap text-white bg-danger-600 me-2">SHORT</span>
                              <span className="text-ink-soft">({getDirectionLabels(formData.tradeMode).shortAction})</span>
                              <div className="mt-1 text-[0.875em]">
                                CE IV &gt; PE IV → {getDirectionLabels(formData.tradeMode).shortAction}
                              </div>
                            </div>
                            <div>
                              <span className="inline-block rounded-md px-[.55em] py-[.35em] text-center text-[.75em] font-semibold leading-none whitespace-nowrap text-white bg-ink-soft me-2">{formData.directionProviderParams?.defaultDirection || 'LONG'}</span>
                              <span className="text-ink-soft">(Default)</span>
                              <div className="mt-1 text-[0.875em]">
                                CE IV = PE IV (No skew, use default)
                              </div>
                            </div>
                          </div>
                        </div>
                      </Col>
                    </Row>
                  </>
                )}

                {/* INDICATOR provider - show direction rules editor */}
                {formData.directionProviderType === 'INDICATOR' && formData.templateName !== 'INDICATOR_ADVANCED_OPTIONS' && (
                  <div className="mt-4 border rounded-md p-4" style={{ borderColor: '#17a2b8' }}>
                    <div className="text-accent-600 dark:text-accent-400 text-[0.875em] font-semibold mb-2" style={{ marginTop: '-1.5rem', background: 'rgb(var(--c-card))', width: 'fit-content', padding: '0 0.5rem' }}>
                      Indicator Direction Rules
                    </div>
                    <DirectionRulesOnlyEditor
                      ruleSet={indicatorRules}
                      onChange={setIndicatorRules}
                      tradeMode={formData.tradeMode}
                    />
                  </div>
                )}

              </div>
            )}

                {/* Leg ordering — applies to hedged option entries and to combos alike. Blank
                    keeps the long-standing default, which differs by shape, so it is resolved in
                    the engine rather than pre-filled here. */}
                <Row>
                  <Col md={4}>
                    <Form.Group className="mb-4">
                      <Form.Label className="flex items-center">Entry Leg Order <HelpIcon article={strategyDefinitionHelpContent['strategyDef.entryLegOrder']} /></Form.Label>
                      <Form.Select
                        value={formData.entryLegOrder ?? ''}
                        disabled={editModalReadOnly}
                        onChange={(e) => setFormData({
                          ...formData,
                          entryLegOrder: (e.target.value || undefined) as typeof formData.entryLegOrder,
                        })}
                      >
                        <option value="">Default (protection first; derivative first for combos)</option>
                        <option value="PROTECTION_FIRST">PROTECTION_FIRST — hedge buy before the sold leg</option>
                        <option value="EXPOSURE_FIRST">EXPOSURE_FIRST — sold leg first, hedge after</option>
                        <option value="DERIVATIVE_FIRST">DERIVATIVE_FIRST — future/option before cash</option>
                        <option value="CASH_FIRST">CASH_FIRST — cash before future/option</option>
                      </Form.Select>
                      <Form.Text className="text-ink-soft">
                        Which leg goes on the book first. Protection-first keeps a sold option from
                        ever being naked; derivative-first puts the uncertain fill on while the book
                        is still flat.
                      </Form.Text>
                    </Form.Group>
                  </Col>
                  <Col md={4}>
                    <Form.Group className="mb-4">
                      <Form.Label className="flex items-center">Exit Leg Order <HelpIcon article={strategyDefinitionHelpContent['strategyDef.exitLegOrder']} /></Form.Label>
                      <Form.Select
                        value={formData.exitLegOrder ?? ''}
                        disabled={editModalReadOnly}
                        onChange={(e) => setFormData({
                          ...formData,
                          exitLegOrder: (e.target.value || undefined) as typeof formData.exitLegOrder,
                        })}
                      >
                        <option value="">Default (reverse of entry)</option>
                        <option value="REVERSE_ENTRY">REVERSE_ENTRY — last on, first off</option>
                        <option value="SAME_AS_ENTRY">SAME_AS_ENTRY — first on, first off</option>
                        <option value="PROTECTION_LAST">PROTECTION_LAST — hedge legs exit last</option>
                      </Form.Select>
                      <Form.Text className="text-ink-soft">
                        Reverse-entry is right when one leg protects another. For a long/short pair
                        prefer SAME_AS_ENTRY, so the illiquid leg is not left behind.
                      </Form.Text>
                    </Form.Group>
                  </Col>
                </Row>

            {/* Indicator Rules Section - only for INDICATOR_ADVANCED_OPTIONS template */}
            {formData.templateName === 'INDICATOR_ADVANCED_OPTIONS' && (
              <>
                <hr className="my-6" />
                <h6 className="text-ink-soft mb-4">Indicator Rules</h6>

                <SimplifiedRuleSetEditor
                  ruleSet={indicatorRules}
                  onChange={setIndicatorRules}
                  isDirectional={formData.isDirectional ?? false}
                  tradeMode={formData.tradeMode}
                />
              </>
            )}
            {/* Trigger Types */}
            <div className="border rounded-md p-4 mb-4" style={{ borderColor: 'rgb(var(--c-hairline))' }}>
              <div className="text-ink-soft text-[0.875em] font-semibold mb-2" style={{ marginTop: '-1.5rem', background: 'rgb(var(--c-card))', width: 'fit-content', padding: '0 0.5rem' }}>
                Trigger Types <span className="text-danger-600 dark:text-danger-400">*</span>
              </div>
              <Row>
              <Col md={12}>
                <Form.Group className="mb-4">
                  <div className="flex flex-wrap gap-6">
                    <Form.Check
                      type="checkbox"
                      id="tickTriggerEnabled"
                      label={<span className="flex items-center">Tick Trigger <HelpIcon article={strategyDefinitionHelpContent['strategyDef.tickTriggerEnabled']} /></span>}
                      checked={formData.tickTriggerEnabled}
                      onChange={(e) => setFormData({ ...formData, tickTriggerEnabled: e.target.checked })}
                    />
                    <Form.Check
                      type="checkbox"
                      id="scheduledTriggerEnabled"
                      label={<span className="flex items-center">Scheduled Trigger <HelpIcon article={strategyDefinitionHelpContent['strategyDef.scheduledTriggerEnabled']} /></span>}
                      checked={formData.scheduledTriggerEnabled}
                      onChange={(e) => setFormData({ ...formData, scheduledTriggerEnabled: e.target.checked })}
                    />
                    <Form.Check
                      type="checkbox"
                      id="signalTriggerEnabled"
                      label={<span className="flex items-center">Signal Trigger <HelpIcon article={strategyDefinitionHelpContent['strategyDef.signalTriggerEnabled']} /></span>}
                      checked={formData.signalTriggerEnabled}
                      onChange={(e) => setFormData({ ...formData, signalTriggerEnabled: e.target.checked })}
                    />
                    <Form.Check
                      type="checkbox"
                      id="periodicTriggerEnabled"
                      label={<span className="flex items-center">Periodic Trigger <HelpIcon article={strategyDefinitionHelpContent['strategyDef.periodicTriggerEnabled']} /></span>}
                      checked={formData.periodicTriggerEnabled}
                      disabled={formData.templateName === 'ADAPTIVE_OPTIONS' || formData.templateName === 'ZERODT_OPTIONS'}
                      onChange={(e) => setFormData({
                        ...formData,
                        periodicTriggerEnabled: e.target.checked,
                      })}
                    />
                  </div>
                  {validationErrors.trigger ? (
                    <div className="text-danger-600 dark:text-danger-400 text-[0.875em] mt-1">{validationErrors.trigger}</div>
                  ) : (
                    <Form.Text className="text-ink-soft">
                      {formData.templateName === 'ADAPTIVE_OPTIONS'
                        ? 'Periodic Trigger required for Adaptive Options — drives the candle-close heartbeat that detects breakouts.'
                        : formData.templateName === 'ZERODT_OPTIONS'
                        ? 'Periodic Trigger required for ZeroDT Options — drives the stuck-state recovery heartbeat between tranches.'
                        : 'Select at least one trigger type for the strategy'}
                    </Form.Text>
                  )}
                </Form.Group>
              </Col>
            </Row>
            {/* Periodic Settings - show when periodic trigger is enabled */}
            {formData.periodicTriggerEnabled && (
              <Row>
                <Col md={6}>
                  <Form.Group className="mb-4">
                    <Form.Label className="flex items-center">Periodic Interval (minutes) <HelpIcon article={strategyDefinitionHelpContent['strategyDef.periodicIntervalMinutes']} /></Form.Label>
                    <Form.Control
                      type="number"
                      min={1}
                      max={240}
                      placeholder="e.g., 5"
                      value={formData.periodicIntervalMinutes ?? ''}
                      onChange={(e) => setFormData({ ...formData, periodicIntervalMinutes: e.target.value ? parseInt(e.target.value) : undefined })}
                    />
                    <Form.Text className="text-ink-soft">1-240 minutes, clock-aligned</Form.Text>
                  </Form.Group>
                </Col>
                <Col md={6}>
                  <Form.Group className="mb-4">
                    <Form.Label className="flex items-center">Periodic Offset (seconds) <HelpIcon article={strategyDefinitionHelpContent['strategyDef.periodicOffsetSeconds']} /></Form.Label>
                    <Form.Control
                      type="number"
                      min={0}
                      max={15}
                      placeholder="0"
                      value={formData.periodicOffsetSeconds ?? ''}
                      onChange={(e) => setFormData({ ...formData, periodicOffsetSeconds: e.target.value ? parseInt(e.target.value) : undefined })}
                    />
                    <Form.Text className="text-ink-soft">0-15s delay for candle data availability</Form.Text>
                  </Form.Group>
                </Col>
              </Row>
            )}
            </div>

            {/* Timing */}
            <div className="border rounded-md p-4 mb-4" style={{ borderColor: 'rgb(var(--c-hairline))' }}>
              <div className="text-ink-soft text-[0.875em] font-semibold mb-2" style={{ marginTop: '-1.5rem', background: 'rgb(var(--c-card))', width: 'fit-content', padding: '0 0.5rem' }}>
                Timing
              </div>
              <Row>
              <Col md={6}>
                <Form.Group className="mb-4">
                  <Form.Label className="flex items-center">Start Time <span className="text-danger-600 dark:text-danger-400">*</span> <HelpIcon article={strategyDefinitionHelpContent['strategyDef.startTime']} /></Form.Label>
                  <Form.Control
                    type="text"
                    placeholder="HH:mm:ss"
                    value={formData.startTime}
                    onChange={(e) => setFormData({ ...formData, startTime: e.target.value })}
                    required
                    isInvalid={!!validationErrors.startTime}
                  />
                  {validationErrors.startTime && <Form.Control.Feedback type="invalid">{validationErrors.startTime}</Form.Control.Feedback>}
                </Form.Group>
              </Col>
              <Col md={4}>
                <Form.Group className="mb-4">
                  <Form.Label className="flex items-center">Stop Time <span className="text-danger-600 dark:text-danger-400">*</span> <HelpIcon article={strategyDefinitionHelpContent['strategyDef.stopTime']} /></Form.Label>
                  <Form.Control
                    type="text"
                    placeholder="HH:mm:ss"
                    value={formData.stopTime}
                    onChange={(e) => setFormData({ ...formData, stopTime: e.target.value })}
                    required
                    isInvalid={!!validationErrors.stopTime}
                  />
                  {validationErrors.stopTime && <Form.Control.Feedback type="invalid">{validationErrors.stopTime}</Form.Control.Feedback>}
                </Form.Group>
              </Col>
            </Row>
            <Row>
              <Col md={12}>
                <Form.Group className="mb-4">
                  <Form.Label className="flex items-center">Tradable Days <HelpIcon article={strategyDefinitionHelpContent['strategyDef.tradableDays']} /></Form.Label>
                  <div className="flex flex-wrap gap-2">
                    {TRADABLE_DAYS.map((day) => (
                      <Form.Check
                        key={day.value}
                        type="checkbox"
                        id={`tradable-day-${day.value}`}
                        label={day.label}
                        checked={selectedDays.includes(day.value)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedDays([...selectedDays, day.value]);
                          } else {
                            setSelectedDays(selectedDays.filter(d => d !== day.value));
                          }
                        }}
                        className={day.group === 'expiry' ? 'text-warning-700 dark:text-warning-400' : ''}
                      />
                    ))}
                  </div>
                  <Form.Text className="text-ink-soft">Leave all unchecked to allow trading on all days</Form.Text>
                </Form.Group>
              </Col>
            </Row>
            <Row>
              <Col md={12}>
                <Form.Group className="mb-4">
                  <Form.Label className="flex items-center">Excluded Days <Badge bg="danger" className="ms-2">Blacklist</Badge> <HelpIcon article={strategyDefinitionHelpContent['strategyDef.excludedDays']} /></Form.Label>
                  <div className="flex flex-wrap gap-2">
                    {TRADABLE_DAYS.map((day) => (
                      <Form.Check
                        key={`excluded-${day.value}`}
                        type="checkbox"
                        id={`excluded-day-${day.value}`}
                        label={day.label}
                        checked={selectedExcludedDays.includes(day.value)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedExcludedDays([...selectedExcludedDays, day.value]);
                          } else {
                            setSelectedExcludedDays(selectedExcludedDays.filter(d => d !== day.value));
                          }
                        }}
                        className={day.group === 'expiry' ? 'text-warning-700 dark:text-warning-400' : ''}
                      />
                    ))}
                  </div>
                  <Form.Text className="text-ink-soft">Days to exclude from trading (takes precedence over tradable days)</Form.Text>
                </Form.Group>
              </Col>
            </Row>
            </div>

            {/* Capital & Hedge (FnO only) */}
            {!isEquityMode(formData.tradeMode) && (
            <div className="border rounded-md p-4 mb-4" style={{ borderColor: 'rgb(var(--c-hairline))' }}>
              <div className="text-ink-soft text-[0.875em] font-semibold mb-2" style={{ marginTop: '-1.5rem', background: 'rgb(var(--c-card))', width: 'fit-content', padding: '0 0.5rem' }}>
                Capital & Hedge
              </div>
              <Row>
              <Col md={4}>
                <Form.Group className="mb-4">
                  <Form.Label className="flex items-center">Capital Per Lot (Default) <span className="text-danger-600 dark:text-danger-400">*</span> <HelpIcon article={strategyDefinitionHelpContent['strategyDef.capitalPerLot']} /></Form.Label>
                  <Form.Control
                    type="number"
                    value={formData.capitalPerLot ?? ''}
                    onChange={(e) => setFormData({ ...formData, capitalPerLot: e.target.value ? parseInt(e.target.value) : undefined })}
                    required
                    isInvalid={!!validationErrors.capitalPerLot}
                  />
                  {validationErrors.capitalPerLot ? <Form.Control.Feedback type="invalid">{validationErrors.capitalPerLot}</Form.Control.Feedback> : <Form.Text className="text-ink-soft">Fallback value</Form.Text>}
                                  {underlyingSource === 'STOCKS' && !isEquityMode(formData.tradeMode) && (
                    <Form.Text className="text-ink-soft">
                      Watchlist strategy: set this ≈ the highest per-lot margin among the member stocks
                      (stock futures margins mostly run ₹1–3L per lot) — cheaper members just leave headroom idle.
                      Each member is sized from capital ÷ Max Active Positions.
                    </Form.Text>
                  )}
                </Form.Group>
              </Col>
              <Col md={4}>
                <Form.Group className="mb-4">
                  <Form.Label className="flex items-center">Capital Per Lot (Hedged) <HelpIcon article={strategyDefinitionHelpContent['strategyDef.capitalPerLotHedged']} /></Form.Label>
                  <Form.Control
                    type="number"
                    value={formData.capitalPerLotHedged}
                    onChange={(e) => setFormData({ ...formData, capitalPerLotHedged: parseInt(e.target.value) || 0 })}
                  />
                  <Form.Text className="text-ink-soft">When hedge is enabled</Form.Text>
                </Form.Group>
              </Col>
              <Col md={4}>
                <Form.Group className="mb-4">
                  <Form.Label className="flex items-center">Capital Per Lot (Naked) <HelpIcon article={strategyDefinitionHelpContent['strategyDef.capitalPerLotNaked']} /></Form.Label>
                  <Form.Control
                    type="number"
                    value={formData.capitalPerLotNaked}
                    onChange={(e) => setFormData({ ...formData, capitalPerLotNaked: parseInt(e.target.value) || 0 })}
                  />
                  <Form.Text className="text-ink-soft">When hedge is disabled</Form.Text>
                </Form.Group>
              </Col>
            </Row>
            {formData.product === 'POSITIONAL' && supportsHedging(formData.tradeMode) && (
            <Row>
              <Col md={6}>
                <Form.Group className="mb-4">
                  <Form.Check
                    type="switch"
                    label={<span className="flex items-center">Hedge Replace Enabled <HelpIcon article={strategyDefinitionHelpContent['strategyDef.hedgeReplaceEnabled']} /></span>}
                    checked={formData.hedgeReplaceEnabled}
                    onChange={(e) => setFormData({ ...formData, hedgeReplaceEnabled: e.target.checked })}
                  />
                  <Form.Text className="text-ink-soft">Enable automatic hedge replacement windows (morning/evening)</Form.Text>
                </Form.Group>
              </Col>
            </Row>
            )}
            {supportsHedging(formData.tradeMode) && (
            <Row>
              <Col md={6}>
                <Form.Group className="mb-4">
                  <Form.Label className="flex items-center">
                    {formData.product === 'POSITIONAL' && formData.hedgeReplaceEnabled ? 'Hedge % (Intraday)' : 'Hedge Distance'}
                    {(formData.product === 'INTRADAY' || formData.product === 'POSITIONAL') && <span className="text-danger-600 dark:text-danger-400"> *</span>}
                    {' '}<HelpIcon article={strategyDefinitionHelpContent[
                      formData.product === 'POSITIONAL' && formData.hedgeReplaceEnabled
                        ? 'strategyDef.hedgeDistancePercentageIntraday'
                        : 'strategyDef.hedgeDistancePercentage'
                    ]} />
                  </Form.Label>
                  <Form.Control
                    type="number"
                    step="0.01"
                    value={formData.hedgeDistancePercentageIntraday ?? ''}
                    onChange={(e) => setFormData({ ...formData, hedgeDistancePercentageIntraday: e.target.value ? parseFloat(e.target.value) : undefined })}
                    required={formData.product === 'INTRADAY' || formData.product === 'POSITIONAL'}
                    isInvalid={!!validationErrors.hedgeDistancePercentageIntraday}
                  />
                  {validationErrors.hedgeDistancePercentageIntraday && <Form.Control.Feedback type="invalid">{validationErrors.hedgeDistancePercentageIntraday}</Form.Control.Feedback>}
                </Form.Group>
              </Col>
              {formData.product === 'POSITIONAL' && formData.hedgeReplaceEnabled && (
              <Col md={6}>
                <Form.Group className="mb-4">
                  <Form.Label className="flex items-center">
                    Hedge % (Positional)
                    <span className="text-danger-600 dark:text-danger-400"> *</span>
                    {' '}<HelpIcon article={strategyDefinitionHelpContent['strategyDef.hedgeDistancePercentagePositional']} />
                  </Form.Label>
                  <Form.Control
                    type="number"
                    step="0.01"
                    value={formData.hedgeDistancePercentagePositional ?? ''}
                    onChange={(e) => setFormData({ ...formData, hedgeDistancePercentagePositional: e.target.value ? parseFloat(e.target.value) : undefined })}
                    required
                    isInvalid={!!validationErrors.hedgeDistancePercentagePositional}
                  />
                  {validationErrors.hedgeDistancePercentagePositional && <Form.Control.Feedback type="invalid">{validationErrors.hedgeDistancePercentagePositional}</Form.Control.Feedback>}
                </Form.Group>
              </Col>
              )}
            </Row>
            )}
            </div>
            )}

            {/* Risk Allocation Settings */}
            <div className="border rounded-md p-4 mb-4" style={{ borderColor: 'rgb(var(--c-hairline))' }}>
              <div className="text-ink-soft text-[0.875em] font-semibold mb-2" style={{ marginTop: '-1.5rem', background: 'rgb(var(--c-card))', width: 'fit-content', padding: '0 0.5rem' }}>
                Risk Allocation Settings
              </div>
              <Row>
                <Col md={3}>
                  <Form.Group className="mb-4">
                    <Form.Label className="flex items-center">Risk % of Capital <HelpIcon article={strategyDefinitionHelpContent['strategyDef.riskPercentage']} /></Form.Label>
                    <Form.Control
                      type="number"
                      step="0.1"
                      min={0}
                      max={100}
                      placeholder="e.g., 1.5 for 1.5%"
                      value={formData.riskPercentage ?? ''}
                      onChange={(e) => setFormData({ ...formData, riskPercentage: e.target.value ? parseFloat(e.target.value) : undefined })}
                    />
                    <Form.Text className="text-ink-soft">Default risk % per day for lot allocation</Form.Text>
                  </Form.Group>
                </Col>
                <Col md={3}>
                  <Form.Group className="mb-4">
                    <Form.Label className="flex items-center">Absolute Max Risk (₹) <HelpIcon article={strategyDefinitionHelpContent['strategyDef.absoluteMaxRisk']} /></Form.Label>
                    <Form.Control
                      type="number"
                      min={0}
                      placeholder="e.g., 15000"
                      value={formData.absoluteMaxRisk ?? ''}
                      onChange={(e) => setFormData({ ...formData, absoluteMaxRisk: e.target.value ? parseFloat(e.target.value) : undefined })}
                    />
                    <Form.Text className="text-ink-soft">Alternative: absolute max risk amount</Form.Text>
                  </Form.Group>
                </Col>
                <Col md={3}>
                  <Form.Group className="mb-4">
                    <Form.Label className="flex items-center">Min Risk % <HelpIcon article={strategyDefinitionHelpContent['strategyDef.minRiskPercentage']} /></Form.Label>
                    <Form.Control
                      type="number"
                      step="0.1"
                      min={0}
                      max={100}
                      placeholder="e.g., 0.5"
                      value={formData.minRiskPercentage ?? ''}
                      onChange={(e) => setFormData({ ...formData, minRiskPercentage: e.target.value ? parseFloat(e.target.value) : undefined })}
                    />
                    <Form.Text className="text-ink-soft">Floor for user override</Form.Text>
                  </Form.Group>
                </Col>
                <Col md={3}>
                  <Form.Group className="mb-4">
                    <Form.Label className="flex items-center">Max Risk % <HelpIcon article={strategyDefinitionHelpContent['strategyDef.maxRiskPercentage']} /></Form.Label>
                    <Form.Control
                      type="number"
                      step="0.1"
                      min={0}
                      max={100}
                      placeholder="e.g., 5.0"
                      value={formData.maxRiskPercentage ?? ''}
                      onChange={(e) => setFormData({ ...formData, maxRiskPercentage: e.target.value ? parseFloat(e.target.value) : undefined })}
                    />
                    <Form.Text className="text-ink-soft">Ceiling for user override</Form.Text>
                  </Form.Group>
                </Col>
              </Row>
              <Row>
                <Col md={3}>
                  <Form.Group className="mb-0">
                    <Form.Check
                      type="switch"
                      label={<span className="flex items-center">Overlap Capital <HelpIcon article={strategyDefinitionHelpContent['strategyDef.isOverlapCapital']} /></span>}
                      checked={formData.isOverlapCapital}
                      onChange={(e) => setFormData({ ...formData, isOverlapCapital: e.target.checked })}
                    />
                  </Form.Group>
                </Col>
              </Row>
            </div>

            {/* Equity Sizing & Leverage — replaces Capital & Hedge for equity strategies */}
            {isEquityMode(formData.tradeMode) && (
            <div className="border rounded-md p-4 mb-4" style={{ borderColor: 'rgb(var(--c-hairline))' }}>
              <div className="text-ink-soft text-[0.875em] font-semibold mb-2" style={{ marginTop: '-1.5rem', background: 'rgb(var(--c-card))', width: 'fit-content', padding: '0 0.5rem' }}>
                Equity Sizing &amp; Leverage
              </div>
              <Row>
                <Col md={4}>
                  <Form.Group className="mb-4">
                    <Form.Label className="flex items-center">Leverage <HelpIcon article={strategyDefinitionHelpContent['strategyDef.leverage']} /></Form.Label>
                    <Form.Control
                      type="number"
                      step="0.5"
                      min={1}
                      placeholder="1 (no leverage)"
                      value={formData.leverage ?? ''}
                      onChange={(e) => setFormData({ ...formData, leverage: e.target.value ? parseFloat(e.target.value) : undefined })}
                      isInvalid={!!validationErrors.leverage}
                    />
                    {validationErrors.leverage
                      ? <Form.Control.Feedback type="invalid">{validationErrors.leverage}</Form.Control.Feedback>
                      : <Form.Text className="text-ink-soft">{formData.product === 'CASHBUY' ? 'Cash Buy (CNC) always runs at 1× regardless of this value' : 'Buying power = capital × leverage'}</Form.Text>}
                  </Form.Group>
                </Col>
                <Col md={4}>
                  <Form.Group className="mb-4">
                    <Form.Label className="flex items-center">Min Leverage <HelpIcon article={strategyDefinitionHelpContent['strategyDef.minLeverage']} /></Form.Label>
                    <Form.Control
                      type="number"
                      step="0.5"
                      min={1}
                      value={formData.minLeverage ?? ''}
                      onChange={(e) => setFormData({ ...formData, minLeverage: e.target.value ? parseFloat(e.target.value) : undefined })}
                      isInvalid={!!validationErrors.minLeverage}
                    />
                    {validationErrors.minLeverage
                      ? <Form.Control.Feedback type="invalid">{validationErrors.minLeverage}</Form.Control.Feedback>
                      : <Form.Text className="text-ink-soft">Floor for user override</Form.Text>}
                  </Form.Group>
                </Col>
                <Col md={4}>
                  <Form.Group className="mb-4">
                    <Form.Label className="flex items-center">Max Leverage <HelpIcon article={strategyDefinitionHelpContent['strategyDef.maxLeverage']} /></Form.Label>
                    <Form.Control
                      type="number"
                      step="0.5"
                      min={1}
                      value={formData.maxLeverage ?? ''}
                      onChange={(e) => setFormData({ ...formData, maxLeverage: e.target.value ? parseFloat(e.target.value) : undefined })}
                    />
                    <Form.Text className="text-ink-soft">Ceiling for user override</Form.Text>
                  </Form.Group>
                </Col>
              </Row>
              <Row>
                <Col md={6}>
                  <Form.Group className="mb-4">
                    <Form.Label className="flex items-center">Sizing Model <HelpIcon article={strategyDefinitionHelpContent['strategyDef.equitySizingModel']} /></Form.Label>
                    <Form.Select
                      value={formData.equitySizingModel ?? ''}
                      onChange={(e) => setFormData({ ...formData, equitySizingModel: (e.target.value || undefined) as EquitySizingModel | undefined })}
                    >
                      <option value="">Select Sizing Model...</option>
                      {EQUITY_SIZING_MODELS.map((m) => (
                        <option key={m.value} value={m.value} title={m.description}>{m.label}</option>
                      ))}
                    </Form.Select>
                    <Form.Text className="text-ink-soft">
                      {EQUITY_SIZING_MODELS.find((m) => m.value === formData.equitySizingModel)?.description || 'How the per-stock quantity is computed'}
                    </Form.Text>
                  </Form.Group>
                </Col>
                {formData.equitySizingModel === 'FIXED_AMOUNT_PER_STOCK' && (
                  <Col md={6}>
                    <Form.Group className="mb-4">
                      <Form.Label className="flex items-center">Fixed Amount Per Stock (₹) <span className="text-danger-600 dark:text-danger-400">*</span> <HelpIcon article={strategyDefinitionHelpContent['strategyDef.fixedAmountPerStock']} /></Form.Label>
                      <Form.Control
                        type="number"
                        min={0}
                        value={formData.fixedAmountPerStock ?? ''}
                        onChange={(e) => setFormData({ ...formData, fixedAmountPerStock: e.target.value ? parseFloat(e.target.value) : undefined })}
                        isInvalid={!!validationErrors.fixedAmountPerStock}
                      />
                      {validationErrors.fixedAmountPerStock && <Form.Control.Feedback type="invalid">{validationErrors.fixedAmountPerStock}</Form.Control.Feedback>}
                    </Form.Group>
                  </Col>
                )}
                {formData.equitySizingModel === 'MAX_POSITIONS_EQUAL_SPLIT' && (
                  <Col md={6}>
                    <Form.Group className="mb-4">
                      <Form.Label className="flex items-center">Max Active Positions <span className="text-danger-600 dark:text-danger-400">*</span> <HelpIcon article={strategyDefinitionHelpContent['strategyDef.maxActivePositions']} /></Form.Label>
                      <Form.Control
                        type="number"
                        min={1}
                        value={formData.maxActivePositions ?? ''}
                        onChange={(e) => setFormData({ ...formData, maxActivePositions: e.target.value ? parseInt(e.target.value) : undefined })}
                        isInvalid={!!validationErrors.maxActivePositions}
                      />
                      {validationErrors.maxActivePositions
                        ? <Form.Control.Feedback type="invalid">{validationErrors.maxActivePositions}</Form.Control.Feedback>
                        : <Form.Text className="text-ink-soft">Buying power is split equally across this many slots</Form.Text>}
                    </Form.Group>
                  </Col>
                )}
                {formData.equitySizingModel === 'MAX_RISK_PER_TRADE' && (
                  <Col md={6}>
                    <Form.Group className="mb-4">
                      <Form.Label className="flex items-center">Max Risk % Per Trade <span className="text-danger-600 dark:text-danger-400">*</span> <HelpIcon article={strategyDefinitionHelpContent['strategyDef.maxRiskPctPerTrade']} /></Form.Label>
                      <Form.Control
                        type="number"
                        step="0.1"
                        min={0}
                        max={100}
                        placeholder="e.g., 1 for 1%"
                        value={formData.maxRiskPctPerTrade ?? ''}
                        onChange={(e) => setFormData({ ...formData, maxRiskPctPerTrade: e.target.value ? parseFloat(e.target.value) : undefined })}
                        isInvalid={!!validationErrors.maxRiskPctPerTrade}
                      />
                      {validationErrors.maxRiskPctPerTrade
                        ? <Form.Control.Feedback type="invalid">{validationErrors.maxRiskPctPerTrade}</Form.Control.Feedback>
                        : <Form.Text className="text-ink-soft">Quantity = risk budget / stop distance, capped by buying power</Form.Text>}
                    </Form.Group>
                  </Col>
                )}
              </Row>

            </div>
            )}

            {/* Section: Lifecycle */}
            <div className="border rounded-md p-4 mb-4" style={{ borderColor: 'rgb(var(--c-hairline))' }}>
              <div className="text-ink-soft text-[0.875em] font-semibold mb-2" style={{ marginTop: '-1.5rem', background: 'rgb(var(--c-card))', width: 'fit-content', padding: '0 0.5rem' }}>
                Lifecycle
              </div>
              <Row>
              <Col md={6}>
                <Form.Group className="mb-4">
                  <Form.Check
                    type="switch"
                    label={<span className="flex items-center">Catch Up Missed Tranches <HelpIcon article={strategyDefinitionHelpContent['strategyDef.catchUpMissedTranches']} /></span>}
                    checked={formData.catchUpMissedTranches}
                    onChange={(e) => setFormData({ ...formData, catchUpMissedTranches: e.target.checked })}
                  />
                  <Form.Text className="text-ink-soft">When reactivated, schedule missed tranches with 1-min gaps</Form.Text>
                </Form.Group>
              </Col>
              <Col md={6}>
                <Form.Group className="mb-4">
                  <Form.Check
                    type="switch"
                    label={<span className="flex items-center">Adaptive Tranches Enabled <HelpIcon article={strategyDefinitionHelpContent['strategyDef.adaptiveTranchesEnabled']} /></span>}
                    checked={formData.adaptiveTranchesEnabled}
                    disabled={formData.templateName === 'ADAPTIVE_OPTIONS' || formData.templateName === 'ZERODT_OPTIONS'}
                    onChange={(e) => setFormData({ ...formData, adaptiveTranchesEnabled: e.target.checked })}
                  />
                  <Form.Text className="text-ink-soft">
                    {formData.templateName === 'ADAPTIVE_OPTIONS'
                      ? 'Required for Adaptive Options — drives re-entry / signal-flip recovery via TranchCompleteEvent.'
                      : formData.templateName === 'ZERODT_OPTIONS'
                      ? 'Required for ZeroDT Options — drives adaptive tranch advancement (loss/profit/max-tranches caps) via TranchCompleteEvent.'
                      : 'Tranch 2+ triggered when previous tranch exits'}
                  </Form.Text>
                </Form.Group>
              </Col>
            </Row>
              {isEquityMode(formData.tradeMode) && (
              <Row>
                <Col md={6}>
                  <Form.Group className="mb-4">
                    <Form.Label className="flex items-center">On Index Removal <HelpIcon article={strategyDefinitionHelpContent['strategyDef.onIndexRemoval']} /></Form.Label>
                    <Form.Select
                      value={formData.onIndexRemoval ?? ''}
                      onChange={(e) => setFormData({ ...formData, onIndexRemoval: (e.target.value || undefined) as OnIndexRemoval | undefined })}
                    >
                      <option value="">Default (Hold Until Exit)</option>
                      {ON_INDEX_REMOVAL_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value} title={o.description}>{o.label}</option>
                      ))}
                    </Form.Select>
                    <Form.Text className="text-ink-soft">Open-position policy when a stock drops out of a predefined index universe</Form.Text>
                  </Form.Group>
                </Col>
              </Row>
              )}
            </div>
            {/* Hedge Replace - only for POSITIONAL options (not FUTURES) */}
            {formData.product === 'POSITIONAL' && supportsHedging(formData.tradeMode) && (
              <div className="border rounded-md p-4 mb-4" style={{ borderColor: 'rgb(var(--c-hairline))' }}>
                <div className="text-ink-soft text-[0.875em] font-semibold mb-2" style={{ marginTop: '-1.5rem', background: 'rgb(var(--c-card))', width: 'fit-content', padding: '0 0.5rem' }}>
                  Hedge Replace Settings
                </div>
                {formData.hedgeReplaceEnabled && (
                  <Row>
                    <Col md={3}>
                      <Form.Group className="mb-0">
                        <Form.Label className="flex items-center">Morning Start (min after open) <HelpIcon article={strategyDefinitionHelpContent['strategyDef.hedgeMorningStartOffset']} /></Form.Label>
                        <Form.Control
                          type="number"
                          min={0}
                          max={60}
                          placeholder="1 (default)"
                          value={formData.hedgeMorningStartOffset ?? ''}
                          onChange={(e) => setFormData({ ...formData, hedgeMorningStartOffset: e.target.value ? parseInt(e.target.value) : undefined })}
                        />
                      </Form.Group>
                    </Col>
                    <Col md={3}>
                      <Form.Group className="mb-0">
                        <Form.Label className="flex items-center">Morning End (min after open) <HelpIcon article={strategyDefinitionHelpContent['strategyDef.hedgeMorningEndOffset']} /></Form.Label>
                        <Form.Control
                          type="number"
                          min={0}
                          max={60}
                          placeholder="15 (default)"
                          value={formData.hedgeMorningEndOffset ?? ''}
                          onChange={(e) => setFormData({ ...formData, hedgeMorningEndOffset: e.target.value ? parseInt(e.target.value) : undefined })}
                        />
                      </Form.Group>
                    </Col>
                    <Col md={3}>
                      <Form.Group className="mb-0">
                        <Form.Label className="flex items-center">Evening Start (min before close) <HelpIcon article={strategyDefinitionHelpContent['strategyDef.hedgeEveningStartOffset']} /></Form.Label>
                        <Form.Control
                          type="number"
                          min={0}
                          max={60}
                          placeholder="10 (default)"
                          value={formData.hedgeEveningStartOffset ?? ''}
                          onChange={(e) => setFormData({ ...formData, hedgeEveningStartOffset: e.target.value ? parseInt(e.target.value) : undefined })}
                        />
                      </Form.Group>
                    </Col>
                    <Col md={3}>
                      <Form.Group className="mb-0">
                        <Form.Label className="flex items-center">Evening End (min before close) <HelpIcon article={strategyDefinitionHelpContent['strategyDef.hedgeEveningEndOffset']} /></Form.Label>
                        <Form.Control
                          type="number"
                          min={0}
                          max={60}
                          placeholder="2 (default)"
                          value={formData.hedgeEveningEndOffset ?? ''}
                          onChange={(e) => setFormData({ ...formData, hedgeEveningEndOffset: e.target.value ? parseInt(e.target.value) : undefined })}
                        />
                      </Form.Group>
                    </Col>
                  </Row>
                )}
              </div>
            )}

            {/* Section: Visibility & Admin */}
            <div className="border rounded-md p-4 mb-4" style={{ borderColor: 'rgb(var(--c-hairline))' }}>
              <div className="text-ink-soft text-[0.875em] font-semibold mb-2" style={{ marginTop: '-1.5rem', background: 'rgb(var(--c-card))', width: 'fit-content', padding: '0 0.5rem' }}>
                Visibility & Admin
              </div>
              <Row>
                <Col md={3}>
                  <Form.Group className="mb-0">
                    <Form.Check
                      type="switch"
                      label={<span className="flex items-center"><BsGlobe className="me-1" />Public <HelpIcon article={strategyDefinitionHelpContent['strategyDef.isPublic']} /></span>}
                      checked={formData.isPublic}
                      onChange={(e) => setFormData({ ...formData, isPublic: e.target.checked })}
                    />
                    <Form.Text className="text-ink-soft">Visible to all users</Form.Text>
                  </Form.Group>
                </Col>
                <Col md={3}>
                  <Form.Group className="mb-0">
                    <Form.Label className="flex items-center">Scope <HelpIcon article={strategyDefinitionHelpContent['strategyDef.scope']} /></Form.Label>
                    <Form.Select
                      value={formData.scope || 'SYSTEM'}
                      onChange={(e) => setFormData({ ...formData, scope: e.target.value as 'SYSTEM' | 'USER' })}
                    >
                      <option value="SYSTEM">SYSTEM</option>
                      <option value="USER">USER</option>
                    </Form.Select>
                    <Form.Text className="text-ink-soft">
                      SYSTEM: Admin-assigned only. USER: Self-subscribe allowed
                    </Form.Text>
                  </Form.Group>
                </Col>
                <Col md={3}>
                  <Form.Group className="mb-0">
                    <Form.Check
                      type="switch"
                      label={<span className="flex items-center">Mock Strategy</span>}
                      checked={!!formData.isMock}
                      onChange={(e) => {
                        const isMock = e.target.checked;
                        // Mock sessions are always intraday — auto-set
                        // product when the toggle goes on. The Product
                        // dropdown is then disabled while isMock=true.
                        setFormData({
                          ...formData,
                          isMock,
                          product: isMock ? 'INTRADAY' : formData.product,
                        });
                      }}
                    />
                    <Form.Text className="text-ink-soft">Runs only during admin-toggled mock sessions</Form.Text>
                  </Form.Group>
                </Col>
              <Col md={3}>
                <Form.Group className="mb-4">
                  <Form.Label className="flex items-center">Display Order <HelpIcon article={strategyDefinitionHelpContent['strategyDef.displayOrder']} /></Form.Label>
                  <Form.Control
                    type="number"
                    value={formData.displayOrder}
                    onChange={(e) => setFormData({ ...formData, displayOrder: parseInt(e.target.value) || 0 })}
                  />
                </Form.Group>
              </Col>
              </Row>
            </div>


          </fieldset>
          </Modal.Body>
          <Modal.Footer>
            <Button variant="secondary" onClick={handleCloseEditModal}>{editModalReadOnly ? 'Close' : 'Cancel'}</Button>
            {!editModalReadOnly && (
              <Button variant="primary" type="submit" disabled={updateMutation.isPending || indicatorRulesLoading || !isFormValid()}>
                {updateMutation.isPending ? <><Spinner size="sm" className="me-2" />Saving...</> : indicatorRulesLoading ? <><Spinner size="sm" className="me-2" />Loading Rules...</> : 'Save Changes'}
              </Button>
            )}
          </Modal.Footer>
        </Form>
      </Modal>

      {/* Delete Confirmation Modal */}
      <Modal show={showDeleteModal} onHide={handleCloseDeleteModal}>
        <Modal.Header closeButton>
          <Modal.Title className="text-danger-600 dark:text-danger-400">
            <BsTrash className="me-2" />
            Delete Definition
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Alert variant="warning">
            Are you sure you want to delete this strategy definition?
          </Alert>
          {selectedDefinition && (
            <div className="p-4 bg-raised rounded-md">
              <p className="mb-1"><strong>Name:</strong> <code>{selectedDefinition.strategyName}</code></p>
              <p className="mb-1"><strong>Symbol:</strong> {selectedDefinition.fnoSymbolName}</p>
              <p className="mb-0"><strong>Template:</strong> {selectedDefinition.templateName}</p>
            </div>
          )}
          <p className="mt-4 text-danger-600 dark:text-danger-400 mb-0">
            <strong>Warning:</strong> This will also remove related subscriptions and schedules.
          </p>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={handleCloseDeleteModal}>Cancel</Button>
          <Button variant="danger" onClick={handleDelete} disabled={deleteMutation.isPending}>
            {deleteMutation.isPending ? <><Spinner size="sm" className="me-2" />Deleting...</> : 'Delete'}
          </Button>
        </Modal.Footer>
      </Modal>

      {/* ==================== Import Modal ==================== */}
      <Modal show={showImportModal} onHide={resetImportModal} size="lg">
        <Modal.Header closeButton>
          <Modal.Title>
            <BsUpload className="me-2" />
            Import Strategy Definitions
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {/* Step 1: Upload File */}
          {importStep === 1 && (
            <div>
              <p className="text-ink-soft">
                Upload an Excel (.xlsx) file exported from another Garuda instance.
                The file should contain sheets: STRATEGY_DEFINITIONS, STRATEGY_CONFIG_TREE, STRATEGY_INDICATOR_RULES.
              </p>
              <Form.Group className="mb-4">
                <Form.Label>Select File</Form.Label>
                <Form.Control
                  type="file"
                  accept=".xlsx"
                  onChange={(e) => {
                    const input = e.target as HTMLInputElement;
                    setImportFile(input.files?.[0] || null);
                  }}
                />
              </Form.Group>
            </div>
          )}

          {/* Step 2: Preview & Resolve Conflicts */}
          {importStep === 2 && importPreview && (
            <div>
              {importPreview.errors.length > 0 && (
                <Alert variant="danger">
                  <strong>Errors found — cannot import:</strong>
                  <ul className="mb-0 mt-1">
                    {importPreview.errors.map((err, i) => <li key={i}>{err}</li>)}
                  </ul>
                </Alert>
              )}

              {importPreview.warnings.length > 0 && (
                <Alert variant="warning">
                  <strong>Warnings:</strong>
                  <ul className="mb-0 mt-1">
                    {importPreview.warnings.map((w, i) => <li key={i}>{w}</li>)}
                  </ul>
                </Alert>
              )}

              <div className="mb-4">
                <small className="text-ink-soft">
                  Config tree entries: {importPreview.configTreeEntries} | Indicator rules: {importPreview.indicatorRulesEntries}
                </small>
              </div>

              {importPreview.newStrategies.length > 0 && (
                <div className="mb-4">
                  <h6 className="text-success-500 dark:text-success-400">New Strategies ({importPreview.newStrategies.length})</h6>
                  <div className="flex flex-wrap gap-1">
                    {importPreview.newStrategies.map(name => (
                      <Badge key={name} bg="success">{name}</Badge>
                    ))}
                  </div>
                </div>
              )}

              {importPreview.conflictingStrategies.length > 0 && (
                <div className="mb-4">
                  <div className="flex justify-between items-center mb-2">
                    <h6 className="text-warning-700 dark:text-warning-400 mb-0">Conflicts ({importPreview.conflictingStrategies.length})</h6>
                    <div className="flex gap-2">
                      <Button size="sm" variant="outline-danger" onClick={() => handleBulkResolution('OVERRIDE')}>
                        Override All
                      </Button>
                      <Button size="sm" variant="outline-secondary" onClick={() => handleBulkResolution('SKIP')}>
                        Skip All
                      </Button>
                    </div>
                  </div>
                  <Table size="sm" bordered>
                    <thead>
                      <tr>
                        <th>Strategy Name</th>
                        <th style={{ width: '200px' }}>Resolution</th>
                      </tr>
                    </thead>
                    <tbody>
                      {importPreview.conflictingStrategies.map(name => (
                        <tr key={name}>
                          <td><code>{name}</code></td>
                          <td>
                            <div className="flex gap-2">
                              <Form.Check
                                type="radio"
                                label="Override"
                                name={`resolution-${name}`}
                                checked={importResolutions[name] === 'OVERRIDE'}
                                onChange={() => setImportResolutions(prev => ({ ...prev, [name]: 'OVERRIDE' }))}
                              />
                              <Form.Check
                                type="radio"
                                label="Skip"
                                name={`resolution-${name}`}
                                checked={importResolutions[name] === 'SKIP'}
                                onChange={() => setImportResolutions(prev => ({ ...prev, [name]: 'SKIP' }))}
                              />
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </div>
              )}
            </div>
          )}

          {/* Step 3: Results */}
          {importStep === 3 && importResult && (
            <div>
              <Alert variant={importResult.errors.length > 0 ? 'warning' : 'success'}>
                <h6>Import Complete</h6>
                <ul className="mb-0">
                  <li><strong>{importResult.imported}</strong> new strategies imported</li>
                  <li><strong>{importResult.overridden}</strong> strategies overridden</li>
                  <li><strong>{importResult.skipped}</strong> strategies skipped</li>
                </ul>
              </Alert>
              {importResult.errors.length > 0 && (
                <Alert variant="danger">
                  <strong>Errors:</strong>
                  <ul className="mb-0 mt-1">
                    {importResult.errors.map((err, i) => <li key={i}>{err}</li>)}
                  </ul>
                </Alert>
              )}
            </div>
          )}
        </Modal.Body>
        <Modal.Footer>
          {importStep === 1 && (
            <>
              <Button variant="secondary" onClick={resetImportModal}>Cancel</Button>
              <Button
                variant="primary"
                onClick={handleImportPreview}
                disabled={!importFile || importLoading}
              >
                {importLoading ? <><Spinner size="sm" className="me-2" />Uploading...</> : 'Upload & Preview'}
              </Button>
            </>
          )}
          {importStep === 2 && (
            <>
              <Button variant="secondary" onClick={() => { setImportStep(1); setImportPreview(null); }}>Back</Button>
              <Button
                variant="primary"
                onClick={handleImportApply}
                disabled={importLoading || (importPreview?.errors?.length ?? 0) > 0}
              >
                {importLoading ? <><Spinner size="sm" className="me-2" />Applying...</> : 'Apply Import'}
              </Button>
            </>
          )}
          {importStep === 3 && (
            <Button variant="primary" onClick={resetImportModal}>Close</Button>
          )}
        </Modal.Footer>
      </Modal>
    </Card>
  );
};

export default StrategyDefinitions;
