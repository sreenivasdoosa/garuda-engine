/**
 * Symbols Component
 * Table for listing trading symbols (SymbolInfo)
 * Reusable across Admin portals
 * Uses V2 API: /api/v2/symbols
 *
 * Distributed: Symbols synced from market-data service. Only core fields editable.
 * Standalone: Full CRUD - all fields editable, add/delete supported.
 */

import { useState } from 'react';
import { Card, Button, Badge, Alert, Form, InputGroup, Row, Col } from '@/components/ui/rbShim';
import { BsEye, BsPencil, BsPlus, BsSearch, BsTrash, BsArrowRepeat } from 'react-icons/bs';
import { DataTable, ConfirmModal } from '@/components/common';
import type { Column } from '@/components/common';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { symbolService, exchangeService, marketDataSyncService } from '@/services/admin/v2AdminService';
import { toast } from 'react-toastify';
import type { Symbol as SymbolType, CreateSymbolRequest } from '@/types/symbol';
import Symbol from './Symbol';

export interface SymbolsProps {
  /** Card title */
  title?: string;
  /** Whether user can edit/create/delete (Standalone mode) */
  canEdit?: boolean;
  /** Read-only mode - shows View button instead of Edit */
  readOnly?: boolean;
  /** Hide sync button */
  hideSync?: boolean;
  /** Show view mode on click */
  viewModeOnClick?: boolean;
  /** Callback when symbol is clicked */
  onSymbolClick?: (symbol: SymbolType) => void;
}

