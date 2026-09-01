/**
 * StatutoryCharge Component
 * Modal for viewing/editing a single statutory charge entry
 */

import { useState, useEffect } from 'react';
import { Modal, Form, Row, Col, Button, Spinner } from '@/components/ui/rbShim';
import { BsPercent } from 'react-icons/bs';
import type { StatutoryCharges as StatutoryChargesType, CreateStatutoryChargesRequest } from '@/types/billing';
import { useQuery } from '@tanstack/react-query';
import { exchangeService } from '@/services/admin/v2AdminService';

export interface StatutoryChargeProps {
  charge: StatutoryChargesType | null;
  show: boolean;
  onClose: () => void;
  onSave: (data: CreateStatutoryChargesRequest, isNew: boolean) => void;
  isSaving?: boolean;
  mode?: 'view' | 'edit' | 'create';
}

const SEGMENT_TYPES = ['EQUITY', 'FUTURES', 'OPTIONS'];
const PRODUCT_TYPES = ['INTRADAY', 'POSITIONAL', 'DELIVERY'];

const StatutoryCharge: React.FC<StatutoryChargeProps> = ({
  charge,
  show,
  onClose,
  onSave,
  isSaving = false,
  mode = charge ? 'edit' : 'create',
}) => {
  const isViewMode = mode === 'view';
  const isCreateMode = mode === 'create';

  const { data: exchanges } = useQuery({
    queryKey: ['exchanges'],
    queryFn: () => exchangeService.getAll(),
  });

  const [formData, setFormData] = useState<CreateStatutoryChargesRequest>({
    exchange: '',
    segment: 'EQUITY',
    product: 'INTRADAY',
    sttBuyPct: 0,
    sttSellPct: 0,
    exchangeTxnPct: 0,
    sebiChargesPct: 0,
    stampDutyBuyPct: 0,
    stampDutySellPct: 0,
    gstPct: 18,
    depositoryCharges: 0,
  });

  useEffect(() => {
    if (charge) {
      setFormData({
        exchange: charge.exchange,
        segment: charge.segment,
        product: charge.product,
        sttBuyPct: charge.sttBuyPct,
        sttSellPct: charge.sttSellPct,
        exchangeTxnPct: charge.exchangeTxnPct,
        sebiChargesPct: charge.sebiChargesPct,
        stampDutyBuyPct: charge.stampDutyBuyPct,
        stampDutySellPct: charge.stampDutySellPct,
        gstPct: charge.gstPct,
        depositoryCharges: charge.depositoryCharges,
      });
    } else {
      setFormData({
        exchange: '',
        segment: 'EQUITY',
        product: 'INTRADAY',
        sttBuyPct: 0,
        sttSellPct: 0,
        exchangeTxnPct: 0,
        sebiChargesPct: 0,
        stampDutyBuyPct: 0,
        stampDutySellPct: 0,
        gstPct: 18,
        depositoryCharges: 0,
      });
    }
  }, [charge, show]);

  const handleSubmit = () => {
    onSave(formData, isCreateMode);
  };

  const getModalTitle = () => {
    if (isCreateMode) return 'Add Statutory Charges';
    if (isViewMode) return `Charges: ${charge?.exchange}/${charge?.segment}/${charge?.product}`;
    return `Edit: ${charge?.exchange}/${charge?.segment}/${charge?.product}`;
  };

  const updateField = (field: keyof CreateStatutoryChargesRequest, value: string | number) => {
    setFormData({ ...formData, [field]: value });
  };

  const renderNumberField = (label: string, field: keyof CreateStatutoryChargesRequest, step = '0.00001') => (
    <Col md={4}>
      <Form.Group className="mb-4">
        <Form.Label className="text-[0.875em]">{label}</Form.Label>
        {isViewMode ? (
          <div className="font-medium">{String(formData[field])}</div>
        ) : (
          <Form.Control
            type="number"
            step={step}
            min={0}
            value={formData[field]}
            onChange={(e) => updateField(field, parseFloat(e.target.value) || 0)}
            size="sm"
          />
        )}
      </Form.Group>
    </Col>
  );

  return (
    <Modal show={show} onHide={onClose} size="lg" backdrop="static">
      <Modal.Header closeButton>
        <Modal.Title className="flex items-center gap-2">
          <BsPercent />
          {getModalTitle()}
        </Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <Form>
          <Row>
            <Col md={4}>
              <Form.Group className="mb-4">
                <Form.Label className="text-[0.875em]">Exchange *</Form.Label>
                {isCreateMode ? (
                  <Form.Select
                    value={formData.exchange}
                    onChange={(e) => updateField('exchange', e.target.value)}
                    size="sm"
                  >
                    <option value="">Select Exchange</option>
                    {exchanges?.map((ex) => (
                      <option key={ex.exchange} value={ex.exchange}>{ex.exchange}</option>
                    ))}
                  </Form.Select>
                ) : (
                  <div><code>{formData.exchange}</code></div>
                )}
              </Form.Group>
            </Col>
            <Col md={4}>
              <Form.Group className="mb-4">
                <Form.Label className="text-[0.875em]">Segment *</Form.Label>
                {isCreateMode ? (
                  <Form.Select
                    value={formData.segment}
                    onChange={(e) => updateField('segment', e.target.value)}
                    size="sm"
                  >
                    {SEGMENT_TYPES.map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </Form.Select>
                ) : (
                  <div><code>{formData.segment}</code></div>
                )}
              </Form.Group>
            </Col>
            <Col md={4}>
              <Form.Group className="mb-4">
                <Form.Label className="text-[0.875em]">Product *</Form.Label>
                {isCreateMode ? (
                  <Form.Select
                    value={formData.product}
                    onChange={(e) => updateField('product', e.target.value)}
                    size="sm"
                  >
                    {PRODUCT_TYPES.map((p) => (
                      <option key={p} value={p}>{p}</option>
                    ))}
                  </Form.Select>
                ) : (
                  <div><code>{formData.product}</code></div>
                )}
              </Form.Group>
            </Col>
          </Row>

          <hr />
          <h6 className="text-ink-soft mb-4">STT (%)</h6>
          <Row>
            {renderNumberField('STT Buy %', 'sttBuyPct')}
            {renderNumberField('STT Sell %', 'sttSellPct')}
          </Row>

          <h6 className="text-ink-soft mb-4">Exchange & SEBI (%)</h6>
          <Row>
            {renderNumberField('Exchange Txn %', 'exchangeTxnPct')}
            {renderNumberField('SEBI Charges %', 'sebiChargesPct')}
          </Row>

          <h6 className="text-ink-soft mb-4">Stamp Duty (%)</h6>
          <Row>
            {renderNumberField('Stamp Duty Buy %', 'stampDutyBuyPct')}
            {renderNumberField('Stamp Duty Sell %', 'stampDutySellPct')}
          </Row>

          <h6 className="text-ink-soft mb-4">GST & Others</h6>
          <Row>
            {renderNumberField('GST %', 'gstPct', '0.01')}
            {renderNumberField('DP Charges (flat Rs)', 'depositoryCharges', '0.01')}
          </Row>
        </Form>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={onClose}>
          {isViewMode ? 'Close' : 'Cancel'}
        </Button>
        {!isViewMode && (
          <Button
            variant="primary"
            onClick={handleSubmit}
            disabled={isSaving || !formData.exchange}
          >
            {isSaving ? <><Spinner size="sm" className="me-1" />Saving...</> : (isCreateMode ? 'Add Charges' : 'Update')}
          </Button>
        )}
      </Modal.Footer>
    </Modal>
  );
};

export default StatutoryCharge;
