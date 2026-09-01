/**
 * Symbol Component
 * Modal for viewing/editing a single symbol (SymbolInfo)
 * Reusable across Admin portals
 * Uses V2 API: /api/v2/symbols
 *
 * Distributed: Only core fields (maxOptionChainLevels, straddleMaxPremiumDiff, hedgeStrikeRoundingMultiple) editable.
 * Standalone: All fields editable, supports create mode.
 */

import { useState, useEffect } from 'react';
import { Modal, Form, Row, Col, Button, Spinner, Badge } from '@/components/ui/rbShim';
import { BsTags } from 'react-icons/bs';
import { useQuery } from '@tanstack/react-query';
import { exchangeService } from '@/services/admin/v2AdminService';
import type { Symbol as SymbolType, CreateSymbolRequest } from '@/types/symbol';
import HelpIcon from '@/components/common/HelpIcon';
import { symbolHelpContent } from '@/data/help';

export interface SymbolProps {
  /** Symbol for edit mode, null for create mode */
  symbol: SymbolType | null;
  /** Whether the modal is visible */
  show: boolean;
  /** Close modal callback */
  onClose: () => void;
  /** Save callback */
  onSave: (data: CreateSymbolRequest, isNew: boolean) => void;
  /** Whether save is in progress */
  isSaving?: boolean;
  /** Mode: 'view' | 'edit' | 'create' */
  mode?: 'view' | 'edit' | 'create';
}

