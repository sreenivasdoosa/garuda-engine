/**
 * Recompute Positional Daily-MTM (sysadmin) — rebuild the broker-basis positional report.
 *
 * Marks every carried/open positional trade to close for each in-range trading day, purely from
 * stored TRADES_POSITIONAL + captured DAILY_SYMBOL_CLOSE_PRICES. Dry run previews the totals and the
 * list of missing (symbol, date) closes to backfill — no writes. Apply writes the granular
 * per-trade-day rows + the aggregated EOD_PNL_REPORTS_POSITIONAL for the period.
 */

import { useCallback, useRef, useState } from 'react';
import { Card, Row, Col, Form, Button, Table, Badge, Spinner, Alert, Modal } from '@/components/ui/rbShim';
import AsyncSelect from 'react-select/async';
import type { MultiValue } from 'react-select';
import { BsGraphUp, BsExclamationTriangle } from 'react-icons/bs';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';

import { PageHeader } from '@/components/common';
import { positionalMtmService, userManagementService } from '@/services/admin/v2AdminService';
import { formatIndianNumber } from '@/utils/formatters';

interface UserOption {
  value: string;
  label: string;
}

const formatUserLabel = (u: { username: string; fullName?: string; name?: string }) =>
  `${u.fullName || u.name || u.username} (${u.username})`;

const getDefaultDates = () => {
  const today = new Date();
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { fromDate: '2026-01-01', toDate: fmt(today) };
};

