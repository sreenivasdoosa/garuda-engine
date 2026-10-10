/**
 * The Strategy Engine: what to trade, under which rules, on whose account.
 *
 * A strategy here is a spec, not a template: its underlying, its product and
 * its legs, each leg a selector the engine's registry knows -- a strike by
 * moneyness, a strike by premium, the near-month future. Rules say when it
 * enters, which way, and when it leaves, through the rule builder the engine
 * reads as it is. A subscription puts the strategy on a trading client with
 * capital, live or paper.
 *
 * **A strategy the engine would refuse is refused at the save**, with the
 * reason the morning's log would otherwise give. And every write reaches the
 * running engine: a subscription made at ten is swept at ten.
 */

import { useEffect, useMemo, useState } from 'react';
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
import { symbolService } from '@/services/admin/v2AdminService';
import { strategyLiveService } from '@/services/admin/strategyLiveService';
import { tradingClientService } from '@/services/admin/tradingClientService';
import type { RuleNode } from '@/types/strategy-engine';
import type {
  Leg,
  StrategyDefinitionEdit,
  StrategyDefinitionLive,
  SubscriptionEdit,
  SubscriptionLive,
} from '@/types/strategy-live';
import IndicatorRuleBuilder from './IndicatorRuleBuilder';

type Tab = 'definitions' | 'subscriptions';

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
      </Nav>
      {tab === 'definitions' ? <Definitions /> : <Subscriptions />}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

const emptyLeg = (): Leg => ({
  instrument: { type: 'option_strike', option_type: 'CALL', moneyness: 'ATM' },
  side: 'ALWAYS_SHORT',
  role: 'MAIN',
});

const blankDefinition = (): StrategyDefinitionEdit => ({
  strategyName: '',
  displayName: '',
  underlyingSymbol: '',
  exchange: 'NSE',
  product: 'INTRADAY',
  expiryType: 'WEEKLY',
  startTime: '09:20:00',
  stopTime: '15:10:00',
  isDirectional: false,
  legs: [emptyLeg()],
});

