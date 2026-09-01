/**
 * SymbolBrokerConfigs Component
 * Table for listing and managing symbol-broker configurations (freeze limits per broker)
 * Uses V2 API: /api/v2/symbols/{symbol}/brokers
 */

import { useState, useEffect, useMemo } from 'react';
import { Card, Button, Alert, Form, InputGroup, Row, Col, Modal, Spinner } from '@/components/ui/rbShim';
import { BsPlus, BsTrash, BsPencil, BsSearch, BsEye } from 'react-icons/bs';
import Select from 'react-select';
import { DataTable, ConfirmModal } from '@/components/common';
import type { Column } from '@/components/common';
import { useQuery, useMutation } from '@tanstack/react-query';
import { symbolService, exchangeService, v2BrokerService } from '@/services/admin/v2AdminService';
import type { SymbolBrokerConfig, CreateSymbolBrokerConfigRequest } from '@/types/symbol';
import HelpIcon from '@/components/common/HelpIcon';
import { symbolHelpContent } from '@/data/help';
import { trimStringsDeep } from '@/utils/inputTrim';

export interface SymbolBrokerConfigsProps {
  /** Card title */
  title?: string;
  /** Hide add button */
  hideCreate?: boolean;
  /** Hide delete button */
  hideDelete?: boolean;
  /** Hide enable/disable toggle */
  hideEnableDisable?: boolean;
  /** Read-only mode - shows View button instead of Edit */
  readOnly?: boolean;
}

