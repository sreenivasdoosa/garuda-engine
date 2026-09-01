import { useState, useMemo } from 'react';
import clsx from 'clsx';
import { BsSearch, BsArrowClockwise, BsXCircle } from 'react-icons/bs';

import { useAlertsPage } from '@/hooks/useAlerts';
import { useAuthStore } from '@/store/authStore';
import UserSelect from '@/components/common/UserSelect';
import TablePagination from '@/components/common/TablePagination';
import type { SystemAlert } from '@/types/common';
import { Badge, Button, Spinner } from '@/components/ui';
import type { Tone } from '@/components/ui';

type AudienceMode = 'important' | 'all';

const AUDIENCE_STORAGE_KEY_PREFIX = 'alerts.audience.';

const readStoredAudience = (username: string | undefined): AudienceMode => {
  if (!username) return 'important';
  try {
    const stored = localStorage.getItem(AUDIENCE_STORAGE_KEY_PREFIX + username);
    return stored === 'all' ? 'all' : 'important';
  } catch {
    return 'important';
  }
};

const formatTimestamp = (timestamp: string): string => {
  try {
    return timestamp.substring(0, 23);
  } catch {
    return timestamp;
  }
};

const formatTimeOnly = (timestamp: string | undefined): string => {
  if (!timestamp) return '';
  try {
    const parts = timestamp.split(' ');
    return parts.length > 1 ? parts[1].substring(0, 8) : timestamp;
  } catch {
    return timestamp;
  }
};

const getAlertTone = (level: string): Tone => {
  switch (level) {
    case 'CRITICAL':
      return 'danger';
    case 'WARNING':
      return 'warning';
    default:
      return 'info';
  }
};

const ctrl = 'h-8 w-full rounded border border-hairline bg-card px-2 text-sm text-ink placeholder:text-ink-faint focus-visible:outline-none focus:border-primary-500/60';
const cell = 'px-2 py-1.5 text-[0.8rem]';
const affixBtn = 'flex h-8 items-center justify-center rounded-r border border-l-0 border-hairline bg-raised px-2.5 text-ink-soft hover:text-ink';

