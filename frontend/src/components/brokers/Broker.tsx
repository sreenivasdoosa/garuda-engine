/**
 * Broker Component
 * Modal for viewing/editing a single broker
 * Reusable across Admin portals
 * Uses V2 API: /api/v2/brokers
 */

import { useState, useEffect } from 'react';
import { Modal, Form, Row, Col, Button, Spinner, Badge, InputGroup, Alert } from '@/components/ui/rbShim';
import { BsBank, BsEye, BsEyeSlash } from 'react-icons/bs';
import { useQuery } from '@tanstack/react-query';
import type { Broker as BrokerType, CreateBrokerRequest, UpdateBrokerRequest } from '@/types/broker';
import HelpIcon from '@/components/common/HelpIcon';
import { brokerHelpContent } from '@/data/help';
import { v2BrokerService } from '@/services/admin/v2AdminService';

export interface BrokerProps {
  /** Broker for edit mode, null for create mode */
  broker: BrokerType | null;
  /** Whether the modal is visible */
  show: boolean;
  /** Close modal callback */
  onClose: () => void;
  /** Save callback */
  onSave: (data: CreateBrokerRequest | UpdateBrokerRequest, isNew: boolean) => void;
  /** Whether save is in progress */
  isSaving?: boolean;
  /** Mode: 'view' | 'edit' | 'create' */
  mode?: 'view' | 'edit' | 'create';
  /** Existing broker names — used to hide already-created fixed-name brokers */
  existingBrokerNames?: string[];
}

export interface BrokerTypeInfo {
  value: string;
  label: string;
  provider: string;
  fixedName: boolean;
  description?: string;
  defaultServerUrl?: string;
  totpDefault?: boolean;
  isXts?: boolean;
}

/**
 * Validates an optional URL field: empty is OK, non-empty must be a
 * well-formed http(s) URL with a non-empty host. Catches the common
 * misconfiguration "http:///host" (triple slash) that silently passes
 * basic parsing in some runtimes but produces URIs with empty hosts
 * downstream on the server.
 */
function isValidOptionalUrl(value: string | undefined | null): boolean {
  if (value == null) return true;
  const trimmed = value.trim();
  if (!trimmed) return true;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    return parsed.hostname.length > 0;
  } catch {
    return false;
  }
}

const isXtsProvider = (provider?: string) => provider === 'xts' || provider === 'xts-hostlookup';
const isXtsHostLookup = (provider?: string) => provider === 'xts-hostlookup';
// Noren is the only provider that consumes BrokerDetails.oauthUrl (per-broker
// OAuth login page); every other broker hardcodes its login URL internally.
const isNoren = (provider?: string) => provider === 'noren';

// Defaults shown in the UI for xts-hostlookup brokers; mirror the backend
// XTSLoginSession fallbacks (LEGACY values — the majority of XTS brokers are
// still on the old server; upgraded brokers like IIFL set per-broker overrides).
const DEFAULT_HOST_LOOKUP_VERSION = 'interactive_1.0.1';
const DEFAULT_HOST_LOOKUP_PASSWORD = '2021HostLookUpAccess';
const DEFAULT_HOST_LOOKUP_PATH = '/HostLookUp';

