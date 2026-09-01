/**
 * Broker Configuration Page (Shared)
 * Manage Broker Exchange Configs, Broker Strategy Configs, and view Broker API Stats
 */

import { useState, useMemo, useEffect } from 'react';
import clsx from 'clsx';
import { BsGear, BsPencil, BsTrash, BsPlus, BsGraphUp, BsEye } from 'react-icons/bs';
import { toast } from 'react-toastify';
import { PageHeader, BrokerSetupRequired, MissingBrokerExchangeConfigAlert } from '@/components/common';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { brokerExchangeConfigService, brokerStrategyConfigService, brokerApiStatsService, v2BrokerService, exchangeService } from '@/services/admin/v2AdminService';
import { strategyDefinitionService } from '@/services/admin/strategyEngineService';
import type { BrokerExchangeConfig, CreateBrokerExchangeConfigRequest } from '@/types/exchange';
import type { BrokerStrategyConfig, CreateBrokerStrategyConfigRequest } from '@/services/admin/v2AdminService';
import type { StrategyDefinition } from '@/types/strategy-engine';
import { usePermissions } from '@/hooks/usePermissions';
import HelpIcon from '@/components/common/HelpIcon';
import { brokerConfigHelpContent } from '@/data/help/broker-config-help';
import { Badge, Button, Spinner, Modal, Toggle } from '@/components/ui';
import type { Tone } from '@/components/ui';

const card = 'rounded-card border border-hairline bg-card';
const cell = 'px-3 py-2';
const flabel = 'mb-1 flex items-center text-sm font-medium text-ink';
const ctrl = 'w-full rounded border border-hairline bg-card px-2 py-1.5 text-sm text-ink placeholder:text-ink-faint focus-visible:outline-none focus:border-primary-500/60 disabled:opacity-60';
const help = 'mt-1 block text-xs text-ink-soft';
const sectionTitle = 'mb-2 text-xs font-semibold uppercase tracking-wide text-ink-faint';
const thRow = 'bg-raised text-xs uppercase text-ink-faint';
const info = 'rounded border border-accent-500/30 bg-accent-500/10 px-3 py-2 text-sm text-ink';
const warn = 'rounded border border-warning-500/30 bg-warning-500/10 px-3 py-2 text-sm text-ink';
const danger = 'rounded border border-danger-500/30 bg-danger-500/10 px-3 py-2 text-sm text-danger-600 dark:text-danger-400';

const tabBtn = (active: boolean) =>
  clsx(
    '-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors',
    active ? 'border-primary-500 text-primary-500' : 'border-transparent text-ink-soft hover:text-ink',
  );

const modalTitle = (mode: 'view' | 'edit' | 'create', label: string) => (
  <span className="flex items-center gap-2">
    {mode === 'view' ? <BsEye /> : mode === 'edit' ? <BsPencil /> : null}
    {mode === 'create' ? 'Add' : mode === 'view' ? 'View' : 'Edit'} {label}
  </span>
);

// Market-protection code defaults (OrderProtections). A stored value <= 0 means "unset" and
// the engine falls back to these, so the UI shows them (dimmed) as the effective value.
const DEFAULT_LIMIT_BUFFERS: [number, number, number] = [1, 1, 15];
const DEFAULT_SL_GAPS: [number, number, number] = [1, 1, 18];

// A brand-new config starts protected, on the code defaults.
const NEW_CONFIG_PROTECTION_DEFAULTS = {
  marketOrdersAllowed: false,
  limitOrderBufferPercentageEquity: DEFAULT_LIMIT_BUFFERS[0],
  limitOrderBufferPercentageFutures: DEFAULT_LIMIT_BUFFERS[1],
  limitOrderBufferPercentageOptions: DEFAULT_LIMIT_BUFFERS[2],
  slTriggerToLimitGapPercentageEquity: DEFAULT_SL_GAPS[0],
  slTriggerToLimitGapPercentageFutures: DEFAULT_SL_GAPS[1],
  slTriggerToLimitGapPercentageOptions: DEFAULT_SL_GAPS[2],
};

/** Compact "equity/futures/options" triplet for the list table; unset values show the default dimmed. */
const Triplet: React.FC<{ values: [number, number, number]; defaults: [number, number, number] }> = ({ values, defaults }) => (
  <span className="whitespace-nowrap tabular-nums">
    {values.map((v, i) => (
      <span key={i}>
        {i > 0 && <span className="text-ink-faint">/</span>}
        <span className={v > 0 ? undefined : 'text-ink-faint'} title={v > 0 ? undefined : 'Unset — engine default'}>{v > 0 ? v : defaults[i]}</span>
      </span>
    ))}
  </span>
);

const TABS = [
  { key: 'exchange', label: 'Broker Exchange Configs' },
  { key: 'strategy', label: 'Broker Strategy Configs' },
  { key: 'stats', label: 'Broker API Stats' },
];

