/**
 * Strategy Config Tree Page
 * Hierarchical configuration management for strategy settings
 * with priority-based overrides (user, broker, tranch, day)
 */

import { useState, useMemo, useEffect } from 'react';
import {
  Card,
  Table,
  Badge,
  Button,
  Form,
  Modal,
  Spinner,
  Alert,
  InputGroup,
  Row,
  Col,
  Tab,
  Tabs,
} from '@/components/ui/rbShim';
import {
  BsPlus,
  BsTrash,
  BsSearch,
  BsPencil,
  BsEye,
  BsGear,
  BsLayersHalf,
  BsListOl,
} from 'react-icons/bs';
import { toast } from 'react-toastify';
import Select from 'react-select';
import { PageHeader, ConfirmModal, HelpIcon } from '@/components/common';
import TablePagination from '@/components/common/TablePagination';
import { DEFAULT_PAGE_SIZE } from '@/types/pagination';
import UserSelect from '@/components/common/UserSelect';
import { strategyConfigTreeHelpContent } from '@/data/help';
import { usePermissions } from '@/hooks/usePermissions';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  strategyConfigTreeService,
  userManagementService,
  strategyPolicyService,
} from '@/services/admin/v2AdminService';
import { strategyDefinitionService, strategyTemplateService } from '@/services/admin/strategyEngineService';
import type {
  StrategyConfigTree,
  CreateStrategyConfigTreeRequest,
  DayConditionType,
  LotAllocationMode,
} from '@/types/strategy-config-tree';
import {
  DAY_CONDITIONS,
  LOT_ALLOCATION_MODES,
  getScopeDescription,
  getPriorityColor,
  getPriorityLabel,
  calculatePriority,
  BREAKOUT_WATCH_TYPES,
  BREAKOUT_DIRECTIONS,
  BREAKOUT_TRIGGER_MODES,
  EXIT_TIME_ENTRY_TIME,
} from '@/types/strategy-config-tree';
import type {
  BreakoutWatchType,
  BreakoutDirection,
  BreakoutTriggerMode,
  UpdateStrategyConfigTreeRequest,
} from '@/types/strategy-config-tree';
import type { StrategyDefinition, StrategyTemplate } from '@/types/strategy-engine';
import type { User } from '@/types/user_mgmt';
import type {
  OrderFillEscalationPolicy,
  TrailingSLPolicy,
  SLTargetPolicy,
  StrikeSelectionPolicy,
  ExitPolicy,
} from '@/types/strategy-policies';

const helpContent = strategyConfigTreeHelpContent;

const supportsHedging = (tradeMode?: StrategyDefinition['tradeMode']): boolean => {
  // Futures hedging is not supported in backend yet. Enable this for FUTURES later
  // when strategy config and execution support that trade mode end-to-end.
  return tradeMode === 'OPTION_SELLING';
};

// Strike value options
const STRIKE_VALUE_OPTIONS = [
  { value: 'ITM-5', label: 'ITM-5 (5 strikes In The Money)' },
  { value: 'ITM-4', label: 'ITM-4 (4 strikes In The Money)' },
  { value: 'ITM-3', label: 'ITM-3 (3 strikes In The Money)' },
  { value: 'ITM-2', label: 'ITM-2 (2 strikes In The Money)' },
  { value: 'ITM-1', label: 'ITM-1 (1 strike In The Money)' },
  { value: 'ATM', label: 'ATM (At The Money)' },
  { value: 'OTM+1', label: 'OTM+1 (1 strike Out of The Money)' },
  { value: 'OTM+2', label: 'OTM+2 (2 strikes Out of The Money)' },
  { value: 'OTM+3', label: 'OTM+3 (3 strikes Out of The Money)' },
  { value: 'OTM+4', label: 'OTM+4 (4 strikes Out of The Money)' },
  { value: 'OTM+5', label: 'OTM+5 (5 strikes Out of The Money)' },
];

