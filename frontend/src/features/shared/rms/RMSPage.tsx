/**
 * Shared RMS (Risk Management System) Page
 * Used by both Admin and Client Manager portals
 * Manage hierarchical RMS config, kill switches, and view breach logs
 */

import { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Row, Col, Card, Tab, Tabs, Badge, Alert, Spinner, Table, Form, Button, Modal, ListGroup, InputGroup } from '@/components/ui/rbShim';
import { BsShieldCheck, BsPencil, BsEye, BsGear, BsExclamationTriangle, BsStopCircle, BsPower, BsTrash, BsPlus, BsArrowRepeat, BsSearch, BsX, BsDownload, BsUpload } from 'react-icons/bs';
import { PageHeader, HelpIcon, ConfirmModal } from '@/components/common';
import UserSelect from '@/components/common/UserSelect';
import type { HelpArticle } from '@/types/help';
import { rmsHelpContent } from '@/data/help/rms-help';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { RMSConfig, KillSwitchEntry, KillSwitchLevel, KillSwitchSource, KillSwitchActivateRequest, RMSConfigImportPreviewResult, RMSConfigImportApplyResult } from '@/services/admin/v2AdminService';
import { rmsConfigService, exchangeService, symbolService, v2BrokerService } from '@/services/admin/v2AdminService';
import { usePermissions } from '@/hooks/usePermissions';
import { toast } from 'react-toastify';

const RMSPage: React.FC = () => {
  const [activeTab, setActiveTab] = useState('config');
  const permissions = usePermissions();

  // Permission flags for RMS tool
  const canEdit = permissions.rms.canEdit;

  return (
    <div className="admin-rms">
      <PageHeader
        title="Risk Management System"
        subtitle="Configure RMS parameters and preview effective config"
        icon={<BsShieldCheck size={24} />}
      />

      <Tabs activeKey={activeTab} onSelect={(k) => setActiveTab(k || 'config')} className="mb-4">
        <Tab eventKey="config" title={<><BsGear className="me-1" /> Config</>}>
          <RmsConfigPanel hideEdit={!canEdit} />
        </Tab>
        <Tab eventKey="preview" title={<><BsEye className="me-1" /> Preview Effective Config</>}>
          <EffectiveConfigPreviewPanel />
        </Tab>
      </Tabs>
    </div>
  );
};

// ==================== RMS CONFIG PANEL ====================

interface RmsPanelProps {
  hideEdit?: boolean;
}

const SEGMENT_TYPES = ['EQUITY', 'FUTURES', 'OPTIONS'] as const;
const CONFIG_LEVELS = ['GLOBAL', 'EXCHANGE', 'SYMBOL', 'BROKER', 'USER'] as const;

