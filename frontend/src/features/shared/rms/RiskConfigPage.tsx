/**
 * RMS Config: the limits the gate enforces, by scope.
 *
 * A row is scoped by what it names -- an exchange, a symbol, a trading
 * client, a segment -- and the gate takes the narrowest row that applies,
 * column by column. The scope is read from those columns, never from a
 * label, so the preview here shows exactly what the engine would enforce
 * on one order and where each value came from.
 *
 * A limit left blank is "not set at this scope" and defers to a broader
 * one. A limit that means nothing at a row's scope -- a rate limit on a
 * symbol row -- is not offered there, and dropped if sent. Limits the gate
 * reads today are marked; the rest are stored for checks not yet built.
 */

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { BsPencil, BsPlus, BsShieldLock, BsTrash } from 'react-icons/bs';
import { Alert, Badge, Button, Card, Col, Form, Modal, Row, Spinner } from '@/components/ui/rbShim';
import { ConfirmModal, PageHeader } from '@/components/common';
import { rmsLiveService } from '@/services/admin/rmsLiveService';
import { exchangeService, symbolService } from '@/services/admin/v2AdminService';
import { tradingClientService } from '@/services/admin/tradingClientService';
import type { RiskCatalog, RiskEdit, RiskLevel, RiskRow } from '@/types/rms-live';

const levelOf = (form: RiskEdit): RiskLevel =>
  form.tradingClientId ? 'CLIENT' : form.symbol ? 'SYMBOL' : form.exchange ? 'EXCHANGE' : 'GLOBAL';

const LEVEL_TONE: Record<RiskLevel, string> = {
  GLOBAL: 'secondary',
  EXCHANGE: 'warning',
  SYMBOL: 'primary',
  CLIENT: 'success',
};