const BrokerConfigPage: React.FC = () => {
  const [activeTab, setActiveTab] = useState('exchange');
  const permissions = usePermissions();
  const canEdit = permissions.brokerConfig.canEdit;
  const canManage = permissions.brokerConfig.canManage;

  return (
    <BrokerSetupRequired>
      <div>
        <PageHeader title="Broker Configuration" subtitle="Manage broker exchange configs, strategy configs, and view API stats" icon={<BsGear size={24} />} />

        <MissingBrokerExchangeConfigAlert />

        <div className="mb-3 flex flex-wrap gap-1 border-b border-hairline">
          {TABS.map((t) => (
            <button key={t.key} type="button" className={tabBtn(activeTab === t.key)} onClick={() => setActiveTab(t.key)}>{t.label}</button>
          ))}
        </div>
        {activeTab === 'exchange' && <BrokerExchangeConfigPanel hideCreate={!canEdit} hideDelete={!canManage} readOnly={!canEdit} />}
        {activeTab === 'strategy' && <BrokerStrategyConfigPanel hideCreate={!canEdit} hideDelete={!canManage} readOnly={!canEdit} />}
        {activeTab === 'stats' && <BrokerApiStatsPanel />}
      </div>
    </BrokerSetupRequired>
  );
};

// ==================== BROKER EXCHANGE CONFIG PANEL ====================
interface BrokerConfigPanelProps {
  hideCreate?: boolean;
  hideDelete?: boolean;
  readOnly?: boolean;
}

