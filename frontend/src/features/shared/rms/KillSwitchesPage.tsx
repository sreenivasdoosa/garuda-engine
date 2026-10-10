/**
 * Kill Switches: the operator's hand on the brake.
 *
 * A switch stops entries at a scope -- everything, an exchange, a symbol,
 * a trading client -- and never stops an exit. It takes effect on the next
 * order, not the next restart. Three states, each a separate action: on,
 * off (listed, stops nothing), removed (gone from today's list, row kept).
 * A switch belongs to the venue's day; yesterday's does not stop today.
 */

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { BsArrowRepeat, BsStopCircle } from 'react-icons/bs';
import { Alert, Badge, Button, Card, Col, Form, Modal, Row, Spinner, Table } from '@/components/ui/rbShim';
import { ConfirmModal, PageHeader } from '@/components/common';
import { rmsLiveService } from '@/services/admin/rmsLiveService';
import { exchangeService, symbolService } from '@/services/admin/v2AdminService';
import { tradingClientService } from '@/services/admin/tradingClientService';
import type { KillLevel, KillSwitchEntry, KillSwitchRequest } from '@/types/rms-live';

const LEVELS: { value: KillLevel; label: string; description: string }[] = [
  { value: 'GLOBAL', label: 'Everything', description: 'No entry leaves the engine, on any account' },
  { value: 'EXCHANGE', label: 'Exchange', description: 'No entry on one venue' },
  { value: 'SYMBOL', label: 'Symbol', description: 'No entry on one underlying, on any account' },
  { value: 'CLIENT', label: 'Trading client', description: 'No entry on one account' },
];

const LEVEL_TONE: Record<KillLevel, string> = {
  GLOBAL: 'danger',
  EXCHANGE: 'warning',
  SYMBOL: 'primary',
  CLIENT: 'secondary',
};
const LEVEL_ORDER: Record<KillLevel, number> = { GLOBAL: 0, EXCHANGE: 1, SYMBOL: 2, CLIENT: 3 };

const SOURCES: { source: string; label: string; description: string }[] = [
  { source: 'DAILY_LOSS', label: 'Daily loss', description: 'Would trip when an account reaches its daily loss limit' },
  { source: 'REJECTION_RATE', label: 'Rejection rate', description: 'Would trip when too many of an account’s orders are rejected' },
  { source: 'VOLATILITY', label: 'Volatility', description: 'Would stop everything when the VIX passes its limit' },
];

const scopeOf = (e: KillSwitchEntry): string => {
  switch (e.level) {
    case 'GLOBAL':
      return 'everything';
    case 'EXCHANGE':
      return e.exchange ?? '-';
    case 'SYMBOL':
      return e.symbol ?? '-';
    default:
      return e.tradingClient ? `${e.tradingClient} (${e.broker})` : (e.tradingClientId ?? '-');
  }
};