const RecomputePositionalMtmPage: React.FC = () => {

  const queryClient = useQueryClient();
  const defaults = getDefaultDates();
  const [allUsers, setAllUsers] = useState(false);
  const [selectedUsers, setSelectedUsers] = useState<UserOption[]>([]);
  const [fromDate, setFromDate] = useState(defaults.fromDate);
  const [toDate, setToDate] = useState(defaults.toDate);
  const [showApplyConfirm, setShowApplyConfirm] = useState(false);

  const { data: status } = useQuery({
    queryKey: ['admin', 'recompute-positional-mtm', 'status'],
    queryFn: () => positionalMtmService.getStatus(),
    refetchInterval: (query) => (query.state.data?.running ? 2000 : false),
    refetchOnWindowFocus: true,
  });
  const job = status?.job ?? null;
  const running = status?.running ?? false;
  const result = job?.result ?? null;

  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadUserOptions = useCallback((input: string): Promise<UserOption[]> => {
    const trimmed = input.trim();
    if (trimmed.length < 2) return Promise.resolve([]);
    return new Promise<UserOption[]>((resolve) => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      debounceTimer.current = setTimeout(() => {
        userManagementService
          .searchUsers(trimmed, 20)
          .then((users) => resolve(users.map((u) => ({ value: u.username, label: formatUserLabel(u) }))))
          .catch(() => resolve([]));
      }, 300);
    });
  }, []);

  const usernamesForRequest = (): string[] | null =>
    allUsers ? null : selectedUsers.map((u) => u.value);

  const validation = (): string | null => {
    if (!fromDate || !toDate) return 'Select a from and to date.';
    if (toDate < fromDate) return 'To date must be on or after from date.';
    if (!allUsers && selectedUsers.length === 0) return 'Select at least one user, or tick "All users".';
    return null;
  };

  const startMutation = useMutation({
    mutationFn: (dryRun: boolean) =>
      positionalMtmService.recompute({ usernames: usernamesForRequest(), fromDate, toDate, dryRun }),
    onSuccess: (res) => {
      setShowApplyConfirm(false);
      toast.info(res.dryRun ? 'Dry run started — computing…' : 'Apply started — running in the background…');
      queryClient.invalidateQueries({ queryKey: ['admin', 'recompute-positional-mtm', 'status'] });
    },
    onError: (err: Error) => {
      toast.error(err?.message || 'Failed to start recompute');
      queryClient.invalidateQueries({ queryKey: ['admin', 'recompute-positional-mtm', 'status'] });
    },
  });

  const onDryRun = () => {
    const v = validation();
    if (v) { toast.error(v); return; }
    startMutation.mutate(true);
  };
  const onApplyConfirmed = () => startMutation.mutate(false);

  const busy = running || startMutation.isPending;
  const num = (n: number) => formatIndianNumber(n, false);
  const signClass = (n: number) => (n > 0 ? 'text-success-500 dark:text-success-400' : n < 0 ? 'text-danger-600 dark:text-danger-400' : 'text-ink-soft');

  return (
    <div className="fade-in">
      <PageHeader
        title="Recompute Positional Daily-MTM"
        subtitle="Rebuild the broker-basis positional report (each day marked to close) for a date range"
        icon={<BsGraphUp />}
      />

      <Card className="mb-4">
        <Card.Header>Scope</Card.Header>
        <Card.Body>
          <Row className=" items-end">
            <Col md={5}>
              <Form.Label className="text-[0.875em] text-ink-soft mb-1">Users</Form.Label>
              <AsyncSelect<UserOption, true>
                isMulti
                cacheOptions
                loadOptions={loadUserOptions}
                value={selectedUsers}
                onChange={(opts: MultiValue<UserOption>) => setSelectedUsers(opts ? [...opts] : [])}
                isDisabled={allUsers || busy}
                placeholder="Search users…"
                classNamePrefix="react-select"
                noOptionsMessage={({ inputValue }) =>
                  inputValue && inputValue.trim().length >= 2 ? 'No users found' : 'Type 2+ characters to search'}
                styles={{ menu: (base) => ({ ...base, zIndex: 9 }) }}
              />
              <Form.Check
                type="checkbox"
                id="pmtm-all-users"
                className="mt-2"
                label="All users"
                checked={allUsers}
                disabled={busy}
                onChange={(e) => setAllUsers(e.target.checked)}
              />
            </Col>
            <Col md={2}>
              <Form.Label className="text-[0.875em] text-ink-soft mb-1">From date</Form.Label>
              <Form.Control type="date" size="sm" value={fromDate} max={toDate}
                disabled={busy} onChange={(e) => setFromDate(e.target.value)} />
            </Col>
            <Col md={2}>
              <Form.Label className="text-[0.875em] text-ink-soft mb-1">To date</Form.Label>
              <Form.Control type="date" size="sm" value={toDate} min={fromDate}
                disabled={busy} onChange={(e) => setToDate(e.target.value)} />
            </Col>
            <Col md={3} className="flex gap-2">
              <Button variant="outline-primary" onClick={onDryRun} disabled={busy}>
                {running ? <><Spinner size="sm" className="me-2" />Running…</> : 'Dry run'}
              </Button>
              <Button
                variant="danger"
                disabled={busy || !true}
                onClick={() => {
                  const v = validation();
                  if (v) { toast.error(v); return; }
                  setShowApplyConfirm(true);
                }}
              >
                Apply
              </Button>
            </Col>
          </Row>
          <div className="text-[0.875em] text-ink-soft mt-2">
            Marks every <strong>carried/open positional</strong> trade to each in-range trading day&apos;s close (broker
            basis), from stored trades + captured closes. Requires closes backfilled for the range (and the trading day
            just before it) — the dry run lists any missing (symbol, date). Apply writes the positional report; the algo
            EOD report &amp; billing are not touched.
          </div>
        </Card.Body>
      </Card>

      {running && (
        <Alert variant="info" className="flex items-center">
          <Spinner size="sm" className="me-2" />
          {job?.dryRun ? 'Dry run' : 'Apply'} in progress — {result?.usersProcessed ?? 0} user(s),
          {' '}{result?.tradesScanned ?? 0} trades, {result?.sliceDaysComputed ?? 0} day-slices so far… (every 2s)
        </Alert>
      )}
      {job?.state === 'FAILED' && (
        <Alert variant="danger">Recompute failed: {job.error || 'see server logs'}.</Alert>
      )}

      {result && (result.tradesScanned > 0 || job?.state !== 'RUNNING') && (
        <>
          <Card className="mb-4">
            <Card.Header className="flex justify-between items-center">
              <span>Result</span>
              <Badge bg={job?.state === 'RUNNING' ? 'info' : job?.dryRun ? 'secondary' : 'success'}>
                {job?.state === 'RUNNING'
                  ? 'RUNNING…'
                  : job?.dryRun ? 'DRY RUN (no changes written)' : 'APPLIED'}
              </Badge>
            </Card.Header>
            <Card.Body>
              <Row className=" text-center">
                <Col md={2}><div className="text-ink-soft text-[0.875em]">Users</div><div className="text-xl font-medium mb-0">{result.usersProcessed}</div></Col>
                <Col md={2}><div className="text-ink-soft text-[0.875em]">Trades</div><div className="text-xl font-medium mb-0">{result.tradesScanned}</div></Col>
                <Col md={2}><div className="text-ink-soft text-[0.875em]">Day-slices</div><div className="text-xl font-medium mb-0">{result.sliceDaysComputed}</div></Col>
                <Col md={2}><div className="text-ink-soft text-[0.875em]">Report rows</div><div className="text-xl font-medium mb-0">{result.eodRecordsAffected}</div></Col>
                <Col md={2}><div className="text-ink-soft text-[0.875em]">Missing closes</div><div className={`text-xl font-medium mb-0 ${result.missingCloseCount ? 'text-warning-700 dark:text-warning-400' : ''}`}>{result.missingCloseCount}</div></Col>
              </Row>
              <hr />
              <Row className=" text-center">
                <Col md={4}><div className="text-ink-soft text-[0.875em]">Gross P&amp;L (close)</div><div className={`text-xl font-medium mb-0 ${signClass(result.grossTotal)}`}>{num(result.grossTotal)}</div></Col>
                <Col md={4}><div className="text-ink-soft text-[0.875em]">Charges</div><div className="text-xl font-medium mb-0">{num(result.chargesTotal)}</div></Col>
                <Col md={4}><div className="text-ink-soft text-[0.875em]">Net P&amp;L (close)</div><div className={`text-xl font-medium mb-0 ${signClass(result.netTotal)}`}>{num(result.netTotal)}</div></Col>
              </Row>
              <Row className=" text-center mt-1">
                <Col md={4}><div className="text-ink-soft text-[0.875em]">Gross P&amp;L (zero&nbsp;/&nbsp;broker)</div><div className={`text-base font-medium mb-0 ${signClass(result.zeroGrossTotal)}`}>{num(result.zeroGrossTotal)}</div></Col>
                <Col md={4}><div className="text-ink-soft text-[0.875em]">&nbsp;</div><div className="text-base font-medium mb-0 text-ink-soft">— same charges —</div></Col>
                <Col md={4}><div className="text-ink-soft text-[0.875em]">Net P&amp;L (zero&nbsp;/&nbsp;broker)</div><div className={`text-base font-medium mb-0 ${signClass(result.zeroNetTotal)}`}>{num(result.zeroNetTotal)}</div></Col>
              </Row>
            </Card.Body>
          </Card>

          {result.perUser.length > 0 && (
            <Card className="mb-4">
              <Card.Header>Per-user ({result.perUser.length})</Card.Header>
              <div style={{ overflowX: 'auto' }}>
                <Table striped hover responsive className="mb-0 text-[0.875em]">
                  <thead>
                    <tr>
                      <th>User</th>
                      <th className="text-end">Trades</th>
                      <th className="text-end">Day-slices</th>
                      <th className="text-end">Gross (close)</th>
                      <th className="text-end">Net (close)</th>
                      <th className="text-end">Gross (zero)</th>
                      <th className="text-end">Net (zero)</th>
                      <th className="text-end">Charges</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.perUser.map((u) => (
                      <tr key={u.username}>
                        <td className="font-medium">{u.username}</td>
                        <td className="text-end">{u.tradesLive}</td>
                        <td className="text-end">{u.sliceDays}</td>
                        <td className={`text-end ${signClass(u.gross)}`}>{num(u.gross)}</td>
                        <td className={`text-end ${signClass(u.net)}`}>{num(u.net)}</td>
                        <td className={`text-end ${signClass(u.zeroGross)}`}>{num(u.zeroGross)}</td>
                        <td className={`text-end ${signClass(u.zeroNet)}`}>{num(u.zeroNet)}</td>
                        <td className="text-end">{num(u.charges)}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            </Card>
          )}

          {result.missingCloses.length > 0 && (
            <Card className="mb-4 border-warning-500">
              <Card.Header className="text-warning-700 dark:text-warning-400">
                <BsExclamationTriangle className="me-2" />
                Missing closes — backfill then re-run ({result.missingCloseCount})
              </Card.Header>
              <Card.Body>
                <div className="text-[0.875em] text-ink-soft mb-2">
                  These (symbol @ date) had no captured close, so their day-slice used 0 and is understated. Backfill the
                  close into <code>DAILY_SYMBOL_CLOSE_PRICES</code> (incl. the trading day just before the range start) and
                  re-run. Showing {result.missingCloses.length}{result.missingCloseCount > result.missingCloses.length ? ` of ${result.missingCloseCount}` : ''}.
                </div>
                <div className="flex flex-wrap gap-1">
                  {result.missingCloses.map((m, i) => (
                    <Badge key={i} bg="light" text="dark"><code>{m}</code></Badge>
                  ))}
                </div>
              </Card.Body>
            </Card>
          )}
        </>
      )}

      <Modal show={showApplyConfirm} onHide={() => setShowApplyConfirm(false)} centered>
        <Modal.Header closeButton>
          <Modal.Title className="text-danger-600 dark:text-danger-400"><BsGraphUp className="me-2" />Apply positional MTM recompute</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Alert variant="warning" className="mb-2">
            This writes the positional daily-MTM rows ({fromDate} → {toDate}) — granular per-trade-day + the aggregated
            EOD_PNL_REPORTS_POSITIONAL. Idempotent (re-runnable). The algo EOD report &amp; billing are not touched.
          </Alert>
          {result?.dryRun ? (
            <div className="text-[0.875em]">
              Last dry run: <strong>{result.sliceDaysComputed}</strong> day-slices across <strong>{result.usersProcessed}</strong> user(s),
              net <strong>{num(result.netTotal)}</strong>
              {result.missingCloseCount > 0 && <>, <span className="text-warning-700 dark:text-warning-400">{result.missingCloseCount} missing close(s)</span></>}.
            </div>
          ) : (
            <div className="text-[0.875em] text-ink-soft">Tip: run a dry run first to preview + catch missing closes.</div>
          )}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={() => setShowApplyConfirm(false)} disabled={busy}>Cancel</Button>
          <Button variant="danger" onClick={onApplyConfirmed} disabled={busy}>
            {busy ? <><Spinner size="sm" className="me-2" />Applying…</> : 'Apply changes'}
          </Button>
        </Modal.Footer>
      </Modal>
    </div>
  );
};

export default RecomputePositionalMtmPage;
