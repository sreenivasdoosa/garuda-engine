/**
 * The Strategy Engine: what to trade, under which rules, on whose account.
 *
 * A definition carries what the reference's template used to decide -- trade
 * mode, direction provider, triggers, combo legs, equity sizing -- as fields
 * (STRATEGY_ENGINE.md §5). Per-tranche settings live on Strategy Config. The
 * monitor shows today as the running engine sees it: the tranche schedule,
 * armed breakout watches, and each account's strategy state.
 *
 * **A strategy the engine would refuse is refused at the save**, with the
 * reason the morning's log would otherwise give.
 */

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { BsDiagram3, BsGear, BsPencil, BsPlus, BsTrash } from 'react-icons/bs';
import {
  Alert,
  Badge,
  Button,
  Card,
  Col,
  Form,
  Modal,
  Nav,
  Row,
  Spinner,
} from '@/components/ui/rbShim';
import { ConfirmModal, PageHeader } from '@/components/common';
import { strategyLiveService } from '@/services/admin/strategyLiveService';
import { tradingClientService } from '@/services/admin/tradingClientService';
import type { RuleNode } from '@/types/strategy-engine';
import type {
  StrategyDefinitionEdit,
  StrategyDefinitionLive,
  SubscriptionEdit,
  SubscriptionLive,
} from '@/types/strategy-live';
import DefinitionForm from './DefinitionForm';
import IndicatorRuleBuilder from './IndicatorRuleBuilder';
import { DayAllocationModal, EngineMonitorTab } from './EngineMonitorTab';

type Tab = 'definitions' | 'subscriptions' | 'monitor';

const money = (value: number | null) =>
  value === null ? '—' : value.toLocaleString('en-IN', { maximumFractionDigits: 0 });

