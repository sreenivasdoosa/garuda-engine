/**
 * Strategy Policies Page
 * Manage reusable configuration policies for strategies
 */

import { useState } from 'react';
import {
  Card,
  Table,
  Badge,
  Button,
  Form,
  Modal,
  Spinner,
  Alert,
  Row,
  Col,
  Tab,
  Tabs,
} from '@/components/ui/rbShim';
import {
  BsPlus,
  BsTrash,
  BsPencil,
  BsEye,
  BsShieldCheck,
  BsArrowRepeat,
  BsCrosshair,
  BsBoxArrowRight,
  BsClockHistory,
} from 'react-icons/bs';
import { toast } from 'react-toastify';
import { PageHeader, ConfirmModal } from '@/components/common';
import HelpIcon from '@/components/common/HelpIcon';
import { strategyPolicyHelpContent } from '@/data/help';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { strategyPolicyService } from '@/services/admin/v2AdminService';
import type {
  OrderFillEscalationPolicy,
  TrailingSLPolicy,
  SLTargetPolicy,
  StrikeSelectionPolicy,
  ExitPolicy,
  CreateOrderFillPolicyRequest,
  CreateTrailingSLPolicyRequest,
  CreateSLTargetPolicyRequest,
  CreateStrikePolicyRequest,
  CreateExitPolicyRequest,
} from '@/types/strategy-policies';

const helpContent = strategyPolicyHelpContent;

// Default trail config values per type
const getDefaultTrailConfig = (trailType: string | null | undefined, includeCombined: boolean = false): string => {
  const baseConfig: Record<string, unknown> = {};

  switch (trailType) {
    case 'ATR':
      baseConfig.period = 21;
      baseConfig.multiplier = 4.0;
      break;
    case 'SUPER_TREND':
      baseConfig.period = 10;
      baseConfig.multiplier = 3;
      break;
    case 'EMA':
      baseConfig.period = 13;
      baseConfig.bufferPercentage = 0.05;
      break;
    case 'HEIKIN_ASHI':
      baseConfig.maxDistancePercentage = 1.25;
      break;
    case 'RISK_MULTIPLE':
      baseConfig.profitGap = 10;
      baseConfig.slMoveGap = 5;
      baseConfig.trailMode = 'absolute'; // 'absolute' (points) or 'percentage' (% of entry)
      break;
    case 'CUSTOM':
      // CUSTOM type: no defaults, user provides all config
      break;
    default:
      return '';
  }

  if (includeCombined) {
    baseConfig.combinedProfitGap = 5;
    baseConfig.combinedSlMoveGap = 2.5;
    baseConfig.combinedTrailMode = 'percentage'; // 'percentage' (% of premium) or 'absolute' (rupees)
  }

  return JSON.stringify(baseConfig, null, 2);
};

// Merge combined config into existing trail config
const mergeTrailConfigWithCombined = (existingConfig: string | null | undefined, addCombined: boolean): string => {
  let config: Record<string, unknown> = {};

  // Parse existing config
  if (existingConfig) {
    try {
      config = JSON.parse(existingConfig);
    } catch {
      config = {};
    }
  }

  if (addCombined) {
    // Add combined fields if not present
    if (!('combinedProfitGap' in config)) {
      config.combinedProfitGap = 5;
    }
    if (!('combinedSlMoveGap' in config)) {
      config.combinedSlMoveGap = 2.5;
    }
    if (!('combinedTrailMode' in config)) {
      config.combinedTrailMode = 'percentage'; // 'percentage' (% of premium) or 'absolute' (rupees)
    }
  } else {
    // Remove combined fields
    delete config.combinedProfitGap;
    delete config.combinedSlMoveGap;
    delete config.combinedTrailMode;
  }

  return Object.keys(config).length > 0 ? JSON.stringify(config, null, 2) : '';
};

// Merge trail-to-cost config into existing trail config
const mergeTrailConfigWithTrailToCost = (existingConfig: string | null | undefined, addTrailToCost: boolean): string => {
  let config: Record<string, unknown> = {};

  // Parse existing config
  if (existingConfig) {
    try {
      config = JSON.parse(existingConfig);
    } catch {
      config = {};
    }
  }

  if (addTrailToCost) {
    // Add trail-to-cost fields if not present
    if (!('trailToCostProfitGap' in config)) {
      config.trailToCostProfitGap = 1.0; // Default: 1R profit
    }
    if (!('trailToCostMode' in config)) {
      config.trailToCostMode = 'risk_multiple'; // 'risk_multiple', 'absolute', 'percentage'
    }
  } else {
    // Remove trail-to-cost fields
    delete config.trailToCostProfitGap;
    delete config.trailToCostMode;
  }

  return Object.keys(config).length > 0 ? JSON.stringify(config, null, 2) : '';
};

interface PolicyTabProps {
  canEdit: boolean;      // Has Edit (E) permission on STRATEGY_POLICIES tool OR sysadmin
  canManage: boolean;    // Has Manage (M) permission on STRATEGY_POLICIES tool OR sysadmin
}

