/**
 * TerminalFilters Component
 * Filter controls for the terminal. Tailwind design system.
 */

import React from 'react';
import { BsX } from 'react-icons/bs';
import type { TerminalFilters as TFilters } from '@/types/terminal';
import HelpIcon from '@/components/common/HelpIcon';
import { terminalHelpContent } from '@/data/help/terminal-help';
import { usePermissions } from '@/hooks/usePermissions';
import UserSelect from '@/components/common/UserSelect';
import { Badge, IconButton, Toggle } from '@/components/ui';

interface TerminalFiltersProps {
  filters: TFilters;
  onFilterChange: (filters: TFilters) => void;
  brokers?: string[];
  totalCount: number;
  filteredCount: number;
}

const selectCls =
  'h-8 rounded border border-hairline bg-card px-2 text-sm text-ink focus-visible:outline-none focus:border-primary-500/60';

const TerminalFilters: React.FC<TerminalFiltersProps> = ({ filters, onFilterChange, brokers = [], totalCount, filteredCount }) => {
  const helpContent = terminalHelpContent;
  const { algoBrokerCompare } = usePermissions();
  const canCompare = algoBrokerCompare.canView;
  const hasActiveFilters = !!(
    filters.username ||
    filters.broker ||
    filters.showOnlyWithMismatch ||
    filters.showOnlyWithActiveTrades ||
    filters.showOnlyLoggedIn ||
    filters.showOnlyCancelled
  );

  const handleClearFilters = () => {
    onFilterChange({ sortBy: filters.sortBy, sortOrder: filters.sortOrder });
  };

  const switchLabel = (text: string, article: unknown) => (
    <span className="flex items-center gap-1">
      {text} <HelpIcon article={article as never} />
    </span>
  );

  return (
    <div className="mb-2">
      <div className="flex flex-wrap items-center gap-2">
        {/* Search — remote username typeahead */}
        <div style={{ width: '220px' }}>
          <UserSelect value={filters.username || ''} onChange={(username) => onFilterChange({ ...filters, username: username || undefined })} placeholder="Search user…" />
        </div>

        {/* Broker Filter */}
        <select
          className={`${selectCls} w-[180px]`}
          value={filters.broker || ''}
          onChange={(e) => onFilterChange({ ...filters, broker: e.target.value || undefined })}
        >
          <option value="">All Brokers</option>
          {brokers.map((broker) => (
            <option key={broker} value={broker}>
              {broker}
            </option>
          ))}
        </select>

        {/* Sort By */}
        <select className={`${selectCls} w-[160px]`} value={filters.sortBy || 'username'} onChange={(e) => onFilterChange({ ...filters, sortBy: e.target.value as TFilters['sortBy'] })}>
          <option value="username">Sort: Name</option>
          <option value="capital">Sort: Capital</option>
          <option value="algoPnl">Sort: Algo P&L</option>
          <option value="algoPercent">Sort: Algo P&L %</option>
          {canCompare && <option value="brokerPnl">Sort: Broker P&L</option>}
          {canCompare && <option value="brokerPercent">Sort: Broker P&L %</option>}
          <option value="activeTradesCount">Sort: Active</option>
          {canCompare && <option value="mismatchSeverity">Sort: Mismatch</option>}
        </select>

        {/* Sort Order */}
        <select className={`${selectCls} w-[80px]`} value={filters.sortOrder || 'asc'} onChange={(e) => onFilterChange({ ...filters, sortOrder: e.target.value as 'asc' | 'desc' })}>
          <option value="asc">Asc</option>
          <option value="desc">Desc</option>
        </select>

        {/* Divider */}
        <div className="mx-1 h-6 w-px bg-hairline" />

        {/* Quick Filters */}
        {canCompare && (
          <label className="mb-0 flex items-center gap-1.5 text-sm text-ink">
            <Toggle checked={filters.showOnlyWithMismatch || false} onChange={(v) => onFilterChange({ ...filters, showOnlyWithMismatch: v || undefined })} aria-label="Mismatch" />
            {switchLabel('Mismatch', helpContent['terminal.filters.mismatch'])}
          </label>
        )}
        <label className="mb-0 flex items-center gap-1.5 text-sm text-ink">
          <Toggle checked={filters.showOnlyWithActiveTrades || false} onChange={(v) => onFilterChange({ ...filters, showOnlyWithActiveTrades: v || undefined })} aria-label="Active" />
          {switchLabel('Active', helpContent['terminal.filters.active'])}
        </label>
        <label className="mb-0 flex items-center gap-1.5 text-sm text-ink">
          <Toggle checked={filters.showOnlyLoggedIn || false} onChange={(v) => onFilterChange({ ...filters, showOnlyLoggedIn: v || undefined })} aria-label="Online" />
          {switchLabel('Online', helpContent['terminal.filters.online'])}
        </label>
        <label className="mb-0 flex items-center gap-1.5 text-sm text-ink" title="Only rows with cancelled trades (local filter)">
          <Toggle checked={filters.showOnlyCancelled || false} onChange={(v) => onFilterChange({ ...filters, showOnlyCancelled: v || undefined })} aria-label="Cancelled Only" />
          <span>Cancelled</span>
        </label>

        {/* Divider */}
        <div className="mx-1 h-6 w-px bg-hairline" />

        {/* Results Count */}
        <span className="text-sm text-ink-soft">
          <Badge tone="neutral">{filteredCount}</Badge>/{totalCount}
        </span>

        {/* Clear Filters */}
        {hasActiveFilters && (
          <IconButton onClick={handleClearFilters} title="Clear Filters" aria-label="Clear Filters">
            <BsX size={16} />
          </IconButton>
        )}
      </div>
    </div>
  );
};

export default TerminalFilters;