const AlertsPage: React.FC = () => {
  const { user } = useAuthStore();
  const username = user?.username;

  const [audienceMode, setAudienceMode] = useState<AudienceMode>(() => readStoredAudience(username));

  const { alerts, pagination, filters, isLoading, isFetching, params, setPage, setPageSize, setFilter, setSearch, resetFilters, refresh } = useAlertsPage({ audience: audienceMode });

  const [searchInput, setSearchInput] = useState('');

  const handleAudienceChange = (value: AudienceMode) => {
    setAudienceMode(value);
    if (username) {
      try {
        localStorage.setItem(AUDIENCE_STORAGE_KEY_PREFIX + username, value);
      } catch {
        // ignore localStorage errors (private mode, quota, etc.)
      }
    }
    setFilter('audience', value);
  };

  const handleSearch = () => setSearch(searchInput);
  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSearch();
  };

  const hasActiveFilters = useMemo(() => {
    return !!(params.alertLevel || params.entityType || params.entityName || params.operation || params.search);
  }, [params]);

  const colSpan = audienceMode === 'all' ? 9 : 8;

  const segBtn = (active: boolean) =>
    clsx(
      'px-3 py-1 text-xs font-medium transition-colors',
      active ? 'bg-primary-500 text-white' : 'bg-app text-ink-soft hover:text-ink',
    );

  return (
    <div className="py-3">
      <div className="rounded-card border border-hairline bg-card">
        <div className="flex items-center justify-between border-b border-hairline p-3">
          <div className="flex items-center gap-2">
            <h5 className="mb-0 font-semibold text-ink">System Alerts</h5>
            {isFetching && <Spinner size="sm" />}
          </div>
          <div className="flex items-center gap-2">
            <div className="inline-flex overflow-hidden rounded border border-hairline">
              <button type="button" className={segBtn(audienceMode === 'important')} onClick={() => handleAudienceChange('important')}>
                Important
              </button>
              <button type="button" className={`${segBtn(audienceMode === 'all')} border-l border-hairline`} onClick={() => handleAudienceChange('all')}>
                All
              </button>
            </div>
            <Button variant="secondary" size="sm" onClick={refresh} disabled={isFetching}>
              <BsArrowClockwise className={isFetching ? 'animate-spin' : ''} /> Refresh
            </Button>
          </div>
        </div>

        <div className="p-3">
          {/* Filters Row */}
          <div className="mb-3 grid grid-cols-1 gap-2 md:grid-cols-2 lg:grid-cols-12">
            <div className="flex lg:col-span-3">
              <input className={`${ctrl} rounded-r-none`} placeholder="Search alerts..." value={searchInput} onChange={(e) => setSearchInput(e.target.value)} onKeyDown={handleSearchKeyDown} />
              <button type="button" className={affixBtn} onClick={handleSearch} aria-label="Search">
                <BsSearch />
              </button>
            </div>
            <div className="lg:col-span-2">
              <UserSelect value={params.entityName || ''} onChange={(username) => setFilter('entityName', username || undefined)} />
            </div>
            <div className="lg:col-span-2">
              <select className={ctrl} value={params.alertLevel || ''} onChange={(e) => setFilter('alertLevel', e.target.value || undefined)}>
                <option value="">All Levels</option>
                {filters?.alertLevels?.map((level) => (
                  <option key={level} value={level}>{level}</option>
                ))}
              </select>
            </div>
            <div className="lg:col-span-2">
              <select className={ctrl} value={params.entityType || ''} onChange={(e) => setFilter('entityType', e.target.value || undefined)}>
                <option value="">All Entity Types</option>
                {filters?.entityTypes?.map((type) => (
                  <option key={type} value={type}>{type}</option>
                ))}
              </select>
            </div>
            <div className="lg:col-span-2">
              <select className={ctrl} value={params.operation || ''} onChange={(e) => setFilter('operation', e.target.value || undefined)}>
                <option value="">All Operations</option>
                {filters?.operations?.map((op) => (
                  <option key={op} value={op}>{op}</option>
                ))}
              </select>
            </div>
            <div className="lg:col-span-1">
              {hasActiveFilters && (
                <Button
                  variant="danger"
                  size="sm"
                  className="w-full"
                  onClick={() => {
                    resetFilters();
                    setSearchInput('');
                  }}
                  title="Clear Filters"
                >
                  <BsXCircle />
                </Button>
              )}
            </div>
          </div>

          {/* Pagination (top) */}
          {pagination && (
            <div className="mb-2">
              <TablePagination
                page={pagination.page}
                pageSize={pagination.pageSize}
                totalCount={pagination.totalCount}
                totalPages={pagination.totalPages}
                onPageChange={setPage}
                onPageSizeChange={setPageSize}
                itemLabel="alerts"
                loading={isLoading}
              />
            </div>
          )}

          {/* Alerts Table */}
          <div className="overflow-x-auto">
            <table className="w-full text-sm [&_tbody_tr]:border-b [&_tbody_tr]:border-hairline">
              <thead className="bg-raised text-xs uppercase text-ink-faint">
                <tr>
                  <th className={`${cell} text-left`} style={{ width: '170px' }}>Last seen</th>
                  <th className={`${cell} text-left`} style={{ width: '80px' }}>Level</th>
                  {audienceMode === 'all' && <th className={`${cell} text-left`} style={{ width: '95px' }}>Audience</th>}
                  <th className={`${cell} text-left`} style={{ width: '80px' }}>Entity Type</th>
                  <th className={`${cell} text-left`} style={{ width: '150px' }}>Entity Name</th>
                  <th className={`${cell} text-left`} style={{ width: '120px' }}>Operation</th>
                  <th className={`${cell} text-left`} style={{ width: '70px' }}>Count</th>
                  <th className={`${cell} text-left`} style={{ width: '100px' }}>First seen</th>
                  <th className={`${cell} text-left`}>Message</th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <tr>
                    <td colSpan={colSpan} className="py-4 text-center text-ink-soft">
                      <Spinner size="sm" /> Loading alerts...
                    </td>
                  </tr>
                ) : alerts.length === 0 ? (
                  <tr>
                    <td colSpan={colSpan} className="py-4 text-center text-ink-soft">No alerts found</td>
                  </tr>
                ) : (
                  alerts.map((alert: SystemAlert, index: number) => (
                    <tr key={`${alert.timestamp}-${index}`} className="hover:bg-raised/50">
                      <td className={`${cell} whitespace-nowrap text-ink`}>{formatTimestamp(alert.timestamp)}</td>
                      <td className={cell}>
                        <Badge tone={getAlertTone(alert.alertLevel)}>{alert.alertLevel}</Badge>
                      </td>
                      {audienceMode === 'all' && (
                        <td className={cell}>
                          <Badge tone={alert.audience === 'DEVELOPER' ? 'neutral' : 'primary'}>{alert.audience ?? 'OPERATOR'}</Badge>
                        </td>
                      )}
                      <td className={`${cell} text-ink`}>{alert.entityType}</td>
                      <td className={`${cell} truncate text-ink`} title={alert.entityName}>{alert.entityName}</td>
                      <td className={`${cell} text-ink`}>{alert.operation}</td>
                      <td className={`${cell} text-right`}>
                        {alert.occurrenceCount && alert.occurrenceCount > 1 ? (
                          <Badge tone="warning">×{alert.occurrenceCount}</Badge>
                        ) : (
                          <span className="text-ink-soft">1</span>
                        )}
                      </td>
                      <td className={`${cell} whitespace-nowrap text-ink-soft`}>{formatTimeOnly(alert.firstOccurrenceTime)}</td>
                      <td className={`${cell} text-ink`} title={alert.alertMessage}>{alert.alertMessage}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AlertsPage;
