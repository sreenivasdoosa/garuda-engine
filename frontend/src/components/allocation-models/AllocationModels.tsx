/**
 * AllocationModels Component
 * Table for listing allocation models
 * Reusable across Admin portals
 */

import { useState, useMemo } from 'react';
import { Card, Button, Badge, Form, Row, Col, InputGroup, Alert, Spinner, Modal, ListGroup } from '@/components/ui/rbShim';
import { BsPlus, BsTrash, BsSearch, BsEye, BsPencil, BsExclamationTriangle } from 'react-icons/bs';
import { toast } from 'react-toastify';
import { DataTable, ConfirmModal } from '@/components/common';
import type { Column } from '@/components/common';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { allocationModelService } from '@/services/admin/v2AdminService';
import type { AllocationModel as AllocationModelType, CreateAllocationModelRequest, AllocationModelDeletionImpact } from '@/types/billing';
import AllocationModel from './AllocationModel';

export interface AllocationModelsProps {
  /** Card title */
  title?: string;
  /** Hide add button */
  hideCreate?: boolean;
  /** Hide delete button */
  hideDelete?: boolean;
  /** Read-only mode - shows View button instead of Edit */
  readOnly?: boolean;
  /** Show view mode on click */
  viewModeOnClick?: boolean;
  /** Hide specific columns */
  hideColumns?: ('capital' | 'intradayCapital' | 'positionalCapital' | 'strategies' | 'actions')[];
  /** Callback when model is clicked */
  onModelClick?: (model: AllocationModelType) => void;
}

const formatCurrency = (value: number): string => {
  if (value >= 10000000) {
    return `${(value / 10000000).toFixed(2)} Cr`;
  } else if (value >= 100000) {
    return `${(value / 100000).toFixed(2)} L`;
  } else if (value >= 1000) {
    return `${(value / 1000).toFixed(1)} K`;
  }
  return value.toString();
};

// Helper component to fetch and display strategy count for a model
const StrategyCount: React.FC<{ modelName: string }> = ({ modelName }) => {
  const { data: strategies, isLoading } = useQuery({
    queryKey: ['allocationModelStrategies', modelName],
    queryFn: () => allocationModelService.getStrategies(modelName),
    staleTime: 30000, // Cache for 30 seconds
  });

  if (isLoading) {
    return <Spinner size="sm" />;
  }

  const count = strategies?.length || 0;
  return <span className="text-ink-soft">{count} mapped</span>;
};