const StrategyEnginePage: React.FC = () => {
  const [tab, setTab] = useState<Tab>('definitions');
  return (
    <div className="fade-in">
      <PageHeader
        title="Strategy Engine"
        subtitle="What to trade, under which rules, on whose account"
        icon={<BsGear size={24} />}
      />
      <Nav variant="tabs" activeKey={tab} onSelect={(k) => setTab((k as Tab) || 'definitions')} className="mb-4">
        <Nav.Item>
          <Nav.Link eventKey="definitions">Definitions</Nav.Link>
        </Nav.Item>
        <Nav.Item>
          <Nav.Link eventKey="subscriptions">Subscriptions</Nav.Link>
        </Nav.Item>
        <Nav.Item>
          <Nav.Link eventKey="monitor">Engine Monitor</Nav.Link>
        </Nav.Item>
      </Nav>
      {tab === 'definitions' && <Definitions />}
      {tab === 'subscriptions' && <Subscriptions />}
      {tab === 'monitor' && <EngineMonitorTab />}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

const blankDefinition = (): StrategyDefinitionEdit => ({
  strategyName: '',
  displayName: '',
  underlyingSymbol: '',
  exchange: 'NSE',
  product: 'INTRADAY',
  tradeMode: 'OPTION_SELLING',
  expiryType: 'WEEKLY',
  startTime: '09:20',
  stopTime: '15:15',
  isDirectional: false,
  scheduledTriggerEnabled: true,
  usePremiumBalancing: true,
  catchUpMissedTranches: true,
});

/** The editable fields of a definition, copied off what the server sent. */
const editable = (d: StrategyDefinitionLive): StrategyDefinitionEdit => {
  const { strategyId: _id, legs: _legs, subscriptions: _subs, createdAt: _c, updatedAt: _u, ...rest } = d;
  return rest;
};

const Definitions: React.FC = () => {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<StrategyDefinitionLive | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<StrategyDefinitionEdit>(blankDefinition());
  const [rulesFor, setRulesFor] = useState<StrategyDefinitionLive | null>(null);
  const [allocationFor, setAllocationFor] = useState<StrategyDefinitionLive | null>(null);
  const [deleting, setDeleting] = useState<StrategyDefinitionLive | null>(null);

  const definitions = useQuery({
    queryKey: ['strategies', 'definitions'],
    queryFn: () => strategyLiveService.definitions(),
  });
  const catalog = useQuery({
    queryKey: ['strategies', 'catalog'],
    queryFn: () => strategyLiveService.catalog(),
    staleTime: 10 * 60 * 1000,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['strategies'] });

  const save = useMutation({
    mutationFn: ({ id, data }: { id: number | null; data: StrategyDefinitionEdit }) =>
      id === null
        ? strategyLiveService.createDefinition(data)
        : strategyLiveService.updateDefinition(id, data),
    onSuccess: (saved) => {
      toast.success(`${saved.strategyName} saved`);
      setEditing(null);
      setCreating(false);
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const status = useMutation({
    mutationFn: ({ id, status }: { id: number; status: string }) =>
      strategyLiveService.changeStatus(id, status),
    onSuccess: (saved) => {
      toast.success(`${saved.strategyName} is ${saved.status}`);
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: (id: number) => strategyLiveService.deleteDefinition(id),
    onSuccess: () => {
      toast.success('Removed');
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
    onSettled: () => setDeleting(null),
  });

  const openCreate = () => {
    setEditing(null);
    setForm(blankDefinition());
    setCreating(true);
  };
  const openEdit = (d: StrategyDefinitionLive) => {
    setCreating(false);
    setEditing(d);
    setForm(editable(d));
  };

  return (
    <>
      <Card>
        <Card.Header className="flex items-center justify-between">
          <h5 className="mb-0">Definitions</h5>
          <Button variant="primary" size="sm" onClick={openCreate}>
            <BsPlus className="me-1" />
            New strategy
          </Button>
        </Card.Header>
        <Card.Body>
          {definitions.isLoading && <Spinner />}
          {definitions.error && <Alert variant="danger">{(definitions.error as Error).message}</Alert>}
          {definitions.data && definitions.data.length === 0 && (
            <Alert variant="info" className="mb-0">
              No strategy yet. Define one: an underlying, a product and the legs it enters.
            </Alert>
          )}
          {definitions.data && definitions.data.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-ink-faint text-xs uppercase">
                  <tr>
                    <th className="py-1 text-left">Strategy</th>
                    <th className="py-1 text-left">Underlying</th>
                    <th className="py-1 text-left">Product</th>
                    <th className="py-1 text-left">Trades</th>
                    <th className="py-1 text-left">Status</th>
                    <th className="py-1 text-right">Subscribed</th>
                    <th className="py-1 text-right" />
                  </tr>
                </thead>
                <tbody>
                  {definitions.data.map((d) => (
                    <tr key={d.strategyId} className="border-t border-hairline align-top">
                      <td className="py-2 pr-3">
                        <div className="font-semibold">{d.displayName || d.strategyName}</div>
                        <div className="text-ink-faint font-mono text-xs">{d.strategyName}</div>
                      </td>
                      <td className="py-2 pr-3 font-mono">
                        {d.exchange}:{d.underlyingSymbol}
                        <div className="text-ink-faint text-xs">{d.expiryType ?? ''}</div>
                      </td>
                      <td className="py-2 pr-3">
                        {d.product}
                        {d.isDirectional && <Badge bg="info" className="ms-1">directional</Badge>}
                      </td>
                      <td className="py-2 pr-3 text-xs">
                        <div className="font-mono">{d.tradeMode}</div>
                        {d.directionProviderType && <div className="text-ink-faint">{d.directionProviderType}</div>}
                        {d.comboSpecJson && <Badge bg="secondary">combo</Badge>}
                        {d.adaptiveTranchesEnabled && <Badge bg="info" className="ms-1">adaptive</Badge>}
                        {d.strategyClass && <Badge bg="warning" className="ms-1">{d.strategyClass}</Badge>}
                      </td>
                      <td className="py-2 pr-3">
                        <Badge bg={d.status === 'ACTIVE' ? 'success' : d.status === 'WIND_DOWN' ? 'warning' : 'secondary'}>
                          {d.status}
                        </Badge>
                      </td>
                      <td className="py-2 pr-3 text-right font-mono">{d.subscriptions ?? 0}</td>
                      <td className="py-2 text-right">
                        <div className="flex flex-wrap justify-end gap-1">
                          {d.status === 'ACTIVE' ? (
                            <Button
                              variant="outline-warning"
                              size="sm"
                              onClick={() => status.mutate({ id: d.strategyId, status: 'INACTIVE' })}
                            >
                              Deactivate
                            </Button>
                          ) : (
                            <Button
                              variant="outline-success"
                              size="sm"
                              onClick={() => status.mutate({ id: d.strategyId, status: 'ACTIVE' })}
                            >
                              Activate
                            </Button>
                          )}
                          <Button variant="outline-secondary" size="sm" onClick={() => setRulesFor(d)}>
                            <BsDiagram3 className="me-1" />
                            Rules
                          </Button>
                          <Button variant="outline-secondary" size="sm" onClick={() => setAllocationFor(d)}>
                            Days
                          </Button>
                          <Button variant="outline-primary" size="sm" onClick={() => openEdit(d)}>
                            <BsPencil />
                          </Button>
                          <Button variant="outline-danger" size="sm" onClick={() => setDeleting(d)}>
                            <BsTrash />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card.Body>
      </Card>

      <Modal
        show={creating || editing !== null}
        onHide={() => {
          setCreating(false);
          setEditing(null);
        }}
        size="xl"
        backdrop="static"
        scrollable
      >
        <Modal.Header closeButton>
          <Modal.Title>{editing ? editing.strategyName : 'New strategy'}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <DefinitionForm form={form} setForm={setForm} catalog={catalog.data} creating={creating} />
        </Modal.Body>
        <Modal.Footer>
          <Button
            variant="secondary"
            onClick={() => {
              setCreating(false);
              setEditing(null);
            }}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={save.isPending}
            onClick={() => save.mutate({ id: editing?.strategyId ?? null, data: form })}
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </Modal.Footer>
      </Modal>

      {rulesFor && <RulesModal definition={rulesFor} onClose={() => setRulesFor(null)} />}
      {allocationFor && (
        <DayAllocationModal strategy={allocationFor.strategyName} onClose={() => setAllocationFor(null)} />
      )}

      <ConfirmModal
        show={deleting !== null}
        onHide={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting.strategyId)}
        title={deleting ? `Remove ${deleting.strategyName}` : ''}
        message="Remove this strategy, its rules and its configuration? Refused while any account is subscribed to it."
        confirmLabel="Remove"
        confirmVariant="danger"
        loading={remove.isPending}
      />
    </>
  );
};

const RulesModal: React.FC<{ definition: StrategyDefinitionLive; onClose: () => void }> = ({
  definition,
  onClose,
}) => {
  const queryClient = useQueryClient();
  const [entry, setEntry] = useState<RuleNode | null>(null);
  const [exit, setExit] = useState<RuleNode | null>(null);
  const [longRules, setLongRules] = useState<RuleNode | null>(null);
  const [shortRules, setShortRules] = useState<RuleNode | null>(null);
  const [useIndicatorExit, setUseIndicatorExit] = useState(false);

  const rules = useQuery({
    queryKey: ['strategies', 'rules', definition.strategyName],
    queryFn: () => strategyLiveService.rules(definition.strategyName),
  });
  useEffect(() => {
    if (!rules.data) return;
    setEntry(rules.data.entryRules);
    setExit(rules.data.exitRules);
    setLongRules(rules.data.directionRules?.longRules ?? null);
    setShortRules(rules.data.directionRules?.shortRules ?? null);
    setUseIndicatorExit(rules.data.useIndicatorExit);
  }, [rules.data]);

  const save = useMutation({
    mutationFn: () =>
      strategyLiveService.saveRules(definition.strategyName, {
        entryRules: entry,
        exitRules: exit,
        directionRules:
          longRules || shortRules
            ? { longRules: longRules ?? undefined, shortRules: shortRules ?? undefined }
            : null,
        useIndicatorExit,
      }),
    onSuccess: () => {
      toast.success(`${definition.strategyName}: rules saved`);
      queryClient.invalidateQueries({ queryKey: ['strategies'] });
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Modal show onHide={onClose} size="xl" backdrop="static">
      <Modal.Header closeButton>
        <Modal.Title>Rules: {definition.strategyName}</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        {rules.isLoading && <Spinner />}
        {rules.data && (
          <>
            <p className="text-ink-soft text-sm">
              Entry rules say when; direction rules say which way, for a directional strategy;
              exit rules close a position on their own. A tree the engine cannot read is refused
              at the save, for the reason it would be left out of the morning.
            </p>
            <IndicatorRuleBuilder title="Entry rules" ruleNode={entry} onChange={setEntry} />
            {definition.isDirectional && (
              <>
                <IndicatorRuleBuilder title="Long when" ruleNode={longRules} onChange={setLongRules} />
                <IndicatorRuleBuilder title="Short when" ruleNode={shortRules} onChange={setShortRules} />
              </>
            )}
            <Form.Check
              type="switch"
              label="Exit on indicator rules"
              checked={useIndicatorExit}
              onChange={(e) => setUseIndicatorExit(e.target.checked)}
              className="my-3"
            />
            {useIndicatorExit && (
              <IndicatorRuleBuilder title="Exit rules" ruleNode={exit} onChange={setExit} />
            )}
          </>
        )}
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? 'Saving…' : 'Save rules'}
        </Button>
      </Modal.Footer>
    </Modal>
  );
};

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

const Subscriptions: React.FC = () => {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<SubscriptionLive | null>(null);
  const [form, setForm] = useState<SubscriptionEdit & { tradingClientId?: string; strategyName?: string }>({});
  const [removing, setRemoving] = useState<SubscriptionLive | null>(null);

  const subscriptions = useQuery({
    queryKey: ['strategies', 'subscriptions'],
    queryFn: () => strategyLiveService.subscriptions(),
  });
  const definitions = useQuery({
    queryKey: ['strategies', 'definitions'],
    queryFn: () => strategyLiveService.definitions(),
  });
  const clients = useQuery({
    queryKey: ['trading-clients'],
    queryFn: () => tradingClientService.getAll(),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['strategies'] });

  const save = useMutation({
    mutationFn: () =>
      editing
        ? strategyLiveService.updateSubscription(editing.subscriptionId, form)
        : strategyLiveService.subscribe({
            tradingClientId: form.tradingClientId ?? '',
            strategyName: form.strategyName ?? '',
            capital: form.capital,
            isPaperTrading: form.isPaperTrading,
            riskPercentage: form.riskPercentage,
            absoluteMaxRisk: form.absoluteMaxRisk,
            maxActivePositions: form.maxActivePositions,
          }),
    onSuccess: (saved) => {
      toast.success(`${saved.displayName} · ${saved.strategyName} saved`);
      setCreating(false);
      setEditing(null);
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const toggle = useMutation({
    mutationFn: (s: SubscriptionLive) =>
      s.isActive
        ? strategyLiveService.deactivate(s.subscriptionId)
        : strategyLiveService.activate(s.subscriptionId),
    onSuccess: (saved) => {
      toast.success(saved.isActive ? 'Resumed' : 'Paused: no new entries; open positions are managed to their end');
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: (id: number) => strategyLiveService.unsubscribe(id),
    onSuccess: () => {
      toast.success('Unsubscribed');
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
    onSettled: () => setRemoving(null),
  });

  return (
    <>
      <Card>
        <Card.Header className="flex items-center justify-between">
          <h5 className="mb-0">Subscriptions</h5>
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              setEditing(null);
              setForm({ isPaperTrading: true });
              setCreating(true);
            }}
          >
            <BsPlus className="me-1" />
            Subscribe an account
          </Button>
        </Card.Header>
        <Card.Body>
          {subscriptions.isLoading && <Spinner />}
          {subscriptions.data && subscriptions.data.length === 0 && (
            <Alert variant="info" className="mb-0">
              No subscription yet. A strategy trades only on an account subscribed to it, with
              capital, and only while the strategy is active.
            </Alert>
          )}
          {subscriptions.data && subscriptions.data.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-ink-faint text-xs uppercase">
                  <tr>
                    <th className="py-1 text-left">Account</th>
                    <th className="py-1 text-left">Strategy</th>
                    <th className="py-1 text-right">Capital</th>
                    <th className="py-1 text-left">Mode</th>
                    <th className="py-1 text-left">State</th>
                    <th className="py-1 text-right" />
                  </tr>
                </thead>
                <tbody>
                  {subscriptions.data.map((s) => (
                    <tr key={s.subscriptionId} className="border-t border-hairline">
                      <td className="py-2 pr-3 font-semibold">{s.displayName}</td>
                      <td className="py-2 pr-3 font-mono">{s.strategyName}</td>
                      <td className="py-2 pr-3 text-right font-mono">{money(s.capital)}</td>
                      <td className="py-2 pr-3">
                        <Badge bg={s.isPaperTrading ? 'info' : 'danger'}>{s.isPaperTrading ? 'Paper' : 'Live'}</Badge>
                      </td>
                      <td className="py-2 pr-3">
                        <Badge bg={s.isActive ? 'success' : 'secondary'}>{s.isActive ? 'Active' : 'Paused'}</Badge>
                      </td>
                      <td className="py-2 text-right">
                        <div className="flex justify-end gap-1">
                          <Button variant="outline-secondary" size="sm" onClick={() => toggle.mutate(s)}>
                            {s.isActive ? 'Pause' : 'Resume'}
                          </Button>
                          <Button
                            variant="outline-primary"
                            size="sm"
                            onClick={() => {
                              setCreating(false);
                              setEditing(s);
                              setForm({
                                capital: s.capital ?? undefined,
                                isPaperTrading: s.isPaperTrading,
                                riskPercentage: s.riskPercentage,
                                absoluteMaxRisk: s.absoluteMaxRisk,
                                maxActivePositions: s.maxActivePositions,
                              });
                            }}
                          >
                            <BsPencil />
                          </Button>
                          <Button variant="outline-danger" size="sm" onClick={() => setRemoving(s)}>
                            <BsTrash />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card.Body>
      </Card>

      <Modal
        show={creating || editing !== null}
        onHide={() => {
          setCreating(false);
          setEditing(null);
        }}
        backdrop="static"
      >
        <Modal.Header closeButton>
          <Modal.Title>
            {editing ? `${editing.displayName} · ${editing.strategyName}` : 'Subscribe an account'}
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Form>
            {creating && (
              <Row>
                <Col md={6}>
                  <Form.Group className="mb-3">
                    <Form.Label>Account</Form.Label>
                    <Form.Select
                      value={form.tradingClientId ?? ''}
                      onChange={(e) => setForm({ ...form, tradingClientId: e.target.value })}
                    >
                      <option value="">Choose…</option>
                      {(clients.data ?? []).map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.displayName} ({c.broker}:{c.clientId})
                        </option>
                      ))}
                    </Form.Select>
                  </Form.Group>
                </Col>
                <Col md={6}>
                  <Form.Group className="mb-3">
                    <Form.Label>Strategy</Form.Label>
                    <Form.Select
                      value={form.strategyName ?? ''}
                      onChange={(e) => setForm({ ...form, strategyName: e.target.value })}
                    >
                      <option value="">Choose…</option>
                      {(definitions.data ?? []).map((d) => (
                        <option key={d.strategyId} value={d.strategyName}>
                          {d.strategyName} ({d.status})
                        </option>
                      ))}
                    </Form.Select>
                  </Form.Group>
                </Col>
              </Row>
            )}
            <Row>
              <Col md={6}>
                <Form.Group className="mb-3">
                  <Form.Label>Capital</Form.Label>
                  <Form.Control
                    type="number"
                    value={form.capital ?? ''}
                    onChange={(e) => setForm({ ...form, capital: e.target.value ? Number(e.target.value) : undefined })}
                  />
                  <small className="text-ink-faint">What the strategy may commit on this account. Required.</small>
                </Form.Group>
              </Col>
              <Col md={6}>
                <Form.Check
                  type="switch"
                  label="Paper trading"
                  checked={form.isPaperTrading ?? false}
                  onChange={(e) => setForm({ ...form, isPaperTrading: e.target.checked })}
                  className="mt-4"
                />
                <small className="text-ink-faint">
                  Simulated fills off the same signals; nothing reaches the broker.
                </small>
              </Col>
            </Row>
            <Row>
              <Col md={4}>
                <Form.Group className="mb-3">
                  <Form.Label>Risk % (override)</Form.Label>
                  <Form.Control
                    type="number"
                    value={form.riskPercentage ?? ''}
                    onChange={(e) =>
                      setForm({ ...form, riskPercentage: e.target.value ? Number(e.target.value) : null })
                    }
                  />
                </Form.Group>
              </Col>
              <Col md={4}>
                <Form.Group className="mb-3">
                  <Form.Label>Absolute max risk</Form.Label>
                  <Form.Control
                    type="number"
                    value={form.absoluteMaxRisk ?? ''}
                    onChange={(e) =>
                      setForm({ ...form, absoluteMaxRisk: e.target.value ? Number(e.target.value) : null })
                    }
                  />
                </Form.Group>
              </Col>
              <Col md={4}>
                <Form.Group className="mb-3">
                  <Form.Label>Max active positions</Form.Label>
                  <Form.Control
                    type="number"
                    value={form.maxActivePositions ?? ''}
                    onChange={(e) =>
                      setForm({ ...form, maxActivePositions: e.target.value ? Number(e.target.value) : null })
                    }
                  />
                </Form.Group>
              </Col>
            </Row>
          </Form>
        </Modal.Body>
        <Modal.Footer>
          <Button
            variant="secondary"
            onClick={() => {
              setCreating(false);
              setEditing(null);
            }}
          >
            Cancel
          </Button>
          <Button variant="primary" disabled={save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </Modal.Footer>
      </Modal>

      <ConfirmModal
        show={removing !== null}
        onHide={() => setRemoving(null)}
        onConfirm={() => removing && remove.mutate(removing.subscriptionId)}
        title={removing ? `Unsubscribe ${removing.displayName} from ${removing.strategyName}` : ''}
        message="Remove this subscription? The strategy stops entering on this account at once; positions already open are managed to their end."
        confirmLabel="Unsubscribe"
        confirmVariant="danger"
        loading={remove.isPending}
      />
    </>
  );
};

export default StrategyEnginePage;