const Definitions: React.FC = () => {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<StrategyDefinitionLive | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<StrategyDefinitionEdit>(blankDefinition());
  const [rulesFor, setRulesFor] = useState<StrategyDefinitionLive | null>(null);
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
  const symbols = useQuery({
    queryKey: ['symbols'],
    queryFn: () => symbolService.getAll(),
    staleTime: 5 * 60 * 1000,
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
    setForm({
      displayName: d.displayName ?? '',
      underlyingSymbol: d.underlyingSymbol,
      exchange: d.exchange,
      product: d.product,
      expiryType: d.expiryType,
      startTime: d.startTime,
      stopTime: d.stopTime,
      isDirectional: Boolean(d.isDirectional),
      capitalPerLot: d.capitalPerLot,
      riskPercentage: d.riskPercentage,
      absoluteMaxRisk: d.absoluteMaxRisk,
      legs: d.legs.length ? d.legs : [emptyLeg()],
    });
  };

  const underlyings = useMemo(() => {
    const rows = (symbols.data ?? []) as { symbol: string; exchange: string }[];
    return rows.filter((s) => !form.exchange || s.exchange === form.exchange);
  }, [symbols.data, form.exchange]);

  const setLeg = (index: number, leg: Leg) =>
    setForm((f) => ({ ...f, legs: (f.legs ?? []).map((l, i) => (i === index ? leg : l)) }));

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
                    <th className="py-1 text-left">Legs</th>
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
                        {d.legs.map((l, i) => (
                          <div key={i} className="font-mono">
                            {l.side ?? 'ALWAYS_SHORT'} {l.instrument.type}
                            {Object.entries(l.instrument)
                              .filter(([k]) => k !== 'type')
                              .map(([k, v]) => ` ${k}=${String(v)}`)
                              .join('')}
                            {l.role && l.role !== 'MAIN' ? ` (${l.role})` : ''}
                          </div>
                        ))}
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
        size="lg"
        backdrop="static"
      >
        <Modal.Header closeButton>
          <Modal.Title>{editing ? editing.strategyName : 'New strategy'}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Form>
            <Row>
              {creating && (
                <Col md={4}>
                  <Form.Group className="mb-3">
                    <Form.Label>Name</Form.Label>
                    <Form.Control
                      value={form.strategyName ?? ''}
                      onChange={(e) => setForm({ ...form, strategyName: e.target.value })}
                      placeholder="nifty-straddle"
                    />
                    <small className="text-ink-faint">Fixed once saved; every trade carries it.</small>
                  </Form.Group>
                </Col>
              )}
              <Col md={creating ? 4 : 6}>
                <Form.Group className="mb-3">
                  <Form.Label>Display name</Form.Label>
                  <Form.Control
                    value={form.displayName ?? ''}
                    onChange={(e) => setForm({ ...form, displayName: e.target.value })}
                  />
                </Form.Group>
              </Col>
              <Col md={creating ? 4 : 6}>
                <Form.Group className="mb-3">
                  <Form.Label>Product</Form.Label>
                  <Form.Select
                    value={form.product ?? 'INTRADAY'}
                    onChange={(e) =>
                      setForm({ ...form, product: e.target.value as StrategyDefinitionEdit['product'] })
                    }
                  >
                    {(catalog.data?.definitionProducts ?? ['INTRADAY', 'POSITIONAL']).map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </Form.Select>
                </Form.Group>
              </Col>
            </Row>
            <Row>
              <Col md={3}>
                <Form.Group className="mb-3">
                  <Form.Label>Exchange</Form.Label>
                  <Form.Select
                    value={form.exchange ?? 'NSE'}
                    onChange={(e) => setForm({ ...form, exchange: e.target.value, underlyingSymbol: '' })}
                  >
                    {[...new Set(((symbols.data ?? []) as { exchange: string }[]).map((s) => s.exchange))].map(
                      (x) => (
                        <option key={x} value={x}>
                          {x}
                        </option>
                      ),
                    )}
                  </Form.Select>
                </Form.Group>
              </Col>
              <Col md={3}>
                <Form.Group className="mb-3">
                  <Form.Label>Underlying</Form.Label>
                  <Form.Select
                    value={form.underlyingSymbol ?? ''}
                    onChange={(e) => setForm({ ...form, underlyingSymbol: e.target.value })}
                  >
                    <option value="">Choose…</option>
                    {underlyings.map((s) => (
                      <option key={s.symbol} value={s.symbol}>
                        {s.symbol}
                      </option>
                    ))}
                  </Form.Select>
                  <small className="text-ink-faint">A symbol curated on the Symbols page.</small>
                </Form.Group>
              </Col>
              <Col md={2}>
                <Form.Group className="mb-3">
                  <Form.Label>Expiry</Form.Label>
                  <Form.Select
                    value={form.expiryType ?? 'WEEKLY'}
                    onChange={(e) =>
                      setForm({ ...form, expiryType: e.target.value as 'WEEKLY' | 'MONTHLY' })
                    }
                  >
                    <option value="WEEKLY">Weekly</option>
                    <option value="MONTHLY">Monthly</option>
                  </Form.Select>
                </Form.Group>
              </Col>
              <Col md={2}>
                <Form.Group className="mb-3">
                  <Form.Label>Start</Form.Label>
                  <Form.Control
                    value={form.startTime ?? ''}
                    onChange={(e) => setForm({ ...form, startTime: e.target.value })}
                    placeholder="09:20:00"
                  />
                </Form.Group>
              </Col>
              <Col md={2}>
                <Form.Group className="mb-3">
                  <Form.Label>Stop</Form.Label>
                  <Form.Control
                    value={form.stopTime ?? ''}
                    onChange={(e) => setForm({ ...form, stopTime: e.target.value })}
                    placeholder="15:10:00"
                  />
                </Form.Group>
              </Col>
            </Row>
            <Row>
              <Col md={4}>
                <Form.Check
                  type="switch"
                  label="Directional"
                  checked={form.isDirectional ?? false}
                  onChange={(e) => setForm({ ...form, isDirectional: e.target.checked })}
                  className="mb-1"
                />
                <small className="text-ink-faint">
                  A directional strategy needs direction rules before it can go active; its legs
                  take the side the rules decide.
                </small>
              </Col>
              <Col md={4}>
                <Form.Group className="mb-3">
                  <Form.Label>Risk % of capital per day</Form.Label>
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
            </Row>

            <h6 className="mt-2">Legs</h6>
            <small className="text-ink-faint">
              Each leg is a selector the engine knows. A straddle is two option_strike legs, a call
              and a put, both ALWAYS_SHORT. Fields the selector does not take are refused at the save.
            </small>
            {(form.legs ?? []).map((leg, index) => (
              <LegEditor
                key={index}
                leg={leg}
                index={index}
                catalog={catalog.data}
                onChange={(next) => setLeg(index, next)}
                onRemove={() =>
                  setForm((f) => ({ ...f, legs: (f.legs ?? []).filter((_, i) => i !== index) }))
                }
              />
            ))}
            <Button
              variant="outline-secondary"
              size="sm"
              className="mt-2"
              onClick={() => setForm((f) => ({ ...f, legs: [...(f.legs ?? []), emptyLeg()] }))}
            >
              <BsPlus /> Add leg
            </Button>
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

const LegEditor: React.FC<{
  leg: Leg;
  index: number;
  catalog: { selectors: { type: string; fields: string[] }[]; sideRules: string[]; legRoles: string[] } | undefined;
  onChange: (leg: Leg) => void;
  onRemove: () => void;
}> = ({ leg, index, catalog, onChange, onRemove }) => {
  const selector = catalog?.selectors.find((s) => s.type === leg.instrument.type);
  const fields = (selector?.fields ?? []).filter((f) => f !== 'type');
  const setField = (name: string, value: string) => {
    const instrument = { ...leg.instrument };
    if (value === '') delete instrument[name];
    else instrument[name] = /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value;
    onChange({ ...leg, instrument });
  };
  return (
    <div className="mt-2 rounded border border-hairline p-2">
      <Row>
        <Col md={2}>
          <Form.Label className="text-xs">Leg {index + 1}: role</Form.Label>
          <Form.Select
            value={leg.role ?? 'MAIN'}
            onChange={(e) => onChange({ ...leg, role: e.target.value })}
          >
            {(catalog?.legRoles ?? ['MAIN', 'HEDGE']).map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </Form.Select>
        </Col>
        <Col md={3}>
          <Form.Label className="text-xs">Side</Form.Label>
          <Form.Select
            value={leg.side ?? 'ALWAYS_SHORT'}
            onChange={(e) => onChange({ ...leg, side: e.target.value as Leg['side'] })}
          >
            {(catalog?.sideRules ?? ['ALWAYS_SHORT', 'ALWAYS_LONG', 'SAME_AS_SIGNAL', 'OPPOSITE']).map(
              (s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ),
            )}
          </Form.Select>
        </Col>
        <Col md={3}>
          <Form.Label className="text-xs">Instrument</Form.Label>
          <Form.Select
            value={leg.instrument.type}
            onChange={(e) => onChange({ ...leg, instrument: { type: e.target.value } })}
          >
            {(catalog?.selectors ?? [{ type: 'option_strike', fields: [] }]).map((s) => (
              <option key={s.type} value={s.type}>
                {s.type}
              </option>
            ))}
          </Form.Select>
        </Col>
        <Col md={3} className="flex flex-wrap gap-2">
          {fields.map((f) => (
            <div key={f}>
              <Form.Label className="text-xs">{f}</Form.Label>
              <Form.Control
                size="sm"
                value={leg.instrument[f] === undefined ? '' : String(leg.instrument[f])}
                onChange={(e) => setField(f, e.target.value)}
                placeholder="default"
              />
            </div>
          ))}
        </Col>
        <Col md={1} className="flex items-end justify-end">
          <Button variant="outline-danger" size="sm" onClick={onRemove}>
            <BsTrash />
          </Button>
        </Col>
      </Row>
    </div>
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
