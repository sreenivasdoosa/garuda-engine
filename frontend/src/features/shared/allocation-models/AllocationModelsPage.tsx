/**
 * Allocation Models Page (Shared)
 * Contains 3 tabs:
 * 1. Allocation Models - Basic allocation model management
 * 2. Strategy Mappings - Map strategies to allocation models with capital tracking
 * 3. Daywise Mappings - Day-wise allocation multipliers for strategies
 */

import { useState, useMemo } from 'react';
import { Row, Col, Card, Table, Badge, Button, Form, Tab, Tabs, Modal, Spinner, Alert, InputGroup, ProgressBar } from '@/components/ui/rbShim';
import Select from 'react-select';
import { BsPieChart, BsSearch, BsPencil, BsTrash, BsPlus, BsSun, BsMoon, BsEye, BsArrowRepeat } from 'react-icons/bs';
import { toast } from 'react-toastify';
import { PageHeader, ConfirmModal } from '@/components/common';
import { AllocationModels } from '@/components/allocation-models';
import { usePermissions } from '@/hooks/usePermissions';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { strategyDaysAllocationService, allocationModelService } from '@/services/admin/v2AdminService';
import { strategyDefinitionService } from '@/services/admin/strategyEngineService';
import type { StrategyDaysAllocationConfig } from '@/services/admin/v2AdminService';
import type { StrategyDefinition } from '@/types/strategy-engine';
import { TRADABLE_PRODUCTS, PRODUCT_LABELS, productBadgeBg, toTradableProduct, type TradableProduct } from '@/types/product';
import type { AllocationModelStrategy } from '@/types/billing';

// Day allocation field keys for iteration
const DAY_ALLOCATION_FIELDS = [
  { key: 'mondayAllocation', label: 'Mon', fullLabel: 'Monday' },
  { key: 'tuesdayAllocation', label: 'Tue', fullLabel: 'Tuesday' },
  { key: 'wednesdayAllocation', label: 'Wed', fullLabel: 'Wednesday' },
  { key: 'thursdayAllocation', label: 'Thu', fullLabel: 'Thursday' },
  { key: 'fridayAllocation', label: 'Fri', fullLabel: 'Friday' },
  { key: 'expiryDayAllocation', label: 'Expiry', fullLabel: 'Expiry Day' },
  { key: 'dt1DayAllocation', label: 'DT1', fullLabel: 'DT1 (1 day to expiry)' },
  { key: 'dt2DayAllocation', label: 'DT2', fullLabel: 'DT2 (2 days to expiry)' },
] as const;

// Format currency helper
const formatCurrency = (value: number): string => {
  if (value >= 10000000) {
    return `${(value / 10000000).toFixed(2)} Cr`;
  } else if (value >= 100000) {
    return `${(value / 100000).toFixed(2)} L`;
  } else if (value >= 1000) {
    return `${(value / 1000).toFixed(1)} K`;
  }
  return value.toLocaleString('en-IN');
};