const BrokerExchangeConfigPanel: React.FC<BrokerConfigPanelProps> = ({ hideCreate, hideDelete, readOnly = false }) => {
  const [selectedBroker, setSelectedBroker] = useState<string>('');
  const [selectedExchange, setSelectedExchange] = useState<string>('');
  const [showModal, setShowModal] = useState(false);
  const [modalMode, setModalMode] = useState<'view' | 'edit' | 'create'>('create');
  const [selectedConfig, setSelectedConfig] = useState<BrokerExchangeConfig | null>(null);
  const queryClient = useQueryClient();

  const { data: brokers } = useQuery({ queryKey: ['admin', 'brokers'], queryFn: () => v2BrokerService.getAll() });

  useEffect(() => {
    if (brokers && brokers.length === 1 && !selectedBroker) setSelectedBroker(brokers[0].name);
  }, [brokers]);

  const { data: exchanges } = useQuery({ queryKey: ['admin', 'exchanges'], queryFn: () => exchangeService.getAll() });

  const { data: allConfigs, isLoading, error } = useQuery({ queryKey: ['admin', 'brokerExchangeConfigs'], queryFn: () => brokerExchangeConfigService.getAll() });

  const configs = useMemo(() => {
    if (!allConfigs) return [];
    return allConfigs.filter((c) => {
      if (selectedBroker && c.brokerName !== selectedBroker) return false;
      if (selectedExchange && c.exchangeCode !== selectedExchange) return false;
      return true;
    });
  }, [allConfigs, selectedBroker, selectedExchange]);

  const [formData, setFormData] = useState<CreateBrokerExchangeConfigRequest>({
    brokerName: '',
    exchangeCode: '',
    loginMinutesBeforeMarketOpen: 30,
    intradaySquareOffMinutesBeforeClose: 15,
    intradaySquareOffBlockMinutesBeforeClose: 10,
    positionalSquareOffMinutesBeforeClose: 15,
    ...NEW_CONFIG_PROTECTION_DEFAULTS,
  });

  const createMutation = useMutation({
    mutationFn: (data: CreateBrokerExchangeConfigRequest) => brokerExchangeConfigService.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'brokerExchangeConfigs'] });
      setShowModal(false);
      toast.success('Broker exchange config created successfully');
    },
    onError: (error: { message?: string }) => toast.error(error.message || 'Failed to create config'),
  });

  const updateMutation = useMutation({
    mutationFn: (data: { brokerName: string; exchangeCode: string; updates: Partial<CreateBrokerExchangeConfigRequest> }) => brokerExchangeConfigService.update(data.brokerName, data.exchangeCode, data.updates),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'brokerExchangeConfigs'] });
      setShowModal(false);
      toast.success('Broker exchange config updated successfully');
    },
    onError: (error: { message?: string }) => toast.error(error.message || 'Failed to update config'),
  });

  const deleteMutation = useMutation({
    mutationFn: (config: BrokerExchangeConfig) => brokerExchangeConfigService.delete(config.brokerName, config.exchangeCode),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'brokerExchangeConfigs'] });
      toast.success('Config deleted successfully');
    },
    onError: (error: { message?: string }) => toast.error(error.message || 'Failed to delete config'),
  });

  const handleSave = () => {
    if (selectedConfig) {
      updateMutation.mutate({ brokerName: selectedConfig.brokerName, exchangeCode: selectedConfig.exchangeCode, updates: formData });
    } else {
      createMutation.mutate(formData);
    }
  };

  const openAddModal = () => {
    setSelectedConfig(null);
    setModalMode('create');
    setFormData({
      brokerName: selectedBroker || '',
      exchangeCode: '',
      loginMinutesBeforeMarketOpen: 30,
      intradaySquareOffMinutesBeforeClose: 15,
      intradaySquareOffBlockMinutesBeforeClose: 10,
      positionalSquareOffMinutesBeforeClose: 15,
      ...NEW_CONFIG_PROTECTION_DEFAULTS,
    });
    setShowModal(true);
  };

  const openEditModal = (config: BrokerExchangeConfig, isViewMode: boolean = false) => {
    setSelectedConfig(config);
    setModalMode(isViewMode ? 'view' : 'edit');
    setFormData({
      brokerName: config.brokerName,
      exchangeCode: config.exchangeCode,
      loginMinutesBeforeMarketOpen: config.loginMinutesBeforeMarketOpen,
      intradaySquareOffMinutesBeforeClose: config.intradaySquareOffMinutesBeforeClose,
      intradaySquareOffBlockMinutesBeforeClose: config.intradaySquareOffBlockMinutesBeforeClose,
      positionalSquareOffMinutesBeforeClose: config.positionalSquareOffMinutesBeforeClose,
      marketOrdersAllowed: config.marketOrdersAllowed,
      limitOrderBufferPercentageEquity: config.limitOrderBufferPercentageEquity,
      limitOrderBufferPercentageFutures: config.limitOrderBufferPercentageFutures,
      limitOrderBufferPercentageOptions: config.limitOrderBufferPercentageOptions,
      slTriggerToLimitGapPercentageEquity: config.slTriggerToLimitGapPercentageEquity,
      slTriggerToLimitGapPercentageFutures: config.slTriggerToLimitGapPercentageFutures,
      slTriggerToLimitGapPercentageOptions: config.slTriggerToLimitGapPercentageOptions,
      naicCode: config.naicCode,
      algoId: config.algoId,
    });
    setShowModal(true);
  };

  const disabled = modalMode === 'view';
  const lockKeys = !!selectedConfig || disabled;

  // Market-protection buffers, one group per segment. Explicit per-segment accessors keep the
  // form fully typed (no dynamic key indexing into the request payload).
  const protectionGroups = [
    {
      segment: 'Equity',
      limitValue: formData.limitOrderBufferPercentageEquity,
      onLimitChange: (v: number) => setFormData({ ...formData, limitOrderBufferPercentageEquity: v }),
      slValue: formData.slTriggerToLimitGapPercentageEquity,
      onSlChange: (v: number) => setFormData({ ...formData, slTriggerToLimitGapPercentageEquity: v }),
      limitHelp: brokerConfigHelpContent['brokerExchangeConfig.limitOrderBufferPercentageEquity'],
      slHelp: brokerConfigHelpContent['brokerExchangeConfig.slTriggerToLimitGapPercentageEquity'],
      limitDefault: DEFAULT_LIMIT_BUFFERS[0],
      slDefault: DEFAULT_SL_GAPS[0],
    },
    {
      segment: 'Futures',
      limitValue: formData.limitOrderBufferPercentageFutures,
      onLimitChange: (v: number) => setFormData({ ...formData, limitOrderBufferPercentageFutures: v }),
      slValue: formData.slTriggerToLimitGapPercentageFutures,
      onSlChange: (v: number) => setFormData({ ...formData, slTriggerToLimitGapPercentageFutures: v }),
      limitHelp: brokerConfigHelpContent['brokerExchangeConfig.limitOrderBufferPercentageFutures'],
      slHelp: brokerConfigHelpContent['brokerExchangeConfig.slTriggerToLimitGapPercentageFutures'],
      limitDefault: DEFAULT_LIMIT_BUFFERS[1],
      slDefault: DEFAULT_SL_GAPS[1],
    },
    {
      segment: 'Options',
      limitValue: formData.limitOrderBufferPercentageOptions,
      onLimitChange: (v: number) => setFormData({ ...formData, limitOrderBufferPercentageOptions: v }),
      slValue: formData.slTriggerToLimitGapPercentageOptions,
      onSlChange: (v: number) => setFormData({ ...formData, slTriggerToLimitGapPercentageOptions: v }),
      limitHelp: brokerConfigHelpContent['brokerExchangeConfig.limitOrderBufferPercentageOptions'],
      slHelp: brokerConfigHelpContent['brokerExchangeConfig.slTriggerToLimitGapPercentageOptions'],
      limitDefault: DEFAULT_LIMIT_BUFFERS[2],
      slDefault: DEFAULT_SL_GAPS[2],
    },
  ];

  if (error) {
    const errorMessage = (error as { message?: string })?.message || 'Failed to load broker exchange configs';
    return <div className={danger}>{errorMessage}</div>;
  }

  return (
    <>
      <div className={card}>
        <div className="flex flex-wrap items-center gap-3 border-b border-hairline p-3">
          <select className={`${ctrl} md:w-56`} value={selectedBroker} onChange={(e) => setSelectedBroker(e.target.value)}>
            <option value="">All Brokers</option>
            {brokers?.map((b) => (
              <option key={b.name} value={b.name}>{b.displayName || b.name}</option>
            ))}
          </select>
          <select className={`${ctrl} md:w-56`} value={selectedExchange} onChange={(e) => setSelectedExchange(e.target.value)}>
            <option value="">All Exchanges</option>
            {exchanges?.map((e) => (
              <option key={e.exchange} value={e.exchange}>{e.exchangeName} ({e.exchange})</option>
            ))}
          </select>
          {!hideCreate && (
            <Button variant="primary" className="ml-auto" onClick={openAddModal}>
              <BsPlus /> Add Config
            </Button>
          )}
        </div>
        <div>
          {isLoading ? (
            <div className="py-10 text-center text-primary-500"><Spinner /></div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm [&_tbody_tr]:border-b [&_tbody_tr]:border-hairline">
                <thead className={thRow}>
                  <tr>
                    <th className={`${cell} text-left`}>Broker</th>
                    <th className={`${cell} text-left`}>Exchange</th>
                    <th className={`${cell} text-left`}>Login (mins before open)</th>
                    <th className={`${cell} text-left`}>Intraday SqOff (mins)</th>
                    <th className={`${cell} text-left`}>Intraday Block (mins)</th>
                    <th className={`${cell} text-left`}>Positional SqOff (mins)</th>
                    <th className={`${cell} text-left`}>Market Orders</th>
                    <th className={`${cell} text-left`} title="Equity / Futures / Options">Limit Buffer % (E/F/O)</th>
                    <th className={`${cell} text-left`} title="Equity / Futures / Options">SL Gap % (E/F/O)</th>
                    <th className={`${cell} text-left`}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {!configs || configs.length === 0 ? (
                    <tr><td colSpan={10} className="py-4 text-center text-ink-soft">No configs found</td></tr>
                  ) : (
                    configs.map((config) => (
                      <tr key={`${config.brokerName}-${config.exchangeCode}`} className="hover:bg-raised/50">
                        <td className={`${cell} font-medium text-ink`}>{config.brokerName}</td>
                        <td className={cell}><Badge tone="info">{config.exchangeCode}</Badge></td>
                        <td className={`${cell} text-ink`}>{config.loginMinutesBeforeMarketOpen}</td>
                        <td className={`${cell} text-ink`}>{config.intradaySquareOffMinutesBeforeClose}</td>
                        <td className={`${cell} text-ink`}>{config.intradaySquareOffBlockMinutesBeforeClose}</td>
                        <td className={`${cell} text-ink`}>{config.positionalSquareOffMinutesBeforeClose}</td>
                        <td className={cell}><Badge tone={config.marketOrdersAllowed ? 'success' : 'neutral'}>{config.marketOrdersAllowed ? 'Yes' : 'No'}</Badge></td>
                        <td className={`${cell} text-ink`}>
                          <Triplet
                            values={[config.limitOrderBufferPercentageEquity, config.limitOrderBufferPercentageFutures, config.limitOrderBufferPercentageOptions]}
                            defaults={DEFAULT_LIMIT_BUFFERS}
                          />
                        </td>
                        <td className={`${cell} text-ink`}>
                          <Triplet
                            values={[config.slTriggerToLimitGapPercentageEquity, config.slTriggerToLimitGapPercentageFutures, config.slTriggerToLimitGapPercentageOptions]}
                            defaults={DEFAULT_SL_GAPS}
                          />
                        </td>
                        <td className={cell}>
                          <div className="flex gap-1">
                            <Button variant="secondary" size="sm" onClick={() => openEditModal(config, readOnly)} title={readOnly ? 'View' : 'Edit'}>{readOnly ? <BsEye /> : <BsPencil />}</Button>
                            {!hideDelete && <Button variant="danger" size="sm" onClick={() => deleteMutation.mutate(config)} disabled={deleteMutation.isPending}><BsTrash /></Button>}
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <Modal
        open={showModal}
        onClose={() => setShowModal(false)}
        size="lg"
        title={modalTitle(modalMode, 'Broker Exchange Config')}
        footer={
          <>
            <Button variant="secondary" onClick={() => setShowModal(false)}>{disabled ? 'Close' : 'Cancel'}</Button>
            {!disabled && (
              <Button variant="primary" onClick={handleSave} disabled={createMutation.isPending || updateMutation.isPending || !formData.brokerName || !formData.exchangeCode}>
                {createMutation.isPending || updateMutation.isPending ? <Spinner size="sm" /> : 'Save'}
              </Button>
            )}
          </>
        }
      >
        <fieldset disabled={disabled} className="border-0 p-0">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div>
              <label className={flabel}>Broker <HelpIcon article={brokerConfigHelpContent['brokerExchangeConfig.broker']} /></label>
              <select className={ctrl} value={formData.brokerName} disabled={lockKeys} onChange={(e) => setFormData({ ...formData, brokerName: e.target.value })}>
                <option value="">Select Broker...</option>
                {brokers?.map((b) => (
                  <option key={b.name} value={b.name}>{b.displayName || b.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={flabel}>Exchange <HelpIcon article={brokerConfigHelpContent['brokerExchangeConfig.exchange']} /></label>
              <select className={ctrl} value={formData.exchangeCode} disabled={lockKeys} onChange={(e) => setFormData({ ...formData, exchangeCode: e.target.value })}>
                <option value="">Select Exchange...</option>
                {exchanges?.map((e) => (
                  <option key={e.exchange} value={e.exchange}>{e.exchangeName} ({e.exchange})</option>
                ))}
              </select>
            </div>
            <div>
              <label className={flabel}>Login Minutes Before Market Open <HelpIcon article={brokerConfigHelpContent['brokerExchangeConfig.loginMinutesBeforeMarketOpen']} /></label>
              <input type="number" className={ctrl} value={formData.loginMinutesBeforeMarketOpen} onChange={(e) => setFormData({ ...formData, loginMinutesBeforeMarketOpen: Number(e.target.value) })} />
            </div>
            <div>
              <label className={flabel}>Intraday Square-off Minutes Before Close <HelpIcon article={brokerConfigHelpContent['brokerExchangeConfig.intradaySquareOffMinutesBeforeClose']} /></label>
              <input type="number" className={ctrl} value={formData.intradaySquareOffMinutesBeforeClose} onChange={(e) => setFormData({ ...formData, intradaySquareOffMinutesBeforeClose: Number(e.target.value) })} />
            </div>
            <div>
              <label className={flabel}>Intraday Square-off Block Minutes <HelpIcon article={brokerConfigHelpContent['brokerExchangeConfig.intradaySquareOffBlockMinutesBeforeClose']} /></label>
              <input type="number" className={ctrl} value={formData.intradaySquareOffBlockMinutesBeforeClose} onChange={(e) => setFormData({ ...formData, intradaySquareOffBlockMinutesBeforeClose: Number(e.target.value) })} />
            </div>
            <div>
              <label className={flabel}>Positional Square-off Minutes Before Close <HelpIcon article={brokerConfigHelpContent['brokerExchangeConfig.positionalSquareOffMinutesBeforeClose']} /></label>
              <input type="number" className={ctrl} value={formData.positionalSquareOffMinutesBeforeClose} onChange={(e) => setFormData({ ...formData, positionalSquareOffMinutesBeforeClose: Number(e.target.value) })} />
            </div>
          </div>
          <div className="mt-4 border-t border-hairline pt-3">
            <div className={sectionTitle}>Market Protection</div>
            <div>
              <label className={flabel}>Market Orders Allowed <HelpIcon article={brokerConfigHelpContent['brokerExchangeConfig.marketOrdersAllowed']} /></label>
              <label className="flex cursor-pointer items-center gap-2">
                <Toggle checked={!!formData.marketOrdersAllowed} disabled={disabled} onChange={(checked) => setFormData({ ...formData, marketOrdersAllowed: checked })} />
                <span className="text-sm text-ink">{formData.marketOrdersAllowed ? 'Yes' : 'No'}</span>
              </label>
              <span className={help}>
                {formData.marketOrdersAllowed
                  ? 'MARKET and SL-M orders go to the broker as-is — the buffers below are ignored. Only for brokers confirmed to accept raw market orders.'
                  : 'MARKET and SL-M orders are converted to marketable LIMIT / SL orders using the per-segment buffers below. Required by brokers like Zerodha, whose API rejects raw market orders.'}
              </span>
            </div>

            <div className={clsx('mt-3 grid grid-cols-1 gap-3 md:grid-cols-3', formData.marketOrdersAllowed && 'opacity-60')}>
              {protectionGroups.map((g) => (
                <div key={g.segment} className="rounded border border-hairline p-3">
                  <div className={sectionTitle}>{g.segment}</div>
                  <div className="mb-3">
                    <label className={flabel}>Limit Order Buffer % <HelpIcon article={g.limitHelp} /></label>
                    <input type="number" step="0.1" min="0" className={ctrl} value={g.limitValue ?? 0} onChange={(e) => g.onLimitChange(Number(e.target.value))} />
                  </div>
                  <div>
                    <label className={flabel}>SL Trigger&rarr;Limit Gap % <HelpIcon article={g.slHelp} /></label>
                    <input type="number" step="0.1" min="0" className={ctrl} value={g.slValue ?? 0} onChange={(e) => g.onSlChange(Number(e.target.value))} />
                  </div>
                  <span className={help}>0 = unset, engine uses {g.limitDefault}% / {g.slDefault}%.</span>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
            <div>
              <label className={flabel}>NAIC Code (override) <HelpIcon article={brokerConfigHelpContent['brokerExchangeConfig.naicCode']} /></label>
              <input className={ctrl} value={formData.naicCode ?? ''} onChange={(e) => setFormData({ ...formData, naicCode: e.target.value })} placeholder="e.g. 118" maxLength={8} />
              <span className={help}>Algo-tagging override for this exchange. Empty = use the broker-level value.</span>
            </div>
            <div>
              <label className={flabel}>Algo ID (override) <HelpIcon article={brokerConfigHelpContent['brokerExchangeConfig.algoId']} /></label>
              <input className={ctrl} value={formData.algoId ?? ''} onChange={(e) => setFormData({ ...formData, algoId: e.target.value })} placeholder="e.g. AA32" maxLength={32} />
              <span className={help}>Exchange-approved algo id override. Empty = use the broker-level value.</span>
            </div>
          </div>
        </fieldset>
      </Modal>
    </>
  );
};

// ==================== BROKER STRATEGY CONFIG PANEL ====================
const BrokerStrategyConfigPanel: React.FC<BrokerConfigPanelProps> = ({ hideCreate, hideDelete, readOnly = false }) => {
  const [selectedBroker, setSelectedBroker] = useState<string>('');
  const [selectedStrategy, setSelectedStrategy] = useState<string>('');
  const [showModal, setShowModal] = useState(false);
  const [modalMode, setModalMode] = useState<'view' | 'edit' | 'create'>('create');
  const [selectedConfig, setSelectedConfig] = useState<BrokerStrategyConfig | null>(null);
  const queryClient = useQueryClient();

  const { data: brokers } = useQuery({ queryKey: ['admin', 'brokers'], queryFn: () => v2BrokerService.getAll() });

  useEffect(() => {
    if (brokers && brokers.length === 1 && !selectedBroker) setSelectedBroker(brokers[0].name);
  }, [brokers]);

  const { data: strategies } = useQuery({ queryKey: ['strategyDefinitions'], queryFn: () => strategyDefinitionService.getAll() });

  const { data: allConfigs, isLoading, error } = useQuery({ queryKey: ['admin', 'brokerStrategyConfigs'], queryFn: () => brokerStrategyConfigService.getAll() });

  const configs = useMemo(() => {
    if (!allConfigs) return [];
    return allConfigs.filter((c) => {
      if (selectedBroker && c.broker !== selectedBroker) return false;
      if (selectedStrategy && c.strategyName !== selectedStrategy) return false;
      return true;
    });
  }, [allConfigs, selectedBroker, selectedStrategy]);

  const [formData, setFormData] = useState({ broker: '', strategyName: '', intradaySquareOffMinutesBeforeClose: 15, positionalSquareOffMinutesBeforeClose: 15 });

  const createMutation = useMutation({
    mutationFn: (data: CreateBrokerStrategyConfigRequest) => brokerStrategyConfigService.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'brokerStrategyConfigs'] });
      setShowModal(false);
      toast.success('Broker strategy config created successfully');
    },
    onError: (error: { message?: string }) => toast.error(error.message || 'Failed to create config'),
  });

  const updateMutation = useMutation({
    mutationFn: (data: { broker: string; strategyName: string; updates: Partial<CreateBrokerStrategyConfigRequest> }) => brokerStrategyConfigService.update(data.broker, data.strategyName, data.updates),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'brokerStrategyConfigs'] });
      setShowModal(false);
      toast.success('Broker strategy config updated successfully');
    },
    onError: (error: { message?: string }) => toast.error(error.message || 'Failed to update config'),
  });

  const deleteMutation = useMutation({
    mutationFn: (config: BrokerStrategyConfig) => brokerStrategyConfigService.delete(config.broker, config.strategyName),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'brokerStrategyConfigs'] });
      toast.success('Config deleted successfully');
    },
    onError: (error: { message?: string }) => toast.error(error.message || 'Failed to delete config'),
  });

  const handleSave = () => {
    const payload: CreateBrokerStrategyConfigRequest = { ...formData, orderType: 'MIS' };
    if (selectedConfig) {
      updateMutation.mutate({ broker: selectedConfig.broker, strategyName: selectedConfig.strategyName, updates: payload });
    } else {
      createMutation.mutate(payload);
    }
  };

  const openAddModal = () => {
    setSelectedConfig(null);
    setModalMode('create');
    setFormData({ broker: selectedBroker || '', strategyName: '', intradaySquareOffMinutesBeforeClose: 15, positionalSquareOffMinutesBeforeClose: 15 });
    setShowModal(true);
  };

  const openEditModal = (config: BrokerStrategyConfig, isViewMode: boolean = false) => {
    setSelectedConfig(config);
    setModalMode(isViewMode ? 'view' : 'edit');
    setFormData({
      broker: config.broker,
      strategyName: config.strategyName,
      intradaySquareOffMinutesBeforeClose: config.intradaySquareOffMinutesBeforeClose,
      positionalSquareOffMinutesBeforeClose: config.positionalSquareOffMinutesBeforeClose,
    });
    setShowModal(true);
  };

  const disabled = modalMode === 'view';
  const lockKeys = !!selectedConfig || disabled;

  if (error) {
    const errorMessage = (error as { message?: string })?.message || 'Failed to load broker strategy configs';
    return <div className={danger}>{errorMessage}</div>;
  }

  return (
    <>
      <div className={card}>
        <div className="flex flex-wrap items-center gap-3 border-b border-hairline p-3">
          <select className={`${ctrl} md:w-56`} value={selectedBroker} onChange={(e) => setSelectedBroker(e.target.value)}>
            <option value="">All Brokers</option>
            {brokers?.map((b) => (
              <option key={b.name} value={b.name}>{b.displayName || b.name}</option>
            ))}
          </select>
          <select className={`${ctrl} md:w-64`} value={selectedStrategy} onChange={(e) => setSelectedStrategy(e.target.value)}>
            <option value="">All Strategies</option>
            {strategies?.map((s: StrategyDefinition) => (
              <option key={s.strategyName} value={s.strategyName}>{s.displayName || s.strategyName}</option>
            ))}
          </select>
          {!hideCreate && (
            <Button variant="primary" className="ml-auto" onClick={openAddModal}>
              <BsPlus /> Add Config
            </Button>
          )}
        </div>
        <div>
          {isLoading ? (
            <div className="py-10 text-center text-primary-500"><Spinner /></div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm [&_tbody_tr]:border-b [&_tbody_tr]:border-hairline">
                <thead className={thRow}>
                  <tr>
                    <th className={`${cell} text-left`}>Broker</th>
                    <th className={`${cell} text-left`}>Strategy</th>
                    <th className={`${cell} text-left`}>Intraday SqOff (mins)</th>
                    <th className={`${cell} text-left`}>Positional SqOff (mins)</th>
                    <th className={`${cell} text-left`}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {!configs || configs.length === 0 ? (
                    <tr><td colSpan={5} className="py-4 text-center text-ink-soft">No configs found</td></tr>
                  ) : (
                    configs.map((config) => (
                      <tr key={`${config.broker}-${config.strategyName}`} className="hover:bg-raised/50">
                        <td className={`${cell} font-medium text-ink`}>{config.broker}</td>
                        <td className={`${cell} text-ink`}>{strategies?.find((s: StrategyDefinition) => s.strategyName === config.strategyName)?.displayName || config.strategyName}</td>
                        <td className={`${cell} text-ink`}>{config.intradaySquareOffMinutesBeforeClose}</td>
                        <td className={`${cell} text-ink`}>{config.positionalSquareOffMinutesBeforeClose}</td>
                        <td className={cell}>
                          <div className="flex gap-1">
                            <Button variant="secondary" size="sm" onClick={() => openEditModal(config, readOnly)} title={readOnly ? 'View' : 'Edit'}>{readOnly ? <BsEye /> : <BsPencil />}</Button>
                            {!hideDelete && <Button variant="danger" size="sm" onClick={() => deleteMutation.mutate(config)} disabled={deleteMutation.isPending}><BsTrash /></Button>}
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <Modal
        open={showModal}
        onClose={() => setShowModal(false)}
        title={modalTitle(modalMode, 'Broker Strategy Config')}
        footer={
          <>
            <Button variant="secondary" onClick={() => setShowModal(false)}>{disabled ? 'Close' : 'Cancel'}</Button>
            {!disabled && (
              <Button variant="primary" onClick={handleSave} disabled={createMutation.isPending || updateMutation.isPending || !formData.broker || !formData.strategyName}>
                {createMutation.isPending || updateMutation.isPending ? <Spinner size="sm" /> : 'Save'}
              </Button>
            )}
          </>
        }
      >
        <fieldset disabled={disabled} className="border-0 p-0">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div>
              <label className={flabel}>Broker <HelpIcon article={brokerConfigHelpContent['brokerStrategyConfig.broker']} /></label>
              <select className={ctrl} value={formData.broker} disabled={lockKeys} onChange={(e) => setFormData({ ...formData, broker: e.target.value })}>
                <option value="">Select Broker...</option>
                {brokers?.map((b) => (
                  <option key={b.name} value={b.name}>{b.displayName || b.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={flabel}>Strategy <HelpIcon article={brokerConfigHelpContent['brokerStrategyConfig.strategy']} /></label>
              <select className={ctrl} value={formData.strategyName} disabled={lockKeys} onChange={(e) => setFormData({ ...formData, strategyName: e.target.value })}>
                <option value="">Select Strategy...</option>
                {strategies?.map((s: StrategyDefinition) => (
                  <option key={s.strategyName} value={s.strategyName}>{s.displayName || s.strategyName}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={flabel}>Intraday Square-off Minutes <HelpIcon article={brokerConfigHelpContent['brokerStrategyConfig.intradaySquareOffMinutes']} /></label>
              <input type="number" className={ctrl} value={formData.intradaySquareOffMinutesBeforeClose} onChange={(e) => setFormData({ ...formData, intradaySquareOffMinutesBeforeClose: Number(e.target.value) })} />
            </div>
            <div>
              <label className={flabel}>Positional Square-off Minutes <HelpIcon article={brokerConfigHelpContent['brokerStrategyConfig.positionalSquareOffMinutes']} /></label>
              <input type="number" className={ctrl} value={formData.positionalSquareOffMinutesBeforeClose} onChange={(e) => setFormData({ ...formData, positionalSquareOffMinutesBeforeClose: Number(e.target.value) })} />
            </div>
          </div>
        </fieldset>
      </Modal>
    </>
  );
};

// ==================== BROKER API STATS PANEL ====================
const latencyTone = (ms: number): Tone => (ms > 1000 ? 'danger' : ms > 500 ? 'warning' : 'success');

const BrokerApiStatsPanel: React.FC = () => {
  const [selectedBroker, setSelectedBroker] = useState<string>('all');
  const [selectedDate, setSelectedDate] = useState<string>(new Date().toISOString().split('T')[0]);

  const { data: brokers } = useQuery({ queryKey: ['admin', 'brokers'], queryFn: () => v2BrokerService.getAll() });

  useEffect(() => {
    if (brokers && brokers.length === 1 && selectedBroker === 'all') setSelectedBroker(brokers[0].name);
  }, [brokers]);

  const { data: stats, isLoading, error, refetch } = useQuery({
    queryKey: ['admin', 'brokerApiStats', selectedBroker, selectedDate],
    queryFn: () => brokerApiStatsService.getStats({ broker: selectedBroker === 'all' ? undefined : selectedBroker, date: selectedDate }),
    enabled: !!selectedDate,
  });

  const aggregatedStats = useMemo(() => {
    if (!stats || stats.length === 0) return null;
    const totalRequests = stats.length;
    const totalTime = stats.reduce((sum, s) => sum + s.timeTaken, 0);
    const avgLatency = Math.round(totalTime / totalRequests);
    const maxLatency = Math.max(...stats.map((s) => s.timeTaken));
    const minLatency = Math.min(...stats.map((s) => s.timeTaken));
    const operationStats: Record<string, { count: number; totalTime: number; maxTime: number }> = {};
    stats.forEach((s) => {
      if (!operationStats[s.operation]) operationStats[s.operation] = { count: 0, totalTime: 0, maxTime: 0 };
      operationStats[s.operation].count++;
      operationStats[s.operation].totalTime += s.timeTaken;
      operationStats[s.operation].maxTime = Math.max(operationStats[s.operation].maxTime, s.timeTaken);
    });
    return { totalRequests, avgLatency, maxLatency, minLatency, operationStats };
  }, [stats]);

  if (error) {
    const errorMessage = (error as { message?: string })?.message || 'Failed to load broker API stats';
    return <div className={danger}>{errorMessage}</div>;
  }

  const summaryTiles = [
    { value: aggregatedStats?.totalRequests, label: 'Total Requests' },
    { value: `${aggregatedStats?.avgLatency}ms`, label: 'Avg Latency' },
    { value: `${aggregatedStats?.maxLatency}ms`, label: 'Max Latency' },
    { value: `${aggregatedStats?.minLatency}ms`, label: 'Min Latency' },
  ];

  return (
    <div className={card}>
      <div className="flex flex-wrap items-center gap-3 border-b border-hairline p-3">
        <select className={`${ctrl} md:w-56`} value={selectedBroker} onChange={(e) => setSelectedBroker(e.target.value)}>
          <option value="all">All Brokers</option>
          {brokers?.map((b) => (
            <option key={b.name} value={b.name}>{b.displayName || b.name}</option>
          ))}
        </select>
        <input type="date" className={`${ctrl} md:w-44`} value={selectedDate} onChange={(e) => setSelectedDate(e.target.value)} />
        <Button variant="secondary" className="ml-auto" onClick={() => refetch()} disabled={!selectedDate}>
          <BsGraphUp /> Refresh
        </Button>
      </div>
      <div className="p-4">
        {!selectedDate ? (
          <div className={info}>Select a date to view API statistics.</div>
        ) : isLoading ? (
          <div className="py-10 text-center text-primary-500"><Spinner /></div>
        ) : !stats || stats.length === 0 ? (
          <div className={warn}>No API stats found for {selectedBroker === 'all' ? 'all brokers' : selectedBroker} on {selectedDate}.</div>
        ) : (
          <>
            <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
              {summaryTiles.map((t) => (
                <div key={t.label} className="rounded bg-raised p-3 text-center">
                  <h4 className="mb-0 text-xl font-bold text-ink">{t.value}</h4>
                  <small className="text-ink-soft">{t.label}</small>
                </div>
              ))}
            </div>

            <h6 className="mb-3 font-semibold text-ink">Operation-wise Statistics</h6>
            <div className="mb-4 overflow-x-auto">
              <table className="w-full text-sm [&_tbody_tr]:border-b [&_tbody_tr]:border-hairline">
                <thead className={thRow}>
                  <tr>
                    <th className={`${cell} text-left`}>Operation</th>
                    <th className={`${cell} text-left`}>Count</th>
                    <th className={`${cell} text-left`}>Avg Latency</th>
                    <th className={`${cell} text-left`}>Max Latency</th>
                  </tr>
                </thead>
                <tbody>
                  {aggregatedStats && Object.entries(aggregatedStats.operationStats).map(([op, data]) => (
                    <tr key={op} className="hover:bg-raised/50">
                      <td className={`${cell} font-medium text-ink`}>{op}</td>
                      <td className={`${cell} text-ink`}>{data.count}</td>
                      <td className={`${cell} text-ink`}>{Math.round(data.totalTime / data.count)}ms</td>
                      <td className={`${cell} text-ink`}>{data.maxTime}ms</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <h6 className="mb-3 font-semibold text-ink">Recent Requests (Last 50)</h6>
            <div className="overflow-x-auto">
              <table className="w-full text-sm [&_tbody_tr]:border-b [&_tbody_tr]:border-hairline">
                <thead className={thRow}>
                  <tr>
                    <th className={`${cell} text-left`}>Operation</th>
                    <th className={`${cell} text-left`}>Entity ID</th>
                    <th className={`${cell} text-left`}>Start Time</th>
                    <th className={`${cell} text-left`}>Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.slice(0, 50).map((stat, i) => (
                    <tr key={i} className="hover:bg-raised/50">
                      <td className={`${cell} text-ink`}>{stat.operation}</td>
                      <td className={cell}><code className="text-ink">{stat.entityId || '-'}</code></td>
                      <td className={`${cell} text-ink`}>{new Date(stat.startEpoch).toLocaleTimeString()}</td>
                      <td className={cell}><Badge tone={latencyTone(stat.timeTaken)}>{stat.timeTaken}ms</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default BrokerConfigPage;