const RmsConfigPanel: React.FC<RmsPanelProps> = ({ hideEdit }) => {
  const queryClient = useQueryClient();
  const [selectedLevel, setSelectedLevel] = useState<string>('');
  const [selectedSegment, setSelectedSegment] = useState<string>('');
  const [showEditModal, setShowEditModal] = useState(false);
  const [selectedConfig, setSelectedConfig] = useState<RMSConfig | null>(null);
  const [showDisableConfirm, setShowDisableConfirm] = useState(false);
  const [deleteTargetId, setDeleteTargetId] = useState<number | null>(null);

  // Queries
  const { data: configs, isLoading, error, refetch } = useQuery({
    queryKey: ['rms-configs'],
    queryFn: () => rmsConfigService.getAll(),
  });

  const { data: status } = useQuery({
    queryKey: ['rms-status'],
    queryFn: () => rmsConfigService.getStatus(),
    refetchInterval: 30000,
  });

  // Mutations
  const createMutation = useMutation({
    mutationFn: (data: Omit<RMSConfig, 'id'>) => rmsConfigService.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['rms-configs'] });
      toast.success('RMS config created');
      setShowEditModal(false);
    },
    onError: (err: Error) => toast.error(`Failed to create: ${err.message}`),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<RMSConfig> }) => rmsConfigService.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['rms-configs'] });
      toast.success('RMS config updated');
      setShowEditModal(false);
    },
    onError: (err: Error) => toast.error(`Failed to update: ${err.message}`),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => rmsConfigService.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['rms-configs'] });
      toast.success('RMS config deleted');
      setDeleteTargetId(null);
    },
    onError: (err: Error) => toast.error(`Failed to delete: ${err.message}`),
  });

  const toggleServiceMutation = useMutation({
    mutationFn: (enable: boolean) => enable ? rmsConfigService.enable() : rmsConfigService.disable(),
    onSuccess: (_, enable) => {
      queryClient.invalidateQueries({ queryKey: ['rms-status'] });
      toast.success(`RMS service ${enable ? 'enabled' : 'disabled'}`);
    },
  });

  const clearCacheMutation = useMutation({
    mutationFn: () => rmsConfigService.clearCache(),
    onSuccess: () => toast.success('Config cache cleared'),
  });

  // Export/Import state
  const [showImportModal, setShowImportModal] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importPreview, setImportPreview] = useState<RMSConfigImportPreviewResult | null>(null);
  const [importResolutions, setImportResolutions] = useState<Record<string, 'OVERRIDE' | 'SKIP'>>({});
  const [importStep, setImportStep] = useState<1 | 2 | 3>(1);
  const [importLoading, setImportLoading] = useState(false);
  const [importResult, setImportResult] = useState<RMSConfigImportApplyResult | null>(null);

  const resetImportModal = () => {
    setShowImportModal(false);
    setImportFile(null);
    setImportPreview(null);
    setImportResolutions({});
    setImportStep(1);
    setImportResult(null);
  };

  const handleExport = async () => {
    try {
      const blob = await rmsConfigService.exportConfigs();
      const url = window.URL.createObjectURL(new Blob([blob]));
      const link = document.createElement('a');
      link.href = url;
      const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      link.setAttribute('download', `rms-config-export-${dateStr}.xlsx`);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
      toast.success('RMS configs exported');
    } catch (err: any) {
      toast.error('Export failed: ' + (err?.message || err));
    }
  };

  const handleImportPreview = async () => {
    if (!importFile) return;
    setImportLoading(true);
    try {
      const preview = await rmsConfigService.importPreview(importFile);
      setImportPreview(preview);
      const resolutions: Record<string, 'OVERRIDE' | 'SKIP'> = {};
      preview.conflictingConfigs.forEach(key => { resolutions[key] = 'SKIP'; });
      setImportResolutions(resolutions);
      setImportStep(2);
    } catch (err: any) {
      toast.error('Preview failed: ' + (err?.message || err));
    } finally {
      setImportLoading(false);
    }
  };

  const handleImportApply = async () => {
    if (!importFile) return;
    setImportLoading(true);
    try {
      const result = await rmsConfigService.importApply(importFile, importResolutions, 'SKIP');
      setImportResult(result);
      setImportStep(3);
      refetch();
      if (result.errors.length === 0) {
        toast.success(`Imported: ${result.imported} new, ${result.overridden} overridden, ${result.skipped} skipped`);
      } else {
        toast.warning(`Import complete with ${result.errors.length} error(s)`);
      }
    } catch (err: any) {
      toast.error('Import failed: ' + (err?.message || err));
    } finally {
      setImportLoading(false);
    }
  };

  const handleBulkResolution = (resolution: 'OVERRIDE' | 'SKIP') => {
    if (!importPreview) return;
    const resolutions: Record<string, 'OVERRIDE' | 'SKIP'> = {};
    importPreview.conflictingConfigs.forEach(key => { resolutions[key] = resolution; });
    setImportResolutions(resolutions);
  };

  const filteredConfigs = useMemo(() => {
    if (!configs) return [];
    return configs.filter(c => {
      if (selectedLevel && c.configLevel !== selectedLevel) return false;
      if (selectedSegment && c.segmentType !== selectedSegment) return false;
      return true;
    });
  }, [configs, selectedLevel, selectedSegment]);

  const handleCreate = () => {
    setSelectedConfig({
      configLevel: 'GLOBAL',
      isActive: true,
    } as RMSConfig);
    setShowEditModal(true);
  };

  const handleEdit = (config: RMSConfig) => {
    setSelectedConfig(config);
    setShowEditModal(true);
  };

  const handleSave = () => {
    if (!selectedConfig) return;
    if (selectedConfig.id) {
      updateMutation.mutate({ id: selectedConfig.id, data: selectedConfig });
    } else {
      createMutation.mutate(selectedConfig);
    }
  };

  if (error) return <Alert variant="danger">Failed to load RMS configurations</Alert>;

  return (
    <>
      {/* Service Status Bar */}
      <Card className="mb-4">
        <Card.Body className="flex justify-between items-center py-2">
          <div className="flex items-center gap-4">
            <span className="font-medium">RMS Service:</span>
            <Badge bg={status?.enabled ? 'success' : 'danger'}>
              {status?.enabled ? 'ENABLED' : 'DISABLED'}
            </Badge>
            {status && (
              <small className="text-ink-soft">
                {status.activeKillSwitchCount} active kill switch(es)
              </small>
            )}
          </div>
          {!hideEdit && (
            <div className="flex gap-2">
              <Button
                variant={status?.enabled ? 'outline-danger' : 'outline-success'}
                size="sm"
                onClick={() => {
                  if (status?.enabled) {
                    setShowDisableConfirm(true);
                  } else {
                    toggleServiceMutation.mutate(true);
                  }
                }}
                disabled={toggleServiceMutation.isPending}
              >
                <BsPower className="me-1" />
                {status?.enabled ? 'Disable' : 'Enable'}
              </Button>
              <Button
                variant="outline-secondary"
                size="sm"
                onClick={() => clearCacheMutation.mutate()}
                disabled={clearCacheMutation.isPending}
              >
                <BsArrowRepeat className="me-1" /> Clear Cache
              </Button>
              <Button variant="outline-success" size="sm" onClick={handleExport}>
                <BsDownload className="me-1" /> Export
              </Button>
              <Button variant="outline-info" size="sm" onClick={() => { resetImportModal(); setShowImportModal(true); }}>
                <BsUpload className="me-1" /> Import
              </Button>
              <Button variant="primary" size="sm" onClick={handleCreate}>
                <BsPlus className="me-1" /> Add Config
              </Button>
            </div>
          )}
        </Card.Body>
      </Card>

      {/* Filters */}
      <Card className="mb-4">
        <Card.Body className="py-2">
          <Row>
            <Col md={4}>
              <Form.Group className="flex items-center gap-2">
                <Form.Label className="mb-0 whitespace-nowrap">Level:</Form.Label>
                <Form.Select size="sm" value={selectedLevel} onChange={e => setSelectedLevel(e.target.value)}>
                  <option value="">All Levels</option>
                  {CONFIG_LEVELS.map(l => <option key={l} value={l}>{l}</option>)}
                </Form.Select>
              </Form.Group>
            </Col>
            <Col md={4}>
              <Form.Group className="flex items-center gap-2">
                <Form.Label className="mb-0 whitespace-nowrap">Segment:</Form.Label>
                <Form.Select size="sm" value={selectedSegment} onChange={e => setSelectedSegment(e.target.value)}>
                  <option value="">All Segments</option>
                  {SEGMENT_TYPES.map(s => <option key={s} value={s}>{s}</option>)}
                </Form.Select>
              </Form.Group>
            </Col>
            <Col md={4} className="text-end">
              <Button variant="outline-secondary" size="sm" onClick={() => refetch()}>
                <BsArrowRepeat className="me-1" /> Refresh
              </Button>
            </Col>
          </Row>
        </Card.Body>
      </Card>

      {/* Config Table */}
      <Card>
        <Card.Body className="p-0">
          {isLoading ? (
            <div className="text-center py-12">
              <Spinner />
              <p className="mt-2 text-ink-soft">Loading configurations...</p>
            </div>
          ) : filteredConfigs.length === 0 ? (
            <Alert variant="info" className="m-4">No RMS configurations found</Alert>
          ) : (
            <Table striped hover responsive className="mb-0" size="sm">
              <thead>
                <tr>
                  <th>Level</th>
                  <th>Segment</th>
                  <th>Scope</th>
                  <th>Price</th>
                  <th>Orders</th>
                  <th>Loss</th>
                  <th>Active</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredConfigs.map(config => (
                  <tr key={config.id}>
                    <td><Badge bg="secondary">{config.configLevel}</Badge></td>
                    <td><Badge bg="info" text="dark">{config.segmentType || '-'}</Badge></td>
                    <td>
                      <small>
                        {config.username || config.broker || config.symbol || config.exchange || 'Global'}
                      </small>
                    </td>
                    <td>
                      <small>
                        Vol: {config.minVolumeToday || '-'}, Spread: {config.maxBidAskSpreadPct || '-'}%
                      </small>
                    </td>
                    <td>
                      <small>
                        {config.maxOrderOperationsPerSecond || '-'}/ops-sec, {config.maxOrdersPerSecond || '-'}/place-sec, {config.maxOrdersPerMinute || '-'}/min
                      </small>
                    </td>
                    <td>
                      <small>
                        {config.maxDailyLossPct ? `${config.maxDailyLossPct}%` : config.maxDailyLossAmount || '-'}
                      </small>
                    </td>
                    <td>
                      <Badge bg={config.isActive ? 'success' : 'secondary'}>
                        {config.isActive ? 'Yes' : 'No'}
                      </Badge>
                    </td>
                    <td>
                      <div className="flex gap-1">
                        <Button variant="outline-primary" size="sm" onClick={() => handleEdit(config)}>
                          {hideEdit ? <BsEye /> : <BsPencil />}
                        </Button>
                        {!hideEdit && (
                          <Button
                            variant="outline-danger"
                            size="sm"
                            onClick={() => config.id && setDeleteTargetId(config.id)}
                            disabled={deleteMutation.isPending}
                          >
                            <BsTrash />
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card.Body>
        <Card.Footer className="text-ink-soft text-[0.875em]">
          {filteredConfigs.length} configuration(s)
        </Card.Footer>
      </Card>

      {/* Edit Modal */}
      <RmsConfigEditModal
        show={showEditModal}
        config={selectedConfig}
        onHide={() => setShowEditModal(false)}
        onChange={setSelectedConfig}
        onSave={handleSave}
        isLoading={createMutation.isPending || updateMutation.isPending}
        hideEdit={hideEdit}
      />

      {/* Delete RMS Config Confirmation */}
      <ConfirmModal
        show={!!deleteTargetId}
        title="Delete RMS Config"
        message="Are you sure you want to delete this RMS configuration? This action cannot be undone."
        confirmLabel="Delete"
        confirmVariant="danger"
        onConfirm={() => deleteTargetId && deleteMutation.mutate(deleteTargetId)}
        onCancel={() => setDeleteTargetId(null)}
        isLoading={deleteMutation.isPending}
      />

      {/* Import Modal */}
      <Modal show={showImportModal} onHide={resetImportModal} size="lg" centered>
        <Modal.Header closeButton>
          <Modal.Title><BsUpload className="me-2" />Import RMS Config</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {importStep === 1 && (
            <>
              <p className="text-ink-soft mb-4">
                Upload an Excel file (.xlsx) with an <strong>RMS_CONFIG</strong> sheet.
                Only GLOBAL, EXCHANGE, and SYMBOL level configs will be imported.
              </p>
              <Form.Group className="mb-4">
                <Form.Control
                  type="file"
                  accept=".xlsx"
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setImportFile(e.target.files?.[0] || null)}
                />
              </Form.Group>
            </>
          )}

          {importStep === 2 && importPreview && (
            <>
              {importPreview.errors.length > 0 && (
                <Alert variant="danger">
                  <strong>Errors (import blocked):</strong>
                  <ul className="mb-0 mt-1">{importPreview.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
                </Alert>
              )}
              {importPreview.warnings.length > 0 && (
                <Alert variant="warning">
                  <strong>Warnings:</strong>
                  <ul className="mb-0 mt-1">{importPreview.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
                </Alert>
              )}
              <p><strong>{importPreview.totalConfigs}</strong> config(s) in file</p>

              {importPreview.newConfigs.length > 0 && (
                <div className="mb-4">
                  <strong>New configs ({importPreview.newConfigs.length}):</strong>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {importPreview.newConfigs.map(key => (
                      <Badge key={key} bg="success">{key}</Badge>
                    ))}
                  </div>
                </div>
              )}

              {importPreview.conflictingConfigs.length > 0 && (
                <div className="mb-4">
                  <div className="flex justify-between items-center mb-2">
                    <strong>Conflicting configs ({importPreview.conflictingConfigs.length}):</strong>
                    <div className="flex gap-1">
                      <Button size="sm" variant="outline-danger" onClick={() => handleBulkResolution('OVERRIDE')}>
                        Override All
                      </Button>
                      <Button size="sm" variant="outline-secondary" onClick={() => handleBulkResolution('SKIP')}>
                        Skip All
                      </Button>
                    </div>
                  </div>
                  <Table size="sm" bordered>
                    <thead>
                      <tr><th>Config</th><th>Action</th></tr>
                    </thead>
                    <tbody>
                      {importPreview.conflictingConfigs.map(key => (
                        <tr key={key}>
                          <td><code>{key}</code></td>
                          <td>
                            <Form.Check
                              inline type="radio" label="Override" name={`res-${key}`}
                              checked={importResolutions[key] === 'OVERRIDE'}
                              onChange={() => setImportResolutions(prev => ({ ...prev, [key]: 'OVERRIDE' }))}
                            />
                            <Form.Check
                              inline type="radio" label="Skip" name={`res-${key}`}
                              checked={importResolutions[key] === 'SKIP'}
                              onChange={() => setImportResolutions(prev => ({ ...prev, [key]: 'SKIP' }))}
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </div>
              )}
            </>
          )}

          {importStep === 3 && importResult && (
            <>
              <Alert variant={importResult.errors.length === 0 ? 'success' : 'warning'}>
                <strong>Import complete:</strong> {importResult.imported} new, {importResult.overridden} overridden, {importResult.skipped} skipped
              </Alert>
              {importResult.errors.length > 0 && (
                <Alert variant="danger">
                  <strong>Errors:</strong>
                  <ul className="mb-0 mt-1">{importResult.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
                </Alert>
              )}
            </>
          )}
        </Modal.Body>
        <Modal.Footer>
          {importStep === 1 && (
            <>
              <Button variant="secondary" onClick={resetImportModal}>Cancel</Button>
              <Button variant="primary" onClick={handleImportPreview} disabled={!importFile || importLoading}>
                {importLoading ? <Spinner size="sm" /> : 'Upload & Preview'}
              </Button>
            </>
          )}
          {importStep === 2 && (
            <>
              <Button variant="secondary" onClick={() => setImportStep(1)}>Back</Button>
              <Button
                variant="primary"
                onClick={handleImportApply}
                disabled={importLoading || (importPreview?.errors?.length ?? 0) > 0}
              >
                {importLoading ? <Spinner size="sm" /> : 'Apply Import'}
              </Button>
            </>
          )}
          {importStep === 3 && (
            <Button variant="secondary" onClick={resetImportModal}>Close</Button>
          )}
        </Modal.Footer>
      </Modal>

      {/* Disable RMS Confirmation Modal */}
      <Modal show={showDisableConfirm} onHide={() => setShowDisableConfirm(false)} centered>
        <Modal.Header closeButton className="bg-danger-600 text-white">
          <Modal.Title><BsExclamationTriangle className="me-2" />Disable RMS Service</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Alert variant="danger" className="mb-4">
            <strong>You are about to disable the Risk Management System.</strong>
          </Alert>
          <p>When RMS is disabled, the following protections are <strong>completely bypassed</strong>:</p>
          <ul className="mb-4">
            <li><strong>Price validation</strong> — stale prices, bid-ask spread checks, and freak price detection will not run</li>
            <li><strong>Order limits</strong> — no enforcement of max quantity, rate limits, or freeze quantity checks</li>
            <li><strong>Position limits</strong> — no caps on total positions, orders per symbol, or buy/sell quantities</li>
            <li><strong>Daily loss protection</strong> — loss limits will not trigger kill switches or auto square-off</li>
            <li><strong>Circuit breakers</strong> — rejection rate and VIX-based circuit breakers will not activate</li>
          </ul>
          <Alert variant="warning" className="mb-0">
            All orders will be sent to brokers without any risk checks. Only disable this if you have a specific reason and plan to re-enable it promptly.
          </Alert>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={() => setShowDisableConfirm(false)}>Cancel</Button>
          <Button
            variant="danger"
            onClick={() => {
              toggleServiceMutation.mutate(false);
              setShowDisableConfirm(false);
            }}
            disabled={toggleServiceMutation.isPending}
          >
            {toggleServiceMutation.isPending ? <Spinner size="sm" /> : 'Disable RMS'}
          </Button>
        </Modal.Footer>
      </Modal>
    </>
  );
};

// ==================== SEARCHABLE USER SELECT ====================

interface SearchableUserSelectProps {
  value: string | null | undefined;
  onChange: (username: string | null) => void;
  disabled?: boolean;
  placeholder?: string;
}

const SearchableUserSelect: React.FC<SearchableUserSelectProps> = ({
  value,
  onChange,
  disabled = false,
  placeholder = 'Search and select user...',
}) => {
  // Remote, server-paginated user search (no whole-user-list load). Maps UserSelect's string
  // value/onChange onto this component's nullable contract so the existing call sites are unchanged.
  return (
    <UserSelect
      value={value || ''}
      onChange={(username) => onChange(username || null)}
      includeAllOption={false}
      placeholder={placeholder}
      isDisabled={disabled}
    />
  );
};

// ==================== SEARCHABLE BROKER SELECT ====================

interface SearchableBrokerSelectProps {
  value: string | null | undefined;
  onChange: (broker: string | null) => void;
  disabled?: boolean;
  placeholder?: string;
}

const SearchableBrokerSelect: React.FC<SearchableBrokerSelectProps> = ({
  value,
  onChange,
  disabled = false,
  placeholder = 'Search and select broker...',
}) => {
  const [search, setSearch] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number; width: number }>({ top: 0, left: 0, width: 0 });

  const { data: brokers, isLoading } = useQuery({
    queryKey: ['brokers'],
    queryFn: () => v2BrokerService.getAll(),
  });

  const filteredBrokers = useMemo(() => {
    if (!brokers) return [];
    if (!search) return brokers;

    const searchLower = search.toLowerCase();
    return brokers.filter(b =>
      b.name?.toLowerCase().includes(searchLower) ||
      b.displayName?.toLowerCase().includes(searchLower)
    );
  }, [brokers, search]);

  const updateDropdownPos = useCallback(() => {
    if (wrapperRef.current) {
      const rect = wrapperRef.current.getBoundingClientRect();
      setDropdownPos({ top: rect.bottom, left: rect.left, width: rect.width });
    }
  }, []);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        wrapperRef.current && !wrapperRef.current.contains(target) &&
        dropdownRef.current && !dropdownRef.current.contains(target)
      ) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSelect = (name: string) => {
    onChange(name);
    setSearch('');
    setIsOpen(false);
  };

  const handleClear = () => {
    onChange(null);
    setSearch('');
  };

  const openDropdown = () => {
    updateDropdownPos();
    setIsOpen(true);
  };

  return (
    <div ref={wrapperRef}>
      <InputGroup>
        <InputGroup.Text><BsSearch /></InputGroup.Text>
        <Form.Control
          type="text"
          value={value || search}
          onChange={(e) => {
            if (value) onChange(null);
            setSearch(e.target.value);
            openDropdown();
          }}
          onFocus={openDropdown}
          placeholder={placeholder}
          disabled={disabled}
        />
        {value && !disabled && (
          <Button variant="outline-secondary" onClick={handleClear} title="Clear">
            <BsX />
          </Button>
        )}
      </InputGroup>

      {isOpen && !disabled && createPortal(
        <div
          ref={dropdownRef}
          // bg-card: the shim ListGroup has no background of its own (Bootstrap's
          // was opaque) — without it this floating panel is transparent over the
          // modal text behind it. Theme-aware token, opaque in light and dark.
          className="rounded-card bg-card"
          style={{
            position: 'fixed',
            top: dropdownPos.top,
            left: dropdownPos.left,
            width: dropdownPos.width,
            // Must beat the shim Modal overlay (z-[1100]) — this dropdown
            // portals to document.body, and the config edit modal buried it
            // when the Tailwind migration raised the modal above Bootstrap's
            // old 1055.
            zIndex: 1200,
            maxHeight: '200px',
            overflowY: 'auto',
            boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
          }}
        >
          <ListGroup>
            {isLoading ? (
              <ListGroup.Item className="text-center py-2">
                <Spinner size="sm" /> Loading brokers...
              </ListGroup.Item>
            ) : filteredBrokers.length === 0 ? (
              <ListGroup.Item className="text-ink-soft">No brokers found</ListGroup.Item>
            ) : (
              filteredBrokers.map((broker) => (
                <ListGroup.Item
                  key={broker.name}
                  action
                  onClick={() => handleSelect(broker.name)}
                  className="py-2"
                >
                  <div className="flex justify-between items-center">
                    <div>
                      <strong>{broker.name}</strong>
                      {broker.displayName && <small className="text-ink-soft ms-2">({broker.displayName})</small>}
                    </div>
                    <Badge bg={broker.enabled ? 'success' : 'secondary'}>{broker.enabled ? 'Active' : 'Inactive'}</Badge>
                  </div>
                </ListGroup.Item>
              ))
            )}
          </ListGroup>
        </div>,
        document.body
      )}
    </div>
  );
};

// ==================== RMS CONFIG EDIT MODAL ====================

interface RmsConfigEditModalProps {
  show: boolean;
  config: RMSConfig | null;
  onHide: () => void;
  onChange: (config: RMSConfig) => void;
  onSave: () => void;
  isLoading: boolean;
  hideEdit?: boolean;
}

// Helper component for form fields with help text
const FormField: React.FC<{
  label: string;
  help?: string;
  helpArticle?: HelpArticle;
  children: React.ReactNode;
}> = ({ label, help, helpArticle, children }) => (
  <Form.Group className="mb-4">
    <Form.Label className="text-[0.875em] font-medium flex items-center">
      {label}
      {helpArticle && <HelpIcon article={helpArticle} />}
    </Form.Label>
    {children}
    {help && <Form.Text className="text-ink-soft block mt-1">{help}</Form.Text>}
  </Form.Group>
);

const RmsConfigEditModal: React.FC<RmsConfigEditModalProps> = ({
  show, config, onHide, onChange, onSave, isLoading, hideEdit
}) => {
  const [activeTab, setActiveTab] = useState('price');

  const { data: exchanges } = useQuery({
    queryKey: ['exchanges'],
    queryFn: () => exchangeService.getAll(),
  });

  const { data: symbols } = useQuery({
    queryKey: ['symbols'],
    queryFn: () => symbolService.getAll(),
  });

  // Fetch field-level applicability from server (cached, rarely changes)
  const { data: fieldApplicability } = useQuery({
    queryKey: ['rms-field-applicability'],
    queryFn: () => rmsConfigService.getFieldApplicability(),
    staleTime: 10 * 60 * 1000, // cache for 10 minutes
  });

  if (!config) return null;

  const level = config.configLevel || 'GLOBAL';

  /** Check if a field is applicable at the current config level */
  const isFieldApplicable = (field: string): boolean => {
    if (!fieldApplicability) return true; // allow all while loading
    const allowedLevels = fieldApplicability[field];
    return !allowedLevels || allowedLevels.includes(level);
  };

  /** Returns true if the field should be disabled (either not editable or not applicable at this level) */
  const fieldDisabled = (field: keyof RMSConfig): boolean =>
    !!hideEdit || !isFieldApplicable(field);

  /** Returns "N/A at {level} level" hint if field is not applicable */
  const naHint = (field: keyof RMSConfig): string | undefined =>
    !isFieldApplicable(field) ? `Not applicable at ${level} level` : undefined;

  const updateField = (field: keyof RMSConfig, value: unknown) => {
    onChange({ ...config, [field]: value });
  };

  const handleSymbolChange = (symbolName: string | null) => {
    const sym = symbols?.find(s => s.symbol === symbolName);
    onChange({
      ...config,
      symbol: symbolName,
      exchange: sym?.exchange || config.exchange,
    });
  };

  const numValue = (val: number | null | undefined) => val ?? '';
  const setNum = (field: keyof RMSConfig) => (e: React.ChangeEvent<HTMLInputElement>) =>
    updateField(field, e.target.value ? Number(e.target.value) : null);
  const setBool = (field: keyof RMSConfig) => (e: React.ChangeEvent<HTMLInputElement>) =>
    updateField(field, e.target.checked);

  // TRI-STATE booleans for override fields on non-GLOBAL levels: a switch can
  // only say true/false, so "clear everything and save" silently stored
  // skipPriceValidationForExit=false as a BROKER override — disabling the
  // exit exemption and rejecting every in-profit SL order at the deviation
  // cap (live 2026-07-23). Inherit (null) must be expressible; the server's
  // hierarchy merge treats null as inherit-from-parent. GLOBAL keeps the
  // plain switch — there is no parent to inherit from.
  const renderBool = (field: keyof RMSConfig) => {
    if (level === 'GLOBAL') {
      return (
        <Form.Check
          type="switch"
          checked={(config[field] as boolean | null | undefined) ?? false}
          onChange={setBool(field)}
          disabled={fieldDisabled(field)}
        />
      );
    }
    const val = config[field] as boolean | null | undefined;
    return (
      <Form.Select
        value={val === true ? 'true' : val === false ? 'false' : ''}
        onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
          updateField(field, e.target.value === '' ? null : e.target.value === 'true')}
        disabled={fieldDisabled(field)}
      >
        <option value="">Inherit from parent</option>
        <option value="true">On (override)</option>
        <option value="false">Off (override)</option>
      </Form.Select>
    );
  };

  return (
    <Modal show={show} onHide={onHide} size="xl" dialogClassName="modal-90w" backdrop="static">
      <Modal.Header closeButton>
        <Modal.Title>{config.id ? 'Edit' : 'Create'} RMS Configuration</Modal.Title>
      </Modal.Header>
      <Modal.Body style={{ maxHeight: '70vh', overflowY: 'auto' }}>
        {/* ==================== SCOPE (always visible) ==================== */}
        <Card className="mb-4">
          <Card.Header className="py-2"><small className="font-medium text-ink-soft">Scope</small></Card.Header>
          <Card.Body className="py-2">
            <Row>
              <Col md={3}>
                <FormField label="Config Level" help="Hierarchy level - lower levels override higher levels">
                  <Form.Select
                    size="sm"
                    value={config.configLevel || 'GLOBAL'}
                    onChange={e => updateField('configLevel', e.target.value)}
                    disabled={hideEdit}
                  >
                    {CONFIG_LEVELS.map(l => <option key={l} value={l}>{l}</option>)}
                  </Form.Select>
                </FormField>
              </Col>
              <Col md={2}>
                <FormField label="Segment" help="Segment type is required">
                  <Form.Select
                    size="sm"
                    value={config.segmentType || ''}
                    onChange={e => updateField('segmentType', e.target.value || null)}
                    disabled={hideEdit}
                  >
                    <option value="" disabled>Select segment</option>
                    {SEGMENT_TYPES.map(s => <option key={s} value={s}>{s}</option>)}
                  </Form.Select>
                </FormField>
              </Col>
              <Col md={2}>
                <FormField label="Exchange" help={config.configLevel === 'SYMBOL' ? 'Auto-set from symbol' : 'Required for EXCHANGE level'}>
                  <Form.Select
                    size="sm"
                    value={config.exchange || ''}
                    onChange={e => updateField('exchange', e.target.value || null)}
                    disabled={hideEdit || config.configLevel === 'GLOBAL' || config.configLevel === 'SYMBOL'}
                  >
                    <option value="">{config.configLevel === 'GLOBAL' ? 'N/A' : 'Select...'}</option>
                    {exchanges?.map(ex => (
                      <option key={ex.exchange} value={ex.exchange}>{ex.exchange}</option>
                    ))}
                  </Form.Select>
                </FormField>
              </Col>
              <Col md={2}>
                <FormField label="FnO Symbol" help="FnO underlying (NIFTY, BANKNIFTY)">
                  <Form.Select
                    size="sm"
                    value={config.symbol || ''}
                    onChange={e => handleSymbolChange(e.target.value || null)}
                    disabled={hideEdit || !['SYMBOL', 'BROKER', 'USER'].includes(config.configLevel || '')}
                  >
                    <option value="">{['SYMBOL', 'BROKER', 'USER'].includes(config.configLevel || '') ? 'Select...' : 'N/A'}</option>
                    {symbols?.map(sym => (
                      <option key={sym.symbol} value={sym.symbol}>{sym.symbol}</option>
                    ))}
                  </Form.Select>
                </FormField>
              </Col>
              <Col md={2}>
                <FormField label="Active" help="Inactive configs are ignored">
                  <Form.Check
                    type="switch"
                    checked={config.isActive ?? true}
                    onChange={setBool('isActive')}
                    disabled={hideEdit}
                    label={config.isActive ? 'Active' : 'Inactive'}
                  />
                </FormField>
              </Col>
            </Row>
            {['BROKER', 'USER'].includes(config.configLevel || '') && (
              <Row>
                <Col md={4}>
                  <FormField label="Broker" help="Broker name - for BROKER and USER levels">
                    <SearchableBrokerSelect
                      value={config.broker}
                      onChange={(broker) => updateField('broker', broker)}
                      disabled={hideEdit}
                      placeholder="Search broker..."
                    />
                  </FormField>
                </Col>
                {config.configLevel === 'USER' && (
                  <Col md={4}>
                    <FormField label="Username" help="Required for USER level only">
                      <SearchableUserSelect
                        value={config.username}
                        onChange={(username) => updateField('username', username)}
                        disabled={hideEdit}
                        placeholder="Search user..."
                      />
                    </FormField>
                  </Col>
                )}
              </Row>
            )}
          </Card.Body>
        </Card>

        {/* ==================== CONFIG TABS ==================== */}
        <Tabs activeKey={activeTab} onSelect={(k) => setActiveTab(k || 'price')} className="mb-4">
          {/* ==================== PRICE VALIDATION TAB ==================== */}
          <Tab eventKey="price" title="Price Validation">
            <Row>
              <Col md={3}>
                <FormField label="Stale Price (sec)" help={naHint('stalePriceSeconds') || "Reject if last trade older than this many seconds"} helpArticle={rmsHelpContent['rms.stalePriceSeconds']}>
                  <Form.Control type="number" value={numValue(config.stalePriceSeconds)} onChange={setNum('stalePriceSeconds')} disabled={fieldDisabled('stalePriceSeconds')} />
                </FormField>
              </Col>
              <Col md={3}>
                <FormField label="Early Market Grace (sec)" help={naHint('earlyMarketGraceSeconds') || "Skip stale check for first N seconds after market open"} helpArticle={rmsHelpContent['rms.earlyMarketGraceSeconds']}>
                  <Form.Control type="number" value={numValue(config.earlyMarketGraceSeconds)} onChange={setNum('earlyMarketGraceSeconds')} disabled={fieldDisabled('earlyMarketGraceSeconds')} />
                </FormField>
              </Col>
              <Col md={3}>
                <FormField label="Min Volume Today" help={naHint('minVolumeToday') || "Minimum traded volume required today"} helpArticle={rmsHelpContent['rms.minVolumeToday']}>
                  <Form.Control type="number" value={numValue(config.minVolumeToday)} onChange={setNum('minVolumeToday')} disabled={fieldDisabled('minVolumeToday')} />
                </FormField>
              </Col>
              <Col md={3}>
                <FormField label="Min Volume Early Market" help={naHint('minVolumeEarlyMarket') || "Min volume during early market period"} helpArticle={rmsHelpContent['rms.minVolumeEarlyMarket']}>
                  <Form.Control type="number" value={numValue(config.minVolumeEarlyMarket)} onChange={setNum('minVolumeEarlyMarket')} disabled={fieldDisabled('minVolumeEarlyMarket')} />
                </FormField>
              </Col>
            </Row>
            <Row>
              <Col md={3}>
                <FormField label="Min Vol Early Period (sec)" help={naHint('minVolumeEarlyPeriodSeconds') || "Separate early period (seconds) for min volume check"} helpArticle={rmsHelpContent['rms.minVolumeEarlyPeriodSeconds']}>
                  <Form.Control type="number" value={numValue(config.minVolumeEarlyPeriodSeconds)} onChange={setNum('minVolumeEarlyPeriodSeconds')} disabled={fieldDisabled('minVolumeEarlyPeriodSeconds')} />
                </FormField>
              </Col>
              <Col md={3}>
                <FormField label="Min Open Interest" help={naHint('minOpenInterest') || "Min OI required (OPTIONS segment only)"} helpArticle={rmsHelpContent['rms.minOpenInterest']}>
                  <Form.Control type="number" value={numValue(config.minOpenInterest)} onChange={setNum('minOpenInterest')} disabled={fieldDisabled('minOpenInterest')} />
                </FormField>
              </Col>
            </Row>
            <Row>
              <Col md={3}>
                <FormField label="Max Bid-Ask Spread %" help={naHint('maxBidAskSpreadPct') || "Reject if spread exceeds this percentage"} helpArticle={rmsHelpContent['rms.maxBidAskSpreadPct']}>
                  <Form.Control type="number" step="0.1" value={numValue(config.maxBidAskSpreadPct)} onChange={setNum('maxBidAskSpreadPct')} disabled={fieldDisabled('maxBidAskSpreadPct')} />
                </FormField>
              </Col>
              <Col md={3}>
                <FormField label="Max Spread Absolute" help={naHint('maxBidAskSpreadAbsolute') || "For low-priced instruments, use absolute spread check"} helpArticle={rmsHelpContent['rms.maxBidAskSpreadAbsolute']}>
                  <Form.Control type="number" step="0.1" value={numValue(config.maxBidAskSpreadAbsolute)} onChange={setNum('maxBidAskSpreadAbsolute')} disabled={fieldDisabled('maxBidAskSpreadAbsolute')} />
                </FormField>
              </Col>
              <Col md={3}>
                <FormField label="Absolute Threshold Price" help={naHint('bidAskAbsoluteThresholdPrice') || "Use absolute spread below this price"} helpArticle={rmsHelpContent['rms.bidAskAbsoluteThresholdPrice']}>
                  <Form.Control type="number" step="0.1" value={numValue(config.bidAskAbsoluteThresholdPrice)} onChange={setNum('bidAskAbsoluteThresholdPrice')} disabled={fieldDisabled('bidAskAbsoluteThresholdPrice')} />
                </FormField>
              </Col>
            </Row>
            <Row>
              <Col md={3}>
                <FormField label="Min Depth Quantity" help={naHint('minDepthQuantity') || "Minimum quantity in order book depth"} helpArticle={rmsHelpContent['rms.minDepthQuantity']}>
                  <Form.Control type="number" value={numValue(config.minDepthQuantity)} onChange={setNum('minDepthQuantity')} disabled={fieldDisabled('minDepthQuantity')} />
                </FormField>
              </Col>
              <Col md={3}>
                <FormField label="Min Depth Levels" help={naHint('minDepthLevels') || "Minimum order book levels required"} helpArticle={rmsHelpContent['rms.minDepthLevels']}>
                  <Form.Control type="number" value={numValue(config.minDepthLevels)} onChange={setNum('minDepthLevels')} disabled={fieldDisabled('minDepthLevels')} />
                </FormField>
              </Col>
              <Col md={3}>
                <FormField label="Enable Freak Price Check" help={naHint('enableFreakPriceCheck') || "Detect abnormal price spikes (for options)"} helpArticle={rmsHelpContent['rms.enableFreakPriceCheck']}>
                  {renderBool('enableFreakPriceCheck')}
                </FormField>
              </Col>
              <Col md={3}>
                <FormField label="Freak Check Min Price" help={naHint('freakCheckMinPrice') || "Apply freak check only above this price"} helpArticle={rmsHelpContent['rms.freakCheckMinPrice']}>
                  <Form.Control type="number" step="0.1" value={numValue(config.freakCheckMinPrice)} onChange={setNum('freakCheckMinPrice')} disabled={fieldDisabled('freakCheckMinPrice')} />
                </FormField>
              </Col>
            </Row>
            <Row>
              <Col md={3}>
                <FormField label="Max Price Deviation %" help={naHint('maxPriceDeviationPct') || "Reject if order price deviates more than this % from LTP (paired with abs cap — only rejected if BOTH exceed)"} helpArticle={rmsHelpContent['rms.maxPriceDeviationPct']}>
                  <Form.Control type="number" step="0.1" value={numValue(config.maxPriceDeviationPct)} onChange={setNum('maxPriceDeviationPct')} disabled={fieldDisabled('maxPriceDeviationPct')} />
                </FormField>
              </Col>
              <Col md={3}>
                <FormField label="Max Price Deviation Abs (₹)" help={naHint('maxPriceDeviationAbs') || "Absolute rupee cap on |orderPrice - LTP|. Pairs with % cap — order passes if EITHER is within limit. Accommodates aggressive MARKET→LIMIT rewrites on cheap options."} helpArticle={rmsHelpContent['rms.maxPriceDeviationAbs']}>
                  <Form.Control type="number" step="0.1" value={numValue(config.maxPriceDeviationAbs)} onChange={setNum('maxPriceDeviationAbs')} disabled={fieldDisabled('maxPriceDeviationAbs')} />
                </FormField>
              </Col>
              <Col md={3}>
                <FormField label="Skip Price Validation for Exit" help={naHint('skipPriceValidationForExit') || "Allow exit orders even if price validation fails"} helpArticle={rmsHelpContent['rms.skipPriceValidationForExit']}>
                  {renderBool('skipPriceValidationForExit')}
                </FormField>
              </Col>
            </Row>
          </Tab>

          {/* ==================== ORDER & POSITION LIMITS TAB ==================== */}
          <Tab eventKey="orders" title="Order & Position Limits">
            {/* Row 1 — Per-Order Limits */}
            <Row>
              <Col md={3}>
                <FormField label="Max Qty Per Order" help={naHint('maxOrderQty') || "Maximum quantity in a single order"} helpArticle={rmsHelpContent['rms.maxOrderQty']}>
                  <Form.Control type="number" value={numValue(config.maxOrderQty)} onChange={setNum('maxOrderQty')} disabled={fieldDisabled('maxOrderQty')} />
                </FormField>
              </Col>
              <Col md={3}>
                <FormField label="Max Lots Per Order" help={naHint('maxOrderQtyLots') || "Max lots allowed in a single FnO order"} helpArticle={rmsHelpContent['rms.maxOrderQtyLots']}>
                  <Form.Control type="number" value={numValue(config.maxOrderQtyLots)} onChange={setNum('maxOrderQtyLots')} disabled={fieldDisabled('maxOrderQtyLots')} />
                </FormField>
              </Col>
              <Col md={3}>
                <FormField label="Max Value Per Order" help={naHint('maxOrderValue') || "Price x Qty x Multiplier (premium-based for options, multiplied by lot size)"} helpArticle={rmsHelpContent['rms.maxOrderValue']}>
                  <Form.Control type="number" value={numValue(config.maxOrderValue)} onChange={setNum('maxOrderValue')} disabled={fieldDisabled('maxOrderValue')} />
                </FormField>
              </Col>
              <Col md={3}>
                <FormField label="Enable Freeze Qty Check" help={naHint('enableFreezeQtyCheck') || "Check against exchange freeze quantity limits"} helpArticle={rmsHelpContent['rms.enableFreezeQtyCheck']}>
                  {renderBool('enableFreezeQtyCheck')}
                </FormField>
              </Col>
            </Row>
            {/* Row 2 — Rate Limits */}
            <Row>
              <Col md={3}>
                <FormField label="Max Ops/Second" help={naHint('maxOrderOperationsPerSecond') || "Combined place, modify, and cancel limit per second"} helpArticle={rmsHelpContent['rms.maxOrderOperationsPerSecond']}>
                  <Form.Control type="number" value={numValue(config.maxOrderOperationsPerSecond)} onChange={setNum('maxOrderOperationsPerSecond')} disabled={fieldDisabled('maxOrderOperationsPerSecond')} placeholder="10" />
                </FormField>
              </Col>
              <Col md={3}>
                <FormField label="Max Orders/Second" help={naHint('maxOrdersPerSecond') || "Broker rate limit (default 10/sec)"} helpArticle={rmsHelpContent['rms.maxOrdersPerSecond']}>
                  <Form.Control type="number" value={numValue(config.maxOrdersPerSecond)} onChange={setNum('maxOrdersPerSecond')} disabled={fieldDisabled('maxOrdersPerSecond')} placeholder="10" />
                </FormField>
              </Col>
              <Col md={3}>
                <FormField label="Max Orders/Minute" help={naHint('maxOrdersPerMinute') || "Throttle orders per minute"} helpArticle={rmsHelpContent['rms.maxOrdersPerMinute']}>
                  <Form.Control type="number" value={numValue(config.maxOrdersPerMinute)} onChange={setNum('maxOrdersPerMinute')} disabled={fieldDisabled('maxOrdersPerMinute')} />
                </FormField>
              </Col>
              <Col md={3}>
                <FormField label="Max Orders/Day" help={naHint('maxOrdersPerDay') || "Total orders allowed per day"} helpArticle={rmsHelpContent['rms.maxOrdersPerDay']}>
                  <Form.Control type="number" value={numValue(config.maxOrdersPerDay)} onChange={setNum('maxOrdersPerDay')} disabled={fieldDisabled('maxOrdersPerDay')} />
                </FormField>
              </Col>
            </Row>
            {/* Row 3 — Daily Order Counts */}
            <Row>
              <Col md={3}>
                <FormField label="Max Buy Orders/Day" help={naHint('maxBuyOrdersPerDay') || "Total buy orders allowed per day"} helpArticle={rmsHelpContent['rms.maxBuyOrdersPerDay']}>
                  <Form.Control type="number" value={numValue(config.maxBuyOrdersPerDay)} onChange={setNum('maxBuyOrdersPerDay')} disabled={fieldDisabled('maxBuyOrdersPerDay')} />
                </FormField>
              </Col>
              <Col md={3}>
                <FormField label="Max Sell Orders/Day" help={naHint('maxSellOrdersPerDay') || "Total sell orders allowed per day"} helpArticle={rmsHelpContent['rms.maxSellOrdersPerDay']}>
                  <Form.Control type="number" value={numValue(config.maxSellOrdersPerDay)} onChange={setNum('maxSellOrdersPerDay')} disabled={fieldDisabled('maxSellOrdersPerDay')} />
                </FormField>
              </Col>
              <Col md={3}>
                <FormField label="Max Orders/Symbol/Day" help={naHint('maxOrdersPerSymbolPerDay') || "Limit orders per symbol per day"} helpArticle={rmsHelpContent['rms.maxOrdersPerSymbolPerDay']}>
                  <Form.Control type="number" value={numValue(config.maxOrdersPerSymbolPerDay)} onChange={setNum('maxOrdersPerSymbolPerDay')} disabled={fieldDisabled('maxOrdersPerSymbolPerDay')} />
                </FormField>
              </Col>
            </Row>
            {/* Row 4 — Position Limits */}
            <Row>
              <Col md={3}>
                <FormField label="Max Total Positions" help={naHint('maxTotalPositions') || "Maximum open positions across all symbols"} helpArticle={rmsHelpContent['rms.maxTotalPositions']}>
                  <Form.Control type="number" value={numValue(config.maxTotalPositions)} onChange={setNum('maxTotalPositions')} disabled={fieldDisabled('maxTotalPositions')} />
                </FormField>
              </Col>
              <Col md={3}>
                <FormField label="Max Total Combos" help={naHint('maxTotalCombos') || "Max multi-leg combos open at once — counted once per combo, separate from position count"} helpArticle={rmsHelpContent['rms.maxTotalCombos']}>
                  <Form.Control type="number" value={numValue(config.maxTotalCombos)} onChange={setNum('maxTotalCombos')} disabled={fieldDisabled('maxTotalCombos')} />
                </FormField>
              </Col>
              <Col md={3}>
                <FormField label="Max Position Qty/Symbol" help={naHint('maxPositionQtyPerSymbol') || "Max position qty per symbol (checked against broker order book)"} helpArticle={rmsHelpContent['rms.maxPositionQtyPerSymbol']}>
                  <Form.Control type="number" value={numValue(config.maxPositionQtyPerSymbol)} onChange={setNum('maxPositionQtyPerSymbol')} disabled={fieldDisabled('maxPositionQtyPerSymbol')} />
                </FormField>
              </Col>
            </Row>
            {/* Row 5 — Daily Qty per Symbol */}
            <Row>
              <Col md={3}>
                <FormField label="Max Buy Qty/Symbol/Day" help={naHint('maxBuyQtyPerSymbolPerDay') || "Max buy quantity per symbol per day"} helpArticle={rmsHelpContent['rms.maxBuyQtyPerSymbolPerDay']}>
                  <Form.Control type="number" value={numValue(config.maxBuyQtyPerSymbolPerDay)} onChange={setNum('maxBuyQtyPerSymbolPerDay')} disabled={fieldDisabled('maxBuyQtyPerSymbolPerDay')} />
                </FormField>
              </Col>
              <Col md={3}>
                <FormField label="Max Sell Qty/Symbol/Day" help={naHint('maxSellQtyPerSymbolPerDay') || "Max sell quantity per symbol per day"} helpArticle={rmsHelpContent['rms.maxSellQtyPerSymbolPerDay']}>
                  <Form.Control type="number" value={numValue(config.maxSellQtyPerSymbolPerDay)} onChange={setNum('maxSellQtyPerSymbolPerDay')} disabled={fieldDisabled('maxSellQtyPerSymbolPerDay')} />
                </FormField>
              </Col>
            </Row>
          </Tab>

          {/* ==================== LOSS PROTECTION TAB ==================== */}
          <Tab eventKey="loss" title="Loss Protection">
            <Row>
              <Col md={3}>
                <FormField label="Max Daily Loss Amount" help={naHint('maxDailyLossAmount') || "Absolute daily loss limit in INR"} helpArticle={rmsHelpContent['rms.maxDailyLossAmount']}>
                  <Form.Control type="number" value={numValue(config.maxDailyLossAmount)} onChange={setNum('maxDailyLossAmount')} disabled={fieldDisabled('maxDailyLossAmount')} />
                </FormField>
              </Col>
              <Col md={3}>
                <FormField label="Max Daily Loss %" help={naHint('maxDailyLossPct') || "Daily loss limit as % of deployed capital"} helpArticle={rmsHelpContent['rms.maxDailyLossPct']}>
                  <Form.Control type="number" step="0.1" value={numValue(config.maxDailyLossPct)} onChange={setNum('maxDailyLossPct')} disabled={fieldDisabled('maxDailyLossPct')} />
                </FormField>
              </Col>
              <Col md={3}>
                <FormField label="Auto Kill on Loss" help={naHint('enableAutoKillOnLoss') || "Activate kill switch when daily loss limit breached"} helpArticle={rmsHelpContent['rms.enableAutoKillOnLoss']}>
                  {renderBool('enableAutoKillOnLoss')}
                </FormField>
              </Col>
              <Col md={3}>
                <FormField label="Auto Square-off on Breach" help={naHint('autoSquareOffOnBreach') || "Close all positions when loss limit breached"} helpArticle={rmsHelpContent['rms.autoSquareOffOnBreach']}>
                  {renderBool('autoSquareOffOnBreach')}
                </FormField>
              </Col>
            </Row>
          </Tab>

          {/* ==================== CIRCUIT BREAKERS TAB ==================== */}
          <Tab eventKey="circuit" title="Circuit Breakers">
            <Row>
              <Col md={3}>
                <FormField label="Max Rejection Rate %" help={naHint('maxRejectionRatePct') || "Circuit breaker if order rejections exceed this %"} helpArticle={rmsHelpContent['rms.maxRejectionRatePct']}>
                  <Form.Control type="number" step="0.1" value={numValue(config.maxRejectionRatePct)} onChange={setNum('maxRejectionRatePct')} disabled={fieldDisabled('maxRejectionRatePct')} />
                </FormField>
              </Col>
              <Col md={3}>
                <FormField label="Max VIX Level" help={naHint('maxVixLevel') || "Pause trading if VIX exceeds this level"} helpArticle={rmsHelpContent['rms.maxVixLevel']}>
                  <Form.Control type="number" step="0.1" value={numValue(config.maxVixLevel)} onChange={setNum('maxVixLevel')} disabled={fieldDisabled('maxVixLevel')} />
                </FormField>
              </Col>
              <Col md={3}>
                <FormField label="Volatility Pause (min)" help={naHint('volatilityPauseMinutes') || "Pause duration when volatility circuit breaker triggers"} helpArticle={rmsHelpContent['rms.volatilityPauseMinutes']}>
                  <Form.Control type="number" value={numValue(config.volatilityPauseMinutes)} onChange={setNum('volatilityPauseMinutes')} disabled={fieldDisabled('volatilityPauseMinutes')} />
                </FormField>
              </Col>
            </Row>
          </Tab>
        </Tabs>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={onHide}>Cancel</Button>
        {!hideEdit && (
          <Button variant="primary" onClick={onSave} disabled={isLoading}>
            {isLoading ? <Spinner size="sm" /> : 'Save'}
          </Button>
        )}
      </Modal.Footer>
    </Modal>
  );
};

// ==================== EFFECTIVE CONFIG PREVIEW PANEL ====================

/** Human-readable labels for RMS config fields, grouped by category */
const RMS_FIELD_LABELS: { category: string; fields: { key: string; label: string }[] }[] = [
  {
    category: 'Price Validation',
    fields: [
      { key: 'stalePriceSeconds', label: 'Stale Price (sec)' },
      { key: 'earlyMarketGraceSeconds', label: 'Early Market Grace (sec)' },
      { key: 'minVolumeToday', label: 'Min Volume Today' },
      { key: 'minVolumeEarlyMarket', label: 'Min Volume Early Market' },
      { key: 'minVolumeEarlyPeriodSeconds', label: 'Min Vol Early Period (sec)' },
      { key: 'minOpenInterest', label: 'Min Open Interest' },
      { key: 'maxBidAskSpreadPct', label: 'Max Bid-Ask Spread %' },
      { key: 'maxBidAskSpreadAbsolute', label: 'Max Spread Absolute' },
      { key: 'bidAskAbsoluteThresholdPrice', label: 'Absolute Threshold Price' },
      { key: 'minDepthQuantity', label: 'Min Depth Quantity' },
      { key: 'minDepthLevels', label: 'Min Depth Levels' },
      { key: 'enableFreakPriceCheck', label: 'Enable Freak Price Check' },
      { key: 'freakCheckMinPrice', label: 'Freak Check Min Price' },
      { key: 'maxPriceDeviationPct', label: 'Max Price Deviation %' },
      { key: 'maxPriceDeviationAbs', label: 'Max Price Deviation Abs (₹)' },
      { key: 'skipPriceValidationForExit', label: 'Skip Price Validation for Exit' },
    ],
  },
  {
    category: 'Order & Position Limits',
    fields: [
      { key: 'maxOrderQty', label: 'Max Qty Per Order' },
      { key: 'maxOrderQtyLots', label: 'Max Lots Per Order' },
      { key: 'maxOrderValue', label: 'Max Value Per Order' },
      { key: 'enableFreezeQtyCheck', label: 'Enable Freeze Qty Check' },
      { key: 'maxOrderOperationsPerSecond', label: 'Max Ops/Second' },
      { key: 'maxOrdersPerSecond', label: 'Max Orders/Second' },
      { key: 'maxOrdersPerMinute', label: 'Max Orders/Minute' },
      { key: 'maxOrdersPerDay', label: 'Max Orders/Day' },
      { key: 'maxBuyOrdersPerDay', label: 'Max Buy Orders/Day' },
      { key: 'maxSellOrdersPerDay', label: 'Max Sell Orders/Day' },
      { key: 'maxOrdersPerSymbolPerDay', label: 'Max Orders/Symbol/Day' },
      { key: 'maxTotalPositions', label: 'Max Total Positions' },
      { key: 'maxTotalCombos', label: 'Max Total Combos' },
      { key: 'maxPositionQtyPerSymbol', label: 'Max Position Qty/Symbol' },
      { key: 'maxBuyQtyPerSymbolPerDay', label: 'Max Buy Qty/Symbol/Day' },
      { key: 'maxSellQtyPerSymbolPerDay', label: 'Max Sell Qty/Symbol/Day' },
    ],
  },
  {
    category: 'Loss Protection',
    fields: [
      { key: 'maxDailyLossAmount', label: 'Max Daily Loss Amount' },
      { key: 'maxDailyLossPct', label: 'Max Daily Loss %' },
      { key: 'enableAutoKillOnLoss', label: 'Auto Kill on Loss' },
      { key: 'autoSquareOffOnBreach', label: 'Auto Square-off on Breach' },
    ],
  },
  {
    category: 'Circuit Breakers',
    fields: [
      { key: 'maxRejectionRatePct', label: 'Max Rejection Rate %' },
      { key: 'maxVixLevel', label: 'Max VIX Level' },
      { key: 'volatilityPauseMinutes', label: 'Volatility Pause (min)' },
    ],
  },
];

const SOURCE_BADGE_COLORS: Record<string, string> = {
  DEFAULT: 'light',
  GLOBAL: 'secondary',
  EXCHANGE: 'warning',
  SYMBOL: 'primary',
  BROKER: 'info',
  BROKER_SYMBOL: 'info',
  USER: 'success',
  USER_SYMBOL: 'success',
};

const SOURCE_DISPLAY_LABELS: Record<string, string> = {
  BROKER_SYMBOL: 'BROKER (SYMBOL)',
  USER_SYMBOL: 'USER (SYMBOL)',
};

const EffectiveConfigPreviewPanel: React.FC = () => {
  const [segmentType, setSegmentType] = useState('OPTIONS');
  const [exchange, setExchange] = useState('');
  const [symbol, setSymbol] = useState('');
  const [broker, setBroker] = useState<string | null>(null);
  const [username, setUsername] = useState<string | null>(null);

  const { data: exchanges } = useQuery({
    queryKey: ['exchanges'],
    queryFn: () => exchangeService.getAll(),
  });

  const { data: symbols } = useQuery({
    queryKey: ['symbols'],
    queryFn: () => symbolService.getAll(),
  });

  const canFetch = !!segmentType;

  const {
    data: effectiveData,
    refetch,
    isFetching,
    error: effectiveError,
  } = useQuery({
    queryKey: ['rms-effective', segmentType, exchange, symbol, broker, username],
    queryFn: () =>
      rmsConfigService.getEffective({
        segmentType,
        exchange: exchange || undefined,
        symbol: symbol || undefined,
        broker: broker || undefined,
        username: username || undefined,
      }),
    enabled: false,
  });

  useEffect(() => {
    if (effectiveError) {
      const msg = (effectiveError as { message?: string })?.message || 'Failed to load effective config';
      toast.error(msg);
    }
  }, [effectiveError]);

  const handleLookup = () => {
    if (canFetch) refetch();
  };

  const handleSymbolChange = (sym: string) => {
    setSymbol(sym);
    if (sym && symbols) {
      const found = symbols.find(s => s.symbol === sym);
      if (found?.exchange) setExchange(found.exchange);
    }
  };

  const renderConfigValue = (label: string, value: unknown, source?: string) => {
    if (value === null || value === undefined) return null;
    return (
      <tr key={label}>
        <td className="font-medium">{label}</td>
        <td>
          {typeof value === 'boolean' ? (
            <Badge bg={value ? 'success' : 'secondary'}>{value ? 'Yes' : 'No'}</Badge>
          ) : (
            <span>{String(value)}</span>
          )}
        </td>
        <td>
          {source && (
            <Badge bg={SOURCE_BADGE_COLORS[source] || 'light'} text={source === 'DEFAULT' ? 'dark' : undefined}>
              {SOURCE_DISPLAY_LABELS[source] || source}
            </Badge>
          )}
        </td>
      </tr>
    );
  };

  const config = effectiveData?.config;
  const sources = effectiveData?.sources;

  return (
    <Card>
      <Card.Header>
        <h6 className="mb-0">
          <BsEye className="me-2" />
          Effective Configuration Preview
        </h6>
        <small className="text-ink-soft">
          Preview the merged RMS config for a specific context. Select segment type and optionally narrow by exchange, symbol, broker, or user.
        </small>
      </Card.Header>
      <Card.Body>
        <Row className="mb-4 ">
          <Col md={2}>
            <Form.Select size="sm" value={segmentType} onChange={e => setSegmentType(e.target.value)}>
              {SEGMENT_TYPES.map(s => <option key={s} value={s}>{s}</option>)}
            </Form.Select>
          </Col>
          <Col md={2}>
            <Form.Select size="sm" value={exchange} onChange={e => setExchange(e.target.value)}>
              <option value="">Exchange (All)</option>
              {exchanges?.map(ex => (
                <option key={ex.exchange} value={ex.exchange}>{ex.exchange}</option>
              ))}
            </Form.Select>
          </Col>
          <Col md={2}>
            <Form.Select size="sm" value={symbol} onChange={e => handleSymbolChange(e.target.value)}>
              <option value="">Symbol (All)</option>
              {symbols?.map(sym => (
                <option key={sym.symbol} value={sym.symbol}>{sym.symbol}</option>
              ))}
            </Form.Select>
          </Col>
          <Col md={2}>
            <SearchableBrokerSelect
              value={broker}
              onChange={setBroker}
              placeholder="Broker (All)"
            />
          </Col>
          <Col md={2}>
            <SearchableUserSelect
              value={username}
              onChange={setUsername}
              placeholder="User (All)"
            />
          </Col>
          <Col md={2}>
            <Button
              variant="primary"
              size="sm"
              onClick={handleLookup}
              disabled={!canFetch || isFetching}
              className="w-full"
            >
              {isFetching ? <Spinner size="sm" /> : 'Lookup'}
            </Button>
          </Col>
        </Row>

        {effectiveError && (
          <Alert variant="danger">
            <strong>Error:</strong>{' '}
            {(effectiveError as { message?: string })?.message || 'Failed to load effective configuration.'}
          </Alert>
        )}

        {!effectiveData && !effectiveError && (
          <Alert variant="info">
            Select segment type and optional filters, then click Lookup to preview the effective RMS config.
          </Alert>
        )}

        {config && sources && !effectiveError && (
          <div className="overflow-x-auto">
            <Table striped size="sm">
              <thead>
                <tr>
                  <th>Parameter</th>
                  <th>Value</th>
                  <th>Source</th>
                </tr>
              </thead>
              <tbody>
                {RMS_FIELD_LABELS.map(group => {
                  const rows = group.fields
                    .map(f => {
                      const val = (config as unknown as Record<string, unknown>)[f.key];
                      return val !== null && val !== undefined
                        ? renderConfigValue(f.label, val, sources[f.key])
                        : null;
                    })
                    .filter(Boolean);

                  if (rows.length === 0) return null;

                  return [
                    <tr key={`header-${group.category}`} className="bg-raised">
                      <td colSpan={3} className="font-bold text-ink-soft text-[0.875em] py-1">{group.category}</td>
                    </tr>,
                    ...rows,
                  ];
                })}
              </tbody>
            </Table>
          </div>
        )}
      </Card.Body>
    </Card>
  );
};

// ==================== KILL SWITCH PANEL ====================

const KILL_SWITCH_LEVELS: { value: KillSwitchLevel; label: string; description: string }[] = [
  { value: 'GLOBAL', label: 'GLOBAL', description: 'Block ALL orders for ALL users' },
  { value: 'EXCHANGE', label: 'EXCHANGE', description: 'Block orders on a specific exchange' },
  { value: 'BROKER', label: 'BROKER', description: 'Block all users on a specific broker' },
  { value: 'SYMBOL', label: 'SYMBOL', description: 'Block FnO orders for a specific underlying' },
  { value: 'USER', label: 'USER', description: 'Block a specific user+broker combination' },
];

const LEVEL_BADGE_COLORS: Record<string, string> = {
  GLOBAL: 'danger',
  EXCHANGE: 'warning',
  BROKER: 'info',
  SYMBOL: 'primary',
  USER: 'secondary',
};

/** Returns a human-readable scope string for a kill switch entry */
const getKillSwitchScope = (entry: KillSwitchEntry): string => {
  switch (entry.level) {
    case 'GLOBAL': return 'All users, all exchanges';
    case 'EXCHANGE': return entry.exchange || '-';
    case 'BROKER': return entry.broker || '-';
    case 'SYMBOL': return entry.symbol || '-';
    case 'USER': return `${entry.username || '?'} @ ${entry.broker || '?'}`;
    default: return entry.key;
  }
};

/** Sort order for kill switch levels (GLOBAL first) */
const LEVEL_SORT_ORDER: Record<string, number> = { GLOBAL: 0, EXCHANGE: 1, BROKER: 2, SYMBOL: 3, USER: 4 };

/** Short labels for kill switch trigger sources */
const SOURCE_LABELS: Record<KillSwitchSource, string> = {
  MANUAL: 'Manual',
  DAILY_LOSS: 'Daily Loss',
  REJECTION_RATE: 'Rejection Rate',
  VOLATILITY: 'Volatility',
};

/** Auto-trigger types with a Layer-2 arm/disarm flag (MANUAL excluded — operator actions are always enabled) */
const KILL_SWITCH_TYPES: { source: KillSwitchSource; label: string; description: string }[] = [
  { source: 'DAILY_LOSS', label: 'Daily Loss Auto-Kill', description: 'Trips when a user breaches their daily loss limit' },
  { source: 'REJECTION_RATE', label: 'Rejection-Rate Breaker', description: 'Trips when a user’s order rejection rate is too high' },
  { source: 'VOLATILITY', label: 'Volatility (VIX) Breaker', description: 'Trips a GLOBAL kill switch when India VIX exceeds the limit' },
];

// Rendered standalone by KillSwitchPage (sidebar: RMS > Kill Switches) —
// kill switches are runtime state, not configuration, so they no longer
// live as a tab inside the RMS Config page.
export const KillSwitchPanel: React.FC<RmsPanelProps> = ({ hideEdit }) => {
  const queryClient = useQueryClient();
  const [showActivateModal, setShowActivateModal] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [activateForm, setActivateForm] = useState<KillSwitchActivateRequest>({
    level: 'USER',
    reason: '',
  });
  // Layer-2: which type the operator is disarming (drives the choice modal)
  const [disarmTarget, setDisarmTarget] = useState<KillSwitchSource | null>(null);
  const [showRemoveAll, setShowRemoveAll] = useState(false);

  const { data: status, isLoading, error, refetch } = useQuery({
    queryKey: ['rms-kill-switch'],
    queryFn: () => rmsConfigService.getKillSwitchStatus(),
    refetchInterval: 10000,
  });

  // Data for searchable dropdowns
  const { data: exchanges } = useQuery({
    queryKey: ['exchanges'],
    queryFn: () => exchangeService.getAll(),
  });

  const { data: symbols } = useQuery({
    queryKey: ['symbols'],
    queryFn: () => symbolService.getAll(),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['rms-kill-switch'] });

  const activateMutation = useMutation({
    mutationFn: (request: KillSwitchActivateRequest) => rmsConfigService.activateKillSwitch(request),
    onSuccess: () => {
      invalidate();
      toast.success('Kill switch activated');
      setShowActivateModal(false);
      setActivateForm({ level: 'USER', reason: '' });
    },
    onError: (err: Error) => toast.error(`Failed: ${err.message}`),
  });

  const deactivateBatchMutation = useMutation({
    mutationFn: (keys: string[]) => rmsConfigService.deactivateKillSwitches(keys),
    onSuccess: () => {
      invalidate();
      setSelectedKeys(new Set());
      toast.success('Kill switch(es) turned OFF');
    },
    onError: (err: Error) => toast.error(`Failed: ${err.message}`),
  });

  const removeBatchMutation = useMutation({
    mutationFn: (keys: string[]) => rmsConfigService.removeKillSwitches(keys),
    onSuccess: () => {
      invalidate();
      setSelectedKeys(new Set());
      toast.success('Kill switch(es) removed');
    },
    onError: (err: Error) => toast.error(`Failed: ${err.message}`),
  });

  const removeAllMutation = useMutation({
    mutationFn: () => rmsConfigService.removeAllKillSwitches(),
    onSuccess: () => {
      invalidate();
      setSelectedKeys(new Set());
      setShowRemoveAll(false);
      toast.success('All kill switches removed');
    },
    onError: (err: Error) => toast.error(`Failed: ${err.message}`),
  });

  const setTypeMutation = useMutation({
    mutationFn: (v: { source: KillSwitchSource; enabled: boolean; alsoRemoveInstances: boolean }) =>
      rmsConfigService.setKillSwitchType(v.source, v.enabled, v.alsoRemoveInstances),
    onSuccess: (_data, v) => {
      invalidate();
      setDisarmTarget(null);
      toast.success(`${SOURCE_LABELS[v.source]} breaker ${v.enabled ? 'armed' : 'disarmed'}`);
    },
    onError: (err: Error) => toast.error(`Failed: ${err.message}`),
  });

  if (error) return <Alert variant="danger">Failed to load kill switch status</Alert>;

  // All instances — ACTIVE and INACTIVE. Sorted ACTIVE-first, then GLOBAL-first.
  const killSwitches: KillSwitchEntry[] = useMemo(() => {
    const entries = status?.activeKillSwitches || [];
    return [...entries].sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      return (LEVEL_SORT_ORDER[a.level] ?? 99) - (LEVEL_SORT_ORDER[b.level] ?? 99);
    });
  }, [status?.activeKillSwitches]);
  const killedUsers = status?.killedUsers || [];
  const typeStates = status?.typeStates || {};
  const activeCount = killSwitches.filter(e => e.active).length;
  const inactiveCount = killSwitches.length - activeCount;

  const anyMutating = deactivateBatchMutation.isPending || removeBatchMutation.isPending
    || activateMutation.isPending || removeAllMutation.isPending;

  const toggleSelection = (key: string) => {
    setSelectedKeys(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedKeys.size === killSwitches.length) {
      setSelectedKeys(new Set());
    } else {
      setSelectedKeys(new Set(killSwitches.map(e => e.key)));
    }
  };

  const handleDeactivateSelected = () => {
    if (selectedKeys.size === 0) return;
    deactivateBatchMutation.mutate(Array.from(selectedKeys));
  };

  const handleRemoveSelected = () => {
    if (selectedKeys.size === 0) return;
    removeBatchMutation.mutate(Array.from(selectedKeys));
  };

  // Toggle a single instance ON/OFF. Re-activating an INACTIVE entry rebuilds
  // the activate request from the entry's own level fields.
  const handleToggleEntry = (entry: KillSwitchEntry) => {
    if (entry.active) {
      deactivateBatchMutation.mutate([entry.key]);
    } else {
      activateMutation.mutate({
        level: entry.level,
        exchange: entry.exchange,
        broker: entry.broker,
        symbol: entry.symbol,
        username: entry.username,
        reason: entry.reason,
      });
    }
  };

  // Layer-2: arming is direct; disarming opens the choice modal.
  const handleTypeToggle = (source: KillSwitchSource, currentlyArmed: boolean) => {
    if (currentlyArmed) {
      setDisarmTarget(source);
    } else {
      setTypeMutation.mutate({ source, enabled: true, alsoRemoveInstances: false });
    }
  };

  const isActivateFormValid = (): boolean => {
    switch (activateForm.level) {
      case 'GLOBAL': return true;
      case 'EXCHANGE': return !!activateForm.exchange;
      case 'BROKER': return !!activateForm.broker;
      case 'SYMBOL': return !!activateForm.symbol;
      case 'USER': return !!activateForm.username && !!activateForm.broker;
      default: return false;
    }
  };

  return (
    <>
      <Row className="mb-4">
        <Col md={3}>
          <Card className="text-center h-full">
            <Card.Body>
              <h2 className={activeCount > 0 ? 'text-danger-600 dark:text-danger-400' : 'text-success-500 dark:text-success-400'}>{activeCount}</h2>
              <small className="text-ink-soft">Active Kill Switches</small>
            </Card.Body>
          </Card>
        </Col>
        <Col md={3}>
          <Card className="text-center h-full">
            <Card.Body>
              <h2 className={inactiveCount > 0 ? 'text-ink-soft' : 'text-ink-soft'}>{inactiveCount}</h2>
              <small className="text-ink-soft">Inactive (Off, Listed)</small>
            </Card.Body>
          </Card>
        </Col>
        <Col md={3}>
          <Card className="text-center h-full">
            <Card.Body>
              <h2 className={killedUsers.length > 0 ? 'text-warning-700 dark:text-warning-400' : 'text-success-500 dark:text-success-400'}>
                {killedUsers.length}
              </h2>
              <small className="text-ink-soft">Killed Users (DB)</small>
            </Card.Body>
          </Card>
        </Col>
        <Col md={3}>
          <Card className="h-full">
            <Card.Body className="flex flex-col justify-center items-center gap-2">
              {!hideEdit && (
                <Button variant="danger" size="sm" onClick={() => setShowActivateModal(true)}>
                  <BsStopCircle className="me-1" /> Activate Kill Switch
                </Button>
              )}
              {!hideEdit && killSwitches.length > 0 && (
                <Button variant="outline-danger" size="sm" onClick={() => setShowRemoveAll(true)}>
                  Remove All
                </Button>
              )}
              <Button variant="outline-secondary" size="sm" onClick={() => refetch()}>
                <BsArrowRepeat className="me-1" /> Refresh
              </Button>
            </Card.Body>
          </Card>
        </Col>
      </Row>

      {/* Auto-Trigger Breakers (Layer 2 — per-type arm/disarm) */}
      <Card className="mb-4">
        <Card.Header>
          <h6 className="mb-0"><BsStopCircle className="me-2" />Auto-Trigger Breakers</h6>
        </Card.Header>
        <Card.Body className="p-0">
          <div className="p-2 bg-raised border-b">
            <small className="text-ink-soft">
              Disarming an auto-trigger breaker now <strong>persists across restarts</strong> and the next-day boundary (V251).
              You only need to re-arm explicitly via the toggle below — previously you had to re-disarm every morning.
            </small>
          </div>
          <Table className="mb-0" size="sm">
            <tbody>
              {KILL_SWITCH_TYPES.map(t => {
                const armed = typeStates[t.source] !== false;
                return (
                  <tr key={t.source}>
                    <td style={{ width: '220px' }}><strong>{t.label}</strong></td>
                    <td><small className="text-ink-soft">{t.description}</small></td>
                    <td style={{ width: '150px' }} className="text-end">
                      <Badge bg={armed ? 'success' : 'secondary'} className="me-2">
                        {armed ? 'ARMED' : 'DISARMED'}
                      </Badge>
                      {!hideEdit && (
                        <Form.Check
                          inline
                          type="switch"
                          checked={armed}
                          disabled={setTypeMutation.isPending}
                          onChange={() => handleTypeToggle(t.source, armed)}
                        />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </Card.Body>
      </Card>

      {/* Kill Switch Instances */}
      <Card className="mb-4">
        <Card.Header className="flex justify-between items-center">
          <h6 className="mb-0"><BsStopCircle className="me-2 text-danger-600 dark:text-danger-400" />Kill Switches</h6>
          {!hideEdit && selectedKeys.size > 0 && (
            <div className="flex gap-2">
              <Button variant="outline-success" size="sm" onClick={handleDeactivateSelected} disabled={anyMutating}>
                Turn OFF ({selectedKeys.size})
              </Button>
              <Button variant="outline-danger" size="sm" onClick={handleRemoveSelected} disabled={anyMutating}>
                Remove ({selectedKeys.size})
              </Button>
            </div>
          )}
        </Card.Header>
        <Card.Body className="p-0">
          {isLoading ? (
            <div className="text-center py-4"><Spinner size="sm" /></div>
          ) : killSwitches.length === 0 ? (
            <Alert variant="success" className="m-4 mb-0">No kill switches</Alert>
          ) : (
            <Table striped hover className="mb-0" size="sm">
              <thead>
                <tr>
                  {!hideEdit && (
                    <th style={{ width: '40px' }}>
                      <Form.Check
                        type="checkbox"
                        checked={selectedKeys.size === killSwitches.length && killSwitches.length > 0}
                        onChange={toggleSelectAll}
                      />
                    </th>
                  )}
                  <th>State</th>
                  <th>Level</th>
                  <th>Scope</th>
                  <th>Source</th>
                  <th>Reason</th>
                  <th>Activated</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {killSwitches.map((entry) => (
                  <tr key={entry.key} className={entry.active ? '' : 'text-ink-soft'}>
                    {!hideEdit && (
                      <td>
                        <Form.Check
                          type="checkbox"
                          checked={selectedKeys.has(entry.key)}
                          onChange={() => toggleSelection(entry.key)}
                        />
                      </td>
                    )}
                    <td>
                      <Badge bg={entry.active ? 'danger' : 'secondary'}>
                        {entry.active ? 'ACTIVE' : 'INACTIVE'}
                      </Badge>
                    </td>
                    <td>
                      <Badge bg={LEVEL_BADGE_COLORS[entry.level] || 'secondary'}>
                        {entry.level}
                      </Badge>
                    </td>
                    <td><small>{getKillSwitchScope(entry)}</small></td>
                    <td><small>{SOURCE_LABELS[entry.source] || entry.source}</small></td>
                    <td><small className="text-ink-soft">{entry.reason || '-'}</small></td>
                    <td>
                      <small title={entry.updatedAt && entry.updatedAt !== entry.createdAt ? `Updated: ${new Date(entry.updatedAt).toLocaleString()}` : undefined}>
                        {entry.createdAt ? new Date(entry.createdAt).toLocaleString() : '-'}
                      </small>
                    </td>
                    <td>
                      {!hideEdit && (
                        <div className="flex gap-1">
                          <Button
                            variant={entry.active ? 'outline-success' : 'outline-danger'}
                            size="sm"
                            onClick={() => handleToggleEntry(entry)}
                            disabled={anyMutating}
                          >
                            {entry.active ? 'Turn OFF' : 'Turn ON'}
                          </Button>
                          <Button
                            variant="outline-secondary"
                            size="sm"
                            onClick={() => removeBatchMutation.mutate([entry.key])}
                            disabled={anyMutating}
                          >
                            Remove
                          </Button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card.Body>
      </Card>

      {/* Killed Users from DB */}
      {killedUsers.length > 0 && (
        <Card>
          <Card.Header>
            <h6 className="mb-0"><BsExclamationTriangle className="me-2 text-warning-700 dark:text-warning-400" />Killed Users Today (DB State)</h6>
          </Card.Header>
          <Card.Body className="p-0">
            <Table striped hover className="mb-0" size="sm">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Broker</th>
                  <th>Reason</th>
                  <th>Kill Time</th>
                  <th>P&L</th>
                </tr>
              </thead>
              <tbody>
                {killedUsers.map((user, idx) => (
                  <tr key={idx}>
                    <td>{user.username}</td>
                    <td><Badge bg="secondary">{user.broker}</Badge></td>
                    <td><small>{user.killReason || '-'}</small></td>
                    <td><small>{user.killTime ? new Date(user.killTime).toLocaleTimeString() : '-'}</small></td>
                    <td className={user.totalPnl >= 0 ? 'text-success-500 dark:text-success-400' : 'text-danger-600 dark:text-danger-400'}>
                      {user.totalPnl?.toLocaleString() || '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card.Body>
        </Card>
      )}

      {/* Activate Kill Switch Modal */}
      <Modal show={showActivateModal} onHide={() => setShowActivateModal(false)} size="lg" backdrop="static">
        <Modal.Header closeButton>
          <Modal.Title><BsStopCircle className="me-2 text-danger-600 dark:text-danger-400" />Activate Kill Switch</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Alert variant="warning">
            This will immediately block new orders at the selected level.
          </Alert>

          {/* Level Selector */}
          <Form.Group className="mb-4">
            <Form.Label className="font-medium">Kill Switch Level</Form.Label>
            <Form.Select
              value={activateForm.level}
              onChange={e => setActivateForm({
                level: e.target.value as KillSwitchLevel,
                reason: activateForm.reason,
              })}
            >
              {KILL_SWITCH_LEVELS.map(l => (
                <option key={l.value} value={l.value}>{l.label} — {l.description}</option>
              ))}
            </Form.Select>
          </Form.Group>

          {/* Conditional fields based on level */}
          {activateForm.level === 'EXCHANGE' && (
            <Form.Group className="mb-4">
              <Form.Label>Exchange</Form.Label>
              <Form.Select
                value={activateForm.exchange || ''}
                onChange={e => setActivateForm({ ...activateForm, exchange: e.target.value || undefined })}
              >
                <option value="">Select Exchange...</option>
                {exchanges?.map(ex => (
                  <option key={ex.exchange} value={ex.exchange}>{ex.exchange} - {ex.exchangeName}</option>
                ))}
              </Form.Select>
            </Form.Group>
          )}

          {activateForm.level === 'BROKER' && (
            <Form.Group className="mb-4">
              <Form.Label>Broker</Form.Label>
              <SearchableBrokerSelect
                value={activateForm.broker || null}
                onChange={(broker) => setActivateForm({ ...activateForm, broker: broker || undefined })}
                placeholder="Search and select broker..."
              />
            </Form.Group>
          )}

          {activateForm.level === 'SYMBOL' && (
            <Form.Group className="mb-4">
              <Form.Label>FnO Symbol (Underlying)</Form.Label>
              <Form.Select
                value={activateForm.symbol || ''}
                onChange={e => setActivateForm({ ...activateForm, symbol: e.target.value || undefined })}
              >
                <option value="">Select Symbol...</option>
                {symbols?.map(sym => (
                  <option key={sym.symbol} value={sym.symbol}>{sym.symbol} ({sym.exchange})</option>
                ))}
              </Form.Select>
            </Form.Group>
          )}

          {activateForm.level === 'USER' && (
            <>
              <Form.Group className="mb-4">
                <Form.Label>Username</Form.Label>
                <SearchableUserSelect
                  value={activateForm.username || null}
                  onChange={(username) => setActivateForm({ ...activateForm, username: username || undefined })}
                  placeholder="Search and select user..."
                />
              </Form.Group>
              <Form.Group className="mb-4">
                <Form.Label>Broker</Form.Label>
                <SearchableBrokerSelect
                  value={activateForm.broker || null}
                  onChange={(broker) => setActivateForm({ ...activateForm, broker: broker || undefined })}
                  placeholder="Search and select broker..."
                />
              </Form.Group>
            </>
          )}

          {/* Reason — always shown */}
          <Form.Group>
            <Form.Label>Reason (Optional)</Form.Label>
            <Form.Control
              as="textarea"
              rows={2}
              value={activateForm.reason || ''}
              onChange={e => setActivateForm({ ...activateForm, reason: e.target.value })}
              placeholder="Enter reason for activation"
            />
          </Form.Group>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={() => setShowActivateModal(false)}>Cancel</Button>
          <Button
            variant="danger"
            onClick={() => activateMutation.mutate(activateForm)}
            disabled={!isActivateFormValid() || activateMutation.isPending}
          >
            {activateMutation.isPending ? <Spinner size="sm" /> : 'Activate'}
          </Button>
        </Modal.Footer>
      </Modal>

      {/* Disarm Type — choice modal: disarm only, or disarm + remove instances */}
      <Modal show={!!disarmTarget} onHide={() => setDisarmTarget(null)} backdrop="static">
        <Modal.Header closeButton>
          <Modal.Title>Disarm {disarmTarget ? SOURCE_LABELS[disarmTarget] : ''} Breaker</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Alert variant="warning" className="mb-4">
            While disarmed, this mechanism cannot create new kill switches. It re-arms
            automatically at the next daily reset, or when you turn it back on.
          </Alert>
          <p className="mb-0">
            Do you also want to remove the kill-switch instances this mechanism has
            already created?
          </p>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={() => setDisarmTarget(null)} disabled={setTypeMutation.isPending}>
            Cancel
          </Button>
          <Button
            variant="outline-warning"
            disabled={setTypeMutation.isPending}
            onClick={() => disarmTarget && setTypeMutation.mutate({ source: disarmTarget, enabled: false, alsoRemoveInstances: false })}
          >
            Disarm Only
          </Button>
          <Button
            variant="warning"
            disabled={setTypeMutation.isPending}
            onClick={() => disarmTarget && setTypeMutation.mutate({ source: disarmTarget, enabled: false, alsoRemoveInstances: true })}
          >
            {setTypeMutation.isPending ? <Spinner size="sm" /> : 'Disarm + Remove Instances'}
          </Button>
        </Modal.Footer>
      </Modal>

      {/* Remove All confirmation */}
      <ConfirmModal
        show={showRemoveAll}
        title="Remove All Kill Switches"
        message="Remove every kill-switch instance (ACTIVE and INACTIVE)? This re-arms all auto-triggers — any condition still breached will trip again."
        confirmLabel="Remove All"
        confirmVariant="danger"
        onConfirm={() => removeAllMutation.mutate()}
        onCancel={() => setShowRemoveAll(false)}
        isLoading={removeAllMutation.isPending}
      />
    </>
  );
};

export default RMSPage;
