/**
 * StrategyEventDays Component
 * Table for listing and managing strategy-specific event day capital percentage overrides
 * Uses V2 API: /api/v2/strategy-event-day-actions
 */

import { useState, useMemo, useEffect } from 'react';
import { Button, Badge, Alert, Form, Row, Col, Modal } from '@/components/ui/rbShim';
import { BsPlus, BsTrash, BsCalendarEvent, BsPencil, BsEye } from 'react-icons/bs';
import { DataTable, ConfirmModal } from '@/components/common';
import type { Column } from '@/components/common';
import HelpIcon from '@/components/common/HelpIcon';
import { eventDaysHelpContent } from '@/data/help/event-days-help';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { strategyEventDayActionService, eventDayService } from '@/services/admin/v2AdminService';
import { strategyDefinitionService } from '@/services/admin/strategyEngineService';
import type { StrategyEventDayAction } from '@/services/admin/v2AdminService';
import type { StrategyDefinition } from '@/types/strategy-engine';
import { productBadgeBg } from '@/types/product';
import { toast } from 'react-toastify';
import Select from 'react-select';

export interface StrategyEventDaysProps {
  /** Hide add button */
  hideCreate?: boolean;
  /** Hide delete button */
  hideDelete?: boolean;
  /** Read-only mode - shows View button instead of Edit */
  readOnly?: boolean;
}

interface CreateStrategyEventDayForm {
  strategyName: string;
  exchangeCode: string;
  eventDate: string;
  capitalPercentage: number;
}

const currentYear = new Date().getFullYear();

