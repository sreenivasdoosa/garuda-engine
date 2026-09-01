/**
 * UserBrokers Component
 * Table for listing user broker configurations
 * Reusable across Admin, Client Manager portals
 * Uses V2 API: /api/v2/users/{username}/brokers
 */

import { useState, useMemo } from 'react';
import { Card, Button, Badge, Form, Row, Col, InputGroup, Alert } from '@/components/ui/rbShim';
import { BsPlus, BsTrash, BsSearch, BsToggleOn, BsToggleOff, BsEye, BsPencil } from 'react-icons/bs';
import { DataTable, ConfirmModal } from '@/components/common';
import type { Column } from '@/components/common';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { userBrokerService } from '@/services/admin/v2AdminService';
import type { UserBrokerConfig, CreateUserBrokerRequest, UpdateUserBrokerRequest } from '@/types/user_mgmt';
import UserBroker from './UserBroker';

export interface UserBrokersProps {
  /** Username to show brokers for */
  username: string;
  /** Card title */
  title?: string;
  /** Hide add button */
  hideCreate?: boolean;
  /** Hide delete button */
  hideDelete?: boolean;
  /** Hide enable/disable buttons */
  hideEnableDisable?: boolean;
  /** Show view mode on click */
  viewModeOnClick?: boolean;
  /** Available brokers for dropdown */
  availableBrokers?: { name: string; displayName: string }[];
  /** Callback when broker is clicked */
  onBrokerClick?: (broker: UserBrokerConfig) => void;
}

