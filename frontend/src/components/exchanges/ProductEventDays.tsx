/**
 * ProductEventDays Component
 * Table for listing and managing product-specific event day capital percentage overrides
 * Uses V2 API: /api/v2/product-event-day-actions
 */

import { useState, useMemo } from 'react';
import { Button, Badge, Alert, Form, Row, Col, Modal } from '@/components/ui/rbShim';
import { BsPlus, BsTrash, BsCalendarEvent, BsPencil, BsEye } from 'react-icons/bs';
import { DataTable, ConfirmModal } from '@/components/common';
import type { Column } from '@/components/common';
import HelpIcon from '@/components/common/HelpIcon';
import { eventDaysHelpContent } from '@/data/help/event-days-help';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { productEventDayActionService, exchangeService, eventDayService } from '@/services/admin/v2AdminService';
import type { ProductEventDayAction } from '@/services/admin/v2AdminService';
import { TRADABLE_PRODUCTS, PRODUCT_LABELS, type Product } from '@/types/product';
import { toast } from 'react-toastify';
import Select from 'react-select';

export interface ProductEventDaysProps {
  hideCreate?: boolean;
  hideDelete?: boolean;
  readOnly?: boolean;
}

interface CreateProductEventDayForm {
  product: Product | '';
  exchangeCode: string;
  eventDate: string;
  capitalPercentage: number;
}

const currentYear = new Date().getFullYear();
// Every engine-managed product (MTF was missing, so no MTF capital override could be created)
const PRODUCT_OPTIONS: Array<{ value: Product; label: string }> = [
  ...TRADABLE_PRODUCTS.map((value): { value: Product; label: string } => ({ value, label: PRODUCT_LABELS[value] })),
];

