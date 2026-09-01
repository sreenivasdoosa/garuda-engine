/**
 * UserEventDays Component
 * Table for listing and managing user-specific event day capital percentage overrides
 * Uses V2 API: /api/v2/user-event-day-actions
 */

import { useState, useMemo } from 'react';
import { Button, Badge, Alert, Form, Row, Col, Modal } from '@/components/ui/rbShim';
import { BsPlus, BsTrash, BsCalendarEvent, BsPencil, BsEye } from 'react-icons/bs';
import { DataTable, ConfirmModal } from '@/components/common';
import type { Column } from '@/components/common';
import HelpIcon from '@/components/common/HelpIcon';
import { eventDaysHelpContent } from '@/data/help/event-days-help';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { userEventDayActionService, exchangeService, eventDayService, userManagementService } from '@/services/admin/v2AdminService';
import type { UserEventDayAction } from '@/services/admin/v2AdminService';
import { toast } from 'react-toastify';
import UserSelect from '@/components/common/UserSelect';

export interface UserEventDaysProps {
  /** Hide add button */
  hideCreate?: boolean;
  /** Hide delete button */
  hideDelete?: boolean;
  /** Read-only mode - shows View button instead of Edit */
  readOnly?: boolean;
}

interface CreateUserEventDayForm {
  username: string;
  exchangeCode: string;
  eventDate: string;
  capitalPercentage: number;
}

const currentYear = new Date().getFullYear();

