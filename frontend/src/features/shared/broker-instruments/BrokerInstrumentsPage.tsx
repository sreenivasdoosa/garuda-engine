/**
 * Broker Instruments Page
 * Displays broker instrument statistics, search functionality, and advanced lookup
 */

import { useState, useMemo, useCallback, useEffect } from 'react';
import clsx from 'clsx';
import { BsBarChartFill, BsSearch, BsFileEarmarkText, BsCloudDownload, BsArrowClockwise, BsCheckCircle, BsXCircle, BsExclamationTriangle } from 'react-icons/bs';
import { toast } from 'react-toastify';
import { PageHeader, BrokerSetupRequired, MissingBrokerExchangeConfigAlert } from '@/components/common';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { brokerInstrumentsService } from '@/services/admin/v2AdminService';
import { brokerService } from '@/services/broker/brokerService';
import type { InstrumentSearchResult, InstrumentLookupResult, BrokerInstrumentsStats } from '@/types/broker-instruments';
import { Badge, Button, Spinner, Tooltip } from '@/components/ui';
import type { Tone } from '@/components/ui';

const card = 'rounded-card border border-hairline bg-card';
const cardHeadRow = 'flex items-center justify-between border-b border-hairline p-3';
const cell = 'px-3 py-2';
const flabel = 'mb-1 block text-sm font-medium text-ink';
const ctrl = 'w-full rounded border border-hairline bg-card px-2 py-1.5 text-sm text-ink placeholder:text-ink-faint focus-visible:outline-none focus:border-primary-500/60 disabled:opacity-60';
const thRow = 'bg-raised text-xs uppercase text-ink-faint';
const info = 'rounded border border-accent-500/30 bg-accent-500/10 px-3 py-2 text-sm text-ink';
const danger = 'rounded border border-danger-500/30 bg-danger-500/10 px-3 py-2 text-sm text-danger-600 dark:text-danger-400';
const warn = 'rounded border border-warning-500/30 bg-warning-500/10 px-3 py-2 text-sm text-ink';

const tabBtn = (active: boolean) =>
  clsx(
    '-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors',
    active ? 'border-primary-500 text-primary-500' : 'border-transparent text-ink-soft hover:text-ink',
  );

const instrumentTypeTone = (t: string | undefined): Tone => {
  switch (t) {
    case 'CE': return 'success';
    case 'PE': return 'danger';
    case 'FUT': return 'warning';
    default: return 'neutral';
  }
};

const TABS = [
  { key: 'stats', label: 'Instrument Statistics' },
  { key: 'search', label: 'Instrument Search' },
  { key: 'lookup', label: 'Advanced Lookup' },
];

const BrokerInstrumentsPage: React.FC = () => {
  const [activeTab, setActiveTab] = useState('stats');

  return (
    <BrokerSetupRequired>
      <div className="fade-in">
        <PageHeader title="Broker Instruments" subtitle="View instrument statistics, search instruments, and perform advanced lookups" icon={<BsFileEarmarkText size={24} />} />

        <MissingBrokerExchangeConfigAlert />

        <div className="mb-3 flex flex-wrap gap-1 border-b border-hairline">
          {TABS.map((t) => (
            <button key={t.key} type="button" className={tabBtn(activeTab === t.key)} onClick={() => setActiveTab(t.key)}>{t.label}</button>
          ))}
        </div>
        {activeTab === 'stats' && <InstrumentStatsPanel />}
        {activeTab === 'search' && <InstrumentSearchPanel />}
        {activeTab === 'lookup' && <InstrumentLookupPanel />}
      </div>
    </BrokerSetupRequired>
  );
};

// ==================== INSTRUMENT STATS PANEL ====================
const FILE_SIZE_WARNING_THRESHOLD = 0.7;

interface StatsPanelProps {
}

