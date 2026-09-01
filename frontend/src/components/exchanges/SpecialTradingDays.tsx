/**
 * SpecialTradingDays Component
 * Distributed: read-only, synced from Market Data Service
 * Standalone: directly managed with add/edit/delete
 * Uses V2 API: /api/v2/special-trading-days
 */

import { useState, useMemo } from 'react';
import { Card, Alert, Form, Row, Col, Badge, Button, Modal, Spinner } from '@/components/ui/rbShim';
import { BsCalendarCheck, BsPlus, BsPencil, BsTrash } from 'react-icons/bs';
import { DataTable } from '@/components/common';
import type { Column } from '@/components/common';
import ConfirmModal from '@/components/common/ConfirmModal';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { specialTradingDayService, exchangeService } from '@/services/admin/v2AdminService';
import { toast } from 'react-toastify';
import type { SpecialTradingDay } from '@/services/admin/v2AdminService';

export interface SpecialTradingDaysProps {
  /** Card title */
  title?: string;
  /** Allow add/edit/delete operations */
  canEdit?: boolean;
}

const currentYear = new Date().getFullYear();

const SpecialTradingDays: React.FC<SpecialTradingDaysProps> = ({
  title = 'Special Trading Days',
  canEdit = false,
}) => {
  const [selectedExchange, setSelectedExchange] = useState<string>('ALL');
  const [selectedYear, setSelectedYear] = useState<number>(currentYear);
  const queryClient = useQueryClient();

  // Add/edit modal state
  const [showModal, setShowModal] = useState(false);
  const [editingDay, setEditingDay] = useState<SpecialTradingDay | null>(null);
  const [formData, setFormData] = useState({ exchange: '', tradingDate: '', tradingDayName: '', marketOpen: '', marketClose: '' });

  // Delete confirm state
  const [deleteTarget, setDeleteTarget] = useState<SpecialTradingDay | null>(null);

  // Fetch exchanges for dropdown
  const { data: exchanges } = useQuery({
    queryKey: ['exchanges'],
    queryFn: () => exchangeService.getAll(),
  });

  // Fetch special trading days
  const { data: specialDays, isLoading, error } = useQuery({
    queryKey: ['specialTradingDays', selectedExchange],
    queryFn: async () => {
      if (selectedExchange === 'ALL') {
        return specialTradingDayService.getAll();
      }
      return specialTradingDayService.getByExchange(selectedExchange);
    },
  });

  // Create mutation
  // Manual sync (distributed mode): triggers the market-data sync AND drops
  // the special/mock trading-day TTL caches so a just-added entry in the
  // market-data admin shows up immediately (instead of after ~5 min).
  const createMutation = useMutation({
    mutationFn: (data: SpecialTradingDay) => specialTradingDayService.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['specialTradingDays'] });
      setShowModal(false);
      toast.success('Special trading day added');
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to add special trading day');
    },
  });

  // Update mutation
  const updateMutation = useMutation({
    mutationFn: ({ exchange, date, data }: { exchange: string; date: string; data: { tradingDayName?: string; marketOpen?: string; marketClose?: string } }) =>
      specialTradingDayService.update(exchange, date, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['specialTradingDays'] });
      setShowModal(false);
      setEditingDay(null);
      toast.success('Special trading day updated');
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to update special trading day');
    },
  });

  // Delete mutation
  const deleteMutation = useMutation({
    mutationFn: ({ exchange, tradingDate }: { exchange: string; tradingDate: string }) =>
      specialTradingDayService.delete(exchange, tradingDate),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['specialTradingDays'] });
      setDeleteTarget(null);
      toast.success('Special trading day deleted');
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to delete special trading day');
    },
  });

  // Get unique years from special days for year dropdown
  const availableYears = useMemo(() => {
    if (!specialDays || specialDays.length === 0) return [currentYear];
    const years = new Set<number>();
    specialDays.forEach(d => {
      if (d.tradingDate) {
        const year = parseInt(d.tradingDate.substring(0, 4), 10);
        if (!isNaN(year)) years.add(year);
      }
    });
    years.add(currentYear);
    return Array.from(years).sort((a, b) => b - a);
  }, [specialDays]);

  // Filter special days by selected year
  const filteredDays: SpecialTradingDay[] = useMemo(() => {
    if (!specialDays) return [];
    return specialDays.filter(d => d.tradingDate?.startsWith(selectedYear.toString()));
  }, [specialDays, selectedYear]);

  const exchangeCodes = useMemo(() => exchanges?.map(e => e.exchange) || [], [exchanges]);

  const handleOpenAddModal = () => {
    setEditingDay(null);
    setFormData({
      exchange: exchangeCodes.length > 0 ? exchangeCodes[0] : '',
      tradingDate: '',
      tradingDayName: '',
      marketOpen: '',
      marketClose: '',
    });
    setShowModal(true);
  };

  const handleOpenEditModal = (day: SpecialTradingDay) => {
    setEditingDay(day);
    setFormData({
      exchange: day.exchange,
      tradingDate: day.tradingDate,
      tradingDayName: day.tradingDayName || '',
      marketOpen: day.marketOpen || '',
      marketClose: day.marketClose || '',
    });
    setShowModal(true);
  };

  const handleSave = () => {
    if (!formData.exchange || !formData.tradingDate) {
      toast.error('Exchange and date are required');
      return;
    }
    if (editingDay) {
      updateMutation.mutate({
        exchange: editingDay.exchange,
        date: editingDay.tradingDate,
        data: {
          tradingDayName: formData.tradingDayName,
          marketOpen: formData.marketOpen || undefined,
          marketClose: formData.marketClose || undefined,
        },
      });
    } else {
      createMutation.mutate({
        ...formData,
        marketOpen: formData.marketOpen || undefined,
        marketClose: formData.marketClose || undefined,
      });
    }
  };

  const isSaving = createMutation.isPending || updateMutation.isPending;

  const columns: Column<SpecialTradingDay>[] = [
    ...(selectedExchange === 'ALL' ? [{
      key: 'exchange' as const,
      header: 'Exchange',
      render: (d: SpecialTradingDay) => <Badge bg="secondary">{d.exchange}</Badge>,
    }] : []),
    {
      key: 'tradingDate',
      header: 'Trading Date',
      render: (d) => (
        <div className="flex items-center gap-2">
          <BsCalendarCheck className="text-success-500 dark:text-success-400" />
          <span className="font-medium">{d.tradingDate}</span>
        </div>
      ),
    },
    {
      key: 'tradingDayName',
      header: 'Event Name',
      render: (d) => <span>{d.tradingDayName || '-'}</span>,
    },
    {
      key: 'marketHours' as const,
      header: 'Market Hours',
      render: (d: SpecialTradingDay) => (d.marketOpen || d.marketClose)
        ? <Badge bg="info">{d.marketOpen || '?'} - {d.marketClose || '?'}</Badge>
        : <span className="text-ink-soft">Default</span>,
    },
    ...(canEdit ? [{
      key: 'actions' as const,
      header: '',
      render: (d: SpecialTradingDay) => (
        <div className="flex gap-1 justify-end">
          <Button
            variant="outline-primary"
            size="sm"
            onClick={() => handleOpenEditModal(d)}
            title="Edit"
          >
            <BsPencil />
          </Button>
          <Button
            variant="outline-danger"
            size="sm"
            onClick={() => setDeleteTarget(d)}
            title="Delete"
          >
            <BsTrash />
          </Button>
        </div>
      ),
    }] : []),
  ];

  if (error) {
    return (
      <Card>
        <Card.Header>
          <h5 className="mb-0">{title}</h5>
        </Card.Header>
        <Card.Body>
          <Alert variant="danger">Failed to load special trading days</Alert>
        </Card.Body>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <Card.Header className="flex justify-between items-center">
          <h5 className="mb-0">{title}</h5>
          <div className="flex items-center gap-2">
            {canEdit && (
              <Button variant="primary" size="sm" onClick={handleOpenAddModal}>
                <BsPlus className="me-1" />
                Add Special Trading Day
              </Button>
            )}
          </div>
        </Card.Header>
        <Card.Body>
          <Row className="mb-4">
            <Col md={4}>
              <Form.Group>
                <Form.Label>Select Exchange</Form.Label>
                <Form.Select
                  value={selectedExchange}
                  onChange={(e) => setSelectedExchange(e.target.value)}
                >
                  <option value="ALL">All Exchanges</option>
                  {exchanges?.map((ex) => (
                    <option key={ex.exchange} value={ex.exchange}>
                      {ex.exchange} - {ex.exchangeName}
                    </option>
                  ))}
                </Form.Select>
              </Form.Group>
            </Col>
            <Col md={2}>
              <Form.Group>
                <Form.Label>Year</Form.Label>
                <Form.Select
                  value={selectedYear}
                  onChange={(e) => setSelectedYear(parseInt(e.target.value, 10))}
                >
                  {availableYears.map((year) => (
                    <option key={year} value={year}>
                      {year}
                    </option>
                  ))}
                </Form.Select>
              </Form.Group>
            </Col>
          </Row>

          <DataTable
            columns={columns}
            data={filteredDays}
            loading={isLoading}
            keyExtractor={(d) => `${d.exchange}-${d.tradingDate}`}
            emptyMessage={selectedExchange === 'ALL'
              ? 'No special trading days found'
              : `No special trading days found for ${selectedExchange}`}
          />

          <div className="text-ink-soft text-[0.875em] mt-2">
            Total: {filteredDays.length} special trading day(s)
          </div>
        </Card.Body>
      </Card>

      {/* Add/Edit Modal */}
      <Modal show={showModal} onHide={() => setShowModal(false)} backdrop="static">
        <Modal.Header closeButton>
          <Modal.Title>
            {editingDay ? <><BsPencil className="me-2" />Edit Special Trading Day</> : <><BsPlus className="me-2" />Add Special Trading Day</>}
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Form.Group className="mb-4">
            <Form.Label>Exchange <span className="text-danger-600 dark:text-danger-400">*</span></Form.Label>
            <Form.Select
              value={formData.exchange}
              onChange={(e) => setFormData((prev) => ({ ...prev, exchange: e.target.value }))}
              disabled={!!editingDay}
            >
              <option value="">-- Select Exchange --</option>
              {exchangeCodes.map((ex) => (
                <option key={ex} value={ex}>{ex}</option>
              ))}
            </Form.Select>
          </Form.Group>
          <Form.Group className="mb-4">
            <Form.Label>Date <span className="text-danger-600 dark:text-danger-400">*</span></Form.Label>
            <Form.Control
              type="date"
              value={formData.tradingDate}
              onChange={(e) => setFormData((prev) => ({ ...prev, tradingDate: e.target.value }))}
              disabled={!!editingDay}
            />
          </Form.Group>
          <Form.Group className="mb-4">
            <Form.Label>Trading Day Name</Form.Label>
            <Form.Control
              type="text"
              placeholder="e.g., Muhurat Trading, Special Saturday"
              value={formData.tradingDayName}
              onChange={(e) => setFormData((prev) => ({ ...prev, tradingDayName: e.target.value }))}
            />
          </Form.Group>
          <Row className="mb-4">
            <Col md={6}>
              <Form.Group>
                <Form.Label>Market Open <small className="text-ink-soft">(optional)</small></Form.Label>
                <Form.Control
                  type="time"
                  value={formData.marketOpen}
                  onChange={(e) => setFormData((prev) => ({ ...prev, marketOpen: e.target.value }))}
                />
              </Form.Group>
            </Col>
            <Col md={6}>
              <Form.Group>
                <Form.Label>Market Close <small className="text-ink-soft">(optional)</small></Form.Label>
                <Form.Control
                  type="time"
                  value={formData.marketClose}
                  onChange={(e) => setFormData((prev) => ({ ...prev, marketClose: e.target.value }))}
                />
              </Form.Group>
            </Col>
            <Form.Text className="text-ink-soft mt-1">
              Leave empty to use default exchange hours. Set for partial holidays (e.g., MCX evening-only session).
            </Form.Text>
          </Row>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={() => setShowModal(false)}>Cancel</Button>
          <Button variant="primary" onClick={handleSave} disabled={isSaving}>
            {isSaving ? <><Spinner size="sm" className="me-2" />Saving...</> : editingDay ? 'Save Changes' : 'Add'}
          </Button>
        </Modal.Footer>
      </Modal>

      {/* Delete Confirmation */}
      <ConfirmModal
        show={deleteTarget !== null}
        title="Delete Special Trading Day"
        message={deleteTarget ? `Delete "${deleteTarget.tradingDayName || deleteTarget.tradingDate}" for ${deleteTarget.exchange}?` : ''}
        confirmText="Delete"
        confirmVariant="danger"
        onConfirm={() => deleteTarget && deleteMutation.mutate({ exchange: deleteTarget.exchange, tradingDate: deleteTarget.tradingDate })}
        onCancel={() => setDeleteTarget(null)}
        isLoading={deleteMutation.isPending}
      />
    </>
  );
};

export default SpecialTradingDays;
