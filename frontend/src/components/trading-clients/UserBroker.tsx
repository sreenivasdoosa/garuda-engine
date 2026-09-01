/**
 * UserBroker Component
 * Modal for viewing/editing a single user broker configuration
 * Reusable across Admin, Client Manager portals
 * Uses V2 API: /api/v2/users/{username}/brokers
 */

import { useState, useEffect, useMemo } from 'react';
import { Modal, Form, Row, Col, Button, Spinner, Badge } from '@/components/ui/rbShim';
import { BsBank } from 'react-icons/bs';
import Select from 'react-select';
import type { UserBrokerConfig, CreateUserBrokerRequest } from '@/types/user_mgmt';
import type { BrokeragePlan, BrokeragePlanRate } from '@/types/billing';
import { brokeragePlanService, brokeragePlanRateService } from '@/services/admin/v2AdminService';

/** The always-configured fallback plan; an unconfigured segment resolves to this (~₹20/order). */
const DEFAULT_BROKERAGE_PLAN = 'DISCOUNT_BROKERAGE_PLAN';

/** Human-readable rate, mirroring the backend ChargeCalculator precedence. */
const describeRate = (r: BrokeragePlanRate): string => {
  if ((r.brokeragePct ?? 0) > 0) return `min(turnover × ${r.brokeragePct}%, ₹${r.ratePerUnit})`;
  const perLot = (r.unitType || '').toLowerCase() === 'lot';
  return `₹${r.ratePerUnit}${perLot ? '/lot' : '/order'}`;
};

export interface UserBrokerProps {
  /** Broker config for edit mode, null for create mode */
  broker: UserBrokerConfig | null;
  /** Username for the broker */
  username: string;
  /** Whether the modal is visible */
  show: boolean;
  /** Close modal callback */
  onClose: () => void;
  /** Save callback */
  onSave: (data: CreateUserBrokerRequest, isNew: boolean) => void;
  /** Whether save is in progress */
  isSaving?: boolean;
  /** Mode: 'view' | 'edit' | 'create' */
  mode?: 'view' | 'edit' | 'create';
  /** Available brokers list for dropdown */
  availableBrokers?: { name: string; displayName: string }[];
}