const Symbol: React.FC<SymbolProps> = ({
  symbol,
  show,
  onClose,
  onSave,
  isSaving = false,
  mode = symbol ? 'edit' : 'create',
}) => {
  const isViewMode = mode === 'view';
  const isCreateMode = mode === 'create';

  const { data: exchanges } = useQuery({
    queryKey: ['exchanges'],
    queryFn: () => exchangeService.getAll(),
  });

  // In Standalone mode, all fields are editable (not synced from external market-data)
  const allFieldsEditable = !isViewMode;

  const [formData, setFormData] = useState<CreateSymbolRequest>({
    symbol: '',
    exchange: 'NSE',
    indexSymbol: '',
    isIndex: false,
    strikeGap: 50,
    freezeLimitQty: 1800,
    maxOptionChainLevels: 10,
    straddleMaxPremiumDiff: 25,
    hedgeStrikeRoundingMultiple: 0,
    contractMultiplier: 1,
    hasOptionsWeeklyExpiry: false,
    hasOptionsMonthlyExpiry: true,
    hasFuturesWeeklyExpiry: false,
    hasFuturesMonthlyExpiry: true,
  });

  useEffect(() => {
    if (symbol) {
      setFormData({
        symbol: symbol.symbol,
        exchange: symbol.exchange || 'NSE',
        indexSymbol: symbol.indexSymbol || '',
        isIndex: symbol.isIndex || false,
        strikeGap: symbol.strikeGap || 50,
        freezeLimitQty: symbol.freezeLimitQty || 1800,
        maxOptionChainLevels: symbol.maxOptionChainLevels || 10,
        straddleMaxPremiumDiff: symbol.straddleMaxPremiumDiff || 25,
        hedgeStrikeRoundingMultiple: symbol.hedgeStrikeRoundingMultiple || 0,
        contractMultiplier: symbol.contractMultiplier || 1,
        hasOptionsWeeklyExpiry: symbol.hasOptionsWeeklyExpiry || false,
        hasOptionsMonthlyExpiry: symbol.hasOptionsMonthlyExpiry || false,
        hasFuturesWeeklyExpiry: symbol.hasFuturesWeeklyExpiry || false,
        hasFuturesMonthlyExpiry: symbol.hasFuturesMonthlyExpiry || false,
      });
    } else {
      setFormData({
        symbol: '',
        exchange: exchanges?.[0]?.exchange || 'NSE',
        indexSymbol: '',
        isIndex: false,
        strikeGap: 50,
        freezeLimitQty: 1800,
        maxOptionChainLevels: 10,
        straddleMaxPremiumDiff: 25,
        hedgeStrikeRoundingMultiple: 0,
        contractMultiplier: 1,
        hasOptionsWeeklyExpiry: false,
        hasOptionsMonthlyExpiry: true,
        hasFuturesWeeklyExpiry: false,
        hasFuturesMonthlyExpiry: true,
      });
    }
  }, [symbol, show, exchanges]);

  const handleSubmit = () => {
    onSave(formData, isCreateMode);
  };

  const getModalTitle = () => {
    if (isCreateMode) return 'Add New Symbol';
    if (isViewMode) return `Symbol: ${symbol?.symbol}`;
    return `Edit Symbol: ${symbol?.symbol}`;
  };

  return (
    <Modal show={show} onHide={onClose} size="lg" backdrop="static">
      <Modal.Header closeButton>
        <Modal.Title className="flex items-center gap-2">
          <BsTags />
          {getModalTitle()}
        </Modal.Title>
      </Modal.Header>
      <Modal.Body>
        {isViewMode && symbol ? (
          <Row className="">
            <Col md={4}>
              <label className="text-ink-soft text-[0.875em]">Symbol</label>
              <div><code className="text-xl">{symbol.symbol}</code></div>
            </Col>
            <Col md={4}>
              <label className="text-ink-soft text-[0.875em]">Exchange</label>
              <div><Badge bg="secondary">{symbol.exchange}</Badge></div>
            </Col>
            <Col md={4}>
              <label className="text-ink-soft text-[0.875em]">Type</label>
              <div><Badge bg={symbol.isIndex ? 'info' : 'secondary'}>{symbol.isIndex ? 'Index' : 'Stock'}</Badge></div>
            </Col>
            {symbol.indexSymbol && (
              <Col md={4}>
                <label className="text-ink-soft text-[0.875em]">Index Symbol</label>
                <div className="font-medium">{symbol.indexSymbol}</div>
              </Col>
            )}
            <Col md={4}>
              <label className="text-ink-soft text-[0.875em]">Strike Gap</label>
              <div className="font-medium">{symbol.strikeGap || 'N/A'}</div>
            </Col>
            <Col md={4}>
              <label className="text-ink-soft text-[0.875em]">Freeze Limit (Qty)</label>
              <div className="font-medium">{symbol.freezeLimitQty || 'N/A'}</div>
            </Col>
            <Col md={4}>
              <label className="text-ink-soft text-[0.875em]">Contract Multiplier</label>
              <div className="font-medium">{symbol.contractMultiplier || 1}</div>
            </Col>
            <Col md={4}>
              <label className="text-ink-soft text-[0.875em]">Max Option Chain Levels</label>
              <div className="font-medium">{symbol.maxOptionChainLevels || 'N/A'}</div>
            </Col>
            <Col md={4}>
              <label className="text-ink-soft text-[0.875em]">Straddle Max Premium Diff</label>
              <div className="font-medium">{symbol.straddleMaxPremiumDiff || 25}</div>
            </Col>
            <Col md={4}>
              <label className="text-ink-soft text-[0.875em]">Hedge Strike Rounding</label>
              <div className="font-medium">{symbol.hedgeStrikeRoundingMultiple || 0} {symbol.hedgeStrikeRoundingMultiple ? '' : '(use strikeGap)'}</div>
            </Col>
            <Col md={12}>
              <label className="text-ink-soft text-[0.875em]">Expiry Types</label>
              <div className="flex flex-wrap gap-2 mt-1">
                <Badge bg={symbol.hasOptionsWeeklyExpiry ? 'success' : 'secondary'}>Options Weekly: {symbol.hasOptionsWeeklyExpiry ? 'Yes' : 'No'}</Badge>
                <Badge bg={symbol.hasOptionsMonthlyExpiry ? 'success' : 'secondary'}>Options Monthly: {symbol.hasOptionsMonthlyExpiry ? 'Yes' : 'No'}</Badge>
                <Badge bg={symbol.hasFuturesWeeklyExpiry ? 'warning' : 'secondary'}>Futures Weekly: {symbol.hasFuturesWeeklyExpiry ? 'Yes' : 'No'}</Badge>
                <Badge bg={symbol.hasFuturesMonthlyExpiry ? 'warning' : 'secondary'}>Futures Monthly: {symbol.hasFuturesMonthlyExpiry ? 'Yes' : 'No'}</Badge>
              </div>
            </Col>
          </Row>
        ) : (
          <Form>
            <Row>
              <Col md={4}>
                <Form.Group className="mb-4">
                  <Form.Label className="flex items-center">Symbol {isCreateMode && '*'} <HelpIcon article={symbolHelpContent['symbol.symbol']} /></Form.Label>
                  <Form.Control
                    value={formData.symbol}
                    onChange={(e) => setFormData({ ...formData, symbol: e.target.value.toUpperCase() })}
                    disabled={!isCreateMode}
                    className={!isCreateMode ? 'bg-raised' : ''}
                    placeholder="e.g., NIFTY"
                  />
                </Form.Group>
              </Col>
              <Col md={4}>
                <Form.Group className="mb-4">
                  <Form.Label className="flex items-center">Exchange {isCreateMode && '*'} <HelpIcon article={symbolHelpContent['symbol.exchange']} /></Form.Label>
                  {allFieldsEditable ? (
                    <Form.Select
                      value={formData.exchange}
                      onChange={(e) => setFormData({ ...formData, exchange: e.target.value })}
                      disabled={!isCreateMode}
                      className={!isCreateMode ? 'bg-raised' : ''}
                    >
                      {exchanges?.map((ex) => (
                        <option key={ex.exchange} value={ex.exchange}>{ex.exchange}</option>
                      ))}
                    </Form.Select>
                  ) : (
                    <Form.Control
                      value={formData.exchange}
                      disabled
                      className="bg-raised"
                    />
                  )}
                </Form.Group>
              </Col>
              <Col md={4}>
                <Form.Group className="mb-4">
                  <Form.Label className="flex items-center">Index Symbol <HelpIcon article={symbolHelpContent['symbol.indexSymbol']} /></Form.Label>
                  <Form.Control
                    value={allFieldsEditable ? (formData.indexSymbol || '') : (formData.indexSymbol || '-')}
                    onChange={(e) => setFormData({ ...formData, indexSymbol: e.target.value })}
                    disabled={!allFieldsEditable}
                    className={!allFieldsEditable ? 'bg-raised' : ''}
                    placeholder="e.g., Nifty 50"
                  />
                </Form.Group>
              </Col>
            </Row>
            <Row>
              <Col md={3}>
                <Form.Group className="mb-4">
                  <Form.Label className="flex items-center">Strike Gap <HelpIcon article={symbolHelpContent['symbol.strikeGap']} /></Form.Label>
                  <Form.Control
                    type="number"
                    value={formData.strikeGap || ''}
                    onChange={(e) => setFormData({ ...formData, strikeGap: parseInt(e.target.value) || 0 })}
                    disabled={!allFieldsEditable}
                    className={!allFieldsEditable ? 'bg-raised' : ''}
                  />
                </Form.Group>
              </Col>
              <Col md={3}>
                <Form.Group className="mb-4">
                  <Form.Label className="flex items-center">Freeze Limit (Qty) <HelpIcon article={symbolHelpContent['symbol.freezeLimitQty']} /></Form.Label>
                  <Form.Control
                    type="number"
                    value={formData.freezeLimitQty || ''}
                    onChange={(e) => setFormData({ ...formData, freezeLimitQty: parseInt(e.target.value) || 0 })}
                    disabled={!allFieldsEditable}
                    className={!allFieldsEditable ? 'bg-raised' : ''}
                  />
                </Form.Group>
              </Col>
              <Col md={3}>
                <Form.Group className="mb-4">
                  <Form.Label className="flex items-center">Contract Multiplier <HelpIcon article={symbolHelpContent['symbol.contractMultiplier']} /></Form.Label>
                  <Form.Control
                    type="number"
                    value={allFieldsEditable ? (formData.contractMultiplier || 1) : (symbol?.contractMultiplier || 1)}
                    onChange={(e) => setFormData({ ...formData, contractMultiplier: parseInt(e.target.value) || 1 })}
                    disabled={!allFieldsEditable}
                    className={!allFieldsEditable ? 'bg-raised' : ''}
                  />
                                  </Form.Group>
              </Col>
              <Col md={3}>
                <Form.Group className="mb-4">
                  <Form.Label className="flex items-center">Type <HelpIcon article={symbolHelpContent['symbol.isIndex']} /></Form.Label>
                  {allFieldsEditable ? (
                    <Form.Check
                      type="switch"
                      label={formData.isIndex ? 'Index' : 'Stock'}
                      checked={formData.isIndex ?? false}
                      onChange={(e) => setFormData({ ...formData, isIndex: e.target.checked })}
                      className="mt-2"
                    />
                  ) : (
                    <Form.Control
                      value={formData.isIndex ? 'Index' : 'Stock'}
                      disabled
                      className="bg-raised"
                    />
                  )}
                </Form.Group>
              </Col>
            </Row>
            <Row>
              <Col md={3}>
                <Form.Group className="mb-4">
                  <Form.Label className="flex items-center">Max OC Levels * <HelpIcon article={symbolHelpContent['symbol.maxOptionChainLevels']} /></Form.Label>
                  <Form.Control
                    type="number"
                    min={1}
                    max={50}
                    value={formData.maxOptionChainLevels || ''}
                    onChange={(e) => setFormData({ ...formData, maxOptionChainLevels: parseInt(e.target.value) || 0 })}
                  />
                  <Form.Text className="text-ink-soft">Editable - Core only</Form.Text>
                </Form.Group>
              </Col>
            </Row>
            <Row>
              <Col md={4}>
                <Form.Group className="mb-4">
                  <Form.Label className="flex items-center">Straddle Max Premium Diff * <HelpIcon article={symbolHelpContent['symbol.straddleMaxPremiumDiff']} /></Form.Label>
                  <Form.Control
                    type="number"
                    min={1}
                    max={200}
                    step={5}
                    value={formData.straddleMaxPremiumDiff || ''}
                    onChange={(e) => setFormData({ ...formData, straddleMaxPremiumDiff: parseFloat(e.target.value) || 25 })}
                  />
                  <Form.Text className="text-ink-soft">Max CE-PE premium diff for straddle selection (Core only)</Form.Text>
                </Form.Group>
              </Col>
              <Col md={4}>
                <Form.Group className="mb-4">
                  <Form.Label className="flex items-center">Hedge Strike Rounding * <HelpIcon article={symbolHelpContent['symbol.hedgeStrikeRoundingMultiple']} /></Form.Label>
                  <Form.Control
                    type="number"
                    min={0}
                    max={1000}
                    step={50}
                    value={formData.hedgeStrikeRoundingMultiple || 0}
                    onChange={(e) => setFormData({ ...formData, hedgeStrikeRoundingMultiple: parseInt(e.target.value) || 0 })}
                  />
                  <Form.Text className="text-ink-soft">Rounding multiple for hedge strikes (0 = use strikeGap only, e.g., 500 for SENSEX/BANKNIFTY)</Form.Text>
                </Form.Group>
              </Col>
            </Row>
            <hr />
            <h6 className="text-ink-soft mb-4">Expiry Configuration</h6>
            <Row>
              <Col md={3}>
                <Form.Check
                  type="switch"
                  label="Options Weekly"
                  checked={formData.hasOptionsWeeklyExpiry ?? false}
                  onChange={(e) => setFormData({ ...formData, hasOptionsWeeklyExpiry: e.target.checked })}
                  disabled={!allFieldsEditable}
                  className="mb-4"
                />
              </Col>
              <Col md={3}>
                <Form.Check
                  type="switch"
                  label="Options Monthly"
                  checked={formData.hasOptionsMonthlyExpiry ?? false}
                  onChange={(e) => setFormData({ ...formData, hasOptionsMonthlyExpiry: e.target.checked })}
                  disabled={!allFieldsEditable}
                  className="mb-4"
                />
              </Col>
              <Col md={3}>
                <Form.Check
                  type="switch"
                  label="Futures Weekly"
                  checked={formData.hasFuturesWeeklyExpiry ?? false}
                  onChange={(e) => setFormData({ ...formData, hasFuturesWeeklyExpiry: e.target.checked })}
                  disabled={!allFieldsEditable}
                  className="mb-4"
                />
              </Col>
              <Col md={3}>
                <Form.Check
                  type="switch"
                  label="Futures Monthly"
                  checked={formData.hasFuturesMonthlyExpiry ?? false}
                  onChange={(e) => setFormData({ ...formData, hasFuturesMonthlyExpiry: e.target.checked })}
                  disabled={!allFieldsEditable}
                  className="mb-4"
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
          <Button variant="primary" onClick={handleSubmit} disabled={isSaving}>
            {isSaving ? <><Spinner size="sm" className="me-1" />Saving...</> : (isCreateMode ? 'Add Symbol' : 'Update')}
          </Button>
        )}
      </Modal.Footer>
    </Modal>
  );
};

export default Symbol;