const InstrumentStatsPanel: React.FC<StatsPanelProps> = () => {
  const queryClient = useQueryClient();

  const { data: stats, isLoading: statsLoading, error: statsError, refetch } = useQuery({
    queryKey: ['broker-instruments-stats'],
    queryFn: () => brokerInstrumentsService.getAllStats(),
  });

  const { data: brokers, isLoading: brokersLoading } = useQuery({
    queryKey: ['brokers'],
    queryFn: () => brokerService.getAll(),
  });

  const mergedStats = useMemo((): BrokerInstrumentsStats[] => {
    const enabledBrokers = brokers?.filter((b) => b.enabled) || [];
    const statsMap = new Map(stats?.map((s) => [s.brokerName, s]) || []);
    return enabledBrokers.map((broker) => {
      const existingStats = statsMap.get(broker.name);
      if (existingStats) return existingStats;
      return { brokerName: broker.name, instrumentsCount: 0, originalFileSize: 0, normalizedFileSize: 0, lastDownloadedTime: null, cacheLoaded: false };
    });
  }, [brokers, stats]);

  const isLoading = statsLoading || brokersLoading;
  const error = statsError;

  const downloadMutation = useMutation({
    mutationFn: (broker: string) => brokerInstrumentsService.downloadInstruments(broker),
    onSuccess: (_data, broker) => {
      queryClient.invalidateQueries({ queryKey: ['broker-instruments-stats'] });
      toast.success(`Instruments downloaded successfully for ${broker}`);
    },
    onError: (error: Error, broker) => {
      toast.error(`Failed to download instruments for ${broker}: ${error.message || 'Unknown error'}`);
    },
  });

  const medianNormalizedSize = useMemo(() => {
    if (!mergedStats || mergedStats.length < 2) return 0;
    const sizes = mergedStats.map((s) => s.normalizedFileSize).filter((s) => s > 0).sort((a, b) => a - b);
    if (sizes.length === 0) return 0;
    const mid = Math.floor(sizes.length / 2);
    return sizes.length % 2 !== 0 ? sizes[mid] : (sizes[mid - 1] + sizes[mid]) / 2;
  }, [mergedStats]);

  const isFileSizeSuspicious = useCallback(
    (normalizedSize: number): boolean => {
      if (normalizedSize === 0) return true;
      if (medianNormalizedSize === 0) return false;
      return normalizedSize < medianNormalizedSize * FILE_SIZE_WARNING_THRESHOLD;
    },
    [medianNormalizedSize],
  );

  const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const getFileSizeWarning = useCallback(
    (normalizedSize: number): string => {
      if (normalizedSize === 0) return 'No instrument file found. Instruments may not have been downloaded yet.';
      if (medianNormalizedSize === 0) return '';
      const percentage = Math.round((normalizedSize / medianNormalizedSize) * 100);
      return `File size is ${percentage}% of median (${formatFileSize(medianNormalizedSize)}). This may indicate incomplete instrument data - possibly missing new expiry options/futures.`;
    },
    [medianNormalizedSize],
  );

  const formatDateTime = (dateString: string | null): string => {
    if (!dateString) return 'Never';
    try {
      return new Date(dateString).toLocaleString();
    } catch {
      return dateString;
    }
  };

  if (error) return <div className={danger}>Failed to load broker instrument statistics</div>;

  if (isLoading) {
    return (
      <div className="py-10 text-center">
        <Spinner className="text-primary-500" />
        <p className="mt-2 text-ink-soft">Loading instrument statistics...</p>
      </div>
    );
  }

  if (!mergedStats || mergedStats.length === 0) {
    return (
      <div className={`${info} flex items-center gap-2`}>
        <BsBarChartFill /> No enabled brokers found. Enable brokers first to download instruments.
      </div>
    );
  }

  const totalOriginalSize = mergedStats.reduce((sum, s) => sum + s.originalFileSize, 0);
  const totalNormalizedSize = mergedStats.reduce((sum, s) => sum + s.normalizedFileSize, 0);
  const suspiciousBrokers = mergedStats.filter((s) => s.instrumentsCount > 0 && isFileSizeSuspicious(s.normalizedFileSize));

  const summaryTiles = [
    { value: mergedStats.length, label: 'Enabled Brokers', cls: 'text-primary-500' },
    { value: formatFileSize(totalOriginalSize), label: 'Original Files', cls: 'text-accent-500' },
    { value: formatFileSize(totalNormalizedSize), label: 'Normalized Files', cls: 'text-warning-500' },
  ];

  return (
    <>
      {suspiciousBrokers.length > 0 && (
        <div className={`${warn} mb-4 flex items-start gap-2`}>
          <BsExclamationTriangle size={20} className="mt-0.5 shrink-0 text-warning-500" />
          <div>
            <strong>Warning:</strong> {suspiciousBrokers.length} broker(s) have significantly lower file sizes than others: <strong>{suspiciousBrokers.map((b) => b.brokerName).join(', ')}</strong>. This may indicate incomplete instrument data (missing new expiry options/futures). Consider re-downloading instruments for these brokers.
          </div>
        </div>
      )}

      <div className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-3">
        {summaryTiles.map((t) => (
          <div key={t.label} className={`${card} p-4 text-center`}>
            <div className={`text-2xl font-bold ${t.cls}`}>{t.value}</div>
            <small className="text-ink-soft">{t.label}</small>
          </div>
        ))}
      </div>

      <div className={card}>
        <div className={cardHeadRow}>
          <div className="flex items-center gap-2">
            <BsBarChartFill className="text-primary-500" />
            <h5 className="mb-0 font-semibold text-ink">Broker Instrument Statistics</h5>
          </div>
          <Button variant="secondary" size="sm" onClick={() => refetch()}>
            <BsArrowClockwise /> Refresh
          </Button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm [&_tbody_tr]:border-b [&_tbody_tr]:border-hairline">
            <thead className={thRow}>
              <tr>
                <th className={`${cell} text-left`}>Broker</th>
                <th className={`${cell} text-left`}>Instruments</th>
                <th className={`${cell} text-left`}>Original File</th>
                <th className={`${cell} text-left`}>Normalized File</th>
                <th className={`${cell} text-left`}>Last Downloaded</th>
                <th className={`${cell} text-left`}>Cache Status</th>
                <th className={`${cell} text-left`}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {mergedStats.map((stat) => {
                const hasNoInstruments = stat.instrumentsCount === 0;
                const isSuspicious = !hasNoInstruments && isFileSizeSuspicious(stat.normalizedFileSize);
                return (
                  <tr key={stat.brokerName} className={clsx('hover:bg-raised/50', isSuspicious && 'bg-warning-500/5')}>
                    <td className={`${cell} font-medium text-ink`}>
                      {stat.brokerName}
                      {isSuspicious && (
                        <Tooltip label={getFileSizeWarning(stat.normalizedFileSize)} placement="top">
                          <span className="ml-2 text-warning-500"><BsExclamationTriangle /></span>
                        </Tooltip>
                      )}
                    </td>
                    <td className={cell}>
                      {hasNoInstruments ? (
                        <Badge tone="neutral">Not Downloaded</Badge>
                      ) : (
                        <code className="rounded bg-raised px-2 py-1 text-ink">{stat.instrumentsCount.toLocaleString()}</code>
                      )}
                    </td>
                    <td className={`${cell} text-ink`}>{hasNoInstruments ? '-' : formatFileSize(stat.originalFileSize)}</td>
                    <td className={`${cell} text-ink`}>
                      {hasNoInstruments ? '-' : formatFileSize(stat.normalizedFileSize)}
                      {isSuspicious && <Badge tone="warning" className="ml-2">Low</Badge>}
                    </td>
                    <td className={cell}><small className="text-ink-soft">{formatDateTime(stat.lastDownloadedTime)}</small></td>
                    <td className={cell}>
                      {hasNoInstruments ? (
                        <Badge tone="neutral" icon={<BsXCircle />}>N/A</Badge>
                      ) : stat.cacheLoaded ? (
                        <Badge tone="success" icon={<BsCheckCircle />}>Loaded</Badge>
                      ) : (
                        <Badge tone="warning" icon={<BsXCircle />}>Not Loaded</Badge>
                      )}
                    </td>
                                          <td className={cell}>
                        <Button variant={hasNoInstruments || isSuspicious ? 'primary' : 'secondary'} size="sm" onClick={() => downloadMutation.mutate(stat.brokerName)} disabled={downloadMutation.isPending}>
                          <BsCloudDownload /> {downloadMutation.isPending ? 'Downloading...' : 'Download'}
                        </Button>
                      </td>
                    
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
};

// ==================== INSTRUMENT SEARCH PANEL ====================
const InstrumentSearchPanel: React.FC = () => {
  const [selectedBroker, setSelectedBroker] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [searchResults, setSearchResults] = useState<InstrumentSearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const { data: brokers } = useQuery({
    queryKey: ['brokers'],
    queryFn: () => brokerService.getAll(),
  });

  const enabledBrokers = useMemo(() => brokers?.filter((b) => b.enabled) || [], [brokers]);

  useEffect(() => {
    if (enabledBrokers.length === 1 && !selectedBroker) setSelectedBroker(enabledBrokers[0].name);
  }, [enabledBrokers]);

  const handleSearch = useCallback(async () => {
    if (!selectedBroker || searchQuery.length < 2) return;
    setIsSearching(true);
    setSearchError(null);
    try {
      const results = await brokerInstrumentsService.searchInstruments(selectedBroker, { q: searchQuery, limit: 100 });
      setSearchResults(results);
    } catch {
      setSearchError('Failed to search instruments');
      setSearchResults([]);
    } finally {
      setIsSearching(false);
    }
  }, [selectedBroker, searchQuery]);

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSearch();
  };

  return (
    <>
      <div className={`${card} mb-4`}>
        <div className="flex items-center gap-2 border-b border-hairline p-3">
          <BsSearch className="text-primary-500" />
          <h5 className="mb-0 font-semibold text-ink">Search Instruments</h5>
        </div>
        <div className="p-4">
          <div className="grid grid-cols-1 items-end gap-3 md:grid-cols-12">
            <div className="md:col-span-3">
              <label className={flabel}>Broker</label>
              <select className={ctrl} value={selectedBroker} onChange={(e) => setSelectedBroker(e.target.value)}>
                <option value="">Select Broker...</option>
                {enabledBrokers.map((b) => (
                  <option key={b.name} value={b.name}>{b.displayName || b.name}</option>
                ))}
              </select>
            </div>
            <div className="md:col-span-6">
              <label className={flabel}>Trading Symbol <small className="font-normal text-ink-soft">(min 2 chars, max 100 results)</small></label>
              <div className="flex">
                <span className="flex items-center rounded-l border border-r-0 border-hairline bg-raised px-2.5 text-ink-soft"><BsSearch /></span>
                <input type="text" className={`${ctrl} rounded-l-none`} placeholder="e.g., NIFTY, BANKNIFTY" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} onKeyPress={handleKeyPress} disabled={!selectedBroker} />
              </div>
            </div>
            <div className="md:col-span-3">
              <Button variant="primary" onClick={handleSearch} disabled={!selectedBroker || searchQuery.length < 2 || isSearching} className="w-full">
                {isSearching ? (<><Spinner size="sm" /> Searching...</>) : (<><BsSearch /> Search</>)}
              </Button>
            </div>
          </div>
        </div>
      </div>

      {searchError && <div className={danger}>{searchError}</div>}

      {searchResults.length > 0 && (
        <div className={card}>
          <div className={cardHeadRow}>
            <h6 className="mb-0 font-semibold text-ink">Search Results</h6>
            <Badge tone="primary">{searchResults.length} instruments found</Badge>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm [&_tbody_tr]:border-b [&_tbody_tr]:border-hairline">
              <thead className={thRow}>
                <tr>
                  <th className={`${cell} text-left`}>Trading Symbol</th>
                  <th className={`${cell} text-left`}>Exchange</th>
                  <th className={`${cell} text-left`}>Name</th>
                  <th className={`${cell} text-left`}>Type</th>
                  <th className={`${cell} text-left`}>Strike</th>
                  <th className={`${cell} text-left`}>Expiry</th>
                  <th className={`${cell} text-left`}>Lot Size</th>
                  <th className={`${cell} text-left`}>Token</th>
                </tr>
              </thead>
              <tbody>
                {searchResults.map((instrument, index) => (
                  <tr key={`${instrument.instrumentToken}-${index}`} className="hover:bg-raised/50">
                    <td className={cell}><code className="rounded bg-raised px-2 py-1 text-ink">{instrument.tradingSymbol}</code></td>
                    <td className={cell}><Badge tone="neutral">{instrument.exchange}</Badge></td>
                    <td className={`${cell} text-ink`}>{instrument.name || '-'}</td>
                    <td className={cell}><Badge tone={instrumentTypeTone(instrument.instrumentType)}>{instrument.instrumentType || 'EQ'}</Badge></td>
                    <td className={`${cell} text-ink`}>{instrument.strike > 0 ? instrument.strike.toLocaleString() : '-'}</td>
                    <td className={`${cell} text-ink`}>{instrument.expiry || '-'}</td>
                    <td className={`${cell} text-ink`}>{instrument.lotSize}</td>
                    <td className={cell}><small className="text-ink-soft">{instrument.instrumentToken}</small></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {searchResults.length === 0 && searchQuery.length >= 2 && !isSearching && !searchError && (
        <div className={`${info} flex items-center gap-2`}>
          <BsSearch /> No instruments found matching "{searchQuery}". Try a different search term.
        </div>
      )}
    </>
  );
};

// ==================== INSTRUMENT LOOKUP PANEL ====================
const InstrumentLookupPanel: React.FC = () => {
  const [selectedBroker, setSelectedBroker] = useState<string>('');
  const [exchange, setExchange] = useState<string>('NSE');
  const [symbol, setSymbol] = useState<string>('');
  const [instrumentType, setInstrumentType] = useState<string>('');
  const [expiry, setExpiry] = useState<string>('');
  const [strike, setStrike] = useState<string>('');
  const [lookupResult, setLookupResult] = useState<InstrumentLookupResult | null>(null);
  const [expiryList, setExpiryList] = useState<string[]>([]);
  const [isLookingUp, setIsLookingUp] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);

  const { data: brokers } = useQuery({
    queryKey: ['brokers'],
    queryFn: () => brokerService.getAll(),
  });

  const enabledBrokers = useMemo(() => brokers?.filter((b) => b.enabled) || [], [brokers]);

  useEffect(() => {
    if (enabledBrokers.length === 1 && !selectedBroker) setSelectedBroker(enabledBrokers[0].name);
  }, [enabledBrokers]);

  const fetchExpiries = useCallback(async () => {
    if (!selectedBroker || !exchange || !symbol || !instrumentType) {
      setExpiryList([]);
      return;
    }
    try {
      const result = await brokerInstrumentsService.getExpiries(selectedBroker, { exchange, symbol, instrumentType });
      setExpiryList(result.expiries);
    } catch {
      setExpiryList([]);
    }
  }, [selectedBroker, exchange, symbol, instrumentType]);

  const handleLookup = useCallback(async () => {
    if (!selectedBroker || !exchange || !symbol) return;
    setIsLookingUp(true);
    setLookupError(null);
    try {
      const result = await brokerInstrumentsService.lookupInstrument(selectedBroker, {
        exchange,
        symbol,
        instrumentType: instrumentType || undefined,
        expiry: expiry || undefined,
        strike: strike ? parseInt(strike) : undefined,
      });
      setLookupResult(result);
    } catch {
      setLookupError('Failed to lookup instrument');
      setLookupResult(null);
    } finally {
      setIsLookingUp(false);
    }
  }, [selectedBroker, exchange, symbol, instrumentType, expiry, strike]);

  const handleFetchExpiries = () => fetchExpiries();

  const kvCell = 'py-1 pr-3 align-top font-medium text-ink';
  const kvVal = 'py-1 text-ink';

  return (
    <>
      <div className={`${card} mb-4`}>
        <div className="border-b border-hairline p-3">
          <div className="flex items-center gap-2">
            <BsFileEarmarkText className="text-primary-500" />
            <h5 className="mb-0 font-semibold text-ink">Advanced Instrument Lookup</h5>
          </div>
          <small className="text-ink-soft">Check if a specific option/future exists for given parameters</small>
        </div>
        <div className="p-4">
          <div className="mb-3 grid grid-cols-1 gap-3 md:grid-cols-3">
            <div>
              <label className={flabel}>Broker *</label>
              <select className={ctrl} value={selectedBroker} onChange={(e) => setSelectedBroker(e.target.value)}>
                <option value="">Select Broker...</option>
                {enabledBrokers.map((b) => (
                  <option key={b.name} value={b.name}>{b.displayName || b.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={flabel}>Exchange *</label>
              <select className={ctrl} value={exchange} onChange={(e) => setExchange(e.target.value)}>
                <option value="NSE">NSE</option>
                <option value="BSE">BSE</option>
                <option value="MCX">MCX</option>
              </select>
            </div>
            <div>
              <label className={flabel}>Symbol/Name *</label>
              <input type="text" className={ctrl} placeholder="e.g., NIFTY, BANKNIFTY, RELIANCE" value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} />
            </div>
          </div>

          <div className="grid grid-cols-1 items-end gap-3 md:grid-cols-4">
            <div>
              <label className={flabel}>Instrument Type</label>
              <select className={ctrl} value={instrumentType} onChange={(e) => setInstrumentType(e.target.value)}>
                <option value="">Any</option>
                <option value="CE">CE (Call)</option>
                <option value="PE">PE (Put)</option>
                <option value="FUT">FUT (Future)</option>
                <option value="EQ">EQ (Equity)</option>
              </select>
            </div>
            <div>
              <label className={`${flabel} flex items-center gap-2`}>
                Expiry
                <button type="button" className="text-xs text-primary-500 hover:underline disabled:opacity-50" onClick={handleFetchExpiries} disabled={!selectedBroker || !symbol || !instrumentType}>
                  (Load Expiries)
                </button>
              </label>
              {expiryList.length > 0 ? (
                <select className={ctrl} value={expiry} onChange={(e) => setExpiry(e.target.value)}>
                  <option value="">Select Expiry...</option>
                  {expiryList.map((exp) => (
                    <option key={exp} value={exp}>{exp}</option>
                  ))}
                </select>
              ) : (
                <input type="text" className={ctrl} placeholder="YYYY-MM-DD" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
              )}
            </div>
            <div>
              <label className={flabel}>Strike Price</label>
              <input type="number" className={ctrl} placeholder="e.g., 23000" value={strike} onChange={(e) => setStrike(e.target.value)} />
            </div>
            <div>
              <Button variant="primary" onClick={handleLookup} disabled={!selectedBroker || !exchange || !symbol || isLookingUp} className="w-full">
                {isLookingUp ? (<><Spinner size="sm" /> Looking up...</>) : (<><BsSearch /> Lookup</>)}
              </Button>
            </div>
          </div>
        </div>
      </div>

      {lookupError && <div className={danger}>{lookupError}</div>}

      {lookupResult && (
        <div className={card}>
          <div className="border-b border-hairline p-3">
            <h6 className="mb-0 font-semibold text-ink">Lookup Result</h6>
          </div>
          <div className="p-4">
            {lookupResult.found && lookupResult.instrument ? (
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <table className="text-sm">
                  <tbody>
                    <tr>
                      <td className={kvCell}>Trading Symbol:</td>
                      <td className={kvVal}><code className="rounded bg-raised px-2 py-1">{lookupResult.instrument.tradingSymbol}</code></td>
                    </tr>
                    <tr>
                      <td className={kvCell}>Exchange:</td>
                      <td className={kvVal}><Badge tone="neutral">{lookupResult.instrument.exchange}</Badge></td>
                    </tr>
                    <tr>
                      <td className={kvCell}>Name:</td>
                      <td className={kvVal}>{lookupResult.instrument.name || '-'}</td>
                    </tr>
                    <tr>
                      <td className={kvCell}>Instrument Type:</td>
                      <td className={kvVal}><Badge tone={instrumentTypeTone(lookupResult.instrument.instrumentType)}>{lookupResult.instrument.instrumentType || 'EQ'}</Badge></td>
                    </tr>
                  </tbody>
                </table>
                <table className="text-sm">
                  <tbody>
                    <tr>
                      <td className={kvCell}>Strike:</td>
                      <td className={kvVal}>{lookupResult.instrument.strike > 0 ? lookupResult.instrument.strike.toLocaleString() : '-'}</td>
                    </tr>
                    <tr>
                      <td className={kvCell}>Expiry:</td>
                      <td className={kvVal}>{lookupResult.instrument.expiry || '-'}</td>
                    </tr>
                    <tr>
                      <td className={kvCell}>Lot Size:</td>
                      <td className={kvVal}>{lookupResult.instrument.lotSize}</td>
                    </tr>
                    <tr>
                      <td className={kvCell}>Instrument Token:</td>
                      <td className={kvVal}><small className="text-ink-soft">{lookupResult.instrument.instrumentToken}</small></td>
                    </tr>
                  </tbody>
                </table>
              </div>
            ) : (
              <div className={`${warn} flex items-center gap-2`}>
                <BsXCircle /> Instrument not found with the specified parameters.
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
};

export default BrokerInstrumentsPage;