const UserBrokers: React.FC<UserBrokersProps> = ({
  username,
  title = 'User Brokers',
  hideCreate = false,
  hideDelete = false,
  hideEnableDisable = false,
  viewModeOnClick = false,
  availableBrokers: _availableBrokers = [],
  onBrokerClick,
}) => {
  const [search, setSearch] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [selectedBroker, setSelectedBroker] = useState<UserBrokerConfig | null>(null);
  const [modalMode, setModalMode] = useState<'view' | 'edit' | 'create'>('create');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const queryClient = useQueryClient();

  const { data: brokers, isLoading, error } = useQuery({
    queryKey: ['userBrokers', username],
    queryFn: () => userBrokerService.getUserBrokers(username),
    enabled: !!username,
  });

  const addMutation = useMutation({
    mutationFn: (data: CreateUserBrokerRequest) => userBrokerService.addBrokerToUser(username, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['userBrokers', username] });
      setShowModal(false);
      setSelectedBroker(null);
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ broker, data }: { broker: string; data: UpdateUserBrokerRequest }) =>
      userBrokerService.updateUserBroker(username, broker, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['userBrokers', username] });
      setShowModal(false);
      setSelectedBroker(null);
    },
  });

  const enableMutation = useMutation({
    mutationFn: (broker: string) => userBrokerService.enableUserBroker(username, broker),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['userBrokers', username] }),
  });

  const disableMutation = useMutation({
    mutationFn: (broker: string) => userBrokerService.disableUserBroker(username, broker),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['userBrokers', username] }),
  });

  const deleteMutation = useMutation({
    mutationFn: (broker: string) => userBrokerService.removeBrokerFromUser(username, broker),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['userBrokers', username] });
      setShowDeleteConfirm(false);
      setSelectedBroker(null);
    },
  });

  const filteredBrokers = useMemo(() => {
    if (!brokers) return [];
    if (!search) return brokers;
    const searchLower = search.toLowerCase();
    return brokers.filter(
      (b) =>
        b.broker?.toLowerCase().includes(searchLower) ||
        b.clientID?.toLowerCase().includes(searchLower) ||
        b.brokeragePlan?.toLowerCase().includes(searchLower)
    );
  }, [brokers, search]);

  const handleCreateClick = () => {
    setSelectedBroker(null);
    setModalMode('create');
    setShowModal(true);
  };

  const handleViewClick = (broker: UserBrokerConfig) => {
    if (onBrokerClick) {
      onBrokerClick(broker);
    } else {
      setSelectedBroker(broker);
      setModalMode(viewModeOnClick ? 'view' : 'edit');
      setShowModal(true);
    }
  };

  const handleToggle = (broker: UserBrokerConfig) => {
    if (broker.enabled) {
      disableMutation.mutate(broker.broker);
    } else {
      enableMutation.mutate(broker.broker);
    }
  };

  const handleSave = (data: CreateUserBrokerRequest | UpdateUserBrokerRequest, isNew: boolean) => {
    if (isNew) {
      addMutation.mutate(data as CreateUserBrokerRequest);
    } else if (selectedBroker) {
      updateMutation.mutate({ broker: selectedBroker.broker, data: data as UpdateUserBrokerRequest });
    }
  };

  const columns: Column<UserBrokerConfig>[] = [
    {
      key: 'broker',
      header: 'Broker',
      render: (b) => (
        <div>
          <div className="font-medium">{b.broker}</div>
          {b.brokeragePlan && <small className="text-ink-soft">Plan: {b.brokeragePlan}</small>}
        </div>
      ),
    },
    {
      key: 'clientID',
      header: 'Client ID',
      render: (b) => <code>{b.clientID}</code>,
    },
    {
      key: 'status',
      header: 'Status',
      render: (b) => (
        <div>
          <Badge bg={b.enabled ? 'success' : 'secondary'}>{b.enabled ? 'Enabled' : 'Disabled'}</Badge>
          {b.loginVerified && <Badge bg="info" className="ms-1">Verified</Badge>}
        </div>
      ),
    },
    {
      key: 'autoLogin',
      header: 'Auto Login',
      render: (b) => <Badge bg={b.autoLogin ? 'primary' : 'light'} text={b.autoLogin ? 'white' : 'dark'}>{b.autoLogin ? 'Yes' : 'No'}</Badge>,
    },
    {
      key: 'isPro',
      header: 'Pro',
      render: (b) => <Badge bg={b.isPro ? 'warning' : 'light'} text="dark">{b.isPro ? 'Yes' : 'No'}</Badge>,
    },
    {
      key: 'allocation',
      header: 'Allocation',
      render: (b) => <span className="text-ink-soft text-[0.875em]">{b.allocationModel || 'Default'}</span>,
    },
    {
      key: 'actions',
      header: 'Actions',
      render: (b) => (
        <div className="flex gap-1">
          {viewModeOnClick && (
            <Button variant="outline-secondary" size="sm" onClick={(e) => { e.stopPropagation(); handleViewClick(b); }}><BsEye /></Button>
          )}
          <Button variant="outline-primary" size="sm" onClick={(e) => { e.stopPropagation(); setSelectedBroker(b); setModalMode('edit'); setShowModal(true); }}><BsPencil /></Button>
          {!hideEnableDisable && (
            b.enabled ? (
              <Button
                variant="outline-warning"
                size="sm"
                onClick={(e) => { e.stopPropagation(); handleToggle(b); }}
                disabled={enableMutation.isPending || disableMutation.isPending}
                title="Disable Broker"
              >
                <BsToggleOff />
              </Button>
            ) : (
              <Button
                variant="outline-success"
                size="sm"
                onClick={(e) => { e.stopPropagation(); handleToggle(b); }}
                disabled={enableMutation.isPending || disableMutation.isPending}
                title="Enable Broker"
              >
                <BsToggleOn />
              </Button>
            )
          )}
          {!hideDelete && (
            <Button variant="outline-danger" size="sm" onClick={(e) => { e.stopPropagation(); setSelectedBroker(b); setShowDeleteConfirm(true); }}><BsTrash /></Button>
          )}
        </div>
      ),
    },
  ];

  if (!username) {
    return <Alert variant="info">Please select a user to view their brokers.</Alert>;
  }

  if (error) {
    return <Alert variant="danger">Failed to load user brokers</Alert>;
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
            keyExtractor={(b) => `${b.username}-${b.broker}`}
            emptyMessage="No brokers configured"
            onRowClick={onBrokerClick ? handleViewClick : undefined}
          />
        </Card.Body>
        <Card.Footer className="text-ink-soft text-[0.875em]">
          Total: {filteredBrokers.length} broker(s)
        </Card.Footer>
      </Card>

      <UserBroker
        broker={selectedBroker}
        username={username}
        show={showModal}
        onClose={() => { setShowModal(false); setSelectedBroker(null); }}
        onSave={handleSave}
        isSaving={addMutation.isPending || updateMutation.isPending}
        mode={modalMode}
      />

      <ConfirmModal
        show={showDeleteConfirm}
        title="Remove Broker"
        message={`Are you sure you want to remove broker "${selectedBroker?.broker}" from this user?`}
        confirmLabel="Remove"
        confirmVariant="danger"
        onConfirm={() => selectedBroker && deleteMutation.mutate(selectedBroker.broker)}
        onCancel={() => { setShowDeleteConfirm(false); setSelectedBroker(null); }}
        isLoading={deleteMutation.isPending}
      />
    </>
  );
};

export default UserBrokers;
