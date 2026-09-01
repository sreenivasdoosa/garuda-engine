/**
 * BrokeragePlan Component
 * Modal for viewing/editing a single brokerage plan (parent table).
 * Plan rates (per segment+product) are managed separately.
 */

import { useState, useEffect, useMemo } from 'react';
import { Modal, Form, Row, Col, Button, Spinner } from '@/components/ui/rbShim';
import { BsPercent } from 'react-icons/bs';
import Select from 'react-select';
import { useQuery } from '@tanstack/react-query';
import { v2BrokerService } from '@/services/admin/v2AdminService';
import type { Broker } from '@/types/broker';
import type { BrokeragePlan as BrokeragePlanType, CreateBrokeragePlanRequest } from '@/types/billing';

export interface BrokeragePlanProps {
  /** Brokerage plan for edit mode, null for create mode */
  plan: BrokeragePlanType | null;
  /** Whether the modal is visible */
  show: boolean;
  /** Close modal callback */
  onClose: () => void;
  /** Save callback */
  onSave: (data: CreateBrokeragePlanRequest, isNew: boolean) => void;
  /** Whether save is in progress */
  isSaving?: boolean;
  /** Mode: 'view' | 'edit' | 'create' */
  mode?: 'view' | 'edit' | 'create';
}

const BrokeragePlan: React.FC<BrokeragePlanProps> = ({
  plan,
  show,
  onClose,
  onSave,
  isSaving = false,
  mode = plan ? 'edit' : 'create',
}) => {
  const isViewMode = mode === 'view';
  const isCreateMode = mode === 'create';

  const { data: brokers } = useQuery({
    queryKey: ['brokers'],
    queryFn: () => v2BrokerService.getAll(),
    staleTime: 10 * 60 * 1000,
  });

  const brokerOptions = useMemo(() => {
    return [
      { value: 'default', label: 'default (all brokers)' },
      ...((brokers || [])
        .filter((broker: Broker) => broker.enabled)
        .map((broker: Broker) => ({
          value: broker.name,
          label: `${broker.name}${broker.displayName ? ` - ${broker.displayName}` : ''}`,
        }))),
    ];
  }, [brokers]);

  const [formData, setFormData] = useState<CreateBrokeragePlanRequest>({
    planName: '',
    brokerName: 'default',
    description: '',
    planType: 'PER_TRADE',
    fixedFee: 0,
    billingPeriod: 'MONTHLY',
  });

  useEffect(() => {
    if (plan) {
      setFormData({
        planName: plan.planName,
        brokerName: plan.brokerName || 'default',
        description: plan.description || '',
        planType: plan.planType || 'PER_TRADE',
        fixedFee: plan.fixedFee || 0,
        billingPeriod: plan.billingPeriod || 'MONTHLY',
      });
    } else {
      setFormData({
        planName: '',
        brokerName: 'default',
        description: '',
        planType: 'PER_TRADE',
        fixedFee: 0,
        billingPeriod: 'MONTHLY',
      });
    }
  }, [plan, show]);

  const handleSubmit = () => {
    onSave(formData, isCreateMode);
  };

  const isFixedPeriod = formData.planType === 'FIXED_PERIOD';

  const getModalTitle = () => {
    if (isCreateMode) return 'Add New Brokerage Plan';
    if (isViewMode) return `Plan: ${plan?.planName}`;
    return `Edit Plan: ${plan?.planName}`;
  };

  return (
    <Modal show={show} onHide={onClose} size="lg" backdrop="static">
      <Modal.Header closeButton>
        <Modal.Title className="flex items-center gap-2">
          <BsPercent />
          {getModalTitle()}
        </Modal.Title>
      </Modal.Header>
      <Modal.Body>
        {isViewMode && plan ? (
          <Row className="">
            <Col md={6}>
              <label className="text-ink-soft text-[0.875em]">Plan Name</label>
              <div><code>{plan.planName}</code></div>
            </Col>
            <Col md={6}>
              <label className="text-ink-soft text-[0.875em]">Broker Name</label>
              <div className="font-medium">{plan.brokerName || 'default'}</div>
            </Col>
            <Col md={4}>
              <label className="text-ink-soft text-[0.875em]">Plan Type</label>
              <div className="font-medium">{plan.planType === 'FIXED_PERIOD' ? 'Fixed Period' : 'Per Trade'}</div>
            </Col>
            {plan.planType === 'FIXED_PERIOD' && (
              <>
                <Col md={4}>
                  <label className="text-ink-soft text-[0.875em]">Fixed Fee</label>
                  <div className="font-medium">{plan.fixedFee?.toLocaleString('en-IN')}</div>
                </Col>
                <Col md={4}>
                  <label className="text-ink-soft text-[0.875em]">Billing Period</label>
                  <div className="font-medium">{plan.billingPeriod}</div>
                </Col>
              </>
            )}
            <Col md={12}>
              <label className="text-ink-soft text-[0.875em]">Description</label>
              <div>{plan.description || '-'}</div>
            </Col>
          </Row>
        ) : (
          <Form>
            <Row>
              <Col md={6}>
                <Form.Group className="mb-4">
                  <Form.Label>Plan Name *</Form.Label>
                  <Form.Control
                    value={formData.planName}
                    onChange={(e) => setFormData({ ...formData, planName: e.target.value.toUpperCase().replace(/\s/g, '_') })}
                    disabled={!isCreateMode}
                    placeholder="e.g., DISCOUNT_BROKERAGE_PLAN"
                  />
                  <Form.Text className="text-ink-soft">
                    Unique identifier for the plan (no spaces allowed)
                  </Form.Text>
                </Form.Group>
              </Col>
              <Col md={6}>
                <Form.Group className="mb-4">
                  <Form.Label>Broker Name</Form.Label>
                  <Select
                    options={brokerOptions}
                    value={brokerOptions.find((option) => option.value === formData.brokerName) || brokerOptions[0]}
                    onChange={(selected) => setFormData({ ...formData, brokerName: selected?.value || 'default' })}
                    isSearchable
                    classNamePrefix="react-select"
                  />
                  <Form.Text className="text-ink-soft">
                    Broker this plan belongs to. Use &quot;default&quot; for plans applicable to all brokers.
                  </Form.Text>
                </Form.Group>
              </Col>
            </Row>
            <Row>
              <Col md={4}>
                <Form.Group className="mb-4">
                  <Form.Label>Plan Type *</Form.Label>
                  <Form.Select
                    value={formData.planType}
                    onChange={(e) => setFormData({ ...formData, planType: e.target.value as 'PER_TRADE' | 'FIXED_PERIOD' })}
                  >
                    <option value="PER_TRADE">Per Trade</option>
                    <option value="FIXED_PERIOD">Fixed Period</option>
                  </Form.Select>
                  <Form.Text className="text-ink-soft">
                    Per Trade: brokerage per trade. Fixed Period: flat monthly/quarterly fee.
                  </Form.Text>
                </Form.Group>
              </Col>
              {isFixedPeriod && (
                <>
                  <Col md={4}>
                    <Form.Group className="mb-4">
                      <Form.Label>Fixed Fee *</Form.Label>
                      <Form.Control
                        type="number"
                        value={formData.fixedFee}
                        onChange={(e) => setFormData({ ...formData, fixedFee: parseFloat(e.target.value) || 0 })}
                        placeholder="e.g., 5000"
                      />
                      <Form.Text className="text-ink-soft">
                        Fixed brokerage amount charged by the broker
                      </Form.Text>
                    </Form.Group>
                  </Col>
                  <Col md={4}>
                    <Form.Group className="mb-4">
                      <Form.Label>Billing Period *</Form.Label>
                      <Form.Select
                        value={formData.billingPeriod}
                        onChange={(e) => setFormData({ ...formData, billingPeriod: e.target.value as 'MONTHLY' | 'QUARTERLY' })}
                      >
                        <option value="MONTHLY">Monthly</option>
                        <option value="QUARTERLY">Quarterly</option>
                      </Form.Select>
                      <Form.Text className="text-ink-soft">
                        How often the broker charges this fee
                      </Form.Text>
                    </Form.Group>
                  </Col>
                </>
              )}
            </Row>
            <Row>
              <Col md={12}>
                <Form.Group className="mb-4">
                  <Form.Label>Description</Form.Label>
                  <Form.Control
                    as="textarea"
                    rows={2}
                    value={formData.description}
                    onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                    placeholder="Plan description"
                  />
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
          <Button variant="primary" onClick={handleSubmit} disabled={isSaving || !formData.planName}>
            {isSaving ? <><Spinner size="sm" className="me-1" />Saving...</> : (isCreateMode ? 'Add Plan' : 'Update')}
          </Button>
        )}
      </Modal.Footer>
    </Modal>
  );
};

export default BrokeragePlan;
