/**
 * Trading Clients.
 *
 * The broker accounts orders are routed to: the operator's own and their
 * family's. One row per account -- a display name, a broker, the broker's
 * own id for it -- and whether it can trade right now, which is one question
 * with two halves: is it enabled, and is it logged in.
 *
 * **Nothing logs in by itself.** Every login starts here, with a button, and
 * goes through the vendor's own page. A session that expires shows as logged
 * out until the operator logs in again; the engine never guesses.
 *
 * An account may log in through another one -- a dealer terminal issues one
 * session for several client ids -- and such an account has no Login button,
 * because it has nothing to log in to.
 */

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'react-toastify';
import {
  Alert,
  Badge,
  Button,
  Card,
  Col,
  Form,
  InputGroup,
  Modal,
  Row,
  Spinner,
} from '@/components/ui/rbShim';
import {
  BsBoxArrowUpRight,
  BsCheck2,
  BsCheckCircleFill,
  BsClipboard,
  BsPencil,
  BsPersonBadge,
  BsPlus,
  BsTrash,
  BsXCircleFill,
} from 'react-icons/bs';
import { ConfirmModal, PageHeader } from '@/components/common';
import { tradingClientService } from '@/services/admin/tradingClientService';
import type { TradingClient, TradingClientEdit } from '@/types/trading-client';

/** Brokers an account can be registered against, in the order they are offered. */
const BROKERS: { code: string; label: string; note: string }[] = [
  { code: 'ZERODHA', label: 'Zerodha', note: 'Kite Connect. Login is built.' },
  { code: 'FYERS', label: 'Fyers', note: 'API v3. Login is built; trading is not yet.' },
  { code: 'DHAN', label: 'Dhan', note: 'Login is built; trading is not yet.' },
  { code: 'KOTAK', label: 'Kotak Neo', note: 'Neither login nor trading is built yet.' },
];