const Symbols: React.FC<SymbolsProps> = ({
  title = 'Symbols',
  canEdit = false,
  readOnly = false,
  hideSync = false,
  viewModeOnClick = false,
  onSymbolClick,
}) => {
  const [showModal, setShowModal] = useState(false);
  const [selectedSymbol, setSelectedSymbol] = useState<SymbolType | null>(null);
  const [modalMode, setModalMode] = useState<'view' | 'edit' | 'create'>('create');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterExchange, setFilterExchange] = useState<string>('');
  const [filterType, setFilterType] = useState<'' | 'INDEX' | 'STOCK'>('');
  const [filterExpiry, setFilterExpiry] = useState<'' | 'WEEKLY' | 'MONTHLY_ONLY'>('');
  const queryClient = useQueryClient();

  // Sync mutation
  const syncMutation = useMutation({
    mutationFn: () => marketDataSyncService.triggerSync(),
    onSuccess: () => {
      toast.success('Sync triggered successfully. Data will be updated shortly.');
      // Refetch symbols after a short delay to allow sync to complete
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['symbols'] });
      }, 3000);
    },
    onError: (error: Error) => {
      toast.error(`Sync failed: ${error.message}`);
    },
  });

  const { data: symbols, isLoading, error } = useQuery({
    queryKey: ['symbols', filterExchange],
    queryFn: () => symbolService.getAll({
      exchange: filterExchange || undefined,
    }),
  });

  const { data: exchanges } = useQuery({
    queryKey: ['exchanges'],
    queryFn: () => exchangeService.getAll(),
  });

  const createMutation = useMutation({
    mutationFn: (data: CreateSymbolRequest) => symbolService.create(data),
    onSuccess: () => {
      toast.success('Symbol created successfully');
      queryClient.invalidateQueries({ queryKey: ['symbols'] });
      setShowModal(false);
    },
    onError: (error: Error) => {
      toast.error(`Failed to create symbol: ${error.message}`);
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ symbol, data }: { symbol: string; data: Partial<CreateSymbolRequest> }) =>
      symbolService.update(symbol, data),
    onSuccess: () => {
      toast.success('Symbol updated successfully');
      queryClient.invalidateQueries({ queryKey: ['symbols'] });
      setShowModal(false);
    },
    onError: (error: Error) => {
      toast.error(`Failed to update symbol: ${error.message}`);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (symbol: string) => symbolService.delete(symbol),
    onSuccess: () => {
      toast.success('Symbol deleted successfully');
      queryClient.invalidateQueries({ queryKey: ['symbols'] });
      setShowDeleteConfirm(false);
      setSelectedSymbol(null);
    },
    onError: (error: Error) => {
      toast.error(`Failed to delete symbol: ${error.message}`);
    },
  });

  const symbolsList = symbols || [];

  // Filter symbols based on search term + type/expiry dropdowns (exchange filters server-side),
  // ordered indices first (the hand-tuned rows), then stocks alphabetically — with ~210
  // auto-synced stock rows a flat alphabetical list buries the indices.
  const filteredSymbols = symbolsList
    .filter((s) => {
      if (!searchTerm) return true;
      const term = searchTerm.toLowerCase();
      return (
        s.symbol.toLowerCase().includes(term) ||
        s.indexSymbol?.toLowerCase().includes(term) ||
        s.exchange?.toLowerCase().includes(term)
      );
    })
    .filter((s) => (filterType === '' ? true : filterType === 'INDEX' ? s.isIndex : !s.isIndex))
    .filter((s) => {
      if (filterExpiry === '') return true;
      const weekly = s.hasOptionsWeeklyExpiry || s.hasFuturesWeeklyExpiry;
      return filterExpiry === 'WEEKLY' ? weekly : !weekly;
    })
    .sort((a, b) =>
      a.isIndex !== b.isIndex ? (a.isIndex ? -1 : 1) : a.symbol.localeCompare(b.symbol)
    );

  const handleViewClick = (symbol: SymbolType) => {
    if (onSymbolClick) {
      onSymbolClick(symbol);
    } else {
      setSelectedSymbol(symbol);
      setModalMode(viewModeOnClick ? 'view' : 'edit');
      setShowModal(true);
    }
  };

  const handleSave = (data: CreateSymbolRequest, isNew: boolean) => {
    if (isNew) {
      createMutation.mutate(data);
    } else if (selectedSymbol) {
      updateMutation.mutate({
        symbol: selectedSymbol.symbol,
        data,
      });
    }
  };

  const columns: Column<SymbolType>[] = [
    {
      key: 'symbol',
      header: 'Symbol',
      render: (s) => (
        <div>
          <div className="font-medium">{s.symbol}</div>
          {s.indexSymbol && <small className="text-ink-soft">{s.indexSymbol}</small>}
        </div>
      ),
    },
    {
      key: 'exchange',
      header: 'Exchange',
      render: (s) => <Badge bg="secondary">{s.exchange}</Badge>,
    },
    {
      key: 'isIndex',
      header: 'Type',
      render: (s) => (
        <Badge bg={s.isIndex ? 'info' : 'secondary'}>
          {s.isIndex ? 'Index' : 'Stock'}
        </Badge>
      ),
    },
    {
      key: 'strikeGap',
      header: 'Strike Gap',
      render: (s) => <small>{s.strikeGap || '-'}</small>,
    },
    {
      key: 'freezeLimitQty',
      header: 'Freeze Limit',
      render: (s) => <small>{s.freezeLimitQty || '-'}</small>,
    },
    {
      key: 'contractMultiplier',
      header: 'Multiplier',
      render: (s) => <small>{s.contractMultiplier || 1}</small>,
    },
    {
      key: 'expiry',
      header: 'Expiry Types',
      render: (s) => (
        <div className="flex flex-wrap gap-1">
          {s.hasOptionsWeeklyExpiry && <Badge bg="success" className="text-[0.875em]">Opt-W</Badge>}
          {s.hasOptionsMonthlyExpiry && <Badge bg="success" className="text-[0.875em]">Opt-M</Badge>}
          {s.hasFuturesWeeklyExpiry && <Badge bg="warning" className="text-[0.875em]">Fut-W</Badge>}
          {s.hasFuturesMonthlyExpiry && <Badge bg="warning" className="text-[0.875em]">Fut-M</Badge>}
        </div>
      ),
    },
    {
      key: 'maxOptionChainLevels',
      header: 'Max OC Levels',
      render: (s) => <small>{s.maxOptionChainLevels || '-'}</small>,
    },
    {
      key: 'actions',
      header: 'Actions',
      render: (s) => (
        <div className="flex gap-1">
          {viewModeOnClick && (
            <Button variant="outline-secondary" size="sm" onClick={(ev) => { ev.stopPropagation(); handleViewClick(s); }}><BsEye /></Button>
          )}
          <Button variant="outline-primary" size="sm" onClick={(ev) => { ev.stopPropagation(); setSelectedSymbol(s); setModalMode(readOnly ? 'view' : 'edit'); setShowModal(true); }} title={readOnly ? 'View' : 'Edit'}>{readOnly ? <BsEye /> : <BsPencil />}</Button>
          {canEdit && (
            <Button variant="outline-danger" size="sm" onClick={(ev) => { ev.stopPropagation(); setSelectedSymbol(s); setShowDeleteConfirm(true); }} title="Delete"><BsTrash /></Button>
          )}
        </div>
      ),
    },
  ];

  if (error) {
    return <Alert variant="danger">Failed to load symbols</Alert>;
  }

  return (
    <>
      <Card>
        <Card.Header className="flex justify-between items-center">
          <h5 className="mb-0">{title}</h5>
          <div className="flex items-center gap-2">
            {!hideSync && (
              <Button
                variant="outline-primary"
                size="sm"
                onClick={() => syncMutation.mutate()}
                disabled={syncMutation.isPending}
              >
                {syncMutation.isPending ? (
                  <>
                    <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-r-transparent align-[-0.125em] text-primary-500 me-1" />
                    Syncing...
                  </>
                ) : (
                  <>
                    <BsArrowRepeat className="me-1" />
                    Sync Now
                  </>
                )}
              </Button>
            )}
            {canEdit && (
              <Button
                variant="primary"
                size="sm"
                onClick={() => { setSelectedSymbol(null); setModalMode('create'); setShowModal(true); }}
              >
                <BsPlus className="me-1" />
                Add Symbol
              </Button>
            )}
          </div>
        </Card.Header>
        <Card.Body>
          {/* Search and Filter */}
          <Row className="mb-4 ">
            <Col md={5}>
              <InputGroup size="sm">
                <InputGroup.Text><BsSearch /></InputGroup.Text>
                <Form.Control
                  placeholder="Search symbols..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                />
              </InputGroup>
            </Col>
            <Col md={2}>
              <Form.Select
                size="sm"
                value={filterExchange}
                onChange={(e) => setFilterExchange(e.target.value)}
              >
                <option value="">All Exchanges</option>
                {exchanges?.map((ex) => (
                  <option key={ex.exchange} value={ex.exchange}>{ex.exchange}</option>
                ))}
              </Form.Select>
            </Col>
            <Col md={2}>
              <Form.Select
                size="sm"
                value={filterType}
                onChange={(e) => setFilterType(e.target.value as '' | 'INDEX' | 'STOCK')}
                title="Filter by symbol type"
              >
                <option value="">All Types</option>
                <option value="INDEX">Indices</option>
                <option value="STOCK">Stocks</option>
              </Form.Select>
            </Col>
            <Col md={2}>
              <Form.Select
                size="sm"
                value={filterExpiry}
                onChange={(e) => setFilterExpiry(e.target.value as '' | 'WEEKLY' | 'MONTHLY_ONLY')}
                title="Filter by expiry calendar (options or futures)"
              >
                <option value="">All Expiries</option>
                <option value="WEEKLY">Has Weekly</option>
                <option value="MONTHLY_ONLY">Monthly Only</option>
              </Form.Select>
            </Col>
          </Row>

          <DataTable
            columns={columns}
            data={filteredSymbols}
            loading={isLoading}
            keyExtractor={(s) => s.symbol}
            emptyMessage="No symbols found"
            onRowClick={onSymbolClick ? handleViewClick : undefined}
          />
        </Card.Body>
        <Card.Footer className="text-ink-soft text-[0.875em]">
          Showing {filteredSymbols.length} of {symbolsList.length} symbol(s)
        </Card.Footer>
      </Card>

      <Symbol
        symbol={selectedSymbol}
        show={showModal}
        onClose={() => { setShowModal(false); setSelectedSymbol(null); }}
        onSave={handleSave}
        isSaving={createMutation.isPending || updateMutation.isPending}
        mode={modalMode}
      />

      <ConfirmModal
        show={showDeleteConfirm}
        title="Delete Symbol"
        message={`Are you sure you want to delete symbol "${selectedSymbol?.symbol}"?`}
        confirmLabel="Delete"
        confirmVariant="danger"
        onConfirm={() => selectedSymbol && deleteMutation.mutate(selectedSymbol.symbol)}
        onCancel={() => { setShowDeleteConfirm(false); setSelectedSymbol(null); }}
        isLoading={deleteMutation.isPending}
      />
    </>
  );
};

export default Symbols;