const AllocationModels: React.FC<AllocationModelsProps> = ({
  title = 'Allocation Models',
  hideCreate = false,
  hideDelete = false,
  readOnly = false,
  viewModeOnClick = false,
  hideColumns = [],
  onModelClick,
}) => {
  const [search, setSearch] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [selectedModel, setSelectedModel] = useState<AllocationModelType | null>(null);
  const [modalMode, setModalMode] = useState<'view' | 'edit' | 'create'>('create');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deletionImpact, setDeletionImpact] = useState<AllocationModelDeletionImpact | null>(null);
  const [loadingImpact, setLoadingImpact] = useState(false);
  const [pendingRename, setPendingRename] = useState<{ oldName: string; newName: string; data: CreateAllocationModelRequest } | null>(null);
  const queryClient = useQueryClient();

  const { data: models, isLoading, error } = useQuery({
    queryKey: ['allocationModels'],
    queryFn: () => allocationModelService.getAll(),
  });

  const createMutation = useMutation({
    mutationFn: (data: CreateAllocationModelRequest) => allocationModelService.create(data),
    onSuccess: () => {
      // Invalidate both query keys used across the app
      queryClient.invalidateQueries({ queryKey: ['allocationModels'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'allocationModels'] });
      setShowModal(false);
      toast.success('Allocation model created successfully');
    },
    onError: (error: { message?: string }) => {
      toast.error(error.message || 'Failed to create allocation model');
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ name, data }: { name: string; data: Partial<CreateAllocationModelRequest> }) =>
      allocationModelService.update(name, data),
    onSuccess: () => {
      // Invalidate both query keys used across the app
      queryClient.invalidateQueries({ queryKey: ['allocationModels'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'allocationModels'] });
      setShowModal(false);
      toast.success('Allocation model updated successfully');
    },
    onError: (error: { message?: string }) => {
      toast.error(error.message || 'Failed to update allocation model');
    },
  });

  // Rename re-points every reference atomically on the server, then persists any capital
  // edits made in the same save (keyed on the new name).
  const renameMutation = useMutation({
    mutationFn: async ({ oldName, newName, data }: { oldName: string; newName: string; data: Partial<CreateAllocationModelRequest> }) => {
      await allocationModelService.rename(oldName, newName);
      return allocationModelService.update(newName, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['allocationModels'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'allocationModels'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'allocationModelStrategies'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'strategyDaysAllocation'] });
      setShowModal(false);
      setSelectedModel(null);
      setPendingRename(null);
      toast.success('Allocation model renamed successfully');
    },
    onError: (error: { message?: string }) => {
      toast.error(error.message || 'Failed to rename allocation model');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (name: string) => allocationModelService.delete(name),
    onSuccess: () => {
      // Invalidate both query keys used across the app
      queryClient.invalidateQueries({ queryKey: ['allocationModels'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'allocationModels'] });
      // Also invalidate strategy mappings and day allocations as cascade delete affects them
      queryClient.invalidateQueries({ queryKey: ['admin', 'allocationModelStrategies'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'strategyDaysAllocation'] });
      handleDeleteCancel();
      toast.success('Allocation model deleted successfully');
    },
    onError: (error: { message?: string }) => {
      toast.error(error.message || 'Failed to delete allocation model');
    },
  });

  const filteredModels = useMemo(() => {
    if (!models) return [];
    if (!search) return models;
    const searchLower = search.toLowerCase();
    return models.filter((m) => m.name?.toLowerCase().includes(searchLower));
  }, [models, search]);

  const handleCreateClick = () => {
    setSelectedModel(null);
    setModalMode('create');
    setShowModal(true);
  };

  const handleViewClick = (model: AllocationModelType) => {
    if (onModelClick) {
      onModelClick(model);
    } else {
      setSelectedModel(model);
      setModalMode(viewModeOnClick ? 'view' : 'edit');
      setShowModal(true);
    }
  };

  const handleSave = (data: CreateAllocationModelRequest, isNew: boolean) => {
    if (isNew) {
      createMutation.mutate(data);
    } else if (selectedModel) {
      const newName = data.name?.trim();
      const isRename = !!newName && newName !== selectedModel.name;
      if (isRename) {
        // Defer to the in-app confirm modal (rendered below) — renaming re-points
        // all FK references, so we ask before committing.
        setPendingRename({ oldName: selectedModel.name, newName, data });
      } else {
        updateMutation.mutate({ name: selectedModel.name, data });
      }
    }
  };

  const handleDeleteClick = async (model: AllocationModelType) => {
    setSelectedModel(model);
    setLoadingImpact(true);
    setDeletionImpact(null);
    setShowDeleteConfirm(true);
    try {
      const impact = await allocationModelService.getDeletionImpact(model.name);
      setDeletionImpact(impact);
    } catch (error) {
      toast.error('Failed to fetch deletion impact');
    } finally {
      setLoadingImpact(false);
    }
  };

  const handleDeleteConfirm = () => {
    if (selectedModel) {
      deleteMutation.mutate(selectedModel.name);
    }
  };

  const handleDeleteCancel = () => {
    setShowDeleteConfirm(false);
    setSelectedModel(null);
    setDeletionImpact(null);
  };

  const columns: Column<AllocationModelType>[] = [
    {
      key: 'name',
      header: 'Model Name',
      render: (m) => <span className="font-medium">{m.name}</span>,
    },
    ...(hideColumns.includes('capital') ? [] : [{
      key: 'capital' as const,
      header: 'Total Capital',
      render: (m: AllocationModelType) => (
        <Badge bg="primary">{formatCurrency(m.capital)}</Badge>
      ),
    }]),
    ...(hideColumns.includes('intradayCapital') ? [] : [{
      key: 'intradayCapital' as const,
      header: 'Intraday',
      render: (m: AllocationModelType) => (
        <Badge bg="info">{formatCurrency(m.intradayCapital)}</Badge>
      ),
    }]),
    ...(hideColumns.includes('positionalCapital') ? [] : [{
      key: 'positionalCapital' as const,
      header: 'Positional',
      render: (m: AllocationModelType) => (
        <Badge bg="success">{formatCurrency(m.positionalCapital)}</Badge>
      ),
    }]),
    ...(hideColumns.includes('strategies') ? [] : [{
      key: 'strategies' as const,
      header: 'Strategies',
      render: (m: AllocationModelType) => <StrategyCount modelName={m.name} />,
    }]),
    ...(hideColumns.includes('actions') ? [] : [{
      key: 'actions' as const,
      header: 'Actions',
      render: (m: AllocationModelType) => (
        <div className="flex gap-1">
          {viewModeOnClick && (
            <Button variant="outline-secondary" size="sm" onClick={(e) => { e.stopPropagation(); handleViewClick(m); }}><BsEye /></Button>
          )}
          <Button variant="outline-primary" size="sm" onClick={(e) => { e.stopPropagation(); setSelectedModel(m); setModalMode(readOnly ? 'view' : 'edit'); setShowModal(true); }} title={readOnly ? 'View' : 'Edit'}>{readOnly ? <BsEye /> : <BsPencil />}</Button>
          {!hideDelete && (
            <Button variant="outline-danger" size="sm" onClick={(e) => { e.stopPropagation(); handleDeleteClick(m); }}><BsTrash /></Button>
          )}
        </div>
      ),
    }]),
  ];

  if (error) {
    return <Alert variant="danger">Failed to load allocation models</Alert>;
  }

  return (
    <>
      <Card>
        <Card.Header className="flex justify-between items-center">
          <h5 className="mb-0">{title}</h5>
          {!hideCreate && (
            <Button variant="primary" size="sm" onClick={handleCreateClick}>
              <BsPlus className="me-1" /> Add Model
            </Button>
          )}
        </Card.Header>
        <Card.Body>
          <Row className="mb-4">
            <Col md={6}>
              <InputGroup>
                <InputGroup.Text><BsSearch /></InputGroup.Text>
                <Form.Control
                  placeholder="Search models..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </InputGroup>
            </Col>
          </Row>
          <DataTable
            columns={columns}
            data={filteredModels}
            loading={isLoading}
            keyExtractor={(m) => m.name}
            emptyMessage="No allocation models found"
            onRowClick={onModelClick ? handleViewClick : undefined}
          />
        </Card.Body>
        <Card.Footer className="text-ink-soft text-[0.875em]">
          Total: {filteredModels.length} model(s)
        </Card.Footer>
      </Card>

      <AllocationModel
        model={selectedModel}
        show={showModal}
        onClose={() => { setShowModal(false); setSelectedModel(null); }}
        onSave={handleSave}
        isSaving={createMutation.isPending || updateMutation.isPending || renameMutation.isPending}
        mode={modalMode}
      />

      {/* Rename Confirmation (in-app modal) */}
      <ConfirmModal
        show={!!pendingRename}
        onCancel={() => setPendingRename(null)}
        onConfirm={() => { if (pendingRename) renameMutation.mutate(pendingRename); }}
        title="Rename allocation model"
        message={pendingRename ? (
          <>
            Rename <strong>{pendingRename.oldName}</strong> to <strong>{pendingRename.newName}</strong>?
            <br /><br />
            This re-points all user-broker, strategy-mapping and day-allocation references to the new name.
            The change is applied atomically on the server.
          </>
        ) : ''}
        confirmText="Rename"
        confirmVariant="primary"
        isLoading={renameMutation.isPending}
      />

      {/* Delete Confirmation Modal with Impact Warning */}
      <Modal show={showDeleteConfirm} onHide={handleDeleteCancel} size="lg">
        <Modal.Header closeButton className="bg-danger-600 text-white">
          <Modal.Title>
            <BsExclamationTriangle className="me-2" />
            Delete Allocation Model
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {loadingImpact ? (
            <div className="text-center py-6">
              <Spinner animation="border" />
              <p className="mt-2 text-ink-soft">Loading deletion impact...</p>
            </div>
          ) : deletionImpact ? (
            <>
              <Alert variant="warning">
                <strong>Warning:</strong> Deleting model <code>{selectedModel?.name}</code> will affect the following data:
              </Alert>

              {/* User-Broker Mappings */}
              <Card className="mb-4">
                <Card.Header className="py-2">
                  <strong>User-Broker Mappings</strong>
                  <Badge bg={deletionImpact.userBrokersCount > 0 ? 'warning' : 'secondary'} className="ms-2">
                    {deletionImpact.userBrokersCount}
                  </Badge>
                </Card.Header>
                {deletionImpact.userBrokersCount > 0 && (
                  <Card.Body className="py-2">
                    <small className="text-ink-soft">
                      Allocation model will be cleared (set to null) for these user-broker combinations:
                    </small>
                    <ListGroup variant="flush" className="mt-2" style={{ maxHeight: '120px', overflowY: 'auto' }}>
                      {deletionImpact.affectedUserBrokers.map((ub) => (
                        <ListGroup.Item key={ub} className="py-1 px-2">
                          <small><code>{ub}</code></small>
                        </ListGroup.Item>
                      ))}
                    </ListGroup>
                  </Card.Body>
                )}
              </Card>

              {/* Strategy Mappings */}
              <Card className="mb-4">
                <Card.Header className="py-2">
                  <strong>Strategy Mappings</strong>
                  <Badge bg={deletionImpact.strategyMappingsCount > 0 ? 'danger' : 'secondary'} className="ms-2">
                    {deletionImpact.strategyMappingsCount}
                  </Badge>
                </Card.Header>
                {deletionImpact.strategyMappingsCount > 0 && (
                  <Card.Body className="py-2">
                    <small className="text-danger-600 dark:text-danger-400">
                      These strategy mappings will be <strong>permanently deleted</strong>:
                    </small>
                    <ListGroup variant="flush" className="mt-2" style={{ maxHeight: '120px', overflowY: 'auto' }}>
                      {deletionImpact.affectedStrategies.map((s) => (
                        <ListGroup.Item key={s} className="py-1 px-2">
                          <small><code>{s}</code></small>
                        </ListGroup.Item>
                      ))}
                    </ListGroup>
                  </Card.Body>
                )}
              </Card>

              {/* Day-wise Allocation Configs */}
              <Card className="mb-4">
                <Card.Header className="py-2">
                  <strong>Day-wise Allocation Configs</strong>
                  <Badge bg={deletionImpact.dayAllocationConfigsCount > 0 ? 'danger' : 'secondary'} className="ms-2">
                    {deletionImpact.dayAllocationConfigsCount}
                  </Badge>
                </Card.Header>
                {deletionImpact.dayAllocationConfigsCount > 0 && (
                  <Card.Body className="py-2">
                    <small className="text-danger-600 dark:text-danger-400">
                      {deletionImpact.dayAllocationConfigsCount} day-wise allocation config(s) will be <strong>permanently deleted</strong>.
                    </small>
                  </Card.Body>
                )}
              </Card>

              <Alert variant="danger" className="mb-0">
                <strong>This action cannot be undone.</strong> Are you sure you want to proceed?
              </Alert>
            </>
          ) : (
            <Alert variant="danger">Failed to load deletion impact. Please try again.</Alert>
          )}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={handleDeleteCancel} disabled={deleteMutation.isPending}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={handleDeleteConfirm}
            disabled={deleteMutation.isPending || loadingImpact || !deletionImpact}
          >
            {deleteMutation.isPending ? (
              <>
                <Spinner size="sm" className="me-1" />
                Deleting...
              </>
            ) : (
              'Delete Model'
            )}
          </Button>
        </Modal.Footer>
      </Modal>
    </>
  );
};

export default AllocationModels;
