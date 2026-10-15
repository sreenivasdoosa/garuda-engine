/**
 * Today as the running engine sees it, and a strategy's share of lots by day.
 *
 * The monitor reads `/api/engine/monitor`: the tranche schedule (pending,
 * fired, missed), the tranches with no time, armed and finished breakout
 * watches, and each account's strategy state -- which tranches signalled, the
 * lots and risk used. The day-allocation dialog edits the reference's
 * per-strategy percentages by weekday and expiry proximity.
 */

import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { BsArrowClockwise } from 'react-icons/bs';
import { Alert, Badge, Button, Card, Col, Form, Modal, Row, Spinner } from '@/components/ui/rbShim';
import { strategyLiveService } from '@/services/admin/strategyLiveService';
import type { DayAllocation } from '@/types/strategy-live';

const time = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString() : '—');

export const EngineMonitorTab: React.FC = () => {
  const monitor = useQuery({
    queryKey: ['strategies', 'monitor'],
    queryFn: () => strategyLiveService.monitor(),
    refetchInterval: 10000,
  });
  if (monitor.isLoading) return <Spinner />;
  if (monitor.error) return <Alert variant="warning">{(monitor.error as Error).message}</Alert>;
  const data = monitor.data;
  if (!data) return null;
  const tone = (status: string) =>
    status === 'FIRED' ? 'success' : status === 'MISSED' || status === 'LAPSED' ? 'secondary' : 'info';
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="text-sm text-ink-soft">Trading day {data.tradingDay}</div>
        <Button variant="outline-secondary" size="sm" onClick={() => monitor.refetch()}>
          <BsArrowClockwise className="me-1" />
          Refresh
        </Button>
      </div>
      {Object.keys(data.refused).length > 0 && (
        <Alert variant="danger">
          {Object.entries(data.refused).map(([name, why]) => (
            <div key={name}>
              <strong>{name}</strong> is left out: {why}
            </div>
          ))}
        </Alert>
      )}
      <Card>
        <Card.Header>Tranche schedule</Card.Header>
        <Card.Body>
          {data.schedule.length === 0 && <div className="text-ink-faint text-sm">Nothing scheduled today.</div>}
          <table className="w-full text-sm">
            <tbody>
              {data.schedule.map((slot) => (
                <tr key={`${slot.strategy}-${slot.tranche}-${slot.at}`} className="border-t border-hairline">
                  <td className="py-1 font-mono">{time(slot.at)}</td>
                  <td className="py-1">{slot.strategy}</td>
                  <td className="py-1">tranche {slot.tranche}</td>
                  <td className="py-1 text-right">
                    <Badge bg={tone(slot.status)}>{slot.status}</Badge>
                  </td>
                </tr>
              ))}
              {data.unscheduled.map((u) => (
                <tr key={`u-${u.strategy}-${u.tranche}`} className="border-t border-hairline text-ink-faint">
                  <td className="py-1">—</td>
                  <td className="py-1">{u.strategy}</td>
                  <td className="py-1">tranche {u.tranche}</td>
                  <td className="py-1 text-right">{u.because}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card.Body>
      </Card>
      <Card>
        <Card.Header>Breakout watches</Card.Header>
        <Card.Body>
          {data.watches.length === 0 && <div className="text-ink-faint text-sm">No watches today.</div>}
          <table className="w-full text-sm">
            <tbody>
              {data.watches.map((w) => (
                <tr key={w.key} className="border-t border-hairline">
                  <td className="py-1">{w.strategy}</td>
                  <td className="py-1">{w.tradingClientId}</td>
                  <td className="py-1 font-mono">{w.watched}</td>
                  <td className="py-1">
                    {w.direction} {w.above ? `≥ ${w.above}` : ''} {w.below ? `≤ ${w.below}` : ''}
                  </td>
                  <td className="py-1 text-right">
                    <Badge bg={w.status === 'LIVE' ? 'info' : tone(w.status)}>{w.status}</Badge>
                    {w.triggeredPrice && <span className="ms-1 font-mono">@ {w.triggeredPrice}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card.Body>
      </Card>
      <Card>
        <Card.Header>Strategy state</Card.Header>
        <Card.Body>
          {data.states.length === 0 && <div className="text-ink-faint text-sm">No evaluations yet today.</div>}
          <table className="w-full text-sm">
            <tbody>
              {data.states.map((s) => (
                <tr key={`${s.tradingClientId}-${s.strategy}`} className="border-t border-hairline">
                  <td className="py-1">{s.strategy}</td>
                  <td className="py-1">{s.tradingClientId}</td>
                  <td className="py-1">
                    signalled {Object.keys(s.signalled).join(', ') || 'none'}
                  </td>
                  <td className="py-1 text-right font-mono">
                    {s.lotsToday} lots · risk {s.usedRisk} · {s.evaluations} evals
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card.Body>
      </Card>
    </div>
  );
};

const FIELDS: [keyof Omit<DayAllocation, 'strategyName'>, string][] = [
  ['monday', 'Monday'],
  ['tuesday', 'Tuesday'],
  ['wednesday', 'Wednesday'],
  ['thursday', 'Thursday'],
  ['friday', 'Friday'],
  ['expiryDay', 'Expiry day'],
  ['dt1Day', 'DT1'],
  ['dt2Day', 'DT2'],
];

export const DayAllocationModal: React.FC<{ strategy: string; onClose: () => void }> = ({ strategy, onClose }) => {
  const current = useQuery({
    queryKey: ['strategies', 'days', strategy],
    queryFn: () => strategyLiveService.dayAllocation(strategy),
  });
  const [values, setValues] = useState<Omit<DayAllocation, 'strategyName'> | null>(null);
  useEffect(() => {
    if (current.data && values === null) {
      const { strategyName: _name, ...rest } = current.data;
      setValues(rest);
    }
  }, [current.data, values]);
  const save = useMutation({
    mutationFn: () => strategyLiveService.saveDayAllocation(strategy, values!),
    onSuccess: () => {
      toast.success(`${strategy}: day allocation saved`);
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <Modal show onHide={onClose}>
      <Modal.Header closeButton>
        <Modal.Title>{strategy}: lots by day</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <p className="text-sm text-ink-faint">
          The share of the strategy's lots to trade, as a percentage. Expiry beats DT1 beats DT2 beats the weekday.
        </p>
        {!values ? (
          <Spinner />
        ) : (
          <Row>
            {FIELDS.map(([key, label]) => (
              <Col md={6} key={key}>
                <Form.Group className="mb-2">
                  <Form.Label className="text-sm">{label} %</Form.Label>
                  <Form.Control
                    type="number"
                    min={0}
                    max={100}
                    value={values[key]}
                    onChange={(e) => setValues({ ...values, [key]: Number(e.target.value) })}
                  />
                </Form.Group>
              </Col>
            ))}
          </Row>
        )}
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!values || save.isPending} onClick={() => save.mutate()}>
          Save
        </Button>
      </Modal.Footer>
    </Modal>
  );
};