const when = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString('en-IN', {
        hour12: false,
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';

const emptyForm = (): TradingClientEdit => ({
  displayName: '',
  broker: 'ZERODHA',
  clientId: '',
  enabled: true,
  apiKey: '',
  staticIp: '',
  isPro: false,
  useDealerApis: null,
  websocketEnabled: true,
  usesCredentialsOf: null,
  isMarketDataSource: false,
});

const TradingClientsPage: React.FC = () => {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [editing, setEditing] = useState<TradingClient | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<TradingClientEdit>(emptyForm());
  const [secret, setSecret] = useState('');
  const [copied, setCopied] = useState(false);
  const [deleting, setDeleting] = useState<TradingClient | null>(null);
  const [loggingOut, setLoggingOut] = useState<TradingClient | null>(null);

  const { data: clients, isLoading, error } = useQuery({
    queryKey: ['trading-clients'],
    queryFn: () => tradingClientService.getAll(),
    // A session can expire under the page; the badge should follow.
    refetchInterval: 15000,
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['trading-clients'] });
    // A provider may borrow this account's session; its page shows it too.
    queryClient.invalidateQueries({ queryKey: ['data-providers'] });
  };

  // The callback lands on the API, which redirects back here saying what
  // happened. Read it once, then take it out of the URL so a refresh does
  // not repeat the message.
  useEffect(() => {
    const broker = searchParams.get('login');
    if (!broker) return;
    const failed = searchParams.get('error');
    if (failed) toast.error(`${broker}: ${failed}`);
    else if (searchParams.get('ok')) toast.success(`${broker} logged in`);
    refresh();
    setSearchParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const save = useMutation({
    mutationFn: ({ id, data }: { id: string | null; data: TradingClientEdit }) =>
      id ? tradingClientService.update(id, data) : tradingClientService.create(data),
    onSuccess: (saved) => {
      toast.success(`${saved.displayName} saved`);
      setEditing(null);
      setCreating(false);
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => tradingClientService.remove(id),
    onSuccess: () => {
      toast.success('Removed');
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
    onSettled: () => setDeleting(null),
  });

  const login = useMutation({
    mutationFn: (id: string) => tradingClientService.login(id),
    onSuccess: (started) => {
      // The vendor's page, in this tab: it redirects back to the callback,
      // which redirects here. A popup would be blocked as often as not.
      window.location.href = started.url;
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const logout = useMutation({
    mutationFn: (id: string) => tradingClientService.logout(id),
    onSuccess: (client) => {
      toast.success(`${client.displayName} logged out`);
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
    onSettled: () => setLoggingOut(null),
  });

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      tradingClientService.update(id, { enabled }),
    onSuccess: (client) =>
      toast.success(`${client.displayName} ${client.enabled ? 'enabled' : 'disabled'}`),
    onError: (e: Error) => toast.error(e.message),
    onSettled: refresh,
  });

  const openCreate = () => {
    setEditing(null);
    setForm(emptyForm());
    setSecret('');
    setCreating(true);
  };

  const openEdit = (client: TradingClient) => {
    setCreating(false);
    setEditing(client);
    setSecret('');
    setForm({
      displayName: client.displayName,
      broker: client.broker,
      clientId: client.clientId,
      enabled: client.enabled,
      apiKey: client.apiKey ?? '',
      staticIp: client.staticIp ?? '',
      isPro: client.isPro,
      useDealerApis: client.useDealerApis,
      websocketEnabled: client.websocketEnabled,
      usesCredentialsOf: client.usesCredentialsOf,
      isMarketDataSource: client.isMarketDataSource,
    });
  };

  const submit = () => {
    const data: TradingClientEdit = { ...form };
    if (secret) data.apiSecret = secret;
    save.mutate({ id: editing?.id ?? null, data });
  };

  // Where the vendor sends the browser back. Shown once the account exists,
  // because the id is part of it and the id is issued on creation.
  const callbackUrl = editing ? `${window.location.origin}${editing.callbackPath}` : '';
  const copyCallback = async () => {
    try {
      await navigator.clipboard.writeText(callbackUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Could not copy — select the URL and copy it by hand.');
    }
  };

  // Accounts this one could log in through: same broker, and ones that log
  // in themselves rather than through a third.
  const holders = (clients ?? []).filter(
    (c) => c.broker === form.broker && c.id !== editing?.id && !c.usesCredentialsOf,
  );

  const showForm = creating || editing !== null;
  const ridesOnAnother = Boolean(form.usesCredentialsOf);

  return (
    <div className="fade-in">
      <PageHeader
        title="Trading Clients"
        subtitle="The broker accounts orders go to — and who is logged in"
        icon={<BsPersonBadge size={24} />}
      />

      <Card>
        <Card.Header className="flex items-center justify-between">
          <h5 className="mb-0">Accounts</h5>
          <Button variant="primary" size="sm" onClick={openCreate}>
            <BsPlus className="me-1" />
            Add account
          </Button>
        </Card.Header>
        <Card.Body>
          {isLoading && (
            <div className="py-5 text-center">
              <Spinner />
            </div>
          )}
          {error && (
            <Alert variant="danger" className="mb-0">
              {(error as Error).message}
            </Alert>
          )}
          {clients && clients.length === 0 && (
            <Alert variant="info" className="mb-0">
              No account yet. Add one, then log it in. A strategy runs paper or live per
              subscription, so even paper trading needs an account to price against.
            </Alert>
          )}
          {clients && clients.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-ink-faint text-xs uppercase">
                  <tr>
                    <th className="py-1 text-left">Account</th>
                    <th className="py-1 text-left">Broker</th>
                    <th className="py-1 text-left">Session</th>
                    <th className="py-1 text-left">Since</th>
                    <th className="py-1 text-left">Flags</th>
                    <th className="py-1 text-right" />
                  </tr>
                </thead>
                <tbody>
                  {clients.map((client) => (
                    <tr key={client.id} className="border-t border-hairline align-top">
                      <td className="py-2 pr-3">
                        <div className="font-semibold">{client.displayName}</div>
                        <div className="text-ink-faint font-mono text-xs">{client.id}</div>
                      </td>
                      <td className="py-2 pr-3">
                        <span className="uppercase">{client.broker}</span>
                        <div className="font-mono text-xs">{client.clientId}</div>
                        {client.usesCredentialsOf && (
                          <div className="text-ink-faint text-xs">
                            logs in through {client.usesCredentialsOf}
                          </div>
                        )}
                      </td>
                      <td className="py-2 pr-3">
                        {client.isLoggedIn ? (
                          <Badge bg="success">
                            <BsCheckCircleFill className="me-1" />
                            Logged in
                          </Badge>
                        ) : client.usesCredentialsOf ? (
                          <Badge bg="secondary">Via {client.usesCredentialsOf}</Badge>
                        ) : (
                          <Badge bg="secondary">
                            <BsXCircleFill className="me-1" />
                            Logged out
                          </Badge>
                        )}
                        {client.loginError && (
                          <div className="text-danger mt-1 text-xs">{client.loginError}</div>
                        )}
                        {client.passwordExpiryDays !== null && client.passwordExpiryDays <= 7 && (
                          <div className="text-warning-600 mt-1 text-xs">
                            password expires in {client.passwordExpiryDays} day(s)
                          </div>
                        )}
                      </td>
                      <td className="py-2 pr-3 font-mono text-xs">{when(client.sessionCreatedOn)}</td>
                      <td className="py-2 pr-3">
                        <div className="flex flex-wrap gap-1">
                          {!client.enabled && <Badge bg="secondary">Disabled</Badge>}
                          {client.isMarketDataSource && <Badge bg="info">Market data</Badge>}
                          {client.isPro && <Badge bg="secondary">Pro</Badge>}
                          {client.useDealerApis === true && <Badge bg="secondary">Dealer</Badge>}
                          {!client.websocketEnabled && <Badge bg="secondary">Polling</Badge>}
                          {client.staticIp && <Badge bg="secondary">via {client.staticIp}</Badge>}
                        </div>
                      </td>
                      <td className="py-2 text-right">
                        <div className="flex flex-wrap justify-end gap-1">
                          {client.canLogin && (
                            <Button
                              variant="primary"
                              size="sm"
                              disabled={login.isPending}
                              onClick={() => login.mutate(client.id)}
                            >
                              <BsBoxArrowUpRight className="me-1" />
                              {client.isLoggedIn ? 'Log in again' : 'Log in'}
                            </Button>
                          )}
                          {client.isLoggedIn && !client.usesCredentialsOf && (
                            <Button
                              variant="outline-danger"
                              size="sm"
                              onClick={() => setLoggingOut(client)}
                            >
                              Log out
                            </Button>
                          )}
                          <Button
                            variant="outline-secondary"
                            size="sm"
                            onClick={() => toggle.mutate({ id: client.id, enabled: !client.enabled })}
                          >
                            {client.enabled ? 'Disable' : 'Enable'}
                          </Button>
                          <Button variant="outline-primary" size="sm" onClick={() => openEdit(client)}>
                            <BsPencil />
                          </Button>
                          <Button
                            variant="outline-danger"
                            size="sm"
                            onClick={() => setDeleting(client)}
                          >
                            <BsTrash />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card.Body>
      </Card>

      <Modal
        show={showForm}
        onHide={() => {
          setEditing(null);
          setCreating(false);
        }}
        size="lg"
        backdrop="static"
      >
        <Modal.Header closeButton>
          <Modal.Title>{editing ? editing.displayName : 'New account'}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Form>
            <Row>
              <Col md={6}>
                <Form.Group className="mb-3">
                  <Form.Label>Display name</Form.Label>
                  <Form.Control
                    value={form.displayName ?? ''}
                    onChange={(e) => setForm({ ...form, displayName: e.target.value })}
                    placeholder="Appa"
                  />
                  <small className="text-ink-faint">
                    What every alert and log line calls it. The id is made from it once and never
                    changes.
                  </small>
                </Form.Group>
              </Col>
              <Col md={6}>
                <Form.Group className="mb-3">
                  <Form.Label>Broker</Form.Label>
                  <Form.Select
                    value={form.broker ?? 'ZERODHA'}
                    onChange={(e) =>
                      setForm({ ...form, broker: e.target.value, usesCredentialsOf: null })
                    }
                  >
                    {BROKERS.map((b) => (
                      <option key={b.code} value={b.code}>
                        {b.label}
                      </option>
                    ))}
                  </Form.Select>
                  <small className="text-ink-faint">
                    {BROKERS.find((b) => b.code === form.broker)?.note}
                  </small>
                </Form.Group>
              </Col>
            </Row>
            <Row>
              <Col md={6}>
                <Form.Group className="mb-3">
                  <Form.Label>Client id</Form.Label>
                  <Form.Control
                    value={form.clientId ?? ''}
                    onChange={(e) => setForm({ ...form, clientId: e.target.value })}
                    placeholder="AB1234"
                  />
                  <small className="text-ink-faint">
                    The broker’s own id. Checked against whoever the vendor says logged in, so a
                    session for another account is refused rather than used.
                  </small>
                </Form.Group>
              </Col>
              <Col md={6}>
                <Form.Group className="mb-3">
                  <Form.Label>Logs in through</Form.Label>
                  <Form.Select
                    value={form.usesCredentialsOf ?? ''}
                    onChange={(e) =>
                      setForm({ ...form, usesCredentialsOf: e.target.value || null })
                    }
                  >
                    <option value="">Itself</option>
                    {holders.map((h) => (
                      <option key={h.id} value={h.id}>
                        {h.displayName} ({h.clientId})
                      </option>
                    ))}
                  </Form.Select>
                  <small className="text-ink-faint">
                    For a dealer terminal, where one login covers several client ids.
                  </small>
                </Form.Group>
              </Col>
            </Row>

            {!ridesOnAnother && (
              <Row>
                <Col md={6}>
                  <Form.Group className="mb-3">
                    <Form.Label>API key</Form.Label>
                    <Form.Control
                      value={form.apiKey ?? ''}
                      onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
                      placeholder="App key"
                    />
                  </Form.Group>
                </Col>
                <Col md={6}>
                  <Form.Group className="mb-3">
                    <Form.Label>
                      API secret{' '}
                      {editing?.hasApiSecret && (
                        <small className="text-ink-faint">(stored — leave blank to keep)</small>
                      )}
                    </Form.Label>
                    <Form.Control
                      type="password"
                      value={secret}
                      onChange={(e) => setSecret(e.target.value)}
                      placeholder="App secret"
                    />
                  </Form.Group>
                </Col>
              </Row>
            )}

            {editing && !ridesOnAnother && editing.loginStyle === 'REDIRECT' && (
              <Form.Group className="mb-3">
                <Form.Label>Redirect URL</Form.Label>
                <InputGroup>
                  <Form.Control readOnly value={callbackUrl} className="font-mono" />
                  <Button
                    variant="outline-secondary"
                    onClick={copyCallback}
                    title={copied ? 'Copied' : 'Copy to clipboard'}
                    aria-label="Copy the redirect URL"
                  >
                    {copied ? <BsCheck2 /> : <BsClipboard />}
                  </Button>
                </InputGroup>
                <small className="text-ink-faint">
                  Register this exactly in the vendor’s console. A provider that borrows this
                  account’s credentials logs in through the same URL.
                </small>
              </Form.Group>
            )}

            <Row>
              <Col md={6}>
                <Form.Group className="mb-3">
                  <Form.Label>Whitelisted address</Form.Label>
                  <Form.Control
                    value={form.staticIp ?? ''}
                    onChange={(e) => setForm({ ...form, staticIp: e.target.value })}
                    placeholder="Leave blank to go direct"
                  />
                  <small className="text-ink-faint">
                    The source address the broker whitelisted for this account’s trading APIs.
                    Login works from anywhere; orders do not.
                  </small>
                </Form.Group>
              </Col>
              <Col md={6}>
                <Form.Group className="mb-3">
                  <Form.Label>Dealer APIs</Form.Label>
                  <Form.Select
                    value={
                      form.useDealerApis === null || form.useDealerApis === undefined
                        ? ''
                        : form.useDealerApis
                          ? 'yes'
                          : 'no'
                    }
                    onChange={(e) =>
                      setForm({
                        ...form,
                        useDealerApis: e.target.value === '' ? null : e.target.value === 'yes',
                      })
                    }
                  >
                    <option value="">Inherit the broker’s setting</option>
                    <option value="yes">Yes</option>
                    <option value="no">No</option>
                  </Form.Select>
                </Form.Group>
              </Col>
            </Row>

            <Row>
              <Col md={3}>
                <Form.Check
                  type="switch"
                  label="Enabled"
                  checked={form.enabled ?? true}
                  onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
                  className="mb-3"
                />
              </Col>
              <Col md={3}>
                <Form.Check
                  type="switch"
                  label="Pro account"
                  checked={form.isPro ?? false}
                  onChange={(e) => setForm({ ...form, isPro: e.target.checked })}
                  className="mb-3"
                />
              </Col>
              <Col md={3}>
                <Form.Check
                  type="switch"
                  label="Order updates over socket"
                  checked={form.websocketEnabled ?? true}
                  onChange={(e) => setForm({ ...form, websocketEnabled: e.target.checked })}
                  className="mb-3"
                />
              </Col>
              <Col md={3}>
                <Form.Check
                  type="switch"
                  label="Market data source"
                  checked={form.isMarketDataSource ?? false}
                  onChange={(e) => setForm({ ...form, isMarketDataSource: e.target.checked })}
                  className="mb-3"
                />
              </Col>
            </Row>
            <small className="text-ink-faint">
              Market data source: whose session the tick feed and quotes use when no provider is
              nominated on the Data Providers page. At most one account; choosing this one
              unchooses the previous.
            </small>
          </Form>
        </Modal.Body>
        <Modal.Footer>
          <Button
            variant="secondary"
            onClick={() => {
              setEditing(null);
              setCreating(false);
            }}
          >
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </Modal.Footer>
      </Modal>

      <ConfirmModal
        show={deleting !== null}
        onHide={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
        title={deleting ? `Remove ${deleting.displayName}` : ''}
        message="Remove this account from the engine? Its session is forgotten and nothing is placed on it again. Trades already recorded against it are kept."
        confirmLabel="Remove"
        confirmVariant="danger"
        loading={remove.isPending}
      />

      <ConfirmModal
        show={loggingOut !== null}
        onHide={() => setLoggingOut(null)}
        onConfirm={() => loggingOut && logout.mutate(loggingOut.id)}
        title={loggingOut ? `Log ${loggingOut.displayName} out` : ''}
        message="Forget this account’s session? Trading on it stops until the next login, and any provider borrowing the session loses its feed."
        confirmLabel="Log out"
        confirmVariant="danger"
        loading={logout.isPending}
      />
    </div>
  );
};

export default TradingClientsPage;
