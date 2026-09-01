/**
 * Exchange Component
 * Modal for viewing/editing a single exchange
 * Reusable across Admin portals
 * Uses: /api/exchanges
 */

import { useState, useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import Select from 'react-select';
import { Modal, Form, Row, Col, Button, Spinner, Badge, Tabs, Tab } from '@/components/ui/rbShim';
import { BsGlobe } from 'react-icons/bs';
import HelpIcon from '@/components/common/HelpIcon';
import { exchangeHelpContent } from '@/data/help';
import { exchangeService } from '@/services/admin/exchangeService';
import { currencySymbol } from '@/utils/currency';
import type { Exchange as ExchangeType, CreateExchangeRequest } from '@/types/exchange';

export interface ExchangeProps {
  /** Exchange for edit mode, null for create mode */
  exchange: ExchangeType | null;
  /** Whether the modal is visible */
  show: boolean;
  /** Close modal callback */
  onClose: () => void;
  /** Save callback */
  onSave: (data: CreateExchangeRequest, isNew: boolean) => void;
  /** Whether save is in progress */
  isSaving?: boolean;
  /** Mode: 'view' | 'edit' | 'create' */
  mode?: 'view' | 'edit' | 'create';
}

/**
 * Used only until `GET /api/exchanges/options` answers, and if it never does.
 * The server's list is authoritative -- these are its enums -- so this is a
 * placeholder for the first paint rather than a second source of truth.
 */
const FALLBACK = {
  currencies: ['INR', 'USD', 'EUR', 'GBP', 'JPY', 'AED', 'SGD', 'HKD', 'AUD'],
  segments: ['COMMODITY', 'CURRENCY', 'EQUITY', 'FNO'],
  weekendDays: ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'],
  timezones: ['Asia/Kolkata', 'UTC'],
};

const Exchange: React.FC<ExchangeProps> = ({
  exchange,
  show,
  onClose,
  onSave,
  isSaving = false,
  mode = exchange ? 'edit' : 'create',
}) => {
  const isViewMode = mode === 'view';
  const isCreateMode = mode === 'create';

  const [formData, setFormData] = useState<CreateExchangeRequest>({
    exchange: '',
    exchangeName: '',
    segments: [],
    currency: 'INR',
    timezone: 'Asia/Kolkata',
    preMarketStart: '09:00:00',
    preMarketEnd: '09:08:00',
    marketOpen: '09:15:00',
    marketClose: '15:30:00',
    algoStartMinutesBeforeMarketOpen: 90,
    intradaySquareOffMinutesBeforeClose: 20,
    intradaySquareOffBlockMinutesBeforeClose: 10,
    postMarketWindowMinutes: 60,
    reportMinutesAfterClose: 15,
    weekendDays: ['SATURDAY', 'SUNDAY'],
    isActive: true,
    historyCacheEnabled: false,
  });

  useEffect(() => {
    if (exchange) {
      setFormData({
        exchange: exchange.exchange,
        exchangeName: exchange.exchangeName,
        segments: exchange.segments ?? [],
        currency: exchange.currency || 'INR',
        timezone: exchange.timezone || 'Asia/Kolkata',
        preMarketStart: exchange.preMarketStart || '',
        preMarketEnd: exchange.preMarketEnd || '',
        marketOpen: exchange.marketOpen || '09:15:00',
        marketClose: exchange.marketClose || '15:30:00',
        algoStartMinutesBeforeMarketOpen: exchange.algoStartMinutesBeforeMarketOpen ?? 90,
        intradaySquareOffMinutesBeforeClose: exchange.intradaySquareOffMinutesBeforeClose ?? 20,
        intradaySquareOffBlockMinutesBeforeClose: exchange.intradaySquareOffBlockMinutesBeforeClose ?? 10,
        postMarketWindowMinutes: exchange.postMarketWindowMinutes ?? 60,
        reportMinutesAfterClose: exchange.reportMinutesAfterClose ?? 15,
        weekendDays: exchange.weekendDays || ['SATURDAY', 'SUNDAY'],
        isActive: exchange.isActive,
        historyCacheEnabled: exchange.historyCacheEnabled ?? false,
      });
    } else {
      setFormData({
        exchange: '',
        exchangeName: '',
        segments: [],
        currency: 'INR',
        timezone: 'Asia/Kolkata',
        preMarketStart: '09:00:00',
        preMarketEnd: '09:08:00',
        marketOpen: '09:15:00',
        marketClose: '15:30:00',
        algoStartMinutesBeforeMarketOpen: 90,
        intradaySquareOffMinutesBeforeClose: 20,
        intradaySquareOffBlockMinutesBeforeClose: 10,
        postMarketWindowMinutes: 60,
        reportMinutesAfterClose: 15,
        weekendDays: ['SATURDAY', 'SUNDAY'],
        isActive: true,
        historyCacheEnabled: false,
      });
    }
  }, [exchange, show]);

  // Kept for as long as the modal lives -- the enums do not change under it.
  const { data: served } = useQuery({
    queryKey: ['exchange-options'],
    queryFn: () => exchangeService.getOptions(),
    staleTime: Infinity,
    enabled: !isViewMode,
  });
  const options = served ?? FALLBACK;

  /**
   * ~600 zones, grouped by the part before the slash. Searchable is what makes
   * the list usable at all; the groups are what make it browsable when you do
   * not already know the name you are looking for.
   */
  const timezoneGroups = useMemo(() => {
    const byRegion = new Map<string, string[]>();
    for (const zone of options.timezones) {
      const region = zone.includes('/') ? zone.slice(0, zone.indexOf('/')) : 'Other';
      const group = byRegion.get(region);
      if (group) group.push(zone);
      else byRegion.set(region, [zone]);
    }
    return [...byRegion.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([region, zones]) => ({
        label: region,
        options: zones.map((zone) => ({ value: zone, label: zone })),
      }));
  }, [options.timezones]);

  const handleSubmit = () => {
    onSave(formData, isCreateMode);
  };

  /** Both weekend days and segments are sets of names; one toggle serves both. */
  const toggle = (field: 'weekendDays' | 'segments', value: string) => {
    const current = formData[field] || [];
    setFormData({
      ...formData,
      [field]: current.includes(value)
        ? current.filter((v) => v !== value)
        : [...current, value],
    });
  };

  const getModalTitle = () => {
    if (isCreateMode) return 'Add New Exchange';
    if (isViewMode) return `Exchange: ${exchange?.exchangeName || exchange?.exchange}`;
    return `Edit Exchange: ${exchange?.exchangeName || exchange?.exchange}`;
  };

  return (
    <Modal show={show} onHide={onClose} size="xl" backdrop="static">
      <Modal.Header closeButton>
        <Modal.Title className="flex items-center gap-2">
          <BsGlobe />
          {getModalTitle()}
        </Modal.Title>
      </Modal.Header>
      <Modal.Body>
        {isViewMode && exchange ? (
          <Tabs defaultActiveKey="basic" className="mb-4">
            <Tab eventKey="basic" title="Basic Info">
              <Row className="">
                <Col md={4}>
                  <label className="text-ink-soft text-[0.875em]">Exchange Code</label>
                  <div><code className="text-xl">{exchange.exchange}</code></div>
                </Col>
                <Col md={4}>
                  <label className="text-ink-soft text-[0.875em]">Exchange Name</label>
                  <div className="font-medium">{exchange.exchangeName}</div>
                </Col>
                <Col md={4}>
                  <label className="text-ink-soft text-[0.875em]">Timezone</label>
                  <div>{exchange.timezone || 'N/A'}</div>
                </Col>
                <Col md={4}>
                  <label className="text-ink-soft text-[0.875em]">Currency</label>
                  <div className="font-medium">
                    {currencySymbol(exchange.currency)} {exchange.currency || 'N/A'}
                  </div>
                </Col>
                <Col md={4}>
                  <label className="text-ink-soft text-[0.875em]">Segments</label>
                  <div className="flex flex-wrap gap-1">
                    {exchange.segments?.length
                      ? exchange.segments.map((segment) => (
                          <Badge key={segment} bg="secondary">
                            {segment}
                          </Badge>
                        ))
                      : 'N/A'}
                  </div>
                </Col>
                <Col md={4}>
                  <label className="text-ink-soft text-[0.875em]">Status</label>
                  <div><Badge bg={exchange.isActive ? 'success' : 'secondary'}>{exchange.isActive ? 'Active' : 'Inactive'}</Badge></div>
                </Col>
                <Col md={4}>
                  <label className="text-ink-soft text-[0.875em]">History Cache</label>
                  <div><Badge bg={exchange.historyCacheEnabled ? 'info' : 'secondary'}>{exchange.historyCacheEnabled ? 'Enabled' : 'Disabled'}</Badge></div>
                </Col>
                <Col md={4}>
                  <label className="text-ink-soft text-[0.875em]">Weekend Days</label>
                  <div>{exchange.weekendDays?.join(', ') || 'N/A'}</div>
                </Col>
              </Row>
            </Tab>
            <Tab eventKey="timing" title="Market Timing">
              <Row className="">
                <Col md={3}>
                  <label className="text-ink-soft text-[0.875em]">Pre-Market Start</label>
                  <div className="font-medium">{exchange.preMarketStart || '--'}</div>
                </Col>
                <Col md={3}>
                  <label className="text-ink-soft text-[0.875em]">Pre-Market End</label>
                  <div className="font-medium">{exchange.preMarketEnd || '--'}</div>
                </Col>
                <Col md={3}>
                  <label className="text-ink-soft text-[0.875em]">Market Open</label>
                  <div className="font-medium text-success-500 dark:text-success-400">{exchange.marketOpen || '--'}</div>
                </Col>
                <Col md={3}>
                  <label className="text-ink-soft text-[0.875em]">Market Close</label>
                  <div className="font-medium text-danger-600 dark:text-danger-400">{exchange.marketClose || '--'}</div>
                </Col>
              </Row>
            </Tab>
            <Tab eventKey="algo" title="Algo Configuration">
              <Row className="">
                <Col md={4}>
                  <label className="text-ink-soft text-[0.875em]">Algo Start (mins before open)</label>
                  <div className="font-medium">{exchange.algoStartMinutesBeforeMarketOpen ?? 'N/A'}</div>
                </Col>
                <Col md={4}>
                  <label className="text-ink-soft text-[0.875em]">Post-Market Window (mins)</label>
                  <div className="font-medium">{exchange.postMarketWindowMinutes ?? 'N/A'}</div>
                </Col>
                <Col md={4}>
                  <label className="text-ink-soft text-[0.875em]">Intraday SqOff (mins before close)</label>
                  <div className="font-medium">{exchange.intradaySquareOffMinutesBeforeClose ?? 'N/A'}</div>
                </Col>
                <Col md={4}>
                  <label className="text-ink-soft text-[0.875em]">Intraday Block SqOff (mins before close)</label>
                  <div className="font-medium">{exchange.intradaySquareOffBlockMinutesBeforeClose ?? 'N/A'}</div>
                </Col>
                <Col md={4}>
                  <label className="text-ink-soft text-[0.875em]">Report Generation (mins after close)</label>
                  <div className="font-medium">{exchange.reportMinutesAfterClose ?? 'N/A'}</div>
                </Col>
              </Row>
            </Tab>
          </Tabs>
        ) : (
          <Tabs defaultActiveKey="basic" className="mb-4">
            <Tab eventKey="basic" title="Basic Info">
              <Form>
                <Row>
                  <Col md={4}>
                    <Form.Group className="mb-4">
                      <Form.Label className="flex items-center">Exchange Code * <HelpIcon article={exchangeHelpContent['exchange.code']} /></Form.Label>
                      <Form.Control
                        value={formData.exchange}
                        onChange={(e) => setFormData({ ...formData, exchange: e.target.value.toUpperCase() })}
                        disabled={!isCreateMode}
                        placeholder="e.g., NSE, BSE, MCX"
                      />
                    </Form.Group>
                  </Col>
                  <Col md={4}>
                    <Form.Group className="mb-4">
                      <Form.Label className="flex items-center">Exchange Name * <HelpIcon article={exchangeHelpContent['exchange.exchangeName']} /></Form.Label>
                      <Form.Control
                        value={formData.exchangeName}
                        onChange={(e) => setFormData({ ...formData, exchangeName: e.target.value })}
                        placeholder="Full exchange name"
                      />
                    </Form.Group>
                  </Col>
                  <Col md={4}>
                    <Form.Group className="mb-4">
                      <Form.Label className="flex items-center">Timezone <HelpIcon article={exchangeHelpContent['exchange.timezone']} /></Form.Label>
                      <Select
                        classNamePrefix="react-select"
                        options={timezoneGroups}
                        value={
                          formData.timezone
                            ? { value: formData.timezone, label: formData.timezone }
                            : null
                        }
                        onChange={(choice) =>
                          setFormData({ ...formData, timezone: choice?.value ?? '' })
                        }
                        placeholder="Search a timezone…"
                        isClearable
                        /* The menu is portalled out of the modal, which clips
                           anything overflowing its body. */
                        menuPortalTarget={typeof document === 'undefined' ? null : document.body}
                        styles={{ menuPortal: (base) => ({ ...base, zIndex: 9999 }) }}
                      />
                    </Form.Group>
                  </Col>
                </Row>
                <Row>
                  <Col md={4}>
                    <Form.Group className="mb-4">
                      {/* Required: a P&L figure from this venue carries this
                          currency, and a number without a unit is not a price. */}
                      <Form.Label>Currency *</Form.Label>
                      <Form.Select
                        value={formData.currency ?? ''}
                        onChange={(e) => setFormData({ ...formData, currency: e.target.value })}
                      >
                        <option value="">Select a currency…</option>
                        {options.currencies.map((code) => (
                          <option key={code} value={code}>
                            {code} {currencySymbol(code)}
                          </option>
                        ))}
                      </Form.Select>
                    </Form.Group>
                  </Col>
                  <Col md={8}>
                    <Form.Group className="mb-4">
                      {/* Required too: the engine will not build a venue that
                          does not say what it lists, so a blank set here
                          produces a row that fails at startup instead. */}
                      <Form.Label>Segments *</Form.Label>
                      <div className="flex flex-wrap gap-3">
                        {options.segments.map((segment) => (
                          <Form.Check
                            key={segment}
                            type="checkbox"
                            label={segment}
                            checked={formData.segments?.includes(segment) ?? false}
                            onChange={() => toggle('segments', segment)}
                            inline
                          />
                        ))}
                      </div>
                      {!formData.segments?.length && (
                        <small className="text-danger-500">
                          Pick at least one — a venue that lists nothing cannot load.
                        </small>
                      )}
                    </Form.Group>
                  </Col>
                </Row>
                <Row>
                  <Col md={4}>
                    <Form.Check
                      type="switch"
                      label={<span className="flex items-center">Active <HelpIcon article={exchangeHelpContent['exchange.isActive']} /></span>}
                      checked={formData.isActive ?? true}
                      onChange={(e) => setFormData({ ...formData, isActive: e.target.checked })}
                      className="mb-4"
                    />
                  </Col>
                  <Col md={4}>
                    <Form.Check
                      type="switch"
                      label={<span className="flex items-center">History Cache Enabled <HelpIcon article={exchangeHelpContent['exchange.historyCacheEnabled']} /></span>}
                      checked={formData.historyCacheEnabled ?? false}
                      onChange={(e) => setFormData({ ...formData, historyCacheEnabled: e.target.checked })}
                      className="mb-4"
                    />
                  </Col>
                </Row>
                <Row>
                  <Col md={12}>
                    <Form.Label className="flex items-center">Weekend Days <HelpIcon article={exchangeHelpContent['exchange.weekendDays']} /></Form.Label>
                    <div className="flex flex-wrap gap-2">
                      {options.weekendDays.map((day) => (
                        <Form.Check
                          key={day}
                          type="checkbox"
                          label={day}
                          checked={formData.weekendDays?.includes(day) ?? false}
                          onChange={() => toggle('weekendDays', day)}
                          inline
                        />
                      ))}
                    </div>
                  </Col>
                </Row>
              </Form>
            </Tab>
            <Tab eventKey="timing" title="Market Timing">
              <Form>
                <Row>
                  <Col md={3}>
                    <Form.Group className="mb-4">
                      <Form.Label className="flex items-center">Pre-Market Start <HelpIcon article={exchangeHelpContent['exchange.preMarketStart']} /></Form.Label>
                      <Form.Control
                        type="time"
                        step="1"
                        value={formData.preMarketStart ?? ''}
                        onChange={(e) => setFormData({ ...formData, preMarketStart: e.target.value })}
                      />
                    </Form.Group>
                  </Col>
                  <Col md={3}>
                    <Form.Group className="mb-4">
                      <Form.Label className="flex items-center">Pre-Market End <HelpIcon article={exchangeHelpContent['exchange.preMarketEnd']} /></Form.Label>
                      <Form.Control
                        type="time"
                        step="1"
                        value={formData.preMarketEnd ?? ''}
                        onChange={(e) => setFormData({ ...formData, preMarketEnd: e.target.value })}
                      />
                    </Form.Group>
                  </Col>
                  <Col md={3}>
                    <Form.Group className="mb-4">
                      <Form.Label className="flex items-center">Market Open * <HelpIcon article={exchangeHelpContent['exchange.marketOpen']} /></Form.Label>
                      <Form.Control
                        type="time"
                        step="1"
                        value={formData.marketOpen ?? ''}
                        onChange={(e) => setFormData({ ...formData, marketOpen: e.target.value })}
                      />
                    </Form.Group>
                  </Col>
                  <Col md={3}>
                    <Form.Group className="mb-4">
                      <Form.Label className="flex items-center">Market Close * <HelpIcon article={exchangeHelpContent['exchange.marketClose']} /></Form.Label>
                      <Form.Control
                        type="time"
                        step="1"
                        value={formData.marketClose ?? ''}
                        onChange={(e) => setFormData({ ...formData, marketClose: e.target.value })}
                      />
                    </Form.Group>
                  </Col>
                </Row>
              </Form>
            </Tab>
            <Tab eventKey="algo" title="Algo Configuration">
              <Form>
                <Row>
                  <Col md={4}>
                    <Form.Group className="mb-4">
                      <Form.Label className="flex items-center">Algo Start (mins before market open) <HelpIcon article={exchangeHelpContent['exchange.algoStartMinutesBeforeMarketOpen']} /></Form.Label>
                      <Form.Control
                        type="number"
                        value={formData.algoStartMinutesBeforeMarketOpen ?? ''}
                        onChange={(e) => setFormData({ ...formData, algoStartMinutesBeforeMarketOpen: parseInt(e.target.value) || 0 })}
                      />
                    </Form.Group>
                  </Col>
                  <Col md={4}>
                    <Form.Group className="mb-4">
                      <Form.Label className="flex items-center">Post-Market Window (mins) <HelpIcon article={exchangeHelpContent['exchange.postMarketWindowMinutes']} /></Form.Label>
                      <Form.Control
                        type="number"
                        value={formData.postMarketWindowMinutes ?? ''}
                        onChange={(e) => setFormData({ ...formData, postMarketWindowMinutes: parseInt(e.target.value) || 0 })}
                      />
                    </Form.Group>
                  </Col>
                </Row>
                <Row>
                  <Col md={4}>
                    <Form.Group className="mb-4">
                      <Form.Label className="flex items-center">Intraday Square-Off (mins before close) <HelpIcon article={exchangeHelpContent['exchange.intradaySquareOffMinutesBeforeClose']} /></Form.Label>
                      <Form.Control
                        type="number"
                        value={formData.intradaySquareOffMinutesBeforeClose ?? ''}
                        onChange={(e) => setFormData({ ...formData, intradaySquareOffMinutesBeforeClose: parseInt(e.target.value) || 0 })}
                      />
                    </Form.Group>
                  </Col>
                  <Col md={4}>
                    <Form.Group className="mb-4">
                      <Form.Label className="flex items-center">Intraday Block Square-Off (mins before close) <HelpIcon article={exchangeHelpContent['exchange.intradaySquareOffBlockMinutesBeforeClose']} /></Form.Label>
                      <Form.Control
                        type="number"
                        value={formData.intradaySquareOffBlockMinutesBeforeClose ?? ''}
                        onChange={(e) => setFormData({ ...formData, intradaySquareOffBlockMinutesBeforeClose: parseInt(e.target.value) || 0 })}
                      />
                    </Form.Group>
                  </Col>
                </Row>
                <Row>
                  <Col md={4}>
                    <Form.Group className="mb-4">
                      <Form.Label className="flex items-center">Report Generation (mins after close) <HelpIcon article={exchangeHelpContent['exchange.reportMinutesAfterClose']} /></Form.Label>
                      <Form.Control
                        type="number"
                        value={formData.reportMinutesAfterClose ?? ''}
                        onChange={(e) => setFormData({ ...formData, reportMinutesAfterClose: parseInt(e.target.value) || 0 })}
                      />
                    </Form.Group>
                  </Col>
                </Row>
              </Form>
            </Tab>
          </Tabs>
        )}
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={onClose}>
          {isViewMode ? 'Close' : 'Cancel'}
        </Button>
        {!isViewMode && (
          <Button variant="primary" onClick={handleSubmit} disabled={isSaving}>
            {isSaving ? <><Spinner size="sm" className="me-1" />Saving...</> : (isCreateMode ? 'Add Exchange' : 'Update')}
          </Button>
        )}
      </Modal.Footer>
    </Modal>
  );
};

export default Exchange;
