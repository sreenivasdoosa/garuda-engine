/**
 * Live Signals Tab - Real-time signal display with strategy grouping.
 * Simplified port from market-data-ui's SignalsPage.
 */

import { useState, useMemo, useEffect } from 'react';
import { useMarketData } from '@/context/MarketDataContext';
import { mdRulesApi, mdSignalOutputsApi, mdStrategyRulesApi, type Rule, type SignalOutput, type StrategyRule } from '@/api/marketDataApi';
import type { Signal } from '@/api/marketDataWebSocket';

interface SignalWithOutput extends Signal {
  signalOutput?: SignalOutput;
}

interface GroupedSignals {
  [strategyName: string]: SignalWithOutput[];
}

export default function SignalsTab() {
  const { signals, clearSignals } = useMarketData();
  const [searchTerm, setSearchTerm] = useState('');
  const [filterOption, setFilterOption] = useState<string>('all');
  const [rules, setRules] = useState<Rule[]>([]);
  const [strategyRules, setStrategyRules] = useState<StrategyRule[]>([]);
  const [signalOutputs, setSignalOutputs] = useState<SignalOutput[]>([]);
  const [expandedStrategies, setExpandedStrategies] = useState<Set<string>>(new Set());

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [rulesData, strategyRulesData, outputsData] = await Promise.all([
          mdRulesApi.getAll(),
          mdStrategyRulesApi.getAll(),
          mdSignalOutputsApi.getAll(),
        ]);
        setRules(rulesData);
        setStrategyRules(strategyRulesData);
        setSignalOutputs(outputsData);
      } catch { /* ignore */ }
    };
    fetchData();
    const interval = setInterval(fetchData, 60000);
    return () => clearInterval(interval);
  }, []);

  const rulesById = useMemo(() => {
    const map: Record<number, Rule> = {};
    rules.forEach(rule => { map[rule.id] = rule; });
    return map;
  }, [rules]);

  const strategyRulesByKey = useMemo(() => {
    const map: Record<string, StrategyRule> = {};
    strategyRules.forEach(sr => { map[`${sr.strategyName}:${sr.exchange}:${sr.tranch}:${sr.condition}`] = sr; });
    return map;
  }, [strategyRules]);

  const signalOutputsByKey = useMemo(() => {
    const map: Record<string, SignalOutput> = {};
    signalOutputs.forEach(o => { map[`${o.strategyName}:${o.exchange}:${o.tranch}:${o.condition}`] = o; });
    return map;
  }, [signalOutputs]);

  const filteredSignals = useMemo(() => {
    const mergedMap = new Map<string, SignalWithOutput>();

    const getInfo = (sn: string, ex: string, tr: number, co: string) => {
      const sr = strategyRulesByKey[`${sn}:${ex}:${tr}:${co}`];
      return { rulesExpr: sr?.rulesExpr || '', dependsOnCond: sr?.dependsOnCond || null };
    };

    signalOutputs.forEach(output => {
      const key = `${output.strategyName}:${output.exchange}:${output.tranch}:${output.condition}`;
      const { rulesExpr, dependsOnCond } = getInfo(output.strategyName, output.exchange, output.tranch, output.condition);
      mergedMap.set(key, { strategyName: output.strategyName, exchange: output.exchange, tranch: output.tranch, condition: output.condition, rulesExpr, dependsOnCond, result: true, signalOutput: output });
    });

    signals.forEach((signal, key) => {
      const outputKey = `${signal.strategyName}:${signal.exchange}:${signal.tranch}:${signal.condition}`;
      const existingOutput = signalOutputsByKey[outputKey];
      const { rulesExpr, dependsOnCond } = getInfo(signal.strategyName, signal.exchange, signal.tranch, signal.condition);
      mergedMap.set(key, {
        ...signal, rulesExpr: signal.rulesExpr || rulesExpr, dependsOnCond: signal.dependsOnCond || dependsOnCond,
        result: existingOutput ? true : signal.result, signalOutput: existingOutput,
      });
    });

    let arr = Array.from(mergedMap.values());
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      arr = arr.filter(s => s.strategyName.toLowerCase().includes(term) || s.condition.toLowerCase().includes(term) || s.exchange.toLowerCase().includes(term));
    }
    if (filterOption !== 'all') {
      const [condition, resultStr] = filterOption.split(':');
      const resultValue = resultStr === 'true';
      arr = arr.filter(s => s.condition.toLowerCase().includes(condition.toLowerCase()) && s.result === resultValue);
    }
    return arr;
  }, [signals, signalOutputs, searchTerm, filterOption, signalOutputsByKey, strategyRulesByKey]);

  const { groupedSignals, nonTranchedSignals } = useMemo(() => {
    const grouped: GroupedSignals = {};
    const nonTranched: SignalWithOutput[] = [];
    filteredSignals.forEach(signal => {
      if (!signal.tranch || signal.tranch === 0) { nonTranched.push(signal); }
      else {
        if (!grouped[signal.strategyName]) grouped[signal.strategyName] = [];
        grouped[signal.strategyName].push(signal);
      }
    });
    Object.values(grouped).forEach(sigs => sigs.sort((a, b) => a.tranch - b.tranch));
    nonTranched.sort((a, b) => a.strategyName.localeCompare(b.strategyName));
    return { groupedSignals: grouped, nonTranchedSignals: nonTranched };
  }, [filteredSignals]);

  useEffect(() => {
    setExpandedStrategies(new Set(Object.keys(groupedSignals)));
  }, [groupedSignals]);

  const toggleStrategy = (name: string) => {
    setExpandedStrategies(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  };

  const getConditionBadgeClass = (condition: string, result: boolean) => {
    if (!result) return 'bg-raised text-ink-soft';
    const cl = condition.toLowerCase();
    if (cl.includes('entry') || cl.includes('buy')) return 'bg-success-500 text-white';
    if (cl.includes('exit') || cl.includes('sell')) return 'bg-danger-600 text-white';
    if (cl.includes('sl')) return 'bg-warning-500 text-black';
    return 'bg-primary-500 text-white';
  };

  const renderRulesExpression = (expression: string) => {
    if (!expression) return <span className="text-ink-soft">-</span>;
    const parts = expression.split(/(\d+)/g);
    return (
      <span className="flex flex-wrap items-center gap-1">
        {parts.map((part, index) => {
          const ruleId = parseInt(part);
          if (!isNaN(ruleId) && rulesById[ruleId]) {
            return <span key={index} className="inline-block rounded-md px-[.55em] py-[.35em] text-center text-[.75em] font-semibold leading-none whitespace-nowrap text-white bg-primary-500" style={{ cursor: 'pointer', fontSize: '0.75rem' }}  title="Click to view rule">{rulesById[ruleId].name || `Rule ${ruleId}`}</span>;
          } else if (!isNaN(ruleId)) {
            return <span key={index} className="inline-block rounded-md px-[.55em] py-[.35em] text-center text-[.75em] font-semibold leading-none whitespace-nowrap text-white bg-danger-600" style={{ fontSize: '0.75rem' }} title={`Rule ${ruleId} not found`}>#{ruleId}?</span>;
          }
          if (part === '&&') return <span key={index} className="inline-block rounded-md px-[.55em] py-[.35em] text-center text-[.75em] font-semibold leading-none whitespace-nowrap bg-warning-500 text-black" style={{ fontSize: '0.7rem' }}>AND</span>;
          if (part === '||') return <span key={index} className="inline-block rounded-md px-[.55em] py-[.35em] text-center text-[.75em] font-semibold leading-none whitespace-nowrap bg-accent-500 text-black" style={{ fontSize: '0.7rem' }}>OR</span>;
          if (part === '(' || part === ')') return <span key={index} className="text-ink-soft font-bold">{part}</span>;
          return null;
        })}
      </span>
    );
  };

  const formatTimestamp = (ts: number | null | undefined) => {
    if (!ts) return '';
    try { return new Date(ts).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }); } catch { return ''; }
  };

  const renderSignalRow = (signal: SignalWithOutput, showTranch: boolean) => (
    <div key={`${signal.strategyName}:${signal.exchange}:${signal.tranch}:${signal.condition}`}
      className={`flex items-center justify-between py-2 px-4 border-b ${signal.result ? '' : 'opacity-50'}`}>
      <div className="flex items-center gap-4">
        {showTranch && <span className="inline-block rounded-md px-[.55em] py-[.35em] text-center text-[.75em] font-semibold leading-none whitespace-nowrap bg-primary-500/10 text-primary-700 dark:text-primary-400" style={{ minWidth: '70px' }}>Tranch {signal.tranch}</span>}
        <span className="inline-block rounded-md px-[.55em] py-[.35em] text-center text-[.75em] font-semibold leading-none whitespace-nowrap bg-raised text-ink-soft">{signal.exchange}</span>
        <span className={`inline-block rounded-md px-[.55em] py-[.35em] text-center text-[.75em] font-semibold leading-none whitespace-nowrap ${getConditionBadgeClass(signal.condition, signal.result)}`}>{signal.condition}</span>
        {signal.result ? <i className="bi bi-check-circle-fill text-success-500 dark:text-success-400"></i> : <i className="bi bi-x-circle text-ink-soft"></i>}
        {signal.signalOutput && (
          <div className="flex items-center gap-2 ms-2">
            {signal.signalOutput.symbolPricesList.length > 0 && (
              <span className="inline-block rounded-md px-[.55em] py-[.35em] text-center text-[.75em] font-semibold leading-none whitespace-nowrap bg-accent-500/10 text-accent-600 dark:text-accent-400">
                <i className="bi bi-currency-rupee me-1"></i>
                {signal.signalOutput.symbolPricesList.map(sp => `${sp.symbol}: ${sp.price}`).join(', ')}
              </span>
            )}
            {signal.signalOutput.lastUpdatedAt && (
              <span className="inline-block rounded-md px-[.55em] py-[.35em] text-center text-[.75em] font-semibold leading-none whitespace-nowrap bg-raised text-ink"><i className="bi bi-clock me-1"></i>{formatTimestamp(signal.signalOutput.lastUpdatedAt)}</span>
            )}
          </div>
        )}
      </div>
      <div className="flex items-center gap-2">
        {renderRulesExpression(signal.rulesExpr)}
        {signal.dependsOnCond && (
          <span className="inline-block rounded-md px-[.55em] py-[.35em] text-center text-[.75em] font-semibold leading-none whitespace-nowrap bg-warning-500/10 text-warning-700 dark:text-warning-300 ms-2"><i className="bi bi-link-45deg me-1"></i>{signal.dependsOnCond}</span>
        )}
      </div>
    </div>
  );

  const filterOptions = [
    { value: 'all', label: 'All Signals' },
    { value: 'entry:true', label: 'Entry = True' },
    { value: 'entry:false', label: 'Entry = False' },
    { value: 'exit:true', label: 'Exit = True' },
    { value: 'exit:false', label: 'Exit = False' },
  ];

  return (
    <div className="h-full flex flex-col">
      {/* Filters */}
      <div className="mb-4 flex gap-2">
        <div className="flex w-full [&>*:not(:first-child)]:rounded-l-none [&>*:not(:first-child)]:-ml-px [&>*:not(:last-child)]:rounded-r-none text-xs grow">
          <span className="inline-flex items-center rounded border border-hairline bg-raised px-2 text-sm text-ink-soft"><i className="bi bi-search"></i></span>
          <input type="text" className="w-full rounded border border-hairline bg-card px-2 py-1.5 text-sm text-ink placeholder:text-ink-faint focus-visible:outline-none focus:border-primary-500/60 disabled:bg-raised disabled:opacity-70" placeholder="Search by strategy, condition..." value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} />
          {searchTerm && <button className="inline-flex items-center justify-center gap-1.5 rounded-control font-medium transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 border border-hairline text-ink hover:bg-raised px-3.5 py-1.5 text-sm" onClick={() => setSearchTerm('')}><i className="bi bi-x"></i></button>}
        </div>
        <select className="w-full rounded border border-hairline bg-card px-2 py-1.5 text-sm text-ink placeholder:text-ink-faint focus-visible:outline-none focus:border-primary-500/60 disabled:bg-raised disabled:opacity-70 py-1 text-xs" style={{ width: '150px' }} value={filterOption} onChange={(e) => setFilterOption(e.target.value)}>
          {filterOptions.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
        </select>
        <button className="inline-flex items-center justify-center gap-1.5 rounded-control font-medium transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 border border-hairline text-ink hover:bg-raised px-2.5 py-1 text-xs" onClick={clearSignals} title="Clear signals"><i className="bi bi-trash"></i></button>
      </div>

      {/* Signals List */}
      {filteredSignals.length === 0 ? (
        <div className="grow flex items-center justify-center">
          <div className="text-center text-ink-soft">
            <i className="bi bi-bell-slash" style={{ fontSize: '4rem' }}></i>
            <h5 className="mt-4">No Signals Yet</h5>
            <p>Waiting for strategy signals...</p>
          </div>
        </div>
      ) : (
        <div className="grow overflow-auto">
          {nonTranchedSignals.length > 0 && (
            <div className="mb-4">
              {nonTranchedSignals.map(signal => (
                <div key={`${signal.strategyName}:${signal.exchange}:${signal.tranch}:${signal.condition}`}
                  className={`rounded-card border border-hairline bg-card mb-2 ${signal.result ? '' : 'opacity-50'}`}
                  style={{ borderLeft: `4px solid ${signal.result ? (signal.condition.toLowerCase().includes('entry') ? 'var(--bs-success)' : signal.condition.toLowerCase().includes('exit') ? 'var(--bs-danger)' : 'var(--bs-primary)') : 'var(--bs-secondary)'}` }}>
                  <div className="p-3 py-2 px-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-4">
                        <span className="font-bold">{signal.strategyName}</span>
                        <span className="inline-block rounded-md px-[.55em] py-[.35em] text-center text-[.75em] font-semibold leading-none whitespace-nowrap bg-raised text-ink-soft">{signal.exchange}</span>
                        <span className={`inline-block rounded-md px-[.55em] py-[.35em] text-center text-[.75em] font-semibold leading-none whitespace-nowrap ${getConditionBadgeClass(signal.condition, signal.result)}`}>{signal.condition}</span>
                        {signal.result ? <i className="bi bi-check-circle-fill text-success-500 dark:text-success-400"></i> : <i className="bi bi-x-circle text-ink-soft"></i>}
                      </div>
                      <div className="flex items-center gap-2">
                        {renderRulesExpression(signal.rulesExpr)}
                        {signal.dependsOnCond && <span className="inline-block rounded-md px-[.55em] py-[.35em] text-center text-[.75em] font-semibold leading-none whitespace-nowrap bg-warning-500/10 text-warning-700 dark:text-warning-300 ms-2"><i className="bi bi-link-45deg me-1"></i>{signal.dependsOnCond}</span>}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {Object.entries(groupedSignals).map(([strategyName, strategySignals]) => (
            <div key={strategyName} className="rounded-card border border-hairline bg-card mb-2">
              <div className="rounded-t-card border-b border-hairline bg-raised/50 px-4 py-3 font-semibold text-ink flex justify-between items-center py-2" onClick={() => toggleStrategy(strategyName)} style={{ cursor: 'pointer' }}>
                <div className="flex items-center gap-2">
                  <i className={`bi ${expandedStrategies.has(strategyName) ? 'bi-chevron-down' : 'bi-chevron-right'} text-ink-soft`}></i>
                  <span className="font-bold">{strategyName}</span>
                  <span className="inline-block rounded-md px-[.55em] py-[.35em] text-center text-[.75em] font-semibold leading-none whitespace-nowrap bg-primary-500/10 text-primary-700 dark:text-primary-400">{strategySignals.length} tranches</span>
                </div>
                <div className="flex items-center gap-2">
                  {strategySignals.some(s => s.result && s.condition.toLowerCase().includes('entry')) && <span className="inline-block rounded-md px-[.55em] py-[.35em] text-center text-[.75em] font-semibold leading-none whitespace-nowrap text-white bg-success-500">ENTRY</span>}
                  {strategySignals.some(s => s.result && s.condition.toLowerCase().includes('exit')) && <span className="inline-block rounded-md px-[.55em] py-[.35em] text-center text-[.75em] font-semibold leading-none whitespace-nowrap text-white bg-danger-600">EXIT</span>}
                </div>
              </div>
              {expandedStrategies.has(strategyName) && (
                <div className="p-3 p-0">{strategySignals.map(signal => renderSignalRow(signal, true))}</div>
              )}
            </div>
          ))}
        </div>
      )}


    </div>
  );
}
