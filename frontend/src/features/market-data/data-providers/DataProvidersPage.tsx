/**
 * Data Providers.
 *
 * A trading client places orders; a data provider supplies prices. Where the
 * vendor issues one app key for both — Zerodha, Fyers, Dhan — a provider
 * borrows a trading client's credentials instead of holding a second copy, and
 * then there is one session: signing in here or on Trading Clients signs in
 * both, because there is nothing to keep in step.
 *
 * Two active choices, and they are independent: one provider may stream ticks
 * while another answers quotes and history.
 *
 * **Nothing logs in by itself.** Every login starts with the operator pressing
 * a button.
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
  BsClipboard,
  BsCheckCircleFill,
  BsGear,
  BsPlug,
  BsXCircleFill,
} from 'react-icons/bs';
import { PageHeader } from '@/components/common';
import { dataProvidersService } from '@/services/admin/dataProviderService';
import type { DataProvider, DataProviderEdit } from '@/types/data-provider';

/** What each provider is, in one line, and what it needs. */
const ABOUT: Record<string, string> = {
  zerodha:
    'Kite Connect. One app key covers trading and market data, so this can use a trading client’s login.',
  fyers:
    'Fyers API v3. One app key covers trading and market data, so this can use a trading client’s login.',
  dhan: 'Dhan. One app key covers trading and market data, so this can use a trading client’s login.',
  xts: 'XTS (Symphony). Its market-data key and secret are issued separately from its trading ones, so it needs its own.',
  truedata: 'TrueData. A data feed with no trading side — prices only, and always its own credentials.',
};

const emptyEdit = (): DataProviderEdit => ({});

