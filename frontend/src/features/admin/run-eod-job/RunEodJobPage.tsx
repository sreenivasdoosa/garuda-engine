/**
 * Run EOD Job (sysadmin) — manually trigger, per exchange, the exact post-market EOD sequence the auto
 * worker runs: force-complete expired options → external P&L → dump trades → algo EOD P&L → positional
 * daily-MTM slicing → daily emails.
 *
 * Two gates enforced by the server: it is only allowed once past the exchange's CONFIGURED post-market
 * report time (e.g. NSE/BSE 15:45), and only one run at a time per exchange. Re-runs after completion
 * are allowed (every step is idempotent).
 */

import { useEffect, useState } from 'react';
import { Card, Row, Col, Form, Button, Table, Badge, Spinner, Alert } from '@/components/ui/rbShim';
import { BsPlayCircle } from 'react-icons/bs';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';

import { PageHeader } from '@/components/common';
import { usePermissions } from '@/hooks/usePermissions';
import { eodJobRunService } from '@/services/admin/v2AdminService';

const extractError = (err: unknown): string => {
  const e = err as { response?: { data?: { error?: { message?: string }; message?: string } }; message?: string };
  return e?.response?.data?.error?.message || e?.response?.data?.message || e?.message || 'Request failed';
};

const RunEodJobPage: React.FC = () => {
  const permissions = usePermissions();
  const canManage = permissions.systemConfig.canManage;
  const queryClient = useQueryClient();

  const [exchange, setExchange] = useState<string>('');

  // Active exchanges + each one's configured EOD time + eligible-now flag.
  const { data: exchanges = [] } = useQuery({
    queryKey: ['admin', 'run-eod-job', 'exchanges'],
    queryFn: () => eodJobRunService.getExchanges(),
    refetchInterval: 30000,
    refetchOnWindowFocus: true,
  });

  // Auto-select the first exchange once loaded.
  useEffect(() => {
    if (!exchange && exchanges.length > 0) {
      setExchange(exchanges[0].exchange);
    }
  }, [exchange, exchanges]);

  const selected = exchanges.find((e) => e.exchange === exchange) ?? null;

  // Poll the selected exchange's job status (fast while running).
  const { data: status } = useQuery({
    queryKey: ['admin', 'run-eod-job', 'status', exchange],
    queryFn: () => eodJobRunService.getStatus(exchange),
    enabled: !!exchange,
    refetchInterval: (query) => (query.state.data?.running ? 2000 : false),
    refetchOnWindowFocus: true,
  });
  const job = status?.job ?? null;
  const running = status?.running ?? false;
  const result = job?.result ?? null;

  const runMutation = useMutation({
    mutationFn: (ex: string) => eodJobRunService.run(ex),
    onSuccess: (res) => {
      toast.success(res.message || `EOD run started for ${res.exchange}`);
      queryClient.invalidateQueries({ queryKey: ['admin', 'run-eod-job'] });
    },
    onError: (err) => toast.error(extractError(err)),
  });

  const canRunNow = canManage && !!selected && selected.eligible && !running && !runMutation.isPending;

  return (
    <div>
      <PageHeader
        title="Run EOD Job"
        subtitle="Manually run today's post-market EOD job for an exchange (same sequence as the automatic run)"
      />

      <Card className="mb-4">
        <Card.Body>
          <Row className="items-end ">
            <Col md={4}>
              <Form.Label>Exchange</Form.Label>
              <Form.Select
                value={exchange}
                onChange={(e) => setExchange(e.target.value)}
                disabled={exchanges.length === 0}
              >
                {exchanges.map((e) => (
                  <option key={e.exchange} value={e.exchange}>
                    {e.exchange} — EOD at {e.reportTime}
                    {e.running ? ' (running…)' : e.eligible ? ' (ready)' : ' (not yet)'}
                  </option>
                ))}
              </Form.Select>
            </Col>
            <Col md={4}>
              <Button
                variant="primary"
                disabled={!canRunNow}
                onClick={() => runMutation.mutate(exchange)}
              >
                {runMutation.isPending ? (
                  <><Spinner size="sm" animation="border" className="me-2" />Starting…</>
                ) : (
                  <><BsPlayCircle className="me-2" />Run EOD now</>
                )}
              </Button>
            </Col>
          </Row>

          {selected && !selected.eligible && selected.reason && (
            <Alert variant="warning" className="mt-4 mb-0">
              {selected.reason}
            </Alert>
          )}
          {!canManage && (
            <Alert variant="secondary" className="mt-4 mb-0">
              You need system-config manage permission to run EOD jobs.
            </Alert>
          )}
        </Card.Body>
      </Card>

      {running && (
        <Alert variant="info">
          <Spinner size="sm" animation="border" className="me-2" />
          EOD run in progress for {job?.exchange}…
        </Alert>
      )}

      {job && (
        <Card>
          <Card.Header className="flex justify-between items-center">
            <span>Last run — {job.exchange} ({job.dateStr})</span>
            <Badge bg={job.state === 'COMPLETED' ? 'success' : job.state === 'FAILED' ? 'danger' : 'secondary'}>
              {job.state}
            </Badge>
          </Card.Header>
          <Card.Body>
            {job.error && <Alert variant="danger">{job.error}</Alert>}
            {result ? (
              <Table size="sm" bordered hover responsive className="mb-0">
                <thead>
                  <tr>
                    <th>Step</th>
                    <th>Result</th>
                    <th className="text-end">Time (ms)</th>
                    <th>Error</th>
                  </tr>
                </thead>
                <tbody>
                  {result.steps.map((s) => (
                    <tr key={s.step}>
                      <td>{s.step}</td>
                      <td>
                        <Badge bg={s.ok ? 'success' : 'danger'}>{s.ok ? 'OK' : 'FAILED'}</Badge>
                      </td>
                      <td className="text-end">{s.millis}</td>
                      <td className="text-danger-600 dark:text-danger-400 text-[0.875em]">{s.error ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            ) : (
              !job.error && <span className="text-ink-soft">No step details.</span>
            )}
          </Card.Body>
        </Card>
      )}
    </div>
  );
};

export default RunEodJobPage;
