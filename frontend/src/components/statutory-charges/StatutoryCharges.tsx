/**
 * StatutoryCharges Component
 * Table for listing and managing statutory/exchange charges
 * Reusable across Admin portals
 */

import { useState, useMemo } from 'react';
import { Card, Button, Badge, Form, Row, Col, InputGroup, Alert } from '@/components/ui/rbShim';
import { BsPlus, BsTrash, BsSearch, BsPencil } from 'react-icons/bs';
import { toast } from 'react-toastify';
import { DataTable, ConfirmModal } from '@/components/common';
import type { Column } from '@/components/common';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { statutoryChargesService } from '@/services/admin/v2AdminService';
import type { StatutoryCharges as StatutoryChargesType, CreateStatutoryChargesRequest } from '@/types/billing';
import StatutoryCharge from './StatutoryCharge';

export interface StatutoryChargesProps {
  title?: string;
  hideCreate?: boolean;
  hideDelete?: boolean;
  readOnly?: boolean;
}

const StatutoryCharges: React.FC<StatutoryChargesProps> = ({
  title = 'Statutory Charges',
  hideCreate = false,
  hideDelete = false,
  readOnly = false,
}) => {
  const [search, setSearch] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [selectedCharge, setSelectedCharge] = useState<StatutoryChargesType | null>(null);
  const [modalMode, setModalMode] = useState<'view' | 'edit' | 'create'>('create');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const queryClient = useQueryClient();

  const { data: charges, isLoading, error } = useQuery({
    queryKey: ['statutoryCharges'],
    queryFn: () => statutoryChargesService.getAll(),
  });

  const createMutation = useMutation({
    mutationFn: (data: CreateStatutoryChargesRequest) => statutoryChargesService.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['statutoryCharges'] });
      setShowModal(false);
      toast.success('Statutory charges created successfully');
    },
    onError: (error: { message?: string }) => {
      toast.error(error.message || 'Failed to create statutory charges');
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ exchange, segment, product, data }: {
      exchange: string; segment: string; product: string; data: Partial<CreateStatutoryChargesRequest>;
    }) => statutoryChargesService.update(exchange, segment, product, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['statutoryCharges'] });
      setShowModal(false);
      toast.success('Statutory charges updated successfully');
    },
    onError: (error: { message?: string }) => {
      toast.error(error.message || 'Failed to update statutory charges');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: ({ exchange, segment, product }: { exchange: string; segment: string; product: string }) =>
      statutoryChargesService.delete(exchange, segment, product),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['statutoryCharges'] });
      setShowDeleteConfirm(false);
      setSelectedCharge(null);
      toast.success('Statutory charges deleted successfully');
    },
    onError: (error: { message?: string }) => {
      toast.error(error.message || 'Failed to delete statutory charges');
    },
  });

  const filteredCharges = useMemo(() => {
    if (!charges) return [];
    if (!search) return charges;
    const searchLower = search.toLowerCase();
    return charges.filter(
      (c) =>
        c.exchange?.toLowerCase().includes(searchLower) ||
        c.segment?.toLowerCase().includes(searchLower) ||
        c.product?.toLowerCase().includes(searchLower)
    );
  }, [charges, search]);

  const handleCreateClick = () => {
    setSelectedCharge(null);
    setModalMode('create');
    setShowModal(true);
  };

  const handleEditClick = (charge: StatutoryChargesType) => {
    setSelectedCharge(charge);
    setModalMode(readOnly ? 'view' : 'edit');
    setShowModal(true);
  };

  const handleSave = (data: CreateStatutoryChargesRequest, isNew: boolean) => {
    if (isNew) {
      createMutation.mutate(data);
    } else if (selectedCharge) {
      updateMutation.mutate({
        exchange: selectedCharge.exchange,
        segment: selectedCharge.segment,
        product: selectedCharge.product,
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

  const formatPct = (val: number) => val === 0 ? '-' : val.toString();

  const columns: Column<StatutoryChargesType>[] = [
    {
      key: 'exchange',
      header: 'Exchange',
      render: (c) => <code className="font-medium">{c.exchange}</code>,
    },
    {
      key: 'segment',
      header: 'Segment',
      render: (c) => getSegmentBadge(c.segment),
    },
    {
      key: 'product',
      header: 'Product',
      render: (c) => (
        <Badge bg={c.product === 'DELIVERY' ? 'success' : 'secondary'}>
          {c.product}
        </Badge>
      ),
    },
    {
      key: 'stt',
      header: 'STT (Buy/Sell)',
      render: (c) => <small>{formatPct(c.sttBuyPct)} / {formatPct(c.sttSellPct)}</small>,
    },
    {
      key: 'txn',
      header: 'Exchange Txn%',
      render: (c) => <small>{formatPct(c.exchangeTxnPct)}</small>,
    },
    {
      key: 'sebi',
      header: 'SEBI%',
      render: (c) => <small>{formatPct(c.sebiChargesPct)}</small>,
    },
    {
      key: 'stamp',
      header: 'Stamp (Buy/Sell)',
      render: (c) => <small>{formatPct(c.stampDutyBuyPct)} / {formatPct(c.stampDutySellPct)}</small>,
    },
    {
      key: 'gst',
      header: 'GST%',
      render: (c) => <small>{c.gstPct}</small>,
    },
    {
      key: 'dp',
      header: 'DP (Rs)',
      render: (c) => <small>{c.depositoryCharges > 0 ? `₹${c.depositoryCharges}` : '-'}</small>,
    },
    {
      key: 'actions',
      header: 'Actions',
      render: (c) => (
        <div className="flex gap-1">
          <Button
            variant="outline-primary"
            size="sm"
            onClick={(e) => { e.stopPropagation(); handleEditClick(c); }}
            title={readOnly ? 'View' : 'Edit'}
          >
            <BsPencil />
          </Button>
          {!hideDelete && !readOnly && (
            <Button
              variant="outline-danger"
              size="sm"
              onClick={(e) => { e.stopPropagation(); setSelectedCharge(c); setShowDeleteConfirm(true); }}
            >
              <BsTrash />
            </Button>
          )}
        </div>
      ),
    },
  ];

  if (error) {
    return <Alert variant="danger">Failed to load statutory charges</Alert>;
  }

  return (
    <>
      <Card>
        <Card.Header className="flex justify-between items-center">
          <h5 className="mb-0">{title}</h5>
          {!hideCreate && !readOnly && (
            <Button variant="primary" size="sm" onClick={handleCreateClick}>
              <BsPlus className="me-1" /> Add Charges
            </Button>
          )}
        </Card.Header>
        <Card.Body>
          <Row className="mb-4">
            <Col md={6}>
              <InputGroup>
                <InputGroup.Text><BsSearch /></InputGroup.Text>
                <Form.Control
                  placeholder="Search by exchange, segment, product..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </InputGroup>
            </Col>
          </Row>
          <DataTable
            columns={columns}
            data={filteredCharges}
            loading={isLoading}
            keyExtractor={(c) => `${c.exchange}-${c.segment}-${c.product}`}
            emptyMessage="No statutory charges configured"
          />
        </Card.Body>
        <Card.Footer className="text-ink-soft text-[0.875em]">
          Total: {filteredCharges.length} entry(s)
        </Card.Footer>
      </Card>

      <StatutoryCharge
        charge={selectedCharge}
        show={showModal}
        onClose={() => { setShowModal(false); setSelectedCharge(null); }}
        onSave={handleSave}
        isSaving={createMutation.isPending || updateMutation.isPending}
        mode={modalMode}
      />

      <ConfirmModal
        show={showDeleteConfirm}
        title="Delete Statutory Charges"
        message={`Are you sure you want to delete charges for "${selectedCharge?.exchange}/${selectedCharge?.segment}/${selectedCharge?.product}"?`}
        confirmLabel="Delete"
        confirmVariant="danger"
        onConfirm={() => selectedCharge && deleteMutation.mutate({
          exchange: selectedCharge.exchange,
          segment: selectedCharge.segment,
          product: selectedCharge.product,
        })}
        onCancel={() => { setShowDeleteConfirm(false); setSelectedCharge(null); }}
        isLoading={deleteMutation.isPending}
      />
    </>
  );
};

export default StatutoryCharges;