// ==================== STRATEGY MAPPINGS PANEL ====================
// Maps strategies to allocation models with capital tracking
// Capital calculation: totalCapital = numOfLots × capitalPerLot
// capitalPerLot is determined by P0 (base strategy) hedging config from backend
const StrategyMappingsPanel: React.FC<{ canEdit: boolean; canManage: boolean }> = ({ canEdit, canManage }) => {
  const [selectedModel, setSelectedModel] = useState('');
  const [showAddModal, setShowAddModal] = useState(false);
  const [showSyncConfirm, setShowSyncConfirm] = useState(false);
  const [formData, setFormData] = useState({ strategyName: '', numOfLots: 1, mappingOverlapCapital: false });
  const queryClient = useQueryClient();

  const { data: allocationModels } = useQuery({
    queryKey: ['admin', 'allocationModels'],
    queryFn: () => allocationModelService.getAll(),
  });

  const { data: strategies } = useQuery({
    queryKey: ['strategyDefinitions'],
    queryFn: () => strategyDefinitionService.getAll(),
  });

  const { data: modelStrategies, isLoading } = useQuery({
    queryKey: ['admin', 'allocationModelStrategies', selectedModel],
    queryFn: () => allocationModelService.getStrategies(selectedModel),
    enabled: !!selectedModel,
  });

  // Get selected allocation model details
  const selectedModelData = useMemo(() => {
    return allocationModels?.find((m) => m.name === selectedModel);
  }, [allocationModels, selectedModel]);

  // Calculate capital allocation by product type
  // Note: Backend now provides computed capital info (hedgingEnabled, capitalPerLot, totalCapital)
  // Strategies with isOverlapCapital=true are NOT counted towards total allocation
  const capitalAllocation = useMemo(() => {
    if (!modelStrategies || !selectedModelData) {
      return { intraday: { used: 0, percentage: 0, strategies: [] }, positional: { used: 0, percentage: 0, strategies: [] } };
    }

    const intradayStrategies: Array<{ mapping: AllocationModelStrategy; totalCapital: number; isOverlap: boolean; capitalPerLot: number }> = [];
    const positionalStrategies: Array<{ mapping: AllocationModelStrategy; totalCapital: number; isOverlap: boolean; capitalPerLot: number }> = [];

    modelStrategies.forEach((ms) => {
      // Use backend-computed values directly
      const capitalPerLot = ms.capitalPerLot || 100000;
      const totalCapital = ms.totalCapital || (ms.numOfLots * capitalPerLot);
      const isOverlap = ms.isOverlapCapital || false;

      const item = { mapping: ms, totalCapital, isOverlap, capitalPerLot };

      if (ms.product === 'INTRADAY') {
        intradayStrategies.push(item);
      } else if (ms.product === 'POSITIONAL') {
        positionalStrategies.push(item);
      }
    });

    // Only count non-overlap strategies towards total used capital
    const intradayUsed = intradayStrategies
      .filter((s) => !s.isOverlap)
      .reduce((sum, s) => sum + s.totalCapital, 0);
    const positionalUsed = positionalStrategies
      .filter((s) => !s.isOverlap)
      .reduce((sum, s) => sum + s.totalCapital, 0);

    return {
      intraday: {
        used: intradayUsed,
        percentage: selectedModelData.intradayCapital > 0 ? (intradayUsed / selectedModelData.intradayCapital) * 100 : 0,
        strategies: intradayStrategies,
      },
      positional: {
        used: positionalUsed,
        percentage: selectedModelData.positionalCapital > 0 ? (positionalUsed / selectedModelData.positionalCapital) * 100 : 0,
        strategies: positionalStrategies,
      },
    };
  }, [modelStrategies, selectedModelData]);

  // Get strategies not already mapped to this model, grouped by product (one bucket per
  // engine-managed product + a catch-all) — CashBuy / MTF equity strategies used to be lumped
  // into a nameless "other" bucket.
  const availableStrategies = useMemo(() => {
    const empty = { byProduct: new Map<TradableProduct, StrategyDefinition[]>(), other: [] as StrategyDefinition[] };
    if (!strategies || !modelStrategies) return empty;
    const mappedNames = new Set(modelStrategies.map((ms) => ms.strategyName));
    const available = (strategies as StrategyDefinition[]).filter((s) => !mappedNames.has(s.strategyName) && s.status !== 'INACTIVE');

    const byProduct = new Map<TradableProduct, StrategyDefinition[]>();
    TRADABLE_PRODUCTS.forEach((p) => byProduct.set(p, []));
    const other: StrategyDefinition[] = [];
    available.forEach((s) => {
      const product = toTradableProduct(s.product);
      if (product) byProduct.get(product)!.push(s);
      else other.push(s);
    });
    return { byProduct, other };
  }, [strategies, modelStrategies]);

  // Searchable, grouped options for the strategy picker (react-select).
  const strategyOptions = useMemo(() => {
    const toOption = (s: StrategyDefinition) => ({
      value: s.strategyName,
      label: `${s.displayName || s.strategyName} (H: ${formatCurrency(s.capitalPerLotHedged || 100000)} / N: ${formatCurrency(s.capitalPerLotNaked || 250000)})`,
    });
    const groups: { label: string; options: { value: string; label: string }[] }[] = [];
    TRADABLE_PRODUCTS.forEach((product) => {
      const list = availableStrategies.byProduct.get(product) || [];
      if (list.length) groups.push({ label: `${PRODUCT_LABELS[product]} Strategies`, options: list.map(toOption) });
    });
    if (availableStrategies.other.length) groups.push({ label: 'Other Strategies', options: availableStrategies.other.map(toOption) });
    return groups;
  }, [availableStrategies]);

  const selectedStrategyOption = useMemo(
    () => strategyOptions.flatMap((g) => g.options).find((o) => o.value === formData.strategyName) || null,
    [strategyOptions, formData.strategyName]
  );

  const addStrategyMutation = useMutation({
    mutationFn: (data: { strategyName: string; numOfLots: number; mappingOverlapCapital: boolean }) =>
      allocationModelService.addStrategy(selectedModel, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'allocationModelStrategies', selectedModel] });
      setShowAddModal(false);
      setFormData({ strategyName: '', numOfLots: 1, mappingOverlapCapital: false });
      toast.success('Strategy added to allocation model');
    },
    onError: (error: { message?: string }) => {
      toast.error(error.message || 'Failed to add strategy');
    },
  });

  const updateStrategyMutation = useMutation({
    mutationFn: ({ strategyName, numOfLots, mappingOverlapCapital }: { strategyName: string; numOfLots?: number; mappingOverlapCapital?: boolean }) =>
      allocationModelService.updateStrategy(selectedModel, strategyName, { numOfLots, mappingOverlapCapital }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'allocationModelStrategies', selectedModel] });
      toast.success('Strategy mapping updated');
    },
    onError: (error: { message?: string }) => {
      toast.error(error.message || 'Failed to update strategy');
    },
  });

  const removeStrategyMutation = useMutation({
    mutationFn: (strategyName: string) =>
      allocationModelService.removeStrategy(selectedModel, strategyName),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'allocationModelStrategies', selectedModel] });
      toast.success('Strategy removed from allocation model');
    },
    onError: (error: { message?: string }) => {
      toast.error(error.message || 'Failed to remove strategy');
    },
  });

  const syncUserAllocationsMutation = useMutation({
    mutationFn: () => allocationModelService.syncUserAllocations(selectedModel),
    onSuccess: (data) => {
      toast.success(data.message, { autoClose: 8000 });
      if (data.errors && data.errors.length > 0) {
        toast.warning(`${data.errors.length} user-broker(s) had errors — see server logs`);
      }
    },
    onError: (error: { message?: string }) => {
      toast.error(error.message || 'Failed to sync user allocations');
    },
    onSettled: () => setShowSyncConfirm(false),
  });

  const handleSyncUserAllocations = () => {
    if (!selectedModel) return;
    setShowSyncConfirm(true);
  };

  // Calculate capital when strategy is selected in modal
  const selectedStrategyForModal = useMemo(() => {
    if (!formData.strategyName || !strategies) return null;
    return (strategies as StrategyDefinition[]).find((s) => s.strategyName === formData.strategyName);
  }, [formData.strategyName, strategies]);

  const modalCapitalPreview = useMemo(() => {
    if (!selectedStrategyForModal) return null;
    const capitalPerLotHedged = selectedStrategyForModal.capitalPerLotHedged || 100000;
    const capitalPerLotNaked = selectedStrategyForModal.capitalPerLotNaked || 250000;
    const totalCapitalHedged = formData.numOfLots * capitalPerLotHedged;
    const totalCapitalNaked = formData.numOfLots * capitalPerLotNaked;
    const isOverlap = selectedStrategyForModal.isOverlapCapital || false;
    return {
      capitalPerLotHedged,
      capitalPerLotNaked,
      totalCapitalHedged,
      totalCapitalNaked,
      product: selectedStrategyForModal.product,
      isOverlap
    };
  }, [selectedStrategyForModal, formData.numOfLots]);

  // Render strategy table for a group
  const renderStrategyTable = (
    title: string,
    icon: React.ReactNode,
    items: Array<{ mapping: AllocationModelStrategy; totalCapital: number; isOverlap: boolean; capitalPerLot: number }>,
    modelCapital: number,
    usedCapital: number,
    percentage: number,
    badgeColor: string,
    totalUsedCapital: number
  ) => (
    <Card className="mb-4">
      <Card.Header className="py-2">
        <Row className="items-center">
          <Col>
            <div className="flex items-center gap-2">
              {icon}
              <span className="font-bold">{title}</span>
              <Badge bg={badgeColor}>{items.length} strategies</Badge>
            </div>
          </Col>
          <Col className="text-end">
            <small className="text-ink-soft">
              Used: <strong>{formatCurrency(usedCapital)}</strong> / {formatCurrency(modelCapital)}
            </small>
          </Col>
        </Row>
        <ProgressBar
          now={Math.min(percentage, 100)}
          variant={percentage > 100 ? 'danger' : percentage > 80 ? 'warning' : 'success'}
          className="mt-2"
          style={{ height: '6px' }}
          label={percentage > 10 ? `${percentage.toFixed(1)}%` : ''}
        />
        {percentage > 100 && (
          <small className="text-danger-600 dark:text-danger-400">Over-allocated by {(percentage - 100).toFixed(1)}%</small>
        )}
      </Card.Header>
      <Table striped hover responsive size="sm" className="mb-0">
        <thead>
          <tr>
            <th>Strategy</th>
            <th>Hedging</th>
            <th title="Capital per lot (based on P0 hedging config)">Capital/Lot</th>
            <th style={{ width: '100px' }} title="Number of lots">Lots</th>
            <th title="Total capital = lots × capital per lot">Total Capital</th>
            <th style={{ width: '90px' }} title="Exclude this mapping from the allocation-model total (per-mapping overlap)">Overlap</th>
            <th title="Percentage of category / total capital">% Category</th>
            <th title="Percentage of total capital across all categories">% Total</th>
            <th style={{ width: '60px' }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {items.length === 0 ? (
            <tr>
              <td colSpan={9} className="text-center py-4 text-ink-soft">
                No {title.toLowerCase()} strategies mapped
              </td>
            </tr>
          ) : (
            items.map(({ mapping, totalCapital, isOverlap, capitalPerLot }) => (
              <tr key={mapping.strategyName} className={isOverlap ? 'bg-raised' : ''}>
                <td className="font-medium">
                  <code>{mapping.strategyName}</code>
                </td>
                <td>
                  <Badge bg={mapping.hedgingEnabled ? 'success' : 'secondary'}>
                    {mapping.hedgingEnabled ? 'Hedged' : 'Naked'}
                  </Badge>
                </td>
                <td>
                  <span title={`Hedged: ${formatCurrency(mapping.capitalPerLotHedged || 100000)} | Naked: ${formatCurrency(mapping.capitalPerLotNaked || 250000)}`}>
                    {formatCurrency(capitalPerLot)}
                  </span>
                </td>
                <td>
                  <Form.Control
                    type="number"
                    size="sm"
                    min={1}
                    value={mapping.numOfLots}
                    onChange={(e) => updateStrategyMutation.mutate({
                      strategyName: mapping.strategyName,
                      numOfLots: Number(e.target.value)
                    })}
                    disabled={updateStrategyMutation.isPending || !canEdit}
                    title="Number of lots"
                  />
                </td>
                <td>
                  <Badge bg={isOverlap ? 'secondary' : badgeColor} title={`${mapping.numOfLots} lots × ${formatCurrency(capitalPerLot)}/lot`}>
                    {formatCurrency(totalCapital)}
                    {isOverlap && ' *'}
                  </Badge>
                </td>
                <td>
                  {/* Per-mapping overlap toggle. Strategy-level overlap is forced globally,
                      so show a static badge there and disable the toggle. Toggling persists
                      and recomputes the whole model total via query invalidation. */}
                  {isOverlap && !mapping.mappingOverlapCapital ? (
                    <Badge bg="warning" text="dark" title="Strategy-level overlap (set on the strategy definition) — always excluded from the model total">
                      Strategy
                    </Badge>
                  ) : (
                    <Form.Check
                      type="checkbox"
                      id={`overlap-${mapping.strategyName}`}
                      checked={!!mapping.mappingOverlapCapital}
                      disabled={updateStrategyMutation.isPending || !canEdit}
                      title="Exclude this mapping from the allocation-model total (per-mapping)"
                      onChange={(e) => updateStrategyMutation.mutate({
                        strategyName: mapping.strategyName,
                        mappingOverlapCapital: e.target.checked,
                      })}
                    />
                  )}
                </td>
                <td>
                  <small className={isOverlap ? 'text-ink-soft' : ''}>
                    {usedCapital > 0 ? `${((totalCapital / usedCapital) * 100).toFixed(1)}%` : '-'}
                  </small>
                </td>
                <td>
                  <small className={isOverlap ? 'text-ink-soft' : ''}>
                    {totalUsedCapital > 0 ? `${((totalCapital / totalUsedCapital) * 100).toFixed(1)}%` : '-'}
                  </small>
                </td>
                <td>
                  {canManage && (
                    <Button
                      variant="outline-danger"
                      size="sm"
                      onClick={() => removeStrategyMutation.mutate(mapping.strategyName)}
                      disabled={removeStrategyMutation.isPending}
                    >
                      <BsTrash />
                    </Button>
                  )}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </Table>
      {items.some((i) => i.isOverlap) && (
        <Card.Footer className="py-1 bg-raised">
          <small className="text-ink-soft">* Overlap capital strategies are not counted towards allocation percentage</small>
        </Card.Footer>
      )}
    </Card>
  );

  return (
    <>
      <Card className="mb-4">
        <Card.Header>
          <Row className="items-center">
            <Col md={4}>
              <Form.Select value={selectedModel} onChange={(e) => setSelectedModel(e.target.value)}>
                <option value="">-- Select Allocation Model --</option>
                {allocationModels?.map((m) => (
                  <option key={m.name} value={m.name}>
                    {m.name} (Capital: {formatCurrency(m.capital)})
                  </option>
                ))}
              </Form.Select>
            </Col>
            <Col md={8} className="text-end">
              {canEdit && (
                <>
                  <Button
                    variant="warning"
                    className="me-2"
                    onClick={handleSyncUserAllocations}
                    disabled={!selectedModel || syncUserAllocationsMutation.isPending}
                    title="Apply this model to all associated users' subscriptions, scaled by each user's capital"
                  >
                    {syncUserAllocationsMutation.isPending ? (
                      <><Spinner as="span" size="sm" animation="border" className="me-1" /> Syncing…</>
                    ) : (
                      <><BsArrowRepeat /> Sync Associated User Allocations</>
                    )}
                  </Button>
                  <Button
                    variant="primary"
                    onClick={() => setShowAddModal(true)}
                    disabled={!selectedModel}
                  >
                    <BsPlus /> Add Strategy
                  </Button>
                </>
              )}
            </Col>
          </Row>
        </Card.Header>
        {selectedModelData && (
          <Card.Body className="py-2 bg-raised">
            <Row>
              <Col md={4}>
                <small className="text-ink-soft">Total Capital</small>
                <div className="font-bold">{formatCurrency(selectedModelData.capital)}</div>
              </Col>
              <Col md={4}>
                <small className="text-ink-soft">Intraday Capital</small>
                <div className="font-bold text-accent-600 dark:text-accent-400">{formatCurrency(selectedModelData.intradayCapital)}</div>
              </Col>
              <Col md={4}>
                <small className="text-ink-soft">Positional Capital</small>
                <div className="font-bold text-success-500 dark:text-success-400">{formatCurrency(selectedModelData.positionalCapital)}</div>
              </Col>
            </Row>
          </Card.Body>
        )}
      </Card>

      {/* Capital Calculation Info */}
      <Alert variant="light" className="mb-4 border">
        <small>
          <strong>Capital Calculation:</strong> Total Capital = Number of Lots × Capital per Lot.
          {' '}Capital per lot is determined by P0 (base strategy) hedging config:
          {' '}<Badge bg="success" className="me-1">Hedged: 1L</Badge>
          <Badge bg="secondary">Naked: 2.5L</Badge> (configurable per strategy).
        </small>
      </Alert>

      {!selectedModel ? (
        <Alert variant="info">
          Select an allocation model to view and manage its strategy mappings.
        </Alert>
      ) : isLoading ? (
        <div className="text-center py-12"><Spinner /></div>
      ) : (
        <>
          {/* Intraday Strategies Section */}
          {renderStrategyTable(
            'Intraday Strategies',
            <BsSun className="text-warning-700 dark:text-warning-400" />,
            capitalAllocation.intraday.strategies,
            selectedModelData?.intradayCapital || 0,
            capitalAllocation.intraday.used,
            capitalAllocation.intraday.percentage,
            'info',
            capitalAllocation.intraday.used + capitalAllocation.positional.used
          )}

          {/* Positional Strategies Section */}
          {renderStrategyTable(
            'Positional Strategies',
            <BsMoon className="text-primary-700 dark:text-primary-400" />,
            capitalAllocation.positional.strategies,
            selectedModelData?.positionalCapital || 0,
            capitalAllocation.positional.used,
            capitalAllocation.positional.percentage,
            'success',
            capitalAllocation.intraday.used + capitalAllocation.positional.used
          )}
        </>
      )}

      {/* Add Strategy Modal */}
      <Modal show={showAddModal} onHide={() => setShowAddModal(false)} size="lg" backdrop="static">
        <Modal.Header closeButton>
          <Modal.Title>Add Strategy to {selectedModel}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Form>
            <Form.Group className="mb-4">
              <Form.Label>Strategy</Form.Label>
              <Select
                options={strategyOptions}
                value={selectedStrategyOption}
                onChange={(opt) => setFormData({ ...formData, strategyName: opt?.value || '' })}
                placeholder="-- Select Strategy --"
                isSearchable
                isClearable
                classNamePrefix="react-select"
                menuPortalTarget={typeof document !== 'undefined' ? document.body : undefined}
                styles={{ menuPortal: (base) => ({ ...base, zIndex: 9999 }) }}
              />
            </Form.Group>

            <Form.Group className="mb-4">
              <Form.Label>Number of Lots</Form.Label>
              <Form.Control
                type="number"
                min={1}
                value={formData.numOfLots}
                onChange={(e) => setFormData({ ...formData, numOfLots: Number(e.target.value) })}
              />
            </Form.Group>

            <Form.Group className="mb-4">
              <Form.Check
                type="checkbox"
                id="mapping-overlap-capital"
                label="Overlap capital — exclude this mapping from the model total"
                checked={formData.mappingOverlapCapital}
                onChange={(e) => setFormData({ ...formData, mappingOverlapCapital: e.target.checked })}
              />
              <Form.Text muted>
                For the same strategy mapped on multiple indices (e.g. BID-NIFTY / BID-BNF / BID-SENSEX)
                where only a subset run at once. The per-lot capital still applies for sizing; it just
                isn&apos;t summed into the allocation-model total. Independent of the strategy-level overlap flag.
              </Form.Text>
            </Form.Group>

            {/* Capital Preview */}
            {modalCapitalPreview && selectedModelData && (
              <Alert variant={modalCapitalPreview.isOverlap ? 'warning' : 'info'}>
                <Row>
                  <Col md={6}>
                    <small className="text-ink-soft">Capital per Lot</small>
                    <div>
                      <Badge bg="success" className="me-1" title="Hedging Enabled">
                        Hedged: {formatCurrency(modalCapitalPreview.capitalPerLotHedged)}
                      </Badge>
                      <Badge bg="secondary" title="Hedging Disabled">
                        Naked: {formatCurrency(modalCapitalPreview.capitalPerLotNaked)}
                      </Badge>
                    </div>
                  </Col>
                  <Col md={3}>
                    <small className="text-ink-soft">Total Capital ({formData.numOfLots} lots)</small>
                    <div>
                      <div className="font-bold text-success-500 dark:text-success-400">{formatCurrency(modalCapitalPreview.totalCapitalHedged)}</div>
                      <small className="text-ink-soft">{formatCurrency(modalCapitalPreview.totalCapitalNaked)} (naked)</small>
                    </div>
                  </Col>
                  <Col md={3}>
                    <small className="text-ink-soft">Product Type</small>
                    <div>
                      <Badge bg={productBadgeBg(modalCapitalPreview.product)}>
                        {modalCapitalPreview.product}
                      </Badge>
                      {modalCapitalPreview.isOverlap && (
                        <Badge bg="warning" text="dark" className="ms-1">Overlap</Badge>
                      )}
                    </div>
                  </Col>
                </Row>
                <hr className="my-2" />
                <small>
                  {modalCapitalPreview.isOverlap ? (
                    <span className="text-warning-700 dark:text-warning-400">
                      This strategy uses overlap capital and will NOT be counted towards allocation percentage.
                    </span>
                  ) : (
                    <>
                      <strong>Note:</strong> Actual capital per lot depends on P0 hedging config.
                      {' '}Hedged strategies use ~1L/lot, Naked strategies use ~2.5L/lot (configurable per strategy).
                    </>
                  )}
                </small>
              </Alert>
            )}
          </Form>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={() => setShowAddModal(false)}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => addStrategyMutation.mutate(formData)}
            disabled={addStrategyMutation.isPending || !formData.strategyName}
          >
            {addStrategyMutation.isPending ? <Spinner size="sm" /> : 'Add Strategy'}
          </Button>
        </Modal.Footer>
      </Modal>

      <ConfirmModal
        show={showSyncConfirm}
        title="Sync Associated User Allocations"
        message={
          <>
            Sync all user+brokers associated with <strong>{selectedModel}</strong> to this model?
            <br /><br />
            For each associated user, every mapped strategy's subscription capital is set to the model
            amount scaled by <em>(their allocated capital ÷ model capital)</em>. New subscriptions are
            added <strong>inactive</strong>; existing active/inactive state is preserved; subscriptions
            for strategies no longer in the model are <strong>removed</strong>.
          </>
        }
        confirmLabel="Sync"
        confirmVariant="warning"
        onConfirm={() => syncUserAllocationsMutation.mutate()}
        onCancel={() => setShowSyncConfirm(false)}
        isLoading={syncUserAllocationsMutation.isPending}
      />
    </>
  );
};

// Helper to create default allocation config
const createDefaultAllocationConfig = (strategyName: string, allocationModel: string): StrategyDaysAllocationConfig => ({
  strategyName,
  allocationModel,
  mondayAllocation: 100,
  tuesdayAllocation: 100,
  wednesdayAllocation: 100,
  thursdayAllocation: 100,
  fridayAllocation: 100,
  expiryDayAllocation: 100,
  dt1DayAllocation: 100,
  dt2DayAllocation: 100,
});

// Get badge color based on allocation percentage
const getAllocationBadgeVariant = (value: number): string => {
  if (value === 0) return 'danger';
  if (value < 50) return 'warning';
  if (value < 100) return 'info';
  return 'success';
};

// ==================== DAYWISE MAPPINGS PANEL (Strategy Days) ====================
const DaywiseMappingsPanel: React.FC<{ canEdit: boolean; canManage: boolean }> = ({ canEdit, canManage }) => {
  const [search, setSearch] = useState('');
  const [selectedModel, setSelectedModel] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editingConfig, setEditingConfig] = useState<StrategyDaysAllocationConfig | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<StrategyDaysAllocationConfig | null>(null);
  const queryClient = useQueryClient();

  const { data: configs, isLoading, error } = useQuery({
    queryKey: ['admin', 'strategyDaysAllocation'],
    queryFn: () => strategyDaysAllocationService.getAll(),
  });

  const { data: strategies } = useQuery({
    queryKey: ['strategyDefinitions'],
    queryFn: () => strategyDefinitionService.getAll(),
  });

  const { data: allocationModels } = useQuery({
    queryKey: ['admin', 'allocationModels'],
    queryFn: () => allocationModelService.getAll(),
  });

  // Get strategies mapped to selected allocation model
  const { data: modelStrategies } = useQuery({
    queryKey: ['admin', 'allocationModelStrategies', selectedModel],
    queryFn: () => allocationModelService.getStrategies(selectedModel),
    enabled: !!selectedModel,
  });

  const saveMutation = useMutation({
    mutationFn: (data: StrategyDaysAllocationConfig) => strategyDaysAllocationService.save(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'strategyDaysAllocation'] });
      setShowModal(false);
      setEditingConfig(null);
      toast.success('Day-wise allocation saved successfully');
    },
    onError: (error: { message?: string }) => {
      toast.error(error.message || 'Failed to save day-wise allocation');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (config: StrategyDaysAllocationConfig) =>
      strategyDaysAllocationService.delete(config.strategyName, config.allocationModel),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'strategyDaysAllocation'] });
      toast.success('Day-wise allocation deleted');
      setDeleteTarget(null);
    },
    onError: (error: { message?: string }) => {
      toast.error(error.message || 'Failed to delete day-wise allocation');
    },
  });

  const [formData, setFormData] = useState<StrategyDaysAllocationConfig>(
    createDefaultAllocationConfig('', '')
  );

  // Filter configs by selected allocation model and search term
  const filteredConfigs = useMemo(() => {
    if (!configs) return [];
    let result = configs;

    // Filter by allocation model
    if (selectedModel) {
      result = result.filter(c => c.allocationModel === selectedModel);
    }

    // Filter by search term
    if (search) {
      const searchLower = search.toLowerCase();
      result = result.filter(
        (c) =>
          c.strategyName?.toLowerCase().includes(searchLower) ||
          c.allocationModel?.toLowerCase().includes(searchLower)
      );
    }

    return result;
  }, [configs, selectedModel, search]);

  // Get strategies available for adding (mapped to model but not yet configured for day allocation)
  const availableStrategiesForAdd = useMemo(() => {
    if (!selectedModel || !modelStrategies || !configs) return [];
    const configuredStrategies = new Set(
      configs.filter(c => c.allocationModel === selectedModel).map(c => c.strategyName)
    );
    return modelStrategies.filter(ms => !configuredStrategies.has(ms.strategyName));
  }, [selectedModel, modelStrategies, configs]);

  const handleSave = () => {
    // Validate all allocations are 0-100
    const allocationKeys = DAY_ALLOCATION_FIELDS.map(f => f.key);
    for (const key of allocationKeys) {
      const value = formData[key as keyof StrategyDaysAllocationConfig] as number;
      if (value < 0 || value > 100) {
        toast.error(`${key.replace('Allocation', '')} allocation must be between 0 and 100`);
        return;
      }
    }
    saveMutation.mutate(formData);
  };

  const openAddModal = () => {
    setEditingConfig(null);
    setFormData(createDefaultAllocationConfig('', selectedModel));
    setShowModal(true);
  };

  const openEditModal = (config: StrategyDaysAllocationConfig) => {
    setEditingConfig(config);
    setFormData({ ...config });
    setShowModal(true);
  };

  const handleAllocationChange = (field: string, value: number) => {
    // Clamp value between 0 and 100
    const clampedValue = Math.min(100, Math.max(0, value));
    setFormData(prev => ({ ...prev, [field]: clampedValue }));
  };

  // Inline update handler for table cells
  const handleInlineUpdate = (config: StrategyDaysAllocationConfig, field: string, value: number) => {
    const clampedValue = Math.min(100, Math.max(0, value));
    const updatedConfig = { ...config, [field]: clampedValue };
    saveMutation.mutate(updatedConfig);
  };

  if (error) return <Alert variant="danger">Failed to load day-wise allocations</Alert>;

  return (
    <>
      <Alert variant="info" className="mb-4">
        <strong>Day-wise Allocation</strong>: Configure what percentage (0-100%) of lots to use for each strategy on specific days.
        Default is 100% if not configured. For example, if a strategy has 2 lots and Expiry Day allocation is 50%, only 1 lot will be used on expiry days.
      </Alert>

      <Card>
        <Card.Header>
          <Row className="items-center ">
            <Col md={4}>
              <Form.Select
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
              >
                <option value="">-- All Allocation Models --</option>
                {allocationModels?.map((m) => (
                  <option key={m.name} value={m.name}>
                    {m.name}
                  </option>
                ))}
              </Form.Select>
            </Col>
            <Col md={4}>
              <InputGroup>
                <InputGroup.Text><BsSearch /></InputGroup.Text>
                <Form.Control
                  placeholder="Search by strategy..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </InputGroup>
            </Col>
            <Col md={4} className="text-end">
              {canEdit && (
                <Button
                  variant="primary"
                  onClick={openAddModal}
                  disabled={!selectedModel}
                  title={!selectedModel ? 'Select an allocation model first' : ''}
                >
                  <BsPlus /> Add Day-wise Config
                </Button>
              )}
            </Col>
          </Row>
        </Card.Header>
        <Card.Body className="p-0">
          {isLoading ? (
            <div className="text-center py-12"><Spinner /></div>
          ) : (
            <div className="overflow-x-auto">
              <Table striped hover className="mb-0" size="sm">
                <thead>
                  <tr>
                    <th style={{ minWidth: '150px' }}>Strategy</th>
                    <th style={{ minWidth: '120px' }}>Alloc. Model</th>
                    {DAY_ALLOCATION_FIELDS.map(day => (
                      <th key={day.key} className="text-center" style={{ minWidth: '80px' }} title={day.fullLabel}>
                        {day.label}
                      </th>
                    ))}
                    <th style={{ width: '80px' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredConfigs.length === 0 ? (
                    <tr>
                      <td colSpan={11} className="text-center py-6 text-ink-soft">
                        {selectedModel
                          ? 'No day-wise allocations configured for this model. Click "Add Day-wise Config" to create one.'
                          : 'Select an allocation model to view its day-wise configurations.'}
                      </td>
                    </tr>
                  ) : (
                    filteredConfigs.map((config) => {
                      const strategy = strategies?.find((s: StrategyDefinition) => s.strategyName === config.strategyName);
                      return (
                      <tr key={`${config.strategyName}-${config.allocationModel}`}>
                        <td className="font-medium">
                          {strategy?.displayName || config.strategyName}
                          <br />
                          <small className="text-ink-soft"><code>{config.strategyName}</code></small>
                        </td>
                        <td>
                          <Badge bg="info">{config.allocationModel}</Badge>
                        </td>
                        {DAY_ALLOCATION_FIELDS.map(day => {
                          const value = config[day.key as keyof StrategyDaysAllocationConfig] as number;
                          return (
                            <td key={day.key} className="text-center p-1">
                              <Form.Control
                                type="number"
                                size="sm"
                                min={0}
                                max={100}
                                value={value}
                                onChange={(e) => handleInlineUpdate(config, day.key, Number(e.target.value))}
                                disabled={saveMutation.isPending || !canEdit}
                                className="text-center"
                                style={{ width: '75px', margin: '0 auto' }}
                                title={`${day.fullLabel}: ${value}%`}
                              />
                            </td>
                          );
                        })}
                        <td>
                          <div className="flex gap-1">
                            <Button
                              variant="outline-primary"
                              size="sm"
                              onClick={() => openEditModal(config)}
                              title={canEdit ? 'Edit all allocations' : 'View all allocations'}
                            >
                              {canEdit ? <BsPencil /> : <BsEye />}
                            </Button>
                            {canManage && (
                              <Button
                                variant="outline-danger"
                                size="sm"
                                onClick={() => setDeleteTarget(config)}
                                disabled={deleteMutation.isPending}
                                title="Delete configuration"
                              >
                                <BsTrash />
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                    })
                  )}
                </tbody>
              </Table>
            </div>
          )}
        </Card.Body>
        <Card.Footer className="text-ink-soft text-[0.875em] flex justify-between">
          <span>Total: {filteredConfigs.length} configuration(s)</span>
          <span>Values are percentages (0-100%). Default: 100%</span>
        </Card.Footer>
      </Card>

      {/* Add/Edit/View Modal */}
      <Modal show={showModal} onHide={() => setShowModal(false)} size="lg" backdrop={editingConfig && !canEdit ? true : 'static'}>
        <Modal.Header closeButton>
          <Modal.Title>
            {editingConfig ? (canEdit ? <BsPencil className="me-2" /> : <BsEye className="me-2" />) : null}
            {editingConfig ? (canEdit ? 'Edit' : 'View') : 'Add'} Day-wise Allocation
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Form>
            <fieldset disabled={!!editingConfig && !canEdit}>
            <Row className="mb-4">
              <Col md={6}>
                <Form.Group>
                  <Form.Label>Strategy</Form.Label>
                  <Form.Select
                    value={formData.strategyName}
                    onChange={(e) => setFormData({ ...formData, strategyName: e.target.value })}
                    disabled={!!editingConfig}
                  >
                    <option value="">-- Select Strategy --</option>
                    {editingConfig ? (
                      <option value={editingConfig.strategyName}>{editingConfig.strategyName}</option>
                    ) : (
                      availableStrategiesForAdd.map((ms) => {
                        const strategy = strategies?.find((s: StrategyDefinition) => s.strategyName === ms.strategyName);
                        return (
                          <option key={ms.strategyName} value={ms.strategyName}>
                            {strategy?.displayName || ms.strategyName}
                          </option>
                        );
                      })
                    )}
                  </Form.Select>
                  {!editingConfig && availableStrategiesForAdd.length === 0 && selectedModel && (
                    <Form.Text className="text-warning-700 dark:text-warning-400">
                      All strategies in this model already have day-wise configs.
                    </Form.Text>
                  )}
                </Form.Group>
              </Col>
              <Col md={6}>
                <Form.Group>
                  <Form.Label>Allocation Model</Form.Label>
                  <Form.Select
                    value={formData.allocationModel}
                    onChange={(e) => setFormData({ ...formData, allocationModel: e.target.value })}
                    disabled={!!editingConfig || !!selectedModel}
                  >
                    <option value="">-- Select Allocation Model --</option>
                    {allocationModels?.map((m) => (
                      <option key={m.name} value={m.name}>
                        {m.name}
                      </option>
                    ))}
                  </Form.Select>
                </Form.Group>
              </Col>
            </Row>

            <hr />
            <h6 className="mb-4">Day Allocations (0-100%)</h6>

            {/* Weekday allocations */}
            <Row className="mb-4">
              {DAY_ALLOCATION_FIELDS.slice(0, 5).map(day => (
                <Col key={day.key}>
                  <Form.Group>
                    <Form.Label className="text-[0.875em]">{day.fullLabel}</Form.Label>
                    <InputGroup size="sm">
                      <Form.Control
                        type="number"
                        min={0}
                        max={100}
                        value={formData[day.key as keyof StrategyDaysAllocationConfig] as number}
                        onChange={(e) => handleAllocationChange(day.key, Number(e.target.value))}
                        className="text-center"
                      />
                      <InputGroup.Text>%</InputGroup.Text>
                    </InputGroup>
                  </Form.Group>
                </Col>
              ))}
            </Row>

            {/* Special day allocations */}
            <Row>
              {DAY_ALLOCATION_FIELDS.slice(5).map(day => (
                <Col md={4} key={day.key}>
                  <Form.Group className="mb-4">
                    <Form.Label className="text-[0.875em]">{day.fullLabel}</Form.Label>
                    <InputGroup size="sm">
                      <Form.Control
                        type="number"
                        min={0}
                        max={100}
                        value={formData[day.key as keyof StrategyDaysAllocationConfig] as number}
                        onChange={(e) => handleAllocationChange(day.key, Number(e.target.value))}
                        className="text-center"
                      />
                      <InputGroup.Text>%</InputGroup.Text>
                    </InputGroup>
                  </Form.Group>
                </Col>
              ))}
            </Row>

            {/* Preview */}
            <Alert variant="light" className="mt-4">
              <small className="font-bold block mb-2">Preview:</small>
              <div className="flex flex-wrap gap-2">
                {DAY_ALLOCATION_FIELDS.map(day => {
                  const value = formData[day.key as keyof StrategyDaysAllocationConfig] as number;
                  return (
                    <Badge
                      key={day.key}
                      bg={getAllocationBadgeVariant(value)}
                      className="py-2 px-4"
                    >
                      {day.label}: {value}%
                    </Badge>
                  );
                })}
              </div>
            </Alert>
            </fieldset>
          </Form>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={() => setShowModal(false)}>
            {editingConfig && !canEdit ? 'Close' : 'Cancel'}
          </Button>
          {(canEdit || !editingConfig) && (
            <Button
              variant="primary"
              onClick={handleSave}
              disabled={saveMutation.isPending || !formData.strategyName || !formData.allocationModel}
            >
              {saveMutation.isPending ? <Spinner size="sm" /> : 'Save'}
            </Button>
          )}
        </Modal.Footer>
      </Modal>

      {/* Delete Daywise Config Confirmation */}
      <ConfirmModal
        show={!!deleteTarget}
        title="Delete Day-wise Allocation"
        message={`Are you sure you want to delete the day-wise configuration for "${deleteTarget?.strategyName}"? This action cannot be undone.`}
        confirmLabel="Delete"
        confirmVariant="danger"
        onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget)}
        onCancel={() => setDeleteTarget(null)}
        isLoading={deleteMutation.isPending}
      />
    </>
  );
};

// ==================== MAIN COMPONENT ====================
const AllocationModelsPage: React.FC = () => {
  const [activeTab, setActiveTab] = useState('models');
  const permissions = usePermissions();

  // Permission flags for Allocation Models tool
  const canEdit = permissions.allocationModels.canEdit;
  const canManage = permissions.allocationModels.canManage;

  return (
    <div className="fade-in">
      <PageHeader
        title="Allocation Models"
        subtitle="Configure allocation models, strategy mappings, and day-wise multipliers"
        icon={<BsPieChart size={24} />}
      />

      <Tabs activeKey={activeTab} onSelect={(k) => setActiveTab(k || 'models')} className="mb-4">
        <Tab eventKey="models" title="Allocation Models">
          <AllocationModels title="All Allocation Models" hideCreate={!canEdit} hideDelete={!canManage} readOnly={!canEdit} />
        </Tab>
        <Tab eventKey="strategy-mappings" title="Strategy Mappings">
          <StrategyMappingsPanel canEdit={canEdit} canManage={canManage} />
        </Tab>
        <Tab eventKey="daywise-mappings" title="Daywise Mappings">
          <DaywiseMappingsPanel canEdit={canEdit} canManage={canManage} />
        </Tab>
      </Tabs>
    </div>
  );
};

export default AllocationModelsPage;
