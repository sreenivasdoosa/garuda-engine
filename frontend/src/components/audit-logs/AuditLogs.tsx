/**
 * AuditLogs Component
 * Table for listing audit logs
 * Reusable across Admin portals
 */

import { useState, useMemo, useEffect } from 'react';
import { Card, Button, Badge, Form, Row, Col, InputGroup, Alert } from '@/components/ui/rbShim';
import { BsSearch, BsEye, BsArrowClockwise } from 'react-icons/bs';
import { DataTable } from '@/components/common';
import type { Column } from '@/components/common';
import TablePagination from '@/components/common/TablePagination';
import { DEFAULT_PAGE_SIZE } from '@/types/pagination';
import { useQuery } from '@tanstack/react-query';
import { auditLogService } from '@/services/admin/v2AdminService';
import type { AuditLog as AuditLogType, AuditLogFilter } from '@/types/system';
import AuditLog from './AuditLog';

export interface AuditLogsProps {
  /** Card title */
  title?: string;
  /** Pre-filter by entity type */
  filterByEntityType?: string;
  /** Pre-filter by username */
  filterByUsername?: string;
  /** Pre-filter by action */
  filterByAction?: string;
  /** Number of days to show */
  defaultDays?: number;
  /** Hide specific columns */
  hideColumns?: ('entityType' | 'entityId' | 'entityName' | 'action' | 'changedBy' | 'timestamp' | 'actions')[];
  /** Callback when log is clicked */
  onLogClick?: (log: AuditLogType) => void;
}

const ACTIONS = ['CREATE', 'UPDATE', 'DELETE', 'ENABLE', 'DISABLE', 'LOGIN', 'LOGOUT'];

const ACTION_COLORS: Record<string, string> = {
  CREATE: 'success',
  UPDATE: 'info',
  DELETE: 'danger',
  ENABLE: 'primary',
  DISABLE: 'warning',
  LOGIN: 'success',
  LOGOUT: 'secondary',
};

const STRATEGY_ENTITY_TYPES = [
  'PRODUCT_EVENT_DAY_ACTION',
  'STRATEGY_EVENT_DAY_ACTION',
  'STRATEGY_DEFINITION',
  'STRATEGY_TEMPLATE',
  'STRATEGY_CONFIG_TREE',
  'STRATEGY_POLICY',
  'STRATEGY_TRANCH_CONFIG',
  'USER_STRATEGY',
  'USER_STRATEGY_TRANCH_CONFIG',
  'USER_SUBSCRIPTION',
  'TRANCH_SCHEDULE',
  'EXTERNAL_SIGNAL',
];

const STRATEGY_ALL_FILTER = '__STRATEGY_ALL__';
const USER_ALL_FILTER = '__USER_ALL__';
const BROKER_ALL_FILTER = '__BROKER_ALL__';

const USER_ENTITY_TYPES = [
  'USER',
  'USER_BROKER',
  'USER_STRATEGY',
  'USER_EVENT_DAY_ACTION',
  'USER_CAPITAL_MAP',
  'USER_STRATEGY_TRANCH_CONFIG',
  'USER_SUBSCRIPTION',
];

const BROKER_ENTITY_TYPES = [
  'BROKER',
  'BROKER_EXCHANGE_CONFIG',
  'BROKER_STRATEGY_CONFIG',
  'BROKERAGE_PLAN',
  'BROKERAGE_PLAN_RATE',
  'STATUTORY_CHARGES',
];

const ENTITY_TYPE_LABELS: Record<string, string> = {
  PRODUCT_EVENT_DAY_ACTION: 'Product Event Day Actions',
  STRATEGY_EVENT_DAY_ACTION: 'Strategy Event Day Actions',
  STRATEGY_DEFINITION: 'Strategy Definitions',
  STRATEGY_TEMPLATE: 'Strategy Templates',
  STRATEGY_CONFIG_TREE: 'Strategy Config Tree',
  STRATEGY_POLICY: 'Strategy Policies',
  STRATEGY_TRANCH_CONFIG: 'Strategy Tranch Config',
  USER_STRATEGY: 'User Strategy',
  USER_STRATEGY_TRANCH_CONFIG: 'User Strategy Tranch Config',
  USER_SUBSCRIPTION: 'User Subscriptions',
  USER_EVENT_DAY_ACTION: 'User Event Day Actions',
  USER_CAPITAL_MAP: 'User Capital Map',
  BROKER_EXCHANGE_CONFIG: 'Broker Exchange Config',
  BROKER_STRATEGY_CONFIG: 'Broker Strategy Config',
  BROKERAGE_PLAN: 'Brokerage Plans',
  BROKERAGE_PLAN_RATE: 'Brokerage Plan Rates',
  STATUTORY_CHARGES: 'Statutory Charges',
  TRANCH_SCHEDULE: 'Tranch Schedules',
  EXTERNAL_SIGNAL: 'External Signals',
};

