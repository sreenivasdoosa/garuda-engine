/**
 * Recompute Trade Charges (sysadmin) — corrects historical brokerage after a plan mis-config.
 *
 * Recomputes brokerage → GST → total charges → net P&L for COMPLETED intraday & positional trades
 * in a date range, using each user-broker's currently-assigned plan and the lot size stored on the
 * trade. Dry run previews current-vs-new (and the EOD-report impact) with no writes; Apply persists
 * the trades and regenerates the EOD P&L reports for the period (billing is NOT touched).
 */

import { useCallback, useRef, useState } from 'react';
import { Card, Row, Col, Form, Button, Table, Badge, Spinner, Alert, Modal } from '@/components/ui/rbShim';
import AsyncSelect from 'react-select/async';
import type { MultiValue } from 'react-select';
import { BsReceipt, BsExclamationTriangle } from 'react-icons/bs';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';

import { PageHeader } from '@/components/common';
import {
  tradeService,
  userManagementService,
} from '@/services/admin/v2AdminService';
import { formatIndianNumber } from '@/utils/formatters';

interface UserOption {
  value: string;
  label: string;
}

const formatUserLabel = (u: { username: string; fullName?: string; name?: string }) =>
  `${u.fullName || u.name || u.username} (${u.username})`;

const getDefaultDates = () => {
  // Default window: the correction period (calendar 2026 to date).
  const today = new Date();
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { fromDate: '2026-01-01', toDate: fmt(today) };
};

