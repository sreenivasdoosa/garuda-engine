/**
 * Trade Component
 * Modal for viewing a single trade
 * Reusable across Admin, Client Manager portals
 */

import { Modal, Row, Col, Button, Badge } from '@/components/ui/rbShim';
import { BsGraphUpArrow } from 'react-icons/bs';
import type { Trade as TradeType } from '@/types/reports';

export interface TradeProps {
  /** Trade entry */
  trade: TradeType | null;
  /** Whether the modal is visible */
  show: boolean;
  /** Close modal callback */
  onClose: () => void;
}

const Trade: React.FC<TradeProps> = ({
  trade,
  show,
  onClose,
}) => {
  if (!trade) return null;

  const pnlColor = trade.netPnl >= 0 ? 'text-success-500 dark:text-success-400' : 'text-danger-600 dark:text-danger-400';

  return (
    <Modal show={show} onHide={onClose} size="lg" backdrop="static">
      <Modal.Header closeButton>
        <Modal.Title className="flex items-center gap-2">
          <BsGraphUpArrow />
          Trade Details
        </Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <Row className="">
          <Col md={6}>
            <label className="text-ink-soft text-[0.875em]">Symbol</label>
            <div className="font-medium">{trade.symbol}</div>
          </Col>
          <Col md={6}>
            <label className="text-ink-soft text-[0.875em]">Trade ID</label>
            <div><code>{trade.id}</code></div>
          </Col>
          <Col md={6}>
            <label className="text-ink-soft text-[0.875em]">Username</label>
            <div>{trade.username}</div>
          </Col>
          <Col md={6}>
            <label className="text-ink-soft text-[0.875em]">Broker</label>
            <div><Badge bg="info">{trade.broker}</Badge></div>
          </Col>
          <Col md={6}>
            <label className="text-ink-soft text-[0.875em]">Strategy</label>
            <div><Badge bg="primary">{trade.strategy}</Badge></div>
          </Col>
          <Col md={6}>
            <label className="text-ink-soft text-[0.875em]">Exchange</label>
            <div>{trade.exchange}</div>
          </Col>
          <Col md={6}>
            <label className="text-ink-soft text-[0.875em]">Trade Type</label>
            <div><Badge bg="secondary">{trade.tradeType}</Badge></div>
          </Col>
          {trade.legRole && (
            <Col md={6}>
              <label className="text-ink-soft text-[0.875em]">Leg Role</label>
              <div>
                <Badge bg={trade.legRole === 'HEDGE' ? 'info' : 'secondary'}>{trade.legRole}</Badge>
                {/* 0 means the trade predates entry sequencing, which is not the same as "first". */}
                {trade.entrySequence ? (
                  <span className="text-ink-soft ml-2 text-[0.875em]">entry #{trade.entrySequence}</span>
                ) : null}
              </div>
            </Col>
          )}
          {trade.comboId && (
            <Col md={6}>
              <label className="text-ink-soft text-[0.875em]">Combo ID</label>
              <div><code>{trade.comboId}</code></div>
            </Col>
          )}
          <Col md={6}>
            <label className="text-ink-soft text-[0.875em]">Order Type</label>
            <div>
              <Badge bg={trade.orderType === 'BUY' ? 'success' : 'danger'}>
                {trade.orderType}
              </Badge>
            </div>
          </Col>
          <Col md={6}>
            <label className="text-ink-soft text-[0.875em]">Quantity</label>
            <div className="font-medium">{trade.quantity}</div>
          </Col>
          <Col md={6}>
            <label className="text-ink-soft text-[0.875em]">Price</label>
            <div>{trade.price.toFixed(2)}</div>
          </Col>
          <Col md={6}>
            <label className="text-ink-soft text-[0.875em]">Status</label>
            <div>
              <Badge bg={trade.status === 'CLOSED' ? 'secondary' : trade.status === 'OPEN' ? 'success' : 'warning'}>
                {trade.status}
              </Badge>
            </div>
          </Col>
          <Col md={6}>
            <label className="text-ink-soft text-[0.875em]">Entry Time</label>
            <div>{new Date(trade.entryTime).toLocaleString()}</div>
          </Col>
          {trade.exitTime && (
            <Col md={6}>
              <label className="text-ink-soft text-[0.875em]">Exit Time</label>
              <div>{new Date(trade.exitTime).toLocaleString()}</div>
            </Col>
          )}
          <Col md={12}><hr className="my-2" /></Col>
          <Col md={4}>
            <label className="text-ink-soft text-[0.875em]">P&L</label>
            <div className={pnlColor + ' font-medium'}>{trade.pnl.toFixed(2)}</div>
          </Col>
          <Col md={4}>
            <label className="text-ink-soft text-[0.875em]">Brokerage</label>
            <div>{trade.brokerage.toFixed(2)}</div>
          </Col>
          <Col md={4}>
            <label className="text-ink-soft text-[0.875em]">Net P&L</label>
            <div className={pnlColor + ' font-medium text-xl'}>{trade.netPnl.toFixed(2)}</div>
          </Col>
        </Row>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={onClose}>Close</Button>
      </Modal.Footer>
    </Modal>
  );
};

export default Trade;
