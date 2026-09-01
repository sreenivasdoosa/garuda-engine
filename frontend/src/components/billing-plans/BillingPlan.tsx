/**
 * BillingPlan Component
 * Modal for viewing/editing a single billing plan
 * Reusable across Admin portals
 */

import { useState, useEffect } from 'react';
import { Modal, Form, Row, Col, Button, Spinner, Badge } from '@/components/ui/rbShim';
import { BsCreditCard } from 'react-icons/bs';
import type { BillingPlan as BillingPlanType, CreateBillingPlanRequest } from '@/types/billing';
import HelpIcon from '@/components/common/HelpIcon';
import { billingHelpContent } from '@/data/help';

export interface BillingPlanProps {
  /** Billing plan for edit mode, null for create mode */
  plan: BillingPlanType | null;
  /** Whether the modal is visible */
  show: boolean;
  /** Close modal callback */
  onClose: () => void;
  /** Save callback */
  onSave: (data: CreateBillingPlanRequest, isNew: boolean) => void;
  /** Whether save is in progress */
  isSaving?: boolean;
  /** Mode: 'view' | 'edit' | 'create' */
  mode?: 'view' | 'edit' | 'create';
}

const BillingPlan: React.FC<BillingPlanProps> = ({
  plan,
  show,
  onClose,
  onSave,
  isSaving = false,
  mode = plan ? 'edit' : 'create',
}) => {
  const isViewMode = mode === 'view';
  const isCreateMode = mode === 'create';

  const [formData, setFormData] = useState<CreateBillingPlanRequest>({
    planName: '',
    billingPeriodDays: 90,
    fixedCostPercentage: 0,
    profitSharingPercentage: 20,
    noCostProfitSharingPercentage: 0,
    displayName: '',
    description: '',
  });

  useEffect(() => {
    if (plan) {
      setFormData({
        planName: plan.planName,
        billingPeriodDays: plan.billingPeriodDays,
        fixedCostPercentage: plan.fixedCostPercentage,
        profitSharingPercentage: plan.profitSharingPercentage,
        noCostProfitSharingPercentage: plan.noCostProfitSharingPercentage,
        displayName: plan.displayName || '',
        description: plan.description || '',
      });
    } else {
      setFormData({
        planName: '',
        billingPeriodDays: 90,
        fixedCostPercentage: 0,
        profitSharingPercentage: 20,
        noCostProfitSharingPercentage: 0,
        displayName: '',
        description: '',
      });
    }
  }, [plan, show]);

  const handleSubmit = () => {
    onSave(formData, isCreateMode);
  };

  const getModalTitle = () => {
    if (isCreateMode) return 'Add New Billing Plan';
    if (isViewMode) return `Plan: ${plan?.displayName || plan?.planName}`;
    return `Edit Plan: ${plan?.displayName || plan?.planName}`;
  };

  return (
    <Modal show={show} onHide={onClose} size="lg" backdrop="static">
      <Modal.Header closeButton>
        <Modal.Title className="flex items-center gap-2">
          <BsCreditCard />
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
              <label className="text-ink-soft text-[0.875em]">Display Name</label>
              <div className="font-medium">{plan.displayName || '-'}</div>
            </Col>
            <Col md={12}>
              <label className="text-ink-soft text-[0.875em]">Description</label>
              <div>{plan.description || '-'}</div>
            </Col>
            <Col md={6}>
              <label className="text-ink-soft text-[0.875em]">Billing Period</label>
              <div className="font-medium">{plan.billingPeriodDays} days</div>
            </Col>
            <Col md={6}>
              <label className="text-ink-soft text-[0.875em]">Fixed Cost %</label>
              <div>{plan.fixedCostPercentage}%</div>
            </Col>
            <Col md={6}>
              <label className="text-ink-soft text-[0.875em]">Profit Sharing %</label>
              <div className="font-medium">{plan.profitSharingPercentage}%</div>
            </Col>
            <Col md={6}>
              <label className="text-ink-soft text-[0.875em]">No Cost Profit Sharing %</label>
              <div>{plan.noCostProfitSharingPercentage}%</div>
            </Col>
            <Col md={6}>
              <label className="text-ink-soft text-[0.875em]">Status</label>
              <div>
                <Badge bg={plan.enabled !== false ? 'success' : 'secondary'}>
                  {plan.enabled !== false ? 'Enabled' : 'Disabled'}
                </Badge>
              </div>
            </Col>
          </Row>
        ) : (
          <Form>
            <Row>
              <Col md={6}>
                <Form.Group className="mb-4">
                  <Form.Label className="flex items-center">Plan Name * <HelpIcon article={billingHelpContent['billingPlan.planName']} /></Form.Label>
                  <Form.Control
                    value={formData.planName}
                    onChange={(e) => setFormData({ ...formData, planName: e.target.value.toUpperCase().replace(/\s/g, '_') })}
                    disabled={!isCreateMode}
                    placeholder="e.g., PS20_QTRLY"
                  />
                  <Form.Text className="text-ink-soft">
                    Unique identifier for the plan
                  </Form.Text>
                </Form.Group>
              </Col>
              <Col md={6}>
                <Form.Group className="mb-4">
                  <Form.Label className="flex items-center">Display Name <HelpIcon article={billingHelpContent['billingPlan.displayName']} /></Form.Label>
                  <Form.Control
                    value={formData.displayName}
                    onChange={(e) => setFormData({ ...formData, displayName: e.target.value })}
                    placeholder="e.g., Quarterly 20% PS Plan"
                  />
                </Form.Group>
              </Col>
            </Row>
            <Row>
              <Col md={12}>
                <Form.Group className="mb-4">
                  <Form.Label className="flex items-center">Description <HelpIcon article={billingHelpContent['billingPlan.description']} /></Form.Label>
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
            <Row>
              <Col md={6}>
                <Form.Group className="mb-4">
                  <Form.Label className="flex items-center">Billing Period (Days) * <HelpIcon article={billingHelpContent['billingPlan.billingPeriodDays']} /></Form.Label>
                  <Form.Control
                    type="number"
                    min={1}
                    value={formData.billingPeriodDays}
                    onChange={(e) => setFormData({ ...formData, billingPeriodDays: parseInt(e.target.value) || 30 })}
                  />
                  <Form.Text className="text-ink-soft">
                    e.g., 30 for monthly, 90 for quarterly, 365 for yearly
                  </Form.Text>
                </Form.Group>
              </Col>
              <Col md={6}>
                <Form.Group className="mb-4">
                  <Form.Label className="flex items-center">Fixed Cost % <HelpIcon article={billingHelpContent['billingPlan.fixedCostPercentage']} /></Form.Label>
                  <Form.Control
                    type="number"
                    min={0}
                    max={100}
                    step={0.1}
                    value={formData.fixedCostPercentage}
                    onChange={(e) => setFormData({ ...formData, fixedCostPercentage: parseFloat(e.target.value) || 0 })}
                  />
                </Form.Group>
              </Col>
            </Row>
            <Row>
              <Col md={6}>
                <Form.Group className="mb-4">
                  <Form.Label className="flex items-center">Profit Sharing % * <HelpIcon article={billingHelpContent['billingPlan.profitSharingPercentage']} /></Form.Label>
                  <Form.Control
                    type="number"
                    min={0}
                    max={100}
                    step={0.1}
                    value={formData.profitSharingPercentage}
                    onChange={(e) => setFormData({ ...formData, profitSharingPercentage: parseFloat(e.target.value) || 0 })}
                  />
                  <Form.Text className="text-ink-soft">
                    Percentage of profits shared
                  </Form.Text>
                </Form.Group>
              </Col>
              <Col md={6}>
                <Form.Group className="mb-4">
                  <Form.Label className="flex items-center">No Cost Profit Sharing % <HelpIcon article={billingHelpContent['billingPlan.noCostProfitSharingPercentage']} /></Form.Label>
                  <Form.Control
                    type="number"
                    min={0}
                    max={100}
                    step={0.1}
                    value={formData.noCostProfitSharingPercentage}
                    onChange={(e) => setFormData({ ...formData, noCostProfitSharingPercentage: parseFloat(e.target.value) || 0 })}
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
          <Button variant="primary" onClick={handleSubmit} disabled={isSaving}>
            {isSaving ? <><Spinner size="sm" className="me-1" />Saving...</> : (isCreateMode ? 'Add Plan' : 'Update')}
          </Button>
        )}
      </Modal.Footer>
    </Modal>
  );
};

export default BillingPlan;