const SymbolBrokerConfigs: React.FC<SymbolBrokerConfigsProps> = ({
  title = 'Symbol Broker Configurations',
  hideCreate = false,
  hideDelete = false,
  readOnly = false,
}) => {
  const [showModal, setShowModal] = useState(false);
  const [selectedConfig, setSelectedConfig] = useState<SymbolBrokerConfig | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterExchange, setFilterExchange] = useState<string>('');
  const [filterSymbol, setFilterSymbol] = useState<string>('');
  const [allConfigs, setAllConfigs] = useState<SymbolBrokerConfig[]>([]);

  const { data: exchanges } = useQuery({
    queryKey: ['exchanges'],
    queryFn: () => exchangeService.getAll(),
  });

  const { data: brokers } = useQuery({
    queryKey: ['brokers'],
    queryFn: () => v2BrokerService.getAll(),
  });

  const { data: symbols, isLoading: symbolsLoading } = useQuery({
    queryKey: ['symbols', filterExchange],
    queryFn: () => symbolService.getAll({ exchange: filterExchange || undefined }),
  });

  // Fetch broker configs for selected symbol
  const { data: brokerConfigs, isLoading: configsLoading, refetch: refetchConfigs } = useQuery({
    queryKey: ['symbolBrokerConfigs', filterSymbol],
    queryFn: () => filterSymbol ? symbolService.getBrokerConfigs(filterSymbol) : Promise.resolve([]),
    enabled: !!filterSymbol,
  });

  // When symbol changes, update configs
  useEffect(() => {
    if (brokerConfigs) {
      setAllConfigs(brokerConfigs);
    }
  }, [brokerConfigs]);

  const createMutation = useMutation({
    mutationFn: async (data: CreateSymbolBrokerConfigRequest) => {
      // POST to /api/v2/symbols/{symbol}/brokers
      const response = await fetch(`/api/v2/symbols/${encodeURIComponent(data.symbol)}/brokers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(trimStringsDeep(data)),
      });
      if (!response.ok) throw new Error('Failed to create broker config');
      return response.json();
    },
    onSuccess: () => {
      refetchConfigs();
      setShowModal(false);
      setSelectedConfig(null);
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ symbol, broker, data }: { symbol: string; broker: string; data: Partial<CreateSymbolBrokerConfigRequest> }) => {
      // PUT to /api/v2/symbols/{symbol}/brokers/{broker}
      const response = await fetch(`/api/v2/symbols/${encodeURIComponent(symbol)}/brokers/${encodeURIComponent(broker)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(trimStringsDeep(data)),
      });
      if (!response.ok) throw new Error('Failed to update broker config');
      return response.json();
    },
    onSuccess: () => {
      refetchConfigs();
      setShowModal(false);
      setSelectedConfig(null);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async ({ symbol, broker }: { symbol: string; broker: string }) => {
      // DELETE /api/v2/symbols/{symbol}/brokers/{broker}
      const response = await fetch(`/api/v2/symbols/${encodeURIComponent(symbol)}/brokers/${encodeURIComponent(broker)}`, {
        method: 'DELETE',
      });
      if (!response.ok) throw new Error('Failed to delete broker config');
      return response.json();
    },
    onSuccess: () => {
      refetchConfigs();
      setShowDeleteConfirm(false);
      setSelectedConfig(null);
    },
  });

  // Filter configs based on search term
  const filteredConfigs = allConfigs.filter((c) => {
    if (!searchTerm) return true;
    const term = searchTerm.toLowerCase();
    return (
      c.symbol.toLowerCase().includes(term) ||
      c.broker.toLowerCase().includes(term)
    );
  });

  const handleCreateClick = () => {
    setSelectedConfig(null);
    setShowModal(true);
  };

  const handleEditClick = (config: SymbolBrokerConfig) => {
    setSelectedConfig(config);
    setShowModal(true);
  };

  const columns: Column<SymbolBrokerConfig>[] = [
    {
      key: 'symbol',
      header: 'Symbol',
      render: (c) => <span className="font-medium">{c.symbol}</span>,
    },
    {
      key: 'broker',
      header: 'Broker',
      render: (c) => <code>{c.broker}</code>,
    },
    {
      key: 'freezeLimitQty',
      header: 'Freeze Limit (Qty)',
      render: (c) => <span className="font-medium">{c.freezeLimitQty}</span>,
    },
    {
      key: 'actions',
      header: 'Actions',
      render: (c) => (
        <div className="flex gap-1">
          <Button variant="outline-primary" size="sm" onClick={() => handleEditClick(c)} title={readOnly ? 'View' : 'Edit'}>{readOnly ? <BsEye /> : <BsPencil />}</Button>
          {!hideDelete && (
            <Button variant="outline-danger" size="sm" onClick={() => { setSelectedConfig(c); setShowDeleteConfirm(true); }}><BsTrash /></Button>
          )}
        </div>
      ),
    },
  ];

  const isLoading = symbolsLoading || configsLoading;

  return (
    <>
      <Card>
        <Card.Header className="flex justify-between items-center">
          <h5 className="mb-0">{title}</h5>
          {!hideCreate && filterSymbol && (
            <Button variant="primary" size="sm" onClick={handleCreateClick}>
              <BsPlus className="me-1" /> Add Broker Config
            </Button>
          )}
        </Card.Header>
        <Card.Body>
          {/* Search and Filter */}
          <Row className="mb-4 ">
            <Col md={3}>
              <Form.Select
                size="sm"
                value={filterExchange}
                onChange={(e) => { setFilterExchange(e.target.value); setFilterSymbol(''); setAllConfigs([]); }}
              >
                <option value="">Select Exchange</option>
                {exchanges?.map((ex) => (
                  <option key={ex.exchange} value={ex.exchange}>{ex.exchange}</option>
                ))}
              </Form.Select>
            </Col>
            <Col md={3}>
              <Form.Select
                size="sm"
                value={filterSymbol}
                onChange={(e) => setFilterSymbol(e.target.value)}
                disabled={!filterExchange}
              >
                <option value="">Select Symbol</option>
                {symbols?.map((s) => (
                  <option key={s.symbol} value={s.symbol}>{s.symbol}</option>
                ))}
              </Form.Select>
            </Col>
            <Col md={4}>
              <InputGroup size="sm">
                <InputGroup.Text><BsSearch /></InputGroup.Text>
                <Form.Control
                  placeholder="Search configurations..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  disabled={!filterSymbol}
                />
              </InputGroup>
            </Col>
          </Row>

          {!filterSymbol ? (
            <Alert variant="info">Please select an exchange and symbol to view broker configurations.</Alert>
          ) : (
            <DataTable
              columns={columns}
              data={filteredConfigs}
              loading={isLoading}
              keyExtractor={(c) => `${c.symbol}:${c.broker}`}
              emptyMessage="No broker configurations found for this symbol"
            />
          )}
        </Card.Body>
        {filterSymbol && (
          <Card.Footer className="text-ink-soft text-[0.875em]">
            Showing {filteredConfigs.length} broker configuration(s) for {filterSymbol}
          </Card.Footer>
        )}
      </Card>

      {/* Create/Edit/View Modal */}
      <SymbolBrokerConfigModal
        config={selectedConfig}
        show={showModal}
        onClose={() => { setShowModal(false); setSelectedConfig(null); }}
        onSave={(data, isNew) => {
          if (isNew) {
            createMutation.mutate({ ...data, symbol: filterSymbol });
          } else if (selectedConfig) {
            updateMutation.mutate({
              symbol: selectedConfig.symbol,
              broker: selectedConfig.broker,
              data: { freezeLimitQty: data.freezeLimitQty },
            });
          }
        }}
        isSaving={createMutation.isPending || updateMutation.isPending}
        symbol={filterSymbol}
        brokers={brokers || []}
        existingBrokers={allConfigs.map(c => c.broker)}
        readOnly={readOnly}
      />

      <ConfirmModal
        show={showDeleteConfirm}
        title="Delete Broker Configuration"
        message={`Are you sure you want to delete the broker configuration for "${selectedConfig?.symbol}" (${selectedConfig?.broker})?`}
        confirmLabel="Delete"
        confirmVariant="danger"
        onConfirm={() => selectedConfig && deleteMutation.mutate({
          symbol: selectedConfig.symbol,
          broker: selectedConfig.broker,
        })}
        onCancel={() => { setShowDeleteConfirm(false); setSelectedConfig(null); }}
        isLoading={deleteMutation.isPending}
      />
    </>
  );
};

