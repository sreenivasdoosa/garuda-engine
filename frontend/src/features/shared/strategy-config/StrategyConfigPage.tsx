/**
 * Strategy Config: the layers the engine merges per column.
 *
 * A strategy is configured at four scopes -- base, day, tranche, tranche and
 * day -- and the engine takes the most specific non-null value per column,
 * so a tranche row that sets only the strike type still inherits the base
 * row's stop. This page shows the rows, and the effective configuration for
 * a chosen tranche and day with where each value came from, which is the
 * question an operator has when a stop is not the one they expected.
 *
 * A setting left blank is "not set at this scope" and defers to a broader
 * one; it is never "set to nothing". Settings the engine reads today are
 * marked; the rest are stored for the parts not yet built, and say so.
 */

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { BsLayers, BsPencil, BsPlus, BsTrash } from 'react-icons/bs';
import {
  Alert,
  Badge,
  Button,
  Card,
  Col,
  Form,
  Modal,
  Row,
  Spinner,
} from '@/components/ui/rbShim';
import { ConfirmModal, PageHeader } from '@/components/common';
import { strategyConfigLiveService } from '@/services/admin/strategyConfigLiveService';
import type { ConfigCatalog, ConfigEdit, ConfigRow } from '@/types/strategy-config-live';

const StrategyConfigPage: React.FC = () => {
  const queryClient = useQueryClient();
  const [strategy, setStrategy] = useState<string>('');
  const [editing, setEditing] = useState<ConfigRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<ConfigEdit>({});
  const [deleting, setDeleting] = useState<ConfigRow | null>(null);
  const [tranche, setTranche] = useState(0);
  const [days, setDays] = useState<string[]>([]);

  const catalog = useQuery({
    queryKey: ['strategy-config', 'catalog'],
    queryFn: () => strategyConfigLiveService.catalog(),
    staleTime: 10 * 60 * 1000,
  });
  const strategies = useQuery({
    queryKey: ['strategy-config', 'strategies'],
    queryFn: () => strategyConfigLiveService.strategies(),
  });
  useEffect(() => {
    if (!strategy && strategies.data?.length) setStrategy(strategies.data[0].strategyName);
  }, [strategies.data, strategy]);

  const rows = useQuery({
    queryKey: ['strategy-config', 'rows', strategy],
    queryFn: () => strategyConfigLiveService.rows(strategy),
    enabled: Boolean(strategy),
  });
  const effective = useQuery({
    queryKey: ['strategy-config', 'effective', strategy, tranche, days],
    queryFn: () => strategyConfigLiveService.effective(strategy, tranche, days),
    enabled: Boolean(strategy),
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['strategy-config'] });

  const save = useMutation({
    mutationFn: () =>
      editing
        ? strategyConfigLiveService.update(editing.id, form)
        : strategyConfigLiveService.create({ ...form, strategyName: strategy }),
    onSuccess: (saved) => {
      toast.success(`${saved.strategyName}: ${saved.scope} row saved`);
      setEditing(null);
      setCreating(false);
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: (id: number) => strategyConfigLiveService.remove(id),
    onSuccess: () => {
      toast.success('Row removed');
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
    onSettled: () => setDeleting(null),
  });

  const fields = catalog.data?.fields ?? {};
  const chosen = strategies.data?.find((s) => s.strategyName === strategy);

  const openCreate = () => {
    setEditing(null);
    setForm({ tranchNumber: null, dayCondition: null });
    setCreating(true);
  };
  const openEdit = (row: ConfigRow) => {
    setCreating(false);
    setEditing(row);
    const values: ConfigEdit = { description: row.description };
    for (const name of Object.keys(fields)) values[name] = row[name] ?? null;
    setForm(values);
  };

  const tranches = useMemo(() => {
    const numbers = new Set<number>([0]);
    for (const r of rows.data ?? []) if (r.tranchNumber !== null) numbers.add(r.tranchNumber);
    return [...numbers].sort((a, b) => a - b);
  }, [rows.data]);

  return (
    <div className="fade-in">
      <PageHeader
        title="Strategy Config"
        subtitle="The layers the engine merges per column: base, day, tranche, tranche and day"
        icon={<BsLayers size={24} />}
      />

      <Row className="mb-3">
        <Col md={4}>
          <Form.Group>
            <Form.Label>Strategy</Form.Label>
            <Form.Select value={strategy} onChange={(e) => setStrategy(e.target.value)}>
              {(strategies.data ?? []).map((s) => (
                <option key={s.strategyName} value={s.strategyName}>
                  {s.displayName || s.strategyName} ({s.status}, {s.rows} row{s.rows === 1 ? '' : 's'})
                </option>
              ))}
            </Form.Select>
            {strategies.data && strategies.data.length === 0 && (
              <small className="text-ink-faint">Define a strategy on the Strategy Engine page first.</small>
            )}
          </Form.Group>
        </Col>
      </Row>

      {strategy && (
        <Row>
          <Col lg={7}>
            <Card className="mb-4">
              <Card.Header className="flex items-center justify-between">
                <h5 className="mb-0">Rows</h5>
                <Button variant="primary" size="sm" onClick={openCreate}>
                  <BsPlus className="me-1" />
                  Add row
                </Button>
              </Card.Header>
              <Card.Body>
                {rows.isLoading && <Spinner />}
                {rows.data && rows.data.length === 0 && (
                  <Alert variant="info" className="mb-0">
                    No configuration row yet. Start with a base row: the stop, the target, the
                    trailing. A tranche or day row then overrides only what it sets.
                  </Alert>
                )}
                {rows.data && rows.data.length > 0 && (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="text-ink-faint text-xs uppercase">
                        <tr>
                          <th className="py-1 text-left">Scope</th>
                          <th className="py-1 text-right">Priority</th>
                          <th className="py-1 text-left">Sets</th>
                          <th className="py-1 text-right" />
                        </tr>
                      </thead>
                      <tbody>
                        {rows.data.map((r) => (
                          <tr key={r.id} className="border-t border-hairline align-top">
                            <td className="py-2 pr-3">
                              <div className="font-semibold">{r.scope}</div>
                              {r.description && (
                                <div className="text-ink-faint text-xs">{r.description}</div>
                              )}
                            </td>
                            <td className="py-2 pr-3 text-right font-mono">{r.priority}</td>
                            <td className="py-2 pr-3 text-xs">
                              {r.setFields.length === 0 && (
                                <span className="text-ink-faint">nothing yet</span>
                              )}
                              {r.setFields.map((f) => (
                                <span key={f} className="me-2 inline-block font-mono">
                                  {f}={String(r[f])}
                                  {fields[f]?.readByEngine === false && (
                                    <span className="text-ink-faint" title="stored; not read by the engine yet">
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
                      * stored for a part of the engine not yet built; it does not take effect today.
                    </small>
                  </div>
                )}
              </Card.Body>
            </Card>
          </Col>

          <Col lg={5}>
            <Card className="mb-4">
              <Card.Header>
                <h5 className="mb-0">Effective configuration</h5>
              </Card.Header>
              <Card.Body>
                <p className="text-ink-soft text-sm">
                  What the engine would use for one tranche on one kind of day, merged per column,
                  with where each value came from.
                </p>
                <Row>
                  <Col md={4}>
                    <Form.Group className="mb-3">
                      <Form.Label>Tranche</Form.Label>
                      <Form.Select value={tranche} onChange={(e) => setTranche(Number(e.target.value))}>
                        {tranches.map((t) => (
                          <option key={t} value={t}>
                            {t}
                          </option>
                        ))}
                      </Form.Select>
                    </Form.Group>
                  </Col>
                  <Col md={8}>
                    <Form.Label>Day</Form.Label>
                    <div className="flex flex-wrap gap-2">
                      {(catalog.data?.dayConditions ?? []).map((d) => (
                        <Form.Check
                          key={d.code}
                          type="checkbox"
                          label={d.code}
                          title={d.name}
                          checked={days.includes(d.code)}
                          onChange={(e) =>
                            setDays((before) =>
                              e.target.checked ? [...before, d.code] : before.filter((c) => c !== d.code),
                            )
                          }
                        />
                      ))}
                    </div>
                  </Col>
                </Row>
                {effective.isFetching && <Spinner />}
                {effective.data && Object.keys(effective.data.values).length === 0 && (
                  <div className="text-ink-faint text-sm">
                    Nothing resolves for this tranche and day: {effective.data.layersInScope} row(s) in scope, none setting anything.
                  </div>
                )}
                {effective.data && Object.keys(effective.data.values).length > 0 && (
                  <table className="w-full text-sm">
                    <thead className="text-ink-faint text-xs uppercase">
                      <tr>
                        <th className="py-1 text-left">Setting</th>
                        <th className="py-1 text-left">Value</th>
                        <th className="py-1 text-left">From</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(effective.data.values)
                        .sort(([a], [b]) => a.localeCompare(b))
                        .map(([name, value]) => (
                          <tr key={name} className="border-t border-hairline">
                            <td className="py-1 pr-2 font-mono text-xs">
                              {name}
                              {fields[name]?.readByEngine && (
                                <Badge bg="success" className="ms-1">live</Badge>
                              )}
                            </td>
                            <td className="py-1 pr-2 font-mono">{String(value)}</td>
                            <td className="py-1 text-ink-soft text-xs">{effective.data!.sources[name]?.scope}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                )}
              </Card.Body>
            </Card>
          </Col>
        </Row>
      )}

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
          <Modal.Title>
            {editing ? `${strategy}: ${editing.scope}` : `${strategy}: new row`}
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {catalog.data && (
            <ConfigForm
              catalog={catalog.data}
              form={form}
              setForm={setForm}
              creating={creating}
              strategyStart={chosen?.startTime ?? null}
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
        message="Remove this row? Whatever it set falls back to the next broader scope at once."
        confirmLabel="Remove"
        confirmVariant="danger"
        loading={remove.isPending}
      />
    </div>
  );
};

const ConfigForm: React.FC<{
  catalog: ConfigCatalog;
  form: ConfigEdit;
  setForm: (next: ConfigEdit) => void;
  creating: boolean;
  strategyStart: string | null;
}> = ({ catalog, form, setForm, creating, strategyStart }) => {
  const isBase = form.tranchNumber === null || form.tranchNumber === undefined || form.tranchNumber === 0;
  const set = (name: string, value: unknown) => setForm({ ...form, [name]: value });

  return (
    <Form>
      {creating && (
        <Row className="mb-2">
          <Col md={3}>
            <Form.Group className="mb-3">
              <Form.Label>Tranche</Form.Label>
              <Form.Control
                type="number"
                min={0}
                value={form.tranchNumber ?? ''}
                onChange={(e) => set('tranchNumber', e.target.value === '' ? null : Number(e.target.value))}
                placeholder="any (base)"
              />
              <small className="text-ink-faint">Blank applies to every tranche.</small>
            </Form.Group>
          </Col>
          <Col md={3}>
            <Form.Group className="mb-3">
              <Form.Label>Day condition</Form.Label>
              <Form.Select
                value={(form.dayCondition as string | null) ?? ''}
                onChange={(e) => set('dayCondition', e.target.value || null)}
              >
                <option value="">any day</option>
                {catalog.dayConditions.map((d) => (
                  <option key={d.code} value={d.code}>
                    {d.code} — {d.name}
                  </option>
                ))}
              </Form.Select>
            </Form.Group>
          </Col>
          <Col md={6}>
            <Form.Group className="mb-3">
              <Form.Label>Description</Form.Label>
              <Form.Control
                value={(form.description as string | null) ?? ''}
                onChange={(e) => set('description', e.target.value)}
              />
            </Form.Group>
          </Col>
        </Row>
      )}
      {!creating && (
        <Form.Group className="mb-3">
          <Form.Label>Description</Form.Label>
          <Form.Control
            value={(form.description as string | null) ?? ''}
            onChange={(e) => set('description', e.target.value)}
          />
        </Form.Group>
      )}
      <small className="text-ink-faint">
        Leave a setting blank to defer to a broader scope. A setting marked <Badge bg="success">live</Badge> is
        read by the engine today; the others are stored for parts not yet built.
        {strategyStart && ` Tranche timing may not be earlier than the strategy's start, ${strategyStart}.`}
      </small>
      {catalog.groups.map((group) => (
        <div key={group.name} className="mt-3">
          <h6 className="text-ink-faint text-xs uppercase">{group.name}</h6>
          <Row>
            {group.fields.map((name) => {
              const field = catalog.fields[name];
              if (!field) return null;
              if (field.baseOnly && !isBase) return null;
              const value = form[name];
              return (
                <Col md={3} key={name} className="mb-2">
                  <Form.Label className="text-xs font-mono">
                    {name}
                    {field.readByEngine && <Badge bg="success" className="ms-1">live</Badge>}
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
                  ) : field.choices.length > 0 ? (
                    <Form.Select
                      value={(value as string | null) ?? ''}
                      onChange={(e) => set(name, e.target.value || null)}
                    >
                      <option value="">—</option>
                      {field.choices.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </Form.Select>
                  ) : (
                    <Form.Control
                      type={field.kind === 'text' ? 'text' : 'number'}
                      step={field.kind === 'decimal' ? 'any' : undefined}
                      value={value === null || value === undefined ? '' : String(value)}
                      onChange={(e) =>
                        set(
                          name,
                          e.target.value === ''
                            ? null
                            : field.kind === 'text'
                              ? e.target.value
                              : Number(e.target.value),
                        )
                      }
                    />
                  )}
                </Col>
              );
            })}
          </Row>
        </div>
      ))}
    </Form>
  );
};

export default StrategyConfigPage;