const RecomputeChargesPage: React.FC = () => {

  const queryClient = useQueryClient();
  const defaults = getDefaultDates();
  const [allUsers, setAllUsers] = useState(false);
  const [selectedUsers, setSelectedUsers] = useState<UserOption[]>([]);
  const [fromDate, setFromDate] = useState(defaults.fromDate);
  const [toDate, setToDate] = useState(defaults.toDate);

  const [showApplyConfirm, setShowApplyConfirm] = useState(false);

  // The recompute runs in the background (one job at a time). Poll the job status; the result
  // updates live while RUNNING and is final on COMPLETED. Auto-picks up a job already in progress.
  const { data: status } = useQuery({
    queryKey: ['admin', 'recompute-charges', 'status'],
    queryFn: () => tradeService.getRecomputeStatus(),
    refetchInterval: (query) => (query.state.data?.running ? 2000 : false),
    refetchOnWindowFocus: true,
  });
  const job = status?.job ?? null;
  const running = status?.running ?? false;
  const result = job?.result ?? null;

  // Remote user search for the multi-select (the user list is far too large to preload).
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
      tradeService.recomputeCharges({ usernames: usernamesForRequest(), fromDate, toDate, dryRun }),
    onSuccess: (res) => {
      setShowApplyConfirm(false);
      toast.info(res.dryRun ? 'Dry run started — computing…' : 'Apply started — running in the background…');
      queryClient.invalidateQueries({ queryKey: ['admin', 'recompute-charges', 'status'] });
    },
    onError: (err: Error) => {
      // Backend returns 409 with an "already running" message when a job is in progress.
      toast.error(err?.message || 'Failed to start recompute');
      queryClient.invalidateQueries({ queryKey: ['admin', 'recompute-charges', 'status'] });
    },
  });

  const onDryRun = () => {
    const v = validation();
    if (v) { toast.error(v); return; }
    startMutation.mutate(true);
  };
  const onApplyConfirmed = () => startMutation.mutate(false);

  // Busy = a job is running (server) or a start request is in flight.
  const busy = running || startMutation.isPending;
  const num = (n: number) => formatIndianNumber(n, false);
  const delta = (oldV: number, newV: number) => newV - oldV;
  const signClass = (n: number) => (n > 0 ? 'text-success-500 dark:text-success-400' : n < 0 ? 'text-danger-600 dark:text-danger-400' : 'text-ink-soft');

  return (
    <div className="fade-in">
      <PageHeader
        title="Recompute Trade Charges"
        subtitle="Recalculate brokerage, GST, charges & net P&L for completed intraday/positional trades"
        icon={<BsReceipt />}
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
                id="recompute-all-users"
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
            Uses each user-broker's <strong>currently-assigned</strong> brokerage plan and the lot size stored on the
            trade. Only <strong>completed</strong> intraday &amp; positional trades are recomputed; P&amp;L is unchanged
            (only charges &amp; net P&amp;L). Apply also regenerates the EOD P&amp;L reports for the period — billing is not touched.
          </div>
        </Card.Body>
      </Card>

      {running && (
        <Alert variant="info" className="flex items-center">
          <Spinner size="sm" className="me-2" />
          {job?.dryRun ? 'Dry run' : 'Apply'} in progress — {result?.usersProcessed ?? 0} user(s) processed,
          {' '}{result?.tradesScanned ?? 0} scanned, {result?.tradesChanged ?? 0} changed so far… (updates every 2s)
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
                <Col md={2}><div className="text-ink-soft text-[0.875em]">Trades scanned</div><div className="text-xl font-medium mb-0">{result.tradesScanned}</div></Col>
                <Col md={2}><div className="text-ink-soft text-[0.875em]">Trades changed</div><div className="text-xl font-medium mb-0">{result.tradesChanged}</div></Col>
                <Col md={2}><div className="text-ink-soft text-[0.875em]">EOD records affected</div><div className="text-xl font-medium mb-0">{result.eodRecordsAffected}</div></Col>
                <Col md={2}><div className="text-ink-soft text-[0.875em]">Lot size missing</div><div className={`text-xl font-medium mb-0 ${result.lotSizeMissingCount ? 'text-warning-700 dark:text-warning-400' : ''}`}>{result.lotSizeMissingCount}</div></Col>
                <Col md={2}><div className="text-ink-soft text-[0.875em]">Fractional lots</div><div className={`text-xl font-medium mb-0 ${result.fractionalLotCount ? 'text-warning-700 dark:text-warning-400' : ''}`}>{result.fractionalLotCount}</div></Col>
              </Row>
              <hr />
              <Row className="">
                <Col md={4}>
                  <div className="text-ink-soft text-[0.875em]">Charges (brokerage-driven)</div>
                  <div>Current: <strong>{num(result.oldChargesTotal)}</strong> → New: <strong>{num(result.newChargesTotal)}</strong></div>
                  <div className={signClass(delta(result.oldChargesTotal, result.newChargesTotal))}>
                    Δ {num(delta(result.oldChargesTotal, result.newChargesTotal))}
                  </div>
                </Col>
                <Col md={4}>
                  <div className="text-ink-soft text-[0.875em]">of which Brokerage / GST</div>
                  <div>Brokerage: {num(result.oldBrokerageTotal)} → {num(result.newBrokerageTotal)}</div>
                  <div>GST: {num(result.oldGstTotal)} → {num(result.newGstTotal)}</div>
                </Col>
                <Col md={4}>
                  <div className="text-ink-soft text-[0.875em]">Net P&amp;L</div>
                  <div>Current: <strong>{num(result.oldNetPnlTotal)}</strong> → New: <strong>{num(result.newNetPnlTotal)}</strong></div>
                  <div className={signClass(delta(result.oldNetPnlTotal, result.newNetPnlTotal))}>
                    Δ {num(delta(result.oldNetPnlTotal, result.newNetPnlTotal))}
                  </div>
                </Col>
              </Row>
            </Card.Body>
          </Card>

          {result.perUser.length > 0 && (
            <Card className="mb-4">
              <Card.Header>Per-user changes ({result.perUser.length})</Card.Header>
              <div style={{ overflowX: 'auto' }}>
                <Table striped hover responsive className="mb-0 text-[0.875em]">
                  <thead>
                    <tr>
                      <th>User</th>
                      <th className="text-end">Trades changed</th>
                      <th className="text-end">Charges (cur → new)</th>
                      <th className="text-end">Δ Charges</th>
                      <th className="text-end">Net P&amp;L (cur → new)</th>
                      <th className="text-end">Δ Net P&amp;L</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.perUser.map((u) => (
                      <tr key={u.username}>
                        <td className="font-medium">{u.username}</td>
                        <td className="text-end">{u.tradesChanged}</td>
                        <td className="text-end">{num(u.oldCharges)} → {num(u.newCharges)}</td>
                        <td className={`text-end ${signClass(delta(u.oldCharges, u.newCharges))}`}>{num(delta(u.oldCharges, u.newCharges))}</td>
                        <td className="text-end">{num(u.oldNetPnl)} → {num(u.newNetPnl)}</td>
                        <td className={`text-end ${signClass(delta(u.oldNetPnl, u.newNetPnl))}`}>{num(delta(u.oldNetPnl, u.newNetPnl))}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            </Card>
          )}

          {result.flags.length > 0 && (
            <Card className="mb-4 border-warning-500">
              <Card.Header className="text-warning-700 dark:text-warning-400">
                <BsExclamationTriangle className="me-2" />
                Skipped — needs attention ({result.flags.length})
              </Card.Header>
              <Card.Body className="pb-0">
                <div className="text-[0.875em] text-ink-soft mb-2">
                  These trades were <strong>not</strong> recomputed. <em>Lot size missing</em> = no lot size on the trade;
                  <em> fractional lots</em> = filled qty isn&apos;t a whole multiple of the lot size (e.g. a lot-size-transition
                  contract). Fix the underlying data, then re-run.
                </div>
              </Card.Body>
              <div style={{ overflowX: 'auto' }}>
                <Table striped responsive className="mb-0 text-[0.875em]">
                  <thead>
                    <tr>
                      <th>User</th><th>Broker</th><th>Symbol</th><th>Product</th><th>Date</th>
                      <th className="text-end">Filled qty</th><th className="text-end">Lot size</th><th>Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.flags.slice(0, 200).map((f, i) => (
                      <tr key={i}>
                        <td>{f.username}</td>
                        <td><Badge bg="light" text="dark">{f.broker}</Badge></td>
                        <td><code>{f.tradingSymbol}</code></td>
                        <td>{f.product}</td>
                        <td>{f.date}</td>
                        <td className="text-end">{f.filledQuantity}</td>
                        <td className="text-end">{f.quantityPerLot}</td>
                        <td>
                          <Badge bg="warning" text="dark">
                            {f.reason === 'LOT_SIZE_MISSING' ? 'Lot size missing' : 'Fractional lots'}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </div>
              {result.flags.length > 200 && (
                <Card.Body className="pt-2 text-[0.875em] text-ink-soft">Showing first 200 of {result.flags.length} flagged trades.</Card.Body>
              )}
            </Card>
          )}
        </>
      )}

      {/* Apply confirmation */}
      <Modal show={showApplyConfirm} onHide={() => setShowApplyConfirm(false)} centered>
        <Modal.Header closeButton>
          <Modal.Title className="text-danger-600 dark:text-danger-400"><BsReceipt className="me-2" />Apply recomputed charges</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Alert variant="warning" className="mb-2">
            This <strong>updates the trade rows</strong> ({fromDate} → {toDate}) and regenerates the EOD P&amp;L reports for
            the period. It rewrites historical charges &amp; net P&amp;L. Billing is not changed.
          </Alert>
          {result?.dryRun ? (
            <div className="text-[0.875em]">
              Last dry run: <strong>{result.tradesChanged}</strong> trade(s) across <strong>{result.usersProcessed}</strong> user(s),
              Δ charges <strong>{num(result.eodChargesDelta)}</strong>.
            </div>
          ) : (
            <div className="text-[0.875em] text-ink-soft">Tip: run a dry run first to preview the impact.</div>
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

export default RecomputeChargesPage;