const ProductEventDays: React.FC<ProductEventDaysProps> = ({
  hideCreate = false,
  hideDelete = false,
  readOnly = false,
}) => {
  const [selectedProduct, setSelectedProduct] = useState<string>('ALL');
  const [selectedYear, setSelectedYear] = useState<number>(currentYear);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [actionToDelete, setActionToDelete] = useState<ProductEventDayAction | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [actionToEdit, setActionToEdit] = useState<ProductEventDayAction | null>(null);
  const [newAction, setNewAction] = useState<CreateProductEventDayForm>({
    product: '',
    exchangeCode: '',
    eventDate: '',
    capitalPercentage: 100,
  });
  const [editCapitalPercentage, setEditCapitalPercentage] = useState(100);
  const [isCreating, setIsCreating] = useState(false);
  const queryClient = useQueryClient();

  const helpContent = eventDaysHelpContent;

  const productOptionsWithAll = useMemo(() => [{ value: 'ALL', label: 'All Products' }, ...PRODUCT_OPTIONS], []);

  const { data: exchanges } = useQuery({
    queryKey: ['exchanges'],
    queryFn: () => exchangeService.getAll(),
  });

  const { data: eventDaysForModal } = useQuery({
    queryKey: ['eventDays', newAction.exchangeCode],
    queryFn: () => eventDayService.getByExchange(newAction.exchangeCode),
    enabled: !!newAction.exchangeCode,
  });

  const { data: modalProductActions } = useQuery({
    queryKey: ['productEventDayActions', 'modal', newAction.product],
    queryFn: () => productEventDayActionService.getByProduct(newAction.product),
    enabled: !!newAction.product,
  });

  const availableEventDays = useMemo(() => {
    if (!eventDaysForModal) return [];
    const today = new Date().toISOString().split('T')[0];
    return eventDaysForModal
      .filter((ed) => {
        if (ed.eventDate < today) {
          return false;
        }
        return !(modalProductActions || []).some(
          (action) => action.exchangeCode === newAction.exchangeCode && action.eventDate === ed.eventDate
        );
      })
      .sort((a, b) => b.eventDate.localeCompare(a.eventDate));
  }, [eventDaysForModal, modalProductActions, newAction.exchangeCode]);

  const { data: actions, isLoading, error } = useQuery({
    queryKey: ['productEventDayActions', selectedProduct],
    queryFn: () => selectedProduct === 'ALL'
      ? productEventDayActionService.getAll()
      : productEventDayActionService.getByProduct(selectedProduct),
    enabled: !!selectedProduct,
  });

  const updateMutation = useMutation({
    mutationFn: ({ product, eventDate, exchangeCode, capitalPercentage }: { product: string; eventDate: string; exchangeCode: string; capitalPercentage: number }) =>
      productEventDayActionService.update(product, eventDate, exchangeCode, { capitalPercentage }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['productEventDayActions', selectedProduct] });
      setShowEditModal(false);
      setActionToEdit(null);
      toast.success('Product event day action updated successfully');
    },
    onError: (error: Error) => {
      toast.error(`Failed to update product event day action: ${error.message}`);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: ({ product, eventDate, exchangeCode }: { product: string; eventDate: string; exchangeCode: string }) =>
      productEventDayActionService.delete(product, eventDate, exchangeCode),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['productEventDayActions', selectedProduct] });
      setShowDeleteConfirm(false);
      setActionToDelete(null);
      toast.success('Product event day action deleted successfully');
    },
    onError: (error: Error) => {
      toast.error(`Failed to delete product event day action: ${error.message}`);
    },
  });

  const handleAddAction = async () => {
    if (!newAction.product || !newAction.exchangeCode || !newAction.eventDate) {
      toast.error('Please fill in all required fields');
      return;
    }

    setIsCreating(true);
    try {
      await productEventDayActionService.create(newAction.product, {
        eventDate: newAction.eventDate,
        exchangeCode: newAction.exchangeCode,
        capitalPercentage: newAction.capitalPercentage,
      });
      toast.success('Product event day action created successfully');
      queryClient.invalidateQueries({ queryKey: ['productEventDayActions'] });
      setShowAddModal(false);
      setNewAction({
        product: '',
        exchangeCode: '',
        eventDate: '',
        capitalPercentage: 100,
      });
    } catch (err) {
      toast.error(`Failed to create: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
    setIsCreating(false);
  };

  const handleEditClick = (action: ProductEventDayAction) => {
    setActionToEdit(action);
    setEditCapitalPercentage(action.capitalPercentage);
    setShowEditModal(true);
  };

  const handleSaveEdit = () => {
    if (actionToEdit) {
      updateMutation.mutate({
        product: actionToEdit.product,
        eventDate: actionToEdit.eventDate,
        exchangeCode: actionToEdit.exchangeCode,
        capitalPercentage: editCapitalPercentage,
      });
    }
  };

  const availableYears = useMemo(() => {
    if (!actions || actions.length === 0) return [currentYear];
    const years = new Set<number>();
    actions.forEach((a) => {
      const year = parseInt(a.eventDate.substring(0, 4), 10);
      if (!isNaN(year)) years.add(year);
    });
    years.add(currentYear);
    return Array.from(years).sort((a, b) => b - a);
  }, [actions]);

  const actionsList: ProductEventDayAction[] = useMemo(() => {
    if (!actions) return [];
    return actions.filter((a) => a.eventDate.startsWith(selectedYear.toString()));
  }, [actions, selectedYear]);

  const getProductDisplayName = (product: string) => {
    return PRODUCT_OPTIONS.find((option) => option.value === product)?.label || product;
  };

  const columns: Column<ProductEventDayAction>[] = [
    ...(selectedProduct === 'ALL' ? [{
      key: 'product' as const,
      header: 'Product',
      render: (a: ProductEventDayAction) => <Badge bg="dark">{getProductDisplayName(a.product)}</Badge>,
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
      render: (a: ProductEventDayAction) => {
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
    return <Alert variant="danger">Failed to load product event day actions</Alert>;
  }

  return (
    <>
      <div className="flex justify-between items-center mb-4">
        <div className="text-ink-soft text-[0.875em]">
          Product-specific capital percentage overrides for event days.
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
            <Form.Label>Select Product</Form.Label>
            <Select
              options={productOptionsWithAll}
              value={productOptionsWithAll.find((opt) => opt.value === selectedProduct) || productOptionsWithAll[0]}
              onChange={(selected) => setSelectedProduct(selected?.value || 'ALL')}
              placeholder="Search and select product..."
              isSearchable
              classNamePrefix="react-select"
            />
          </Form.Group>
        </Col>
        {selectedProduct && (
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
        keyExtractor={(a) => `${a.product}-${a.exchangeCode}-${a.eventDate}`}
        emptyMessage={selectedProduct === 'ALL' ? 'No event day overrides found' : 'No event day overrides found for this product'}
      />
      <div className="text-ink-soft text-[0.875em] mt-2">
        Total: {actionsList.length} override(s)
      </div>

      <Modal show={showAddModal} onHide={() => setShowAddModal(false)} backdrop="static">
        <Modal.Header closeButton>
          <Modal.Title>Add Product Event Day Override</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Form.Group className="mb-4">
            <Form.Label className="flex items-center">Product * <HelpIcon article={helpContent['eventDays.product.product']} /></Form.Label>
            <Select
              options={PRODUCT_OPTIONS}
              value={PRODUCT_OPTIONS.find((opt) => opt.value === newAction.product) || null}
              onChange={(selected) => setNewAction({ ...newAction, product: selected?.value || '', eventDate: '' })}
              placeholder="Search and select product..."
              isClearable
              isSearchable
              classNamePrefix="react-select"
            />
          </Form.Group>
          <Form.Group className="mb-4">
            <Form.Label className="flex items-center">Exchange * <HelpIcon article={helpContent['eventDays.product.exchangeCode']} /></Form.Label>
            <Form.Select
              value={newAction.exchangeCode}
              onChange={(e) => setNewAction({ ...newAction, exchangeCode: e.target.value, eventDate: '' })}
            >
              <option value="">-- Select Exchange --</option>
              {exchanges?.map((exchange) => (
                <option key={exchange.exchange} value={exchange.exchange}>
                  {exchange.exchange}
                </option>
              ))}
            </Form.Select>
          </Form.Group>
          <Form.Group className="mb-4">
            <Form.Label className="flex items-center">Event Date * <HelpIcon article={helpContent['eventDays.product.eventDate']} /></Form.Label>
            <Form.Select
              value={newAction.eventDate}
              onChange={(e) => setNewAction({ ...newAction, eventDate: e.target.value })}
              disabled={!newAction.product || !newAction.exchangeCode}
            >
              <option value="">-- Select Event Date --</option>
              {availableEventDays.map((ed) => (
                <option key={ed.eventDate} value={ed.eventDate}>
                  {ed.eventDate} - {ed.eventName} ({ed.capitalPercentage}%)
                </option>
              ))}
            </Form.Select>
            {newAction.product && newAction.exchangeCode && availableEventDays.length === 0 && (
              <div className="text-ink-soft text-[0.875em] mt-1">
                No available event days for this exchange, or all have been configured for this product.
              </div>
            )}
          </Form.Group>
          <Form.Group className="mb-4">
            <Form.Label className="flex items-center">Capital % (0-100) * <HelpIcon article={helpContent['eventDays.product.capitalPercentage']} /></Form.Label>
            <Form.Control
              type="number"
              min={0}
              max={100}
              value={newAction.capitalPercentage}
              onChange={(e) => setNewAction({ ...newAction, capitalPercentage: Number(e.target.value) })}
            />
          </Form.Group>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={() => setShowAddModal(false)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={handleAddAction} disabled={isCreating}>
            {isCreating ? 'Creating...' : 'Add Override'}
          </Button>
        </Modal.Footer>
      </Modal>

      <Modal show={showEditModal} onHide={() => setShowEditModal(false)} backdrop="static">
        <Modal.Header closeButton>
          <Modal.Title>{readOnly ? 'View' : 'Edit'} Product Event Day Override</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Form.Group className="mb-4">
            <Form.Label>Product</Form.Label>
            <Form.Control type="text" value={actionToEdit ? getProductDisplayName(actionToEdit.product) : ''} disabled />
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
            <Form.Label className="flex items-center">Capital % (0-100) * <HelpIcon article={helpContent['eventDays.product.capitalPercentage']} /></Form.Label>
            <Form.Control
              type="number"
              min={0}
              max={100}
              value={editCapitalPercentage}
              onChange={(e) => setEditCapitalPercentage(Number(e.target.value))}
              disabled={readOnly}
            />
          </Form.Group>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={() => setShowEditModal(false)}>
            {readOnly ? 'Close' : 'Cancel'}
          </Button>
          {!readOnly && (
            <Button variant="primary" onClick={handleSaveEdit} disabled={updateMutation.isPending}>
              Save Changes
            </Button>
          )}
        </Modal.Footer>
      </Modal>

      <ConfirmModal
        show={showDeleteConfirm}
        title="Delete Product Event Day Override"
        message={`Are you sure you want to delete the event day override for product "${actionToDelete ? getProductDisplayName(actionToDelete.product) : ''}" on ${actionToDelete?.eventDate} (${actionToDelete?.exchangeCode})?`}
        confirmLabel="Delete"
        confirmVariant="danger"
        onConfirm={() => actionToDelete && deleteMutation.mutate({
          product: actionToDelete.product,
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

export default ProductEventDays;