const KillSwitchesPage: React.FC = () => {
  const queryClient = useQueryClient();
  const [activating, setActivating] = useState(false);
  const [form, setForm] = useState<KillSwitchRequest>({ level: 'CLIENT', reason: '' });
  const [removingAll, setRemovingAll] = useState(false);
  const [disarming, setDisarming] = useState<string | null>(null);

  const status = useQuery({
    queryKey: ['rms', 'kill-switch'],
    queryFn: () => rmsLiveService.killSwitches(),
    refetchInterval: 10000,
  });
  const exchanges = useQuery({ queryKey: ['exchanges'], queryFn: () => exchangeService.getAll() });
  const symbols = useQuery({ queryKey: ['symbols'], queryFn: () => symbolService.getAll() });
  const clients = useQuery({ queryKey: ['trading-clients'], queryFn: () => tradingClientService.getAll() });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['rms'] });
  const failed = (e: Error) => toast.error(e.message);

  const activate = useMutation({
    mutationFn: (request: KillSwitchRequest) => rmsLiveService.activate(request),
    onSuccess: (entry) => {
      toast.warning(`Kill switch on ${scopeOf(entry)} is ON`);
      setActivating(false);
      refresh();
    },
    onError: failed,
  });
  const deactivate = useMutation({
    mutationFn: (keys: string[]) => rmsLiveService.deactivate(keys),
    onSuccess: (r) => {
      toast.success(`${r.deactivated.length} switch(es) turned off`);
      refresh();
    },
    onError: failed,
  });
  const removeSome = useMutation({
    mutationFn: (keys: string[]) => rmsLiveService.removeSwitches(keys),
    onSuccess: (r) => {
      toast.success(`${r.removed.length} switch(es) removed`);
      refresh();
    },
    onError: failed,
  });
  const removeAll = useMutation({
    mutationFn: () => rmsLiveService.removeAllSwitches(),
    onSuccess: () => {
      toast.success('All kill switches removed');
      setRemovingAll(false);
      refresh();
    },
    onError: failed,
  });
  const setSource = useMutation({
    mutationFn: (v: { source: string; enabled: boolean; alsoRemoveInstances: boolean }) =>
      rmsLiveService.setSource(v.source, v.enabled, v.alsoRemoveInstances),
    onSuccess: (r) => {
      toast.success(`${r.source} ${r.enabled ? 'armed' : 'disarmed'}`);
      setDisarming(null);
      refresh();
    },
    onError: failed,
  });

  const switches = useMemo(
    () =>
      [...(status.data?.switches ?? [])].sort((a, b) =>
        a.active !== b.active ? (a.active ? -1 : 1) : LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level],
      ),
    [status.data],
  );
  const onCount = switches.filter((s) => s.active).length;
  const offCount = switches.length - onCount;
  const busy = activate.isPending || deactivate.isPending || removeSome.isPending || removeAll.isPending;

  const formValid =
    form.level === 'GLOBAL' ||
    (form.level === 'EXCHANGE' && !!form.exchange) ||
    (form.level === 'SYMBOL' && !!form.symbol) ||
    (form.level === 'CLIENT' && !!form.tradingClientId);

  const turnBackOn = (e: KillSwitchEntry) =>
    activate.mutate({
      level: e.level,
      exchange: e.exchange,
      symbol: e.symbol,
      tradingClientId: e.tradingClientId,
      reason: e.reason,
    });

  if (status.error) {
    return (
      <div>
        <PageHeader title="Kill Switches" subtitle="The operator's hand on the brake" icon={<BsStopCircle size={24} />} />
        <Alert variant="danger">Could not load the kill switches: {(status.error as Error).message}</Alert>
      </div>
    );
  }

  return (
    <div className="fade-in">
      <PageHeader
        title="Kill Switches"
        subtitle="Stop entries at a scope, on the next order. An exit is never stopped."
        icon={<BsStopCircle size={24} />}
      />

      <Row className="mb-4">
        <Col md={3}>
          <Card className="h-full text-center">
            <Card.Body>
              <h2 className={onCount > 0 ? 'text-danger-500' : 'text-success-500'}>{onCount}</h2>
              <small className="text-ink-soft">On</small>
            </Card.Body>
          </Card>
        </Col>
        <Col md={3}>
          <Card className="h-full text-center">
            <Card.Body>
              <h2 className="text-ink-soft">{offCount}</h2>
              <small className="text-ink-soft">Off, still listed</small>
            </Card.Body>
          </Card>
        </Col>
        <Col md={3}>
          <Card className="h-full text-center">
            <Card.Body>
              <h2 className="text-ink">{status.data?.date ?? '…'}</h2>
              <small className="text-ink-soft">Venue day the list belongs to</small>
            </Card.Body>
          </Card>
        </Col>
        <Col md={3}>
          <Card className="h-full">
            <Card.Body className="flex flex-col items-center justify-center gap-2">
              <Button variant="danger" size="sm" onClick={() => setActivating(true)}>
                <BsStopCircle className="me-1" /> Set a kill switch
              </Button>
              {switches.length > 0 && (
                <Button variant="outline-danger" size="sm" onClick={() => setRemovingAll(true)}>
                  Remove all
                </Button>
              )}
              <Button variant="outline-secondary" size="sm" onClick={() => status.refetch()}>
                <BsArrowRepeat className="me-1" /> Refresh
              </Button>
            </Card.Body>
          </Card>
        </Col>
      </Row>

      <Card className="mb-4">
        <Card.Header className="flex items-center justify-between">
          <h6 className="mb-0">
            <BsStopCircle className="me-2 text-danger-500" />
            Switches
          </h6>
        </Card.Header>
        <Card.Body className="p-0">
          {status.isLoading ? (
            <div className="py-4 text-center">
              <Spinner size="sm" />
            </div>
          ) : switches.length === 0 ? (
            <Alert variant="success" className="m-4 mb-0">
              Nothing is stopped.
            </Alert>
          ) : (
            <Table className="mb-0" size="sm">
              <thead>
                <tr>
                  <th>State</th>
                  <th>Level</th>
                  <th>Scope</th>
                  <th>Source</th>
                  <th>Reason</th>
                  <th>Set at</th>
                  <th>By</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {switches.map((e) => (
                  <tr key={e.key} className={e.active ? '' : 'text-ink-soft'}>
                    <td>
                      <Badge bg={e.active ? 'danger' : 'secondary'}>{e.active ? 'ON' : 'OFF'}</Badge>
                    </td>
                    <td>
                      <Badge bg={LEVEL_TONE[e.level]}>{e.level}</Badge>
                    </td>
                    <td className="font-semibold">{scopeOf(e)}</td>
                    <td>{e.source}</td>
                    <td className="text-sm">{e.reason}</td>
                    <td className="text-xs">{e.updatedAt ? new Date(e.updatedAt).toLocaleTimeString() : '-'}</td>
                    <td className="text-xs">{e.updatedBy ?? '-'}</td>
                    <td className="text-end">
                      <div className="flex justify-end gap-1">
                        {e.active ? (
                          <Button variant="outline-success" size="sm" disabled={busy} onClick={() => deactivate.mutate([e.key])}>
                            Turn off
                          </Button>
                        ) : (
                          <Button variant="outline-danger" size="sm" disabled={busy} onClick={() => turnBackOn(e)}>
                            Turn on
                          </Button>
                        )}
                        <Button variant="outline-secondary" size="sm" disabled={busy} onClick={() => removeSome.mutate([e.key])}>
                          Remove
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card.Body>
      </Card>

      <Card className="mb-4">
        <Card.Header>
          <h6 className="mb-0">Automatic sources</h6>
        </Card.Header>
        <Card.Body className="p-0">
          <div className="border-b border-hairline bg-raised p-2">
            <small className="text-ink-soft">
              {status.data?.automaticSourcesBuilt
                ? 'A disarmed source cannot raise a switch. The setting survives restarts.'
                : 'Nothing raises a switch on its own yet: the gate refuses at the daily loss limit instead, and the other two circuits are not built. The flags are kept so a ported configuration keeps its meaning, and a switch from a disarmed source would not apply.'}
            </small>
          </div>
          <Table className="mb-0" size="sm">
            <tbody>
              {SOURCES.map((t) => {
                const armed = status.data?.typeStates?.[t.source] !== false;
                return (
                  <tr key={t.source}>
                    <td style={{ width: 180 }}>
                      <strong>{t.label}</strong>
                    </td>
                    <td>
                      <small className="text-ink-soft">{t.description}</small>
                    </td>
                    <td style={{ width: 200 }} className="text-end">
                      <Badge bg={armed ? 'success' : 'secondary'} className="me-2">
                        {armed ? 'ARMED' : 'DISARMED'}
                      </Badge>
                      <Form.Check
                        type="switch"
                        checked={armed}
                        disabled={setSource.isPending}
                        onChange={() =>
                          armed
                            ? setDisarming(t.source)
                            : setSource.mutate({ source: t.source, enabled: true, alsoRemoveInstances: false })
                        }
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </Card.Body>
      </Card>

      <Modal show={activating} onHide={() => setActivating(false)}>
        <Modal.Header closeButton>
          <Modal.Title>Set a kill switch</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Form>
            <Form.Group className="mb-3">
              <Form.Label>Stop</Form.Label>
              <Form.Select value={form.level} onChange={(e) => setForm({ level: e.target.value as KillLevel, reason: form.reason })}>
                {LEVELS.map((l) => (
                  <option key={l.value} value={l.value}>
                    {l.label} — {l.description}
                  </option>
                ))}
              </Form.Select>
            </Form.Group>
            {form.level === 'EXCHANGE' && (
              <Form.Group className="mb-3">
                <Form.Label>Exchange</Form.Label>
                <Form.Select value={form.exchange ?? ''} onChange={(e) => setForm({ ...form, exchange: e.target.value || null })}>
                  <option value="">choose</option>
                  {(exchanges.data ?? []).map((ex) => (
                    <option key={ex.exchange} value={ex.exchange}>
                      {ex.exchange}
                    </option>
                  ))}
                </Form.Select>
              </Form.Group>
            )}
            {form.level === 'SYMBOL' && (
              <Form.Group className="mb-3">
                <Form.Label>Symbol</Form.Label>
                <Form.Select value={form.symbol ?? ''} onChange={(e) => setForm({ ...form, symbol: e.target.value || null })}>
                  <option value="">choose</option>
                  {(symbols.data ?? []).map((s) => (
                    <option key={s.symbol} value={s.symbol}>
                      {s.symbol}
                    </option>
                  ))}
                </Form.Select>
              </Form.Group>
            )}
            {form.level === 'CLIENT' && (
              <Form.Group className="mb-3">
                <Form.Label>Trading client</Form.Label>
                <Form.Select
                  value={form.tradingClientId ?? ''}
                  onChange={(e) => setForm({ ...form, tradingClientId: e.target.value || null })}
                >
                  <option value="">choose</option>
                  {(clients.data ?? []).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.displayName} ({c.broker})
                    </option>
                  ))}
                </Form.Select>
              </Form.Group>
            )}
            <Form.Group className="mb-3">
              <Form.Label>Reason</Form.Label>
              <Form.Control value={form.reason ?? ''} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder="what happened" />
            </Form.Group>
            <small className="text-ink-faint">
              Entries stop on the next order. Stop-losses and square-offs still go out.
            </small>
          </Form>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={() => setActivating(false)}>
            Cancel
          </Button>
          <Button variant="danger" disabled={!formValid || activate.isPending} onClick={() => activate.mutate(form)}>
            {activate.isPending ? 'Setting…' : 'Set the switch'}
          </Button>
        </Modal.Footer>
      </Modal>

      <ConfirmModal
        show={removingAll}
        onHide={() => setRemovingAll(false)}
        onConfirm={() => removeAll.mutate()}
        title="Remove every kill switch"
        message="Every switch on today's list goes, on and off alike. Entries resume on the next order."
        confirmLabel="Remove all"
        confirmVariant="danger"
        loading={removeAll.isPending}
      />

      <Modal show={disarming !== null} onHide={() => setDisarming(null)}>
        <Modal.Header closeButton>
          <Modal.Title>Disarm {disarming}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          A disarmed source cannot raise a switch. Switches it already raised can stay listed, or go with it.
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={() => setDisarming(null)}>
            Cancel
          </Button>
          <Button
            variant="outline-warning"
            disabled={setSource.isPending}
            onClick={() => disarming && setSource.mutate({ source: disarming, enabled: false, alsoRemoveInstances: false })}
          >
            Disarm only
          </Button>
          <Button
            variant="warning"
            disabled={setSource.isPending}
            onClick={() => disarming && setSource.mutate({ source: disarming, enabled: false, alsoRemoveInstances: true })}
          >
            Disarm and remove its switches
          </Button>
        </Modal.Footer>
      </Modal>
    </div>
  );
};

export default KillSwitchesPage;