// Time format validation
const TIME_FORMAT_REGEX = /^([01]?[0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]$/;

const validateTimeFormat = (value: string | null | undefined): boolean => {
  if (!value) return true; // Empty is valid (optional field)
  return TIME_FORMAT_REGEX.test(value);
};

// Default trail config values per type
const getDefaultTrailConfig = (trailType: string | null, includeCombined: boolean = false): string => {
  const baseConfig: Record<string, unknown> = {};

  switch (trailType) {
    case 'ATR':
      baseConfig.period = 21;
      baseConfig.multiplier = 4.0;
      break;
    case 'SUPER_TREND':
      baseConfig.period = 10;
      baseConfig.multiplier = 3;
      break;
    case 'EMA':
      baseConfig.period = 13;
      baseConfig.bufferPercentage = 0.05;
      break;
    case 'HEIKIN_ASHI':
      baseConfig.maxDistancePercentage = 1.25;
      break;
    case 'RISK_MULTIPLE':
      baseConfig.profitGap = 10;
      baseConfig.slMoveGap = 5;
      baseConfig.trailMode = 'absolute'; // 'absolute' (points) or 'percentage' (% of entry)
      break;
    case 'CUSTOM':
      // CUSTOM type: no defaults, user provides all config
      break;
    default:
      return '';
  }

  if (includeCombined) {
    baseConfig.combinedProfitGap = 5;
    baseConfig.combinedSlMoveGap = 2.5;
    baseConfig.combinedTrailMode = 'percentage'; // 'percentage' (% of premium) or 'absolute' (rupees)
  }

  return JSON.stringify(baseConfig, null, 2);
};

// Merge combined config into existing trail config
const mergeTrailConfigWithCombined = (existingConfig: string | null | undefined, addCombined: boolean): string => {
  let config: Record<string, unknown> = {};

  // Parse existing config
  if (existingConfig) {
    try {
      config = JSON.parse(existingConfig);
    } catch {
      config = {};
    }
  }

  if (addCombined) {
    // Add combined fields if not present
    if (!('combinedProfitGap' in config)) {
      config.combinedProfitGap = 5;
    }
    if (!('combinedSlMoveGap' in config)) {
      config.combinedSlMoveGap = 2.5;
    }
    if (!('combinedTrailMode' in config)) {
      config.combinedTrailMode = 'percentage'; // 'percentage' (% of premium) or 'absolute' (rupees)
    }
  } else {
    // Remove combined fields
    delete config.combinedProfitGap;
    delete config.combinedSlMoveGap;
    delete config.combinedTrailMode;
  }

  return Object.keys(config).length > 0 ? JSON.stringify(config, null, 2) : '';
};

// Merge trail-to-cost config into existing trail config
const mergeTrailConfigWithTrailToCost = (existingConfig: string | null | undefined, addTrailToCost: boolean): string => {
  let config: Record<string, unknown> = {};

  // Parse existing config
  if (existingConfig) {
    try {
      config = JSON.parse(existingConfig);
    } catch {
      config = {};
    }
  }

  if (addTrailToCost) {
    // Add trail-to-cost fields if not present
    if (!('trailToCostProfitGap' in config)) {
      config.trailToCostProfitGap = 1.0; // Default: 1R profit
    }
    if (!('trailToCostMode' in config)) {
      config.trailToCostMode = 'risk_multiple'; // 'risk_multiple', 'absolute', 'percentage'
    }
  } else {
    // Remove trail-to-cost fields
    delete config.trailToCostProfitGap;
    delete config.trailToCostMode;
  }

  return Object.keys(config).length > 0 ? JSON.stringify(config, null, 2) : '';
};

// ==================== CONFIG LIST PANEL ====================
const ConfigListPanel: React.FC<{
  canEdit: boolean;
  canManage: boolean;
}> = ({ canEdit, canManage }) => {
  const [search, setSearch] = useState('');
  // Search is applied server-side (debounced) so it matches across the whole tree.
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);
  const [strategyFilter, setStrategyFilter] = useState('');
  const [priorityFilter, setPriorityFilter] = useState<number | ''>('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [showModal, setShowModal] = useState(false);
  const [editingConfig, setEditingConfig] = useState<StrategyConfigTree | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [configToDelete, setConfigToDelete] = useState<StrategyConfigTree | null>(null);
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});

  // Bulk add tranches state
  const [showBulkModal, setShowBulkModal] = useState(false);
  const [bulkStrategyName, setBulkStrategyName] = useState('');
  const [bulkUsername, setBulkUsername] = useState<string | null>(null);
  const [bulkBroker, setBulkBroker] = useState<string | null>(null);
  const [bulkTranches, setBulkTranches] = useState<Array<{
    tranchNumber: number | '';
    tranchTiming: string;
    tranchCutoffTime: string;
    lotsPerTranch: number | '';
  }>>([{ tranchNumber: 1, tranchTiming: '', tranchCutoffTime: '', lotsPerTranch: '' }]);
  const [bulkCreating, setBulkCreating] = useState(false);
  const queryClient = useQueryClient();

  // Reset to the first page whenever a filter / search / page size changes.
  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, strategyFilter, priorityFilter, pageSize]);

  // Fetch one PAGE of configs for the table — search/strategy/priority filters and
  // ordering are applied server-side, so the browser never loads the whole tree.
  const { data: pageData, isLoading, error: configsError } = useQuery({
    queryKey: ['admin', 'strategyConfigTree', 'page', page, pageSize, debouncedSearch, strategyFilter, priorityFilter],
    queryFn: () => strategyConfigTreeService.getPaginated({
      page,
      pageSize,
      search: debouncedSearch || undefined,
      strategyName: strategyFilter || undefined,
      priority: priorityFilter === '' ? undefined : priorityFilter,
    }),
  });
  const tableConfigs = useMemo(() => pageData?.data ?? [], [pageData]);
  const pagination = pageData?.pagination;

  // Base (scope-less) configs for the Clone-From picker — small, one row per strategy.
  const { data: baseConfigs } = useQuery({
    queryKey: ['admin', 'strategyConfigTree', 'base'],
    queryFn: () => strategyConfigTreeService.getBaseConfigs(),
  });

  // Distinct strategy names for the filter dropdown.
  const { data: strategyNames } = useQuery({
    queryKey: ['admin', 'strategyConfigTree', 'strategy-names'],
    queryFn: () => strategyConfigTreeService.getStrategyNames(),
  });

  const { data: strategies, error: strategiesError } = useQuery({
    queryKey: ['admin', 'strategyDefinitions', 'active'],
    queryFn: () => strategyDefinitionService.getActive(),
  });

  // Fetch templates to check supportTranches property
  const { data: templates } = useQuery({
    queryKey: ['admin', 'strategyTemplates'],
    queryFn: () => strategyTemplateService.getAll(),
  });

  // Fetch users with their brokers embedded
  const { data: users, error: usersError } = useQuery({
    queryKey: ['admin', 'users'],
    queryFn: () => userManagementService.getUsers(),
  });

  // Fetch policies for dropdowns
  const { data: orderFillPolicies } = useQuery({
    queryKey: ['admin', 'policies', 'order-fill'],
    queryFn: () => strategyPolicyService.orderFill.getAll(),
  });

  const { data: trailingSLPolicies } = useQuery({
    queryKey: ['admin', 'policies', 'trailing-sl'],
    queryFn: () => strategyPolicyService.trailingSL.getAll(),
  });

  const { data: slTargetPolicies } = useQuery({
    queryKey: ['admin', 'policies', 'sl-target'],
    queryFn: () => strategyPolicyService.slTarget.getAll(),
  });

  const { data: strikePolicies } = useQuery({
    queryKey: ['admin', 'policies', 'strike'],
    queryFn: () => strategyPolicyService.strike.getAll(),
  });

  const { data: exitPolicies } = useQuery({
    queryKey: ['admin', 'policies', 'exit'],
    queryFn: () => strategyPolicyService.exit.getAll(),
  });

  // Show toast for query errors
  useEffect(() => {
    if (configsError) {
      const errorMessage = (configsError as { message?: string })?.message || 'Failed to load configurations';
      toast.error(errorMessage);
    }
  }, [configsError]);

  useEffect(() => {
    if (strategiesError) {
      const errorMessage = (strategiesError as { message?: string })?.message || 'Failed to load strategy definitions';
      toast.error(errorMessage);
    }
  }, [strategiesError]);

  useEffect(() => {
    if (usersError) {
      const errorMessage = (usersError as { message?: string })?.message || 'Failed to load users';
      toast.error(errorMessage);
    }
  }, [usersError]);

  // Form state
  const [formData, setFormData] = useState<CreateStrategyConfigTreeRequest>({
    strategyName: '',
  });

  // Real-time duplicate validation when scope fields change. Checked SERVER-SIDE
  // (existsByScope) so it sees the whole tree, not just the loaded page. Debounced
  // + cancellable to avoid races; the POST still 409s on a real conflict.
  useEffect(() => {
    const clearDuplicateError = () =>
      setValidationErrors((prev) => {
        if (prev.strategyName?.includes('already exists')) {
          const { strategyName, ...rest } = prev;
          return rest;
        }
        return prev;
      });

    // Only validate when creating new (not editing) and strategy is selected
    if (editingConfig || !formData.strategyName) {
      clearDuplicateError();
      return;
    }

    let cancelled = false;
    const handle = setTimeout(() => {
      strategyConfigTreeService
        .checkExists({
          strategyName: formData.strategyName,
          username: formData.username || null,
          broker: formData.broker || null,
          tranchNumber: formData.tranchNumber ?? null,
          dayCondition: formData.dayCondition || null,
        })
        .then((exists) => {
          if (cancelled) return;
          if (!exists) {
            clearDuplicateError();
            return;
          }
          const scopeParts: string[] = [];
          if (formData.username) scopeParts.push(`User: ${formData.username}`);
          if (formData.broker) scopeParts.push(`Broker: ${formData.broker}`);
          if (formData.tranchNumber != null) scopeParts.push(`Tranch: ${formData.tranchNumber}`);
          if (formData.dayCondition) scopeParts.push(`Day: ${formData.dayCondition}`);

          const strategyDisplay = strategies?.find((s: StrategyDefinition) => s.strategyName === formData.strategyName);
          const displayName = strategyDisplay?.displayName || formData.strategyName;

          const scopeDesc = scopeParts.length > 0
            ? `with scope [${scopeParts.join(', ')}]`
            : '(P0 Base)';

          setValidationErrors((prev) => ({
            ...prev,
            strategyName: `Configuration for "${displayName}" ${scopeDesc} already exists`,
          }));
        })
        .catch(() => {
          // Network/validation hiccup — don't block the form; the POST enforces uniqueness.
          if (!cancelled) clearDuplicateError();
        });
    }, 300);

    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [
    editingConfig,
    formData.strategyName,
    formData.username,
    formData.broker,
    formData.tranchNumber,
    formData.dayCondition,
    strategies,
  ]);

  // Inline field-level validation — runs on every form change
  useEffect(() => {
    setValidationErrors((prev) => {
      const errors: Record<string, string> = {};

      // Preserve duplicate-scope error (managed by the other useEffect)
      if (prev.strategyName?.includes('already exists')) {
        errors.strategyName = prev.strategyName;
      }

      // Time format
      if (formData.tranchTiming && !validateTimeFormat(formData.tranchTiming)) {
        errors.tranchTiming = 'Format: HH:mm:ss';
      }
      if (formData.tranchCutoffTime && !validateTimeFormat(formData.tranchCutoffTime)) {
        errors.tranchCutoffTime = 'Format: HH:mm:ss';
      }

      // SL / Target > 0
      if (formData.slPercentage !== null && formData.slPercentage !== undefined && formData.slPercentage <= 0) {
        errors.slPercentage = 'SL % must be greater than 0';
      }
      if (formData.targetPercentage !== null && formData.targetPercentage !== undefined && formData.targetPercentage <= 0) {
        errors.targetPercentage = 'Target % must be greater than 0';
      }
      if (formData.combinedSLPercentage !== null && formData.combinedSLPercentage !== undefined && formData.combinedSLPercentage <= 0) {
        errors.combinedSLPercentage = 'Combined SL % must be greater than 0';
      }
      if (formData.combinedTargetPercentage !== null && formData.combinedTargetPercentage !== undefined && formData.combinedTargetPercentage <= 0) {
        errors.combinedTargetPercentage = 'Combined Target % must be greater than 0';
      }

      // Option premium
      if (formData.optionPremium !== null && formData.optionPremium !== undefined && formData.optionPremium < 1) {
        errors.optionPremium = 'Option Premium must be at least 1';
      }

      // PremiumRange
      if (formData.strikeType === 'PremiumRange') {
        if (!formData.optionPremium) errors.optionPremium = 'Lower bound required for PremiumRange';
        if (!formData.optionPremiumUpper) errors.optionPremiumUpper = 'Upper bound required for PremiumRange';
        if (formData.optionPremium && formData.optionPremiumUpper && formData.optionPremiumUpper <= formData.optionPremium) {
          errors.optionPremiumUpper = 'Upper bound must be greater than lower';
        }
      }

      // PremiumRange_OIRanked
      if (formData.strikeType === 'PremiumRange_OIRanked') {
        if (!formData.optionPremium) errors.optionPremium = 'Lower bound required for PremiumRange_OIRanked';
        if (!formData.optionPremiumUpper) errors.optionPremiumUpper = 'Upper bound required for PremiumRange_OIRanked';
        if (formData.optionPremium && formData.optionPremiumUpper && formData.optionPremiumUpper <= formData.optionPremium) {
          errors.optionPremiumUpper = 'Upper bound must be greater than lower';
        }
      }

      // CandleLow_NearPremium
      if (formData.strikeType === 'CandleLow_NearPremium') {
        if (!formData.optionPremium) errors.optionPremium = 'Target premium required for CandleLow_NearPremium';
        if (!formData.lookbackMinutes || formData.lookbackMinutes < 5) errors.lookbackMinutes = 'Lookback minutes required (min: 5)';
        if (!formData.otmLevels || formData.otmLevels < 1) errors.otmLevels = 'Strike levels required (min: 1)';
      }

      // Tranch gaps
      if (formData.minTranchGap !== null && formData.minTranchGap !== undefined && formData.minTranchGap < 1) {
        errors.minTranchGap = 'Min gap must be at least 1 minute';
      }
      if (formData.tranchGap !== null && formData.tranchGap !== undefined && formData.tranchGap < 1) {
        errors.tranchGap = 'Tranch gap must be at least 1 minute';
      }
      if (formData.minTranchGap && formData.tranchGap && formData.minTranchGap > formData.tranchGap) {
        errors.minTranchGap = 'Min gap must be <= tranch gap';
      }

      // Lots
      if (formData.lotsPerTranch !== null && formData.lotsPerTranch !== undefined && formData.lotsPerTranch < 1) {
        errors.lotsPerTranch = 'Lots per tranch must be at least 1';
      }

      if (formData.maxTranches !== null && formData.maxTranches !== undefined && formData.maxTranches < 1) {
        errors.maxTranches = 'Max tranches must be at least 1';
      }

      if (formData.globalAllocationTranches !== null && formData.globalAllocationTranches !== undefined && formData.globalAllocationTranches < 1) {
        errors.globalAllocationTranches = 'Global allocation tranches must be at least 1';
      }

      if (formData.allocationStartTranch !== null && formData.allocationStartTranch !== undefined && formData.allocationStartTranch < 1) {
        errors.allocationStartTranch = 'Allocation start tranch must be at least 1';
      }

      if (formData.lotAllocationMode === 'GLOBAL_SHARED') {
        if (!formData.globalAllocationTranches) {
          errors.globalAllocationTranches = 'Global allocation tranches is required for Global Shared mode';
        }
        if (!formData.allocationStartTranch) {
          errors.allocationStartTranch = 'Allocation start tranch is required for Global Shared mode';
        }
        if (
          formData.maxTranches &&
          formData.globalAllocationTranches &&
          formData.allocationStartTranch &&
          formData.allocationStartTranch + formData.maxTranches - 1 > formData.globalAllocationTranches
        ) {
          errors.allocationStartTranch = 'Start tranch + max tranches exceeds global allocation tranches';
        }
      }

      return errors;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formData]);

  // Prepare options for react-select dropdowns
  const strategyOptions = useMemo(() => {
    return (strategies || []).map((s: StrategyDefinition) => ({
      value: s.strategyName,
      label: `${s.displayName || s.strategyName} (${s.strategyName})`,
    }));
  }, [strategies]);

  // Get selected strategy definition
  const selectedStrategy = useMemo(() => {
    if (!formData.strategyName || !strategies) return null;
    return (strategies as StrategyDefinition[]).find((s) => s.strategyName === formData.strategyName) || null;
  }, [formData.strategyName, strategies]);

  // Equity strategies hide all option-chain-only config (strikes, premiums,
  // expiry day-conditions) and restrict breakout watches to the UNDERLYING type.
  const isEquityStrategy = selectedStrategy?.tradeMode === 'EQUITY';

  // A combo strategy declares its legs in the spec, so strike selection (MoneyNess and every
  // dependent) does not apply: the option hedge's strike comes from the strategy's hedge distance,
  // and the tranch hedging toggle is superseded by the spec's HEDGE leg. Expiry-relative day
  // conditions (E/DT1/DT2) are also hidden — they key off the option-chain expiry calendar, which
  // is not what drives a futures or cash main leg.
  const comboType = useMemo(() => {
    if (!selectedStrategy?.comboSpecJson) return null;
    try {
      return (JSON.parse(selectedStrategy.comboSpecJson) as { type?: string }).type ?? null;
    } catch {
      return null;
    }
  }, [selectedStrategy]);
  const isComboStrategy = Boolean(comboType);
  const comboLabel = comboType === 'FUTURES_OPTIONS' ? 'Futures + Option hedge'
    : comboType === 'LONG_SHORT' ? 'Long/Short (cash vs futures)'
    : comboType === 'COVERED_CALL' ? 'Covered Call (stock + sold call)'
    : comboType === 'PROTECTIVE_PUT' ? 'Protective Put (stock + bought put)'
    : comboType;
  const hideOptionChainConfig = isEquityStrategy || isComboStrategy;
  // A covered call is the one combo whose OPTION leg is a MAIN leg — its strike comes from the
  // tranch strikeType/strikeValue (operator rule: strikeType is a main-leg concept), so the strike
  // block must stay visible for it. Hedge-striked shapes keep it hidden.
  const hideStrikeConfig = isEquityStrategy || (isComboStrategy && comboType !== 'COVERED_CALL');

  // Check if selected strategy's template supports tranches
  const selectedStrategySupportsTranches = useMemo(() => {
    if (!selectedStrategy || !templates) return false;
    const template = (templates as StrategyTemplate[]).find((t) => t.templateName === selectedStrategy.templateName);
    return template?.supportTranches ?? false;
  }, [selectedStrategy, templates]);

  // Build broker options based on selected user's actual brokers
  const brokerOptionsForUser = useMemo(() => {
    if (!users || !formData.username) return [];
    const user = (users as User[]).find((u) => u.username === formData.username);
    if (!user || !user.brokers) return [];
    return user.brokers.map((b) => ({
      value: b.broker,
      label: b.broker,
    }));
  }, [users, formData.username]);

  // Build broker options for bulk modal based on selected bulk user
  const bulkBrokerOptions = useMemo(() => {
    if (!users || !bulkUsername) return [];
    const user = (users as User[]).find((u) => u.username === bulkUsername);
    if (!user || !user.brokers) return [];
    return user.brokers.map((b) => ({
      value: b.broker,
      label: b.broker,
    }));
  }, [users, bulkUsername]);

  // Policy dropdown options
  const orderFillPolicyOptions = useMemo(() => {
    if (!orderFillPolicies) return [];
    return (orderFillPolicies as OrderFillEscalationPolicy[]).map((p) => ({
      value: p.id,
      label: `${p.policyName} (${p.escalationMode})`,
      description: p.description,
    }));
  }, [orderFillPolicies]);

  const trailingSLPolicyOptions = useMemo(() => {
    if (!trailingSLPolicies) return [];
    return (trailingSLPolicies as TrailingSLPolicy[]).map((p) => ({
      value: p.id,
      label: p.policyName,
      description: p.description,
    }));
  }, [trailingSLPolicies]);

  const slTargetPolicyOptions = useMemo(() => {
    if (!slTargetPolicies) return [];
    return (slTargetPolicies as SLTargetPolicy[]).map((p) => ({
      value: p.id,
      label: `${p.policyName} (SL:${p.slPercentage || '-'}%, T:${p.targetPercentage || '-'}%)`,
      description: p.description,
    }));
  }, [slTargetPolicies]);

  const strikePolicyOptions = useMemo(() => {
    if (!strikePolicies) return [];
    return (strikePolicies as StrikeSelectionPolicy[]).map((p) => ({
      value: p.id,
      label: `${p.policyName} (${p.strikeType || 'N/A'})`,
      description: p.description,
    }));
  }, [strikePolicies]);

  const exitPolicyOptions = useMemo(() => {
    if (!exitPolicies) return [];
    return (exitPolicies as ExitPolicy[]).map((p) => ({
      value: p.id,
      label: `${p.policyName} (${p.exitMode || 'N/A'})`,
      description: p.description,
    }));
  }, [exitPolicies]);

  // Get strategy display name
  const getStrategyDisplayName = (name: string) => {
    const strategy = strategies?.find((s: StrategyDefinition) => s.strategyName === name);
    return strategy?.displayName || name;
  };

  // Prepare P0 Base config options for Clone From dropdown (only show other strategies' base configs)
  const cloneFromConfigOptions = useMemo(() => {
    if (!baseConfigs || !formData.strategyName) return [];
    // baseConfigs are already scope-less (no user/broker/tranch/day); just exclude the current strategy.
    return baseConfigs
      .filter((c) => c.strategyName !== formData.strategyName)
      .map((c) => ({
        value: c.id,
        label: `${getStrategyDisplayName(c.strategyName)} (${c.strategyName})`,
        config: c,
      }));
  }, [baseConfigs, formData.strategyName, strategies]);

  // Check if Clone From should be shown (only for P0 Base level - no user/broker/tranch selected)
  const showCloneFrom = useMemo(() => {
    return (
      !editingConfig && // Not in edit mode
      formData.strategyName && // Strategy is selected
      !formData.username && // No user selected
      !formData.broker && // No broker selected
      formData.tranchNumber == null // No tranch selected
    );
  }, [editingConfig, formData.strategyName, formData.username, formData.broker, formData.tranchNumber]);

  // The table renders the server page directly — filtering (strategy / priority /
  // search) and ordering (strategy → tranch → priority → id) are done in SQL.
  const filteredConfigs = tableConfigs;

  // Unique strategies for filter dropdown (from the distinct-names endpoint, so it
  // covers the whole tree — not just the loaded page).
  const uniqueStrategyOptions = useMemo(() => {
    if (!strategyNames) return [];
    return [...strategyNames]
      .sort()
      .map((name) => ({
        value: name,
        label: getStrategyDisplayName(name),
      }));
  }, [strategyNames, strategies]);

  // Pre-load the bulk-tranches editor from the EXISTING tranch rows for a scope.
  // Sourced from getByStrategy (one strategy's rows) instead of the full tree, so
  // the bulk modal no longer depends on loading every config. Same filter/sort/map
  // as before. A null broker means "no broker filter" (matches the old behaviour).
  const BULK_FALLBACK = (): typeof bulkTranches => [
    { tranchNumber: 1, tranchTiming: '', tranchCutoffTime: '', lotsPerTranch: '' },
  ];
  const loadBulkTranches = async (strategyName: string, username: string | null, broker: string | null) => {
    if (!strategyName) {
      setBulkTranches(BULK_FALLBACK());
      return;
    }
    try {
      const strategyConfigs = await strategyConfigTreeService.getByStrategy(strategyName);
      const existingTranches = strategyConfigs
        .filter((c) =>
          c.tranchNumber !== null &&
          c.tranchNumber !== undefined &&
          c.tranchNumber > 0 &&
          (!username || c.username === username) &&
          (!broker || c.broker === broker)
        )
        .sort((a, b) => (a.tranchNumber || 0) - (b.tranchNumber || 0))
        .map((c) => ({
          tranchNumber: c.tranchNumber || 1,
          tranchTiming: c.tranchTiming || '',
          tranchCutoffTime: c.tranchCutoffTime || '',
          lotsPerTranch: (c.lotsPerTranch || '') as number | '',
        }));
      setBulkTranches(existingTranches.length > 0 ? existingTranches : BULK_FALLBACK());
    } catch {
      setBulkTranches(BULK_FALLBACK());
    }
  };

  // Mutations
  const createMutation = useMutation({
    mutationFn: (data: CreateStrategyConfigTreeRequest) => strategyConfigTreeService.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'strategyConfigTree'] });
      setShowModal(false);
      setFormData({ strategyName: '' });
      setValidationErrors({});
      toast.success('Configuration created successfully');
    },
    onError: (error: { message?: string }) => {
      toast.error(error.message || 'Failed to create configuration');
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<CreateStrategyConfigTreeRequest> }) =>
      strategyConfigTreeService.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'strategyConfigTree'] });
      setShowModal(false);
      setEditingConfig(null);
      setValidationErrors({});
      toast.success('Configuration updated successfully');
    },
    onError: (error: { message?: string }) => {
      toast.error(error.message || 'Failed to update configuration');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => strategyConfigTreeService.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'strategyConfigTree'] });
      setShowDeleteConfirm(false);
      setConfigToDelete(null);
      toast.success('Configuration deleted successfully');
    },
    onError: (error: { message?: string }) => {
      toast.error(error.message || 'Failed to delete configuration');
    },
  });

  const handleOpenCreate = () => {
    setEditingConfig(null);
    setFormData({ strategyName: strategyFilter || '' });
    setValidationErrors({});
    setShowModal(true);
  };

  const handleOpenEdit = (config: StrategyConfigTree) => {
    setEditingConfig(config);
    setFormData({
      strategyName: config.strategyName,
      username: config.username,
      broker: config.broker,
      tranchNumber: config.tranchNumber,
      dayCondition: config.dayCondition,
      strikeType: config.strikeType,
      strikeValue: config.strikeValue,
      optionPremium: config.optionPremium,
      optionPremiumUpper: config.optionPremiumUpper,
      useATMIfITM: config.useATMIfITM,
      volumeFilter: config.volumeFilter,
      oiFilter: config.oiFilter,
      applyVolumeFilterToHedge: config.applyVolumeFilterToHedge,
      applyOIFilterToHedge: config.applyOIFilterToHedge,
      oiRank: config.oiRank,
      ignoreITMStrikes: config.ignoreITMStrikes,
      lookbackMinutes: config.lookbackMinutes,
      otmLevels: config.otmLevels,
      lotsPerTranch: config.lotsPerTranch,
      hedgingEnabled: config.hedgingEnabled,
      hedgeStrikeRoundingMinDistance: config.hedgeStrikeRoundingMinDistance,
      slPercentage: config.slPercentage,
      targetPercentage: config.targetPercentage,
      combinedSLPercentage: config.combinedSLPercentage,
      combinedTargetPercentage: config.combinedTargetPercentage,
      riskCalculationMode: config.riskCalculationMode,
      noStopLoss: config.noStopLoss,
      trailSL: config.trailSL,
      trailSLType: config.trailSLType,
      trailConfig: config.trailConfig,
      slBufferPercentage: config.slBufferPercentage,
      trailSLToCost: config.trailSLToCost,
      combinedTrailSL: config.combinedTrailSL,
      slTriggerToLimitGapPercentage: config.slTriggerToLimitGapPercentage,
      tranchTiming: config.tranchTiming,
      tranchCutoffTime: config.tranchCutoffTime,
      minTranchGap: config.minTranchGap,
      tranchGap: config.tranchGap,
      reEntry: config.reEntry,
      maxReentries: config.maxReentries,
      minReentryLossPercentage: config.minReentryLossPercentage,
      exitMode: config.exitMode,
      exitDays: config.exitDays,
      exitTime: config.exitTime,
      orderFillEscalationMode: config.orderFillEscalationMode,
      orderFillEscalationSeconds: config.orderFillEscalationSeconds,
      orderFillEscalationSteps: config.orderFillEscalationSteps,
      breakoutEnabled: config.breakoutEnabled,
      breakoutWatchType: config.breakoutWatchType,
      breakoutDirection: config.breakoutDirection,
      breakoutTriggerMode: config.breakoutTriggerMode,
      breakoutTriggerValue: config.breakoutTriggerValue,
      breakoutSelectFreshStrikes: config.breakoutSelectFreshStrikes,
      maxTranches: config.maxTranches,
      lotAllocationMode: config.lotAllocationMode,
      globalAllocationTranches: config.globalAllocationTranches,
      allocationStartTranch: config.allocationStartTranch,
      description: config.description,
    });
    setValidationErrors({});
    setShowModal(true);
  };

  // Safety-net validation on save — inline useEffect keeps errors up to date in real-time,
  // but this catches anything that might slip through (e.g., strategy name required).
  const validateForm = (): boolean => {
    const errors: Record<string, string> = { ...validationErrors };

    if (!formData.strategyName) {
      errors.strategyName = 'Strategy is required';
    }

    setValidationErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSave = () => {
    if (!validateForm()) {
      toast.error('Please fix validation errors');
      return;
    }

    if (editingConfig?.id) {
      updateMutation.mutate({ id: editingConfig.id, data: formData });
    } else {
      createMutation.mutate(formData);
    }
  };

  const handleDelete = (config: StrategyConfigTree) => {
    setConfigToDelete(config);
    setShowDeleteConfirm(true);
  };

  // Render value badge
  const renderValueBadge = (value: number | boolean | string | null | undefined, label: string) => {
    if (value === null || value === undefined) return null;
    if (typeof value === 'boolean') {
      return (
        <Badge bg={value ? 'success' : 'secondary'} className="me-1" title={label}>
          {label}: {value ? 'Yes' : 'No'}
        </Badge>
      );
    }
    if (typeof value === 'number') {
      return (
        <Badge bg="info" className="me-1" title={label}>
          {label}: {value}
        </Badge>
      );
    }
    // Check if value looks like JSON (object or array)
    const isJson = typeof value === 'string' && (value.startsWith('{') || value.startsWith('['));
    if (isJson) {
      return (
        <Badge bg="secondary" className="me-1" title={`${label}: ${value}`} style={{ cursor: 'help' }}>
          {label}: {'{...}'}
        </Badge>
      );
    }
    return (
      <Badge bg="secondary" className="me-1" title={label}>
        {label}: {value}
      </Badge>
    );
  };

  // Handle user change - clear broker when user changes
  const handleUserChange = (option: { value: string; label: string } | null) => {
    setFormData({
      ...formData,
      username: option?.value || null,
      broker: null, // Clear broker when user changes
    });
  };

  // Handle cloning from another strategy's P0 Base config
  const handleCloneFromConfig = (configId: number | null) => {
    if (!configId) return;

    // Clone sources are base (scope-less) configs — the same set that feeds the picker.
    const sourceConfig = baseConfigs?.find((c) => c.id === configId);
    if (!sourceConfig) return;

    // Clone all configuration values but keep the current strategy name and scope fields
    setFormData({
      // Keep current scope fields (strategyName is already set, others should be empty for P0 Base)
      strategyName: formData.strategyName,
      username: null,
      broker: null,
      tranchNumber: null,
      dayCondition: null,
      // Clone all configuration values from source
      strikeType: sourceConfig.strikeType,
      strikeValue: sourceConfig.strikeValue,
      optionPremium: sourceConfig.optionPremium,
      optionPremiumUpper: sourceConfig.optionPremiumUpper,
      useATMIfITM: sourceConfig.useATMIfITM,
      volumeFilter: sourceConfig.volumeFilter,
      oiFilter: sourceConfig.oiFilter,
      applyVolumeFilterToHedge: sourceConfig.applyVolumeFilterToHedge,
      applyOIFilterToHedge: sourceConfig.applyOIFilterToHedge,
      lotsPerTranch: sourceConfig.lotsPerTranch,
      hedgingEnabled: sourceConfig.hedgingEnabled,
      hedgeStrikeRoundingMinDistance: sourceConfig.hedgeStrikeRoundingMinDistance,
      slPercentage: sourceConfig.slPercentage,
      targetPercentage: sourceConfig.targetPercentage,
      combinedSLPercentage: sourceConfig.combinedSLPercentage,
      combinedTargetPercentage: sourceConfig.combinedTargetPercentage,
      riskCalculationMode: sourceConfig.riskCalculationMode,
      noStopLoss: sourceConfig.noStopLoss,
      trailSL: sourceConfig.trailSL,
      trailSLType: sourceConfig.trailSLType,
      trailConfig: sourceConfig.trailConfig,
      slBufferPercentage: sourceConfig.slBufferPercentage,
      trailSLToCost: sourceConfig.trailSLToCost,
      combinedTrailSL: sourceConfig.combinedTrailSL,
      slTriggerToLimitGapPercentage: sourceConfig.slTriggerToLimitGapPercentage,
      tranchTiming: sourceConfig.tranchTiming,
      tranchCutoffTime: sourceConfig.tranchCutoffTime,
      minTranchGap: sourceConfig.minTranchGap,
      tranchGap: sourceConfig.tranchGap,
      reEntry: sourceConfig.reEntry,
      maxReentries: sourceConfig.maxReentries,
      minReentryLossPercentage: sourceConfig.minReentryLossPercentage,
      exitMode: sourceConfig.exitMode,
      exitDays: sourceConfig.exitDays,
      exitTime: sourceConfig.exitTime,
      orderFillEscalationMode: sourceConfig.orderFillEscalationMode,
      orderFillEscalationSeconds: sourceConfig.orderFillEscalationSeconds,
      orderFillEscalationSteps: sourceConfig.orderFillEscalationSteps,
      breakoutEnabled: sourceConfig.breakoutEnabled,
      breakoutWatchType: sourceConfig.breakoutWatchType,
      breakoutDirection: sourceConfig.breakoutDirection,
      breakoutTriggerMode: sourceConfig.breakoutTriggerMode,
      breakoutTriggerValue: sourceConfig.breakoutTriggerValue,
      breakoutSelectFreshStrikes: sourceConfig.breakoutSelectFreshStrikes,
      maxTranches: sourceConfig.maxTranches,
      lotAllocationMode: sourceConfig.lotAllocationMode,
      globalAllocationTranches: sourceConfig.globalAllocationTranches,
      allocationStartTranch: sourceConfig.allocationStartTranch,
      description: sourceConfig.description,
    });
  };

  return (
    <>
      <Card>
        <Card.Header>
          <Row className="items-center ">
            <Col md={3}>
              <Select
                options={uniqueStrategyOptions}
                value={uniqueStrategyOptions.find((opt) => opt.value === strategyFilter) || null}
                onChange={(option) => setStrategyFilter(option?.value || '')}
                isClearable
                isSearchable
                placeholder="All Strategies"
                classNamePrefix="react-select"
              />
            </Col>
            <Col md={2}>
              <Form.Select
                value={priorityFilter}
                onChange={(e) => setPriorityFilter(e.target.value === '' ? '' : Number(e.target.value))}
              >
                <option value="">All Priorities</option>
                <option value="0">P0 - Base</option>
                <option value="2">P2 - Day</option>
                <option value="4">P4 - Tranch</option>
                <option value="6">P6 - Tranch+Day</option>
                <option value="24">P24 - User</option>
                <option value="26">P26 - User+Day</option>
                <option value="28">P28 - User+Tranch</option>
                <option value="30">P30 - User+Tranch+Day</option>
              </Form.Select>
            </Col>
            <Col md={3}>
              <InputGroup>
                <InputGroup.Text>
                  <BsSearch />
                </InputGroup.Text>
                <Form.Control
                  placeholder="Search configs..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </InputGroup>
            </Col>
            <Col md={4} className="text-end">
              {canEdit && (
                <>
                  <Button
                    variant="outline-primary"
                    className="me-2"
                    onClick={() => {
                      setBulkStrategyName('');
                      setBulkUsername(null);
                      setBulkBroker(null);
                      setBulkTranches([{ tranchNumber: 1, tranchTiming: '', tranchCutoffTime: '', lotsPerTranch: '' }]);
                      setShowBulkModal(true);
                    }}
                  >
                    <BsListOl className="me-1" /> Bulk Add Tranches
                  </Button>
                  <Button variant="primary" onClick={handleOpenCreate}>
                    <BsPlus className="me-1" /> Add Configuration
                  </Button>
                </>
              )}
            </Col>
          </Row>
        </Card.Header>
        <Card.Body className="p-0">
          {isLoading ? (
            <div className="text-center py-12">
              <Spinner />
            </div>
          ) : configsError ? (
            <Alert variant="danger" className="m-4">
              <strong>Error loading configurations:</strong>{' '}
              {(configsError as { message?: string })?.message || 'Failed to load configurations. Please try again.'}
            </Alert>
          ) : (
            <div className="overflow-x-auto">
              {pagination && (
                <div className="px-2 pt-2">
                  <TablePagination
                    page={pagination.page}
                    pageSize={pagination.pageSize}
                    totalCount={pagination.totalCount}
                    totalPages={pagination.totalPages}
                    onPageChange={setPage}
                    onPageSizeChange={setPageSize}
                    itemLabel="configs"
                    loading={isLoading}
                  />
                </div>
              )}
              <Table striped hover className="mb-0" size="sm">
                <thead>
                  <tr>
                    <th>Strategy</th>
                    <th>Scope</th>
                    <th>Priority</th>
                    <th>Configuration Values</th>
                    <th style={{ width: '100px' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredConfigs.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="text-center py-6 text-ink-soft">
                        No configurations found. Click "Add Configuration" to create one.
                      </td>
                    </tr>
                  ) : (
                    filteredConfigs.map((config) => (
                      <tr key={config.id}>
                        <td>
                          <div className="font-medium">{getStrategyDisplayName(config.strategyName)}</div>
                          <small className="text-ink-soft">
                            <code>{config.strategyName}</code>
                          </small>
                        </td>
                        <td>
                          <div className="flex flex-wrap gap-1">
                            {config.username && <Badge bg="primary">User: {config.username}</Badge>}
                            {config.broker && <Badge bg="secondary">Broker: {config.broker}</Badge>}
                            {config.tranchNumber != null && (
                              <Badge bg="warning" text="dark">
                                Tranch: {config.tranchNumber}
                              </Badge>
                            )}
                            {config.dayCondition && (
                              <Badge bg="info">
                                Day: {DAY_CONDITIONS.find((d) => d.value === config.dayCondition)?.label || config.dayCondition}
                              </Badge>
                            )}
                            {!config.username && !config.broker && config.tranchNumber == null && !config.dayCondition && (
                              <Badge bg="light" text="dark">Base Config</Badge>
                            )}
                          </div>
                        </td>
                        <td>
                          <Badge bg={getPriorityColor(config.priority || 0)}>
                            P{config.priority || 0} - {getPriorityLabel(config.priority || 0)}
                          </Badge>
                        </td>
                        <td>
                          <div className="flex flex-wrap gap-1" style={{ maxWidth: '400px' }}>
                            {/* Ordered: Hedge, Lots, StrikeType, Strike/Premium, ReEntry, Timing, SL, Target, TrailSL, TrailLogic, CombinedSL, CombinedTarget, CombinedTrailSL, CombinedTrailLogic */}
                            {renderValueBadge(config.hedgingEnabled, 'Hedge')}
                            {config.hedgingEnabled === true && renderValueBadge(config.hedgeStrikeRoundingMinDistance, 'HedgeRound%')}
                            {renderValueBadge(config.lotsPerTranch, 'Lots/Tranch')}
                            {config.strikeType && config.strikeType !== 'None' && renderValueBadge(config.strikeType, 'StrikeType')}
                            {config.strikeType === 'MoneyNess' && config.strikeValue && renderValueBadge(config.strikeValue, 'Strike')}
                            {config.strikeType === 'FixedPremium' && config.optionPremium && renderValueBadge(config.optionPremium, 'Premium')}
                            {config.strikeType === 'PremiumRange' && config.optionPremium && config.optionPremiumUpper &&
                              renderValueBadge(`${config.optionPremium}-${config.optionPremiumUpper}`, 'Range')}
                            {config.strikeType === 'PremiumRange_OIRanked' && config.optionPremium && config.optionPremiumUpper &&
                              renderValueBadge(`${config.optionPremium}-${config.optionPremiumUpper}`, 'Range')}
                            {config.strikeType === 'PremiumRange_OIRanked' && config.oiRank &&
                              renderValueBadge(config.oiRank, 'OIRank')}
                            {config.strikeType === 'PremiumRange_OIRanked' && config.ignoreITMStrikes != null &&
                              renderValueBadge(config.ignoreITMStrikes, 'IgnoreITM')}
                            {config.strikeType === 'CandleLow_NearPremium' && config.optionPremium &&
                              renderValueBadge(config.optionPremium, 'TargetPrem')}
                            {config.strikeType === 'CandleLow_NearPremium' && config.lookbackMinutes &&
                              renderValueBadge(config.lookbackMinutes, 'LookbackMins')}
                            {config.strikeType === 'CandleLow_NearPremium' && config.otmLevels &&
                              renderValueBadge(config.otmLevels, 'StrikeLevels')}
                            {(config.strikeType === 'FixedPremium' || config.strikeType === 'PremiumRange') &&
                              config.useATMIfITM != null && renderValueBadge(config.useATMIfITM, 'ATMifITM')}
                            {renderValueBadge(config.volumeFilter, 'VolFilter')}
                            {renderValueBadge(config.oiFilter, 'OIFilter')}
                            {config.applyVolumeFilterToHedge === true && renderValueBadge(config.applyVolumeFilterToHedge, 'VolFilter→Hedge')}
                            {config.applyOIFilterToHedge === true && renderValueBadge(config.applyOIFilterToHedge, 'OIFilter→Hedge')}
                            {renderValueBadge(config.reEntry, 'ReEntry')}
                            {config.reEntry && renderValueBadge(config.maxReentries, 'MaxRE')}
                            {config.reEntry && renderValueBadge(config.minReentryLossPercentage, 'MinLoss%')}
                            {renderValueBadge(config.tranchTiming, 'Timing')}
                            {renderValueBadge(config.tranchCutoffTime, 'Cutoff')}
                            {renderValueBadge(config.minTranchGap, 'MinGap')}
                            {renderValueBadge(config.tranchGap, 'Gap')}
                            {(config.tranchNumber == null || config.tranchNumber === 0) &&
                              renderValueBadge(config.maxTranches, 'MaxTranches')}
                            {renderValueBadge(config.lotAllocationMode, 'LotAlloc')}
                            {renderValueBadge(config.globalAllocationTranches, 'GlobalTranches')}
                            {renderValueBadge(config.allocationStartTranch, 'StartTranch')}
                            {renderValueBadge(config.slPercentage, 'SL%')}
                            {renderValueBadge(config.targetPercentage, 'Target%')}
                            {renderValueBadge(config.trailSL, 'TrailSL')}
                            {renderValueBadge(config.trailSLType, 'TrailType')}
                            {renderValueBadge(config.trailConfig, 'TrailCfg')}
                            {renderValueBadge(config.slBufferPercentage, 'SLBuf%')}
                            {renderValueBadge(config.trailSLToCost, 'TrailToCost')}
                            {renderValueBadge(config.slTriggerToLimitGapPercentage, 'SLGap%')}
                            {renderValueBadge(config.combinedSLPercentage, 'CombSL%')}
                            {renderValueBadge(config.combinedTargetPercentage, 'CombTarget%')}
                            {renderValueBadge(config.riskCalculationMode, 'RiskMode')}
                            {renderValueBadge(config.noStopLoss, 'NoSL')}
                            {renderValueBadge(config.combinedTrailSL, 'CombTrailSL')}
                            {renderValueBadge(config.combinedTrailLogic, 'CombTrailLogic')}
                            {renderValueBadge(config.exitMode, 'ExitMode')}
                            {renderValueBadge(config.exitDays, 'ExitDays')}
                            {renderValueBadge(config.exitTime, 'ExitTime')}
                            {renderValueBadge(config.orderFillEscalationMode, 'FillEsc')}
                            {renderValueBadge(config.orderFillEscalationSeconds, 'EscSecs')}
                            {renderValueBadge(config.breakoutEnabled, 'Breakout')}
                            {config.breakoutEnabled && config.breakoutWatchType && renderValueBadge(config.breakoutWatchType, 'WatchType')}
                            {config.breakoutEnabled && config.breakoutDirection && renderValueBadge(config.breakoutDirection, 'BreakDir')}
                            {config.breakoutEnabled && config.breakoutTriggerValue && renderValueBadge(
                              `${config.breakoutTriggerValue}${config.breakoutTriggerMode === 'PERCENTAGE' ? '%' : 'pts'}`,
                              'Trigger'
                            )}
                          </div>
                          {config.description && (
                            <small className="text-ink-soft block mt-1">{config.description}</small>
                          )}
                        </td>
                        <td>
                          <div className="flex gap-1">
                            <Button
                              variant="outline-primary"
                              size="sm"
                              onClick={() => handleOpenEdit(config)}
                              title={canEdit ? 'Edit' : 'View'}
                            >
                              {canEdit ? <BsPencil /> : <BsEye />}
                            </Button>
                            {canManage && (
                              <Button
                                variant="outline-danger"
                                size="sm"
                                onClick={() => handleDelete(config)}
                                title="Delete"
                              >
                                <BsTrash />
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </Table>
            </div>
          )}
        </Card.Body>
        <Card.Footer className="text-ink-soft text-[0.875em]">
          Total: {pagination?.totalCount ?? filteredConfigs.length} configuration(s)
        </Card.Footer>
      </Card>

      {/* Create/View/Edit Modal */}
      <Modal show={showModal} onHide={() => setShowModal(false)} size="xl" backdrop={editingConfig && !canEdit ? true : 'static'}>
        <Modal.Header closeButton>
          <Modal.Title>{editingConfig ? (canEdit ? 'Edit' : 'View') : 'Create'} Strategy Configuration</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Form>
          <fieldset disabled={!!editingConfig && !canEdit}>
            {/* Shape banner: the admin must know WHAT they are configuring before any field below
                makes sense — for a combo, strike/moneyness and the hedging toggle do not apply and
                the SL/target percentages change meaning (they are % of the MAIN leg's price). */}
            {isComboStrategy && (
              <Alert variant="info" className="mb-4">
                <strong>Combo strategy: {comboLabel}.</strong>{' '}
                SL / Target / Trailing here apply to the <strong>main leg</strong> and are
                percentages of its <strong>price</strong> (not an option premium). Combined
                SL/Target measures the whole combo&apos;s net MTM against the main leg&apos;s entry
                value. Strike selection and the Hedging toggle do not apply — the option
                hedge&apos;s strike comes from the strategy&apos;s hedge-distance settings.
              </Alert>
            )}
            {/* Scope Section */}
            <div className="border rounded-md p-4 mb-4" style={{ borderColor: 'rgb(var(--c-hairline))' }}>
              <div className="text-ink-soft text-[0.875em] font-semibold mb-2" style={{ marginTop: '-1.5rem', background: 'rgb(var(--c-card))', width: 'fit-content', padding: '0 0.5rem' }}>
                <BsLayersHalf className="me-2" />
                Scope (determines override priority)
              </div>
              <Row className="mb-4">
              <Col md={6}>
                <Form.Group>
                  <Form.Label className="flex items-center">
                    Strategy <span className="text-danger-600 dark:text-danger-400 ms-1">*</span> <HelpIcon article={helpContent['strategyConfig.strategy']} />
                  </Form.Label>
                  <Select
                    options={strategyOptions}
                    value={strategyOptions.find((opt) => opt.value === formData.strategyName) || null}
                    onChange={(option) => setFormData({ ...formData, strategyName: option?.value || '' })}
                    isDisabled={!!editingConfig}
                    isClearable
                    isSearchable
                    placeholder="Search and select strategy..."
                    classNamePrefix="react-select"
                  />
                  {validationErrors.strategyName && (
                    <Form.Text className="text-danger-600 dark:text-danger-400">{validationErrors.strategyName}</Form.Text>
                  )}
                </Form.Group>
              </Col>
              {/* Clone From - only shown for P0 Base level configs */}
              {showCloneFrom && cloneFromConfigOptions.length > 0 && (
                <Col md={6}>
                  <Form.Group>
                    <Form.Label className="flex items-center">
                      Clone From <HelpIcon article={helpContent['strategyConfig.cloneFrom']} />
                    </Form.Label>
                    <Select
                      options={cloneFromConfigOptions}
                      value={null}
                      onChange={(option) => handleCloneFromConfig(option?.value || null)}
                      isClearable
                      isSearchable
                      placeholder="Search and select P0 Base config to clone..."
                      classNamePrefix="react-select"
                    />
                    <Form.Text className="text-ink-soft">
                      Only P0 Base configs from other strategies are shown.
                    </Form.Text>
                  </Form.Group>
                </Col>
              )}
            </Row>
            <Row className="mb-4">
              <Col md={3}>
                <Form.Group>
                  <Form.Label className="flex items-center">
                    User <HelpIcon article={helpContent['strategyConfig.user']} />
                  </Form.Label>
                  <UserSelect
                    value={formData.username || ''}
                    onChange={(username) => handleUserChange(username ? { value: username, label: username } : null)}
                    includeAllOption={false}
                    isDisabled={!!editingConfig}
                    placeholder="Search user..."
                  />
                </Form.Group>
              </Col>
              <Col md={3}>
                <Form.Group>
                  <Form.Label className="flex items-center">
                    Broker <HelpIcon article={helpContent['strategyConfig.broker']} />
                  </Form.Label>
                  <Select
                    options={brokerOptionsForUser}
                    value={brokerOptionsForUser.find((opt) => opt.value === formData.broker) || null}
                    onChange={(option) => setFormData({ ...formData, broker: option?.value || null })}
                    isDisabled={!!editingConfig || !formData.username}
                    isClearable
                    isSearchable
                    placeholder={formData.username ? 'Select broker...' : 'Select user first'}
                    classNamePrefix="react-select"
                  />
                </Form.Group>
              </Col>
            </Row>
            <Row className="mb-4">
              <Col md={6}>
                <Form.Group>
                  <Form.Label className="flex items-center">
                    Tranch Number <HelpIcon article={helpContent['strategyConfig.tranchNumber']} />
                  </Form.Label>
                  <Form.Control
                    type="number"
                    placeholder={selectedStrategySupportsTranches ? '0 or empty = no tranch' : 'N/A - Strategy does not support tranches'}
                    min={0}
                    value={formData.tranchNumber ?? ''}
                    onChange={(e) => {
                      const val = e.target.value;
                      if (val === '') {
                        setFormData({ ...formData, tranchNumber: null });
                      } else {
                        const num = Number(val);
                        // 0 means null (no tranch)
                        setFormData({ ...formData, tranchNumber: num === 0 ? null : num });
                      }
                    }}
                    disabled={!!editingConfig || !selectedStrategySupportsTranches}
                  />
                </Form.Group>
              </Col>
              <Col md={6}>
                <Form.Group>
                  <Form.Label className="flex items-center">Day Condition <HelpIcon article={helpContent['strategyConfig.dayCondition']} /></Form.Label>
                  <Form.Select
                    value={formData.dayCondition || ''}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        dayCondition: (e.target.value || null) as DayConditionType | null,
                      })
                    }
                    disabled={!!editingConfig}
                  >
                    <option value="">-- All Days --</option>
                    {/* Expiry-relative day conditions are meaningless for equity (no expiry) and
                        key off the option-chain calendar, which does not drive a combo's main leg. */}
                    {!hideOptionChainConfig && (
                    <optgroup label="Expiry Related">
                      {DAY_CONDITIONS.filter((d) => d.group === 'expiry').map((d) => (
                        <option key={d.value} value={d.value}>
                          {d.label}
                        </option>
                      ))}
                    </optgroup>
                    )}
                    <optgroup label="Day of Week">
                      {DAY_CONDITIONS.filter((d) => d.group === 'weekday').map((d) => (
                        <option key={d.value} value={d.value}>
                          {d.label}
                        </option>
                      ))}
                    </optgroup>
                  </Form.Select>
                </Form.Group>
              </Col>
            </Row>

            {/* Priority Preview */}
            <Alert variant="light" className="mb-4">
              <strong>Priority:</strong>{' '}
              <Badge bg={getPriorityColor(calculatePriority(formData))}>
                P{calculatePriority(formData)} - {getPriorityLabel(calculatePriority(formData))}
              </Badge>
              <small className="block mt-1 text-ink-soft">
                Higher priority configs override lower priority ones. User (+16), Broker (+8), Tranch (+4), Day (+2)
              </small>
            </Alert>

            {/* Hedging - shown only for trade modes that currently support hedging */}
            {supportsHedging(selectedStrategy?.tradeMode) && (
            <Row className="mb-4">
              <Col md={3}>
                <Form.Group>
                  <Form.Label className="flex items-center">Hedging <HelpIcon article={helpContent['strategyConfig.hedgingEnabled']} /></Form.Label>
                  {isComboStrategy && (
                    <Form.Text className="text-ink-soft d-block">
                      Declared by the combo spec (HEDGE leg) — this toggle is ignored for combos.
                    </Form.Text>
                  )}
                  <Form.Select
                    value={formData.hedgingEnabled === null || formData.hedgingEnabled === undefined ? '' : String(formData.hedgingEnabled)}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        hedgingEnabled: e.target.value === '' ? null : e.target.value === 'true',
                      })
                    }
                  >
                    <option value="">-- Not Set --</option>
                    <option value="true">Enabled</option>
                    <option value="false">Disabled</option>
                  </Form.Select>
                </Form.Group>
              </Col>
              {formData.hedgingEnabled === true && (
                <Col md={3}>
                  <Form.Group>
                    <Form.Label className="flex items-center">
                      Hedge Strike Rounding Min Dist % <HelpIcon article={helpContent['strategyConfig.hedgeStrikeRoundingMinDistance']} />
                    </Form.Label>
                    <Form.Control
                      type="number"
                      min={0}
                      max={10}
                      step={0.5}
                      placeholder="Not set"
                      value={formData.hedgeStrikeRoundingMinDistance ?? ''}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          hedgeStrikeRoundingMinDistance: e.target.value === '' ? null : parseFloat(e.target.value),
                        })
                      }
                    />
                    <Form.Text className="text-ink-soft">Leave empty for no rounding</Form.Text>
                  </Form.Group>
                </Col>
              )}
            </Row>
            )}

            {/* Tranch-level settings.
                Tranch Timing + Lots Per Tranch only make sense for tranch >= 1
                (they describe a specific tranch's firing). Tranch CutOff Time is
                also valid at strategy level (tranchNumber == 0/null) — it acts
                as the strategy-wide entry-cutoff fallback inherited by tranches
                that don't override it. */}
            <Row className="mb-4">
              {(formData.tranchNumber != null && formData.tranchNumber > 0) && (
                <Col md={3}>
                  <Form.Group>
                    <Form.Label className="flex items-center">Tranch Timing <HelpIcon article={helpContent['strategyConfig.tranchTiming']} /></Form.Label>
                    <Form.Control
                      type="text"
                      placeholder="HH:mm:ss"
                      value={formData.tranchTiming || ''}
                      onChange={(e) =>
                        setFormData({ ...formData, tranchTiming: e.target.value || null })
                      }
                      isInvalid={!!validationErrors.tranchTiming}
                    />
                    <Form.Control.Feedback type="invalid">
                      {validationErrors.tranchTiming}
                    </Form.Control.Feedback>
                  </Form.Group>
                </Col>
              )}
              <Col md={3}>
                <Form.Group>
                  <Form.Label className="flex items-center">Tranch CutOff Time <HelpIcon article={helpContent['strategyConfig.tranchCutoffTime']} /></Form.Label>
                  <Form.Control
                    type="text"
                    placeholder="HH:mm:ss"
                    value={formData.tranchCutoffTime || ''}
                    onChange={(e) =>
                      setFormData({ ...formData, tranchCutoffTime: e.target.value || null })
                    }
                    isInvalid={!!validationErrors.tranchCutoffTime}
                  />
                  <Form.Control.Feedback type="invalid">
                    {validationErrors.tranchCutoffTime}
                  </Form.Control.Feedback>
                </Form.Group>
              </Col>
              {(formData.tranchNumber != null && formData.tranchNumber > 0) && (
                <Col md={3}>
                  <Form.Group>
                    <Form.Label className="flex items-center">
                      Lots Per Tranch <HelpIcon article={helpContent['strategyConfig.lotsPerTranch']} />
                    </Form.Label>
                    <Form.Control
                      type="number"
                      min="1"
                      placeholder="Auto-calc"
                      value={formData.lotsPerTranch ?? ''}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          lotsPerTranch: e.target.value ? Number(e.target.value) : null,
                        })
                      }
                      isInvalid={!!validationErrors.lotsPerTranch}
                    />
                    <Form.Control.Feedback type="invalid">
                      {validationErrors.lotsPerTranch}
                    </Form.Control.Feedback>
                  </Form.Group>
                </Col>
              )}
            </Row>

            {/* Strategy-level settings - Only shown at strategy level (tranchNumber is null/0) */}
            {(formData.tranchNumber == null || formData.tranchNumber === 0) && (
              <Row className="mb-4">
                <Col md={3}>
                  <Form.Group>
                    <Form.Label className="flex items-center">
                      Max Tranches <HelpIcon article={helpContent['strategyConfig.maxTranches']} />
                    </Form.Label>
                    <Form.Control
                      type="number"
                      min="1"
                      placeholder="e.g., 8"
                      value={formData.maxTranches ?? ''}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          maxTranches: e.target.value ? Number(e.target.value) : null,
                        })
                      }
                      isInvalid={!!validationErrors.maxTranches}
                    />
                    <Form.Control.Feedback type="invalid">
                      {validationErrors.maxTranches}
                    </Form.Control.Feedback>
                  </Form.Group>
                </Col>
                <Col md={3}>
                  <Form.Group>
                    <Form.Label className="flex items-center">
                      Tranch Gap <HelpIcon article={helpContent['strategyConfig.tranchGap']} />
                    </Form.Label>
                    <Form.Control
                      type="number"
                      min="1"
                      placeholder="e.g., 5"
                      value={formData.tranchGap ?? ''}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          tranchGap: e.target.value ? Number(e.target.value) : null,
                        })
                      }
                      isInvalid={!!validationErrors.tranchGap}
                    />
                    <Form.Control.Feedback type="invalid">
                      {validationErrors.tranchGap}
                    </Form.Control.Feedback>
                  </Form.Group>
                </Col>
                <Col md={3}>
                  <Form.Group>
                    <Form.Label className="flex items-center">
                      Min Tranch Gap <HelpIcon article={helpContent['strategyConfig.minTranchGap']} />
                    </Form.Label>
                    <Form.Control
                      type="number"
                      min="1"
                      placeholder="Default: 1 min"
                      value={formData.minTranchGap ?? ''}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          minTranchGap: e.target.value ? Number(e.target.value) : null,
                        })
                      }
                      isInvalid={!!validationErrors.minTranchGap}
                    />
                    <Form.Control.Feedback type="invalid">
                      {validationErrors.minTranchGap}
                    </Form.Control.Feedback>
                  </Form.Group>
                </Col>
                <Col md={3}>
                  <Form.Group>
                    <Form.Label className="flex items-center">
                      Lot Allocation Mode <HelpIcon article={helpContent['strategyConfig.lotAllocationMode']} />
                    </Form.Label>
                    <Form.Select
                      value={formData.lotAllocationMode || ''}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          lotAllocationMode: (e.target.value || null) as LotAllocationMode | null,
                          globalAllocationTranches: e.target.value === 'GLOBAL_SHARED'
                            ? formData.globalAllocationTranches
                            : null,
                          allocationStartTranch: e.target.value === 'GLOBAL_SHARED'
                            ? formData.allocationStartTranch
                            : null,
                        })
                      }
                    >
                      <option value="">-- Not Set --</option>
                      {LOT_ALLOCATION_MODES.map((mode) => (
                        <option key={mode.value} value={mode.value}>
                          {mode.label}
                        </option>
                      ))}
                    </Form.Select>
                    <Form.Text className="text-ink-soft">
                      {LOT_ALLOCATION_MODES.find((m) => m.value === formData.lotAllocationMode)?.description || 'Defaults to current day-local behavior when unset.'}
                    </Form.Text>
                  </Form.Group>
                </Col>
              </Row>
            )}

            {/* Liquidity filters for strike selection (blank = inherit, 0 = off, > 0 = active threshold).
                FnO-only: consumed by FnoBaseStrategyEvaluator's strike traversal, which combos never enter. */}
            {!hideOptionChainConfig && (
            <Row className="mb-4">
              <Col md={3}>
                <Form.Group>
                  <Form.Label className="flex items-center">
                    Volume Filter <HelpIcon article={helpContent['strategyConfig.volumeFilter']} />
                  </Form.Label>
                  <Form.Control
                    type="text"
                    inputMode="numeric"
                    placeholder="Off"
                    value={formData.volumeFilter ?? ''}
                    onChange={(e) => {
                      const digits = e.target.value.replace(/[^0-9]/g, '');
                      setFormData({ ...formData, volumeFilter: digits === '' ? null : Number(digits) });
                    }}
                  />
                </Form.Group>
              </Col>
              <Col md={3}>
                <Form.Group>
                  <Form.Label className="flex items-center">
                    OI Filter <HelpIcon article={helpContent['strategyConfig.oiFilter']} />
                  </Form.Label>
                  <Form.Control
                    type="text"
                    inputMode="numeric"
                    placeholder="Off"
                    value={formData.oiFilter ?? ''}
                    onChange={(e) => {
                      const digits = e.target.value.replace(/[^0-9]/g, '');
                      setFormData({ ...formData, oiFilter: digits === '' ? null : Number(digits) });
                    }}
                  />
                </Form.Group>
              </Col>
              <Col md={3}>
                <Form.Group>
                  <Form.Label className="flex items-center">
                    Apply Vol Filter to Hedge <HelpIcon article={helpContent['strategyConfig.applyVolumeFilterToHedge']} />
                  </Form.Label>
                  <Form.Select
                    value={formData.applyVolumeFilterToHedge === null || formData.applyVolumeFilterToHedge === undefined ? '' : String(formData.applyVolumeFilterToHedge)}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        applyVolumeFilterToHedge: e.target.value === '' ? null : e.target.value === 'true',
                      })
                    }
                  >
                    <option value="">Default (No)</option>
                    <option value="true">Yes</option>
                    <option value="false">No</option>
                  </Form.Select>
                </Form.Group>
              </Col>
              <Col md={3}>
                <Form.Group>
                  <Form.Label className="flex items-center">
                    Apply OI Filter to Hedge <HelpIcon article={helpContent['strategyConfig.applyOIFilterToHedge']} />
                  </Form.Label>
                  <Form.Select
                    value={formData.applyOIFilterToHedge === null || formData.applyOIFilterToHedge === undefined ? '' : String(formData.applyOIFilterToHedge)}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        applyOIFilterToHedge: e.target.value === '' ? null : e.target.value === 'true',
                      })
                    }
                  >
                    <option value="">Default (No)</option>
                    <option value="true">Yes</option>
                    <option value="false">No</option>
                  </Form.Select>
                </Form.Group>
              </Col>
            </Row>
            )}

            {(formData.tranchNumber == null || formData.tranchNumber === 0) && formData.lotAllocationMode === 'GLOBAL_SHARED' && (
              <Row className="mb-4">
                <Col md={3}>
                  <Form.Group>
                    <Form.Label className="flex items-center">
                      Global Allocation Tranches <HelpIcon article={helpContent['strategyConfig.globalAllocationTranches']} />
                    </Form.Label>
                    <Form.Control
                      type="number"
                      min="1"
                      placeholder="e.g., 8"
                      value={formData.globalAllocationTranches ?? ''}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          globalAllocationTranches: e.target.value ? Number(e.target.value) : null,
                        })
                      }
                      isInvalid={!!validationErrors.globalAllocationTranches}
                    />
                    <Form.Control.Feedback type="invalid">
                      {validationErrors.globalAllocationTranches}
                    </Form.Control.Feedback>
                  </Form.Group>
                </Col>
                <Col md={3}>
                  <Form.Group>
                    <Form.Label className="flex items-center">
                      Allocation Start Tranch <HelpIcon article={helpContent['strategyConfig.allocationStartTranch']} />
                    </Form.Label>
                    <Form.Control
                      type="number"
                      min="1"
                      placeholder="e.g., 3"
                      value={formData.allocationStartTranch ?? ''}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          allocationStartTranch: e.target.value ? Number(e.target.value) : null,
                        })
                      }
                      isInvalid={!!validationErrors.allocationStartTranch}
                    />
                    <Form.Control.Feedback type="invalid">
                      {validationErrors.allocationStartTranch}
                    </Form.Control.Feedback>
                  </Form.Group>
                </Col>
              </Row>
            )}
            </div>

            {/* Load from Template Section */}
            <div className="border rounded-md p-4 mb-4" style={{ borderColor: 'rgb(var(--c-hairline))' }}>
              <div className="text-ink-soft text-[0.875em] font-semibold mb-2" style={{ marginTop: '-1.5rem', background: 'rgb(var(--c-card))', width: 'fit-content', padding: '0 0.5rem' }}>
                <BsLayersHalf className="me-2" />
                Load from Template (optional)
              </div>
              <Alert variant="light" className="mb-4 py-2">
              <small>
                Select a policy template to auto-fill configuration values. You can then customize any individual field.
              </small>
            </Alert>

            <Row className="mb-4">
              {!hideOptionChainConfig && (
              <Col md={4}>
                <Form.Group>
                  <Form.Label className="flex items-center">Strike Selection Template <HelpIcon article={helpContent['strategyConfig.strikeSelectionTemplate']} /></Form.Label>
                  <Select
                    options={strikePolicyOptions}
                    value={null}
                    onChange={(option) => {
                      if (option?.value) {
                        const policy = (strikePolicies as StrikeSelectionPolicy[])?.find(p => p.id === option.value);
                        if (policy) {
                          // Clear all strike-related fields first, then set only what applies
                          setFormData(prev => ({
                            ...prev,
                            strikeType: policy.strikeType ?? undefined,
                            // MoneyNess: set strikeValue, clear premium fields
                            // FixedPremium/PremiumRange: set premium fields, clear strikeValue
                            strikeValue: policy.strikeType === 'MoneyNess' ? policy.strikeValue : undefined,
                            optionPremium: (policy.strikeType === 'FixedPremium' || policy.strikeType === 'PremiumRange')
                              ? policy.premiumLower : undefined,
                            optionPremiumUpper: policy.strikeType === 'PremiumRange'
                              ? policy.premiumUpper : undefined,
                          }));
                          toast.info(`Loaded Strike values from "${policy.policyName}"`);
                        }
                      }
                    }}
                    isClearable
                    isSearchable
                    placeholder="Select to load values..."
                    classNamePrefix="react-select"
                  />
                </Form.Group>
              </Col>
              )}
              <Col md={4}>
                <Form.Group>
                  <Form.Label className="flex items-center">SL & Target Template <HelpIcon article={helpContent['strategyConfig.slTargetTemplate']} /></Form.Label>
                  <Select
                    options={slTargetPolicyOptions}
                    value={null}
                    onChange={(option) => {
                      if (option?.value) {
                        const policy = (slTargetPolicies as SLTargetPolicy[])?.find(p => p.id === option.value);
                        if (policy) {
                          // Set all SL/Target fields from policy, clear if not set
                          setFormData(prev => ({
                            ...prev,
                            slPercentage: policy.slPercentage ?? undefined,
                            targetPercentage: policy.targetPercentage ?? undefined,
                            combinedSLPercentage: policy.combinedSLPercentage ?? undefined,
                            combinedTargetPercentage: policy.combinedTargetPercentage ?? undefined,
                            slTriggerToLimitGapPercentage: policy.slTriggerToLimitGapPercentage ?? undefined,
                            slBufferPercentage: policy.slBufferPercentage ?? undefined,
                            riskCalculationMode: policy.riskCalculationMode ?? undefined,
                          }));
                          toast.info(`Loaded SL/Target values from "${policy.policyName}"`);
                        }
                      }
                    }}
                    isClearable
                    isSearchable
                    placeholder="Select to load values..."
                    classNamePrefix="react-select"
                  />
                </Form.Group>
              </Col>
              <Col md={4}>
                <Form.Group>
                  <Form.Label className="flex items-center">Trailing SL Template <HelpIcon article={helpContent['strategyConfig.trailingSLTemplate']} /></Form.Label>
                  <Select
                    options={trailingSLPolicyOptions}
                    value={null}
                    onChange={(option) => {
                      if (option?.value) {
                        const policy = (trailingSLPolicies as TrailingSLPolicy[])?.find(p => p.id === option.value);
                        if (policy) {
                          // Get trail config from policy or generate default based on type
                          const policyTrailConfig = policy.trailConfig ||
                            getDefaultTrailConfig(policy.trailType || null, policy.combinedTrailEnabled === true);
                          // Set all Trailing SL fields from policy, clear if not set
                          setFormData(prev => ({
                            ...prev,
                            trailSL: policy.trailEnabled ?? undefined,
                            trailSLType: policy.trailType ?? undefined,
                            trailConfig: policyTrailConfig || undefined,
                            trailSLToCost: policy.trailToCost ?? undefined,
                            combinedTrailSL: policy.combinedTrailEnabled ?? undefined,
                          }));
                          toast.info(`Loaded Trailing SL values from "${policy.policyName}"`);
                        }
                      }
                    }}
                    isClearable
                    isSearchable
                    placeholder="Select to load values..."
                    classNamePrefix="react-select"
                  />
                </Form.Group>
              </Col>
            </Row>

            <Row className="mb-4">
              <Col md={4}>
                <Form.Group>
                  <Form.Label className="flex items-center">Order Fill Template <HelpIcon article={helpContent['strategyConfig.orderFillTemplate']} /></Form.Label>
                  <Select
                    options={orderFillPolicyOptions}
                    value={null}
                    onChange={(option) => {
                      if (option?.value) {
                        const policy = (orderFillPolicies as OrderFillEscalationPolicy[])?.find(p => p.id === option.value);
                        if (policy) {
                          // Set fields based on escalation mode, clear non-relevant fields
                          setFormData(prev => ({
                            ...prev,
                            orderFillEscalationMode: policy.escalationMode ?? undefined,
                            // MARKET mode uses seconds, STEP_ESCALATION uses steps
                            orderFillEscalationSeconds: policy.escalationMode === 'MARKET' ? policy.escalationSeconds : undefined,
                            orderFillEscalationSteps: policy.escalationMode === 'STEP_ESCALATION' ? policy.escalationSteps : undefined,
                          }));
                          toast.info(`Loaded Order Fill values from "${policy.policyName}"`);
                        }
                      }
                    }}
                    isClearable
                    isSearchable
                    placeholder="Select to load values..."
                    classNamePrefix="react-select"
                  />
                </Form.Group>
              </Col>
              <Col md={4}>
                <Form.Group>
                  <Form.Label className="flex items-center">Exit Template <HelpIcon article={helpContent['strategyConfig.exitTemplate']} /></Form.Label>
                  <Select
                    options={exitPolicyOptions}
                    value={null}
                    onChange={(option) => {
                      if (option?.value) {
                        const policy = (exitPolicies as ExitPolicy[])?.find(p => p.id === option.value);
                        if (policy) {
                          // Set fields based on exit mode, clear non-relevant fields
                          setFormData(prev => ({
                            ...prev,
                            exitMode: policy.exitMode ?? undefined,
                            // DAYS_FROM_ENTRY, DTE, and MINUTES_FROM_ENTRY use exitDays, others don't
                            exitDays: (policy.exitMode === 'DAYS_FROM_ENTRY' || policy.exitMode === 'DTE' || policy.exitMode === 'MINUTES_FROM_ENTRY')
                              ? policy.exitDays : undefined,
                            // MINUTES_FROM_ENTRY computes exit time dynamically, so clear it
                            exitTime: policy.exitMode === 'MINUTES_FROM_ENTRY' ? undefined : (policy.exitTime ?? undefined),
                          }));
                          toast.info(`Loaded Exit values from "${policy.policyName}"`);
                        }
                      }
                    }}
                    isClearable
                    isSearchable
                    placeholder="Select to load values..."
                    classNamePrefix="react-select"
                  />
                </Form.Group>
              </Col>
            </Row>
            </div>

            {/* Configuration Values */}
            <div className="border rounded-md p-4 mb-4" style={{ borderColor: 'rgb(var(--c-hairline))' }}>
              <div className="text-ink-soft text-[0.875em] font-semibold mb-2" style={{ marginTop: '-1.5rem', background: 'rgb(var(--c-card))', width: 'fit-content', padding: '0 0.5rem' }}>
                <BsGear className="me-2" />
                Configuration Values (leave empty to inherit)
              </div>

              {/* Strike Configuration — hidden for FUTURES / EQUITY modes and for hedge-striked
                  combos. A COVERED CALL shows it: its sold call is a MAIN leg and this is where
                  its strike (MoneyNess ATM/OTM±n) comes from. */}
              {selectedStrategy?.tradeMode !== 'FUTURES' && !hideStrikeConfig && (
              <Row className="mb-4">
              <Col md={3}>
                <Form.Group>
                  <Form.Label className="flex items-center">Strike Type <HelpIcon article={helpContent['strategyConfig.strikeType']} /></Form.Label>
                  <Form.Select
                    value={formData.strikeType || ''}
                    onChange={(e) => {
                      const newType = e.target.value || null;
                      setFormData({
                        ...formData,
                        strikeType: newType,
                        // Clear non-relevant fields based on selected type
                        strikeValue: newType === 'MoneyNess' ? formData.strikeValue : undefined,
                        optionPremium: (newType === 'FixedPremium' || newType === 'PremiumRange' || newType === 'PremiumRange_OIRanked' || newType === 'CandleLow_NearPremium') ? formData.optionPremium : undefined,
                        optionPremiumUpper: (newType === 'PremiumRange' || newType === 'PremiumRange_OIRanked') ? formData.optionPremiumUpper : undefined,
                        oiRank: newType === 'PremiumRange_OIRanked' ? (formData.oiRank ?? 1) : undefined,
                        ignoreITMStrikes: newType === 'PremiumRange_OIRanked' ? (formData.ignoreITMStrikes ?? true) : undefined,
                        lookbackMinutes: newType === 'CandleLow_NearPremium' ? (formData.lookbackMinutes ?? 60) : undefined,
                        otmLevels: newType === 'CandleLow_NearPremium' ? (formData.otmLevels ?? 10) : undefined,
                      });
                    }}
                  >
                    <option value="">-- Not Set --</option>
                    <option value="MoneyNess">MoneyNess (ATM/OTM/ITM)</option>
                    <option value="FixedPremium">Fixed Premium</option>
                    <option value="PremiumRange">Premium Range</option>
                    <option value="PremiumRange_OIRanked">Premium Range + OI Rank</option>
                    <option value="CandleLow_NearPremium">Candle Low Near Premium</option>
                  </Form.Select>
                </Form.Group>
              </Col>
              <Col md={3}>
                <Form.Group>
                  <Form.Label className="flex items-center">Strike Value <HelpIcon article={helpContent['strategyConfig.strikeValue']} /></Form.Label>
                  <Form.Select
                    value={formData.strikeValue || ''}
                    onChange={(e) =>
                      setFormData({ ...formData, strikeValue: e.target.value || null })
                    }
                    disabled={formData.strikeType !== 'MoneyNess' && formData.strikeType !== null && formData.strikeType !== ''}
                  >
                    <option value="">-- Not Set --</option>
                    {STRIKE_VALUE_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </Form.Select>
                </Form.Group>
              </Col>
              <Col md={3}>
                <Form.Group>
                  <Form.Label className="flex items-center">
                    {(formData.strikeType === 'PremiumRange' || formData.strikeType === 'PremiumRange_OIRanked') ? 'Premium (Lower)' :
                     formData.strikeType === 'CandleLow_NearPremium' ? 'Target Premium' : 'Option Premium'}
                    {' '}<HelpIcon article={helpContent['strategyConfig.optionPremium']} />
                  </Form.Label>
                  <Form.Control
                    type="number"
                    min="1"
                    placeholder={(formData.strikeType === 'PremiumRange' || formData.strikeType === 'PremiumRange_OIRanked') ? 'Lower bound' :
                                 formData.strikeType === 'CandleLow_NearPremium' ? 'e.g., 100' : 'Min: 1'}
                    value={formData.optionPremium ?? ''}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        optionPremium: e.target.value ? Number(e.target.value) : null,
                      })
                    }
                    isInvalid={!!validationErrors.optionPremium}
                    disabled={formData.strikeType === 'MoneyNess'}
                  />
                  <Form.Control.Feedback type="invalid">
                    {validationErrors.optionPremium}
                  </Form.Control.Feedback>
                </Form.Group>
              </Col>
              <Col md={3}>
                <Form.Group>
                  <Form.Label className="flex items-center">Premium (Upper) <HelpIcon article={helpContent['strategyConfig.optionPremiumUpper']} /></Form.Label>
                  <Form.Control
                    type="number"
                    min="1"
                    placeholder="Upper bound"
                    value={formData.optionPremiumUpper ?? ''}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        optionPremiumUpper: e.target.value ? Number(e.target.value) : null,
                      })
                    }
                    isInvalid={!!validationErrors.optionPremiumUpper}
                    disabled={formData.strikeType !== 'PremiumRange' && formData.strikeType !== 'PremiumRange_OIRanked'}
                  />
                  <Form.Control.Feedback type="invalid">
                    {validationErrors.optionPremiumUpper}
                  </Form.Control.Feedback>
                </Form.Group>
              </Col>
              {/* Use ATM if ITM - only show for FixedPremium/PremiumRange */}
              {(formData.strikeType === 'FixedPremium' || formData.strikeType === 'PremiumRange') && (
                <Col md={3}>
                  <Form.Group>
                    <Form.Label className="flex items-center">
                      Use ATM if ITM <HelpIcon article={helpContent['strategyConfig.useATMIfITM']} />
                    </Form.Label>
                    <Form.Select
                      value={formData.useATMIfITM === null || formData.useATMIfITM === undefined ? '' : String(formData.useATMIfITM)}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          useATMIfITM: e.target.value === '' ? null : e.target.value === 'true',
                        })
                      }
                    >
                      <option value="">Not set</option>
                      <option value="true">Yes</option>
                      <option value="false">No</option>
                    </Form.Select>
                  </Form.Group>
                </Col>
              )}
              {/* OI Rank - only show for PremiumRange_OIRanked */}
              {formData.strikeType === 'PremiumRange_OIRanked' && (
                <>
                  <Col md={2}>
                    <Form.Group>
                      <Form.Label className="flex items-center">
                        OI Rank <HelpIcon article={helpContent['strategyConfig.oiRank']} />
                      </Form.Label>
                      <Form.Select
                        value={formData.oiRank ?? 1}
                        onChange={(e) =>
                          setFormData({
                            ...formData,
                            oiRank: Number(e.target.value),
                          })
                        }
                      >
                        <option value={1}>1st (Highest OI)</option>
                        <option value={2}>2nd</option>
                        <option value={3}>3rd</option>
                        <option value={4}>4th</option>
                        <option value={5}>5th</option>
                      </Form.Select>
                    </Form.Group>
                  </Col>
                  <Col md={2}>
                    <Form.Group>
                      <Form.Label className="flex items-center">
                        Ignore ITM <HelpIcon article={helpContent['strategyConfig.ignoreITMStrikes']} />
                      </Form.Label>
                      <Form.Select
                        value={formData.ignoreITMStrikes === null || formData.ignoreITMStrikes === undefined ? 'true' : String(formData.ignoreITMStrikes)}
                        onChange={(e) =>
                          setFormData({
                            ...formData,
                            ignoreITMStrikes: e.target.value === 'true',
                          })
                        }
                      >
                        <option value="true">Yes (OTM only)</option>
                        <option value="false">No (Include ITM)</option>
                      </Form.Select>
                    </Form.Group>
                  </Col>
                </>
              )}
              {/* CandleLow_NearPremium fields */}
              {formData.strikeType === 'CandleLow_NearPremium' && (
                <>
                  <Col md={2}>
                    <Form.Group>
                      <Form.Label className="flex items-center">
                        Lookback Mins <HelpIcon article={helpContent['strategyConfig.lookbackMinutes']} />
                      </Form.Label>
                      <Form.Control
                        type="number"
                        min="5"
                        placeholder="e.g., 60"
                        value={formData.lookbackMinutes ?? ''}
                        onChange={(e) =>
                          setFormData({
                            ...formData,
                            lookbackMinutes: e.target.value ? Number(e.target.value) : null,
                          })
                        }
                        isInvalid={!!validationErrors.lookbackMinutes}
                      />
                      <Form.Control.Feedback type="invalid">
                        {validationErrors.lookbackMinutes}
                      </Form.Control.Feedback>
                    </Form.Group>
                  </Col>
                  <Col md={2}>
                    <Form.Group>
                      <Form.Label className="flex items-center">
                        Strike Levels <HelpIcon article={helpContent['strategyConfig.otmLevels']} />
                      </Form.Label>
                      <Form.Control
                        type="number"
                        min="1"
                        placeholder="e.g., 10"
                        value={formData.otmLevels ?? ''}
                        onChange={(e) =>
                          setFormData({
                            ...formData,
                            otmLevels: e.target.value ? Number(e.target.value) : null,
                          })
                        }
                        isInvalid={!!validationErrors.otmLevels}
                      />
                      <Form.Control.Feedback type="invalid">
                        {validationErrors.otmLevels}
                      </Form.Control.Feedback>
                    </Form.Group>
                  </Col>
                </>
              )}
            </Row>
            )}

            {/* SL & Target */}
            <Row className="mb-4" style={{ display: 'flex', flexWrap: 'wrap' }}>
              <Col style={{ flex: '0 0 15%', maxWidth: '15%' }}>
                <Form.Group>
                  <Form.Label className="flex items-center">SL % <HelpIcon article={helpContent['strategyConfig.slPercentage']} /></Form.Label>
                  <Form.Control
                    type="number"
                    step="0.1"
                    min="0.1"
                    placeholder="e.g., 25"
                    value={formData.slPercentage ?? ''}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        slPercentage: e.target.value ? Number(e.target.value) : null,
                      })
                    }
                    isInvalid={!!validationErrors.slPercentage}
                  />
                  <Form.Control.Feedback type="invalid">
                    {validationErrors.slPercentage}
                  </Form.Control.Feedback>
                </Form.Group>
              </Col>
              <Col style={{ flex: '0 0 15%', maxWidth: '15%' }}>
                <Form.Group>
                  <Form.Label className="flex items-center">
                    SL Buffer % <HelpIcon article={helpContent['strategyConfig.slBufferPercentage']} />
                  </Form.Label>
                  <Form.Control
                    type="number"
                    step="0.1"
                    min="0"
                    placeholder="e.g., 0.5"
                    value={formData.slBufferPercentage ?? ''}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        slBufferPercentage: e.target.value ? Number(e.target.value) : null,
                      })
                    }
                  />
                </Form.Group>
              </Col>
              <Col style={{ flex: '0 0 15%', maxWidth: '15%' }}>
                <Form.Group>
                  <Form.Label className="flex items-center">
                    SL Gap % <HelpIcon article={helpContent['strategyConfig.slTriggerToLimitGapPercentage']} />
                  </Form.Label>
                  <Form.Control
                    type="number"
                    step="0.1"
                    min="0"
                    placeholder="e.g., 6"
                    value={formData.slTriggerToLimitGapPercentage ?? ''}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        slTriggerToLimitGapPercentage: e.target.value ? Number(e.target.value) : null,
                      })
                    }
                  />
                </Form.Group>
              </Col>
              <Col style={{ flex: '0 0 15%', maxWidth: '15%' }}>
                <Form.Group>
                  <Form.Label className="flex items-center">Target % <HelpIcon article={helpContent['strategyConfig.targetPercentage']} /></Form.Label>
                  <Form.Control
                    type="number"
                    step="0.1"
                    min="0.1"
                    placeholder="e.g., 50"
                    value={formData.targetPercentage ?? ''}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        targetPercentage: e.target.value ? Number(e.target.value) : null,
                      })
                    }
                    isInvalid={!!validationErrors.targetPercentage}
                  />
                  <Form.Control.Feedback type="invalid">
                    {validationErrors.targetPercentage}
                  </Form.Control.Feedback>
                </Form.Group>
              </Col>
              <Col style={{ flex: '0 0 15%', maxWidth: '15%' }}>
                <Form.Group>
                  <Form.Label className="flex items-center">Combined SL % <HelpIcon article={helpContent['strategyConfig.combinedSLPercentage']} /></Form.Label>
                  <Form.Control
                    type="number"
                    step="0.1"
                    min="0.1"
                    placeholder="e.g., 15"
                    value={formData.combinedSLPercentage ?? ''}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        combinedSLPercentage: e.target.value ? Number(e.target.value) : null,
                      })
                    }
                    isInvalid={!!validationErrors.combinedSLPercentage}
                  />
                  <Form.Control.Feedback type="invalid">
                    {validationErrors.combinedSLPercentage}
                  </Form.Control.Feedback>
                </Form.Group>
              </Col>
              <Col style={{ flex: '0 0 15%', maxWidth: '15%' }}>
                <Form.Group>
                  <Form.Label className="flex items-center">Combined Tgt % <HelpIcon article={helpContent['strategyConfig.combinedTargetPercentage']} /></Form.Label>
                  <Form.Control
                    type="number"
                    step="0.1"
                    min="0.1"
                    placeholder="e.g., 30"
                    value={formData.combinedTargetPercentage ?? ''}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        combinedTargetPercentage: e.target.value ? Number(e.target.value) : null,
                      })
                    }
                    isInvalid={!!validationErrors.combinedTargetPercentage}
                  />
                  <Form.Control.Feedback type="invalid">
                    {validationErrors.combinedTargetPercentage}
                  </Form.Control.Feedback>
                </Form.Group>
              </Col>
            </Row>

            {/* Risk Calculation Mode */}
            <Row className="mb-4">
              <Col md={3}>
                <Form.Group>
                  <Form.Label className="flex items-center">Risk Calc Mode <HelpIcon article={helpContent['strategyConfig.riskCalculationMode']} /></Form.Label>
                  <Form.Select
                    value={formData.riskCalculationMode ?? ''}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        riskCalculationMode: e.target.value || null,
                      })
                    }
                  >
                    <option value="">-- Not Set --</option>
                    <option value="STOP_LOSS">STOP_LOSS (Stop Loss Based)</option>
                    <option value="WING_WIDTH_MAX_LOSS">WING_WIDTH_MAX_LOSS (Wing Width Max Loss)</option>
                  </Form.Select>
                </Form.Group>
              </Col>
              <Col md={3}>
                <Form.Group>
                  <Form.Label className="flex items-center">No Stop Loss <HelpIcon article={helpContent['strategyConfig.noStopLoss']} /></Form.Label>
                  <Form.Select
                    value={formData.noStopLoss === null || formData.noStopLoss === undefined ? '' : String(formData.noStopLoss)}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        noStopLoss: e.target.value === '' ? null : e.target.value === 'true',
                      })
                    }
                  >
                    <option value="">-- Not Set --</option>
                    <option value="true">Yes</option>
                    <option value="false">No</option>
                  </Form.Select>
                </Form.Group>
              </Col>
            </Row>

            {/* Trailing SL */}
            <Row className="mb-4">
              <Col md={3}>
                <Form.Group>
                  <Form.Label className="flex items-center">Trail SL <HelpIcon article={helpContent['strategyConfig.trailSL']} /></Form.Label>
                  <Form.Select
                    value={formData.trailSL === null || formData.trailSL === undefined ? '' : String(formData.trailSL)}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        trailSL: e.target.value === '' ? null : e.target.value === 'true',
                      })
                    }
                  >
                    <option value="">-- Not Set --</option>
                    <option value="true">Yes</option>
                    <option value="false">No</option>
                  </Form.Select>
                </Form.Group>
              </Col>
              <Col md={3}>
                <Form.Group>
                  <Form.Label className="flex items-center">
                    Combined Trail SL <HelpIcon article={helpContent['strategyConfig.combinedTrailSL']} />
                  </Form.Label>
                  <Form.Select
                    value={formData.combinedTrailSL === null || formData.combinedTrailSL === undefined ? '' : String(formData.combinedTrailSL)}
                    onChange={(e) => {
                      const newValue = e.target.value === '' ? null : e.target.value === 'true';
                      const newTrailConfig = mergeTrailConfigWithCombined(formData.trailConfig, newValue === true);
                      setFormData({
                        ...formData,
                        combinedTrailSL: newValue,
                        trailConfig: newTrailConfig || null,
                      });
                    }}
                  >
                    <option value="">-- Not Set --</option>
                    <option value="true">Yes</option>
                    <option value="false">No</option>
                  </Form.Select>
                </Form.Group>
              </Col>
            </Row>

            {/* Advanced Trailing SL Options */}
            <Row className="mb-4">
              <Col md={6}>
                <Form.Group>
                  <Form.Label className="flex items-center">
                    Trail SL Type <HelpIcon article={helpContent['strategyConfig.trailSLType']} />
                  </Form.Label>
                  <Form.Select
                    value={formData.trailSLType || ''}
                    onChange={(e) => {
                      const newType = e.target.value || null;
                      const includeCombined = formData.combinedTrailSL === true;
                      const newTrailConfig = getDefaultTrailConfig(newType, includeCombined);
                      setFormData({
                        ...formData,
                        trailSLType: newType,
                        trailConfig: newTrailConfig || null,
                      });
                    }}
                  >
                    <option value="">-- Not Set --</option>
                    <option value="RISK_MULTIPLE">Risk Multiple (R-Multiple)</option>
                    <option value="SUPER_TREND">SuperTrend</option>
                    <option value="ATR">ATR (Average True Range)</option>
                    <option value="EMA">EMA (Exponential Moving Average)</option>
                    <option value="HEIKIN_ASHI">Heikin Ashi</option>
                    <option value="CUSTOM">Custom</option>
                  </Form.Select>
                </Form.Group>
              </Col>
              <Col md={6}>
                <Form.Group>
                  <Form.Label className="flex items-center">
                    Trail SL to Cost <HelpIcon article={helpContent['strategyConfig.trailSLToCost']} />
                  </Form.Label>
                  <Form.Select
                    value={formData.trailSLToCost === null || formData.trailSLToCost === undefined ? '' : String(formData.trailSLToCost)}
                    onChange={(e) => {
                      const newValue = e.target.value === '' ? null : e.target.value === 'true';
                      const newTrailConfig = mergeTrailConfigWithTrailToCost(formData.trailConfig, newValue === true);
                      setFormData({
                        ...formData,
                        trailSLToCost: newValue,
                        trailConfig: newTrailConfig || null,
                      });
                    }}
                  >
                    <option value="">-- Not Set --</option>
                    <option value="true">Yes</option>
                    <option value="false">No</option>
                  </Form.Select>
                </Form.Group>
              </Col>
            </Row>

            {/* Trail Config (JSON) */}
            <Row className="mb-4">
              <Col md={12}>
                <Form.Group>
                  <Form.Label className="flex items-center">
                    Trail Config{' '}
                    <small className="text-ink-soft">(JSON)</small>
                    {' '}<HelpIcon article={helpContent['strategyConfig.trailConfig']} />
                  </Form.Label>
                  <Form.Control
                    as="textarea"
                    rows={4}
                    value={formData.trailConfig || ''}
                    onChange={(e) =>
                      setFormData({ ...formData, trailConfig: e.target.value || null })
                    }
                    placeholder='{"period": 21, "multiplier": 4.0}'
                    style={{ fontFamily: 'monospace', fontSize: '0.85rem' }}
                  />
                  <Form.Text className="text-ink-soft">
                    Keys: period, multiplier, bufferPercentage, maxDistancePercentage, profitGap, slMoveGap, trailMode, trailToCostProfitGap, trailToCostMode (risk_multiple/absolute/percentage)
                  </Form.Text>
                </Form.Group>
              </Col>
            </Row>

            {/* Order Fill Escalation Configuration */}
            <Row className="mb-4">
              <Col md={3}>
                <Form.Group>
                  <Form.Label className="flex items-center">
                    Order Fill Escalation <HelpIcon article={helpContent['strategyConfig.orderFillEscalationMode']} />
                  </Form.Label>
                  <Form.Select
                    value={formData.orderFillEscalationMode || ''}
                    onChange={(e) => {
                      const newMode = e.target.value || null;
                      // Default escalation steps JSON
                      const defaultSteps = '[{"afterSeconds":3,"type":"PERCENTAGE","value":1.0},{"afterSeconds":5,"type":"MARKET"}]';
                      setFormData({
                        ...formData,
                        orderFillEscalationMode: newMode,
                        // Only keep seconds for MARKET mode
                        orderFillEscalationSeconds: newMode === 'MARKET' ? formData.orderFillEscalationSeconds : null,
                        // Set default steps if STEP_ESCALATION, clear otherwise
                        orderFillEscalationSteps: newMode === 'STEP_ESCALATION'
                          ? (formData.orderFillEscalationSteps || defaultSteps)
                          : null,
                      });
                    }}
                  >
                    <option value="">-- Not Set --</option>
                    <option value="NONE">None</option>
                    <option value="MARKET">Market</option>
                    <option value="STEP_ESCALATION">Step Escalation</option>
                  </Form.Select>
                </Form.Group>
              </Col>
              <Col md={3}>
                <Form.Group>
                  <Form.Label className="flex items-center">
                    Escalation Seconds <HelpIcon article={helpContent['strategyConfig.orderFillEscalationSeconds']} />
                  </Form.Label>
                  <Form.Control
                    type="number"
                    min="1"
                    placeholder="e.g., 30"
                    value={formData.orderFillEscalationSeconds ?? ''}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        orderFillEscalationSeconds: e.target.value ? Number(e.target.value) : null,
                      })
                    }
                    disabled={formData.orderFillEscalationMode !== 'MARKET'}
                  />
                </Form.Group>
              </Col>
              <Col md={6}>
                <Form.Group>
                  <Form.Label className="flex items-center">
                    Escalation Steps (JSON) <HelpIcon article={helpContent['strategyConfig.orderFillEscalationSteps']} />
                  </Form.Label>
                  <Form.Control
                    type="text"
                    placeholder='e.g., [{"afterSeconds":3,"type":"PERCENTAGE","value":1.0},{"afterSeconds":5,"type":"MARKET"}]'
                    value={formData.orderFillEscalationSteps || ''}
                    onChange={(e) =>
                      setFormData({ ...formData, orderFillEscalationSteps: e.target.value || null })
                    }
                    disabled={formData.orderFillEscalationMode !== 'STEP_ESCALATION'}
                  />
                </Form.Group>
              </Col>
            </Row>

            {/* Exit Configuration */}
            <Row className="mb-4">
              <Col md={3}>
                <Form.Group>
                  <Form.Label className="flex items-center">
                    Exit Mode <HelpIcon article={helpContent['strategyConfig.exitMode']} />
                  </Form.Label>
                  <Form.Select
                    value={formData.exitMode || ''}
                    onChange={(e) => {
                      const newMode = e.target.value || null;
                      setFormData({
                        ...formData,
                        exitMode: newMode,
                        // Clear exitDays if mode doesn't use it (SAME_DAY, EXPIRY, or not set).
                        // END_OF_MONTH_FROM_ENTRY reuses exitDays as the month count N.
                        exitDays: (newMode === 'DAYS_FROM_ENTRY' || newMode === 'DTE' || newMode === 'MINUTES_FROM_ENTRY' || newMode === 'END_OF_MONTH_FROM_ENTRY') ? formData.exitDays : null,
                        // Clear exitTime for MINUTES_FROM_ENTRY (computed dynamically)
                        exitTime: newMode === 'MINUTES_FROM_ENTRY' ? null : formData.exitTime,
                      });
                    }}
                  >
                    <option value="">-- Not Set --</option>
                    <option value="SAME_DAY">Same Day</option>
                    <option value="DAYS_FROM_ENTRY">Days From Entry</option>
                    {/* Expiry-anchored modes have no meaning for equity (no expiry) */}
                    {!isEquityStrategy && <option value="DTE">Days To Expiry</option>}
                    {!isEquityStrategy && <option value="EXPIRY">Expiry</option>}
                    <option value="MINUTES_FROM_ENTRY">Minutes From Entry</option>
                    <option value="END_OF_MONTH_FROM_ENTRY">End of Month (N months from entry)</option>
                  </Form.Select>
                </Form.Group>
              </Col>
              <Col md={3}>
                <Form.Group>
                  <Form.Label className="flex items-center">
                    {formData.exitMode === 'MINUTES_FROM_ENTRY' ? 'Exit Minutes' : formData.exitMode === 'END_OF_MONTH_FROM_ENTRY' ? 'Exit Months' : 'Exit Days'} <HelpIcon article={helpContent['strategyConfig.exitDays']} />
                  </Form.Label>
                  <Form.Control
                    type="number"
                    min="0"
                    placeholder={formData.exitMode === 'MINUTES_FROM_ENTRY' ? 'e.g., 120' : formData.exitMode === 'END_OF_MONTH_FROM_ENTRY' ? 'e.g., 1' : 'e.g., 2'}
                    value={formData.exitDays ?? ''}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        exitDays: e.target.value ? Number(e.target.value) : null,
                      })
                    }
                    disabled={!formData.exitMode || formData.exitMode === 'SAME_DAY' || formData.exitMode === 'EXPIRY'}
                  />
                  {formData.exitMode === 'END_OF_MONTH_FROM_ENTRY' && (
                    <Form.Text className="text-ink-soft">N=1 exits on the last trading day of next month</Form.Text>
                  )}
                </Form.Group>
              </Col>
              {formData.exitMode !== 'MINUTES_FROM_ENTRY' && (
              <Col md={3}>
                <Form.Group>
                  <Form.Label className="flex items-center">Exit Time <HelpIcon article={helpContent['strategyConfig.exitTime']} /></Form.Label>
                  <Form.Control
                    type="text"
                    list="exitTimeOptions"
                    placeholder="HH:mm:ss or ENTRY_TIME"
                    value={formData.exitTime || ''}
                    onChange={(e) =>
                      setFormData({ ...formData, exitTime: e.target.value || null })
                    }
                  />
                  <datalist id="exitTimeOptions">
                    <option value={EXIT_TIME_ENTRY_TIME}>Same as Entry Time</option>
                    <option value="09:20:00" />
                    <option value="09:30:00" />
                    <option value="10:00:00" />
                    <option value="12:00:00" />
                    <option value="14:00:00" />
                    <option value="15:00:00" />
                    <option value="15:15:00" />
                    <option value="15:20:00" />
                  </datalist>
                </Form.Group>
              </Col>
              )}
              <Col md={3}>
                <Form.Group>
                  <Form.Label className="flex items-center">Re-Entry <HelpIcon article={helpContent['strategyConfig.reEntry']} /></Form.Label>
                  <Form.Select
                    value={formData.reEntry === null || formData.reEntry === undefined ? '' : String(formData.reEntry)}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        reEntry: e.target.value === '' ? null : e.target.value === 'true',
                      })
                    }
                  >
                    <option value="">-- Not Set --</option>
                    <option value="true">Enabled</option>
                    <option value="false">Disabled</option>
                  </Form.Select>
                </Form.Group>
              </Col>
              {formData.reEntry === true && (
                <>
                  <Col md={3}>
                    <Form.Group>
                      <Form.Label className="flex items-center">Max Re-Entries <HelpIcon article={helpContent['strategyConfig.maxReentries']} /></Form.Label>
                      <Form.Control
                        type="number"
                        min="1"
                        max="10"
                        placeholder="2"
                        value={formData.maxReentries ?? ''}
                        onChange={(e) =>
                          setFormData({
                            ...formData,
                            maxReentries: e.target.value === '' ? null : parseInt(e.target.value, 10),
                          })
                        }
                      />
                      <Form.Text className="text-ink-soft">Default: 2</Form.Text>
                    </Form.Group>
                  </Col>
                  <Col md={3}>
                    <Form.Group>
                      <Form.Label className="flex items-center">Min Loss % for Re-Entry <HelpIcon article={helpContent['strategyConfig.minReentryLossPercentage']} /></Form.Label>
                      <Form.Control
                        type="number"
                        min="0"
                        step="0.5"
                        placeholder="5.0"
                        value={formData.minReentryLossPercentage ?? ''}
                        onChange={(e) =>
                          setFormData({
                            ...formData,
                            minReentryLossPercentage: e.target.value === '' ? null : parseFloat(e.target.value),
                          })
                        }
                      />
                      <Form.Text className="text-ink-soft">Default: 0% (any loss)</Form.Text>
                    </Form.Group>
                  </Col>
                </>
              )}
            </Row>
            </div>

            {/* Breakout Watch Configuration - shown at all levels (inheritable) */}
            <div className="border rounded-md p-4 mb-4" style={{ borderColor: 'rgb(var(--c-hairline))' }}>
              <div className="text-ink-soft text-[0.875em] font-semibold mb-2" style={{ marginTop: '-1.5rem', background: 'rgb(var(--c-card))', width: 'fit-content', padding: '0 0.5rem' }}>
                <BsGear className="me-2" />
                Breakout Watch Configuration
              </div>
              <Alert variant="light" className="mb-4 py-2">
              <small>
                Instead of immediate entry at scheduled time, create a watch that triggers entry when price conditions are met.
                Useful for waiting for premium drop or underlying price movement.
              </small>
            </Alert>

            <Row className="mb-4">
              <Col md={3}>
                <Form.Group>
                  <Form.Label className="flex items-center">Breakout Watch <HelpIcon article={helpContent['strategyConfig.breakoutEnabled']} /></Form.Label>
                  <Form.Select
                    value={formData.breakoutEnabled === null || formData.breakoutEnabled === undefined ? '' : String(formData.breakoutEnabled)}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        breakoutEnabled: e.target.value === '' ? null : e.target.value === 'true',
                      })
                    }
                  >
                    <option value="">-- Not Set --</option>
                    <option value="true">Enabled</option>
                    <option value="false">Disabled</option>
                  </Form.Select>
                </Form.Group>
              </Col>
              {formData.breakoutEnabled === true && (
                <>
                  {/* Show info alert when CandleLow_NearPremium is selected with breakout */}
                  {formData.strikeType === 'CandleLow_NearPremium' && (
                    <Col md={12} className="mb-2">
                      <Alert variant="info" className="py-2 mb-0">
                        <small>
                          <strong>Candle Low Breakout:</strong> Entry triggers when option premium drops to the identified candle LOW
                          (from last {formData.lookbackMinutes || 60} minutes). Watch Type, Direction, and Trigger Mode are auto-configured.
                        </small>
                      </Alert>
                    </Col>
                  )}
                  <Col md={3}>
                    <Form.Group>
                      <Form.Label className="flex items-center">
                        Watch Type <HelpIcon article={helpContent['strategyConfig.breakoutWatchType']} />
                      </Form.Label>
                      <Form.Select
                        value={formData.strikeType === 'CandleLow_NearPremium' ? 'OPTION_SYMBOL' : (formData.breakoutWatchType || '')}
                        onChange={(e) =>
                          setFormData({
                            ...formData,
                            breakoutWatchType: (e.target.value || null) as BreakoutWatchType | null,
                          })
                        }
                        disabled={formData.strikeType === 'CandleLow_NearPremium'}
                      >
                        <option value="">-- Not Set --</option>
                        {/* Equity has no option leg — only UNDERLYING (the stock itself) can be watched */}
                        {BREAKOUT_WATCH_TYPES.filter((t) => !isEquityStrategy || t.value === 'UNDERLYING').map((t) => (
                          <option key={t.value} value={t.value}>
                            {t.label}
                          </option>
                        ))}
                      </Form.Select>
                      {formData.strikeType === 'CandleLow_NearPremium' && (
                        <Form.Text className="text-ink-soft">Auto-set for Candle Low</Form.Text>
                      )}
                      {isEquityStrategy && (
                        <Form.Text className="text-ink-soft">Equity: watch the stock price (UNDERLYING) only</Form.Text>
                      )}
                    </Form.Group>
                  </Col>
                  <Col md={3}>
                    <Form.Group>
                      <Form.Label className="flex items-center">
                        Direction <HelpIcon article={helpContent['strategyConfig.breakoutDirection']} />
                      </Form.Label>
                      <Form.Select
                        value={formData.strikeType === 'CandleLow_NearPremium' ? 'BELOW' : (formData.breakoutDirection || '')}
                        onChange={(e) =>
                          setFormData({
                            ...formData,
                            breakoutDirection: (e.target.value || null) as BreakoutDirection | null,
                          })
                        }
                        disabled={formData.strikeType === 'CandleLow_NearPremium'}
                      >
                        <option value="">-- Not Set --</option>
                        {BREAKOUT_DIRECTIONS.map((d) => (
                          <option key={d.value} value={d.value}>
                            {d.label}
                          </option>
                        ))}
                      </Form.Select>
                      {formData.strikeType === 'CandleLow_NearPremium' && (
                        <Form.Text className="text-ink-soft">Auto-set for Candle Low</Form.Text>
                      )}
                    </Form.Group>
                  </Col>
                  <Col md={3}>
                    <Form.Group>
                      <Form.Label className="flex items-center">Trigger Mode <HelpIcon article={helpContent['strategyConfig.breakoutTriggerMode']} /></Form.Label>
                      <Form.Select
                        value={formData.strikeType === 'CandleLow_NearPremium' ? 'CANDLE_LOW' : (formData.breakoutTriggerMode || '')}
                        onChange={(e) =>
                          setFormData({
                            ...formData,
                            breakoutTriggerMode: (e.target.value || null) as BreakoutTriggerMode | null,
                          })
                        }
                        disabled={formData.strikeType === 'CandleLow_NearPremium'}
                      >
                        <option value="">-- Not Set --</option>
                        {BREAKOUT_TRIGGER_MODES.map((m) => (
                          <option key={m.value} value={m.value}>
                            {m.label}
                          </option>
                        ))}
                      </Form.Select>
                      {formData.strikeType === 'CandleLow_NearPremium' && (
                        <Form.Text className="text-ink-soft">Auto-set for Candle Low</Form.Text>
                      )}
                    </Form.Group>
                  </Col>
                </>
              )}
            </Row>

            {formData.breakoutEnabled === true && formData.strikeType !== 'CandleLow_NearPremium' && (
              <Row className="mb-4">
                <Col md={3}>
                  <Form.Group>
                    <Form.Label className="flex items-center">
                      Trigger Value <HelpIcon article={helpContent['strategyConfig.breakoutTriggerValue']} />
                    </Form.Label>
                    <InputGroup>
                      <Form.Control
                        type="number"
                        min="0"
                        step="0.1"
                        placeholder={formData.breakoutTriggerMode === 'PERCENTAGE' ? 'e.g., 20' : 'e.g., 50'}
                        value={formData.breakoutTriggerValue ?? ''}
                        onChange={(e) =>
                          setFormData({
                            ...formData,
                            breakoutTriggerValue: e.target.value ? Number(e.target.value) : null,
                          })
                        }
                      />
                      <InputGroup.Text>
                        {formData.breakoutTriggerMode === 'PERCENTAGE' ? '%' : 'pts'}
                      </InputGroup.Text>
                    </InputGroup>
                  </Form.Group>
                </Col>
                {formData.breakoutWatchType === 'UNDERLYING' && !isEquityStrategy && (
                  <Col md={3}>
                    <Form.Group>
                      <Form.Label className="flex items-center">
                        Fresh Strike Selection <HelpIcon article={helpContent['strategyConfig.breakoutSelectFreshStrikes']} />
                      </Form.Label>
                      <Form.Select
                        value={formData.breakoutSelectFreshStrikes === null || formData.breakoutSelectFreshStrikes === undefined ? '' : String(formData.breakoutSelectFreshStrikes)}
                        onChange={(e) =>
                          setFormData({
                            ...formData,
                            breakoutSelectFreshStrikes: e.target.value === '' ? null : e.target.value === 'true',
                          })
                        }
                      >
                        <option value="">-- Not Set --</option>
                        <option value="true">Yes (at trigger time)</option>
                        <option value="false">No (at watch creation)</option>
                      </Form.Select>
                    </Form.Group>
                  </Col>
                )}
              </Row>
            )}

            <hr />

            </div>

            {/* Description */}
            <div className="border rounded-md p-4 mb-4" style={{ borderColor: 'rgb(var(--c-hairline))' }}>
              <div className="text-ink-soft text-[0.875em] font-semibold mb-2" style={{ marginTop: '-1.5rem', background: 'rgb(var(--c-card))', width: 'fit-content', padding: '0 0.5rem' }}>
                Notes
              </div>
              <Row>
                <Col>
                  <Form.Group className="mb-0">
                    <Form.Label className="flex items-center">Description <HelpIcon article={helpContent['strategyConfig.description']} /></Form.Label>
                    <Form.Control
                      as="textarea"
                      rows={2}
                      placeholder="Optional description for this configuration..."
                      value={formData.description || ''}
                      onChange={(e) =>
                        setFormData({ ...formData, description: e.target.value || null })
                      }
                    />
                  </Form.Group>
                </Col>
              </Row>
            </div>
          </fieldset>
          </Form>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={() => setShowModal(false)}>
            {editingConfig && !canEdit ? 'Close' : 'Cancel'}
          </Button>
          {(canEdit || !editingConfig) && (
            <Button
              variant="primary"
              onClick={handleSave}
              disabled={createMutation.isPending || updateMutation.isPending || !formData.strategyName || Object.keys(validationErrors).length > 0}
            >
              {createMutation.isPending || updateMutation.isPending ? (
                <Spinner size="sm" />
              ) : editingConfig ? (
                'Update'
              ) : (
                'Create'
              )}
            </Button>
          )}
        </Modal.Footer>
      </Modal>

      {/* Bulk Add Tranches Modal */}
      <Modal show={showBulkModal} onHide={() => setShowBulkModal(false)} size="lg" backdrop="static">
        <Modal.Header closeButton>
          <Modal.Title>Bulk Add / Update Tranch Configurations</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Row className="mb-4">
            <Col md={4}>
              <Form.Group>
                <Form.Label>Strategy <span className="text-danger-600 dark:text-danger-400">*</span></Form.Label>
                <Select
                  options={strategies?.map((s: StrategyDefinition) => ({
                    value: s.strategyName,
                    label: s.displayName || s.strategyName,
                  })) || []}
                  value={bulkStrategyName ? {
                    value: bulkStrategyName,
                    label: strategies?.find((s: StrategyDefinition) => s.strategyName === bulkStrategyName)?.displayName || bulkStrategyName,
                  } : null}
                  onChange={(option) => {
                    const strategyName = option?.value || '';
                    setBulkStrategyName(strategyName);
                    // Load existing tranch configurations for selected strategy
                    void loadBulkTranches(strategyName, bulkUsername, bulkBroker);
                  }}
                  placeholder="Select Strategy..."
                  isClearable
                  classNamePrefix="react-select"
                />
              </Form.Group>
            </Col>
            <Col md={4}>
              <Form.Group>
                <Form.Label>Username</Form.Label>
                <UserSelect
                  value={bulkUsername || ''}
                  includeAllOption={false}
                  placeholder="(Optional)"
                  onChange={(selected) => {
                    const username = selected || null;
                    setBulkUsername(username);
                    setBulkBroker(null); // Reset broker when user changes
                    // Reload tranch configs with new filter (broker reset → no broker filter)
                    void loadBulkTranches(bulkStrategyName, username, null);
                  }}
                />
              </Form.Group>
            </Col>
            <Col md={4}>
              <Form.Group>
                <Form.Label>Broker</Form.Label>
                <Select
                  options={bulkBrokerOptions}
                  value={bulkBroker ? bulkBrokerOptions.find((opt) => opt.value === bulkBroker) : null}
                  onChange={(option) => {
                    const broker = option?.value || null;
                    setBulkBroker(broker);
                    // Reload tranch configs with new filter
                    void loadBulkTranches(bulkStrategyName, bulkUsername, broker);
                  }}
                  placeholder="(Optional)"
                  isClearable
                  isDisabled={!bulkUsername}
                  classNamePrefix="react-select"
                />
                {!bulkUsername && <Form.Text className="text-ink-soft">Select a user first</Form.Text>}
              </Form.Group>
            </Col>
          </Row>

          <hr />

          <div className="mb-2 flex justify-between items-center">
            <strong>Tranch Configurations</strong>
            <Button
              variant="outline-success"
              size="sm"
              onClick={() => {
                const maxTranch = bulkTranches.reduce((max, t) =>
                  typeof t.tranchNumber === 'number' ? Math.max(max, t.tranchNumber) : max, 0);
                setBulkTranches([...bulkTranches, {
                  tranchNumber: maxTranch + 1,
                  tranchTiming: '',
                  tranchCutoffTime: '',
                  lotsPerTranch: ''
                }]);
              }}
            >
              <BsPlus /> Add Row
            </Button>
          </div>

          <Table bordered size="sm">
            <thead>
              <tr>
                <th style={{ width: '100px' }}>Tranch #</th>
                <th style={{ width: '140px' }}>Timing (HH:mm:ss)</th>
                <th style={{ width: '140px' }}>Cutoff (HH:mm:ss)</th>
                <th style={{ width: '100px' }}>Lots</th>
                <th style={{ width: '60px' }}></th>
              </tr>
            </thead>
            <tbody>
              {bulkTranches.map((tranch, index) => (
                <tr key={index}>
                  <td>
                    <Form.Control
                      type="number"
                      min="1"
                      value={tranch.tranchNumber}
                      onChange={(e) => {
                        const updated = [...bulkTranches];
                        updated[index].tranchNumber = e.target.value ? Number(e.target.value) : '';
                        setBulkTranches(updated);
                      }}
                      size="sm"
                    />
                  </td>
                  <td>
                    <Form.Control
                      type="text"
                      placeholder="09:20:00"
                      value={tranch.tranchTiming}
                      onChange={(e) => {
                        const updated = [...bulkTranches];
                        updated[index].tranchTiming = e.target.value;
                        setBulkTranches(updated);
                      }}
                      size="sm"
                      isInvalid={!!tranch.tranchTiming && !validateTimeFormat(tranch.tranchTiming)}
                    />
                  </td>
                  <td>
                    <Form.Control
                      type="text"
                      placeholder="15:00:00"
                      value={tranch.tranchCutoffTime}
                      onChange={(e) => {
                        const updated = [...bulkTranches];
                        updated[index].tranchCutoffTime = e.target.value;
                        setBulkTranches(updated);
                      }}
                      size="sm"
                      isInvalid={!!tranch.tranchCutoffTime && !validateTimeFormat(tranch.tranchCutoffTime)}
                    />
                  </td>
                  <td>
                    <Form.Control
                      type="number"
                      min="1"
                      value={tranch.lotsPerTranch}
                      onChange={(e) => {
                        const updated = [...bulkTranches];
                        updated[index].lotsPerTranch = e.target.value ? Number(e.target.value) : '';
                        setBulkTranches(updated);
                      }}
                      size="sm"
                    />
                  </td>
                  <td className="text-center">
                    <Button
                      variant="outline-danger"
                      size="sm"
                      onClick={() => {
                        if (bulkTranches.length > 1) {
                          setBulkTranches(bulkTranches.filter((_, i) => i !== index));
                        }
                      }}
                      disabled={bulkTranches.length <= 1}
                    >
                      <BsTrash />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>

          <Form.Text className="text-ink-soft">
            All other configuration values (SL, Target, Strike, etc.) will be inherited from the P0 Base configuration.
          </Form.Text>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={() => setShowBulkModal(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={
              bulkCreating ||
              !bulkStrategyName ||
              bulkTranches.length === 0 ||
              bulkTranches.some(t => !t.tranchNumber || t.tranchNumber < 1) ||
              bulkTranches.some(t => t.tranchTiming && !validateTimeFormat(t.tranchTiming)) ||
              bulkTranches.some(t => t.tranchCutoffTime && !validateTimeFormat(t.tranchCutoffTime))
            }
            onClick={async () => {
              setBulkCreating(true);
              let createdCount = 0;
              let updatedCount = 0;
              let failCount = 0;

              // Fetch the strategy's CURRENT rows fresh (one strategy, not the whole
              // tree) so create-vs-update matching sees the latest DB state.
              let existing: StrategyConfigTree[] = [];
              try {
                existing = bulkStrategyName ? await strategyConfigTreeService.getByStrategy(bulkStrategyName) : [];
              } catch {
                existing = [];
              }

              for (const tranch of bulkTranches) {
                if (!tranch.tranchNumber || tranch.tranchNumber < 1) continue;

                // Find an existing config at the SAME scope (strategy + user + broker +
                // tranch#, base/all-days only) so a re-submit UPDATES its timings/lots
                // instead of failing on the unique constraint. null user/broker is the
                // GLOBAL/all scope, compared explicitly so it never matches a narrower one.
                const match = existing.find(c =>
                  c.strategyName === bulkStrategyName &&
                  (c.username ?? null) === (bulkUsername ?? null) &&
                  (c.broker ?? null) === (bulkBroker ?? null) &&
                  (c.tranchNumber ?? null) === tranch.tranchNumber &&
                  !c.dayCondition
                );

                const values = {
                  tranchTiming: tranch.tranchTiming || null,
                  tranchCutoffTime: tranch.tranchCutoffTime || null,
                  lotsPerTranch: tranch.lotsPerTranch ? Number(tranch.lotsPerTranch) : null,
                };

                try {
                  if (match?.id) {
                    // Merge the new timing/cutoff/lots into the FULL existing config.
                    // The PUT endpoint does a full-row UPDATE, so sending only the
                    // sparse `values` here nulled out every OTHER column (strike
                    // selection, SL, target, hedging, ...) for each updated tranch —
                    // the bulk-wipe regression. Spreading `match` first preserves all
                    // other fields; `values` overrides only the three bulk-edited ones.
                    await strategyConfigTreeService.update(
                      match.id,
                      { ...match, ...values } as UpdateStrategyConfigTreeRequest,
                    );
                    updatedCount++;
                  } else {
                    await strategyConfigTreeService.create({
                      strategyName: bulkStrategyName,
                      username: bulkUsername,
                      broker: bulkBroker,
                      tranchNumber: tranch.tranchNumber as number,
                      ...values,
                    });
                    createdCount++;
                  }
                } catch (error) {
                  failCount++;
                  console.error(`Failed to save tranch ${tranch.tranchNumber}:`, error);
                }
              }

              setBulkCreating(false);

              if (createdCount > 0 || updatedCount > 0) {
                queryClient.invalidateQueries({ queryKey: ['admin', 'strategyConfigTree'] });
                const parts: string[] = [];
                if (createdCount > 0) parts.push(`created ${createdCount}`);
                if (updatedCount > 0) parts.push(`updated ${updatedCount}`);
                toast.success(`Tranch configurations ${parts.join(', ')}`);
              }
              if (failCount > 0) {
                toast.error(`Failed to save ${failCount} configuration${failCount > 1 ? 's' : ''}`);
              }

              if (failCount === 0) {
                setShowBulkModal(false);
              }
            }}
          >
            {bulkCreating ? (
              <><Spinner size="sm" className="me-1" /> Saving...</>
            ) : (
              `Save ${bulkTranches.filter(t => t.tranchNumber && t.tranchNumber >= 1).length} Configuration${bulkTranches.filter(t => t.tranchNumber && t.tranchNumber >= 1).length !== 1 ? 's' : ''}`
            )}
          </Button>
        </Modal.Footer>
      </Modal>

      {/* Delete Confirmation */}
      <ConfirmModal
        show={showDeleteConfirm}
        title="Delete Configuration"
        message={`Are you sure you want to delete this configuration?\n\n${configToDelete ? getScopeDescription(configToDelete) : ''}`}
        confirmLabel="Delete"
        confirmVariant="danger"
        onConfirm={() => configToDelete?.id && deleteMutation.mutate(configToDelete.id)}
        onCancel={() => {
          setShowDeleteConfirm(false);
          setConfigToDelete(null);
        }}
        isLoading={deleteMutation.isPending}
      />
    </>
  );
};

// ==================== EFFECTIVE CONFIG PREVIEW PANEL ====================
const EffectiveConfigPreviewPanel: React.FC = () => {
  const [username, setUsername] = useState('');
  const [broker, setBroker] = useState('');
  const [strategyName, setStrategyName] = useState('');
  const [tranchNumber, setTranchNumber] = useState<number | ''>('');
  const [dayCondition, setDayCondition] = useState('');

  const { data: strategies } = useQuery({
    queryKey: ['admin', 'strategyDefinitions', 'active'],
    queryFn: () => strategyDefinitionService.getActive(),
  });

  // Fetch users with their brokers embedded
  const { data: users } = useQuery({
    queryKey: ['admin', 'users'],
    queryFn: () => userManagementService.getUsers(),
  });

  // Prepare options for react-select
  const strategyOptions = useMemo(() => {
    return (strategies || []).map((s: StrategyDefinition) => ({
      value: s.strategyName,
      label: `${s.displayName || s.strategyName} (${s.strategyName})`,
    }));
  }, [strategies]);

  // Build user options from users who have brokers
  const userOptions = useMemo(() => {
    if (!users) return [];
    return (users as User[])
      .filter((u) => u.brokers && u.brokers.length > 0)
      .map((u) => ({
        value: u.username,
        label: u.username,
      }));
  }, [users]);

  // Build broker options based on selected user's actual brokers
  const brokerOptions = useMemo(() => {
    if (!users || !username) return [];
    const user = (users as User[]).find((u) => u.username === username);
    if (!user || !user.brokers) return [];
    return user.brokers.map((b) => ({
      value: b.broker,
      label: b.broker,
    }));
  }, [users, username]);

  const canFetch = username && broker && strategyName;

  const {
    data: effectiveConfig,
    refetch,
    isFetching,
    error: effectiveConfigError,
  } = useQuery({
    queryKey: ['admin', 'effectiveConfig', username, broker, strategyName, tranchNumber, dayCondition],
    queryFn: () =>
      strategyConfigTreeService.getEffective({
        username,
        broker,
        strategyName,
        tranchNumber: tranchNumber || undefined,
        dayCondition: dayCondition || undefined,
      }),
    enabled: false, // Manual trigger
  });

  // Show toast for effective config query errors
  useEffect(() => {
    if (effectiveConfigError) {
      const errorMessage = (effectiveConfigError as { message?: string })?.message || 'Failed to load effective configuration';
      toast.error(errorMessage);
    }
  }, [effectiveConfigError]);

  const handleLookup = () => {
    if (canFetch) {
      refetch();
    }
  };

  const renderConfigValue = (label: string, value: unknown, source?: string) => {
    if (value === null || value === undefined) return null;
    return (
      <tr>
        <td className="font-medium">{label}</td>
        <td>
          {typeof value === 'boolean' ? (
            <Badge bg={value ? 'success' : 'secondary'}>{value ? 'Yes' : 'No'}</Badge>
          ) : (
            <span>{String(value)}</span>
          )}
        </td>
        <td>
          {source && (
            <small className="text-ink-soft">{source}</small>
          )}
        </td>
      </tr>
    );
  };

  return (
    <Card>
      <Card.Header>
        <h6 className="mb-0">
          <BsEye className="me-2" />
          Effective Configuration Preview
        </h6>
        <small className="text-ink-soft">
          Test what configuration values will be applied for a specific context
        </small>
      </Card.Header>
      <Card.Body>
        <Row className="mb-4 ">
          <Col md={2}>
            <Select
              options={userOptions}
              value={userOptions.find((opt) => opt.value === username) || null}
              onChange={(option) => {
                setUsername(option?.value || '');
                setBroker(''); // Clear broker when user changes
              }}
              isClearable
              isSearchable
              placeholder="Username *"
              classNamePrefix="react-select"
            />
          </Col>
          <Col md={2}>
            <Select
              options={brokerOptions}
              value={brokerOptions.find((opt) => opt.value === broker) || null}
              onChange={(option) => setBroker(option?.value || '')}
              isClearable
              isSearchable
              placeholder="Broker *"
              classNamePrefix="react-select"
              isDisabled={!username}
            />
          </Col>
          <Col md={3}>
            <Select
              options={strategyOptions}
              value={strategyOptions.find((opt) => opt.value === strategyName) || null}
              onChange={(option) => setStrategyName(option?.value || '')}
              isClearable
              isSearchable
              placeholder="Strategy *"
              classNamePrefix="react-select"
            />
          </Col>
          <Col md={2}>
            <Form.Control
              type="number"
              placeholder="Tranch #"
              min={0}
              value={tranchNumber}
              onChange={(e) => setTranchNumber(e.target.value ? Number(e.target.value) : '')}
            />
          </Col>
          <Col md={2}>
            <Form.Select value={dayCondition} onChange={(e) => setDayCondition(e.target.value)}>
              <option value="">-- Day --</option>
              {DAY_CONDITIONS.map((d) => (
                <option key={d.value} value={d.value}>
                  {d.label}
                </option>
              ))}
            </Form.Select>
          </Col>
          <Col md={1}>
            <Button
              variant="primary"
              onClick={handleLookup}
              disabled={!canFetch || isFetching}
              className="w-full"
            >
              {isFetching ? <Spinner size="sm" /> : 'Lookup'}
            </Button>
          </Col>
        </Row>

        {!canFetch && (
          <Alert variant="info">
            Enter username, broker, and strategy to preview effective configuration.
          </Alert>
        )}

        {effectiveConfigError && (
          <Alert variant="danger">
            <strong>Error:</strong>{' '}
            {(effectiveConfigError as { message?: string })?.message || 'Failed to load effective configuration. Please try again.'}
          </Alert>
        )}

        {effectiveConfig && !effectiveConfigError && (
          <div className="overflow-x-auto">
            <Table striped size="sm">
              <thead>
                <tr>
                  <th>Parameter</th>
                  <th>Value</th>
                  <th>Source</th>
                </tr>
              </thead>
              <tbody>
                {/* Ordered: Hedge, Lots, StrikeType, Strike/Premium, ReEntry, Timing, SL, Target, TrailSL, TrailLogic, CombinedSL, CombinedTarget, CombinedTrailSL, CombinedTrailLogic */}
                {renderConfigValue('Hedging', effectiveConfig.hedgingEnabled, effectiveConfig.hedgingSource)}
                {effectiveConfig.hedgingEnabled && renderConfigValue('Hedge Strike Rounding Min %', effectiveConfig.hedgeStrikeRoundingMinDistance, undefined)}
                {renderConfigValue('Lots Per Tranch', effectiveConfig.lotsPerTranch, effectiveConfig.lotsPerTranchSource)}
                {renderConfigValue('Strike Type', effectiveConfig.strikeType || 'None', effectiveConfig.strikeTypeSource)}
                {effectiveConfig.strikeType === 'MoneyNess' && renderConfigValue('Strike Value', effectiveConfig.strikeValue, effectiveConfig.strikeValueSource)}
                {effectiveConfig.strikeType === 'FixedPremium' && renderConfigValue('Option Premium', effectiveConfig.optionPremium, effectiveConfig.optionPremiumSource)}
                {effectiveConfig.strikeType === 'PremiumRange' && renderConfigValue('Premium Range', `${effectiveConfig.optionPremium}-${effectiveConfig.optionPremiumUpper}`, effectiveConfig.optionPremiumSource)}
                {effectiveConfig.strikeType === 'PremiumRange_OIRanked' && renderConfigValue('Premium Range', `${effectiveConfig.optionPremium}-${effectiveConfig.optionPremiumUpper}`, effectiveConfig.optionPremiumSource)}
                {effectiveConfig.strikeType === 'PremiumRange_OIRanked' && renderConfigValue('OI Rank', effectiveConfig.oiRank, effectiveConfig.oiRankSource)}
                {effectiveConfig.strikeType === 'PremiumRange_OIRanked' && renderConfigValue('Ignore ITM Strikes', effectiveConfig.ignoreITMStrikes, effectiveConfig.ignoreITMStrikesSource)}
                {effectiveConfig.strikeType === 'CandleLow_NearPremium' && renderConfigValue('Target Premium', effectiveConfig.optionPremium, effectiveConfig.optionPremiumSource)}
                {effectiveConfig.strikeType === 'CandleLow_NearPremium' && renderConfigValue('Lookback Minutes', effectiveConfig.lookbackMinutes, effectiveConfig.lookbackMinutesSource)}
                {effectiveConfig.strikeType === 'CandleLow_NearPremium' && renderConfigValue('Strike Levels', effectiveConfig.otmLevels, effectiveConfig.otmLevelsSource)}
                {renderConfigValue('Volume Filter', effectiveConfig.volumeFilter, effectiveConfig.volumeFilterSource)}
                {renderConfigValue('OI Filter', effectiveConfig.oiFilter, effectiveConfig.oiFilterSource)}
                {renderConfigValue('Apply Vol Filter to Hedge', effectiveConfig.applyVolumeFilterToHedge, effectiveConfig.applyVolumeFilterToHedgeSource)}
                {renderConfigValue('Apply OI Filter to Hedge', effectiveConfig.applyOIFilterToHedge, effectiveConfig.applyOIFilterToHedgeSource)}
                {renderConfigValue('Re-Entry', effectiveConfig.reEntry, effectiveConfig.reEntrySource)}
                {effectiveConfig.reEntry && renderConfigValue('Max Re-Entries', effectiveConfig.maxReentries, effectiveConfig.maxReentriesSource)}
                {effectiveConfig.reEntry && renderConfigValue('Min Loss % for Re-Entry', effectiveConfig.minReentryLossPercentage, effectiveConfig.minReentryLossPercentageSource)}
                {renderConfigValue('Tranch Timing', effectiveConfig.tranchTiming, effectiveConfig.tranchTimingSource)}
                {renderConfigValue('Tranch CutOff Time', effectiveConfig.tranchCutoffTime, effectiveConfig.tranchCutoffSource)}
                {renderConfigValue('Max Tranches', effectiveConfig.maxTranches, effectiveConfig.maxTranchesSource)}
                {renderConfigValue('Lot Allocation Mode', effectiveConfig.lotAllocationMode, effectiveConfig.lotAllocationModeSource)}
                {renderConfigValue('Global Allocation Tranches', effectiveConfig.globalAllocationTranches, effectiveConfig.globalAllocationTranchesSource)}
                {renderConfigValue('Allocation Start Tranch', effectiveConfig.allocationStartTranch, effectiveConfig.allocationStartTranchSource)}
                {renderConfigValue('Tranch Gap', effectiveConfig.tranchGap, effectiveConfig.tranchGapSource)}
                {renderConfigValue('Min Tranch Gap', effectiveConfig.minTranchGap, effectiveConfig.minTranchGapSource)}
                {renderConfigValue('SL %', effectiveConfig.slPercentage, effectiveConfig.slSource)}
                {renderConfigValue('Target %', effectiveConfig.targetPercentage, effectiveConfig.targetSource)}
                {renderConfigValue('Trail SL', effectiveConfig.trailSL, effectiveConfig.trailSLSource)}
                {renderConfigValue('Trail SL Type', effectiveConfig.trailSLType, effectiveConfig.trailSLTypeSource)}
                {renderConfigValue('Trail Config', effectiveConfig.trailConfig, effectiveConfig.trailConfigSource)}
                {renderConfigValue('SL Buffer %', effectiveConfig.slBufferPercentage, effectiveConfig.slBufferPercentageSource)}
                {renderConfigValue('Trail SL to Cost', effectiveConfig.trailSLToCost, effectiveConfig.trailSLToCostSource)}
                {renderConfigValue('SL Trigger-Limit Gap %', effectiveConfig.slTriggerToLimitGapPercentage, effectiveConfig.slTriggerToLimitGapPercentageSource)}
                {renderConfigValue('Combined SL %', effectiveConfig.combinedSLPercentage, effectiveConfig.combinedSLSource)}
                {renderConfigValue('Combined Target %', effectiveConfig.combinedTargetPercentage, effectiveConfig.combinedTargetSource)}
                {renderConfigValue('Risk Calc Mode', effectiveConfig.riskCalculationMode, effectiveConfig.riskCalculationModeSource)}
                {renderConfigValue('No Stop Loss', effectiveConfig.noStopLoss, effectiveConfig.noStopLossSource)}
                {renderConfigValue('Combined Trail SL', effectiveConfig.combinedTrailSL, effectiveConfig.combinedTrailSLSource)}
                {renderConfigValue('Exit Mode', effectiveConfig.exitMode, effectiveConfig.exitModeSource)}
                {renderConfigValue('Exit Days', effectiveConfig.exitDays, effectiveConfig.exitDaysSource)}
                {renderConfigValue('Exit Time', effectiveConfig.exitTime, effectiveConfig.exitTimeSource)}
                {renderConfigValue('Order Fill Escalation', effectiveConfig.orderFillEscalationMode, effectiveConfig.orderFillEscalationModeSource)}
                {renderConfigValue('Escalation Seconds', effectiveConfig.orderFillEscalationSeconds, effectiveConfig.orderFillEscalationSecondsSource)}
              </tbody>
            </Table>
          </div>
        )}
      </Card.Body>
    </Card>
  );
};

// ==================== MAIN PAGE ====================
const StrategyConfigTreePage: React.FC = () => {
  const [activeTab, setActiveTab] = useState('configs');
  const permissions = usePermissions();

  // Use strategies permission for this feature
  const canEdit = permissions.strategyConfigs.canEdit;
  const canManage = permissions.strategyConfigs.canManage;

  return (
    <div className="fade-in">
      <PageHeader
        title="Strategy Configurations"
        subtitle="Hierarchical configuration overrides with priority-based inheritance"
        icon={<BsGear size={24} />}
      />

      <Alert variant="info" className="mb-4">
        <strong>How it works:</strong> Create configuration overrides at different scope levels.
        Higher priority configs (user-specific, day-specific) override lower priority ones (strategy defaults).
        Priority is calculated as: User (+16) + Broker (+8) + Tranch (+4) + Day (+2).
      </Alert>

      <Tabs activeKey={activeTab} onSelect={(k) => setActiveTab(k || 'configs')} className="mb-4">
        <Tab eventKey="configs" title="Configurations">
          <ConfigListPanel canEdit={canEdit} canManage={canManage} />
        </Tab>
        <Tab eventKey="preview" title="Preview Effective Config">
          <EffectiveConfigPreviewPanel />
        </Tab>
      </Tabs>
    </div>
  );
};

export default StrategyConfigTreePage;