const Broker: React.FC<BrokerProps> = ({
  broker,
  show,
  onClose,
  onSave,
  isSaving = false,
  mode = broker ? 'edit' : 'create',
  existingBrokerNames = [],
}) => {
  const isViewMode = mode === 'view';
  const isCreateMode = mode === 'create';
  const [selectedBrokerType, setSelectedBrokerType] = useState<string>('');

  // Fetch supported broker types from backend
  const { data: brokerTypes = [] } = useQuery<BrokerTypeInfo[]>({
    queryKey: ['broker-types'],
    queryFn: () => v2BrokerService.getBrokerTypes(),
    staleTime: Infinity,
  });
  const [formData, setFormData] = useState<CreateBrokerRequest>({
    name: '',
  });
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (broker) {
      setFormData({
        name: broker.name,
        enabled: broker.enabled,
        stopped: broker.stopped,
        autoLogin: broker.autoLogin,
        description: broker.description,
        provider: broker.provider,
        useDealerAPIs: broker.useDealerAPIs,
        isBOCOBlocked: broker.isBOCOBlocked,
        // useCommonApp: broker.useCommonApp, // Deprecated — no longer supported per regulations
        commonAppKey: broker.commonAppKey,
        commonAppSecret: broker.commonAppSecret,
        marketDataAppKey: broker.marketDataAppKey,
        marketDataAppSecret: broker.marketDataAppSecret,
        serverUrl: broker.serverUrl,
        dataServerUrl: broker.dataServerUrl,
        xtremeAgentDestUrl: broker.xtremeAgentDestUrl,
        totpEnabled: broker.totpEnabled,
        webSocketEnabled: broker.webSocketEnabled,
        apiVersion: broker.apiVersion,
        serverStartTime: broker.serverStartTime,
        serverStopTime: broker.serverStopTime,
        orderUpdateIntervalSecs: broker.orderUpdateIntervalSecs,
        positionUpdateIntervalSecs: broker.positionUpdateIntervalSecs,
        ioSocketVersion: broker.ioSocketVersion || '1.0.2',
        mtfInterestRatePerAnnum: broker.mtfInterestRatePerAnnum,
        naicCode: broker.naicCode,
        algoId: broker.algoId,
        oauthUrl: broker.oauthUrl,
        // For xts-hostlookup, always show a value: fall back to the defaults
        // when the broker hasn't had these set yet. Other providers: leave as-is
        // (field is hidden and not sent).
        hostLookupVersion: isXtsHostLookup(broker.provider)
          ? (broker.hostLookupVersion || DEFAULT_HOST_LOOKUP_VERSION)
          : broker.hostLookupVersion,
        hostLookupPassword: isXtsHostLookup(broker.provider)
          ? (broker.hostLookupPassword || DEFAULT_HOST_LOOKUP_PASSWORD)
          : broker.hostLookupPassword,
        hostLookupPath: isXtsHostLookup(broker.provider)
          ? (broker.hostLookupPath || DEFAULT_HOST_LOOKUP_PATH)
          : broker.hostLookupPath,
      });
      // Determine broker type from provider
      const bt = brokerTypes.find(t => t.provider === broker.provider);
      setSelectedBrokerType(bt ? bt.value : broker.provider || '');
    } else {
      setSelectedBrokerType('');
      setFormData({
        name: '',
        enabled: true,
        isBOCOBlocked: true,
      });
    }
  }, [broker, show]);

  const handleBrokerTypeChange = (type: string) => {
    setSelectedBrokerType(type);
    const bt = brokerTypes.find(t => t.value === type);
    if (!bt) return;

    if (isCreateMode) {
      const defaults: Partial<CreateBrokerRequest> = {
        provider: bt.provider,
        isBOCOBlocked: true,
        enabled: true,
      };
      if (bt.fixedName) {
        defaults.name = bt.value;
      }
      if (bt.defaultServerUrl) {
        defaults.serverUrl = bt.defaultServerUrl;
      }
      if (bt.totpDefault) {
        defaults.totpEnabled = true;
      }
      if (bt.provider === 'noren') {
        // Noren/Kambala brokers run dealer-mode by default (one dealer login
        // serving multiple client accounts). Websocket stays OFF until the
        // Noren websocket support is confirmed and implemented.
        defaults.useDealerAPIs = true;
        defaults.webSocketEnabled = false;
      }
      if (isXtsHostLookup(bt.provider)) {
        // Pre-fill the host-lookup params with the backend defaults; admin can edit.
        defaults.hostLookupVersion = DEFAULT_HOST_LOOKUP_VERSION;
        defaults.hostLookupPassword = DEFAULT_HOST_LOOKUP_PASSWORD;
        defaults.hostLookupPath = DEFAULT_HOST_LOOKUP_PATH;
      }
      setFormData(prev => ({ ...prev, ...defaults }));
    } else {
      // Edit mode (recovery for legacy rows missing provider): only fill the
      // missing provider, never clobber existing name/serverUrl/etc.
      setFormData(prev => ({ ...prev, provider: prev.provider || bt.provider }));
    }
  };

  // Edit-mode only: allow switching between the two XTS variants (xts <-> xts-hostlookup).
  // Both resolve to the same broker implementation classes on the backend, so this is a
  // safe in-family switch; the only behavioural change is the login base-URL/host-lookup
  // path (see XTSLoginSession). We never expose a cross-provider switch (e.g. zerodha ->
  // dhan) because that would orphan the stored credentials.
  const canSwitchXtsVariant = !isCreateMode && isXtsProvider(broker?.provider);

  const handleProviderChange = (newProvider: string) => {
    setFormData(prev => {
      const next = { ...prev, provider: newProvider };
      if (isXtsHostLookup(newProvider)) {
        // Switching to host-lookup: ensure the three host-lookup params carry a value so
        // they are actually sent on save. Fall back to the backend defaults (never clobber
        // values the broker may already have set).
        next.hostLookupVersion = prev.hostLookupVersion || DEFAULT_HOST_LOOKUP_VERSION;
        next.hostLookupPassword = prev.hostLookupPassword || DEFAULT_HOST_LOOKUP_PASSWORD;
        next.hostLookupPath = prev.hostLookupPath || DEFAULT_HOST_LOOKUP_PATH;
      }
      return next;
    });
  };

  const providerChanged = !isCreateMode && !!broker?.provider && formData.provider !== broker.provider;

  const serverUrlValid = isValidOptionalUrl(formData.serverUrl);
  const dataServerUrlValid = isValidOptionalUrl(formData.dataServerUrl);
  // xtremeAgentDestUrl is a broker-level override used by XtremeAgentManager
  // (mainly for XTS host-lookup setups). Not exposed in this form, so don't
  // gate the Update button on its validity — the existing DB value is
  // preserved by BrokerServletV2's merge logic.
  const urlsValid = serverUrlValid && dataServerUrlValid;

  const handleSubmit = () => {
    if (!urlsValid) return;
    onSave(formData, isCreateMode);
  };

  const getModalTitle = () => {
    if (isCreateMode) return 'Add New Broker';
    if (isViewMode) return `Broker: ${broker?.name}`;
    return `Edit Broker: ${broker?.name}`;
  };

  const isXts = isXtsProvider(formData.provider);
  const brokerTypeSelected = !!selectedBrokerType;

  return (
    <Modal show={show} onHide={onClose} size="lg" backdrop="static">
      <Modal.Header closeButton>
        <Modal.Title className="flex items-center gap-2">
          <BsBank />
          {getModalTitle()}
        </Modal.Title>
      </Modal.Header>
      <Modal.Body>
        {isViewMode && broker ? (
          <Row className="">
            <Col md={6}>
              <label className="text-ink-soft text-[0.875em]">Name</label>
              <div className="font-medium">{broker.name}</div>
            </Col>
            <Col md={3}>
              <label className="text-ink-soft text-[0.875em]">Provider</label>
              <div>{broker.provider || 'N/A'}</div>
            </Col>
            {broker.availableApiVersions && broker.availableApiVersions.length > 1 && (
              <Col md={3}>
                <label className="text-ink-soft text-[0.875em]">API Version</label>
                <div><Badge bg={broker.apiVersion >= 2 ? 'primary' : 'secondary'}>V{broker.apiVersion || 1}</Badge></div>
              </Col>
            )}
            <Col md={12}>
              <label className="text-ink-soft text-[0.875em]">Description</label>
              <div>{broker.description || 'N/A'}</div>
            </Col>
            <Col md={4}>
              <label className="text-ink-soft text-[0.875em]">Status</label>
              <div>
                <Badge bg={broker.enabled ? 'success' : 'secondary'}>{broker.enabled ? 'Enabled' : 'Disabled'}</Badge>
                {broker.stopped && <Badge bg="danger" className="ms-1">Stopped</Badge>}
              </div>
            </Col>
            <Col md={4}>
              <label className="text-ink-soft text-[0.875em]">TOTP Enabled</label>
              <div><Badge bg={broker.totpEnabled ? 'info' : 'light'} text={broker.totpEnabled ? 'white' : 'dark'}>{broker.totpEnabled ? 'Yes' : 'No'}</Badge></div>
            </Col>
            <Col md={4}>
              <label className="text-ink-soft text-[0.875em]">WebSocket</label>
              <div><Badge bg={broker.webSocketEnabled ? 'info' : 'light'} text={broker.webSocketEnabled ? 'white' : 'dark'}>{broker.webSocketEnabled ? 'Yes' : 'No'}</Badge></div>
            </Col>
            {isXtsProvider(broker.provider) && (
              <Col md={4}>
                <label className="text-ink-soft text-[0.875em]">Use Dealer APIs</label>
                <div><Badge bg={broker.useDealerAPIs ? 'info' : 'light'} text={broker.useDealerAPIs ? 'white' : 'dark'}>{broker.useDealerAPIs ? 'Yes' : 'No'}</Badge></div>
              </Col>
            )}
            {broker.serverUrl && (
              <Col md={12}>
                <label className="text-ink-soft text-[0.875em]">Server URL</label>
                <div><code>{broker.serverUrl}</code></div>
              </Col>
            )}
            {isXtsProvider(broker.provider) && (
              <Col md={4}>
                <label className="text-ink-soft text-[0.875em]">Server Hours</label>
                <div>{broker.serverStartTime || '08:00'} – {broker.serverStopTime || '24x7'}</div>
              </Col>
            )}
            {isXtsProvider(broker.provider) && broker.marketDataAppKey && (
              <Col md={6}>
                <label className="text-ink-soft text-[0.875em]">Market Data App Key</label>
                <div><code>{broker.marketDataAppKey}</code></div>
              </Col>
            )}
            {isXtsHostLookup(broker.provider) && (
              <Col md={6}>
                <label className="text-ink-soft text-[0.875em]">Host Lookup Version</label>
                <div><code>{broker.hostLookupVersion || DEFAULT_HOST_LOOKUP_VERSION}</code></div>
              </Col>
            )}
            {isXtsHostLookup(broker.provider) && (
              <Col md={6}>
                <label className="text-ink-soft text-[0.875em]">Host Lookup Password</label>
                <div><code>{broker.hostLookupPassword || DEFAULT_HOST_LOOKUP_PASSWORD}</code></div>
              </Col>
            )}
            {isXtsHostLookup(broker.provider) && (
              <Col md={6}>
                <label className="text-ink-soft text-[0.875em]">Host Lookup Path</label>
                <div><code>{broker.hostLookupPath || DEFAULT_HOST_LOOKUP_PATH}</code></div>
              </Col>
            )}
            {isNoren(broker.provider) && broker.oauthUrl && (
              <Col md={12}>
                <label className="text-ink-soft text-[0.875em]">OAuth Login URL</label>
                <div><code>{broker.oauthUrl}</code></div>
              </Col>
            )}
          </Row>
        ) : (
          <Form>
            {/* Step 1: Broker Type Selection.
                Shown in create mode (initially) and in edit mode when the
                existing record is missing a provider value (legacy data). */}
            {!brokerTypeSelected && (
              <>
                <Alert variant="info" className="py-2" style={{ fontSize: '0.85rem' }}>
                  {isCreateMode
                    ? 'Select the broker type to get started'
                    : 'Broker type is not set for this broker. Please select the correct type.'}
                </Alert>
                <Row className="">
                  {brokerTypes
                    .filter(bt => {
                      if (bt.fixedName) {
                        // Fixed-name types: in create mode, hide ones that already exist;
                        // in edit mode, only show the one matching the current broker's name.
                        return isCreateMode
                          ? !existingBrokerNames.includes(bt.value)
                          : broker?.name === bt.value;
                      }
                      // Custom multi-broker provider types (XTS variants, Noren/Kambala)
                      // — always available: many brokers can share one provider.
                      return true;
                    })
                    .map(bt => (
                    <Col md={6} key={bt.value}>
                      <div
                        className="border rounded-md p-4 text-center"
                        style={{ cursor: 'pointer', transition: 'all 0.15s' }}
                        onClick={() => handleBrokerTypeChange(bt.value)}
                        onMouseEnter={e => { (e.target as HTMLElement).style.borderColor = 'var(--brand-primary)'; (e.target as HTMLElement).style.background = 'var(--card-header-bg)'; }}
                        onMouseLeave={e => { (e.target as HTMLElement).style.borderColor = ''; (e.target as HTMLElement).style.background = ''; }}
                      >
                        <div className="font-semibold">{bt.label}</div>
                        <small className="text-ink-soft">{bt.description || `Provider: ${bt.provider}`}</small>
                      </div>
                    </Col>
                  ))}
                </Row>
              </>
            )}

            {/* Step 2: Broker Details (after type selected or edit mode) */}
            {(brokerTypeSelected || !isCreateMode) && (
              <>
                <Row>
                  <Col md={6}>
                    <Form.Group className="mb-4">
                      <Form.Label className="flex items-center">Name * <HelpIcon article={brokerHelpContent['broker.name']} /></Form.Label>
                      <Form.Control
                        value={formData.name}
                        onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                        disabled={!isCreateMode || brokerTypes.find(t => t.value === selectedBrokerType)?.fixedName}
                        placeholder="Broker name"
                      />
                    </Form.Group>
                  </Col>
                  <Col md={broker?.availableApiVersions && broker.availableApiVersions.length > 1 ? 4 : 6}>
                    <Form.Group className="mb-4">
                      <Form.Label className="flex items-center">Provider <HelpIcon article={brokerHelpContent['broker.provider']} /></Form.Label>
                      {canSwitchXtsVariant ? (
                        <Form.Select
                          value={formData.provider ?? ''}
                          onChange={(e) => handleProviderChange(e.target.value)}
                        >
                          <option value="xts">xts</option>
                          <option value="xts-hostlookup">xts-hostlookup</option>
                        </Form.Select>
                      ) : (
                        <Form.Control
                          value={formData.provider ?? ''}
                          disabled
                        />
                      )}
                    </Form.Group>
                  </Col>
                  {broker?.availableApiVersions && broker.availableApiVersions.length > 1 && (
                    <Col md={2}>
                      <Form.Group className="mb-4">
                        <Form.Label className="flex items-center">API Version <HelpIcon article={brokerHelpContent['broker.apiVersion']} /></Form.Label>
                        <Form.Select
                          value={formData.apiVersion ?? 1}
                          onChange={(e) => setFormData({ ...formData, apiVersion: parseInt(e.target.value) })}
                        >
                          {broker.availableApiVersions.map((v) => (
                            <option key={v} value={v}>V{v}</option>
                          ))}
                        </Form.Select>
                      </Form.Group>
                    </Col>
                  )}
                </Row>
                {providerChanged && (
                  <Alert variant="warning" className="py-2" style={{ fontSize: '0.85rem' }}>
                    Provider changed to <strong>{formData.provider}</strong>. This takes effect on the
                    broker's next login. Review the <strong>Server URL</strong>: plain <code>xts</code>{' '}
                    auto-appends <code>/interactive</code>, whereas <code>xts-hostlookup</code> uses the
                    Server URL as-is and calls the host-lookup endpoint first
                    {isXtsHostLookup(formData.provider) && ' (see the Host Lookup fields below)'}.
                  </Alert>
                )}
                <Row>
                  <Col md={12}>
                    <Form.Group className="mb-4">
                      <Form.Label className="flex items-center">Description <HelpIcon article={brokerHelpContent['broker.description']} /></Form.Label>
                      <Form.Control
                        as="textarea"
                        rows={2}
                        value={formData.description ?? ''}
                        onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                        placeholder="Broker description"
                      />
                    </Form.Group>
                  </Col>
                </Row>

                {/* Server URL & Data Server URL — shown for all brokers */}
                <Row>
                  <Col md={6}>
                    <Form.Group className="mb-4">
                      <Form.Label className="flex items-center">Server URL <HelpIcon article={brokerHelpContent['broker.serverUrl']} /></Form.Label>
                      <Form.Control
                        value={formData.serverUrl ?? ''}
                        onChange={(e) => setFormData({ ...formData, serverUrl: e.target.value })}
                        placeholder="https://..."
                        isInvalid={!serverUrlValid}
                      />
                      <Form.Control.Feedback type="invalid">
                        Must be a well-formed http(s) URL (e.g. https://host:port). Leave empty if unused.
                      </Form.Control.Feedback>
                    </Form.Group>
                  </Col>
                  <Col md={6}>
                    <Form.Group className="mb-4">
                      <Form.Label className="flex items-center">Data Server URL <span className="text-ink-soft ms-1" style={{ fontWeight: 400 }}>(optional)</span> <HelpIcon article={brokerHelpContent['broker.dataServerUrl']} /></Form.Label>
                      <Form.Control
                        value={formData.dataServerUrl ?? ''}
                        onChange={(e) => setFormData({ ...formData, dataServerUrl: e.target.value })}
                        placeholder="https://..."
                        isInvalid={!dataServerUrlValid}
                      />
                      <Form.Control.Feedback type="invalid">
                        Must be a well-formed http(s) URL. Leave empty if not used.
                      </Form.Control.Feedback>
                      <Form.Text className="text-ink-soft">Leave empty if not used or same as Server URL</Form.Text>
                    </Form.Group>
                  </Col>
                </Row>

                {/* Exchange algo-tagging (global defaults; Broker Config page overrides per exchange) */}
                <Row>
                  <Col md={6}>
                    <Form.Group className="mb-4">
                      <Form.Label className="flex items-center">NAIC Code <HelpIcon article={brokerHelpContent['broker.naicCode']} /></Form.Label>
                      <Form.Control
                        value={formData.naicCode ?? ''}
                        onChange={(e) => setFormData({ ...formData, naicCode: e.target.value })}
                        placeholder="e.g. 118"
                        maxLength={8}
                      />
                      <Form.Text className="text-ink-soft">
                        Algo-tagging: '1' (algo) + 2-digit exchange vendor code. Empty = omit from orders.
                      </Form.Text>
                    </Form.Group>
                  </Col>
                  <Col md={6}>
                    <Form.Group className="mb-4">
                      <Form.Label className="flex items-center">Algo ID <HelpIcon article={brokerHelpContent['broker.algoId']} /></Form.Label>
                      <Form.Control
                        value={formData.algoId ?? ''}
                        onChange={(e) => setFormData({ ...formData, algoId: e.target.value })}
                        placeholder="e.g. AA32"
                        maxLength={32}
                      />
                      <Form.Text className="text-ink-soft">
                        Exchange-approved algo id. Empty = omit from orders. Per-exchange override on Broker Config.
                      </Form.Text>
                    </Form.Group>
                  </Col>
                </Row>

                {/* OAuth login URL — only Noren consumes it (per-broker login page);
                    other providers hardcode their login URL internally. */}
                {isNoren(formData.provider) && (
                  <Row>
                    <Col md={12}>
                      <Form.Group className="mb-4">
                        <Form.Label className="flex items-center">OAuth Login URL <HelpIcon article={brokerHelpContent['broker.oauthUrl']} /></Form.Label>
                        <Form.Control
                          value={formData.oauthUrl ?? ''}
                          onChange={(e) => setFormData({ ...formData, oauthUrl: e.target.value })}
                          placeholder="https://broker-login-page (leave empty if not using OAuth login)"
                        />
                        <Form.Text className="text-ink-soft">
                          Login-page URL for individual-user OAuth flows. Empty = OAuth login disabled.
                        </Form.Text>
                      </Form.Group>
                    </Col>
                  </Row>
                )}

                {/* XTS Host Lookup-only fields — sent to the host lookup endpoint before login */}
                {isXtsHostLookup(formData.provider) && (
                  <Row>
                    <Col md={6}>
                      <Form.Group className="mb-4">
                        <Form.Label>Host Lookup Path</Form.Label>
                        <Form.Control
                          value={formData.hostLookupPath ?? ''}
                          onChange={(e) => setFormData({ ...formData, hostLookupPath: e.target.value })}
                          placeholder={DEFAULT_HOST_LOOKUP_PATH}
                        />
                        <Form.Text className="text-ink-soft">
                          Path appended to Server URL for host lookup, e.g. {DEFAULT_HOST_LOOKUP_PATH} (case-sensitive on some brokers).
                        </Form.Text>
                      </Form.Group>
                    </Col>
                    <Col md={6}>
                      <Form.Group className="mb-4">
                        <Form.Label>Host Lookup Version</Form.Label>
                        <Form.Control
                          value={formData.hostLookupVersion ?? ''}
                          onChange={(e) => setFormData({ ...formData, hostLookupVersion: e.target.value })}
                          placeholder={DEFAULT_HOST_LOOKUP_VERSION}
                        />
                        <Form.Text className="text-ink-soft">
                          Version sent to the host lookup endpoint (default {DEFAULT_HOST_LOOKUP_VERSION}).
                        </Form.Text>
                      </Form.Group>
                    </Col>
                    <Col md={6}>
                      <Form.Group className="mb-4">
                        <Form.Label>Host Lookup Password</Form.Label>
                        <Form.Control
                          value={formData.hostLookupPassword ?? ''}
                          onChange={(e) => setFormData({ ...formData, hostLookupPassword: e.target.value })}
                          placeholder={DEFAULT_HOST_LOOKUP_PASSWORD}
                        />
                        <Form.Text className="text-ink-soft">
                          Access password sent to the host lookup endpoint (default {DEFAULT_HOST_LOOKUP_PASSWORD}).
                        </Form.Text>
                      </Form.Group>
                    </Col>
                  </Row>
                )}

                {/* XTS-only fields */}
                {isXts && (
                  <>
                    <Row>
                      <Col md={6}>
                        <Form.Group className="mb-4">
                          <Form.Label>Server Start Time</Form.Label>
                          <Form.Control
                            type="time"
                            value={formData.serverStartTime ?? '08:00'}
                            onChange={(e) => setFormData({ ...formData, serverStartTime: e.target.value })}
                          />
                          <Form.Text className="text-ink-soft">When broker server starts (default 08:00)</Form.Text>
                        </Form.Group>
                      </Col>
                      <Col md={6}>
                        <Form.Group className="mb-4">
                          <Form.Label>Server Stop Time</Form.Label>
                          <Form.Control
                            type="time"
                            value={formData.serverStopTime ?? ''}
                            onChange={(e) => setFormData({ ...formData, serverStopTime: e.target.value || null })}
                          />
                          <Form.Text className="text-ink-soft">When broker server stops. Leave empty for 24x7</Form.Text>
                        </Form.Group>
                      </Col>
                    </Row>
                    <Row>
                      <Col md={6}>
                        <Form.Group className="mb-4">
                          <Form.Label className="flex items-center">Order Update Interval (secs) <HelpIcon article={brokerHelpContent['broker.orderUpdateIntervalSecs']} /></Form.Label>
                          <Form.Control
                            type="number"
                            min={0}
                            value={formData.orderUpdateIntervalSecs ?? 30}
                            onChange={(e) => setFormData({ ...formData, orderUpdateIntervalSecs: Math.max(0, parseInt(e.target.value) || 0) })}
                          />
                          <Form.Text className="text-ink-soft">
                            Order-book REST poll cadence, used as-is regardless of WebSocket state. 0 = global default (30s).
                          </Form.Text>
                        </Form.Group>
                      </Col>
                      <Col md={6}>
                        <Form.Group className="mb-4">
                          <Form.Label className="flex items-center">Position Update Interval (secs) <HelpIcon article={brokerHelpContent['broker.positionUpdateIntervalSecs']} /></Form.Label>
                          <Form.Control
                            type="number"
                            min={0}
                            value={formData.positionUpdateIntervalSecs ?? 60}
                            onChange={(e) => setFormData({ ...formData, positionUpdateIntervalSecs: Math.max(0, parseInt(e.target.value) || 0) })}
                          />
                          <Form.Text className="text-ink-soft">
                            Positions REST poll cadence, used as-is regardless of WebSocket state. 0 = global default (60s). Note: Dhan's socket sends no position updates — this poll is its only source.
                          </Form.Text>
                        </Form.Group>
                      </Col>
                    </Row>
                    <Row>
                      <Col md={6}>
                        <Form.Group className="mb-4">
                          <Form.Label>socket.io Client Version</Form.Label>
                          <Form.Select
                            value={formData.ioSocketVersion ?? '1.0.2'}
                            onChange={(e) => setFormData({ ...formData, ioSocketVersion: e.target.value })}
                          >
                            <option value="1.0.2">1.0.2 (default)</option>
                            <option value="2.x">2.x</option>
                          </Form.Select>
                          <Form.Text className="text-ink-soft">
                            socket.io client for this broker's order/position socket. 1.0.2 is the bundled client; 2.x uses the newer client (fixes the per-handshake scheduled-executor thread leak). Change one broker at a time and verify connectivity.
                          </Form.Text>
                        </Form.Group>
                      </Col>
                      <Col md={6}>
                        <Form.Group className="mb-4">
                          <Form.Label className="flex items-center">MTF Interest Rate (% per annum) <HelpIcon article={brokerHelpContent['broker.mtfInterestRatePerAnnum']} /></Form.Label>
                          <Form.Control
                            type="number"
                            min={0}
                            max={100}
                            step={0.1}
                            value={formData.mtfInterestRatePerAnnum ?? 0}
                            onChange={(e) => setFormData({ ...formData, mtfInterestRatePerAnnum: Math.max(0, parseFloat(e.target.value) || 0) })}
                          />
                          <Form.Text className="text-ink-soft">
                            Funding interest this broker charges on MTF carry positions (e.g. 12 = 12%/yr, accrued daily on the funded value). 0 = no MTF interest tracked.
                          </Form.Text>
                        </Form.Group>
                      </Col>
                    </Row>
                    <Row>
                      <Col md={6}>
                        <Form.Group className="mb-4">
                          <Form.Label className="flex items-center">Market Data App Key <HelpIcon article={brokerHelpContent['broker.marketDataAppKey']} /></Form.Label>
                          <Form.Control
                            value={formData.marketDataAppKey ?? ''}
                            onChange={(e) => setFormData({ ...formData, marketDataAppKey: e.target.value })}
                            placeholder="Market data API key"
                          />
                        </Form.Group>
                      </Col>
                      <Col md={6}>
                        <Form.Group className="mb-4">
                          <Form.Label className="flex items-center">Market Data App Secret <HelpIcon article={brokerHelpContent['broker.marketDataAppSecret']} /></Form.Label>
                          <InputGroup>
                            <Form.Control
                              type={showSecrets['marketDataAppSecret'] ? 'text' : 'password'}
                              value={formData.marketDataAppSecret ?? ''}
                              onChange={(e) => setFormData({ ...formData, marketDataAppSecret: e.target.value })}
                              placeholder="Market data API secret"
                            />
                            <Button
                              variant="outline-secondary"
                              onClick={() => setShowSecrets((s) => ({ ...s, marketDataAppSecret: !s.marketDataAppSecret }))}
                              tabIndex={-1}
                            >
                              {showSecrets['marketDataAppSecret'] ? <BsEyeSlash /> : <BsEye />}
                            </Button>
                          </InputGroup>
                        </Form.Group>
                      </Col>
                    </Row>
                  </>
                )}

                {/* Common App — commented out per regulations
                {formData.useCommonApp && (
                  <Row>
                    <Col md={6}>
                      <Form.Group className="mb-3">
                        <Form.Label>Common App Key</Form.Label>
                        <Form.Control
                          value={formData.commonAppKey ?? ''}
                          onChange={(e) => setFormData({ ...formData, commonAppKey: e.target.value })}
                        />
                      </Form.Group>
                    </Col>
                    <Col md={6}>
                      <Form.Group className="mb-3">
                        <Form.Label>Common App Secret</Form.Label>
                        <InputGroup>
                          <Form.Control
                            type={showSecrets['commonAppSecret'] ? 'text' : 'password'}
                            value={formData.commonAppSecret ?? ''}
                            onChange={(e) => setFormData({ ...formData, commonAppSecret: e.target.value })}
                          />
                          <Button
                            variant="outline-secondary"
                            onClick={() => setShowSecrets((s) => ({ ...s, commonAppSecret: !s.commonAppSecret }))}
                            tabIndex={-1}
                          >
                            {showSecrets['commonAppSecret'] ? <BsEyeSlash /> : <BsEye />}
                          </Button>
                        </InputGroup>
                      </Form.Group>
                    </Col>
                  </Row>
                )}
                */}

                {/* Flags */}
                <Row className="mt-2">
                  <Col md={3}>
                    <Form.Check
                      type="checkbox"
                      label="Enabled"
                      checked={formData.enabled ?? false}
                      onChange={(e) => setFormData({ ...formData, enabled: e.target.checked })}
                    />
                  </Col>
                  <Col md={3}>
                    <Form.Check
                      type="checkbox"
                      label="TOTP Enabled"
                      checked={formData.totpEnabled ?? false}
                      onChange={(e) => setFormData({ ...formData, totpEnabled: e.target.checked })}
                    />
                  </Col>
                  <Col md={3}>
                    <Form.Check
                      type="checkbox"
                      label="WebSocket"
                      checked={formData.webSocketEnabled ?? false}
                      onChange={(e) => setFormData({ ...formData, webSocketEnabled: e.target.checked })}
                    />
                  </Col>
                </Row>
                {isXts && (
                  <Row className="mt-2">
                    <Col md={3}>
                      <Form.Check
                        type="checkbox"
                        label="Use Dealer APIs"
                        checked={formData.useDealerAPIs ?? false}
                        onChange={(e) => setFormData({ ...formData, useDealerAPIs: e.target.checked })}
                      />
                    </Col>
                  </Row>
                )}
              </>
            )}
          </Form>
        )}
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={onClose}>
          {isViewMode ? 'Close' : 'Cancel'}
        </Button>
        {!isViewMode && (brokerTypeSelected || !isCreateMode) && (
          <Button variant="primary" onClick={handleSubmit} disabled={isSaving || !urlsValid}>
            {isSaving ? <><Spinner size="sm" className="me-1" />Saving...</> : (isCreateMode ? 'Add Broker' : 'Update')}
          </Button>
        )}
      </Modal.Footer>
    </Modal>
  );
};

export default Broker;
