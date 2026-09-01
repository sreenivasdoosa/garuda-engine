/**
 * Exchanges Component
 * Table for listing exchanges
 * Reusable across Admin portals
 * Uses V2 API: /api/v2/exchanges
 */

import { useState } from 'react';
import { Card, Button, Badge, Alert } from '@/components/ui/rbShim';
import { BsPlus, BsTrash, BsToggleOn, BsToggleOff, BsEye, BsPencil } from 'react-icons/bs';
import { DataTable, ConfirmModal } from '@/components/common';
import type { Column } from '@/components/common';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { exchangeService } from '@/services/admin/v2AdminService';
import type { Exchange as ExchangeType, CreateExchangeRequest } from '@/types/exchange';
import Exchange from './Exchange';

export interface ExchangesProps {
  /** Card title */
  title?: string;
  /** Hide add button */
  hideCreate?: boolean;
  /** Hide delete button */
  hideDelete?: boolean;
  /** Hide enable/disable buttons */
  hideEnableDisable?: boolean;
  /** Read-only mode - shows View button instead of Edit */
  readOnly?: boolean;
  /** Show view mode on click */
  viewModeOnClick?: boolean;
  /** Hide specific columns */
  hideColumns?: ('timezone' | 'hours' | 'status' | 'actions')[];
  /** Callback when exchange is clicked */
  onExchangeClick?: (exchange: ExchangeType) => void;
}