const DataProvidersPage: React.FC = () => {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [editing, setEditing] = useState<DataProvider | null>(null);
  const [form, setForm] = useState<DataProviderEdit>(emptyEdit());
  const [secret, setSecret] = useState('');
  const [copied, setCopied] = useState(false);

  const { data: providers, isLoading } = useQuery({
    queryKey: ['data-providers'],
    queryFn: () => dataProvidersService.getAll(),
  });
  const { data: active } = useQuery({
    queryKey: ['data-providers', 'active'],
    queryFn: () => dataProvidersService.getActive(),
  });
  // Scoped to the provider being edited: which accounts could it borrow from.
  const { data: borrowable } = useQuery({
    queryKey: ['data-providers', 'borrowable', editing?.provider],
    queryFn: () => dataProvidersService.borrowable(editing!.provider),
    enabled: editing !== null && editing.canBorrowTradingClient,
  });

  // The callback lands on the API, which redirects back here saying what
  // happened. Read it once, then take it out of the URL so a refresh does not
  // repeat the message.
  useEffect(() => {
    const provider = searchParams.get('login');
    if (!provider) return;
    const error = searchParams.get('error');
    if (error) toast.error(`${provider}: ${error}`);
    else if (searchParams.get('ok')) toast.success(`${provider} logged in`);
    queryClient.invalidateQueries({ queryKey: ['data-providers'] });
    setSearchParams({}, { replace: true });
  }, [searchParams, setSearchParams, queryClient]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['data-providers'] });

  const saveMutation = useMutation({
    mutationFn: ({ provider, data }: { provider: string; data: DataProviderEdit }) =>
      dataProvidersService.save(provider, data),
    onSuccess: () => {
      toast.success('Saved');
      setEditing(null);
      refresh();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const activeMutation = useMutation({
    mutationFn: (data: { ticker?: string | null; history?: string | null }) =>
      dataProvidersService.setActive(data),
    onSuccess: () => {
      toast.success('Active providers saved');
      refresh();
      queryClient.invalidateQueries({ queryKey: ['data-providers', 'active'] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const loginMutation = useMutation({
    mutationFn: (provider: string) => dataProvidersService.login(provider),
    onSuccess: (started, provider) => {
      if (started.loginStyle === 'REDIRECT' && started.url) {
        // The vendor's page, in this tab: it redirects back to the callback,
        // which redirects here. A popup would be blocked as often as not.
        window.location.href = started.url;
        return;
      }
      toast.success(`${provider} logged in`);
      refresh();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const logoutMutation = useMutation({
    mutationFn: (provider: string) => dataProvidersService.logout(provider),
    onSuccess: () => {
      toast.success('Logged out');
      refresh();
    },
  });

  const openEditor = (provider: DataProvider) => {
    setEditing(provider);
    setSecret('');
    setForm({
      enabled: provider.enabled,
      credentialSource: provider.credentialSource,
      tradingClientId: provider.tradingClientId,
      apiKey: provider.apiKey,
      clientId: provider.clientId,
      redirectUrl: provider.redirectUrl,
      websocketPort: provider.websocketPort,
      historyPort: provider.historyPort,
      quoteMinIntervalMs: provider.quoteMinIntervalMs,
      historyMinIntervalMs: provider.historyMinIntervalMs,
      batchSize: provider.batchSize,
    });
  };

  // Where the vendor sends the browser back. Derived, never typed: Fyers
  // checks the redirect URI it is given against the one registered on its app,
  // so a value entered by hand is one typo away from a login that fails as if
  // the key were wrong. The origin is the browser's own because this is a
  // *browser* redirect -- the vendor never calls it -- so whatever address the
  // operator reaches the Console at is by definition the right one.
  //
  // The owner segment matches what the login endpoint builds: the trading
  // client when the credentials are borrowed, else the literal `provider`.
  const callbackOwner =
    form.credentialSource === 'TRADING_CLIENT' ? (form.tradingClientId ?? 'provider') : 'provider';
  const callbackUrl = editing
    ? `${window.location.origin}/api/auth/callback/${editing.provider}/${callbackOwner}`
    : '';

  const copyCallback = async () => {
    try {
      await navigator.clipboard.writeText(callbackUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Could not copy — select the URL and copy it by hand.');
    }
  };

  const submit = () => {
    if (!editing) return;
    const data: DataProviderEdit = { ...form };
    // Absent means leave it; an empty string clears it.
    if (secret) data.apiSecret = secret;
    // Stored rather than entered, so the value Fyers is sent at login is the
    // same one shown here and registered on its app.
    if (editing.loginStyle === 'REDIRECT') data.redirectUrl = callbackUrl;
    saveMutation.mutate({ provider: editing.provider, data });
  };

  const enabled = (providers ?? []).filter((p) => p.enabled);

  return (
    <div className="fade-in">
      <PageHeader
        title="Data Providers"
        subtitle="Where ticks, quotes and candles come from — and who is logged in"
        icon={<BsPlug size={24} />}
      />

      <Card className="mb-4">
        <Card.Header>
          <h5 className="mb-0">Active</h5>
        </Card.Header>
        <Card.Body>
          <p className="text-ink-soft mb-3 text-sm">
            Independent choices: one provider may stream ticks while another answers quotes and
            history. Only an enabled provider can be chosen.
          </p>
          <Row>
            <Col md={4}>
              <Form.Group className="mb-3">
                <Form.Label>Ticks</Form.Label>
                <Form.Select
                  value={active?.ticker ?? ''}
                  onChange={(e) => activeMutation.mutate({ ticker: e.target.value || null })}
                >
                  <option value="">None — no live prices</option>
                  {enabled.map((p) => (
                    <option key={p.provider} value={p.provider}>
                      {p.provider}
                    </option>
                  ))}
                </Form.Select>
              </Form.Group>
            </Col>
            <Col md={4}>
              <Form.Group className="mb-3">
                <Form.Label>Quotes, OHLC and history</Form.Label>
                <Form.Select
                  value={active?.history ?? ''}
                  onChange={(e) => activeMutation.mutate({ history: e.target.value || null })}
                >
                  <option value="">None</option>
                  {enabled.map((p) => (
                    <option key={p.provider} value={p.provider}>
                      {p.provider}
                    </option>
                  ))}
                </Form.Select>
              </Form.Group>
            </Col>
          </Row>
          {enabled.length === 0 && (
            <Alert variant="warning" className="mb-0">
              No provider is enabled yet, so there are no prices. Configure one below.
            </Alert>
          )}
        </Card.Body>
      </Card>

      {isLoading ? (
        <div className="py-5 text-center">
          <Spinner />
        </div>
      ) : (
        <Row>
          {(providers ?? []).map((provider) => (
            <Col lg={6} key={provider.provider} className="mb-4">
              <Card className="h-full">
                <Card.Header className="flex items-center justify-between">
                  <span className="flex items-center gap-2 font-semibold uppercase">
                    {provider.provider}
                    {provider.isLoggedIn ? (
                      <Badge bg="success">
                        <BsCheckCircleFill className="me-1" />
                        Logged in
                      </Badge>
                    ) : (
                      <Badge bg="secondary">
                        <BsXCircleFill className="me-1" />
                        Logged out
                      </Badge>
                    )}
                    {!provider.enabled && <Badge bg="secondary">Disabled</Badge>}
                  </span>
                  <Button variant="outline-primary" size="sm" onClick={() => openEditor(provider)}>
                    <BsGear className="me-1" />
                    Configure
                  </Button>
                </Card.Header>
                <Card.Body>
                  <p className="text-ink-soft text-sm">{ABOUT[provider.provider]}</p>

                  <dl className="mb-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                    <dt className="text-ink-faint">Credentials</dt>
                    <dd>
                      {provider.credentialSource === 'TRADING_CLIENT'
                        ? `Trading client: ${provider.tradingClientId ?? 'not chosen'}`
                        : provider.apiKey
                          ? 'Its own'
                          : 'Its own — not set'}
                    </dd>
                    <dt className="text-ink-faint">Login</dt>
                    <dd>
                      {provider.loginStyle === 'REDIRECT'
                        ? 'Browser redirect'
                        : 'Direct API call'}
                    </dd>
                    <dt className="text-ink-faint">Quote spacing</dt>
                    <dd>{provider.quoteMinIntervalMs} ms</dd>
                    <dt className="text-ink-faint">History spacing</dt>
                    <dd>{provider.historyMinIntervalMs} ms</dd>
                  </dl>

                  {provider.credentialSource === 'TRADING_CLIENT' && (
                    <Alert variant="info" className="py-2 text-sm">
                      This shares the trading client’s login. Signing in on either page signs in
                      both.
                    </Alert>
                  )}

                  <div className="flex gap-2">
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={!provider.enabled || loginMutation.isPending}
                      onClick={() => loginMutation.mutate(provider.provider)}
                    >
                      {provider.loginStyle === 'REDIRECT' && (
                        <BsBoxArrowUpRight className="me-1" />
                      )}
                      {provider.isLoggedIn ? 'Log in again' : 'Log in'}
                    </Button>
                    {provider.isLoggedIn && provider.credentialSource === 'OWN' && (
                      <Button
                        variant="outline-danger"
                        size="sm"
                        onClick={() => logoutMutation.mutate(provider.provider)}
                      >
                        Log out
                      </Button>
                    )}
                  </div>
                </Card.Body>
              </Card>
            </Col>
          ))}
        </Row>
      )}

      <Modal show={editing !== null} onHide={() => setEditing(null)} size="lg" backdrop="static">
        <Modal.Header closeButton>
          <Modal.Title className="uppercase">{editing?.provider}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {editing && (
            <Form>
              <Form.Check
                type="switch"
                label="Enabled"
                checked={form.enabled ?? false}
                onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
                className="mb-3"
              />

              <Form.Group className="mb-3">
                <Form.Label>Credentials</Form.Label>
                <Form.Select
                  value={form.credentialSource ?? 'OWN'}
                  disabled={!editing.canBorrowTradingClient}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      credentialSource: e.target.value as 'TRADING_CLIENT' | 'OWN',
                    })
                  }
                >
                  {editing.canBorrowTradingClient && (
                    <option value="TRADING_CLIENT">Use a trading client’s</option>
                  )}
                  <option value="OWN">Its own</option>
                </Form.Select>
                {!editing.canBorrowTradingClient && (
                  <small className="text-ink-faint">
                    {editing.provider === 'truedata'
                      ? 'TrueData has no trading side, so there is nothing to borrow.'
                      : 'Its market-data credentials are issued separately from its trading ones.'}
                  </small>
                )}
              </Form.Group>

              {form.credentialSource === 'TRADING_CLIENT' ? (
                <Form.Group className="mb-3">
                  <Form.Label>Trading client</Form.Label>
                  <Form.Select
                    value={form.tradingClientId ?? ''}
                    onChange={(e) => setForm({ ...form, tradingClientId: e.target.value || null })}
                  >
                    <option value="">Choose one…</option>
                    {(borrowable ?? []).map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.displayName} ({c.clientId})
                      </option>
                    ))}
                  </Form.Select>
                  <small className="text-ink-faint">
                    Its app key and its session are used as they are — nothing is copied.
                  </small>
                </Form.Group>
              ) : (
                <>
                  <Row>
                    <Col md={6}>
                      <Form.Group className="mb-3">
                        <Form.Label>API key</Form.Label>
                        <Form.Control
                          value={form.apiKey ?? ''}
                          onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
                          placeholder={
                            editing.provider === 'truedata' ? 'TrueData username' : 'App key'
                          }
                        />
                      </Form.Group>
                    </Col>
                    <Col md={6}>
                      <Form.Group className="mb-3">
                        <Form.Label>
                          API secret{' '}
                          {editing.hasApiSecret && (
                            <small className="text-ink-faint">(stored — leave blank to keep)</small>
                          )}
                        </Form.Label>
                        <Form.Control
                          type="password"
                          value={secret}
                          onChange={(e) => setSecret(e.target.value)}
                          placeholder={
                            editing.provider === 'truedata' ? 'TrueData password' : 'App secret'
                          }
                        />
                      </Form.Group>
                    </Col>
                  </Row>
                  <Row>
                    <Col md={6}>
                      <Form.Group className="mb-3">
                        <Form.Label>Account id</Form.Label>
                        <Form.Control
                          value={form.clientId ?? ''}
                          onChange={(e) => setForm({ ...form, clientId: e.target.value })}
                        />
                        <small className="text-ink-faint">
                          Checked against whoever the vendor says logged in, so a session for
                          another account is refused rather than used.
                        </small>
                      </Form.Group>
                    </Col>
                    {editing.loginStyle === 'REDIRECT' && (
                      <Col md={6}>
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
                            Garuda builds this; copy it into the vendor’s console exactly. It is
                            not editable because the vendor matches what it is sent against what
                            is registered, and a value typed twice is a value that can differ.
                          </small>
                        </Form.Group>
                      </Col>
                    )}
                  </Row>
                  {editing.provider === 'truedata' && (
                    <Row>
                      <Col md={6}>
                        <Form.Group className="mb-3">
                          <Form.Label>WebSocket port</Form.Label>
                          <Form.Control
                            type="number"
                            value={form.websocketPort ?? ''}
                            onChange={(e) =>
                              setForm({
                                ...form,
                                websocketPort: e.target.value ? Number(e.target.value) : null,
                              })
                            }
                          />
                        </Form.Group>
                      </Col>
                      <Col md={6}>
                        <Form.Group className="mb-3">
                          <Form.Label>History port</Form.Label>
                          <Form.Control
                            type="number"
                            value={form.historyPort ?? ''}
                            onChange={(e) =>
                              setForm({
                                ...form,
                                historyPort: e.target.value ? Number(e.target.value) : null,
                              })
                            }
                          />
                        </Form.Group>
                      </Col>
                    </Row>
                  )}
                </>
              )}

              <hr />
              <p className="text-ink-soft mb-2 text-sm">
                How hard the engine may lean on this provider. Exceeding a vendor’s rate costs more
                than the request saved, so a call that would breach the spacing is refused rather
                than queued.
              </p>
              <Row>
                <Col md={4}>
                  <Form.Group className="mb-3">
                    <Form.Label>Quote spacing (ms)</Form.Label>
                    <Form.Control
                      type="number"
                      value={form.quoteMinIntervalMs ?? 0}
                      onChange={(e) =>
                        setForm({ ...form, quoteMinIntervalMs: Number(e.target.value) })
                      }
                    />
                  </Form.Group>
                </Col>
                <Col md={4}>
                  <Form.Group className="mb-3">
                    <Form.Label>History spacing (ms)</Form.Label>
                    <Form.Control
                      type="number"
                      value={form.historyMinIntervalMs ?? 0}
                      onChange={(e) =>
                        setForm({ ...form, historyMinIntervalMs: Number(e.target.value) })
                      }
                    />
                  </Form.Group>
                </Col>
                <Col md={4}>
                  <Form.Group className="mb-3">
                    <Form.Label>Quote batch size</Form.Label>
                    <Form.Control
                      type="number"
                      value={form.batchSize ?? ''}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          batchSize: e.target.value ? Number(e.target.value) : null,
                        })
                      }
                    />
                  </Form.Group>
                </Col>
              </Row>
            </Form>
          )}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={() => setEditing(null)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={saveMutation.isPending}>
            {saveMutation.isPending ? 'Saving…' : 'Save'}
          </Button>
        </Modal.Footer>
      </Modal>
    </div>
  );
};

export default DataProvidersPage;
