/**
 * BrokerChargeOverrides — per-broker SPARSE statutory-charge overrides tab.
 *
 * Brokers levy different all-in exchange transaction rates (and potentially any
 * component in future, incl. GST). Each override row targets one
 * (broker, exchange, segment, product); every charge field is nullable —
 * EMPTY input = inherit the default (shown as a grey placeholder), a value =
 * override. Server merges per column at the charge calculator and writes
 * through to the eager statutoryChargesBrokerOverrides cache on save.
 * Rights: TRADING_CHARGES — E = add/edit, M = delete, V = read-only.
 */
import React, { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { Modal, Button, Spinner } from '@/components/ui';
import { usePermissions } from '@/hooks/usePermissions';
import { statutoryChargesService } from '@/services/admin/v2AdminService';
import { brokerService } from '@/services/broker/brokerService';
import type { StatutoryCharges, StatutoryChargesBrokerOverride } from '@/types/billing';

const CTRL =
  'w-full rounded border border-hairline bg-card px-2 py-1.5 text-sm text-ink placeholder:text-ink-faint focus-visible:outline-none focus:border-primary-500/60 disabled:bg-raised disabled:opacity-70';

type ChargeField = keyof Pick<StatutoryChargesBrokerOverride,
  'sttBuyPct' | 'sttSellPct' | 'exchangeTxnPct' | 'sebiChargesPct' |
  'stampDutyBuyPct' | 'stampDutySellPct' | 'gstPct' | 'depositoryCharges'>;

const FIELDS: { key: ChargeField; label: string }[] = [
  { key: 'sttBuyPct', label: 'STT Buy %' },
  { key: 'sttSellPct', label: 'STT Sell %' },
  { key: 'exchangeTxnPct', label: 'Exchange Txn %' },
  { key: 'sebiChargesPct', label: 'SEBI %' },
  { key: 'stampDutyBuyPct', label: 'Stamp Buy %' },
  { key: 'stampDutySellPct', label: 'Stamp Sell %' },
  { key: 'gstPct', label: 'GST %' },
  { key: 'depositoryCharges', label: 'DP (Rs)' },
];

const emptyForm = { broker: '', exchange: '', segment: '', product: '' } as Record<string, string>;

const BrokerChargeOverrides: React.FC = () => {
  const { tradingCharges } = usePermissions();
  const queryClient = useQueryClient();

  const [showModal, setShowModal] = useState(false);
  const [editingKey, setEditingKey] = useState<string | null>(null); // broker|ex|seg|prod when editing
  const [form, setForm] = useState<Record<string, string>>(emptyForm);
  const [confirmDelete, setConfirmDelete] = useState<StatutoryChargesBrokerOverride | null>(null);

  const { data: overrides, isLoading } = useQuery({
    queryKey: ['statutoryChargesOverrides'],
    queryFn: () => statutoryChargesService.getOverrides(),
  });
  const { data: defaults } = useQuery({
    queryKey: ['statutoryCharges'],
    queryFn: () => statutoryChargesService.getAll(),
  });
  const { data: brokers } = useQuery({
    queryKey: ['brokers', 'all'],
    queryFn: () => brokerService.getAll(),
  });

  const defaultFor = (exchange: string, segment: string, product: string): StatutoryCharges | undefined =>
    defaults?.find((d) => d.exchange === exchange && d.segment === segment && d.product === product);

  // Exchange/segment/product combos come from the DEFAULTS table — an override
  // must overlay an existing default row.
  const combos = useMemo(() => defaults ?? [], [defaults]);
  const exchanges = useMemo(() => [...new Set(combos.map((c) => c.exchange))], [combos]);
  const segmentsFor = (ex: string) => [...new Set(combos.filter((c) => c.exchange === ex).map((c) => c.segment))];
  const productsFor = (ex: string, seg: string) =>
    [...new Set(combos.filter((c) => c.exchange === ex && c.segment === seg).map((c) => c.product))];

  const upsertMutation = useMutation({
    mutationFn: (data: StatutoryChargesBrokerOverride) => statutoryChargesService.upsertOverride(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['statutoryChargesOverrides'] });
      setShowModal(false);
      toast.success('Broker override saved (cache updated)');
    },
    onError: (error: { message?: string }) => toast.error(error.message || 'Failed to save override'),
  });

  const deleteMutation = useMutation({
    mutationFn: (o: StatutoryChargesBrokerOverride) =>
      statutoryChargesService.deleteOverride(o.broker, o.exchange, o.segment, o.product),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['statutoryChargesOverrides'] });
      setConfirmDelete(null);
      toast.success('Broker override deleted (broker back on defaults)');
    },
    onError: (error: { message?: string }) => toast.error(error.message || 'Failed to delete override'),
  });

  const openCreate = () => {
    setEditingKey(null);
    setForm({ ...emptyForm });
    setShowModal(true);
  };

  const openEdit = (o: StatutoryChargesBrokerOverride) => {
    setEditingKey(`${o.broker}|${o.exchange}|${o.segment}|${o.product}`);
    const f: Record<string, string> = {
      broker: o.broker, exchange: o.exchange, segment: o.segment, product: o.product,
    };
    for (const { key } of FIELDS) f[key] = o[key] == null ? '' : String(o[key]);
    setForm(f);
    setShowModal(true);
  };

  const handleSave = () => {
    if (!form.broker || !form.exchange || !form.segment || !form.product) {
      toast.error('Broker, exchange, segment and product are required');
      return;
    }
    const payload = {
      broker: form.broker, exchange: form.exchange, segment: form.segment, product: form.product,
    } as StatutoryChargesBrokerOverride;
    let hasAny = false;
    for (const { key } of FIELDS) {
      const raw = (form[key] ?? '').trim();
      if (raw === '') {
        payload[key] = null;
      } else {
        const n = Number(raw);
        if (Number.isNaN(n) || n < 0) {
          toast.error(`Invalid value for ${key}`);
          return;
        }
        payload[key] = n;
        hasAny = true;
      }
    }
    if (!hasAny) {
      toast.error('Set at least one override value (empty fields inherit the default)');
      return;
    }
    upsertMutation.mutate(payload);
  };

  const cellFor = (o: StatutoryChargesBrokerOverride, key: ChargeField) => {
    const def = defaultFor(o.exchange, o.segment, o.product);
    if (o[key] != null) {
      return <span className="font-semibold text-primary-700 dark:text-primary-400" title="Overridden">{o[key]}</span>;
    }
    return <span className="text-ink-faint" title="Inherited from defaults">{def ? `${def[key as keyof StatutoryCharges]}` : '—'}</span>;
  };

  const selectedDefault = defaultFor(form.exchange, form.segment, form.product);

  return (
    <div className="rounded-card border border-hairline bg-card">
      <div className="flex items-center justify-between border-b border-hairline px-4 py-3">
        <div>
          <h6 className="mb-0 text-sm font-semibold text-ink">Broker Overrides</h6>
          <small className="text-ink-soft">
            Per-broker exceptions to the defaults — empty field = inherits; overridden values are highlighted
          </small>
        </div>
        {tradingCharges.canEdit && (
          <Button size="sm" onClick={openCreate}>Add Override</Button>
        )}
      </div>

      {isLoading ? (
        <div className="py-10 text-center text-primary-500"><Spinner /></div>
      ) : (overrides ?? []).length === 0 ? (
        <div className="py-10 text-center text-sm text-ink-faint">
          No broker overrides — every broker is charged at the default rates.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm [&_th]:whitespace-nowrap [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:text-xs [&_th]:font-semibold [&_th]:uppercase [&_th]:text-ink-faint [&_thead_th]:bg-raised [&_td]:whitespace-nowrap [&_td]:px-3 [&_td]:py-2 [&_td]:align-middle [&_tbody_tr]:border-b [&_tbody_tr]:border-hairline">
            <thead>
              <tr>
                <th>Broker</th><th>Exchange</th><th>Segment</th><th>Product</th>
                {FIELDS.map((f) => <th key={f.key} className="!text-right">{f.label}</th>)}
                <th className="!text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {(overrides ?? []).map((o) => (
                <tr key={`${o.broker}|${o.exchange}|${o.segment}|${o.product}`} className="hover:bg-raised/40">
                  <td className="font-medium text-ink">{o.broker}</td>
                  <td className="text-ink">{o.exchange}</td>
                  <td className="text-ink">{o.segment}</td>
                  <td className="text-ink">{o.product}</td>
                  {FIELDS.map((f) => <td key={f.key} className="!text-right tabular-nums">{cellFor(o, f.key)}</td>)}
                  <td className="!text-right">
                    <div className="flex justify-end gap-1">
                      {tradingCharges.canEdit && (
                        <Button variant="secondary" size="sm" onClick={() => openEdit(o)}>Edit</Button>
                      )}
                      {tradingCharges.canManage && (
                        confirmDelete === o ? (
                          <>
                            <Button variant="danger" size="sm" onClick={() => deleteMutation.mutate(o)}>Confirm</Button>
                            <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(null)}>Cancel</Button>
                          </>
                        ) : (
                          <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(o)}>Delete</Button>
                        )
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Add / Edit modal */}
      <Modal
        open={showModal}
        onClose={() => setShowModal(false)}
        title={editingKey ? 'Edit Broker Override' : 'Add Broker Override'}
        size="lg"
      >
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div>
              <label className="mb-1 block text-sm font-medium text-ink">Broker</label>
              <select className={CTRL} value={form.broker} disabled={!!editingKey}
                onChange={(e) => setForm({ ...form, broker: e.target.value })}>
                <option value="">Select…</option>
                {(brokers ?? []).map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-ink">Exchange</label>
              <select className={CTRL} value={form.exchange} disabled={!!editingKey}
                onChange={(e) => setForm({ ...form, exchange: e.target.value, segment: '', product: '' })}>
                <option value="">Select…</option>
                {exchanges.map((ex) => <option key={ex} value={ex}>{ex}</option>)}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-ink">Segment</label>
              <select className={CTRL} value={form.segment} disabled={!!editingKey || !form.exchange}
                onChange={(e) => setForm({ ...form, segment: e.target.value, product: '' })}>
                <option value="">Select…</option>
                {segmentsFor(form.exchange).map((sg) => <option key={sg} value={sg}>{sg}</option>)}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-ink">Product</label>
              <select className={CTRL} value={form.product} disabled={!!editingKey || !form.segment}
                onChange={(e) => setForm({ ...form, product: e.target.value })}>
                <option value="">Select…</option>
                {productsFor(form.exchange, form.segment).map((pr) => <option key={pr} value={pr}>{pr}</option>)}
              </select>
            </div>
          </div>

          <div className="rounded border border-accent-500/30 bg-accent-500/10 px-3 py-2 text-xs text-ink">
            Leave a field EMPTY to inherit the default (shown as placeholder). Only filled fields override —
            they keep tracking default changes for everything else.
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {FIELDS.map(({ key, label }) => (
              <div key={key}>
                <label className="mb-1 block text-sm font-medium text-ink">{label}</label>
                <input
                  type="number"
                  step="any"
                  min="0"
                  className={CTRL}
                  value={form[key] ?? ''}
                  placeholder={selectedDefault ? `${selectedDefault[key as keyof StatutoryCharges]} (default)` : 'default'}
                  onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                />
              </div>
            ))}
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setShowModal(false)}>Cancel</Button>
            <Button onClick={handleSave} disabled={upsertMutation.isPending}>
              {upsertMutation.isPending ? <Spinner size="sm" /> : 'Save Override'}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
};

export default BrokerChargeOverrides;
