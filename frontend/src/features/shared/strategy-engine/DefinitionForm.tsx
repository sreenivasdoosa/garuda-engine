/**
 * The strategy definition form, in the reference's sections.
 *
 * What a template used to switch on is a field here (STRATEGY_ENGINE.md §5):
 * trade mode, direction provider, triggers, adaptive tranches, indicator
 * entry, combo legs, equity sizing. There is no template to choose, no
 * visibility and no mock flag. Per-tranche settings -- strikes, lots, stops,
 * timing, breakout -- live on the Strategy Config page, as in the reference.
 */

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Col, Form, Row } from '@/components/ui/rbShim';
import { symbolService } from '@/services/admin/v2AdminService';
import { stockUniverseService } from '@/services/admin/stockUniverseService';
import type { StrategyCatalog, StrategyDefinitionEdit } from '@/types/strategy-live';
import ComboSpecEditor from './ComboSpecEditor';

type Props = {
  form: StrategyDefinitionEdit;
  setForm: (next: StrategyDefinitionEdit) => void;
  catalog: StrategyCatalog | undefined;
  creating: boolean;
};

const DAY_LABELS: Record<string, string> = {
  E: 'Expiry',
  DT1: 'DT1',
  DT2: 'DT2',
  DT3: 'DT3',
  DT4: 'DT4',
  DT5: 'DT5',
  M: 'Mon',
  T: 'Tue',
  W: 'Wed',
  TH: 'Thu',
  F: 'Fri',
};

const numberOrNull = (value: string): number | null => (value === '' ? null : Number(value));

const parseDays = (raw: string | null | undefined): string[] => {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return raw.split(',').map((d) => d.trim()).filter(Boolean);
  }
};

const Section: React.FC<{ title: string; children: React.ReactNode; hint?: string }> = ({
  title,
  children,
  hint,
}) => (
  <fieldset className="mb-4 rounded border border-hairline p-3">
    <legend className="px-1 text-sm font-semibold text-ink">{title}</legend>
    {hint && <p className="mb-2 text-xs text-ink-faint">{hint}</p>}
    {children}
  </fieldset>
);

const NumberField: React.FC<{
  label: string;
  value: number | null | undefined;
  onChange: (v: number | null) => void;
  step?: string;
  hint?: string;
}> = ({ label, value, onChange, step, hint }) => (
  <Form.Group className="mb-3">
    <Form.Label className="text-sm">{label}</Form.Label>
    <Form.Control
      type="number"
      step={step}
      value={value ?? ''}
      onChange={(e) => onChange(numberOrNull(e.target.value))}
    />
    {hint && <small className="text-ink-faint">{hint}</small>}
  </Form.Group>
);

