/**
 * BrokeragePlanRates Component
 * Displays and manages rates (per segment+product) for a specific brokerage plan.
 */

import { useState } from 'react';
import { Card, Button, Badge, Alert } from '@/components/ui/rbShim';
import { BsPlus, BsTrash, BsPencil, BsEye } from 'react-icons/bs';
import { toast } from 'react-toastify';
import { DataTable, ConfirmModal } from '@/components/common';
import type { Column } from '@/components/common';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { brokeragePlanRateService } from '@/services/admin/v2AdminService';
import type { BrokeragePlanRate, CreateBrokeragePlanRateRequest } from '@/types/billing';
import BrokeragePlanRateModal from './BrokeragePlanRateModal';

export interface BrokeragePlanRatesProps {
  planName: string;
  readOnly?: boolean;
}

const BrokeragePlanRates: React.FC<BrokeragePlanRatesProps> = ({
  planName,
  readOnly = false,
}) => {
  const [showModal, setShowModal] = useState(false);
  const [selectedRate, setSelectedRate] = useState<BrokeragePlanRate | null>(null);
  const [modalMode, setModalMode] = useState<'view' | 'edit' | 'create'>('create');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const queryClient = useQueryClient();

  const { data: rates, isLoading, error } = useQuery({
    queryKey: ['brokeragePlanRates', planName],
    queryFn: () => brokeragePlanRateService.getByPlan(planName),
  });

  const createMutation = useMutation({
    mutationFn: (data: CreateBrokeragePlanRateRequest) => brokeragePlanRateService.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['brokeragePlanRates', planName] });
      setShowModal(false);
      toast.success('Rate added successfully');
    },
    onError: (error: { message?: string }) => {
      toast.error(error.message || 'Failed to add rate');
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ segment, product, data }: {
      segment: string; product: string; data: Partial<CreateBrokeragePlanRateRequest>;
    }) => brokeragePlanRateService.update(planName, segment, product, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['brokeragePlanRates', planName] });
      setShowModal(false);
      toast.success('Rate updated successfully');
    },
    onError: (error: { message?: string }) => {
      toast.error(error.message || 'Failed to update rate');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: ({ segment, product }: { segment: string; product: string }) =>
      brokeragePlanRateService.delete(planName, segment, product),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['brokeragePlanRates', planName] });
      setShowDeleteConfirm(false);
      setSelectedRate(null);
      toast.success('Rate deleted successfully');
    },
    onError: (error: { message?: string }) => {
      toast.error(error.message || 'Failed to delete rate');
    },
  });

  const handleSave = (data: CreateBrokeragePlanRateRequest, isNew: boolean) => {
    if (isNew) {
      createMutation.mutate({ ...data, planName });
    } else if (selectedRate) {
      updateMutation.mutate({
        segment: selectedRate.segment,
        product: selectedRate.product,
        data,
      });
    }
  };

  const getSegmentBadge = (segment: string) => {
    switch (segment) {
      case 'EQUITY': return <Badge bg="primary">{segment}</Badge>;
      case 'FUTURES': return <Badge bg="warning" text="dark">{segment}</Badge>;
      case 'OPTIONS': return <Badge bg="info">{segment}</Badge>;
      default: return <Badge bg="secondary">{segment}</Badge>;
    }
  };

  const getBrokerageDisplay = (rate: BrokeragePlanRate) => {
    if (rate.brokeragePct > 0) {
      return `min(${rate.brokeragePct}%, ₹${rate.ratePerUnit})`;
    }
    if (rate.ratePerUnit > 0) {
      return `₹${rate.ratePerUnit}/${rate.unitType}`;
    }
    return 'Zero';
  };

  const columns: Column<BrokeragePlanRate>[] = [
    {
      key: 'segment',
      header: 'Segment',
      render: (r) => getSegmentBadge(r.segment),
    },
    {
      key: 'product',
      header: 'Product',
      render: (r) => (
        <Badge bg={r.product === 'DELIVERY' ? 'success' : 'secondary'}>
          {r.product}
        </Badge>
      ),
    },
    {
      key: 'unitType',
      header: 'Unit Type',
      render: (r) => (
        <Badge bg={r.unitType === 'lot' ? 'info' : 'primary'}>
          Per {r.unitType?.toUpperCase()}
        </Badge>
      ),
    },
    {
      key: 'ratePerUnit',
      header: 'Rate Per Unit',
      render: (r) => <span className="font-medium">₹{r.ratePerUnit}</span>,
    },
    {
      key: 'brokeragePct',
      header: 'Brokerage %',
      render: (r) => <span>{r.brokeragePct > 0 ? `${r.brokeragePct}%` : '-'}</span>,
    },
    {
      key: 'effective',
      header: 'Effective',
      render: (r) => <small className="text-ink-soft">{getBrokerageDisplay(r)}</small>,
    },
    {
      key: 'actions',
      header: 'Actions',
      render: (r) => (
        <div className="flex gap-1">
          <Button
            variant="outline-primary"
            size="sm"
            onClick={(e) => {
              e.stopPropagation();
              setSelectedRate(r);
              setModalMode(readOnly ? 'view' : 'edit');
              setShowModal(true);
            }}
            title={readOnly ? 'View' : 'Edit'}
          >
            {readOnly ? <BsEye /> : <BsPencil />}
          </Button>
          {!readOnly && (
            <Button
              variant="outline-danger"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                setSelectedRate(r);
                setShowDeleteConfirm(true);
              }}
            >
              <BsTrash />
            </Button>
          )}
        </div>
      ),
    },
  ];

  if (error) {
    return <Alert variant="danger">Failed to load rates for {planName}</Alert>;
  }

  return (
    <>
      <Card className="mt-4">
        <Card.Header className="flex justify-between items-center py-2">
          <h6 className="mb-0">Rates for <code>{planName}</code></h6>
          {!readOnly && (
            <Button
              variant="outline-primary"
              size="sm"
              onClick={() => {
                setSelectedRate(null);
                setModalMode('create');
                setShowModal(true);
              }}
            >
              <BsPlus className="me-1" /> Add Rate
            </Button>
          )}
        </Card.Header>
        <Card.Body className="p-0">
          <DataTable
            columns={columns}
            data={rates || []}
            loading={isLoading}
            keyExtractor={(r) => `${r.planName}-${r.segment}-${r.product}`}
            emptyMessage="No rates configured for this plan"
          />
        </Card.Body>
      </Card>

      <BrokeragePlanRateModal
        rate={selectedRate}
        planName={planName}
        show={showModal}
        onClose={() => { setShowModal(false); setSelectedRate(null); }}
        onSave={handleSave}
        isSaving={createMutation.isPending || updateMutation.isPending}
        mode={modalMode}
      />

      <ConfirmModal
        show={showDeleteConfirm}
        title="Delete Rate"
        message={`Are you sure you want to delete the rate for "${selectedRate?.segment}/${selectedRate?.product}"?`}
        confirmLabel="Delete"
        confirmVariant="danger"
        onConfirm={() => selectedRate && deleteMutation.mutate({
          segment: selectedRate.segment,
          product: selectedRate.product,
        })}
        onCancel={() => { setShowDeleteConfirm(false); setSelectedRate(null); }}
        isLoading={deleteMutation.isPending}
      />
    </>
  );
};

export default BrokeragePlanRates;
