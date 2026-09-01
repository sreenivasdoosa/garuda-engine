/**
 * GlobalEventDays Component
 * Table for listing and managing exchange event days (expiry days, special trading days)
 * These are global settings that apply to all strategies and users
 * Uses V2 API: /api/v2/event-days
 */

import { useState, useMemo } from 'react';
import { Button, Badge, Alert, Form, Row, Col, Modal } from '@/components/ui/rbShim';
import { BsPlus, BsTrash, BsCalendarEvent, BsPencil, BsEye } from 'react-icons/bs';
import { DataTable, ConfirmModal } from '@/components/common';
import type { Column } from '@/components/common';
import HelpIcon from '@/components/common/HelpIcon';
import { eventDaysHelpContent } from '@/data/help/event-days-help';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { eventDayService, exchangeService } from '@/services/admin/v2AdminService';
import { toast } from 'react-toastify';
import type { EventDay } from '@/types/exchange';

export interface GlobalEventDaysProps {
  /** Hide add button */
  hideCreate?: boolean;
  /** Hide delete button */
  hideDelete?: boolean;
  /** Read-only mode - shows View button instead of Edit */
  readOnly?: boolean;
}

interface CreateEventDayForm {
  exchanges: string[];
  eventDate: string;
  eventName: string;
  capitalPercentage: number;
}

const currentYear = new Date().getFullYear();