const StrategyEventDays: React.FC<StrategyEventDaysProps> = ({
  hideCreate = false,
  hideDelete = false,
  readOnly = false,
}) => {
  const [selectedStrategy, setSelectedStrategy] = useState<string>('ALL');
  const [selectedYear, setSelectedYear] = useState<number>(currentYear);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [actionToDelete, setActionToDelete] = useState<StrategyEventDayAction | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [actionToEdit, setActionToEdit] = useState<StrategyEventDayAction | null>(null);
  const [newAction, setNewAction] = useState<CreateStrategyEventDayForm>({
    strategyName: '',
    exchangeCode: '',
    eventDate: '',
    capitalPercentage: 100,
  });
  const [editCapitalPercentage, setEditCapitalPercentage] = useState(100);
  const [isCreating, setIsCreating] = useState(false);
  const queryClient = useQueryClient();

  const helpContent = eventDaysHelpContent;

  // Fetch strategies for dropdown (active or wind_down, exclude CAPITAL product)
  const { data: strategies } = useQuery({
    queryKey: ['strategyDefinitions', 'eventDayConfig'],
    queryFn: async () => {
      const allStrategies = await strategyDefinitionService.getAll();
      // Tradable strategies only. (The CAPITAL product this used to exclude was retired in
      // V305 — every Product value is now a real, tradable product.)
      return allStrategies.filter((s: StrategyDefinition) =>
        s.status === 'ACTIVE' || s.status === 'WIND_DOWN'
      );
    },
  });

  // Prepare strategy options for react-select (main dropdown with "All" option)
  const strategyOptionsWithAll = useMemo(() => {
    const options = [{ value: 'ALL', label: 'All Strategies' }];
    if (strategies) {
      strategies.forEach((s: StrategyDefinition) => {
        options.push({
          value: s.strategyName,
          label: s.displayName || s.strategyName,
        });
      });
    }
    return options;
  }, [strategies]);

  // Prepare strategy options for react-select (modal dropdown without "All" option)
  const strategyOptions = useMemo(() => {
    if (!strategies) return [];
    return strategies.map((s: StrategyDefinition) => ({
      value: s.strategyName,
      label: s.displayName || s.strategyName,
    }));
  }, [strategies]);

  // Get selected strategy object for modal
  const selectedStrategyForModal = useMemo(() => {
    if (!newAction.strategyName || !strategies) return null;
    return strategies.find((s: StrategyDefinition) => s.strategyName === newAction.strategyName) || null;
  }, [newAction.strategyName, strategies]);

  // Helper to get display name for a strategy
  const getStrategyDisplayName = (strategyName: string) => {
    const strategy = strategies?.find((s: StrategyDefinition) => s.strategyName === strategyName);
    return strategy?.displayName || strategyName;
  };

  // Helper to get product for a strategy
  const getStrategyProduct = (strategyName: string) => {
    const strategy = strategies?.find((s: StrategyDefinition) => s.strategyName === strategyName);
    return strategy?.product || '';
  };

  // Fetch event days for selected strategy's exchange (for modal dropdown)
  const { data: eventDaysForModal } = useQuery({
    queryKey: ['eventDays', selectedStrategyForModal?.exchange],
    queryFn: () => eventDayService.getByExchange(selectedStrategyForModal!.exchange!),
    enabled: !!selectedStrategyForModal?.exchange,
  });

  // Fetch existing overrides for the strategy selected in the add modal.
  // This must be independent of the page-level selectedStrategy filter.
  const { data: modalStrategyActions } = useQuery({
    queryKey: ['strategyEventDayActions', 'modal', newAction.strategyName],
    queryFn: () => strategyEventDayActionService.getByStrategy(newAction.strategyName),
    enabled: !!newAction.strategyName,
  });

  // Update exchange when strategy is selected in modal
  useEffect(() => {
    if (selectedStrategyForModal) {
      setNewAction(prev => ({
        ...prev,
        exchangeCode: selectedStrategyForModal.exchange || '',
        eventDate: '', // Reset event date when strategy changes
      }));
    }
  }, [selectedStrategyForModal]);

  // Fetch strategy event day actions for selected strategy or all
  const { data: actions, isLoading, error } = useQuery({
    queryKey: ['strategyEventDayActions', selectedStrategy],
    queryFn: () => selectedStrategy === 'ALL'
      ? strategyEventDayActionService.getAll()
      : strategyEventDayActionService.getByStrategy(selectedStrategy),
    enabled: !!selectedStrategy,
  });

  const updateMutation = useMutation({
    mutationFn: ({ strategyName, eventDate, exchangeCode, capitalPercentage }: { strategyName: string; eventDate: string; exchangeCode: string; capitalPercentage: number }) =>
      strategyEventDayActionService.update(strategyName, eventDate, exchangeCode, { capitalPercentage }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['strategyEventDayActions', selectedStrategy] });
      setShowEditModal(false);
      setActionToEdit(null);
      toast.success('Strategy event day action updated successfully');
    },
    onError: (error: Error) => {
      toast.error(`Failed to update strategy event day action: ${error.message}`);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: ({ strategyName, eventDate, exchangeCode }: { strategyName: string; eventDate: string; exchangeCode: string }) =>
      strategyEventDayActionService.delete(strategyName, eventDate, exchangeCode),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['strategyEventDayActions', selectedStrategy] });
      setShowDeleteConfirm(false);
      setActionToDelete(null);
      toast.success('Strategy event day action deleted successfully');
    },
    onError: (error: Error) => {
      toast.error(`Failed to delete strategy event day action: ${error.message}`);
    },
  });

  const handleAddAction = async () => {
    if (!newAction.strategyName || !newAction.exchangeCode || !newAction.eventDate) {
      toast.error('Please fill in all required fields');
      return;
    }

    setIsCreating(true);
    try {
      await strategyEventDayActionService.create(newAction.strategyName, {
        eventDate: newAction.eventDate,
        exchangeCode: newAction.exchangeCode,
        capitalPercentage: newAction.capitalPercentage,
      });
      toast.success('Strategy event day action created successfully');
      queryClient.invalidateQueries({ queryKey: ['strategyEventDayActions'] });
      setShowAddModal(false);
      setNewAction({
        strategyName: '',
        exchangeCode: '',
        eventDate: '',
        capitalPercentage: 100,
      });
    } catch (err) {
      toast.error(`Failed to create: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
    setIsCreating(false);
  };

  const handleEditClick = (action: StrategyEventDayAction) => {
    setActionToEdit(action);
    setEditCapitalPercentage(action.capitalPercentage);
    setShowEditModal(true);
  };

  const handleSaveEdit = () => {
    if (actionToEdit) {
      updateMutation.mutate({
        strategyName: actionToEdit.strategyName,
        eventDate: actionToEdit.eventDate,
        exchangeCode: actionToEdit.exchangeCode,
        capitalPercentage: editCapitalPercentage,
      });
    }
  };

  // Get unique years from actions for year dropdown
  const availableYears = useMemo(() => {
    if (!actions || actions.length === 0) return [currentYear];
    const years = new Set<number>();
    actions.forEach(a => {
      const year = parseInt(a.eventDate.substring(0, 4), 10);
      if (!isNaN(year)) years.add(year);
    });
    years.add(currentYear);
    return Array.from(years).sort((a, b) => b - a);
  }, [actions]);

  // Filter actions by selected year
  const actionsList: StrategyEventDayAction[] = useMemo(() => {
    if (!actions) return [];
    return actions.filter(a => a.eventDate.startsWith(selectedYear.toString()));
  }, [actions, selectedYear]);

  // Filter event days for modal to exclude already configured ones and past dates
  const availableEventDays = useMemo(() => {
    if (!eventDaysForModal) return [];
    // Get existing event dates only for the strategy selected in the modal
    const existingDates = modalStrategyActions?.map(a => a.eventDate) || [];
    // Get today's date in YYYY-MM-DD format
    const today = new Date().toISOString().split('T')[0];
    // Filter out already configured event days and past dates, then sort descending
    return eventDaysForModal
      .filter(ed => !existingDates.includes(ed.eventDate) && ed.eventDate >= today)
      .sort((a, b) => b.eventDate.localeCompare(a.eventDate));
  }, [eventDaysForModal, modalStrategyActions]);

  const columns: Column<StrategyEventDayAction>[] = [
    ...(selectedStrategy === 'ALL' ? [{
      key: 'strategyName' as const,
      header: 'Strategy',
      render: (a: StrategyEventDayAction) => <span>{getStrategyDisplayName(a.strategyName)}</span>,
    },
    {
      key: 'product' as const,
      header: 'Product',
      render: (a: StrategyEventDayAction) => {
        const product = getStrategyProduct(a.strategyName);
        return <Badge bg={productBadgeBg(product)}>{product}</Badge>;
      },
    }] : []),
    {
      key: 'exchangeCode',
      header: 'Exchange',
      render: (a) => <Badge bg="secondary">{a.exchangeCode}</Badge>,
    },
    {
      key: 'eventDate',
      header: 'Event Date',
      render: (a) => (
        <div className="flex items-center gap-2">
          <BsCalendarEvent className="text-primary-700 dark:text-primary-400" />
          <span className="font-medium">{a.eventDate}</span>
        </div>
      ),
    },
    {
      key: 'capitalPercentage',
      header: 'Capital %',
      render: (a) => (
        <Badge bg={a.capitalPercentage < 100 ? 'warning' : 'success'}>
          {a.capitalPercentage}%
        </Badge>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      render: (a: StrategyEventDayAction) => {
        const today = new Date().toISOString().split('T')[0];
        const isPastDate = a.eventDate < today;
        return (
          <div className="flex gap-1">
            <Button
              variant="outline-primary"
              size="sm"
              disabled={isPastDate && !readOnly}
              title={isPastDate && !readOnly ? 'Cannot edit past event days' : (readOnly ? 'View' : 'Edit')}
              onClick={(ev) => {
                ev.stopPropagation();
                handleEditClick(a);
              }}
            >
              {readOnly ? <BsEye /> : <BsPencil />}
            </Button>
            {!hideDelete && (
              <Button
                variant="outline-danger"
                size="sm"
                disabled={isPastDate}
                title={isPastDate ? 'Cannot delete past event days' : 'Delete'}
                onClick={(ev) => {
                  ev.stopPropagation();
                  setActionToDelete(a);
                  setShowDeleteConfirm(true);
                }}
              >
                <BsTrash />
              </Button>
            )}
          </div>
        );
      },
    },
  ];

  if (error) {
    return <Alert variant="danger">Failed to load strategy event day actions</Alert>;
  }

  return (
    <>
      <div className="flex justify-between items-center mb-4">
        <div className="text-ink-soft text-[0.875em]">
          Strategy-specific capital percentage overrides for event days.
        </div>
        {!hideCreate && (
          <Button variant="primary" size="sm" onClick={() => setShowAddModal(true)}>
            <BsPlus className="me-1" /> Add Override
          </Button>
        )}
      </div>

      <Row className="mb-4">
        <Col md={4}>
          <Form.Group>
            <Form.Label>Select Strategy</Form.Label>
            <Select
              options={strategyOptionsWithAll}
              value={strategyOptionsWithAll.find(opt => opt.value === selectedStrategy) || strategyOptionsWithAll[0]}
              onChange={(selected) => setSelectedStrategy(selected?.value || 'ALL')}
              placeholder="Search and select strategy..."
              isSearchable
              classNamePrefix="react-select"
            />
          </Form.Group>
        </Col>
        {selectedStrategy && (
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
        )}
      </Row>

      <DataTable
        columns={columns}
        data={actionsList}
        loading={isLoading}
        keyExtractor={(a) => `${a.strategyName}-${a.exchangeCode}-${a.eventDate}`}
        emptyMessage={selectedStrategy === 'ALL' ? 'No event day overrides found' : 'No event day overrides found for this strategy'}
      />
      <div className="text-ink-soft text-[0.875em] mt-2">
        Total: {actionsList.length} override(s)
      </div>

      {/* Add Override Modal */}
      <Modal show={showAddModal} onHide={() => setShowAddModal(false)} backdrop="static">
        <Modal.Header closeButton>
          <Modal.Title>Add Strategy Event Day Override</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Form.Group className="mb-4">
            <Form.Label className="flex items-center">Strategy * <HelpIcon article={helpContent['eventDays.strategy.strategyName']} /></Form.Label>
            <Select
              options={strategyOptions}
              value={strategyOptions.find(opt => opt.value === newAction.strategyName) || null}
              onChange={(selected) => setNewAction({ ...newAction, strategyName: selected?.value || '' })}
              placeholder="Search and select strategy..."
              isClearable
              isSearchable
              classNamePrefix="react-select"
            />
          </Form.Group>
          <Form.Group className="mb-4">
            <Form.Label>Exchange</Form.Label>
            <Form.Control
              type="text"
              value={selectedStrategyForModal?.exchange || ''}
              disabled
              placeholder="Select a strategy first"
            />
          </Form.Group>
          <Form.Group className="mb-4">
            <Form.Label className="flex items-center">Event Date * <HelpIcon article={helpContent['eventDays.strategy.eventDate']} /></Form.Label>
            <Form.Select
              value={newAction.eventDate}
              onChange={(e) => setNewAction({ ...newAction, eventDate: e.target.value })}
              disabled={!selectedStrategyForModal}
            >
              <option value="">-- Select Event Date --</option>
              {availableEventDays.map((ed) => (
                <option key={ed.eventDate} value={ed.eventDate}>
                  {ed.eventDate} - {ed.eventName} ({ed.capitalPercentage}%)
                </option>
              ))}
            </Form.Select>
            {selectedStrategyForModal && availableEventDays.length === 0 && (
              <div className="text-ink-soft text-[0.875em] mt-1">
                No available event days for this exchange, or all have been configured.
              </div>
            )}
          </Form.Group>
          <Form.Group className="mb-4">
            <Form.Label className="flex items-center">Capital % (0-100) * <HelpIcon article={helpContent['eventDays.strategy.capitalPercentage']} /></Form.Label>
            <Form.Control
              type="number"
              min={0}
              max={100}
              value={newAction.capitalPercentage}
              onChange={(e) => setNewAction({
                ...newAction,
                capitalPercentage: Math.min(100, Math.max(0, Number(e.target.value))),
              })}
            />
          </Form.Group>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={() => setShowAddModal(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleAddAction}
            disabled={isCreating || !newAction.strategyName || !newAction.exchangeCode || !newAction.eventDate}
          >
            {isCreating ? 'Creating...' : 'Add Override'}
          </Button>
        </Modal.Footer>
      </Modal>

      {/* Edit/View Override Modal */}
      <Modal show={showEditModal} onHide={() => setShowEditModal(false)} backdrop={readOnly ? true : 'static'}>
        <Modal.Header closeButton>
          <Modal.Title>
            {readOnly ? <BsEye className="me-2" /> : <BsPencil className="me-2" />}
            {readOnly ? 'View' : 'Edit'} Strategy Event Day Override
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <fieldset disabled={readOnly}>
            <Form.Group className="mb-4">
              <Form.Label>Strategy</Form.Label>
              <Form.Control type="text" value={actionToEdit ? getStrategyDisplayName(actionToEdit.strategyName) : ''} disabled />
            </Form.Group>
            <Form.Group className="mb-4">
              <Form.Label>Exchange</Form.Label>
              <Form.Control type="text" value={actionToEdit?.exchangeCode || ''} disabled />
            </Form.Group>
            <Form.Group className="mb-4">
              <Form.Label>Event Date</Form.Label>
              <Form.Control type="text" value={actionToEdit?.eventDate || ''} disabled />
            </Form.Group>
            <Form.Group className="mb-4">
              <Form.Label className="flex items-center">Capital % (0-100) * <HelpIcon article={helpContent['eventDays.strategy.capitalPercentage']} /></Form.Label>
              <Form.Control
                type="number"
                min={0}
                max={100}
                value={editCapitalPercentage}
                onChange={(e) => setEditCapitalPercentage(Math.min(100, Math.max(0, Number(e.target.value))))}
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
        title="Delete Override"
        message={`Are you sure you want to delete the event day override for strategy "${actionToDelete ? getStrategyDisplayName(actionToDelete.strategyName) : ''}" on ${actionToDelete?.eventDate} (${actionToDelete?.exchangeCode})?`}
        confirmLabel="Delete"
        confirmVariant="danger"
        onConfirm={() => actionToDelete && deleteMutation.mutate({
          strategyName: actionToDelete.strategyName,
          eventDate: actionToDelete.eventDate,
          exchangeCode: actionToDelete.exchangeCode,
        })}
        onCancel={() => {
          setShowDeleteConfirm(false);
          setActionToDelete(null);
        }}
        isLoading={deleteMutation.isPending}
      />
    </>
  );
};

export default StrategyEventDays;