const UserEventDays: React.FC<UserEventDaysProps> = ({
  hideCreate = false,
  hideDelete = false,
  readOnly = false,
}) => {
  const [selectedUser, setSelectedUser] = useState<string>('ALL');
  const [selectedYear, setSelectedYear] = useState<number>(currentYear);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [actionToDelete, setActionToDelete] = useState<UserEventDayAction | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [actionToEdit, setActionToEdit] = useState<UserEventDayAction | null>(null);
  const [newAction, setNewAction] = useState<CreateUserEventDayForm>({
    username: '',
    exchangeCode: '',
    eventDate: '',
    capitalPercentage: 100,
  });
  const [editCapitalPercentage, setEditCapitalPercentage] = useState(100);
  const [isCreating, setIsCreating] = useState(false);
  const queryClient = useQueryClient();

  const helpContent = eventDaysHelpContent;

  // Fetch users for display-name lookup (getUserDisplayName)
  const { data: users } = useQuery({
    queryKey: ['users'],
    queryFn: () => userManagementService.getUsers(),
  });

  // Fetch exchanges for dropdown
  const { data: exchanges } = useQuery({
    queryKey: ['exchanges'],
    queryFn: () => exchangeService.getAll(),
  });

  // Fetch event days for selected exchange in modal
  const { data: eventDaysForModal } = useQuery({
    queryKey: ['eventDays', newAction.exchangeCode],
    queryFn: () => eventDayService.getByExchange(newAction.exchangeCode),
    enabled: !!newAction.exchangeCode,
  });

  // Filter event days for modal - only today or future, sorted descending
  const availableEventDays = useMemo(() => {
    if (!eventDaysForModal) return [];
    const today = new Date().toISOString().split('T')[0];
    return eventDaysForModal
      .filter(ed => ed.eventDate >= today)
      .sort((a, b) => b.eventDate.localeCompare(a.eventDate));
  }, [eventDaysForModal]);

  // Fetch user event day actions for selected user or all
  const { data: actions, isLoading, error } = useQuery({
    queryKey: ['userEventDayActions', selectedUser],
    queryFn: () => selectedUser === 'ALL'
      ? userEventDayActionService.getAll()
      : userEventDayActionService.getByUser(selectedUser),
    enabled: !!selectedUser,
  });

  // Note: createMutation removed since add modal functionality is not wired up yet
  // When implementing add functionality, define: const createMutation = useMutation({ ... })

  const updateMutation = useMutation({
    mutationFn: ({ username, eventDate, exchangeCode, capitalPercentage }: { username: string; eventDate: string; exchangeCode: string; capitalPercentage: number }) =>
      userEventDayActionService.update(username, eventDate, exchangeCode, { capitalPercentage }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['userEventDayActions', selectedUser] });
      setShowEditModal(false);
      setActionToEdit(null);
      toast.success('User event day action updated successfully');
    },
    onError: (error: Error) => {
      toast.error(`Failed to update user event day action: ${error.message}`);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: ({ username, eventDate, exchangeCode }: { username: string; eventDate: string; exchangeCode: string }) =>
      userEventDayActionService.delete(username, eventDate, exchangeCode),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['userEventDayActions', selectedUser] });
      setShowDeleteConfirm(false);
      setActionToDelete(null);
      toast.success('User event day action deleted successfully');
    },
    onError: (error: Error) => {
      toast.error(`Failed to delete user event day action: ${error.message}`);
    },
  });

  const handleAddAction = async () => {
    if (!newAction.username || !newAction.exchangeCode || !newAction.eventDate) {
      toast.error('Please fill in all required fields');
      return;
    }

    setIsCreating(true);
    try {
      await userEventDayActionService.create(newAction.username, {
        eventDate: newAction.eventDate,
        exchangeCode: newAction.exchangeCode,
        capitalPercentage: newAction.capitalPercentage,
      });
      toast.success('User event day action created successfully');
      queryClient.invalidateQueries({ queryKey: ['userEventDayActions'] });
      setShowAddModal(false);
      setNewAction({
        username: '',
        exchangeCode: '',
        eventDate: '',
        capitalPercentage: 100,
      });
    } catch (err) {
      toast.error(`Failed to create: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
    setIsCreating(false);
  };

  const handleEditClick = (action: UserEventDayAction) => {
    setActionToEdit(action);
    setEditCapitalPercentage(action.capitalPercentage);
    setShowEditModal(true);
  };

  const handleSaveEdit = () => {
    if (actionToEdit) {
      updateMutation.mutate({
        username: actionToEdit.username,
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
  const actionsList: UserEventDayAction[] = useMemo(() => {
    if (!actions) return [];
    return actions.filter(a => a.eventDate.startsWith(selectedYear.toString()));
  }, [actions, selectedYear]);

  // Helper to get display name for a user
  const getUserDisplayName = (username: string) => {
    const user = users?.find(u => u.username === username);
    return user?.alias ? `${username} (${user.alias})` : username;
  };

  const columns: Column<UserEventDayAction>[] = [
    ...(selectedUser === 'ALL' ? [{
      key: 'username' as const,
      header: 'User',
      render: (a: UserEventDayAction) => <span>{getUserDisplayName(a.username)}</span>,
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
      render: (a: UserEventDayAction) => (
        <div className="flex gap-1">
          <Button
            variant="outline-primary"
            size="sm"
            onClick={(ev) => {
              ev.stopPropagation();
              handleEditClick(a);
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
                setActionToDelete(a);
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
    return <Alert variant="danger">Failed to load user event day actions</Alert>;
  }

  return (
    <>
      <div className="flex justify-between items-center mb-4">
        <div className="text-ink-soft text-[0.875em]">
          User-specific capital percentage overrides for event days.
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
            <Form.Label>Select User</Form.Label>
            <UserSelect
              value={selectedUser === 'ALL' ? '' : selectedUser}
              onChange={(username) => setSelectedUser(username || 'ALL')}
            />
          </Form.Group>
        </Col>
        {selectedUser && (
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
        keyExtractor={(a) => `${a.username}-${a.exchangeCode}-${a.eventDate}`}
        emptyMessage={selectedUser === 'ALL' ? 'No event day overrides found' : 'No event day overrides found for this user'}
      />
      <div className="text-ink-soft text-[0.875em] mt-2">
        Total: {actionsList.length} override(s)
      </div>

      {/* Add Override Modal */}
      <Modal show={showAddModal} onHide={() => setShowAddModal(false)} backdrop="static">
        <Modal.Header closeButton>
          <Modal.Title>Add User Event Day Override</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Form.Group className="mb-4">
            <Form.Label className="flex items-center">User * <HelpIcon article={helpContent['eventDays.user.username']} /></Form.Label>
            <UserSelect
              value={newAction.username}
              onChange={(username) => setNewAction({ ...newAction, username })}
              includeAllOption={false}
            />
          </Form.Group>
          <Form.Group className="mb-4">
            <Form.Label className="flex items-center">Exchange * <HelpIcon article={helpContent['eventDays.user.exchangeCode']} /></Form.Label>
            <Form.Select
              value={newAction.exchangeCode}
              onChange={(e) => setNewAction({ ...newAction, exchangeCode: e.target.value, eventDate: '' })}
            >
              <option value="">-- Select Exchange --</option>
              {exchanges?.map((ex) => (
                <option key={ex.exchange} value={ex.exchange}>
                  {ex.exchange} - {ex.exchangeName}
                </option>
              ))}
            </Form.Select>
          </Form.Group>
          <Form.Group className="mb-4">
            <Form.Label className="flex items-center">Event Date * <HelpIcon article={helpContent['eventDays.user.eventDate']} /></Form.Label>
            <Form.Select
              value={newAction.eventDate}
              onChange={(e) => setNewAction({ ...newAction, eventDate: e.target.value })}
              disabled={!newAction.exchangeCode}
            >
              <option value="">-- Select Event Date --</option>
              {availableEventDays.map((ed) => (
                <option key={ed.eventDate} value={ed.eventDate}>
                  {ed.eventDate} - {ed.eventName} ({ed.capitalPercentage}%)
                </option>
              ))}
            </Form.Select>
            {newAction.exchangeCode && availableEventDays.length === 0 && (
              <div className="text-ink-soft text-[0.875em] mt-1">
                No available event days for this exchange.
              </div>
            )}
          </Form.Group>
          <Form.Group className="mb-4">
            <Form.Label className="flex items-center">Capital % (0-100) * <HelpIcon article={helpContent['eventDays.user.capitalPercentage']} /></Form.Label>
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
            disabled={isCreating || !newAction.username || !newAction.exchangeCode || !newAction.eventDate}
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
            {readOnly ? 'View' : 'Edit'} User Event Day Override
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <fieldset disabled={readOnly}>
            <Form.Group className="mb-4">
              <Form.Label>User</Form.Label>
              <Form.Control type="text" value={actionToEdit?.username || ''} disabled />
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
              <Form.Label className="flex items-center">Capital % (0-100) * <HelpIcon article={helpContent['eventDays.user.capitalPercentage']} /></Form.Label>
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
        message={`Are you sure you want to delete the event day override for user "${actionToDelete?.username}" on ${actionToDelete?.eventDate} (${actionToDelete?.exchangeCode})?`}
        confirmLabel="Delete"
        confirmVariant="danger"
        onConfirm={() => actionToDelete && deleteMutation.mutate({
          username: actionToDelete.username,
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

export default UserEventDays;
