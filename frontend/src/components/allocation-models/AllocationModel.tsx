/**
 * AllocationModel Component
 * Modal for viewing/editing a single allocation model
 * Reusable across Admin portals
 */

import { useState, useEffect } from 'react';
import { Modal, Form, Row, Col, Button, Spinner, Badge } from '@/components/ui/rbShim';
import { BsPieChart } from 'react-icons/bs';
import type { AllocationModel as AllocationModelType, CreateAllocationModelRequest } from '@/types/billing';
import HelpIcon from '@/components/common/HelpIcon';
import { allocationHelpContent } from '@/data/help';

export interface AllocationModelProps {
  /** Allocation model for edit mode, null for create mode */
  model: AllocationModelType | null;
  /** Whether the modal is visible */
  show: boolean;
  /** Close modal callback */
  onClose: () => void;
  /** Save callback */
  onSave: (data: CreateAllocationModelRequest, isNew: boolean) => void;
  /** Whether save is in progress */
  isSaving?: boolean;
  /** Mode: 'view' | 'edit' | 'create' */
  mode?: 'view' | 'edit' | 'create';
}

const formatCurrency = (value: number): string => {
  if (value >= 10000000) {
    return `${(value / 10000000).toFixed(2)} Cr`;
  } else if (value >= 100000) {
    return `${(value / 100000).toFixed(2)} L`;
  } else if (value >= 1000) {
    return `${(value / 1000).toFixed(1)} K`;
  }
  return value.toString();
};

const AllocationModel: React.FC<AllocationModelProps> = ({
  model,
  show,
  onClose,
  onSave,
  isSaving = false,
  mode = model ? 'edit' : 'create',
}) => {
  const isViewMode = mode === 'view';
  const isCreateMode = mode === 'create';

  const [formData, setFormData] = useState<CreateAllocationModelRequest>({
    name: '',
    capital: 0,
    intradayCapital: 0,
    positionalCapital: 0,
  });

  useEffect(() => {
    if (model) {
      setFormData({
        name: model.name,
        capital: model.capital,
        intradayCapital: model.intradayCapital,
        positionalCapital: model.positionalCapital,
      });
    } else {
      setFormData({
        name: '',
        capital: 0,
        intradayCapital: 0,
        positionalCapital: 0,
      });
    }
  }, [model, show]);

  const handleSubmit = () => {
    onSave(formData, isCreateMode);
  };

  const getModalTitle = () => {
    if (isCreateMode) return 'Add New Allocation Model';
    if (isViewMode) return `Model: ${model?.name}`;
    return `Edit Model: ${model?.name}`;
  };

  // Auto-calculate total capital when intraday/positional change
  const handleCapitalChange = (field: 'intradayCapital' | 'positionalCapital', value: number) => {
    const newFormData = { ...formData, [field]: value };
    newFormData.capital = newFormData.intradayCapital + newFormData.positionalCapital;
    setFormData(newFormData);
  };

  return (
    <Modal show={show} onHide={onClose} size="lg" backdrop="static">
      <Modal.Header closeButton>
        <Modal.Title className="flex items-center gap-2">
          <BsPieChart />
          {getModalTitle()}
        </Modal.Title>
      </Modal.Header>
      <Modal.Body>
        {isViewMode && model ? (
          <Row className="">
            <Col md={12}>
              <label className="text-ink-soft text-[0.875em]">Name</label>
              <div className="font-medium">{model.name}</div>
            </Col>
            <Col md={4}>
              <label className="text-ink-soft text-[0.875em]">Total Capital</label>
              <div><Badge bg="primary" className="text-base">{formatCurrency(model.capital)}</Badge></div>
            </Col>
            <Col md={4}>
              <label className="text-ink-soft text-[0.875em]">Intraday Capital</label>
              <div><Badge bg="info" className="text-base">{formatCurrency(model.intradayCapital)}</Badge></div>
            </Col>
            <Col md={4}>
              <label className="text-ink-soft text-[0.875em]">Positional Capital</label>
              <div><Badge bg="success" className="text-base">{formatCurrency(model.positionalCapital)}</Badge></div>
            </Col>
            <Col md={12}>
              <label className="text-ink-soft text-[0.875em]">Mapped Strategies</label>
              <div>
                {model.strategiesList && model.strategiesList.length > 0 ? (
                  model.strategiesList.map((s) => (
                    <Badge key={s} bg="secondary" className="me-1">{s}</Badge>
                  ))
                ) : (
                  <span className="text-ink-soft">No strategies mapped</span>
                )}
              </div>
            </Col>
          </Row>
        ) : (
          <Form>
            <Row>
              <Col md={12}>
                <Form.Group className="mb-4">
                  <Form.Label className="flex items-center">Name * <HelpIcon article={allocationHelpContent['allocation.name']} /></Form.Label>
                  <Form.Control
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    placeholder="e.g., Retail, Broker, Personal"
                  />
                  <Form.Text className="text-ink-soft">
                    Unique identifier for the allocation model.
                    {!isCreateMode && ' Renaming re-points all user-broker, strategy-mapping and day-allocation references (applied atomically).'}
                  </Form.Text>
                </Form.Group>
              </Col>
            </Row>
            <Row>
              <Col md={6}>
                <Form.Group className="mb-4">
                  <Form.Label className="flex items-center">Intraday Capital * <HelpIcon article={allocationHelpContent['allocation.intradayCapital']} /></Form.Label>
                  <Form.Control
                    type="number"
                    min={0}
                    value={formData.intradayCapital}
                    onChange={(e) => handleCapitalChange('intradayCapital', Number(e.target.value))}
                    placeholder="e.g., 2200000"
                  />
                </Form.Group>
              </Col>
              <Col md={6}>
                <Form.Group className="mb-4">
                  <Form.Label className="flex items-center">Positional Capital * <HelpIcon article={allocationHelpContent['allocation.positionalCapital']} /></Form.Label>
                  <Form.Control
                    type="number"
                    min={0}
                    value={formData.positionalCapital}
                    onChange={(e) => handleCapitalChange('positionalCapital', Number(e.target.value))}
                    placeholder="e.g., 1400000"
                  />
                </Form.Group>
              </Col>
            </Row>
            <Row>
              <Col md={6}>
                <Form.Group className="mb-4">
                  <Form.Label className="flex items-center">Total Capital <HelpIcon article={allocationHelpContent['allocation.capital']} /></Form.Label>
                  <Form.Control
                    type="number"
                    value={formData.capital}
                    disabled
                    className="bg-raised"
                  />
                  <Form.Text className="text-ink-soft">
                    Auto-calculated: Intraday + Positional
                  </Form.Text>
                </Form.Group>
              </Col>
            </Row>
          </Form>
        )}
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={onClose}>
          {isViewMode ? 'Close' : 'Cancel'}
        </Button>
        {!isViewMode && (
          <Button variant="primary" onClick={handleSubmit} disabled={isSaving || !formData.name}>
            {isSaving ? <><Spinner size="sm" className="me-1" />Saving...</> : (isCreateMode ? 'Add Model' : 'Update')}
          </Button>
        )}
      </Modal.Footer>
    </Modal>
  );
};

export default AllocationModel;