const DefinitionForm: React.FC<Props> = ({ form, setForm, catalog, creating }) => {
  const symbols = useQuery({
    queryKey: ['symbols'],
    queryFn: () => symbolService.getAll(),
    staleTime: 5 * 60 * 1000,
  });
  const universes = useQuery({
    queryKey: ['universes', 'active'],
    queryFn: () => stockUniverseService.getActive(),
    enabled: form.tradeMode === 'EQUITY',
    staleTime: 5 * 60 * 1000,
  });

  const set = (patch: Partial<StrategyDefinitionEdit>) => setForm({ ...form, ...patch });
  const underlyings = useMemo(() => {
    const rows = (symbols.data ?? []) as { symbol: string; exchange: string }[];
    return rows.filter((s) => !form.exchange || s.exchange === form.exchange);
  }, [symbols.data, form.exchange]);
  const exchanges = useMemo(
    () => [...new Set(((symbols.data ?? []) as { exchange: string }[]).map((s) => s.exchange))],
    [symbols.data],
  );

  const providerParams = form.directionProviderParams ?? '';
  let paramsError: string | null = null;
  if (providerParams.trim()) {
    try {
      const parsed = JSON.parse(providerParams);
      if (typeof parsed !== 'object' || Array.isArray(parsed)) paramsError = 'Must be a JSON object';
    } catch {
      paramsError = 'Not readable JSON';
    }
  }

  const tradable = parseDays(form.tradableDays);
  const excluded = parseDays(form.excludedDays);
  const toggleDay = (field: 'tradableDays' | 'excludedDays', code: string) => {
    const current = field === 'tradableDays' ? tradable : excluded;
    const next = current.includes(code) ? current.filter((c) => c !== code) : [...current, code];
    set({ [field]: next.length ? JSON.stringify(next) : null });
  };

  const isEquity = form.tradeMode === 'EQUITY';
  const isOptions = form.tradeMode === 'OPTION_SELLING' || form.tradeMode === 'OPTION_BUYING';
  const isCombo = Boolean(form.comboSpecJson) || form.tradeMode === 'FUTURES_OPTIONS';

  return (
    <Form>
      <Section title="Basic information">
        <Row>
          {creating && (
            <Col md={4}>
              <Form.Group className="mb-3">
                <Form.Label className="text-sm">Strategy name</Form.Label>
                <Form.Control
                  value={form.strategyName ?? ''}
                  onChange={(e) => set({ strategyName: e.target.value })}
                  placeholder="NIFTY_STRADDLE"
                />
                <small className="text-ink-faint">Fixed once saved; every trade carries it.</small>
              </Form.Group>
            </Col>
          )}
          <Col md={creating ? 4 : 6}>
            <Form.Group className="mb-3">
              <Form.Label className="text-sm">Display name</Form.Label>
              <Form.Control value={form.displayName ?? ''} onChange={(e) => set({ displayName: e.target.value })} />
            </Form.Group>
          </Col>
          <Col md={creating ? 4 : 6}>
            <Form.Group className="mb-3">
              <Form.Label className="text-sm">Custom strategy class</Form.Label>
              <Form.Select
                value={form.strategyClass ?? ''}
                onChange={(e) => set({ strategyClass: e.target.value || null })}
              >
                <option value="">Configured pipeline</option>
                {(catalog?.strategyClasses ?? []).map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </Form.Select>
              <small className="text-ink-faint">A registered code strategy overriding some steps.</small>
            </Form.Group>
          </Col>
        </Row>
      </Section>

      <Section title="What it trades">
        <Row>
          <Col md={4}>
            <Form.Group className="mb-3">
              <Form.Label className="text-sm">Trade mode</Form.Label>
              <Form.Select value={form.tradeMode ?? 'OPTION_SELLING'} onChange={(e) => set({ tradeMode: e.target.value })}>
                {(catalog?.tradeModes ?? ['OPTION_SELLING']).map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </Form.Select>
            </Form.Group>
          </Col>
          <Col md={4}>
            <Form.Group className="mb-3">
              <Form.Label className="text-sm">Exchange</Form.Label>
              <Form.Select
                value={form.exchange ?? 'NSE'}
                onChange={(e) => set({ exchange: e.target.value, underlyingSymbol: '' })}
              >
                {exchanges.map((x) => (
                  <option key={x} value={x}>
                    {x}
                  </option>
                ))}
              </Form.Select>
            </Form.Group>
          </Col>
          <Col md={4}>
            <Form.Group className="mb-3">
              <Form.Label className="text-sm">Underlying</Form.Label>
              <Form.Select value={form.underlyingSymbol ?? ''} onChange={(e) => set({ underlyingSymbol: e.target.value })}>
                <option value="">Choose…</option>
                {underlyings.map((s) => (
                  <option key={s.symbol} value={s.symbol}>
                    {s.symbol}
                  </option>
                ))}
              </Form.Select>
            </Form.Group>
          </Col>
        </Row>
        <Row>
          <Col md={3}>
            <Form.Group className="mb-3">
              <Form.Label className="text-sm">Product</Form.Label>
              <Form.Select
                value={form.product ?? 'INTRADAY'}
                onChange={(e) => set({ product: e.target.value as StrategyDefinitionEdit['product'] })}
              >
                {(catalog?.definitionProducts ?? ['INTRADAY', 'POSITIONAL']).map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </Form.Select>
            </Form.Group>
          </Col>
          {!isEquity && (
            <>
              <Col md={3}>
                <Form.Group className="mb-3">
                  <Form.Label className="text-sm">Expiry</Form.Label>
                  <Form.Select
                    value={form.expiryType ?? 'WEEKLY'}
                    onChange={(e) => set({ expiryType: e.target.value as 'WEEKLY' | 'MONTHLY' })}
                  >
                    <option value="WEEKLY">Weekly</option>
                    <option value="MONTHLY">Monthly</option>
                  </Form.Select>
                </Form.Group>
              </Col>
              <Col md={3}>
                <Form.Group className="mb-3">
                  <Form.Label className="text-sm">Strikes priced off</Form.Label>
                  <Form.Select value={form.underlyingType ?? 'INDEX'} onChange={(e) => set({ underlyingType: e.target.value })}>
                    {(catalog?.underlyingTypes ?? ['INDEX', 'FUTURE', 'SYNTHETIC_FUTURE']).map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </Form.Select>
                </Form.Group>
              </Col>
              <Col md={3} className="flex flex-col justify-center gap-1">
                <Form.Check
                  type="switch"
                  label="Exclude monthly expiry week"
                  checked={Boolean(form.excludeMonthlyExpiry)}
                  onChange={(e) => set({ excludeMonthlyExpiry: e.target.checked })}
                />
                {isOptions && (
                  <Form.Check
                    type="switch"
                    label="Premium-balanced straddle"
                    checked={form.usePremiumBalancing ?? true}
                    onChange={(e) => set({ usePremiumBalancing: e.target.checked })}
                  />
                )}
              </Col>
            </>
          )}
        </Row>
        {isCombo && (
          <div className="mt-1">
            <Form.Label className="text-sm">Combo legs</Form.Label>
            <ComboSpecEditor
              value={form.comboSpecJson ?? undefined}
              onChange={(next) => set({ comboSpecJson: next ?? null })}
            />
          </div>
        )}
      </Section>

      <Section
        title="Direction & leg order"
        hint="A directional strategy trades the side its provider answers. Non-directional option strategies trade both sides as a pair."
      >
        <Row>
          <Col md={3} className="flex items-center">
            <Form.Check
              type="switch"
              label="Directional"
              checked={Boolean(form.isDirectional)}
              onChange={(e) => set({ isDirectional: e.target.checked })}
            />
          </Col>
          <Col md={4}>
            <Form.Group className="mb-3">
              <Form.Label className="text-sm">Direction provider</Form.Label>
              <Form.Select
                value={form.directionProviderType ?? ''}
                onChange={(e) => set({ directionProviderType: e.target.value || null })}
              >
                <option value="">None</option>
                {(catalog?.directionProviders ?? []).map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </Form.Select>
              <small className="text-ink-faint">INDICATOR reads the direction rules on the Rules dialog.</small>
            </Form.Group>
          </Col>
          <Col md={5}>
            <Form.Group className="mb-3">
              <Form.Label className="text-sm">Provider parameters (JSON)</Form.Label>
              <Form.Control
                as="textarea"
                rows={3}
                value={providerParams}
                onChange={(e) => set({ directionProviderParams: e.target.value || null })}
                placeholder='{"direction": "LONG", "applicableDirection": "BOTH"}'
                className="font-mono text-xs"
              />
              {paramsError && <small className="text-danger-500">{paramsError}</small>}
            </Form.Group>
          </Col>
        </Row>
        <Row>
          <Col md={4}>
            <Form.Group className="mb-3">
              <Form.Label className="text-sm">Entry leg order</Form.Label>
              <Form.Select value={form.entryLegOrder ?? ''} onChange={(e) => set({ entryLegOrder: e.target.value || null })}>
                <option value="">Protection first (default)</option>
                {(catalog?.legOrders ?? []).map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </Form.Select>
            </Form.Group>
          </Col>
          <Col md={4} className="flex items-center">
            <Form.Check
              type="switch"
              label="Gate entries on indicator rules"
              checked={Boolean(form.useIndicatorEntry)}
              onChange={(e) => set({ useIndicatorEntry: e.target.checked })}
            />
          </Col>
        </Row>
      </Section>

      <Section title="Triggers" hint="Scheduled tranches fire at their tranche timing. Periodic evaluates on each interval.">
        <Row>
          <Col md={3} className="flex flex-col gap-1">
            <Form.Check
              type="switch"
              label="Scheduled"
              checked={form.scheduledTriggerEnabled ?? true}
              onChange={(e) => set({ scheduledTriggerEnabled: e.target.checked })}
            />
            <Form.Check
              type="switch"
              label="Periodic"
              checked={Boolean(form.periodicTriggerEnabled)}
              onChange={(e) => set({ periodicTriggerEnabled: e.target.checked })}
            />
            <Form.Check type="switch" label="External signal (not built)" checked={false} disabled />
          </Col>
          {form.periodicTriggerEnabled && (
            <>
              <Col md={3}>
                <NumberField
                  label="Every (minutes)"
                  value={form.periodicIntervalMinutes}
                  onChange={(v) => set({ periodicIntervalMinutes: v })}
                />
              </Col>
              <Col md={3}>
                <NumberField
                  label="Offset (seconds)"
                  value={form.periodicOffsetSeconds}
                  onChange={(v) => set({ periodicOffsetSeconds: v })}
                />
              </Col>
            </>
          )}
        </Row>
      </Section>

      <Section title="Timing">
        <Row>
          <Col md={3}>
            <Form.Group className="mb-3">
              <Form.Label className="text-sm">Start time</Form.Label>
              <Form.Control value={form.startTime ?? ''} onChange={(e) => set({ startTime: e.target.value })} placeholder="09:20" />
            </Form.Group>
          </Col>
          <Col md={3}>
            <Form.Group className="mb-3">
              <Form.Label className="text-sm">Stop time</Form.Label>
              <Form.Control value={form.stopTime ?? ''} onChange={(e) => set({ stopTime: e.target.value })} placeholder="15:15" />
            </Form.Group>
          </Col>
        </Row>
        {(['tradableDays', 'excludedDays'] as const).map((field) => (
          <div key={field} className="mb-2">
            <div className="text-sm">{field === 'tradableDays' ? 'Tradable days (none = every day)' : 'Excluded days (wins over tradable)'}</div>
            <div className="flex flex-wrap gap-3">
              {(catalog?.dayCodes ?? Object.keys(DAY_LABELS)).map((code) => (
                <Form.Check
                  key={code}
                  type="checkbox"
                  label={DAY_LABELS[code] ?? code}
                  checked={(field === 'tradableDays' ? tradable : excluded).includes(code)}
                  onChange={() => toggleDay(field, code)}
                />
              ))}
            </div>
          </div>
        ))}
      </Section>

      {!isEquity && (
        <Section title="Capital & hedge">
          <Row>
            <Col md={4}>
              <NumberField label="Capital per lot" value={form.capitalPerLot} onChange={(v) => set({ capitalPerLot: v })} />
            </Col>
            <Col md={4}>
              <NumberField label="Capital per lot (hedged)" value={form.capitalPerLotHedged} onChange={(v) => set({ capitalPerLotHedged: v })} />
            </Col>
            <Col md={4}>
              <NumberField label="Capital per lot (naked)" value={form.capitalPerLotNaked} onChange={(v) => set({ capitalPerLotNaked: v })} />
            </Col>
          </Row>
          <Row>
            <Col md={4}>
              <NumberField
                label="Hedge distance % (intraday)"
                step="0.1"
                value={form.hedgeDistancePercentageIntraday}
                onChange={(v) => set({ hedgeDistancePercentageIntraday: v })}
              />
            </Col>
            <Col md={4}>
              <NumberField
                label="Hedge distance % (positional)"
                step="0.1"
                value={form.hedgeDistancePercentagePositional}
                onChange={(v) => set({ hedgeDistancePercentagePositional: v })}
              />
            </Col>
            <Col md={4} className="flex flex-col justify-center gap-1">
              <Form.Check
                type="switch"
                label="Overlap capital"
                checked={Boolean(form.isOverlapCapital)}
                onChange={(e) => set({ isOverlapCapital: e.target.checked })}
              />
              <Form.Check
                type="switch"
                label="Hedge replace windows"
                checked={Boolean(form.hedgeReplaceEnabled)}
                onChange={(e) => set({ hedgeReplaceEnabled: e.target.checked })}
              />
            </Col>
          </Row>
          {form.hedgeReplaceEnabled && (
            <Row>
              <Col md={3}>
                <NumberField label="Morning start (min after open)" value={form.hedgeMorningStartOffset} onChange={(v) => set({ hedgeMorningStartOffset: v })} />
              </Col>
              <Col md={3}>
                <NumberField label="Morning end (min after open)" value={form.hedgeMorningEndOffset} onChange={(v) => set({ hedgeMorningEndOffset: v })} />
              </Col>
              <Col md={3}>
                <NumberField label="Evening start (min before close)" value={form.hedgeEveningStartOffset} onChange={(v) => set({ hedgeEveningStartOffset: v })} />
              </Col>
              <Col md={3}>
                <NumberField label="Evening end (min before close)" value={form.hedgeEveningEndOffset} onChange={(v) => set({ hedgeEveningEndOffset: v })} />
              </Col>
            </Row>
          )}
        </Section>
      )}

      <Section title="Risk allocation" hint="With a risk budget set, each tranche takes its share of today's remaining budget.">
        <Row>
          <Col md={3}>
            <NumberField label="Risk % of capital" step="0.1" value={form.riskPercentage} onChange={(v) => set({ riskPercentage: v })} />
          </Col>
          <Col md={3}>
            <NumberField label="Absolute max risk" value={form.absoluteMaxRisk} onChange={(v) => set({ absoluteMaxRisk: v })} />
          </Col>
          <Col md={3}>
            <NumberField label="Min risk %" step="0.1" value={form.minRiskPercentage} onChange={(v) => set({ minRiskPercentage: v })} />
          </Col>
          <Col md={3}>
            <NumberField label="Max risk %" step="0.1" value={form.maxRiskPercentage} onChange={(v) => set({ maxRiskPercentage: v })} />
          </Col>
        </Row>
      </Section>

      {isEquity && (
        <Section title="Equity sizing & leverage">
          <Row>
            <Col md={4}>
              <Form.Group className="mb-3">
                <Form.Label className="text-sm">Universe</Form.Label>
                <Form.Select
                  value={form.universeId ?? ''}
                  onChange={(e) => set({ universeId: e.target.value ? Number(e.target.value) : null })}
                >
                  <option value="">The underlying only</option>
                  {(universes.data ?? []).map((u) => (
                    <option key={u.universeId} value={u.universeId}>
                      {u.name}
                    </option>
                  ))}
                </Form.Select>
              </Form.Group>
            </Col>
            <Col md={4}>
              <Form.Group className="mb-3">
                <Form.Label className="text-sm">Sizing model</Form.Label>
                <Form.Select value={form.equitySizingModel ?? ''} onChange={(e) => set({ equitySizingModel: e.target.value || null })}>
                  <option value="">Equal split over max positions</option>
                  {(catalog?.equitySizingModels ?? []).map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </Form.Select>
              </Form.Group>
            </Col>
            <Col md={4}>
              <Form.Group className="mb-3">
                <Form.Label className="text-sm">On index removal</Form.Label>
                <Form.Select value={form.onIndexRemoval ?? ''} onChange={(e) => set({ onIndexRemoval: e.target.value || null })}>
                  <option value="">Hold until exit</option>
                  {(catalog?.onIndexRemoval ?? []).map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </Form.Select>
              </Form.Group>
            </Col>
          </Row>
          <Row>
            <Col md={2}>
              <NumberField label="Leverage" step="0.1" value={form.leverage} onChange={(v) => set({ leverage: v })} />
            </Col>
            <Col md={2}>
              <NumberField label="Min leverage" step="0.1" value={form.minLeverage} onChange={(v) => set({ minLeverage: v })} />
            </Col>
            <Col md={2}>
              <NumberField label="Max leverage" step="0.1" value={form.maxLeverage} onChange={(v) => set({ maxLeverage: v })} />
            </Col>
            <Col md={2}>
              <NumberField label="Amount per stock" value={form.fixedAmountPerStock} onChange={(v) => set({ fixedAmountPerStock: v })} />
            </Col>
            <Col md={2}>
              <NumberField label="Max positions" value={form.maxActivePositions} onChange={(v) => set({ maxActivePositions: v })} />
            </Col>
            <Col md={2}>
              <NumberField label="Max risk % a trade" step="0.1" value={form.maxRiskPctPerTrade} onChange={(v) => set({ maxRiskPctPerTrade: v })} />
            </Col>
          </Row>
        </Section>
      )}

      <Section title="Lifecycle">
        <Row>
          <Col md={4}>
            <Form.Check
              type="switch"
              label="Catch up missed tranches on reactivation"
              checked={form.catchUpMissedTranches ?? true}
              onChange={(e) => set({ catchUpMissedTranches: e.target.checked })}
            />
          </Col>
          <Col md={4}>
            <Form.Check
              type="switch"
              label="Adaptive tranches"
              checked={Boolean(form.adaptiveTranchesEnabled)}
              onChange={(e) => set({ adaptiveTranchesEnabled: e.target.checked })}
            />
            <small className="text-ink-faint">Tranche 1 on schedule; each next one when the previous closes.</small>
          </Col>
        </Row>
      </Section>
    </Form>
  );
};

export default DefinitionForm;
