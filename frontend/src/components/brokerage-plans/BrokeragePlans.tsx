/**
 * BrokeragePlans Component
 * Table for listing brokerage plans with rates view for selected plan.
 */

import { useState, useMemo, useEffect, useRef } from 'react';
import { Card, Button, Form, Row, Col, InputGroup, Alert } from '@/components/ui/rbShim';
import { BsPlus, BsTrash, BsSearch, BsPencil, BsListNested } from 'react-icons/bs';
import { toast } from 'react-toastify';
import { DataTable, ConfirmModal } from '@/components/common';
import type { Column } from '@/components/common';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { brokeragePlanService } from '@/services/admin/v2AdminService';
import type { BrokeragePlan as BrokeragePlanType, CreateBrokeragePlanRequest } from '@/types/billing';
import BrokeragePlan from './BrokeragePlan';
import BrokeragePlanRates from './BrokeragePlanRates';

export interface BrokeragePlansProps {
  title?: string;
  hideCreate?: boolean;
  hideDelete?: boolean;
  readOnly?: boolean;
  viewModeOnClick?: boolean;
  onPlanClick?: (plan: BrokeragePlanType) => void;
  /** When set, pre-select + expand this plan on first load (deep link ?plan=). */
  initialPlan?: string;
}

const BrokeragePlans: React.FC<BrokeragePlansProps> = ({
  title = 'Brokerage Plans',
  hideCreate = false,
  hideDelete = false,
  readOnly = false,
  onPlanClick,
  initialPlan,
}) => {
  const [search, setSearch] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [selectedPlan, setSelectedPlan] = useState<BrokeragePlanType | null>(null);
  const [modalMode, setModalMode] = useState<'view' | 'edit' | 'create'>('create');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [expandedPlan, setExpandedPlan] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const { data: plans, isLoading, error } = useQuery({
    queryKey: ['brokeragePlans'],
    queryFn: () => brokeragePlanService.getAll(),
  });

  // Deep link (?plan=<name>): filter to and expand that plan once, after load.
  const appliedInitialPlan = useRef(false);
  useEffect(() => {
    if (appliedInitialPlan.current || !initialPlan || !plans) return;
    if (plans.some((p) => p.planName === initialPlan)) {
      setSearch(initialPlan);
      setExpandedPlan(initialPlan);
      appliedInitialPlan.current = true;
    }
  }, [initialPlan, plans]);

  const createMutation = useMutation({
    mutationFn: (data: CreateBrokeragePlanRequest) => brokeragePlanService.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['brokeragePlans'] });
      setShowModal(false);
      toast.success('Brokerage plan created successfully');
    },
    onError: (error: { message?: string }) => {
      toast.error(error.message || 'Failed to create brokerage plan');
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ planName, data }: { planName: string; data: Partial<CreateBrokeragePlanRequest> }) =>
      brokeragePlanService.update(planName, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['brokeragePlans'] });
      setShowModal(false);
      toast.success('Brokerage plan updated successfully');
    },
    onError: (error: { message?: string }) => {
      toast.error(error.message || 'Failed to update brokerage plan');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (planName: string) => brokeragePlanService.delete(planName),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['brokeragePlans'] });
      setShowDeleteConfirm(false);
      setSelectedPlan(null);
      if (expandedPlan === selectedPlan?.planName) setExpandedPlan(null);
      toast.success('Brokerage plan deleted successfully');
    },
    onError: (error: { message?: string }) => {
      toast.error(error.message || 'Failed to delete brokerage plan');
    },
  });

  const filteredPlans = useMemo(() => {
    if (!plans) return [];
    if (!search) return plans;
    const searchLower = search.toLowerCase();
    return plans.filter(
      (p) =>
        p.planName?.toLowerCase().includes(searchLower) ||
        p.brokerName?.toLowerCase().includes(searchLower) ||
        p.description?.toLowerCase().includes(searchLower)
    );
  }, [plans, search]);

  const handleCreateClick = () => {
    setSelectedPlan(null);
    setModalMode('create');
    setShowModal(true);
  };

  const handleSave = (data: CreateBrokeragePlanRequest, isNew: boolean) => {
    if (isNew) {
      createMutation.mutate(data);
    } else if (selectedPlan) {
      updateMutation.mutate({ planName: selectedPlan.planName, data });
    }
  };

  const columns: Column<BrokeragePlanType>[] = [
    {
      key: 'planName',
      header: 'Plan Name',
      render: (p) => (
        <div className="flex items-center gap-2">
          <code className="font-medium">{p.planName}</code>
          {expandedPlan === p.planName && (
            <small className="text-primary-700 dark:text-primary-400">(rates shown below)</small>
          )}
        </div>
      ),
    },
    {
      key: 'brokerName',
      header: 'Broker',
      render: (p) => {
        const isDefault = !p.brokerName || p.brokerName === 'default';
        return (
          <span className={`inline-block rounded-md px-[.55em] py-[.35em] text-center text-[.75em] font-semibold leading-none whitespace-nowrap text-white bg-ink-soft ${isDefault ? 'bg-ink-soft' : 'bg-primary-500'}`}>
            {p.brokerName || 'default'}
          </span>
        );
      },
    },
    {
      key: 'planType',
      header: 'Type',
      render: (p) => (
        <span>
          {p.planType === 'FIXED_PERIOD' ? (
            <span className="inline-block rounded-md px-[.55em] py-[.35em] text-center text-[.75em] font-semibold leading-none whitespace-nowrap text-white bg-accent-500">Fixed {p.billingPeriod?.toLowerCase()} - {p.fixedFee?.toLocaleString('en-IN')}</span>
          ) : (
            <span className="inline-block rounded-md px-[.55em] py-[.35em] text-center text-[.75em] font-semibold leading-none whitespace-nowrap text-white bg-ink-soft">Per Trade</span>
          )}
        </span>
      ),
    },
    {
      key: 'description',
      header: 'Description',
      render: (p) => (
        <small className="text-ink-soft">{p.description || '-'}</small>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      render: (p) => (
        <div className="flex gap-1">
          <Button
            variant={expandedPlan === p.planName ? 'primary' : 'outline-secondary'}
            size="sm"
            onClick={(e) => {
              e.stopPropagation();
              setExpandedPlan(expandedPlan === p.planName ? null : p.planName);
            }}
            title="View Rates"
          >
            <BsListNested />
          </Button>
          <Button
            variant="outline-primary"
            size="sm"
            onClick={(e) => {
              e.stopPropagation();
              setSelectedPlan(p);
              setModalMode(readOnly ? 'view' : 'edit');
              setShowModal(true);
            }}
            title={readOnly ? 'View' : 'Edit'}
          >
            <BsPencil />
          </Button>
          {!hideDelete && !readOnly && (
            <Button
              variant="outline-danger"
              size="sm"
              onClick={(e) => { e.stopPropagation(); setSelectedPlan(p); setShowDeleteConfirm(true); }}
            >
              <BsTrash />
            </Button>
          )}
        </div>
      ),
    },
  ];

  if (error) {
    return <Alert variant="danger">Failed to load brokerage plans</Alert>;
  }

  return (
    <>
      <Card>
        <Card.Header className="flex justify-between items-center">
          <h5 className="mb-0">{title}</h5>
          {!hideCreate && !readOnly && (
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
            emptyMessage="No brokerage plans found"
            onRowClick={onPlanClick || ((p) => setExpandedPlan(expandedPlan === p.planName ? null : p.planName))}
          />
        </Card.Body>
        <Card.Footer className="text-ink-soft text-[0.875em]">
          Total: {filteredPlans.length} plan(s)
        </Card.Footer>
      </Card>

      {expandedPlan && (() => {
        const plan = plans?.find((p) => p.planName === expandedPlan);
        if (plan?.planType === 'FIXED_PERIOD') {
          return (
            <Alert variant="info" className="mt-4">
              <strong>{expandedPlan}</strong> is a fixed-period plan ({plan.billingPeriod?.toLowerCase()} fee of {plan.fixedFee?.toLocaleString('en-IN')}). Individual trade brokerage rates are not applicable.
            </Alert>
          );
        }
        return <BrokeragePlanRates planName={expandedPlan} readOnly={readOnly} />;
      })()}

      <BrokeragePlan
        plan={selectedPlan}
        show={showModal}
        onClose={() => { setShowModal(false); setSelectedPlan(null); }}
        onSave={handleSave}
        isSaving={createMutation.isPending || updateMutation.isPending}
        mode={modalMode}
      />

      <ConfirmModal
        show={showDeleteConfirm}
        title="Delete Brokerage Plan"
        message={`Are you sure you want to delete plan "${selectedPlan?.planName}"? This will also delete all associated rates.`}
        confirmLabel="Delete"
        confirmVariant="danger"
        onConfirm={() => selectedPlan && deleteMutation.mutate(selectedPlan.planName)}
        onCancel={() => { setShowDeleteConfirm(false); setSelectedPlan(null); }}
        isLoading={deleteMutation.isPending}
      />
    </>
  );
};

export default BrokeragePlans;
