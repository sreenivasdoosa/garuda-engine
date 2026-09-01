/**
 * BrokeragePlanRateModal Component
 * Modal for viewing/editing a single brokerage plan rate (segment+product).
 */

import { useState, useEffect } from 'react';
import { Modal, Form, Row, Col, Button, Spinner } from '@/components/ui/rbShim';
import type { BrokeragePlanRate, CreateBrokeragePlanRateRequest } from '@/types/billing';

export interface BrokeragePlanRateModalProps {
  rate: BrokeragePlanRate | null;
  planName: string;
  show: boolean;
  onClose: () => void;
  onSave: (data: CreateBrokeragePlanRateRequest, isNew: boolean) => void;
  isSaving?: boolean;
  mode?: 'view' | 'edit' | 'create';
}

const SEGMENT_TYPES = ['EQUITY', 'FUTURES', 'OPTIONS'];
const PRODUCT_TYPES = ['INTRADAY', 'POSITIONAL', 'DELIVERY'];
const UNIT_TYPES = [
  { value: 'order', label: 'Per Order' },
  { value: 'lot', label: 'Per Lot' },
];

const BrokeragePlanRateModal: React.FC<BrokeragePlanRateModalProps> = ({
  rate,
  planName,
  show,
  onClose,
  onSave,
  isSaving = false,
  mode = rate ? 'edit' : 'create',
}) => {
  const isViewMode = mode === 'view';
  const isCreateMode = mode === 'create';

  const [formData, setFormData] = useState<CreateBrokeragePlanRateRequest>({
    planName,
    segment: 'EQUITY',
    product: 'INTRADAY',
    unitType: 'order',
    ratePerUnit: 0,
    brokeragePct: 0,
  });

  useEffect(() => {
    if (rate) {
      setFormData({
        planName: rate.planName,
        segment: rate.segment,
        product: rate.product,
        unitType: rate.unitType,
        ratePerUnit: rate.ratePerUnit,
        brokeragePct: rate.brokeragePct,
      });
    } else {
      setFormData({
        planName,
        segment: 'EQUITY',
        product: 'INTRADAY',
        unitType: 'order',
        ratePerUnit: 0,
        brokeragePct: 0,
      });
    }
  }, [rate, planName, show]);

  const handleSubmit = () => {
    onSave(formData, isCreateMode);
  };

  const getModalTitle = () => {
    if (isCreateMode) return `Add Rate to ${planName}`;
    if (isViewMode) return `Rate: ${rate?.segment} / ${rate?.product}`;
    return `Edit Rate: ${rate?.segment} / ${rate?.product}`;
  };

  const getBrokerageDescription = () => {
    if (formData.brokeragePct > 0) {
      return `Brokerage = min(turnover × ${formData.brokeragePct}% / 100, ₹${formData.ratePerUnit}) — equity style`;
    }
    if (formData.ratePerUnit > 0) {
      return `Flat ₹${formData.ratePerUnit} per ${formData.unitType} — FnO style`;
    }
    return 'Zero brokerage — delivery style';
  };

  return (
    <Modal show={show} onHide={onClose} size="lg" backdrop="static">
      <Modal.Header closeButton>
        <Modal.Title>{getModalTitle()}</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        {isViewMode && rate ? (
          <Row className="">
            <Col md={4}>
              <label className="text-ink-soft text-[0.875em]">Segment</label>
              <div className="font-medium">{rate.segment}</div>
            </Col>
            <Col md={4}>
              <label className="text-ink-soft text-[0.875em]">Product</label>
              <div className="font-medium">{rate.product}</div>
            </Col>
            <Col md={4}>
              <label className="text-ink-soft text-[0.875em]">Unit Type</label>
              <div className="font-medium">Per {rate.unitType}</div>
            </Col>
            <Col md={4}>
              <label className="text-ink-soft text-[0.875em]">Rate Per Unit (Rs)</label>
              <div className="font-medium">₹{rate.ratePerUnit}</div>
            </Col>
            <Col md={4}>
              <label className="text-ink-soft text-[0.875em]">Brokerage %</label>
              <div className="font-medium">{rate.brokeragePct}%</div>
            </Col>
            <Col md={12}>
              <small className="text-ink-soft">{getBrokerageDescription()}</small>
            </Col>
          </Row>
        ) : (
          <Form>
            <Row>
              <Col md={6}>
                <Form.Group className="mb-4">
                  <Form.Label>Segment *</Form.Label>
                  <Form.Select
                    value={formData.segment}
                    onChange={(e) => setFormData({ ...formData, segment: e.target.value })}
                    disabled={!isCreateMode}
                  >
                    {SEGMENT_TYPES.map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </Form.Select>
                </Form.Group>
              </Col>
              <Col md={6}>
                <Form.Group className="mb-4">
                  <Form.Label>Product *</Form.Label>
                  <Form.Select
                    value={formData.product}
                    onChange={(e) => setFormData({ ...formData, product: e.target.value })}
                    disabled={!isCreateMode}
                  >
                    {PRODUCT_TYPES.map((p) => (
                      <option key={p} value={p}>{p}</option>
                    ))}
                  </Form.Select>
                </Form.Group>
              </Col>
            </Row>
            <Row>
              <Col md={4}>
                <Form.Group className="mb-4">
                  <Form.Label>Unit Type *</Form.Label>
                  <Form.Select
                    value={formData.unitType}
                    onChange={(e) => setFormData({ ...formData, unitType: e.target.value as 'order' | 'lot' })}
                  >
                    {UNIT_TYPES.map((t) => (
                      <option key={t.value} value={t.value}>{t.label}</option>
                    ))}
                  </Form.Select>
                </Form.Group>
              </Col>
              <Col md={4}>
                <Form.Group className="mb-4">
                  <Form.Label>Rate Per Unit (Rs) *</Form.Label>
                  <Form.Control
                    type="number"
                    step="0.01"
                    min={0}
                    value={formData.ratePerUnit}
                    onChange={(e) => setFormData({ ...formData, ratePerUnit: parseFloat(e.target.value) || 0 })}
                  />
                  <Form.Text className="text-ink-soft">
                    Flat fee per {formData.unitType}, or cap when % is set
                  </Form.Text>
                </Form.Group>
              </Col>
              <Col md={4}>
                <Form.Group className="mb-4">
                  <Form.Label>Brokerage %</Form.Label>
                  <Form.Control
                    type="number"
                    step="0.001"
                    min={0}
                    value={formData.brokeragePct}
                    onChange={(e) => setFormData({ ...formData, brokeragePct: parseFloat(e.target.value) || 0 })}
                  />
                  <Form.Text className="text-ink-soft">
                    % of turnover (0 = flat fee only)
                  </Form.Text>
                </Form.Group>
              </Col>
            </Row>
            <div className="p-2 bg-raised rounded-md">
              <small className="text-ink-soft">{getBrokerageDescription()}</small>
            </div>
          </Form>
        )}
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={onClose}>
          {isViewMode ? 'Close' : 'Cancel'}
        </Button>
        {!isViewMode && (
          <Button variant="primary" onClick={handleSubmit} disabled={isSaving || !formData.segment || !formData.product}>
            {isSaving ? <><Spinner size="sm" className="me-1" />Saving...</> : (isCreateMode ? 'Add Rate' : 'Update')}
          </Button>
        )}
      </Modal.Footer>
    </Modal>
  );
};

export default BrokeragePlanRateModal;