const GlobalEventDays: React.FC<GlobalEventDaysProps> = ({
  hideCreate = false,
  hideDelete = false,
  readOnly = false,
}) => {
  const [selectedExchange, setSelectedExchange] = useState<string>('ALL');
  const [selectedYear, setSelectedYear] = useState<number>(currentYear);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [eventDayToDelete, setEventDayToDelete] = useState<EventDay | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [eventDayToEdit, setEventDayToEdit] = useState<EventDay | null>(null);
  const [newEventDay, setNewEventDay] = useState<CreateEventDayForm>({
    exchanges: [],
    eventDate: '',
    eventName: '',
    capitalPercentage: 100,
  });
  const [editForm, setEditForm] = useState({
    eventName: '',
    capitalPercentage: 100,
  });
  const [isCreating, setIsCreating] = useState(false);
  const queryClient = useQueryClient();

  const helpContent = eventDaysHelpContent;

  // Fetch exchanges for dropdown
  const { data: exchanges } = useQuery({
    queryKey: ['exchanges'],
    queryFn: () => exchangeService.getAll(),
  });

  // Fetch event days for selected exchange or all exchanges
  const { data: eventDays, isLoading, error } = useQuery({
    queryKey: ['eventDays', selectedExchange, exchanges?.map(e => e.exchange)],
    queryFn: async () => {
      if (selectedExchange === 'ALL') {
        // Fetch event days for all exchanges
        if (!exchanges || exchanges.length === 0) return [];
        const allEventDays: EventDay[] = [];
        for (const ex of exchanges) {
          try {
            const days = await eventDayService.getByExchange(ex.exchange);
            // Add exchange code to each event day for display
            days.forEach(d => {
              allEventDays.push({ ...d, exchange: ex.exchange });
            });
          } catch (err) {
            console.error(`Failed to fetch event days for ${ex.exchange}:`, err);
          }
        }
        return allEventDays;
      }
      const days = await eventDayService.getByExchange(selectedExchange);
      return days.map(d => ({ ...d, exchange: selectedExchange }));
    },
    enabled: selectedExchange === 'ALL' ? !!exchanges && exchanges.length > 0 : !!selectedExchange,
  });

  const updateMutation = useMutation({
    mutationFn: ({ exchange, eventDate, data }: { exchange: string; eventDate: string; data: { eventName: string; capitalPercentage: number } }) =>
      eventDayService.update(exchange, eventDate, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['eventDays', selectedExchange] });
      setShowEditModal(false);
      setEventDayToEdit(null);
      toast.success('Event day updated successfully');
    },
    onError: (error: Error) => {
      toast.error(`Failed to update event day: ${error.message}`);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: ({ exchange, eventDate }: { exchange: string; eventDate: string }) =>
      eventDayService.delete(exchange, eventDate),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['eventDays', selectedExchange] });
      setShowDeleteConfirm(false);
      setEventDayToDelete(null);
      toast.success('Event day deleted successfully');
    },
    onError: (error: Error) => {
      toast.error(`Failed to delete event day: ${error.message}`);
    },
  });

  const handleAddEventDay = async () => {
    if (!newEventDay.exchanges.length || !newEventDay.eventDate || !newEventDay.eventName) {
      toast.error('Please fill in all required fields');
      return;
    }

    setIsCreating(true);
    let successCount = 0;
    let failCount = 0;

    for (const exchange of newEventDay.exchanges) {
      try {
        await eventDayService.create(exchange, {
          eventDate: newEventDay.eventDate,
          eventName: newEventDay.eventName,
          capitalPercentage: newEventDay.capitalPercentage,
        });
        successCount++;
      } catch (err) {
        failCount++;
        console.error(`Failed to create event day for ${exchange}:`, err);
      }
    }

    setIsCreating(false);

    if (successCount > 0) {
      toast.success(`Event day created for ${successCount} exchange(s)`);
      queryClient.invalidateQueries({ queryKey: ['eventDays'] });
      setShowAddModal(false);
      setNewEventDay({
        exchanges: [],
        eventDate: '',
        eventName: '',
        capitalPercentage: 100,
      });
    }

    if (failCount > 0) {
      toast.error(`Failed to create event day for ${failCount} exchange(s)`);
    }
  };

  const handleEditClick = (eventDay: EventDay) => {
    setEventDayToEdit(eventDay);
    setEditForm({
      eventName: eventDay.eventName,
      capitalPercentage: eventDay.capitalPercentage,
    });
    setShowEditModal(true);
  };

  const handleSaveEdit = () => {
    if (eventDayToEdit && eventDayToEdit.exchange) {
      updateMutation.mutate({
        exchange: eventDayToEdit.exchange,
        eventDate: eventDayToEdit.eventDate,
        data: editForm,
      });
    }
  };

  const handleExchangeToggle = (exchangeCode: string) => {
    setNewEventDay(prev => ({
      ...prev,
      exchanges: prev.exchanges.includes(exchangeCode)
        ? prev.exchanges.filter(e => e !== exchangeCode)
        : [...prev.exchanges, exchangeCode],
    }));
  };

  const handleSelectAllExchanges = () => {
    if (exchanges) {
      const allExchanges = exchanges.map(e => e.exchange);
      setNewEventDay(prev => ({
        ...prev,
        exchanges: prev.exchanges.length === allExchanges.length ? [] : allExchanges,
      }));
    }
  };

  // Get unique years from event days for year dropdown
  const availableYears = useMemo(() => {
    if (!eventDays || eventDays.length === 0) return [currentYear];
    const years = new Set<number>();
    eventDays.forEach(e => {
      const year = parseInt(e.eventDate.substring(0, 4), 10);
      if (!isNaN(year)) years.add(year);
    });
    years.add(currentYear);
    return Array.from(years).sort((a, b) => b - a);
  }, [eventDays]);

  // Filter event days by selected year
  const eventDaysList: EventDay[] = useMemo(() => {
    if (!eventDays) return [];
    return eventDays.filter(e => e.eventDate.startsWith(selectedYear.toString()));
  }, [eventDays, selectedYear]);

  const columns: Column<EventDay>[] = [
    ...(selectedExchange === 'ALL' ? [{
      key: 'exchange' as const,
      header: 'Exchange',
      render: (e: EventDay) => <Badge bg="secondary">{e.exchange}</Badge>,
    }] : []),
    {
      key: 'eventDate',
      header: 'Event Date',
      render: (e) => (
        <div className="flex items-center gap-2">
          <BsCalendarEvent className="text-primary-700 dark:text-primary-400" />
          <span className="font-medium">{e.eventDate}</span>
        </div>
      ),
    },
    {
      key: 'eventName',
      header: 'Event Name',
      render: (e) => <span>{e.eventName}</span>,
    },
    {
      key: 'capitalPercentage',
      header: 'Capital %',
      render: (e) => (
        <Badge bg={e.capitalPercentage < 100 ? 'warning' : 'success'}>
          {e.capitalPercentage}%
        </Badge>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      render: (e: EventDay) => (
        <div className="flex gap-1">
          <Button
            variant="outline-primary"
            size="sm"
            onClick={(ev) => {
              ev.stopPropagation();
              handleEditClick(e);
            }}
            title={readOnly ? 'View' : 'Edit'}
          >
            {readOnly ? <BsEye /> : <BsPencil />}
          </Button>
          {!hideDelete && (
            <Button
              variant="outline-danger"
              size="sm"
              onClick={(ev) => {
                ev.stopPropagation();
                setEventDayToDelete(e);
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
    return <Alert variant="danger">Failed to load event days</Alert>;
  }

  const allExchanges = exchanges || [];

  return (
    <>
      <div className="flex justify-between items-center mb-4">
        <div className="text-ink-soft text-[0.875em]">
          Event days are high-impact dates (elections, Fed rates, budget, etc.) where capital allocation is reduced to limit volatility risk.
        </div>
        {!hideCreate && (
          <Button variant="primary" size="sm" onClick={() => setShowAddModal(true)}>
            <BsPlus className="me-1" /> Add Event Day
          </Button>
        )}
      </div>

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
        data={eventDaysList}
        loading={isLoading}
        keyExtractor={(e) => `${e.exchange || selectedExchange}-${e.eventDate}`}
        emptyMessage={selectedExchange === 'ALL' ? 'No event days found' : 'No event days found for this exchange'}
      />

      <div className="text-ink-soft text-[0.875em] mt-2">
        Total: {eventDaysList.length} event day(s)
      </div>

      {/* Add Event Day Modal */}
      <Modal show={showAddModal} onHide={() => setShowAddModal(false)} size="lg" backdrop="static">
        <Modal.Header closeButton>
          <Modal.Title>Add Event Day</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Form.Group className="mb-4">
            <Form.Label className="flex items-center">Exchanges * <HelpIcon article={helpContent['eventDays.global.exchanges']} /></Form.Label>
            <div className="mb-2">
              <Button
                variant="outline-secondary"
                size="sm"
                onClick={handleSelectAllExchanges}
              >
                {newEventDay.exchanges.length === allExchanges.length ? 'Deselect All' : 'Select All'}
              </Button>
            </div>
            <div className="flex flex-wrap gap-2">
              {allExchanges.map((ex) => (
                <Form.Check
                  key={ex.exchange}
                  type="checkbox"
                  id={`exchange-${ex.exchange}`}
                  label={ex.exchange}
                  checked={newEventDay.exchanges.includes(ex.exchange)}
                  onChange={() => handleExchangeToggle(ex.exchange)}
                  className="border rounded-md px-4 py-2"
                />
              ))}
            </div>
            {newEventDay.exchanges.length > 0 && (
              <div className="mt-2 text-ink-soft text-[0.875em]">
                Selected: {newEventDay.exchanges.join(', ')}
              </div>
            )}
          </Form.Group>
          <Row>
            <Col md={6}>
              <Form.Group className="mb-4">
                <Form.Label className="flex items-center">Event Date * <HelpIcon article={helpContent['eventDays.global.eventDate']} /></Form.Label>
                <Form.Control
                  type="date"
                  value={newEventDay.eventDate}
                  onChange={(e) => setNewEventDay({ ...newEventDay, eventDate: e.target.value })}
                />
              </Form.Group>
            </Col>
            <Col md={6}>
              <Form.Group className="mb-4">
                <Form.Label className="flex items-center">Capital % (0-100) * <HelpIcon article={helpContent['eventDays.global.capitalPercentage']} /></Form.Label>
                <Form.Control
                  type="number"
                  min={0}
                  max={100}
                  value={newEventDay.capitalPercentage}
                  onChange={(e) => setNewEventDay({
                    ...newEventDay,
                    capitalPercentage: Math.min(100, Math.max(0, Number(e.target.value))),
                  })}
                />
              </Form.Group>
            </Col>
          </Row>
          <Form.Group className="mb-4">
            <Form.Label className="flex items-center">Event Name * <HelpIcon article={helpContent['eventDays.global.eventName']} /></Form.Label>
            <Form.Control
              type="text"
              placeholder="e.g., Monthly Expiry, Election Event"
              value={newEventDay.eventName}
              onChange={(e) => setNewEventDay({ ...newEventDay, eventName: e.target.value })}
            />
          </Form.Group>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={() => setShowAddModal(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleAddEventDay}
            disabled={isCreating || !newEventDay.exchanges.length || !newEventDay.eventDate || !newEventDay.eventName}
          >
            {isCreating ? 'Creating...' : 'Add Event Day'}
          </Button>
        </Modal.Footer>
      </Modal>

      {/* Edit/View Event Day Modal */}
      <Modal show={showEditModal} onHide={() => setShowEditModal(false)} backdrop={readOnly ? true : 'static'}>
        <Modal.Header closeButton>
          <Modal.Title>
            {readOnly ? <BsEye className="me-2" /> : <BsPencil className="me-2" />}
            {readOnly ? 'View' : 'Edit'} Event Day
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <fieldset disabled={readOnly}>
            <Form.Group className="mb-4">
              <Form.Label>Exchange</Form.Label>
              <Form.Control type="text" value={eventDayToEdit?.exchange || ''} disabled />
            </Form.Group>
            <Form.Group className="mb-4">
              <Form.Label>Event Date</Form.Label>
              <Form.Control type="text" value={eventDayToEdit?.eventDate || ''} disabled />
            </Form.Group>
            <Form.Group className="mb-4">
              <Form.Label className="flex items-center">Event Name * <HelpIcon article={helpContent['eventDays.global.eventName']} /></Form.Label>
              <Form.Control
                type="text"
                value={editForm.eventName}
                onChange={(e) => setEditForm({ ...editForm, eventName: e.target.value })}
              />
            </Form.Group>
            <Form.Group className="mb-4">
              <Form.Label className="flex items-center">Capital % (0-100) * <HelpIcon article={helpContent['eventDays.global.capitalPercentage']} /></Form.Label>
              <Form.Control
                type="number"
                min={0}
                max={100}
                value={editForm.capitalPercentage}
                onChange={(e) => setEditForm({
                  ...editForm,
                  capitalPercentage: Math.min(100, Math.max(0, Number(e.target.value))),
                })}
              />
            </Form.Group>
          </fieldset>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={() => setShowEditModal(false)}>
            {readOnly ? 'Close' : 'Cancel'}
          </Button>
          {!readOnly && (
            <Button
              variant="primary"
              onClick={handleSaveEdit}
              disabled={updateMutation.isPending}
            >
              {updateMutation.isPending ? 'Saving...' : 'Save'}
            </Button>
          )}
        </Modal.Footer>
      </Modal>

      <ConfirmModal
        show={showDeleteConfirm}
        title="Delete Event Day"
        message={`Are you sure you want to delete the event day "${eventDayToDelete?.eventName}" (${eventDayToDelete?.eventDate}) for ${eventDayToDelete?.exchange}?`}
        confirmLabel="Delete"
        confirmVariant="danger"
        onConfirm={() => eventDayToDelete && eventDayToDelete.exchange && deleteMutation.mutate({
          exchange: eventDayToDelete.exchange,
          eventDate: eventDayToDelete.eventDate,
        })}
        onCancel={() => {
          setShowDeleteConfirm(false);
          setEventDayToDelete(null);
        }}
        isLoading={deleteMutation.isPending}
      />
    </>
  );
};

export default GlobalEventDays;
