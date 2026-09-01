/**
 * BillingPlans Component
 * Table for listing billing plans
 * Reusable across Admin portals
 */

import { useState, useMemo } from 'react';
import { Card, Button, Badge, Form, Row, Col, InputGroup, Alert } from '@/components/ui/rbShim';
import { BsPlus, BsTrash, BsSearch, BsToggleOn, BsToggleOff, BsEye, BsPencil } from 'react-icons/bs';
import { toast } from 'react-toastify';
import { DataTable, ConfirmModal } from '@/components/common';
import type { Column } from '@/components/common';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { billingPlanService } from '@/services/admin/v2AdminService';
import type { BillingPlan as BillingPlanType, CreateBillingPlanRequest } from '@/types/billing';
import BillingPlan from './BillingPlan';

export interface BillingPlansProps {
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
  hideColumns?: ('billingPeriod' | 'profitSharing' | 'fixedCost' | 'status' | 'actions')[];
  /** Callback when plan is clicked */
  onPlanClick?: (plan: BillingPlanType) => void;
}

const BillingPlans: React.FC<BillingPlansProps> = ({
  title = 'Billing Plans',
  hideCreate = false,
  hideDelete = false,
  hideEnableDisable = false,
  readOnly = false,
  viewModeOnClick = false,
  hideColumns = [],
  onPlanClick,
}) => {
  const [search, setSearch] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [selectedPlan, setSelectedPlan] = useState<BillingPlanType | null>(null);
  const [modalMode, setModalMode] = useState<'view' | 'edit' | 'create'>('create');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const queryClient = useQueryClient();

  const { data: plans, isLoading, error } = useQuery({
    queryKey: ['billingPlans'],
    queryFn: () => billingPlanService.getAll(),
  });

  const createMutation = useMutation({
    mutationFn: (data: CreateBillingPlanRequest) => billingPlanService.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['billingPlans'] });
      setShowModal(false);
      toast.success('Billing plan created successfully');
    },
    onError: (error: { message?: string }) => {
      toast.error(error.message || 'Failed to create billing plan');
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ planName, data }: { planName: string; data: Partial<CreateBillingPlanRequest> }) =>
      billingPlanService.update(planName, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['billingPlans'] });
      setShowModal(false);
      toast.success('Billing plan updated successfully');
    },
    onError: (error: { message?: string }) => {
      toast.error(error.message || 'Failed to update billing plan');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (planName: string) => billingPlanService.delete(planName),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['billingPlans'] });
      setShowDeleteConfirm(false);
      setSelectedPlan(null);
      toast.success('Billing plan deleted successfully');
    },
    onError: (error: { message?: string }) => {
      toast.error(error.message || 'Failed to delete billing plan');
    },
  });

  const toggleEnabledMutation = useMutation({
    mutationFn: ({ planName, enabled }: { planName: string; enabled: boolean }) =>
      billingPlanService.update(planName, { enabled }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['billingPlans'] });
      toast.success(`Billing plan ${variables.enabled ? 'enabled' : 'disabled'} successfully`);
    },
    onError: (error: { message?: string }) => {
      toast.error(error.message || 'Failed to update billing plan status');
    },
  });

  const filteredPlans = useMemo(() => {
    if (!plans) return [];
    if (!search) return plans;
    const searchLower = search.toLowerCase();
    return plans.filter(
      (p) =>
        p.planName?.toLowerCase().includes(searchLower) ||
        p.displayName?.toLowerCase().includes(searchLower) ||
        p.description?.toLowerCase().includes(searchLower)
    );
  }, [plans, search]);

  const handleCreateClick = () => {
    setSelectedPlan(null);
    setModalMode('create');
    setShowModal(true);
  };

  const handleViewClick = (plan: BillingPlanType) => {
    if (onPlanClick) {
      onPlanClick(plan);
    } else {
      setSelectedPlan(plan);
      setModalMode(viewModeOnClick ? 'view' : 'edit');
      setShowModal(true);
    }
  };

  const handleToggle = (plan: BillingPlanType) => {
    toggleEnabledMutation.mutate({ planName: plan.planName, enabled: !(plan.enabled !== false) });
  };

  const handleSave = (data: CreateBillingPlanRequest, isNew: boolean) => {
    if (isNew) {
      createMutation.mutate(data);
    } else if (selectedPlan) {
      updateMutation.mutate({ planName: selectedPlan.planName, data });
    }
  };

  const columns: Column<BillingPlanType>[] = [
    {
      key: 'plan',
      header: 'Plan',
      render: (p) => (
        <div>
          <div className="font-medium">
            {p.displayName || p.planName}
          </div>
          <small className="text-ink-soft"><code>{p.planName}</code></small>
        </div>
      ),
    },
    ...(hideColumns.includes('billingPeriod') ? [] : [{
      key: 'billingPeriod' as const,
      header: 'Billing Period',
      render: (p: BillingPlanType) => (
        <span className="font-medium">{p.billingPeriodDays} days</span>
      ),
    }]),
    ...(hideColumns.includes('profitSharing') ? [] : [{
      key: 'profitSharing' as const,
      header: 'Profit Sharing',
      render: (p: BillingPlanType) => (
        <span className="font-medium">{p.profitSharingPercentage}%</span>
      ),
    }]),
    ...(hideColumns.includes('fixedCost') ? [] : [{
      key: 'fixedCost' as const,
      header: 'Fixed Cost',
      render: (p: BillingPlanType) => (
        <span>{p.fixedCostPercentage}%</span>
      ),
    }]),
    ...(hideColumns.includes('status') ? [] : [{
      key: 'status' as const,
      header: 'Status',
      render: (p: BillingPlanType) => (
        <Badge bg={p.enabled !== false ? 'success' : 'secondary'}>
          {p.enabled !== false ? 'Enabled' : 'Disabled'}
        </Badge>
      ),
    }]),
    ...(hideColumns.includes('actions') ? [] : [{
      key: 'actions' as const,
      header: 'Actions',
      render: (p: BillingPlanType) => (
        <div className="flex gap-1">
          {viewModeOnClick && (
            <Button variant="outline-secondary" size="sm" onClick={(e) => { e.stopPropagation(); handleViewClick(p); }}><BsEye /></Button>
          )}
          <Button variant="outline-primary" size="sm" onClick={(e) => { e.stopPropagation(); setSelectedPlan(p); setModalMode(readOnly ? 'view' : 'edit'); setShowModal(true); }} title={readOnly ? 'View' : 'Edit'}>{readOnly ? <BsEye /> : <BsPencil />}</Button>
          {!hideEnableDisable && !readOnly && (
            (p.enabled !== false) ? (
              <Button
                variant="outline-warning"
                size="sm"
                onClick={(e) => { e.stopPropagation(); handleToggle(p); }}
                disabled={toggleEnabledMutation.isPending}
                title="Disable Plan"
              >
                <BsToggleOff />
              </Button>
            ) : (
              <Button
                variant="outline-success"
                size="sm"
                onClick={(e) => { e.stopPropagation(); handleToggle(p); }}
                disabled={toggleEnabledMutation.isPending}
                title="Enable Plan"
              >
                <BsToggleOn />
              </Button>
            )
          )}
          {!hideDelete && (
            <Button variant="outline-danger" size="sm" onClick={(e) => { e.stopPropagation(); setSelectedPlan(p); setShowDeleteConfirm(true); }}><BsTrash /></Button>
          )}
        </div>
      ),
    }]),
  ];

  if (error) {
    return <Alert variant="danger">Failed to load billing plans</Alert>;
  }

  return (
    <>
      <Card>
        <Card.Header className="flex justify-between items-center">
          <h5 className="mb-0">{title}</h5>
          {!hideCreate && (
            <Button variant="primary" size="sm" onClick={handleCreateClick}>
              <BsPlus className="me-1" /> Add Plan
            </Button>
          )}
        </Card.Header>
        <Card.Body>
          <Row className="mb-4">
            <Col md={6}>
              <InputGroup>
                <InputGroup.Text><BsSearch /></InputGroup.Text>
                <Form.Control
                  placeholder="Search plans..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </InputGroup>
            </Col>
          </Row>
          <DataTable
            columns={columns}
            data={filteredPlans}
            loading={isLoading}
            keyExtractor={(p) => p.planName}
            emptyMessage="No billing plans found"
            onRowClick={onPlanClick ? handleViewClick : undefined}
          />
        </Card.Body>
        <Card.Footer className="text-ink-soft text-[0.875em]">
          Total: {filteredPlans.length} plan(s)
        </Card.Footer>
      </Card>

      <BillingPlan
        plan={selectedPlan}
        show={showModal}
        onClose={() => { setShowModal(false); setSelectedPlan(null); }}
        onSave={handleSave}
        isSaving={createMutation.isPending || updateMutation.isPending}
        mode={modalMode}
      />

      <ConfirmModal
        show={showDeleteConfirm}
        title="Delete Billing Plan"
        message={`Are you sure you want to delete plan "${selectedPlan?.displayName || selectedPlan?.planName}"?`}
        confirmLabel="Delete"
        confirmVariant="danger"
        onConfirm={() => selectedPlan && deleteMutation.mutate(selectedPlan.planName)}
        onCancel={() => { setShowDeleteConfirm(false); setSelectedPlan(null); }}
        isLoading={deleteMutation.isPending}
      />
    </>
  );
};

export default BillingPlans;