const RiskConfigPage: React.FC = () => {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<RiskRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<RiskEdit>({});
  const [deleting, setDeleting] = useState<RiskRow | null>(null);
  const [preview, setPreview] = useState({ segmentType: 'OPTIONS', exchange: '', symbol: '', tradingClientId: '' });

  const catalog = useQuery({
    queryKey: ['rms', 'catalog'],
    queryFn: () => rmsLiveService.catalog(),
    staleTime: 10 * 60 * 1000,
  });
  const status = useQuery({
    queryKey: ['rms', 'status'],
    queryFn: () => rmsLiveService.status(),
    refetchInterval: 30000,
  });
  const rows = useQuery({ queryKey: ['rms', 'rows'], queryFn: () => rmsLiveService.rows() });
  const exchanges = useQuery({ queryKey: ['exchanges'], queryFn: () => exchangeService.getAll() });
  const symbols = useQuery({ queryKey: ['symbols'], queryFn: () => symbolService.getAll() });
  const clients = useQuery({ queryKey: ['trading-clients'], queryFn: () => tradingClientService.getAll() });
  const effective = useQuery({
    queryKey: ['rms', 'effective', preview],
    queryFn: () => rmsLiveService.effective(preview),
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['rms'] });

  const save = useMutation({
    mutationFn: () => (editing ? rmsLiveService.update(editing.id, form) : rmsLiveService.create(form)),
    onSuccess: (saved) => {
      toast.success(`${saved.scope}: limits saved`);
      setEditing(null);
      setCreating(false);
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: (id: number) => rmsLiveService.remove(id),
    onSuccess: () => {
      toast.success('Row removed');
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
    onSettled: () => setDeleting(null),
  });

  const fields = catalog.data?.fields ?? {};

  const openCreate = () => {
    setEditing(null);
    setForm({ exchange: null, symbol: null, tradingClientId: null, segmentType: null, isActive: true });
    setCreating(true);
  };
  const openEdit = (row: RiskRow) => {
    setCreating(false);
    setEditing(row);
    const values: RiskEdit = {
      exchange: row.exchange,
      symbol: row.symbol,
      tradingClientId: row.tradingClientId,
      segmentType: row.segmentType,
      isActive: row.isActive,
    };
    for (const name of Object.keys(fields)) values[name] = row[name] ?? null;
    setForm(values);
  };

  const cards = [
    { label: 'Active limit rows', value: status.data?.activeConfigRows ?? '…', cls: 'text-primary-500' },
    {
      label: 'Kill switches on',
      value: status.data?.activeKillSwitchCount ?? '…',
      cls: status.data?.activeKillSwitchCount ? 'text-danger-500' : 'text-success-500',
    },
    {
      label: 'Breaches today',
      value: status.data?.breachesToday ?? '…',
      cls: status.data?.breachesToday ? 'text-warning-500' : 'text-success-500',
    },
    { label: 'Gate', value: 'always on', cls: 'text-success-500' },
  ];

  return (
    <div className="fade-in">
      <PageHeader
        title="RMS Config"
        subtitle="The limits the gate enforces, by scope: the narrowest row that applies wins, column by column"
        icon={<BsShieldLock size={24} />}
      />

      <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4">
        {cards.map((c) => (
          <div key={c.label} className="rounded-card border border-hairline bg-card p-4 text-center">
            <div className={`text-2xl font-bold ${c.cls}`}>{c.value}</div>
            <div className="text-xs text-ink-soft">{c.label}</div>
          </div>
        ))}
      </div>

      <Row>
        <Col lg={7}>
          <Card className="mb-4">
            <Card.Header className="flex items-center justify-between">
              <h5 className="mb-0">Limit rows</h5>
              <Button variant="primary" size="sm" onClick={openCreate}>
                <BsPlus className="me-1" />
                Add row
              </Button>
            </Card.Header>
            <Card.Body>
              {rows.isLoading && <Spinner />}
              {rows.data && rows.data.length === 0 && (
                <Alert variant="info" className="mb-0">
                  No limits configured: only the unconfigurable checks apply -- market closed, no
                  quote, zero price, a quote older than 30 seconds. Start with a global row.
                </Alert>
              )}
              {rows.data && rows.data.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="text-ink-faint text-xs uppercase">
                      <tr>
                        <th className="py-1 text-left">Scope</th>
                        <th className="py-1 text-left">Level</th>
                        <th className="py-1 text-left">Sets</th>
                        <th className="py-1 text-right" />
                      </tr>
                    </thead>
                    <tbody>
                      {rows.data.map((r) => (
                        <tr key={r.id} className={`border-t border-hairline align-top ${r.isActive ? '' : 'text-ink-faint'}`}>
                          <td className="py-2 pr-3">
                            <div className="font-semibold">{r.scope}</div>
                            {!r.isActive && <Badge bg="secondary">inactive</Badge>}
                          </td>
                          <td className="py-2 pr-3">
                            <Badge bg={LEVEL_TONE[r.configLevel]}>{r.configLevel}</Badge>
                          </td>
                          <td className="py-2 pr-3 text-xs">
                            {r.setFields.length === 0 && <span className="text-ink-faint">nothing yet</span>}
                            {r.setFields.map((f) => (
                              <span key={f} className="me-2 inline-block font-mono">
                                {f}={String(r[f])}
                                {fields[f]?.enforced === false && (
                                  <span className="text-ink-faint" title="stored; no check reads it yet">
                                    *
                                  </span>
                                )}
                              </span>
                            ))}
                          </td>
                          <td className="py-2 text-right">
                            <div className="flex justify-end gap-1">
                              <Button variant="outline-primary" size="sm" onClick={() => openEdit(r)}>
                                <BsPencil />
                              </Button>
                              <Button variant="outline-danger" size="sm" onClick={() => setDeleting(r)}>
                                <BsTrash />
                              </Button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <small className="text-ink-faint">
                    * stored for a check not yet built; it does not take effect today.
                  </small>
                </div>
              )}
            </Card.Body>
          </Card>
        </Col>

        <Col lg={5}>
          <Card className="mb-4">
            <Card.Header>
              <h5 className="mb-0">What the gate would enforce</h5>
            </Card.Header>
            <Card.Body>
              <p className="text-ink-soft text-sm">
                For one order: pick what it is and whose it is. Merged exactly as the gate merges it,
                with where each value came from.
              </p>
              <Row>
                <Col md={6}>
                  <Form.Group className="mb-2">
                    <Form.Label>Segment</Form.Label>
                    <Form.Select
                      value={preview.segmentType}
                      onChange={(e) => setPreview({ ...preview, segmentType: e.target.value })}
                    >
                      {(catalog.data?.segments ?? []).map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </Form.Select>
                  </Form.Group>
                </Col>
                <Col md={6}>
                  <Form.Group className="mb-2">
                    <Form.Label>Exchange</Form.Label>
                    <Form.Select value={preview.exchange} onChange={(e) => setPreview({ ...preview, exchange: e.target.value })}>
                      <option value="">any</option>
                      {(exchanges.data ?? []).map((ex) => (
                        <option key={ex.exchange} value={ex.exchange}>
                          {ex.exchange}
                        </option>
                      ))}
                    </Form.Select>
                  </Form.Group>
                </Col>
                <Col md={6}>
                  <Form.Group className="mb-2">
                    <Form.Label>Symbol</Form.Label>
                    <Form.Select value={preview.symbol} onChange={(e) => setPreview({ ...preview, symbol: e.target.value })}>
                      <option value="">any</option>
                      {(symbols.data ?? []).map((s) => (
                        <option key={s.symbol} value={s.symbol}>
                          {s.symbol}
                        </option>
                      ))}
                    </Form.Select>
                  </Form.Group>
                </Col>
                <Col md={6}>
                  <Form.Group className="mb-2">
                    <Form.Label>Trading client</Form.Label>
                    <Form.Select
                      value={preview.tradingClientId}
                      onChange={(e) => setPreview({ ...preview, tradingClientId: e.target.value })}
                    >
                      <option value="">any</option>
                      {(clients.data ?? []).map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.displayName} ({c.broker})
                        </option>
                      ))}
                    </Form.Select>
                  </Form.Group>
                </Col>
              </Row>
              {effective.isFetching && <Spinner />}
              {effective.data && (
                <>
                  <div className="text-ink-faint mb-2 text-xs">
                    {effective.data.layersInScope} row(s) apply to this order.
                  </div>
                  <table className="w-full text-sm">
                    <thead className="text-ink-faint text-xs uppercase">
                      <tr>
                        <th className="py-1 text-left">Limit</th>
                        <th className="py-1 text-left">Value</th>
                        <th className="py-1 text-left">From</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(effective.data.config)
                        .sort(([a], [b]) => a.localeCompare(b))
                        .map(([name, value]) => (
                          <tr key={name} className="border-t border-hairline">
                            <td className="py-1 pr-2 font-mono text-xs">
                              {name}
                              {effective.data!.enforced.includes(name) && (
                                <Badge bg="success" className="ms-1">
                                  live
                                </Badge>
                              )}
                            </td>
                            <td className="py-1 pr-2 font-mono">{String(value)}</td>
                            <td className="py-1 text-ink-soft text-xs">{effective.data!.sources[name]}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </>
              )}
            </Card.Body>
          </Card>
        </Col>
      </Row>

      <Modal
        show={creating || editing !== null}
        onHide={() => {
          setCreating(false);
          setEditing(null);
        }}
        size="xl"
        backdrop="static"
      >
        <Modal.Header closeButton>
          <Modal.Title>{editing ? `Limits for ${editing.scope}` : 'New limit row'}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {catalog.data && (
            <RiskForm
              catalog={catalog.data}
              form={form}
              setForm={setForm}
              creating={creating}
              exchanges={(exchanges.data ?? []).map((e) => e.exchange)}
              symbols={(symbols.data ?? []).map((s) => s.symbol)}
              clients={(clients.data ?? []).map((c) => ({ id: c.id, label: `${c.displayName} (${c.broker})` }))}
            />
          )}
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
        show={deleting !== null}
        onHide={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
        title={deleting ? `Remove the ${deleting.scope} row` : ''}
        message="Remove this row? Whatever it set falls back to the next broader scope on the next order."
        confirmLabel="Remove"
        confirmVariant="danger"
        loading={remove.isPending}
      />
    </div>
  );
};

const RiskForm: React.FC<{
  catalog: RiskCatalog;
  form: RiskEdit;
  setForm: (next: RiskEdit) => void;
  creating: boolean;
  exchanges: string[];
  symbols: string[];
  clients: { id: string; label: string }[];
}> = ({ catalog, form, setForm, creating, exchanges, symbols, clients }) => {
  const set = (name: string, value: unknown) => setForm({ ...form, [name]: value });
  const level = useMemo(() => levelOf(form), [form]);

  return (
    <Form>
      <Row className="mb-2">
        <Col md={3}>
          <Form.Group className="mb-3">
            <Form.Label>Exchange</Form.Label>
            <Form.Select
              value={(form.exchange as string | null) ?? ''}
              onChange={(e) => set('exchange', e.target.value || null)}
              disabled={!creating}
            >
              <option value="">any</option>
              {exchanges.map((ex) => (
                <option key={ex} value={ex}>
                  {ex}
                </option>
              ))}
            </Form.Select>
          </Form.Group>
        </Col>
        <Col md={3}>
          <Form.Group className="mb-3">
            <Form.Label>Symbol</Form.Label>
            <Form.Select
              value={(form.symbol as string | null) ?? ''}
              onChange={(e) => set('symbol', e.target.value || null)}
              disabled={!creating}
            >
              <option value="">any</option>
              {symbols.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Form.Select>
          </Form.Group>
        </Col>
        <Col md={3}>
          <Form.Group className="mb-3">
            <Form.Label>Trading client</Form.Label>
            <Form.Select
              value={(form.tradingClientId as string | null) ?? ''}
              onChange={(e) => set('tradingClientId', e.target.value || null)}
              disabled={!creating}
            >
              <option value="">any</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </Form.Select>
          </Form.Group>
        </Col>
        <Col md={3}>
          <Form.Group className="mb-3">
            <Form.Label>Segment</Form.Label>
            <Form.Select
              value={(form.segmentType as string | null) ?? ''}
              onChange={(e) => set('segmentType', e.target.value || null)}
              disabled={!creating}
            >
              <option value="">every segment</option>
              {catalog.segments.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Form.Select>
          </Form.Group>
        </Col>
      </Row>
      <div className="mb-2 flex items-center gap-3">
        <span className="text-sm">
          Scope: <Badge bg={LEVEL_TONE[level]}>{level}</Badge>
        </span>
        <Form.Check
          type="checkbox"
          label="active"
          checked={form.isActive !== false}
          onChange={(e) => set('isActive', e.target.checked)}
        />
        {!creating && <small className="text-ink-faint">The scope is fixed; a different scope is a new row.</small>}
      </div>
      <small className="text-ink-faint">
        Leave a limit blank to defer to a broader scope. A limit marked <Badge bg="success">live</Badge> is
        read by the gate today; the others are stored for checks not yet built. Only the limits that mean
        something at this scope are offered.
      </small>
      {catalog.groups.map((group) => {
        const offered = group.fields.filter((name) => catalog.fields[name]?.levels.includes(level));
        if (offered.length === 0) return null;
        return (
          <div key={group.name} className="mt-3">
            <h6 className="text-ink-faint text-xs uppercase">{group.name}</h6>
            <Row>
              {offered.map((name) => {
                const field = catalog.fields[name];
                const value = form[name];
                return (
                  <Col md={3} key={name} className="mb-2">
                    <Form.Label className="text-xs font-mono">
                      {name}
                      {field.enforced && (
                        <Badge bg="success" className="ms-1">
                          live
                        </Badge>
                      )}
                    </Form.Label>
                    {field.kind === 'boolean' ? (
                      <Form.Select
                        value={value === null || value === undefined ? '' : value ? 'true' : 'false'}
                        onChange={(e) => set(name, e.target.value === '' ? null : e.target.value === 'true')}
                      >
                        <option value="">—</option>
                        <option value="true">yes</option>
                        <option value="false">no</option>
                      </Form.Select>
                    ) : (
                      <Form.Control
                        type="number"
                        min={0}
                        step={field.kind === 'decimal' ? 'any' : 1}
                        value={value === null || value === undefined ? '' : String(value)}
                        onChange={(e) => set(name, e.target.value === '' ? null : Number(e.target.value))}
                      />
                    )}
                  </Col>
                );
              })}
            </Row>
          </div>
        );
      })}
    </Form>
  );
};

export default RiskConfigPage;