const Exchanges: React.FC<ExchangesProps> = ({
  title = 'Exchanges',
  hideCreate = false,
  hideDelete = false,
  hideEnableDisable = false,
  readOnly = false,
  viewModeOnClick = false,
  hideColumns = [],
  onExchangeClick,
}) => {
  const [showModal, setShowModal] = useState(false);
  const [selectedExchange, setSelectedExchange] = useState<ExchangeType | null>(null);
  const [modalMode, setModalMode] = useState<'view' | 'edit' | 'create'>('create');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const queryClient = useQueryClient();

  const { data: exchanges, isLoading, error } = useQuery({
    queryKey: ['exchanges'],
    queryFn: () => exchangeService.getAll(),
  });

  const createMutation = useMutation({
    mutationFn: (data: CreateExchangeRequest) => exchangeService.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['exchanges'] });
      setShowModal(false);
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ code, data }: { code: string; data: Partial<CreateExchangeRequest> }) =>
      exchangeService.update(code, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['exchanges'] });
      setShowModal(false);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (code: string) => exchangeService.delete(code),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['exchanges'] });
      setShowDeleteConfirm(false);
      setSelectedExchange(null);
    },
  });

  const exchangesList = exchanges || [];

  const handleCreateClick = () => {
    setSelectedExchange(null);
    setModalMode('create');
    setShowModal(true);
  };

  const handleViewClick = (exchange: ExchangeType) => {
    if (onExchangeClick) {
      onExchangeClick(exchange);
    } else {
      setSelectedExchange(exchange);
      setModalMode(viewModeOnClick ? 'view' : 'edit');
      setShowModal(true);
    }
  };

  const handleToggle = (exchange: ExchangeType) => {
    updateMutation.mutate({
      code: exchange.exchange,
      data: {
        exchange: exchange.exchange,
        exchangeName: exchange.exchangeName,
        segment: exchange.segment,
        timezone: exchange.timezone,
        preMarketStart: exchange.preMarketStart,
        preMarketEnd: exchange.preMarketEnd,
        marketOpen: exchange.marketOpen,
        marketClose: exchange.marketClose,
        algoStartMinutesBeforeMarketOpen: exchange.algoStartMinutesBeforeMarketOpen,
        loginMinutesBeforeMarketOpen: exchange.loginMinutesBeforeMarketOpen,
        intradaySquareOffMinutesBeforeClose: exchange.intradaySquareOffMinutesBeforeClose,
        intradaySquareOffBlockMinutesBeforeClose: exchange.intradaySquareOffBlockMinutesBeforeClose,
        positionalSquareOffMinutesBeforeClose: exchange.positionalSquareOffMinutesBeforeClose,
        postMarketWindowMinutes: exchange.postMarketWindowMinutes,
        reportMinutesAfterClose: exchange.reportMinutesAfterClose,
        billingMinutesAfterClose: exchange.billingMinutesAfterClose,
        weekendDays: exchange.weekendDays,
        isActive: !exchange.isActive,
        historyCacheEnabled: exchange.historyCacheEnabled,
      },
    });
  };

  const handleSave = (data: CreateExchangeRequest, isNew: boolean) => {
    if (isNew) {
      createMutation.mutate(data);
    } else if (selectedExchange) {
      updateMutation.mutate({ code: selectedExchange.exchange, data });
    }
  };

  const columns: Column<ExchangeType>[] = [
    {
      key: 'exchange',
      header: 'Exchange',
      render: (e) => (
        <div>
          <div className="font-medium">{e.exchange}</div>
          <small className="text-ink-soft">{e.exchangeName}</small>
        </div>
      ),
    },
    ...(hideColumns.includes('timezone') ? [] : [{
      key: 'timezone' as const,
      header: 'Timezone',
      render: (e: ExchangeType) => <small className="text-ink-soft">{e.timezone || 'N/A'}</small>,
    }]),
    ...(hideColumns.includes('hours') ? [] : [{
      key: 'premarket' as const,
      header: 'Pre-Market',
      render: (e: ExchangeType) => (
        <small>
          {e.preMarketStart || '--'} - {e.preMarketEnd || '--'}
        </small>
      ),
    }]),
    ...(hideColumns.includes('hours') ? [] : [{
      key: 'hours' as const,
      header: 'Market Hours',
      render: (e: ExchangeType) => (
        <small>
          {e.marketOpen || '--'} - {e.marketClose || '--'}
        </small>
      ),
    }]),
    {
      key: 'intradaySqOff' as const,
      header: 'Intraday SqOff',
      render: (e: ExchangeType) => (
        <small>{e.intradaySquareOffMinutesBeforeClose ?? '--'} mins</small>
      ),
    },
    {
      key: 'intradayBlockSqOff' as const,
      header: 'Block SqOff',
      render: (e: ExchangeType) => (
        <small>{e.intradaySquareOffBlockMinutesBeforeClose ?? '--'} mins</small>
      ),
    },
    {
      key: 'positionalSqOff' as const,
      header: 'Positional SqOff',
      render: (e: ExchangeType) => (
        <small>{e.positionalSquareOffMinutesBeforeClose ?? '--'} mins</small>
      ),
    },
    ...(hideColumns.includes('status') ? [] : [{
      key: 'status' as const,
      header: 'Status',
      render: (e: ExchangeType) => (
        <div>
          <Badge bg={e.isActive ? 'success' : 'secondary'}>
            {e.isActive ? 'Active' : 'Inactive'}
          </Badge>
          {e.historyCacheEnabled && <Badge bg="info" className="ms-1">Cache</Badge>}
        </div>
      ),
    }]),
    ...(hideColumns.includes('actions') ? [] : [{
      key: 'actions' as const,
      header: 'Actions',
      render: (e: ExchangeType) => (
        <div className="flex gap-1">
          {viewModeOnClick && (
            <Button variant="outline-secondary" size="sm" onClick={(ev) => { ev.stopPropagation(); handleViewClick(e); }}><BsEye /></Button>
          )}
          <Button variant="outline-primary" size="sm" onClick={(ev) => { ev.stopPropagation(); setSelectedExchange(e); setModalMode(readOnly ? 'view' : 'edit'); setShowModal(true); }} title={readOnly ? 'View' : 'Edit'}>{readOnly ? <BsEye /> : <BsPencil />}</Button>
          {!hideEnableDisable && (
            e.isActive ? (
              <Button
                variant="outline-warning"
                size="sm"
                onClick={(ev) => { ev.stopPropagation(); handleToggle(e); }}
                disabled={updateMutation.isPending}
                title="Deactivate Exchange"
              >
                <BsToggleOff />
              </Button>
            ) : (
              <Button
                variant="outline-success"
                size="sm"
                onClick={(ev) => { ev.stopPropagation(); handleToggle(e); }}
                disabled={updateMutation.isPending}
                title="Activate Exchange"
              >
                <BsToggleOn />
              </Button>
            )
          )}
          {!hideDelete && (
            <Button variant="outline-danger" size="sm" onClick={(ev) => { ev.stopPropagation(); setSelectedExchange(e); setShowDeleteConfirm(true); }}><BsTrash /></Button>
          )}
        </div>
      ),
    }]),
  ];

  if (error) {
    return <Alert variant="danger">Failed to load exchanges</Alert>;
  }

  return (
    <>
      <Card>
        <Card.Header className="flex justify-between items-center">
          <h5 className="mb-0">{title}</h5>
          {!hideCreate && (
            <Button variant="primary" size="sm" onClick={handleCreateClick}>
              <BsPlus className="me-1" /> Add Exchange
            </Button>
          )}
        </Card.Header>
        <Card.Body>
          <DataTable
            columns={columns}
            data={exchangesList}
            loading={isLoading}
            keyExtractor={(e) => e.exchange}
            emptyMessage="No exchanges found"
            onRowClick={onExchangeClick ? handleViewClick : undefined}
          />
        </Card.Body>
        <Card.Footer className="text-ink-soft text-[0.875em]">
          Total: {exchangesList.length} exchange(s)
        </Card.Footer>
      </Card>

      <Exchange
        exchange={selectedExchange}
        show={showModal}
        onClose={() => { setShowModal(false); setSelectedExchange(null); }}
        onSave={handleSave}
        isSaving={createMutation.isPending || updateMutation.isPending}
        mode={modalMode}
      />

      <ConfirmModal
        show={showDeleteConfirm}
        title="Delete Exchange"
        message={`Are you sure you want to delete exchange "${selectedExchange?.exchangeName || selectedExchange?.exchange}"?`}
        confirmLabel="Delete"
        confirmVariant="danger"
        onConfirm={() => selectedExchange && deleteMutation.mutate(selectedExchange.exchange)}
        onCancel={() => { setShowDeleteConfirm(false); setSelectedExchange(null); }}
        isLoading={deleteMutation.isPending}
      />
    </>
  );
};

export default Exchanges;