const UserBroker: React.FC<UserBrokerProps> = ({
  broker,
  username,
  show,
  onClose,
  onSave,
  isSaving = false,
  mode = broker ? 'edit' : 'create',
  availableBrokers = [],
}) => {
  const isViewMode = mode === 'view';
  const isCreateMode = mode === 'create';
  const brokerOptions = useMemo(() => {
    return availableBrokers.map((broker) => ({
      value: broker.name,
      label: broker.displayName || broker.name,
    }));
  }, [availableBrokers]);

  const [formData, setFormData] = useState<CreateUserBrokerRequest>({
    broker: '',
    clientID: '',
    clientPassword: '',
    clientPIN: '',
    totpKey: '',
    panOrDOB: '',
    appKey: '',
    appSecret: '',
    autoLogin: false,
    brokeragePlan: '',
    allocationModel: '',
    isPro: false,
    webSocketEnabled: false,
  });

  // Brokerage-plan assignment guard: show the selected plan's configured rates,
  // flag segments that would silently fall back to the default (~₹20/order),
  // and block Save until the plan is complete.
  const [plans, setPlans] = useState<BrokeragePlan[]>([]);
  const [requiredCombos, setRequiredCombos] = useState<string[]>([]);
  const [selectedPlanRates, setSelectedPlanRates] = useState<BrokeragePlanRate[] | null>(null);
  const [ratesLoading, setRatesLoading] = useState(false);

  useEffect(() => {
    if (broker) {
      setFormData({
        broker: broker.broker,
        clientID: broker.clientID,
        clientPassword: '',
        clientPIN: '',
        totpKey: '',
        panOrDOB: broker.panOrDOB || '',
        appKey: broker.appKey || '',
        appSecret: '',
        autoLogin: broker.autoLogin,
        brokeragePlan: broker.brokeragePlan || '',
        allocationModel: broker.allocationModel || '',
        useApiOf: broker.useApiOf || '',
        isPro: broker.isPro,
        xtremeAgentUrl: broker.xtremeAgentUrl || '',
        xtremeAgentBypass: broker.xtremeAgentBypass,
        webSocketEnabled: broker.webSocketEnabled,
      });
    } else {
      setFormData({
        broker: '',
        clientID: '',
        clientPassword: '',
        clientPIN: '',
        totpKey: '',
        panOrDOB: '',
        appKey: '',
        appSecret: '',
        autoLogin: false,
        brokeragePlan: '',
        allocationModel: '',
        isPro: false,
        webSocketEnabled: false,
      });
    }
  }, [broker, show]);

  // Load the plan list (for the dropdown) + the default plan's chargeable
  // segments (the "required" set) when the editable modal opens.
  useEffect(() => {
    if (!show || isViewMode) return;
    let cancelled = false;
    (async () => {
      try {
        const [allPlans, defaultRates] = await Promise.all([
          brokeragePlanService.getAll(),
          brokeragePlanRateService.getByPlan(DEFAULT_BROKERAGE_PLAN),
        ]);
        if (cancelled) return;
        setPlans(allPlans);
        setRequiredCombos(
          defaultRates
            .filter((r) => (r.ratePerUnit ?? 0) !== 0 || (r.brokeragePct ?? 0) !== 0)
            .map((r) => `${r.segment}/${r.product}`)
        );
      } catch {
        // Fall back to free-text plan entry; the backend still enforces the rule.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [show, isViewMode]);

  // Load the selected plan's rates whenever it changes.
  useEffect(() => {
    const plan = formData.brokeragePlan;
    if (!show || isViewMode || !plan) {
      setSelectedPlanRates(null);
      return;
    }
    let cancelled = false;
    setRatesLoading(true);
    brokeragePlanRateService
      .getByPlan(plan)
      .then((rates) => {
        if (!cancelled) setSelectedPlanRates(rates);
      })
      .catch(() => {
        if (!cancelled) setSelectedPlanRates([]);
      })
      .finally(() => {
        if (!cancelled) setRatesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [formData.brokeragePlan, show, isViewMode]);

  const planOptions = useMemo(
    () => plans.map((p) => ({ value: p.planName, label: p.planName })),
    [plans]
  );

  const selectedPlanType = useMemo(
    () => plans.find((p) => p.planName === formData.brokeragePlan)?.planType,
    [plans, formData.brokeragePlan]
  );
  const isFixedPeriodPlan = selectedPlanType === 'FIXED_PERIOD';
  const isDefaultPlan = formData.brokeragePlan === DEFAULT_BROKERAGE_PLAN;
  const showRatePreview = Boolean(formData.brokeragePlan) && !isFixedPeriodPlan && !isDefaultPlan;

  const missingCombos = useMemo(() => {
    if (!showRatePreview || selectedPlanRates === null) return [];
    const configured = new Set(selectedPlanRates.map((r) => `${r.segment}/${r.product}`));
    return requiredCombos.filter((c) => !configured.has(c));
  }, [showRatePreview, selectedPlanRates, requiredCombos]);

  const planIncomplete = missingCombos.length > 0;

  const handleSubmit = () => {
    onSave(formData, isCreateMode);
  };

  const getModalTitle = () => {
    if (isCreateMode) return `Add Broker for ${username}`;
    if (isViewMode) return `Broker: ${broker?.broker}`;
    return `Edit Broker: ${broker?.broker}`;
  };

  return (
    <Modal show={show} onHide={onClose} size="lg" backdrop="static">
      <Modal.Header closeButton>
        <Modal.Title className="flex items-center gap-2">
          <BsBank />
          {getModalTitle()}
        </Modal.Title>
      </Modal.Header>
      <Modal.Body>
        {isViewMode && broker ? (
          <Row className="">
            <Col md={6}>
              <label className="text-ink-soft text-[0.875em]">Broker</label>
              <div className="font-medium">{broker.broker}</div>
            </Col>
            <Col md={6}>
              <label className="text-ink-soft text-[0.875em]">Client ID</label>
              <div><code>{broker.clientID}</code></div>
            </Col>
            <Col md={4}>
              <label className="text-ink-soft text-[0.875em]">Status</label>
              <div>
                <Badge bg={broker.enabled ? 'success' : 'secondary'}>{broker.enabled ? 'Enabled' : 'Disabled'}</Badge>
                {broker.loginVerified && <Badge bg="info" className="ms-1">Verified</Badge>}
              </div>
            </Col>
            <Col md={4}>
              <label className="text-ink-soft text-[0.875em]">Pro Account</label>
              <div><Badge bg={broker.isPro ? 'warning' : 'light'} text="dark">{broker.isPro ? 'Yes' : 'No'}</Badge></div>
            </Col>
            <Col md={4}>
              <label className="text-ink-soft text-[0.875em]">Brokerage Plan</label>
              <div>{broker.brokeragePlan || 'N/A'}</div>
            </Col>
            <Col md={4}>
              <label className="text-ink-soft text-[0.875em]">Allocation Model</label>
              <div>{broker.allocationModel || 'Default'}</div>
            </Col>
            <Col md={4}>
              <label className="text-ink-soft text-[0.875em]">WebSocket</label>
              <div><Badge bg={broker.webSocketEnabled ? 'info' : 'light'} text={broker.webSocketEnabled ? 'white' : 'dark'}>{broker.webSocketEnabled ? 'Yes' : 'No'}</Badge></div>
            </Col>
            {broker.useApiOf && (
              <Col md={6}>
                <label className="text-ink-soft text-[0.875em]">Use API Of</label>
                <div>{broker.useApiOf}</div>
              </Col>
            )}
            {broker.appKey && (
              <Col md={6}>
                <label className="text-ink-soft text-[0.875em]">App Key</label>
                <div><code>{broker.appKey}</code></div>
              </Col>
            )}
          </Row>
        ) : (
          <Form>
            <Row>
              <Col md={6}>
                <Form.Group className="mb-4">
                  <Form.Label>Broker *</Form.Label>
                  <Form.Text className="text-ink-soft block mb-1">Only enabled brokers are shown</Form.Text>
                  {availableBrokers.length > 0 ? (
                    isCreateMode ? (
                      <Select
                        options={brokerOptions}
                        value={brokerOptions.find((option) => option.value === formData.broker) || null}
                        onChange={(selected) => setFormData({ ...formData, broker: selected?.value || '' })}
                        isClearable
                        isSearchable
                        classNamePrefix="react-select"
                        placeholder="-- Select Broker --"
                      />
                    ) : (
                      <Form.Control value={formData.broker} disabled />
                    )
                  ) : (
                    <Form.Control
                      value={formData.broker}
                      onChange={(e) => setFormData({ ...formData, broker: e.target.value })}
                      disabled={!isCreateMode}
                      placeholder="e.g., ZERODHA, ANGEL"
                    />
                  )}
                </Form.Group>
              </Col>
              <Col md={6}>
                <Form.Group className="mb-4">
                  <Form.Label>Client ID *</Form.Label>
                  <Form.Control
                    value={formData.clientID}
                    onChange={(e) => setFormData({ ...formData, clientID: e.target.value })}
                    placeholder="Enter client ID"
                  />
                </Form.Group>
              </Col>
            </Row>
            <Row>
              <Col md={6}>
                <Form.Group className="mb-4">
                  <Form.Label>App Key</Form.Label>
                  <Form.Control
                    value={formData.appKey || ''}
                    onChange={(e) => setFormData({ ...formData, appKey: e.target.value })}
                    placeholder="Enter app key"
                  />
                </Form.Group>
              </Col>
              <Col md={6}>
                <Form.Group className="mb-4">
                  <Form.Label>App Secret</Form.Label>
                  <Form.Control
                    type="password"
                    value={formData.appSecret || ''}
                    onChange={(e) => setFormData({ ...formData, appSecret: e.target.value })}
                    placeholder="Enter app secret"
                  />
                </Form.Group>
              </Col>
            </Row>
            <Row>
              <Col md={6}>
                <Form.Group className="mb-4">
                  <Form.Label>Brokerage Plan</Form.Label>
                  {plans.length > 0 ? (
                    <Select
                      options={planOptions}
                      value={planOptions.find((o) => o.value === formData.brokeragePlan) || null}
                      onChange={(selected) => setFormData({ ...formData, brokeragePlan: selected?.value || '' })}
                      isClearable
                      isSearchable
                      classNamePrefix="react-select"
                      placeholder="-- Default plan if empty --"
                    />
                  ) : (
                    <Form.Control
                      value={formData.brokeragePlan || ''}
                      onChange={(e) => setFormData({ ...formData, brokeragePlan: e.target.value })}
                      placeholder="Enter brokerage plan"
                    />
                  )}
                </Form.Group>
              </Col>
              <Col md={6}>
                <Form.Group className="mb-4">
                  <Form.Label>Allocation Model</Form.Label>
                  <Form.Control
                    value={formData.allocationModel || ''}
                    onChange={(e) => setFormData({ ...formData, allocationModel: e.target.value })}
                    placeholder="Enter allocation model"
                  />
                </Form.Group>
              </Col>
            </Row>
            {showRatePreview && (
              <Row>
                <Col md={12}>
                  <div className="mb-4">
                    {ratesLoading ? (
                      <div className="text-ink-soft text-[0.875em]"><Spinner size="sm" className="me-1" />Loading plan rates…</div>
                    ) : (
                      <>
                        <div className="overflow-x-auto">
                          <table className="w-full text-sm [&_thead_th]:bg-raised [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:text-xs [&_th]:font-semibold [&_th]:uppercase [&_th]:text-ink-faint [&_td]:px-3 [&_td]:py-2 [&_td]:align-middle [&_td]:text-ink [&_tbody_tr]:border-b [&_tbody_tr]:border-hairline [&_th]:!py-1.5 [&_td]:!py-1.5 [&_th]:!px-2 [&_td]:!px-2 align-middle mb-2">
                            <thead>
                              <tr><th>Segment</th><th>Product</th><th>Rate</th></tr>
                            </thead>
                            <tbody>
                              {requiredCombos.map((c) => {
                                const [seg, prod] = c.split('/');
                                const rate = (selectedPlanRates ?? []).find((r) => r.segment === seg && r.product === prod);
                                return (
                                  <tr key={c} className={rate ? '' : '[&_td]:!bg-warning-500/10'}>
                                    <td>{seg}</td>
                                    <td>{prod}</td>
                                    <td>
                                      {rate ? (
                                        describeRate(rate)
                                      ) : (
                                        <span className="text-danger-600 dark:text-danger-400 font-semibold">Not configured → falls back to ₹20/order</span>
                                      )}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                        {planIncomplete && (
                          <div className="mb-3 rounded border px-3 py-2 text-sm border-danger-500/30 bg-danger-500/10 text-danger-700 dark:text-danger-300 py-2 mb-0 text-[0.875em]">
                            ⚠ This plan is missing rates for <strong>{missingCombos.join(', ')}</strong> — assigning it would
                            overcharge at the default ₹20/order. Save is disabled until it's configured.{' '}
                            <a
                              href={`/console/brokerage-plans?plan=${encodeURIComponent(formData.brokeragePlan || '')}`}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              Configure rates for this plan →
                            </a>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </Col>
              </Row>
            )}
            <Row>
              <Col md={6}>
                <Form.Group className="mb-4">
                  <Form.Label>Use API Of</Form.Label>
                  <Form.Control
                    value={formData.useApiOf || ''}
                    onChange={(e) => setFormData({ ...formData, useApiOf: e.target.value })}
                    placeholder="Share access token with"
                  />
                </Form.Group>
              </Col>
            </Row>
            <Row className="mt-2">
              <Col md={3}>
                <Form.Check
                  type="checkbox"
                  label="Pro Account"
                  checked={formData.isPro ?? false}
                  onChange={(e) => setFormData({ ...formData, isPro: e.target.checked })}
                />
              </Col>
              <Col md={3}>
                <Form.Check
                  type="checkbox"
                  label="WebSocket"
                  checked={formData.webSocketEnabled ?? false}
                  onChange={(e) => setFormData({ ...formData, webSocketEnabled: e.target.checked })}
                />
              </Col>
              <Col md={3}>
                <Form.Check
                  type="checkbox"
                  label="Agent Bypass"
                  checked={formData.xtremeAgentBypass ?? false}
                  onChange={(e) => setFormData({ ...formData, xtremeAgentBypass: e.target.checked })}
                />
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
          <Button
            variant="primary"
            onClick={handleSubmit}
            disabled={isSaving || planIncomplete}
            title={planIncomplete ? 'Configure the missing brokerage-plan rates before assigning this plan' : undefined}
          >
            {isSaving ? <><Spinner size="sm" className="me-1" />Saving...</> : (isCreateMode ? 'Add Broker' : 'Update')}
          </Button>
        )}
      </Modal.Footer>
    </Modal>
  );
};

export default UserBroker;
