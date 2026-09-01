/**
 * Exchange Component
 * Modal for viewing/editing a single exchange
 * Reusable across Admin portals
 * Uses V2 API: /api/v2/exchanges
 */

import { useState, useEffect } from 'react';
import { Modal, Form, Row, Col, Button, Spinner, Badge, Tabs, Tab } from '@/components/ui/rbShim';
import { BsGlobe } from 'react-icons/bs';
import HelpIcon from '@/components/common/HelpIcon';
import { exchangeHelpContent } from '@/data/help';
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

const WEEKEND_DAYS = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];

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
    segment: null,
    timezone: 'Asia/Kolkata',
    preMarketStart: '09:00:00',
    preMarketEnd: '09:08:00',
    marketOpen: '09:15:00',
    marketClose: '15:30:00',
    algoStartMinutesBeforeMarketOpen: 90,
    loginMinutesBeforeMarketOpen: 60,
    intradaySquareOffMinutesBeforeClose: 20,
    intradaySquareOffBlockMinutesBeforeClose: 10,
    positionalSquareOffMinutesBeforeClose: 30,
    postMarketWindowMinutes: 60,
    reportMinutesAfterClose: 15,
    billingMinutesAfterClose: 30,
    weekendDays: ['SATURDAY', 'SUNDAY'],
    isActive: true,
    historyCacheEnabled: false,
  });

  useEffect(() => {
    if (exchange) {
      setFormData({
        exchange: exchange.exchange,
        exchangeName: exchange.exchangeName,
        segment: exchange.segment || null,
        timezone: exchange.timezone || 'Asia/Kolkata',
        preMarketStart: exchange.preMarketStart || '',
        preMarketEnd: exchange.preMarketEnd || '',
        marketOpen: exchange.marketOpen || '09:15:00',
        marketClose: exchange.marketClose || '15:30:00',
        algoStartMinutesBeforeMarketOpen: exchange.algoStartMinutesBeforeMarketOpen ?? 90,
        loginMinutesBeforeMarketOpen: exchange.loginMinutesBeforeMarketOpen ?? 60,
        intradaySquareOffMinutesBeforeClose: exchange.intradaySquareOffMinutesBeforeClose ?? 20,
        intradaySquareOffBlockMinutesBeforeClose: exchange.intradaySquareOffBlockMinutesBeforeClose ?? 10,
        positionalSquareOffMinutesBeforeClose: exchange.positionalSquareOffMinutesBeforeClose ?? 30,
        postMarketWindowMinutes: exchange.postMarketWindowMinutes ?? 60,
        reportMinutesAfterClose: exchange.reportMinutesAfterClose ?? 15,
        billingMinutesAfterClose: exchange.billingMinutesAfterClose ?? 30,
        weekendDays: exchange.weekendDays || ['SATURDAY', 'SUNDAY'],
        isActive: exchange.isActive,
        historyCacheEnabled: exchange.historyCacheEnabled ?? false,
      });
    } else {
      setFormData({
        exchange: '',
        exchangeName: '',
        segment: null,
        timezone: 'Asia/Kolkata',
        preMarketStart: '09:00:00',
        preMarketEnd: '09:08:00',
        marketOpen: '09:15:00',
        marketClose: '15:30:00',
        algoStartMinutesBeforeMarketOpen: 90,
        loginMinutesBeforeMarketOpen: 60,
        intradaySquareOffMinutesBeforeClose: 20,
        intradaySquareOffBlockMinutesBeforeClose: 10,
        positionalSquareOffMinutesBeforeClose: 30,
        postMarketWindowMinutes: 60,
        reportMinutesAfterClose: 15,
        billingMinutesAfterClose: 30,
        weekendDays: ['SATURDAY', 'SUNDAY'],
        isActive: true,
        historyCacheEnabled: false,
      });
    }
  }, [exchange, show]);

  const handleSubmit = () => {
    onSave(formData, isCreateMode);
  };

  const handleWeekendDayToggle = (day: string) => {
    const currentDays = formData.weekendDays || [];
    if (currentDays.includes(day)) {
      setFormData({ ...formData, weekendDays: currentDays.filter((d) => d !== day) });
    } else {
      setFormData({ ...formData, weekendDays: [...currentDays, day] });
    }
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
                  <label className="text-ink-soft text-[0.875em]">Login Start (mins before open)</label>
                  <div className="font-medium">{exchange.loginMinutesBeforeMarketOpen ?? 'N/A'}</div>
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
                  <label className="text-ink-soft text-[0.875em]">Positional SqOff (mins before close)</label>
                  <div className="font-medium">{exchange.positionalSquareOffMinutesBeforeClose ?? 'N/A'}</div>
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
                      <Form.Control
                        value={formData.timezone ?? ''}
                        onChange={(e) => setFormData({ ...formData, timezone: e.target.value })}
                        placeholder="e.g., Asia/Kolkata"
                      />
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
                      {WEEKEND_DAYS.map((day) => (
                        <Form.Check
                          key={day}
                          type="checkbox"
                          label={day}
                          checked={formData.weekendDays?.includes(day) ?? false}
                          onChange={() => handleWeekendDayToggle(day)}
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
                      <Form.Label className="flex items-center">Login Start (mins before market open) <HelpIcon article={exchangeHelpContent['exchange.loginMinutesBeforeMarketOpen']} /></Form.Label>
                      <Form.Control
                        type="number"
                        value={formData.loginMinutesBeforeMarketOpen ?? ''}
                        onChange={(e) => setFormData({ ...formData, loginMinutesBeforeMarketOpen: parseInt(e.target.value) || 0 })}
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
                  <Col md={4}>
                    <Form.Group className="mb-4">
                      <Form.Label className="flex items-center">Positional Square-Off (mins before close) <HelpIcon article={exchangeHelpContent['exchange.positionalSquareOffMinutesBeforeClose']} /></Form.Label>
                      <Form.Control
                        type="number"
                        value={formData.positionalSquareOffMinutesBeforeClose ?? ''}
                        onChange={(e) => setFormData({ ...formData, positionalSquareOffMinutesBeforeClose: parseInt(e.target.value) || 0 })}
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