const formatEntityTypeLabel = (type: string) =>
  ENTITY_TYPE_LABELS[type] || type.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

const AuditLogs: React.FC<AuditLogsProps> = ({
  title = 'Audit Logs',
  filterByEntityType,
  filterByUsername,
  filterByAction,
  defaultDays = 7,
  hideColumns = [],
  onLogClick,
}) => {
  const [search, setSearch] = useState('');
  // Search is applied server-side (debounced) so it matches across the whole filtered
  // set, not just the rows already loaded on the client.
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);
  const [entityTypeFilter, setEntityTypeFilter] = useState(filterByEntityType || '');
  const [actionFilter, setActionFilter] = useState(filterByAction || '');
  const [daysFilter, setDaysFilter] = useState(defaultDays);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [showModal, setShowModal] = useState(false);
  const [selectedLog, setSelectedLog] = useState<AuditLogType | null>(null);

  // Any filter / search / page-size change resets to the first page so the user
  // never lands on a now-out-of-range page.
  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, entityTypeFilter, actionFilter, daysFilter, pageSize]);

  // Fetch entity types for dropdown
  const { data: entityTypes = [], isLoading: entityTypesLoading } = useQuery({
    queryKey: ['auditLogEntityTypes'],
    queryFn: () => auditLogService.getEntityTypes(),
  });

  const filter: AuditLogFilter = useMemo(() => ({
    entityType: entityTypeFilter &&
      entityTypeFilter !== STRATEGY_ALL_FILTER &&
      entityTypeFilter !== USER_ALL_FILTER &&
      entityTypeFilter !== BROKER_ALL_FILTER
        ? entityTypeFilter
        : undefined,
    entityTypes:
      entityTypeFilter === STRATEGY_ALL_FILTER ? STRATEGY_ENTITY_TYPES.join(',') :
      entityTypeFilter === USER_ALL_FILTER ? USER_ENTITY_TYPES.join(',') :
      entityTypeFilter === BROKER_ALL_FILTER ? BROKER_ENTITY_TYPES.join(',') :
      undefined,
    username: filterByUsername,
    action: actionFilter || undefined,
    days: daysFilter,
    search: debouncedSearch || undefined,
    page,
    pageSize,
  }), [entityTypeFilter, filterByUsername, actionFilter, daysFilter, debouncedSearch, page, pageSize]);

  const { data: logsPage, isLoading, error, refetch } = useQuery({
    queryKey: ['auditLogs', filter],
    queryFn: () => auditLogService.getPaginated(filter),
  });

  // Search/entity/action/date filtering AND pagination all happen server-side, so
  // render the returned page directly and read the count from the server total.
  const filteredLogs = logsPage?.data ?? [];
  const pagination = logsPage?.pagination;

  const handleViewClick = (log: AuditLogType) => {
    if (onLogClick) {
      onLogClick(log);
    } else {
      setSelectedLog(log);
      setShowModal(true);
    }
  };

  const columns: Column<AuditLogType>[] = [
    ...(hideColumns.includes('timestamp') ? [] : [{
      key: 'changedTimestamp' as const,
      header: 'Timestamp',
      render: (l: AuditLogType) => (
        <small>{new Date(l.changedTimestamp).toLocaleString()}</small>
      ),
    }]),
    ...(hideColumns.includes('action') ? [] : [{
      key: 'action' as const,
      header: 'Action',
      render: (l: AuditLogType) => <Badge bg={ACTION_COLORS[l.action] || 'secondary'}>{l.action}</Badge>,
    }]),
    ...(hideColumns.includes('entityType') ? [] : [{
      key: 'entityType' as const,
      header: 'Entity Type',
      render: (l: AuditLogType) => <Badge bg="primary">{l.entityType}</Badge>,
    }]),
    ...(hideColumns.includes('entityId') ? [] : [{
      key: 'entityId' as const,
      header: 'Entity ID',
      render: (l: AuditLogType) => <code className="text-[0.875em]">{l.entityId}</code>,
    }]),
    ...(hideColumns.includes('entityName') ? [] : [{
      key: 'entityName' as const,
      header: 'Entity Name',
      render: (l: AuditLogType) => <span className="text-ink-soft">{l.entityName || '-'}</span>,
    }]),
    ...(hideColumns.includes('changedBy') ? [] : [{
      key: 'changedBy' as const,
      header: 'Changed By',
      render: (l: AuditLogType) => <span className="font-medium">{l.changedBy}</span>,
    }]),
    ...(hideColumns.includes('actions') ? [] : [{
      key: 'actions' as const,
      header: 'Details',
      render: (l: AuditLogType) => (
        <Button
          variant="outline-secondary"
          size="sm"
          onClick={(e) => { e.stopPropagation(); handleViewClick(l); }}
          title="View Details"
        >
          <BsEye />
        </Button>
      ),
    }]),
  ];

  if (error) {
    return <Alert variant="danger">Failed to load audit logs</Alert>;
  }

  return (
    <>
      <Card>
        <Card.Header className="flex justify-between items-center">
          <h5 className="mb-0">{title}</h5>
          <Button variant="outline-secondary" size="sm" onClick={() => refetch()} title="Refresh">
            <BsArrowClockwise />
          </Button>
        </Card.Header>
        <Card.Body>
          <Row className="mb-4 ">
            <Col md={3}>
              <InputGroup>
                <InputGroup.Text><BsSearch /></InputGroup.Text>
                <Form.Control
                  placeholder="Search logs..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </InputGroup>
            </Col>
            {!filterByEntityType && (
              <Col md={2}>
                <Form.Select
                  value={entityTypeFilter}
                  onChange={(e) => setEntityTypeFilter(e.target.value)}
                  disabled={entityTypesLoading}
                >
                  <option value="">All Entity Types</option>
                  <option value={USER_ALL_FILTER}>User (All)</option>
                  <option value={BROKER_ALL_FILTER}>Broker (All)</option>
                  <option value={STRATEGY_ALL_FILTER}>Strategy (All)</option>
                  {entityTypes.map((type) => (
                    <option key={type} value={type}>{formatEntityTypeLabel(type)}</option>
                  ))}
                </Form.Select>
              </Col>
            )}
            {!filterByAction && (
              <Col md={2}>
                <Form.Select
                  value={actionFilter}
                  onChange={(e) => setActionFilter(e.target.value)}
                >
                  <option value="">All Actions</option>
                  {ACTIONS.map((a) => (
                    <option key={a} value={a}>{a}</option>
                  ))}
                </Form.Select>
              </Col>
            )}
            <Col md={2}>
              <Form.Select
                value={daysFilter}
                onChange={(e) => setDaysFilter(parseInt(e.target.value))}
              >
                <option value={1}>Last 1 day</option>
                <option value={7}>Last 7 days</option>
                <option value={30}>Last 30 days</option>
                <option value={90}>Last 90 days</option>
              </Form.Select>
            </Col>
          </Row>
          {pagination && (
            <TablePagination
              page={pagination.page}
              pageSize={pagination.pageSize}
              totalCount={pagination.totalCount}
              totalPages={pagination.totalPages}
              onPageChange={setPage}
              onPageSizeChange={setPageSize}
              itemLabel="logs"
              loading={isLoading}
            />
          )}
          <DataTable
            columns={columns}
            data={filteredLogs}
            loading={isLoading}
            keyExtractor={(l) => String(l.id)}
            emptyMessage="No audit logs found"
            onRowClick={onLogClick ? handleViewClick : undefined}
          />
        </Card.Body>
        <Card.Footer className="text-ink-soft text-[0.875em]">
          {pagination?.totalCount ?? filteredLogs.length} log(s)
        </Card.Footer>
      </Card>

      <AuditLog
        log={selectedLog}
        show={showModal}
        onClose={() => { setShowModal(false); setSelectedLog(null); }}
      />
    </>
  );
};

export default AuditLogs;
