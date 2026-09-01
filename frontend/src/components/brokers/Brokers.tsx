/**
 * Brokers Component
 * Table for listing brokers
 * Reusable across Admin portals
 * Uses V2 API: /api/v2/brokers
 */

import { useState, useMemo } from 'react';
import { Card, Button, Badge, Form, Row, Col, InputGroup, Alert } from '@/components/ui/rbShim';
import { BsPlus, BsTrash, BsSearch, BsToggleOn, BsToggleOff, BsEye, BsPencil, BsStop, BsPlay } from 'react-icons/bs';
import { DataTable } from '@/components/common';
import type { Column } from '@/components/common';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { brokerService } from '@/services/broker/brokerService';
import type { Broker as BrokerType, CreateBrokerRequest, UpdateBrokerRequest } from '@/types/broker';
import Broker from './Broker';
import BrokerDeleteModal from './BrokerDeleteModal';

export interface BrokersProps {
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
  hideColumns?: ('provider' | 'apiVersion' | 'totp' | 'websocket' | 'status' | 'actions')[];
  /** Callback when broker is clicked */
  onBrokerClick?: (broker: BrokerType) => void;
}

const Brokers: React.FC<BrokersProps> = ({
  title = 'Brokers',
  hideCreate = false,
  hideDelete = false,
  hideEnableDisable = false,
  readOnly = false,
  viewModeOnClick = false,
  hideColumns = [],
  onBrokerClick,
}) => {
  const [search, setSearch] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [selectedBroker, setSelectedBroker] = useState<BrokerType | null>(null);
  const [modalMode, setModalMode] = useState<'view' | 'edit' | 'create'>('create');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const queryClient = useQueryClient();

  const { data: brokers, isLoading, error } = useQuery({
    queryKey: ['brokers'],
    queryFn: () => brokerService.getAll(),
  });

  const createMutation = useMutation({
    mutationFn: (data: CreateBrokerRequest) => brokerService.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['brokers'] });
      setShowModal(false);
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ name, data }: { name: string; data: UpdateBrokerRequest }) => brokerService.update(name, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['brokers'] });
      setShowModal(false);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (name: string) => brokerService.delete(name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['brokers'] });
      setShowDeleteConfirm(false);
      setSelectedBroker(null);
    },
    onError: (err: unknown) => {
      // 409 = a USER_BROKERS_MAP / etc. row appeared between the usage
      // fetch and the delete. Refetch the usage so the modal re-renders
      // with the now-blocking dependency list instead of a generic error.
      const status = (err as { status?: number })?.status;
      if (status === 409 && selectedBroker) {
        queryClient.invalidateQueries({ queryKey: ['broker', 'usage', selectedBroker.name] });
      }
    },
  });

  const stopMutation = useMutation({
    mutationFn: (name: string) => brokerService.stop(name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['brokers'] });
    },
  });

  const unstopMutation = useMutation({
    mutationFn: (name: string) => brokerService.unstop(name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['brokers'] });
    },
  });

  const filteredBrokers = useMemo(() => {
    if (!brokers) return [];
    if (!search) return brokers;
    const searchLower = search.toLowerCase();
    return brokers.filter(
      (b) =>
        b.name?.toLowerCase().includes(searchLower) ||
        b.provider?.toLowerCase().includes(searchLower) ||
        b.description?.toLowerCase().includes(searchLower)
    );
  }, [brokers, search]);

  // Check if any broker has multiple API versions available
  const hasMultipleApiVersions = useMemo(() => {
    return brokers?.some((b) => b.availableApiVersions && b.availableApiVersions.length > 1) ?? false;
  }, [brokers]);

  const handleCreateClick = () => {
    setSelectedBroker(null);
    setModalMode('create');
    setShowModal(true);
  };

  const handleViewClick = (broker: BrokerType) => {
    if (onBrokerClick) {
      onBrokerClick(broker);
    } else {
      setSelectedBroker(broker);
      setModalMode(viewModeOnClick ? 'view' : 'edit');
      setShowModal(true);
    }
  };

  const handleToggle = (broker: BrokerType) => {
    updateMutation.mutate({
      name: broker.name,
      data: { enabled: !broker.enabled },
    });
  };

  const handleStopToggle = (broker: BrokerType) => {
    if (broker.stopped) {
      unstopMutation.mutate(broker.name);
    } else {
      stopMutation.mutate(broker.name);
    }
  };

  const handleSave = (data: CreateBrokerRequest | UpdateBrokerRequest, isNew: boolean) => {
    if (isNew) {
      createMutation.mutate(data as CreateBrokerRequest);
    } else if (selectedBroker) {
      updateMutation.mutate({ name: selectedBroker.name, data: data as UpdateBrokerRequest });
    }
  };

  const columns: Column<BrokerType>[] = [
    {
      key: 'broker',
      header: 'Broker',
      render: (b) => (
        <div>
          <div className="font-medium">{b.name}</div>
          {b.description && <small className="text-ink-soft">{b.description}</small>}
        </div>
      ),
    },
    ...(hideColumns.includes('provider') ? [] : [{
      key: 'provider' as const,
      header: 'Provider',
      render: (b: BrokerType) => (
        <span className="text-ink-soft">{b.provider || 'N/A'}</span>
      ),
    }]),
    ...((hideColumns.includes('apiVersion') || !hasMultipleApiVersions) ? [] : [{
      key: 'apiVersion' as const,
      header: 'API Ver',
      render: (b: BrokerType) => (
        <Badge bg={b.apiVersion >= 2 ? 'primary' : 'secondary'}>
          V{b.apiVersion || 1}
        </Badge>
      ),
    }]),
    ...(hideColumns.includes('totp') ? [] : [{
      key: 'totp' as const,
      header: 'TOTP',
      render: (b: BrokerType) => (
        <Badge bg={b.totpEnabled ? 'info' : 'light'} text={b.totpEnabled ? 'white' : 'dark'}>
          {b.totpEnabled ? 'Yes' : 'No'}
        </Badge>
      ),
    }]),
    ...(hideColumns.includes('websocket') ? [] : [{
      key: 'websocket' as const,
      header: 'WebSocket',
      render: (b: BrokerType) => (
        <Badge bg={b.webSocketEnabled ? 'info' : 'light'} text={b.webSocketEnabled ? 'white' : 'dark'}>
          {b.webSocketEnabled ? 'Yes' : 'No'}
        </Badge>
      ),
    }]),
    {
      key: 'useDealerAPIs' as const,
      header: 'Use Dealer APIs',
      render: (b: BrokerType) => (
        <Badge bg={b.useDealerAPIs ? 'info' : 'light'} text={b.useDealerAPIs ? 'white' : 'dark'}>
          {b.useDealerAPIs ? 'Yes' : 'No'}
        </Badge>
      ),
    },
    {
      key: 'serverUrl' as const,
      header: 'Server URL',
      render: (b: BrokerType) => (
        <small className="text-ink-soft break-words">{b.serverUrl || '-'}</small>
      ),
    },
    {
      key: 'dataServerUrl' as const,
      header: 'Market Data URL',
      render: (b: BrokerType) => (
        <small className="text-ink-soft break-words">{b.dataServerUrl || '-'}</small>
      ),
    },
    ...(hideColumns.includes('status') ? [] : [{
      key: 'status' as const,
      header: 'Status',
      render: (b: BrokerType) => (
        <div>
          <Badge bg={b.enabled ? 'success' : 'secondary'}>
            {b.enabled ? 'Enabled' : 'Disabled'}
          </Badge>
          {b.stopped && <Badge bg="danger" className="ms-1">Stopped</Badge>}
          {b.autoLogin && <Badge bg="info" className="ms-1">Auto Login</Badge>}
        </div>
      ),
    }]),
    ...(hideColumns.includes('actions') ? [] : [{
      key: 'actions' as const,
      header: 'Actions',
      render: (b: BrokerType) => (
        <div className="flex gap-1">
          {viewModeOnClick && (
            <Button variant="outline-secondary" size="sm" onClick={(e) => { e.stopPropagation(); handleViewClick(b); }}><BsEye /></Button>
          )}
          <Button variant="outline-primary" size="sm" onClick={(e) => { e.stopPropagation(); setSelectedBroker(b); setModalMode(readOnly ? 'view' : 'edit'); setShowModal(true); }} title={readOnly ? 'View' : 'Edit'}>{readOnly ? <BsEye /> : <BsPencil />}</Button>
          {!hideEnableDisable && (
            <>
              {b.enabled ? (
                <Button
                  variant="outline-warning"
                  size="sm"
                  onClick={(e) => { e.stopPropagation(); handleToggle(b); }}
                  disabled={updateMutation.isPending}
                  title="Disable Broker"
                >
                  <BsToggleOff />
                </Button>
              ) : (
                <Button
                  variant="outline-success"
                  size="sm"
                  onClick={(e) => { e.stopPropagation(); handleToggle(b); }}
                  disabled={updateMutation.isPending}
                  title="Enable Broker"
                >
                  <BsToggleOn />
                </Button>
              )}
              {b.stopped ? (
                <Button
                  variant="outline-success"
                  size="sm"
                  onClick={(e) => { e.stopPropagation(); handleStopToggle(b); }}
                  disabled={stopMutation.isPending || unstopMutation.isPending}
                  title="Resume Broker"
                >
                  <BsPlay />
                </Button>
              ) : (
                <Button
                  variant="outline-danger"
                  size="sm"
                  onClick={(e) => { e.stopPropagation(); handleStopToggle(b); }}
                  disabled={stopMutation.isPending || unstopMutation.isPending}
                  title="Stop Broker"
                >
                  <BsStop />
                </Button>
              )}
            </>
          )}
          {!hideDelete && (
            <Button variant="outline-danger" size="sm" onClick={(e) => { e.stopPropagation(); setSelectedBroker(b); setShowDeleteConfirm(true); }}><BsTrash /></Button>
          )}
        </div>
      ),
    }]),
  ];

  if (error) {
    return <Alert variant="danger">Failed to load brokers</Alert>;
  }

  return (
    <>
      <Card>
        <Card.Header className="flex justify-between items-center">
          <h5 className="mb-0">{title}</h5>
          {!hideCreate && (
            <Button variant="primary" size="sm" onClick={handleCreateClick}>
              <BsPlus className="me-1" /> Add Broker
            </Button>
          )}
        </Card.Header>
        <Card.Body>
          <Row className="mb-4">
            <Col md={6}>
              <InputGroup>
                <InputGroup.Text><BsSearch /></InputGroup.Text>
                <Form.Control
                  placeholder="Search brokers..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </InputGroup>
            </Col>
          </Row>
          <DataTable
            columns={columns}
            data={filteredBrokers}
            loading={isLoading}
            keyExtractor={(b) => b.name}
            emptyMessage="No brokers found"
            onRowClick={onBrokerClick ? handleViewClick : undefined}
          />
        </Card.Body>
        <Card.Footer className="text-ink-soft text-[0.875em]">
          Total: {filteredBrokers.length} broker(s)
        </Card.Footer>
      </Card>

      <Broker
        broker={selectedBroker}
        show={showModal}
        onClose={() => { setShowModal(false); setSelectedBroker(null); }}
        onSave={handleSave}
        isSaving={createMutation.isPending || updateMutation.isPending}
        mode={modalMode}
        existingBrokerNames={brokers?.map(b => b.name) || []}
      />

      <BrokerDeleteModal
        show={showDeleteConfirm}
        brokerName={selectedBroker?.name ?? null}
        onCancel={() => { setShowDeleteConfirm(false); setSelectedBroker(null); }}
        onDelete={() => selectedBroker && deleteMutation.mutate(selectedBroker.name)}
        isDeleting={deleteMutation.isPending}
      />
    </>
  );
};

export default Brokers;
