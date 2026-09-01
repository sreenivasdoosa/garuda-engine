/**
 * Holidays Component
 * Distributed: read-only, synced from Market Data Service
 * Standalone: directly managed with add/delete
 * Uses V2 API: /api/v2/holidays
 */

import { useState, useMemo } from 'react';
import { Card, Alert, Form, Row, Col, Badge, Button, Modal, Spinner } from '@/components/ui/rbShim';
import { BsCalendar, BsArrowRepeat, BsPlus, BsTrash } from 'react-icons/bs';
import { DataTable } from '@/components/common';
import type { Column } from '@/components/common';
import ConfirmModal from '@/components/common/ConfirmModal';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { holidayService, exchangeService, marketDataSyncService } from '@/services/admin/v2AdminService';
import { toast } from 'react-toastify';
import type { Holiday } from '@/types/exchange';

export interface HolidaysProps {
  /** Card title */
  title?: string;
  /** Hide sync button for view-only users */
  hideSync?: boolean;
  /** Allow add/delete operations */
  canEdit?: boolean;
}

const currentYear = new Date().getFullYear();

const Holidays: React.FC<HolidaysProps> = ({
  title = 'Holidays',
  hideSync = false,
  canEdit = false,
}) => {
  const [selectedExchange, setSelectedExchange] = useState<string>('ALL');
  const [selectedYear, setSelectedYear] = useState<number>(currentYear);
  const queryClient = useQueryClient();

  // Add holiday modal state
  const [showAddModal, setShowAddModal] = useState(false);
  const [newHoliday, setNewHoliday] = useState({ exchanges: [] as string[], date: '', description: '' });

  // Delete confirm state
  const [deleteTarget, setDeleteTarget] = useState<{ exchange: string; date: string } | null>(null);

  // Sync mutation
  const syncMutation = useMutation({
    mutationFn: () => marketDataSyncService.triggerSync(),
    onSuccess: () => {
      toast.success('Sync triggered successfully. Data will be updated shortly.');
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['holidays'] });
      }, 3000);
    },
    onError: (error: Error) => {
      toast.error(`Sync failed: ${error.message}`);
    },
  });

  // Create mutation
  const createMutation = useMutation({
    mutationFn: async (data: { exchanges: string[]; date: string; description: string }) => {
      const results = { success: [] as string[], failed: [] as string[], skipped: [] as string[] };
      const existingKeys = new Set((holidays || []).map((h) => `${h.exchange}:${h.date}`));

      for (const exchange of data.exchanges) {
        const key = `${exchange}:${data.date}`;
        if (existingKeys.has(key)) {
          results.skipped.push(exchange);
          continue;
        }
        try {
          await holidayService.create({ exchange, date: data.date, description: data.description || undefined });
          results.success.push(exchange);
        } catch {
          results.failed.push(exchange);
        }
      }
      return results;
    },
    onSuccess: (results) => {
      queryClient.invalidateQueries({ queryKey: ['holidays'] });
      setShowAddModal(false);

      if (results.failed.length > 0) {
        toast.warning(`Added: ${results.success.length}, Skipped: ${results.skipped.length}, Failed: ${results.failed.join(', ')}`);
      } else if (results.skipped.length > 0) {
        toast.info(`Added: ${results.success.length}, Already exists: ${results.skipped.join(', ')}`);
      } else {
        toast.success(`Holiday added for ${results.success.length} exchange(s)`);
      }
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to add holiday');
    },
  });

  // Delete mutation
  const deleteMutation = useMutation({
    mutationFn: ({ exchange, date }: { exchange: string; date: string }) =>
      holidayService.delete(exchange, date),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['holidays'] });
      setDeleteTarget(null);
      toast.success('Holiday deleted');
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to delete holiday');
    },
  });

  // Fetch exchanges for dropdown
  const { data: exchanges } = useQuery({
    queryKey: ['exchanges'],
    queryFn: () => exchangeService.getAll(),
  });

  // Fetch holidays for selected exchange or all exchanges
  const { data: holidays, isLoading, error } = useQuery({
    queryKey: ['holidays', selectedExchange, exchanges?.map(e => e.exchange)],
    queryFn: async () => {
      if (selectedExchange === 'ALL') {
        if (!exchanges || exchanges.length === 0) return [];
        const allHolidays: Holiday[] = [];
        for (const ex of exchanges) {
          try {
            const days = await holidayService.getByExchange(ex.exchange);
            days.forEach(d => {
              allHolidays.push({ ...d, exchange: ex.exchange });
            });
          } catch (err) {
            console.error(`Failed to fetch holidays for ${ex.exchange}:`, err);
          }
        }
        return allHolidays;
      }
      const days = await holidayService.getByExchange(selectedExchange);
      return days.map(d => ({ ...d, exchange: selectedExchange }));
    },
    enabled: selectedExchange === 'ALL' ? !!exchanges && exchanges.length > 0 : !!selectedExchange,
  });

  // Get unique years from holiday dates for year dropdown
  const availableYears = useMemo(() => {
    if (!holidays || holidays.length === 0) return [currentYear];
    const years = new Set<number>();
    holidays.forEach(h => {
      const year = parseInt(h.date.substring(0, 4), 10);
      if (!isNaN(year)) years.add(year);
    });
    years.add(currentYear);
    return Array.from(years).sort((a, b) => b - a);
  }, [holidays]);

  // Filter holidays by selected year
  const holidaysList: Holiday[] = useMemo(() => {
    if (!holidays) return [];
    return holidays.filter(h => h.date.startsWith(selectedYear.toString()));
  }, [holidays, selectedYear]);

  // Exchange toggle for add modal
  const handleExchangeToggle = (exchange: string) => {
    setNewHoliday((prev) => {
      const exList = prev.exchanges.includes(exchange)
        ? prev.exchanges.filter((e) => e !== exchange)
        : [...prev.exchanges, exchange];
      return { ...prev, exchanges: exList };
    });
  };

  const allExchangeCodes = useMemo(() => exchanges?.map(e => e.exchange) || [], [exchanges]);

  const handleSelectAllExchanges = () => {
    const allSelected = allExchangeCodes.every((ex) => newHoliday.exchanges.includes(ex));
    setNewHoliday((prev) => ({
      ...prev,
      exchanges: allSelected ? [] : [...allExchangeCodes],
    }));
  };

  const handleOpenAddModal = () => {
    setNewHoliday({ exchanges: [], date: '', description: '' });
    setShowAddModal(true);
  };

  const handleAddHoliday = () => {
    if (!newHoliday.date) {
      toast.error('Please select a date');
      return;
    }
    if (newHoliday.exchanges.length === 0) {
      toast.error('Please select at least one exchange');
      return;
    }
    createMutation.mutate(newHoliday);
  };

  const columns: Column<Holiday>[] = [
    ...(selectedExchange === 'ALL' ? [{
      key: 'exchange' as const,
      header: 'Exchange',
      render: (h: Holiday) => <Badge bg="secondary">{h.exchange}</Badge>,
    }] : []),
    {
      key: 'date',
      header: 'Date',
      render: (h) => (
        <div className="flex items-center gap-2">
          <BsCalendar className="text-ink-soft" />
          <span className="font-medium">{h.date}</span>
        </div>
      ),
    },
    {
      key: 'description',
      header: 'Description',
      render: (h) => <span>{h.description || '-'}</span>,
    },
    ...(canEdit ? [{
      key: 'actions' as const,
      header: '',
      render: (h: Holiday) => (
        <Button
          variant="outline-danger"
          size="sm"
          onClick={() => setDeleteTarget({ exchange: h.exchange, date: h.date })}
          title="Delete"
        >
          <BsTrash />
        </Button>
      ),
    }] : []),
  ];

  if (error) {
    return <Alert variant="danger">Failed to load holidays</Alert>;
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
              <Button variant="primary" size="sm" onClick={handleOpenAddModal}>
                <BsPlus className="me-1" />
                Add Holiday
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
            data={holidaysList}
            loading={isLoading}
            keyExtractor={(h) => `${h.exchange}-${h.date}`}
            emptyMessage={selectedExchange === 'ALL' ? 'No holidays found' : 'No holidays found for this exchange'}
          />
        </Card.Body>
        <Card.Footer className="text-ink-soft text-[0.875em]">
          Total: {holidaysList.length} holiday(s)
        </Card.Footer>
      </Card>

      {/* Add Holiday Modal */}
      <Modal show={showAddModal} onHide={() => setShowAddModal(false)} backdrop="static">
        <Modal.Header closeButton>
          <Modal.Title>
            <BsPlus className="me-2" />
            Add Holiday
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Form.Group className="mb-4">
            <Form.Label>Date <span className="text-danger-600 dark:text-danger-400">*</span></Form.Label>
            <Form.Control
              type="date"
              value={newHoliday.date}
              onChange={(e) => setNewHoliday((prev) => ({ ...prev, date: e.target.value }))}
            />
          </Form.Group>
          <Form.Group className="mb-4">
            <Form.Label>Description</Form.Label>
            <Form.Control
              type="text"
              placeholder="e.g., Republic Day"
              value={newHoliday.description}
              onChange={(e) => setNewHoliday((prev) => ({ ...prev, description: e.target.value }))}
            />
          </Form.Group>
          <Form.Group className="mb-4">
            <div className="flex justify-between items-center mb-2">
              <Form.Label className="mb-0">Exchanges <span className="text-danger-600 dark:text-danger-400">*</span></Form.Label>
              <Button variant="outline-secondary" size="sm" onClick={handleSelectAllExchanges}>
                {allExchangeCodes.every((ex) => newHoliday.exchanges.includes(ex)) ? 'Deselect All' : 'Select All'}
              </Button>
            </div>
            <div className="border rounded-md p-2" style={{ maxHeight: '200px', overflowY: 'auto' }}>
              {allExchangeCodes.length === 0 ? (
                <div className="text-ink-soft text-center py-2">No exchanges configured</div>
              ) : (
                allExchangeCodes.map((ex) => (
                  <Form.Check
                    key={ex}
                    type="checkbox"
                    label={ex}
                    checked={newHoliday.exchanges.includes(ex)}
                    onChange={() => handleExchangeToggle(ex)}
                  />
                ))
              )}
            </div>
            {newHoliday.exchanges.length > 0 && (
              <Form.Text className="text-ink-soft">
                {newHoliday.exchanges.length} exchange{newHoliday.exchanges.length > 1 ? 's' : ''} selected
              </Form.Text>
            )}
          </Form.Group>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={() => setShowAddModal(false)}>Cancel</Button>
          <Button variant="primary" onClick={handleAddHoliday} disabled={createMutation.isPending}>
            {createMutation.isPending ? <><Spinner size="sm" className="me-2" />Adding...</> : 'Add Holiday'}
          </Button>
        </Modal.Footer>
      </Modal>

      {/* Delete Confirmation */}
      <ConfirmModal
        show={deleteTarget !== null}
        title="Delete Holiday"
        message={deleteTarget ? `Delete holiday ${deleteTarget.date} for ${deleteTarget.exchange}?` : ''}
        confirmText="Delete"
        confirmVariant="danger"
        onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget)}
        onCancel={() => setDeleteTarget(null)}
        isLoading={deleteMutation.isPending}
      />
    </>
  );
};

export default Holidays;