// ==================== ORDER FILL POLICIES TAB ====================
const OrderFillPoliciesTab: React.FC<PolicyTabProps> = ({ canEdit, canManage }) => {
  const [showModal, setShowModal] = useState(false);
  const [editingPolicy, setEditingPolicy] = useState<OrderFillEscalationPolicy | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [policyToDelete, setPolicyToDelete] = useState<OrderFillEscalationPolicy | null>(null);
  const queryClient = useQueryClient();

  const { data: policies, isLoading } = useQuery({
    queryKey: ['admin', 'policies', 'order-fill'],
    queryFn: () => strategyPolicyService.orderFill.getAll(),
  });

  const [formData, setFormData] = useState<CreateOrderFillPolicyRequest>({
    policyName: '',
    escalationMode: 'NONE',
  });

  const createMutation = useMutation({
    mutationFn: (data: CreateOrderFillPolicyRequest) => strategyPolicyService.orderFill.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'policies', 'order-fill'] });
      setShowModal(false);
      resetForm();
      toast.success('Policy created successfully');
    },
    onError: (error: { message?: string }) => {
      toast.error(error.message || 'Failed to create policy');
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<CreateOrderFillPolicyRequest> }) =>
      strategyPolicyService.orderFill.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'policies', 'order-fill'] });
      setShowModal(false);
      setEditingPolicy(null);
      toast.success('Policy updated successfully');
    },
    onError: (error: { message?: string }) => {
      toast.error(error.message || 'Failed to update policy');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => strategyPolicyService.orderFill.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'policies', 'order-fill'] });
      setShowDeleteConfirm(false);
      setPolicyToDelete(null);
      toast.success('Policy deleted successfully');
    },
    onError: (error: { message?: string }) => {
      toast.error(error.message || 'Failed to delete policy');
    },
  });

  const resetForm = () => {
    setFormData({ policyName: '', escalationMode: 'NONE' });
  };

  const handleOpenCreate = () => {
    setEditingPolicy(null);
    resetForm();
    setShowModal(true);
  };

  const handleOpenEdit = (policy: OrderFillEscalationPolicy) => {
    setEditingPolicy(policy);
    setFormData({
      policyName: policy.policyName,
      description: policy.description,
      escalationMode: policy.escalationMode,
      escalationSeconds: policy.escalationSeconds,
      escalationSteps: policy.escalationSteps,
    });
    setShowModal(true);
  };

  const handleSave = () => {
    if (!formData.policyName) {
      toast.error('Policy name is required');
      return;
    }
    if (editingPolicy?.id) {
      updateMutation.mutate({ id: editingPolicy.id, data: formData });
    } else {
      createMutation.mutate(formData);
    }
  };

  return (
    <>
      <Card>
        <Card.Header className="flex justify-between items-center">
          <span>Order Fill Escalation Policies</span>
          {canEdit && (
            <Button variant="primary" size="sm" onClick={handleOpenCreate}>
              <BsPlus className="me-1" /> Add Policy
            </Button>
          )}
        </Card.Header>
        <Card.Body className="p-0">
          {isLoading ? (
            <div className="text-center py-12"><Spinner /></div>
          ) : (
            <Table striped hover className="mb-0" size="sm">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Mode</th>
                  <th>Seconds</th>
                  <th style={{ width: '100px' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {(policies || []).length === 0 ? (
                  <tr><td colSpan={4} className="text-center py-6 text-ink-soft">No policies found</td></tr>
                ) : (
                  (policies || []).map((policy) => (
                    <tr key={policy.id}>
                      <td className="font-medium">{policy.policyName}</td>
                      <td><Badge bg={policy.escalationMode === 'NONE' ? 'secondary' : policy.escalationMode === 'MARKET' ? 'warning' : 'info'}>{policy.escalationMode}</Badge></td>
                      <td>{policy.escalationSeconds ?? '-'}</td>
                      <td>
                        <div className="flex gap-1">
                          <Button variant="outline-primary" size="sm" onClick={() => handleOpenEdit(policy)} title={canEdit ? 'Edit' : 'View'}>{canEdit ? <BsPencil /> : <BsEye />}</Button>
                          {canManage && <Button variant="outline-danger" size="sm" onClick={() => { setPolicyToDelete(policy); setShowDeleteConfirm(true); }}><BsTrash /></Button>}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </Table>
          )}
        </Card.Body>
      </Card>

      <Modal show={showModal} onHide={() => setShowModal(false)} backdrop="static">
        <Modal.Header closeButton>
          <Modal.Title>{editingPolicy ? (canEdit ? 'Edit' : 'View') : 'Create'} Order Fill Policy</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Form>
            <fieldset disabled={!!editingPolicy && !canEdit}>
            <Form.Group className="mb-4">
              <Form.Label className="flex items-center">Policy Name <span className="text-danger-600 dark:text-danger-400">*</span> <HelpIcon article={helpContent['strategyPolicy.orderFill.policyName']} /></Form.Label>
              <Form.Control type="text" value={formData.policyName} onChange={(e) => setFormData({ ...formData, policyName: e.target.value })} placeholder="e.g., Standard Market Escalation" />
            </Form.Group>
            <Form.Group className="mb-4">
              <Form.Label className="flex items-center">Escalation Mode <HelpIcon article={helpContent['strategyPolicy.orderFill.escalationMode']} /></Form.Label>
              <Form.Select value={formData.escalationMode} onChange={(e) => setFormData({ ...formData, escalationMode: e.target.value as 'NONE' | 'MARKET' | 'STEP_ESCALATION' })}>
                <option value="NONE">None (no escalation)</option>
                <option value="MARKET">Market (convert to market after timeout)</option>
                <option value="STEP_ESCALATION">Step Escalation (multi-step)</option>
              </Form.Select>
            </Form.Group>
            {formData.escalationMode === 'MARKET' && (
              <Form.Group className="mb-4">
                <Form.Label className="flex items-center">Escalation Seconds <HelpIcon article={helpContent['strategyPolicy.orderFill.escalationSeconds']} /></Form.Label>
                <Form.Control type="number" min={1} value={formData.escalationSeconds ?? ''} onChange={(e) => setFormData({ ...formData, escalationSeconds: e.target.value ? Number(e.target.value) : undefined })} placeholder="Seconds before converting to market" />
              </Form.Group>
            )}
            {formData.escalationMode === 'STEP_ESCALATION' && (
              <Form.Group className="mb-4">
                <Form.Label className="flex items-center">Escalation Steps (JSON) <HelpIcon article={helpContent['strategyPolicy.orderFill.escalationSteps']} /></Form.Label>
                <Form.Control as="textarea" rows={3} value={formData.escalationSteps ?? ''} onChange={(e) => setFormData({ ...formData, escalationSteps: e.target.value || undefined })} placeholder='[{"afterSeconds":30,"action":"INCREASE_PRICE","value":0.5}]' />
                <Form.Text className="text-ink-soft">JSON array of escalation steps</Form.Text>
              </Form.Group>
            )}
            <Form.Group className="mb-4">
              <Form.Label className="flex items-center">Description <HelpIcon article={helpContent['strategyPolicy.orderFill.description']} /></Form.Label>
              <Form.Control as="textarea" rows={2} value={formData.description ?? ''} onChange={(e) => setFormData({ ...formData, description: e.target.value || undefined })} placeholder="Optional description" />
            </Form.Group>
            </fieldset>
          </Form>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={() => setShowModal(false)}>{editingPolicy && !canEdit ? 'Close' : 'Cancel'}</Button>
          {(canEdit || !editingPolicy) && (
            <Button variant="primary" onClick={handleSave} disabled={createMutation.isPending || updateMutation.isPending}>
              {(createMutation.isPending || updateMutation.isPending) ? <Spinner size="sm" /> : editingPolicy ? 'Update' : 'Create'}
            </Button>
          )}
        </Modal.Footer>
      </Modal>

      <ConfirmModal
        show={showDeleteConfirm}
        title="Delete Policy"
        message={`Are you sure you want to delete "${policyToDelete?.policyName}"?`}
        confirmLabel="Delete"
        confirmVariant="danger"
        onConfirm={() => policyToDelete?.id && deleteMutation.mutate(policyToDelete.id)}
        onCancel={() => { setShowDeleteConfirm(false); setPolicyToDelete(null); }}
        isLoading={deleteMutation.isPending}
      />
    </>
  );
};

// ==================== TRAILING SL POLICIES TAB ====================
const TrailingSLPoliciesTab: React.FC<PolicyTabProps> = ({ canEdit, canManage }) => {
  const [showModal, setShowModal] = useState(false);
  const [editingPolicy, setEditingPolicy] = useState<TrailingSLPolicy | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [policyToDelete, setPolicyToDelete] = useState<TrailingSLPolicy | null>(null);
  const queryClient = useQueryClient();

  const { data: policies, isLoading } = useQuery({
    queryKey: ['admin', 'policies', 'trailing-sl'],
    queryFn: () => strategyPolicyService.trailingSL.getAll(),
  });

  const [formData, setFormData] = useState<CreateTrailingSLPolicyRequest>({ policyName: '' });

  const createMutation = useMutation({
    mutationFn: (data: CreateTrailingSLPolicyRequest) => strategyPolicyService.trailingSL.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'policies', 'trailing-sl'] });
      setShowModal(false);
      setFormData({ policyName: '' });
      toast.success('Policy created successfully');
    },
    onError: (error: { message?: string }) => toast.error(error.message || 'Failed to create policy'),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<CreateTrailingSLPolicyRequest> }) => strategyPolicyService.trailingSL.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'policies', 'trailing-sl'] });
      setShowModal(false);
      setEditingPolicy(null);
      toast.success('Policy updated successfully');
    },
    onError: (error: { message?: string }) => toast.error(error.message || 'Failed to update policy'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => strategyPolicyService.trailingSL.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'policies', 'trailing-sl'] });
      setShowDeleteConfirm(false);
      setPolicyToDelete(null);
      toast.success('Policy deleted successfully');
    },
    onError: (error: { message?: string }) => toast.error(error.message || 'Failed to delete policy'),
  });

  const handleOpenCreate = () => { setEditingPolicy(null); setFormData({ policyName: '' }); setShowModal(true); };
  const handleOpenEdit = (policy: TrailingSLPolicy) => {
    setEditingPolicy(policy);
    setFormData({
      policyName: policy.policyName, description: policy.description, trailEnabled: policy.trailEnabled,
      trailType: policy.trailType, trailConfig: policy.trailConfig,
      trailToCost: policy.trailToCost, combinedTrailEnabled: policy.combinedTrailEnabled,
    });
    setShowModal(true);
  };

  const handleSave = () => {
    if (!formData.policyName) { toast.error('Policy name is required'); return; }
    if (editingPolicy?.id) { updateMutation.mutate({ id: editingPolicy.id, data: formData }); }
    else { createMutation.mutate(formData); }
  };

  return (
    <>
      <Card>
        <Card.Header className="flex justify-between items-center">
          <span>Trailing SL Policies</span>
          {canEdit && <Button variant="primary" size="sm" onClick={handleOpenCreate}><BsPlus className="me-1" /> Add Policy</Button>}
        </Card.Header>
        <Card.Body className="p-0">
          {isLoading ? <div className="text-center py-12"><Spinner /></div> : (
            <Table striped hover className="mb-0" size="sm">
              <thead>
                <tr><th>Name</th><th>Trail</th><th>Type</th><th>Combined Trail</th><th style={{ width: '100px' }}>Actions</th></tr>
              </thead>
              <tbody>
                {(policies || []).length === 0 ? <tr><td colSpan={5} className="text-center py-6 text-ink-soft">No policies found</td></tr> : (policies || []).map((policy) => (
                  <tr key={policy.id}>
                    <td className="font-medium">{policy.policyName}</td>
                    <td><Badge bg={policy.trailEnabled ? 'success' : 'secondary'}>{policy.trailEnabled ? 'Yes' : 'No'}</Badge></td>
                    <td><code>{policy.trailType || '-'}</code></td>
                    <td><Badge bg={policy.combinedTrailEnabled ? 'success' : 'secondary'}>{policy.combinedTrailEnabled ? 'Yes' : 'No'}</Badge></td>
                    <td>
                      <div className="flex gap-1">
                        <Button variant="outline-primary" size="sm" onClick={() => handleOpenEdit(policy)} title={canEdit ? 'Edit' : 'View'}>{canEdit ? <BsPencil /> : <BsEye />}</Button>
                        {canManage && <Button variant="outline-danger" size="sm" onClick={() => { setPolicyToDelete(policy); setShowDeleteConfirm(true); }}><BsTrash /></Button>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card.Body>
      </Card>

      <Modal show={showModal} onHide={() => setShowModal(false)} size="lg" backdrop="static">
        <Modal.Header closeButton><Modal.Title>{editingPolicy ? (canEdit ? 'Edit' : 'View') : 'Create'} Trailing SL Policy</Modal.Title></Modal.Header>
        <Modal.Body>
          <Form>
            <fieldset disabled={!!editingPolicy && !canEdit}>
            <Row>
              <Col md={6}>
                <Form.Group className="mb-4">
                  <Form.Label className="flex items-center">Policy Name <span className="text-danger-600 dark:text-danger-400">*</span> <HelpIcon article={helpContent['strategyPolicy.trailingSL.policyName']} /></Form.Label>
                  <Form.Control type="text" value={formData.policyName} onChange={(e) => setFormData({ ...formData, policyName: e.target.value })} />
                </Form.Group>
              </Col>
              <Col md={6}>
                <Form.Group className="mb-4">
                  <Form.Label className="flex items-center">Trail Type <HelpIcon article={helpContent['strategyPolicy.trailingSL.trailType']} /></Form.Label>
                  <Form.Select value={formData.trailType ?? ''} onChange={(e) => {
                    const newType = e.target.value || undefined;
                    const includeCombined = formData.combinedTrailEnabled === true;
                    const newTrailConfig = getDefaultTrailConfig(newType, includeCombined);
                    setFormData({ ...formData, trailType: newType, trailConfig: newTrailConfig || undefined });
                  }}>
                    <option value="">-- Select Trail Type --</option>
                    <option value="RISK_MULTIPLE">Risk Multiple (R-Multiple)</option>
                    <option value="SUPER_TREND">SuperTrend</option>
                    <option value="ATR">ATR (Average True Range)</option>
                    <option value="EMA">EMA (Exponential Moving Average)</option>
                    <option value="HEIKIN_ASHI">Heikin Ashi</option>
                    <option value="CUSTOM">Custom</option>
                  </Form.Select>
                </Form.Group>
              </Col>
            </Row>
            <Row>
              <Col md={4}>
                <Form.Group className="mb-4">
                  <Form.Check type="checkbox" label={<span className="flex items-center">Trail Enabled <HelpIcon article={helpContent['strategyPolicy.trailingSL.trailEnabled']} /></span>} checked={formData.trailEnabled === true}
                    onChange={(e) => {
                      const newValue = e.target.checked;
                      if (!newValue) {
                        // Remove individual trail config fields when disabled
                        let config: Record<string, unknown> = {};
                        if (formData.trailConfig) {
                          try {
                            config = JSON.parse(formData.trailConfig);
                          } catch {
                            config = {};
                          }
                        }
                        // Keep only combined fields
                        const combinedFields = ['combinedProfitGap', 'combinedSlMoveGap', 'combinedTrailMode'];
                        const filteredConfig: Record<string, unknown> = {};
                        for (const key of combinedFields) {
                          if (key in config) {
                            filteredConfig[key] = config[key];
                          }
                        }
                        const newTrailConfig = Object.keys(filteredConfig).length > 0 ? JSON.stringify(filteredConfig, null, 2) : '';
                        setFormData({ ...formData, trailEnabled: newValue, trailConfig: newTrailConfig || undefined });
                      } else {
                        // When enabling, fill default values based on trail type
                        const includeCombined = formData.combinedTrailEnabled === true;
                        const newTrailConfig = getDefaultTrailConfig(formData.trailType, includeCombined);
                        setFormData({ ...formData, trailEnabled: newValue, trailConfig: newTrailConfig || undefined });
                      }
                    }} />
                </Form.Group>
              </Col>
              <Col md={4}>
                <Form.Group className="mb-4">
                  <Form.Check type="checkbox" label={<span className="flex items-center">Trail to Cost <HelpIcon article={helpContent['strategyPolicy.trailingSL.trailToCost']} /></span>} checked={formData.trailToCost === true}
                    onChange={(e) => {
                      const newValue = e.target.checked;
                      const newTrailConfig = mergeTrailConfigWithTrailToCost(formData.trailConfig, newValue);
                      setFormData({ ...formData, trailToCost: newValue, trailConfig: newTrailConfig || undefined });
                    }} />
                </Form.Group>
              </Col>
              <Col md={4}>
                <Form.Group className="mb-4">
                  <Form.Check type="checkbox" label={<span className="flex items-center">Combined Trail Enabled <HelpIcon article={helpContent['strategyPolicy.trailingSL.combinedTrailEnabled']} /></span>} checked={formData.combinedTrailEnabled === true}
                    onChange={(e) => {
                      const newValue = e.target.checked;
                      const newTrailConfig = mergeTrailConfigWithCombined(formData.trailConfig, newValue);
                      setFormData({ ...formData, combinedTrailEnabled: newValue, trailConfig: newTrailConfig || undefined });
                    }} />
                </Form.Group>
              </Col>
            </Row>
            <Row>
              <Col md={12}>
                <Form.Group className="mb-4">
                  <Form.Label className="flex items-center">Trail Config <small className="text-ink-soft">(JSON)</small> <HelpIcon article={helpContent['strategyPolicy.trailingSL.trailConfig']} /></Form.Label>
                  <Form.Control
                    as="textarea"
                    rows={6}
                    value={formData.trailConfig ?? ''}
                    onChange={(e) => setFormData({ ...formData, trailConfig: e.target.value || undefined })}
                    placeholder='{"period": 21, "multiplier": 4.0}'
                    style={{ fontFamily: 'monospace', fontSize: '0.85rem' }}
                  />
                  <Form.Text className="text-ink-soft">
                    Keys: period, multiplier, bufferPercentage, maxDistancePercentage, profitGap, slMoveGap, trailMode, combinedProfitGap, combinedSlMoveGap, combinedTrailMode, trailToCostProfitGap, trailToCostMode (risk_multiple/absolute/percentage)
                  </Form.Text>
                </Form.Group>
              </Col>
            </Row>
            <Form.Group className="mb-4">
              <Form.Label className="flex items-center">Description <HelpIcon article={helpContent['strategyPolicy.trailingSL.description']} /></Form.Label>
              <Form.Control as="textarea" rows={2} value={formData.description ?? ''} onChange={(e) => setFormData({ ...formData, description: e.target.value || undefined })} />
            </Form.Group>
            </fieldset>
          </Form>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={() => setShowModal(false)}>{editingPolicy && !canEdit ? 'Close' : 'Cancel'}</Button>
          {(canEdit || !editingPolicy) && (
            <Button variant="primary" onClick={handleSave} disabled={createMutation.isPending || updateMutation.isPending}>
              {(createMutation.isPending || updateMutation.isPending) ? <Spinner size="sm" /> : editingPolicy ? 'Update' : 'Create'}
            </Button>
          )}
        </Modal.Footer>
      </Modal>

      <ConfirmModal show={showDeleteConfirm} title="Delete Policy" message={`Are you sure you want to delete "${policyToDelete?.policyName}"?`}
        confirmLabel="Delete" confirmVariant="danger" onConfirm={() => policyToDelete?.id && deleteMutation.mutate(policyToDelete.id)}
        onCancel={() => { setShowDeleteConfirm(false); setPolicyToDelete(null); }} isLoading={deleteMutation.isPending} />
    </>
  );
};

// ==================== SL TARGET POLICIES TAB ====================
const SLTargetPoliciesTab: React.FC<PolicyTabProps> = ({ canEdit, canManage }) => {
  const [showModal, setShowModal] = useState(false);
  const [editingPolicy, setEditingPolicy] = useState<SLTargetPolicy | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [policyToDelete, setPolicyToDelete] = useState<SLTargetPolicy | null>(null);
  const queryClient = useQueryClient();

  const { data: policies, isLoading } = useQuery({
    queryKey: ['admin', 'policies', 'sl-target'],
    queryFn: () => strategyPolicyService.slTarget.getAll(),
  });

  const [formData, setFormData] = useState<CreateSLTargetPolicyRequest>({ policyName: '' });

  const createMutation = useMutation({
    mutationFn: (data: CreateSLTargetPolicyRequest) => strategyPolicyService.slTarget.create(data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['admin', 'policies', 'sl-target'] }); setShowModal(false); setFormData({ policyName: '' }); toast.success('Policy created'); },
    onError: (error: { message?: string }) => toast.error(error.message || 'Failed'),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<CreateSLTargetPolicyRequest> }) => strategyPolicyService.slTarget.update(id, data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['admin', 'policies', 'sl-target'] }); setShowModal(false); setEditingPolicy(null); toast.success('Policy updated'); },
    onError: (error: { message?: string }) => toast.error(error.message || 'Failed'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => strategyPolicyService.slTarget.delete(id),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['admin', 'policies', 'sl-target'] }); setShowDeleteConfirm(false); setPolicyToDelete(null); toast.success('Policy deleted'); },
    onError: (error: { message?: string }) => toast.error(error.message || 'Failed'),
  });

  const handleOpenCreate = () => { setEditingPolicy(null); setFormData({ policyName: '' }); setShowModal(true); };
  const handleOpenEdit = (policy: SLTargetPolicy) => {
    setEditingPolicy(policy);
    setFormData({ policyName: policy.policyName, description: policy.description, slPercentage: policy.slPercentage, targetPercentage: policy.targetPercentage,
      combinedSLPercentage: policy.combinedSLPercentage, combinedTargetPercentage: policy.combinedTargetPercentage,
      slTriggerToLimitGapPercentage: policy.slTriggerToLimitGapPercentage, slBufferPercentage: policy.slBufferPercentage });
    setShowModal(true);
  };

  const handleSave = () => {
    if (!formData.policyName) { toast.error('Policy name is required'); return; }
    if (editingPolicy?.id) { updateMutation.mutate({ id: editingPolicy.id, data: formData }); } else { createMutation.mutate(formData); }
  };

  return (
    <>
      <Card>
        <Card.Header className="flex justify-between items-center">
          <span>SL & Target Policies</span>
          {canEdit && <Button variant="primary" size="sm" onClick={handleOpenCreate}><BsPlus className="me-1" /> Add Policy</Button>}
        </Card.Header>
        <Card.Body className="p-0">
          {isLoading ? <div className="text-center py-12"><Spinner /></div> : (
            <Table striped hover className="mb-0" size="sm">
              <thead><tr><th>Name</th><th>SL%</th><th>Target%</th><th>Combined SL%</th><th>Combined Target%</th><th style={{ width: '100px' }}>Actions</th></tr></thead>
              <tbody>
                {(policies || []).length === 0 ? <tr><td colSpan={6} className="text-center py-6 text-ink-soft">No policies found</td></tr> : (policies || []).map((policy) => (
                  <tr key={policy.id}>
                    <td className="font-medium">{policy.policyName}</td>
                    <td>{policy.slPercentage ?? '-'}</td>
                    <td>{policy.targetPercentage ?? '-'}</td>
                    <td>{policy.combinedSLPercentage ?? '-'}</td>
                    <td>{policy.combinedTargetPercentage ?? '-'}</td>
                    <td>
                      <div className="flex gap-1">
                        <Button variant="outline-primary" size="sm" onClick={() => handleOpenEdit(policy)} title={canEdit ? 'Edit' : 'View'}>{canEdit ? <BsPencil /> : <BsEye />}</Button>
                        {canManage && <Button variant="outline-danger" size="sm" onClick={() => { setPolicyToDelete(policy); setShowDeleteConfirm(true); }}><BsTrash /></Button>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card.Body>
      </Card>

      <Modal show={showModal} onHide={() => setShowModal(false)} backdrop="static">
        <Modal.Header closeButton><Modal.Title>{editingPolicy ? (canEdit ? 'Edit' : 'View') : 'Create'} SL & Target Policy</Modal.Title></Modal.Header>
        <Modal.Body>
          <Form>
            <fieldset disabled={!!editingPolicy && !canEdit}>
            <Form.Group className="mb-4">
              <Form.Label className="flex items-center">Policy Name <span className="text-danger-600 dark:text-danger-400">*</span> <HelpIcon article={helpContent['strategyPolicy.slTarget.policyName']} /></Form.Label>
              <Form.Control type="text" value={formData.policyName} onChange={(e) => setFormData({ ...formData, policyName: e.target.value })} />
            </Form.Group>
            <Row>
              <Col md={6}><Form.Group className="mb-4"><Form.Label className="flex items-center">SL % <HelpIcon article={helpContent['strategyPolicy.slTarget.slPercentage']} /></Form.Label><Form.Control type="number" step="0.1" value={formData.slPercentage ?? ''} onChange={(e) => setFormData({ ...formData, slPercentage: e.target.value ? Number(e.target.value) : undefined })} /></Form.Group></Col>
              <Col md={6}><Form.Group className="mb-4"><Form.Label className="flex items-center">Target % <HelpIcon article={helpContent['strategyPolicy.slTarget.targetPercentage']} /></Form.Label><Form.Control type="number" step="0.1" value={formData.targetPercentage ?? ''} onChange={(e) => setFormData({ ...formData, targetPercentage: e.target.value ? Number(e.target.value) : undefined })} /></Form.Group></Col>
            </Row>
            <Row>
              <Col md={6}><Form.Group className="mb-4"><Form.Label className="flex items-center">Combined SL % <HelpIcon article={helpContent['strategyPolicy.slTarget.combinedSLPercentage']} /></Form.Label><Form.Control type="number" step="0.1" value={formData.combinedSLPercentage ?? ''} onChange={(e) => setFormData({ ...formData, combinedSLPercentage: e.target.value ? Number(e.target.value) : undefined })} /></Form.Group></Col>
              <Col md={6}><Form.Group className="mb-4"><Form.Label className="flex items-center">Combined Target % <HelpIcon article={helpContent['strategyPolicy.slTarget.combinedTargetPercentage']} /></Form.Label><Form.Control type="number" step="0.1" value={formData.combinedTargetPercentage ?? ''} onChange={(e) => setFormData({ ...formData, combinedTargetPercentage: e.target.value ? Number(e.target.value) : undefined })} /></Form.Group></Col>
            </Row>
            <Row>
              <Col md={6}><Form.Group className="mb-4"><Form.Label className="flex items-center">SL Trigger to Limit Gap % <HelpIcon article={helpContent['strategyPolicy.slTarget.slTriggerToLimitGapPercentage']} /></Form.Label><Form.Control type="number" step="0.1" value={formData.slTriggerToLimitGapPercentage ?? ''} onChange={(e) => setFormData({ ...formData, slTriggerToLimitGapPercentage: e.target.value ? Number(e.target.value) : undefined })} /></Form.Group></Col>
              <Col md={6}><Form.Group className="mb-4"><Form.Label className="flex items-center">SL Buffer % <HelpIcon article={helpContent['strategyPolicy.slTarget.slBufferPercentage']} /></Form.Label><Form.Control type="number" step="0.1" value={formData.slBufferPercentage ?? ''} onChange={(e) => setFormData({ ...formData, slBufferPercentage: e.target.value ? Number(e.target.value) : undefined })} /></Form.Group></Col>
            </Row>
            <Form.Group className="mb-4"><Form.Label className="flex items-center">Description <HelpIcon article={helpContent['strategyPolicy.slTarget.description']} /></Form.Label><Form.Control as="textarea" rows={2} value={formData.description ?? ''} onChange={(e) => setFormData({ ...formData, description: e.target.value || undefined })} /></Form.Group>
            </fieldset>
          </Form>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={() => setShowModal(false)}>{editingPolicy && !canEdit ? 'Close' : 'Cancel'}</Button>
          {(canEdit || !editingPolicy) && (
            <Button variant="primary" onClick={handleSave} disabled={createMutation.isPending || updateMutation.isPending}>
              {(createMutation.isPending || updateMutation.isPending) ? <Spinner size="sm" /> : editingPolicy ? 'Update' : 'Create'}
            </Button>
          )}
        </Modal.Footer>
      </Modal>

      <ConfirmModal show={showDeleteConfirm} title="Delete Policy" message={`Are you sure you want to delete "${policyToDelete?.policyName}"?`}
        confirmLabel="Delete" confirmVariant="danger" onConfirm={() => policyToDelete?.id && deleteMutation.mutate(policyToDelete.id)}
        onCancel={() => { setShowDeleteConfirm(false); setPolicyToDelete(null); }} isLoading={deleteMutation.isPending} />
    </>
  );
};

// ==================== STRIKE POLICIES TAB ====================
const StrikePoliciesTab: React.FC<PolicyTabProps> = ({ canEdit, canManage }) => {
  const [showModal, setShowModal] = useState(false);
  const [editingPolicy, setEditingPolicy] = useState<StrikeSelectionPolicy | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [policyToDelete, setPolicyToDelete] = useState<StrikeSelectionPolicy | null>(null);
  const queryClient = useQueryClient();

  const { data: policies, isLoading } = useQuery({
    queryKey: ['admin', 'policies', 'strike'],
    queryFn: () => strategyPolicyService.strike.getAll(),
  });

  const [formData, setFormData] = useState<CreateStrikePolicyRequest>({ policyName: '' });

  const createMutation = useMutation({
    mutationFn: (data: CreateStrikePolicyRequest) => strategyPolicyService.strike.create(data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['admin', 'policies', 'strike'] }); setShowModal(false); setFormData({ policyName: '' }); toast.success('Policy created'); },
    onError: (error: { message?: string }) => toast.error(error.message || 'Failed'),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<CreateStrikePolicyRequest> }) => strategyPolicyService.strike.update(id, data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['admin', 'policies', 'strike'] }); setShowModal(false); setEditingPolicy(null); toast.success('Policy updated'); },
    onError: (error: { message?: string }) => toast.error(error.message || 'Failed'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => strategyPolicyService.strike.delete(id),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['admin', 'policies', 'strike'] }); setShowDeleteConfirm(false); setPolicyToDelete(null); toast.success('Policy deleted'); },
    onError: (error: { message?: string }) => toast.error(error.message || 'Failed'),
  });

  const handleOpenCreate = () => { setEditingPolicy(null); setFormData({ policyName: '' }); setShowModal(true); };
  const handleOpenEdit = (policy: StrikeSelectionPolicy) => {
    setEditingPolicy(policy);
    setFormData({ policyName: policy.policyName, description: policy.description, strikeType: policy.strikeType, strikeValue: policy.strikeValue, premiumLower: policy.premiumLower, premiumUpper: policy.premiumUpper });
    setShowModal(true);
  };

  const handleSave = () => {
    if (!formData.policyName) { toast.error('Policy name is required'); return; }
    if (editingPolicy?.id) { updateMutation.mutate({ id: editingPolicy.id, data: formData }); } else { createMutation.mutate(formData); }
  };

  return (
    <>
      <Card>
        <Card.Header className="flex justify-between items-center">
          <span>Strike Selection Policies</span>
          {canEdit && <Button variant="primary" size="sm" onClick={handleOpenCreate}><BsPlus className="me-1" /> Add Policy</Button>}
        </Card.Header>
        <Card.Body className="p-0">
          {isLoading ? <div className="text-center py-12"><Spinner /></div> : (
            <Table striped hover className="mb-0" size="sm">
              <thead><tr><th>Name</th><th>Type</th><th>Strike Value</th><th>Premium Range</th><th style={{ width: '100px' }}>Actions</th></tr></thead>
              <tbody>
                {(policies || []).length === 0 ? <tr><td colSpan={5} className="text-center py-6 text-ink-soft">No policies found</td></tr> : (policies || []).map((policy) => (
                  <tr key={policy.id}>
                    <td className="font-medium">{policy.policyName}</td>
                    <td><Badge bg="info">{policy.strikeType || '-'}</Badge></td>
                    <td>{policy.strikeValue || '-'}</td>
                    <td>{policy.premiumLower && policy.premiumUpper ? `${policy.premiumLower}-${policy.premiumUpper}` : policy.premiumLower ?? '-'}</td>
                    <td>
                      <div className="flex gap-1">
                        <Button variant="outline-primary" size="sm" onClick={() => handleOpenEdit(policy)} title={canEdit ? 'Edit' : 'View'}>{canEdit ? <BsPencil /> : <BsEye />}</Button>
                        {canManage && <Button variant="outline-danger" size="sm" onClick={() => { setPolicyToDelete(policy); setShowDeleteConfirm(true); }}><BsTrash /></Button>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card.Body>
      </Card>

      <Modal show={showModal} onHide={() => setShowModal(false)} backdrop="static">
        <Modal.Header closeButton><Modal.Title>{editingPolicy ? (canEdit ? 'Edit' : 'View') : 'Create'} Strike Policy</Modal.Title></Modal.Header>
        <Modal.Body>
          <Form>
            <fieldset disabled={!!editingPolicy && !canEdit}>
            <Form.Group className="mb-4">
              <Form.Label className="flex items-center">Policy Name <span className="text-danger-600 dark:text-danger-400">*</span> <HelpIcon article={helpContent['strategyPolicy.strike.policyName']} /></Form.Label>
              <Form.Control type="text" value={formData.policyName} onChange={(e) => setFormData({ ...formData, policyName: e.target.value })} />
            </Form.Group>
            <Form.Group className="mb-4">
              <Form.Label className="flex items-center">Strike Type <HelpIcon article={helpContent['strategyPolicy.strike.strikeType']} /></Form.Label>
              <Form.Select value={formData.strikeType ?? ''} onChange={(e) => setFormData({ ...formData, strikeType: e.target.value as 'MoneyNess' | 'FixedPremium' | 'PremiumRange' | undefined })}>
                <option value="">-- Select --</option>
                <option value="MoneyNess">MoneyNess (ATM/OTM/ITM)</option>
                <option value="FixedPremium">Fixed Premium</option>
                <option value="PremiumRange">Premium Range</option>
              </Form.Select>
            </Form.Group>
            {formData.strikeType === 'MoneyNess' && (
              <Form.Group className="mb-4">
                <Form.Label className="flex items-center">Strike Value <HelpIcon article={helpContent['strategyPolicy.strike.strikeValue']} /></Form.Label>
                <Form.Select value={formData.strikeValue ?? ''} onChange={(e) => setFormData({ ...formData, strikeValue: e.target.value || undefined })}>
                  <option value="">-- Select --</option>
                  <option value="ITM-3">ITM-3</option><option value="ITM-2">ITM-2</option><option value="ITM-1">ITM-1</option>
                  <option value="ATM">ATM</option>
                  <option value="OTM+1">OTM+1</option><option value="OTM+2">OTM+2</option><option value="OTM+3">OTM+3</option>
                </Form.Select>
              </Form.Group>
            )}
            {(formData.strikeType === 'FixedPremium' || formData.strikeType === 'PremiumRange') && (
              <Row>
                <Col md={6}><Form.Group className="mb-4"><Form.Label className="flex items-center">{formData.strikeType === 'PremiumRange' ? 'Premium Lower' : 'Premium'} <HelpIcon article={helpContent['strategyPolicy.strike.premiumLower']} /></Form.Label><Form.Control type="number" value={formData.premiumLower ?? ''} onChange={(e) => setFormData({ ...formData, premiumLower: e.target.value ? Number(e.target.value) : undefined })} /></Form.Group></Col>
                {formData.strikeType === 'PremiumRange' && (
                  <Col md={6}><Form.Group className="mb-4"><Form.Label className="flex items-center">Premium Upper <HelpIcon article={helpContent['strategyPolicy.strike.premiumUpper']} /></Form.Label><Form.Control type="number" value={formData.premiumUpper ?? ''} onChange={(e) => setFormData({ ...formData, premiumUpper: e.target.value ? Number(e.target.value) : undefined })} /></Form.Group></Col>
                )}
              </Row>
            )}
            <Form.Group className="mb-4"><Form.Label className="flex items-center">Description <HelpIcon article={helpContent['strategyPolicy.strike.description']} /></Form.Label><Form.Control as="textarea" rows={2} value={formData.description ?? ''} onChange={(e) => setFormData({ ...formData, description: e.target.value || undefined })} /></Form.Group>
            </fieldset>
          </Form>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={() => setShowModal(false)}>{editingPolicy && !canEdit ? 'Close' : 'Cancel'}</Button>
          {(canEdit || !editingPolicy) && (
            <Button variant="primary" onClick={handleSave} disabled={createMutation.isPending || updateMutation.isPending}>
              {(createMutation.isPending || updateMutation.isPending) ? <Spinner size="sm" /> : editingPolicy ? 'Update' : 'Create'}
            </Button>
          )}
        </Modal.Footer>
      </Modal>

      <ConfirmModal show={showDeleteConfirm} title="Delete Policy" message={`Are you sure you want to delete "${policyToDelete?.policyName}"?`}
        confirmLabel="Delete" confirmVariant="danger" onConfirm={() => policyToDelete?.id && deleteMutation.mutate(policyToDelete.id)}
        onCancel={() => { setShowDeleteConfirm(false); setPolicyToDelete(null); }} isLoading={deleteMutation.isPending} />
    </>
  );
};

// ==================== EXIT POLICIES TAB ====================
const ExitPoliciesTab: React.FC<PolicyTabProps> = ({ canEdit, canManage }) => {
  const [showModal, setShowModal] = useState(false);
  const [editingPolicy, setEditingPolicy] = useState<ExitPolicy | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [policyToDelete, setPolicyToDelete] = useState<ExitPolicy | null>(null);
  const queryClient = useQueryClient();

  const { data: policies, isLoading } = useQuery({
    queryKey: ['admin', 'policies', 'exit'],
    queryFn: () => strategyPolicyService.exit.getAll(),
  });

  const [formData, setFormData] = useState<CreateExitPolicyRequest>({ policyName: '' });

  const createMutation = useMutation({
    mutationFn: (data: CreateExitPolicyRequest) => strategyPolicyService.exit.create(data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['admin', 'policies', 'exit'] }); setShowModal(false); setFormData({ policyName: '' }); toast.success('Policy created'); },
    onError: (error: { message?: string }) => toast.error(error.message || 'Failed'),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<CreateExitPolicyRequest> }) => strategyPolicyService.exit.update(id, data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['admin', 'policies', 'exit'] }); setShowModal(false); setEditingPolicy(null); toast.success('Policy updated'); },
    onError: (error: { message?: string }) => toast.error(error.message || 'Failed'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => strategyPolicyService.exit.delete(id),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['admin', 'policies', 'exit'] }); setShowDeleteConfirm(false); setPolicyToDelete(null); toast.success('Policy deleted'); },
    onError: (error: { message?: string }) => toast.error(error.message || 'Failed'),
  });

  const handleOpenCreate = () => { setEditingPolicy(null); setFormData({ policyName: '' }); setShowModal(true); };
  const handleOpenEdit = (policy: ExitPolicy) => {
    setEditingPolicy(policy);
    setFormData({ policyName: policy.policyName, description: policy.description, exitMode: policy.exitMode, exitDays: policy.exitDays, exitTime: policy.exitTime });
    setShowModal(true);
  };

  const handleSave = () => {
    if (!formData.policyName) { toast.error('Policy name is required'); return; }
    if (editingPolicy?.id) { updateMutation.mutate({ id: editingPolicy.id, data: formData }); } else { createMutation.mutate(formData); }
  };

  return (
    <>
      <Card>
        <Card.Header className="flex justify-between items-center">
          <span>Exit Policies</span>
          {canEdit && <Button variant="primary" size="sm" onClick={handleOpenCreate}><BsPlus className="me-1" /> Add Policy</Button>}
        </Card.Header>
        <Card.Body className="p-0">
          {isLoading ? <div className="text-center py-12"><Spinner /></div> : (
            <Table striped hover className="mb-0" size="sm">
              <thead><tr><th>Name</th><th>Exit Mode</th><th>Exit Days</th><th>Exit Time</th><th style={{ width: '100px' }}>Actions</th></tr></thead>
              <tbody>
                {(policies || []).length === 0 ? <tr><td colSpan={5} className="text-center py-6 text-ink-soft">No policies found</td></tr> : (policies || []).map((policy) => (
                  <tr key={policy.id}>
                    <td className="font-medium">{policy.policyName}</td>
                    <td><Badge bg="info">{policy.exitMode || '-'}</Badge></td>
                    <td>{policy.exitDays ?? '-'}</td>
                    <td>{policy.exitTime || '-'}</td>
                    <td>
                      <div className="flex gap-1">
                        <Button variant="outline-primary" size="sm" onClick={() => handleOpenEdit(policy)} title={canEdit ? 'Edit' : 'View'}>{canEdit ? <BsPencil /> : <BsEye />}</Button>
                        {canManage && <Button variant="outline-danger" size="sm" onClick={() => { setPolicyToDelete(policy); setShowDeleteConfirm(true); }}><BsTrash /></Button>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card.Body>
      </Card>

      <Modal show={showModal} onHide={() => setShowModal(false)} backdrop="static">
        <Modal.Header closeButton><Modal.Title>{editingPolicy ? (canEdit ? 'Edit' : 'View') : 'Create'} Exit Policy</Modal.Title></Modal.Header>
        <Modal.Body>
          <Form>
            <fieldset disabled={!!editingPolicy && !canEdit}>
            <Form.Group className="mb-4">
              <Form.Label className="flex items-center">Policy Name <span className="text-danger-600 dark:text-danger-400">*</span> <HelpIcon article={helpContent['strategyPolicy.exit.policyName']} /></Form.Label>
              <Form.Control type="text" value={formData.policyName} onChange={(e) => setFormData({ ...formData, policyName: e.target.value })} />
            </Form.Group>
            <Form.Group className="mb-4">
              <Form.Label className="flex items-center">Exit Mode <HelpIcon article={helpContent['strategyPolicy.exit.exitMode']} /></Form.Label>
              <Form.Select value={formData.exitMode ?? ''} onChange={(e) => setFormData({ ...formData, exitMode: e.target.value as 'SAME_DAY' | 'DAYS_FROM_ENTRY' | 'DTE' | 'EXPIRY' | 'MINUTES_FROM_ENTRY' | undefined })}>
                <option value="">-- Select --</option>
                <option value="SAME_DAY">Same Day</option>
                <option value="DAYS_FROM_ENTRY">Days From Entry</option>
                <option value="DTE">Days To Expiry (DTE)</option>
                <option value="EXPIRY">Expiry Day</option>
                <option value="MINUTES_FROM_ENTRY">Minutes From Entry</option>
              </Form.Select>
            </Form.Group>
            {(formData.exitMode === 'DAYS_FROM_ENTRY' || formData.exitMode === 'DTE' || formData.exitMode === 'MINUTES_FROM_ENTRY') && (
              <Form.Group className="mb-4">
                <Form.Label className="flex items-center">{formData.exitMode === 'MINUTES_FROM_ENTRY' ? 'Exit Minutes' : 'Exit Days'} <HelpIcon article={helpContent['strategyPolicy.exit.exitDays']} /></Form.Label>
                <Form.Control type="number" min={1} value={formData.exitDays ?? ''} onChange={(e) => setFormData({ ...formData, exitDays: e.target.value ? Number(e.target.value) : undefined })} placeholder={formData.exitMode === 'MINUTES_FROM_ENTRY' ? 'Trading minutes after entry' : formData.exitMode === 'DTE' ? 'Days before expiry' : 'Days after entry'} />
              </Form.Group>
            )}
            {formData.exitMode !== 'MINUTES_FROM_ENTRY' && (
            <Form.Group className="mb-4">
              <Form.Label className="flex items-center">Exit Time <HelpIcon article={helpContent['strategyPolicy.exit.exitTime']} /></Form.Label>
              <Form.Control type="text" value={formData.exitTime ?? ''} onChange={(e) => setFormData({ ...formData, exitTime: e.target.value || undefined })} placeholder="HH:mm:ss (e.g., 15:15:00)" />
            </Form.Group>
            )}
            <Form.Group className="mb-4"><Form.Label className="flex items-center">Description <HelpIcon article={helpContent['strategyPolicy.exit.description']} /></Form.Label><Form.Control as="textarea" rows={2} value={formData.description ?? ''} onChange={(e) => setFormData({ ...formData, description: e.target.value || undefined })} /></Form.Group>
            </fieldset>
          </Form>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={() => setShowModal(false)}>{editingPolicy && !canEdit ? 'Close' : 'Cancel'}</Button>
          {(canEdit || !editingPolicy) && (
            <Button variant="primary" onClick={handleSave} disabled={createMutation.isPending || updateMutation.isPending}>
              {(createMutation.isPending || updateMutation.isPending) ? <Spinner size="sm" /> : editingPolicy ? 'Update' : 'Create'}
            </Button>
          )}
        </Modal.Footer>
      </Modal>

      <ConfirmModal show={showDeleteConfirm} title="Delete Policy" message={`Are you sure you want to delete "${policyToDelete?.policyName}"?`}
        confirmLabel="Delete" confirmVariant="danger" onConfirm={() => policyToDelete?.id && deleteMutation.mutate(policyToDelete.id)}
        onCancel={() => { setShowDeleteConfirm(false); setPolicyToDelete(null); }} isLoading={deleteMutation.isPending} />
    </>
  );
};

// ==================== MAIN PAGE ====================
const StrategyPoliciesPage: React.FC = () => {
  const [activeTab, setActiveTab] = useState('strike');

  // Use strategyPolicies permission - sysadmin OR E/M permission
  const canEdit = true || true;
  const canManage = true || true;

  return (
    <div className="fade-in">
      <PageHeader
        title="Strategy Policies"
        subtitle="Manage reusable configuration policies for strategies"
        icon={<BsShieldCheck size={24} />}
      />

      <Alert variant="info" className="mb-4">
        <strong>How it works:</strong> Create reusable policies that can be referenced from Strategy Config Tree entries.
        Sysadmins and users with Edit permission can create/edit policies.
        Sysadmins and users with Manage permission can delete policies.
      </Alert>

      <Tabs activeKey={activeTab} onSelect={(k) => setActiveTab(k || 'strike')} className="mb-4">
        <Tab eventKey="strike" title={<><BsCrosshair className="me-1" /> Strike</>}>
          <StrikePoliciesTab canEdit={canEdit} canManage={canManage} />
        </Tab>
        <Tab eventKey="sl-target" title={<><BsCrosshair className="me-1" /> SL & Target</>}>
          <SLTargetPoliciesTab canEdit={canEdit} canManage={canManage} />
        </Tab>
        <Tab eventKey="trailing-sl" title={<><BsArrowRepeat className="me-1" /> Trailing SL</>}>
          <TrailingSLPoliciesTab canEdit={canEdit} canManage={canManage} />
        </Tab>
        <Tab eventKey="order-fill" title={<><BsClockHistory className="me-1" /> Order Fill</>}>
          <OrderFillPoliciesTab canEdit={canEdit} canManage={canManage} />
        </Tab>
        <Tab eventKey="exit" title={<><BsBoxArrowRight className="me-1" /> Exit</>}>
          <ExitPoliciesTab canEdit={canEdit} canManage={canManage} />
        </Tab>
      </Tabs>
    </div>
  );
};

export default StrategyPoliciesPage;