// Modal component for create/edit/view
interface SymbolBrokerConfigModalProps {
  config: SymbolBrokerConfig | null;
  show: boolean;
  onClose: () => void;
  onSave: (data: CreateSymbolBrokerConfigRequest, isNew: boolean) => void;
  isSaving: boolean;
  symbol: string;
  brokers: { name: string }[];
  existingBrokers: string[];
  readOnly?: boolean;
}

const SymbolBrokerConfigModal: React.FC<SymbolBrokerConfigModalProps> = ({
  config,
  show,
  onClose,
  onSave,
  isSaving,
  symbol,
  brokers,
  existingBrokers,
  readOnly = false,
}) => {
  const isCreateMode = !config;
  const isViewMode = !isCreateMode && readOnly;

  const [formData, setFormData] = useState<CreateSymbolBrokerConfigRequest>({
    symbol: '',
    broker: '',
    freezeLimitQty: 0,
  });

  // Available brokers for create mode (exclude already configured)
  const availableBrokers = isCreateMode
    ? brokers.filter(b => !existingBrokers.includes(b.name))
    : brokers;

  // Update form when config changes
  useEffect(() => {
    if (show) {
      if (config) {
        setFormData({
          symbol: config.symbol,
          broker: config.broker,
          freezeLimitQty: config.freezeLimitQty,
        });
      } else {
        setFormData({
          symbol: symbol,
          broker: availableBrokers[0]?.name || '',
          freezeLimitQty: 1800, // Default freeze limit
        });
      }
    }
  }, [config, show, symbol]);

  const handleSubmit = () => {
    onSave(formData, isCreateMode);
  };

  const brokerOptions = useMemo(() => {
    return availableBrokers.map((broker) => ({
      value: broker.name,
      label: broker.name,
    }));
  }, [availableBrokers]);

  return (
    <Modal show={show} onHide={onClose} backdrop={isViewMode ? true : 'static'}>
      <Modal.Header closeButton>
        <Modal.Title>
          {isViewMode ? <BsEye className="me-2" /> : !isCreateMode ? <BsPencil className="me-2" /> : null}
          {isCreateMode ? 'Add Broker Configuration' : (isViewMode ? 'View Broker Configuration' : 'Edit Broker Configuration')}
        </Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <Form>
          <fieldset disabled={isViewMode}>
            <Form.Group className="mb-4">
              <Form.Label>Symbol</Form.Label>
              <Form.Control value={symbol} disabled />
            </Form.Group>
            <Form.Group className="mb-4">
              <Form.Label className="flex items-center">Broker * <HelpIcon article={symbolHelpContent['symbolBrokerConfig.broker']} /></Form.Label>
              {isCreateMode ? (
                <Select
                  options={brokerOptions}
                  value={brokerOptions.find((option) => option.value === formData.broker) || null}
                  onChange={(selected) => setFormData({ ...formData, broker: selected?.value || '' })}
                  isClearable
                  isSearchable
                  classNamePrefix="react-select"
                  placeholder="Select broker"
                />
              ) : (
                <Form.Control value={formData.broker} disabled />
              )}
              {isCreateMode && availableBrokers.length === 0 && (
                <Form.Text className="text-warning-700 dark:text-warning-400">All brokers already have configurations for this symbol.</Form.Text>
              )}
            </Form.Group>
            <Form.Group className="mb-4">
              <Form.Label className="flex items-center">Freeze Limit (Qty) * <HelpIcon article={symbolHelpContent['symbolBrokerConfig.freezeLimitQty']} /></Form.Label>
              <Form.Control
                type="number"
                min={1}
                value={formData.freezeLimitQty || ''}
                onChange={(e) => setFormData({ ...formData, freezeLimitQty: parseInt(e.target.value) || 0 })}
                placeholder="e.g., 1800"
              />
              <Form.Text className="text-ink-soft">Maximum quantity per order before exchange freeze.</Form.Text>
            </Form.Group>
          </fieldset>
        </Form>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={onClose}>{isViewMode ? 'Close' : 'Cancel'}</Button>
        {!isViewMode && (
          <Button
            variant="primary"
            onClick={handleSubmit}
            disabled={isSaving || (isCreateMode && !formData.broker)}
          >
            {isSaving ? <><Spinner size="sm" className="me-1" />Saving...</> : (isCreateMode ? 'Add' : 'Update')}
          </Button>
        )}
      </Modal.Footer>
    </Modal>
  );
};

export default SymbolBrokerConfigs;
