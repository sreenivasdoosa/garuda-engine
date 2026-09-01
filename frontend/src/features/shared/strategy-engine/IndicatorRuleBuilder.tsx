import { Card, Form, Button, Row, Col, Badge, InputGroup, ButtonGroup, Alert } from '@/components/ui/rbShim';
import { BsPlus, BsTrash, BsArrowRight, BsArrowUp, BsArrowDown } from 'react-icons/bs';
import type {
  RuleNode,
  RuleCondition,
  IndicatorType,
  RuleComparator,
  CandleInterval,
  DirectionRules,
  IndicatorRuleSet,
  RuleDirection,
} from '@/types/strategy-engine';
import {
  INDICATOR_DEFINITIONS,
  COMPARATOR_DEFINITIONS,
  CANDLE_INTERVAL_DEFINITIONS,
} from '@/types/strategy-engine';

// Direction action labels based on trade mode
const getDirectionLabels = (tradeMode?: string): { longAction: string; shortAction: string } => {
  if (tradeMode === 'OPTION_BUYING') {
    return { longAction: 'Buy CE', shortAction: 'Buy PE' };
  }
  return { longAction: 'Sell PE', shortAction: 'Sell CE' };
};

// ==================== Single Direction Props ====================
interface IndicatorRuleBuilderProps {
  title: string;
  ruleNode: RuleNode | null;
  onChange: (node: RuleNode | null) => void;
  direction?: RuleDirection;
  onDirectionChange?: (direction: RuleDirection) => void;
  showDirection?: boolean;
  tradeMode?: string;
}

/**
 * Visual rule builder for AND/OR rule trees with indicator conditions.
 * Supports nested grouping and indicator-to-indicator comparisons.
 */
export function IndicatorRuleBuilder({
  title,
  ruleNode,
  onChange,
  direction,
  onDirectionChange,
  showDirection = false,
  tradeMode,
}: IndicatorRuleBuilderProps) {
  // Create default condition
  const createDefaultCondition = (): RuleCondition => ({
    indicator: 'RSI',
    params: { period: 14 },
    interval: '15minute',
    comparator: 'GREATER_THAN',
    value: 30,
  });

  // Create default rule node (single condition)
  const createDefaultNode = (): RuleNode => ({
    type: 'condition',
    condition: createDefaultCondition(),
  });

  // Add root node if none exists
  const handleAddRoot = () => {
    onChange({
      type: 'operator',
      operator: 'AND',
      children: [createDefaultNode()],
    });
  };

  // Render the rule tree
  const renderNode = (node: RuleNode, path: number[], depth: number = 0): JSX.Element => {
    // Check if this is an operator node (has operator field) or condition node (has condition field)
    const isOperatorNode = node.operator != null || node.type === 'operator';
    if (isOperatorNode) {
      return (
        <OperatorNode
          key={path.join('-')}
          node={node}
          path={path}
          depth={depth}
          onChange={(updatedNode) => updateNodeAtPath(path, updatedNode)}
          onDelete={() => deleteNodeAtPath(path)}
          onAddCondition={() => addChildToPath(path, createDefaultNode())}
          onAddGroup={() => addChildToPath(path, {
            type: 'operator',
            operator: 'AND',
            children: [createDefaultNode()],
          })}
          renderChild={(child, idx) => renderNode(child, [...path, idx], depth + 1)}
        />
      );
    } else {
      return (
        <ConditionNode
          key={path.join('-')}
          node={node}
          onChange={(updatedNode) => updateNodeAtPath(path, updatedNode)}
          onDelete={() => deleteNodeAtPath(path)}
        />
      );
    }
  };

  // Update node at specific path
  const updateNodeAtPath = (path: number[], updatedNode: RuleNode | null) => {
    if (!ruleNode) return;
    if (path.length === 0) {
      onChange(updatedNode);
      return;
    }
    const newRoot = JSON.parse(JSON.stringify(ruleNode));
    let current = newRoot;
    for (let i = 0; i < path.length - 1; i++) {
      current = current.children[path[i]];
    }
    if (updatedNode === null) {
      current.children.splice(path[path.length - 1], 1);
    } else {
      current.children[path[path.length - 1]] = updatedNode;
    }
    onChange(newRoot);
  };

  // Delete node at path
  const deleteNodeAtPath = (path: number[]) => {
    if (!ruleNode) return;
    if (path.length === 0) {
      onChange(null);
      return;
    }
    const newRoot = JSON.parse(JSON.stringify(ruleNode));
    let current = newRoot;
    for (let i = 0; i < path.length - 1; i++) {
      current = current.children[path[i]];
    }
    current.children.splice(path[path.length - 1], 1);
    // If operator has no children, remove it too
    if (current.children.length === 0) {
      if (path.length > 1) {
        deleteNodeAtPath(path.slice(0, -1));
      } else {
        // Root operator with no children — clear the entire rule
        onChange(null);
      }
    } else {
      onChange(newRoot);
    }
  };

  // Add child to operator at path
  const addChildToPath = (path: number[], child: RuleNode) => {
    if (!ruleNode) return;
    const newRoot = JSON.parse(JSON.stringify(ruleNode));
    let current = newRoot;
    for (const idx of path) {
      current = current.children[idx];
    }
    if (!current.children) {
      current.children = [];
    }
    current.children.push(child);
    onChange(newRoot);
  };

  return (
    <Card className="mb-4">
      <Card.Header className="flex justify-between items-center">
        <span>{title}</span>
        {showDirection && direction && onDirectionChange && (
          <div className="flex items-center gap-2">
            <span className="text-ink-soft text-[0.875em]">When rules match, go:</span>
            <ButtonGroup size="sm">
              <Button
                variant={direction === 'LONG' ? 'success' : 'outline-success'}
                onClick={() => onDirectionChange('LONG')}
              >
                LONG ({getDirectionLabels(tradeMode).longAction})
              </Button>
              <Button
                variant={direction === 'SHORT' ? 'danger' : 'outline-danger'}
                onClick={() => onDirectionChange('SHORT')}
              >
                SHORT ({getDirectionLabels(tradeMode).shortAction})
              </Button>
            </ButtonGroup>
          </div>
        )}
      </Card.Header>
      <Card.Body>
        {!ruleNode ? (
          <div className="text-center py-6">
            <p className="text-ink-soft mb-4">No rules defined. Add a rule to get started.</p>
            <Button variant="primary" size="sm" onClick={handleAddRoot}>
              <BsPlus className="me-1" /> Add Rule
            </Button>
          </div>
        ) : (
          renderNode(ruleNode, [])
        )}
      </Card.Body>
    </Card>
  );
}

// ==================== Operator Node ====================

interface OperatorNodeProps {
  node: RuleNode;
  path: number[];
  depth: number;
  onChange: (node: RuleNode) => void;
  onDelete: () => void;
  onAddCondition: () => void;
  onAddGroup: () => void;
  renderChild: (child: RuleNode, idx: number) => JSX.Element;
}

function OperatorNode({
  node,
  path,
  depth,
  onChange,
  onDelete,
  onAddCondition,
  onAddGroup,
  renderChild,
}: OperatorNodeProps) {
  const isRoot = path.length === 0;
  const bgColor = depth % 2 === 0 ? 'bg-raised' : 'bg-card';

  return (
    <div className={`p-2 rounded-md border ${bgColor} mb-2`}>
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <ButtonGroup size="sm">
          <Button
            variant={node.operator === 'AND' ? 'primary' : 'outline-primary'}
            onClick={() => onChange({ ...node, operator: 'AND' })}
          >
            AND
          </Button>
          <Button
            variant={node.operator === 'OR' ? 'warning' : 'outline-warning'}
            onClick={() => onChange({ ...node, operator: 'OR' })}
          >
            OR
          </Button>
        </ButtonGroup>
        <Badge bg={node.operator === 'AND' ? 'primary' : 'warning'}>
          {node.operator === 'AND' ? 'All conditions must match' : 'Any condition can match'}
        </Badge>
        <div className="ms-auto flex gap-1">
          <Button variant="outline-success" size="sm" onClick={onAddCondition} title="Add condition">
            <BsPlus /> Condition
          </Button>
          <Button variant="outline-info" size="sm" onClick={onAddGroup} title="Add nested group">
            <BsPlus /> Group
          </Button>
          {!isRoot && (
            <Button variant="outline-danger" size="sm" onClick={onDelete} title="Delete group">
              <BsTrash />
            </Button>
          )}
        </div>
      </div>
      <div className="ps-4 border-s border-2" style={{ borderColor: node.operator === 'AND' ? '#0d6efd' : '#ffc107' }}>
        {node.children?.map((child, idx) => (
          <div key={idx} className="relative">
            {idx > 0 && (
              <div className="absolute start-0 top-1/2 -translate-y-1/2" style={{ marginLeft: '-1.5rem' }}>
                <Badge bg={node.operator === 'AND' ? 'primary' : 'warning'} pill className="px-1" style={{ fontSize: '0.6rem' }}>
                  {node.operator}
                </Badge>
              </div>
            )}
            {renderChild(child, idx)}
          </div>
        ))}
        {(!node.children || node.children.length === 0) && (
          <div className="text-ink-soft text-[0.875em] py-2">No conditions in this group</div>
        )}
      </div>
    </div>
  );
}

// ==================== Condition Node ====================

interface ConditionNodeProps {
  node: RuleNode;
  onChange: (node: RuleNode) => void;
  onDelete: () => void;
}

function ConditionNode({ node, onChange, onDelete }: ConditionNodeProps) {
  const condition = node.condition!;
  const indicatorDef = INDICATOR_DEFINITIONS.find(i => i.value === condition.indicator);
  const comparatorDef = COMPARATOR_DEFINITIONS.find(c => c.value === condition.comparator);

  // Check if this comparator requires a reference indicator
  const requiresReference = comparatorDef?.requiresReference ?? false;

  // Derive compare mode: 'indicator' or 'value'
  const compareMode: 'indicator' | 'value' = requiresReference
    ? 'indicator'
    : condition.referenceIndicator
      ? 'indicator'
      : 'value';

  // Update condition field
  const updateCondition = (updates: Partial<RuleCondition>) => {
    onChange({
      ...node,
      condition: { ...condition, ...updates },
    });
  };

  // Handle indicator change - reset params to defaults
  const handleIndicatorChange = (newIndicator: IndicatorType) => {
    const newDef = INDICATOR_DEFINITIONS.find(i => i.value === newIndicator);
    const newParams: Record<string, number | string> = {};
    newDef?.params.forEach(p => {
      newParams[p.name] = p.defaultValue;
    });

    // Set appropriate default comparator and value based on indicator type
    const updates: Partial<RuleCondition> = {
      indicator: newIndicator,
      params: newParams,
      referenceIndicator: undefined,
      referenceParams: undefined,
      referenceInterval: undefined,
    };

    if (newIndicator === 'SUPERTREND') {
      // Default to FLIP for Supertrend (detects state changes)
      updates.comparator = 'FLIP';
      updates.value = 'GREEN';
    } else {
      updates.comparator = 'GREATER_THAN';
      updates.value = newDef?.valueType === 'string' ? newDef.stringValues?.[0] : 0;
    }

    updateCondition(updates);
  };

  // Handle comparator change - may need to add/remove reference
  const handleComparatorChange = (newComparator: RuleComparator) => {
    const newDef = COMPARATOR_DEFINITIONS.find(c => c.value === newComparator);
    const updates: Partial<RuleCondition> = { comparator: newComparator };
    if (newDef?.requiresReference && !condition.referenceIndicator) {
      // Crossover comparator needs a reference indicator
      updates.referenceIndicator = 'EMA';
      updates.referenceParams = { period: 20 };
      updates.referenceInterval = condition.interval;
      updates.value = undefined;
    } else if (newDef?.forSupertrend) {
      // FLIP comparator - always clear reference, use string value
      updates.referenceIndicator = undefined;
      updates.referenceParams = undefined;
      updates.referenceInterval = undefined;
      updates.value = 'GREEN';
    } else if (condition.indicator === 'SUPERTREND' &&
               (newComparator === 'EQUAL' || newComparator === 'NOT_EQUAL')) {
      // SuperTrend with EQUAL/NOT_EQUAL: use string state (GREEN/RED)
      updates.referenceIndicator = undefined;
      updates.referenceParams = undefined;
      updates.referenceInterval = undefined;
      updates.value = 'GREEN';
    } else if (condition.indicator === 'SUPERTREND' && !newDef?.requiresReference) {
      // SuperTrend switching to numeric comparator (>, <, etc.)
      // Default to comparing with a reference indicator (PRICE) since the
      // supertrend line value is a price-level number
      if (!condition.referenceIndicator) {
        updates.referenceIndicator = 'PRICE';
        updates.referenceParams = { type: 'CLOSE' };
        updates.referenceInterval = condition.interval;
        updates.value = undefined;
      }
    }
    // For regular numeric comparators, PRESERVE existing reference if set
    // (user may have toggled to indicator mode previously)
    updateCondition(updates);
  };

  return (
    <div className="bg-card border rounded-md p-2 mb-2">
      <Row className=" items-center">
        {/* Indicator Selection */}
        <Col xs="auto">
          <Form.Select
            size="sm"
            value={condition.indicator}
            onChange={(e) => handleIndicatorChange(e.target.value as IndicatorType)}
            style={{ minWidth: '120px' }}
          >
            {INDICATOR_DEFINITIONS.map(ind => (
              <option key={ind.value} value={ind.value}>{ind.label}</option>
            ))}
          </Form.Select>
        </Col>

        {/* Indicator Parameters */}
        {indicatorDef?.params.map(param => (
          <Col xs="auto" key={param.name}>
            {param.type === 'select' ? (
              <Form.Select
                size="sm"
                value={condition.params[param.name] ?? param.defaultValue}
                onChange={(e) => updateCondition({
                  params: { ...condition.params, [param.name]: e.target.value }
                })}
                style={{ minWidth: '80px' }}
              >
                {param.options?.map(opt => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
              </Form.Select>
            ) : (
              <InputGroup size="sm" style={{ width: '90px' }}>
                <Form.Control
                  type="number"
                  value={condition.params[param.name] ?? param.defaultValue}
                  onChange={(e) => updateCondition({
                    params: { ...condition.params, [param.name]: parseFloat(e.target.value) || 0 }
                  })}
                  placeholder={param.label}
                  title={param.label}
                />
              </InputGroup>
            )}
          </Col>
        ))}

        {/* Interval */}
        <Col xs="auto">
          <Form.Select
            size="sm"
            value={condition.interval}
            onChange={(e) => updateCondition({ interval: e.target.value as CandleInterval })}
            style={{ minWidth: '80px' }}
          >
            {CANDLE_INTERVAL_DEFINITIONS.map(int => (
              <option key={int.value} value={int.value}>{int.label}</option>
            ))}
          </Form.Select>
        </Col>

        {/* Comparator */}
        <Col xs="auto">
          <Form.Select
            size="sm"
            value={condition.comparator}
            onChange={(e) => handleComparatorChange(e.target.value as RuleComparator)}
            style={{ minWidth: '100px' }}
          >
            {/* Filter comparators based on indicator type */}
            {COMPARATOR_DEFINITIONS
              .filter(comp => {
                // For Supertrend: show all comparators (numeric + state-based)
                // Numeric (>, <, etc.) compare against the trend line value
                // EQUAL/NOT_EQUAL compare against GREEN/RED state
                // FLIP detects state transitions
                if (condition.indicator === 'SUPERTREND') {
                  return true; // all comparators are valid
                }
                // For other indicators: hide FLIP (it's Supertrend-only)
                return !comp.forSupertrend;
              })
              .map(comp => (
                <option key={comp.value} value={comp.value}>{comp.symbol} {comp.label}</option>
              ))}
          </Form.Select>
        </Col>

        {/* Compare Mode Toggle - shown for numeric comparators (including Supertrend with >, <, etc.) */}
        {!requiresReference && !comparatorDef?.forSupertrend && (indicatorDef?.valueType !== 'string' || (
          condition.indicator === 'SUPERTREND' && condition.comparator !== 'EQUAL' && condition.comparator !== 'NOT_EQUAL'
        )) && (
          <Col xs="auto">
            <ButtonGroup size="sm">
              <Button
                variant={compareMode === 'value' ? 'primary' : 'outline-primary'}
                onClick={() => {
                  // Switch to value mode: clear reference, set default value
                  updateCondition({
                    referenceIndicator: undefined,
                    referenceParams: undefined,
                    referenceInterval: undefined,
                    value: 0,
                  });
                }}
                title="Compare against a fixed value"
                style={{ fontSize: '0.75rem', padding: '0.15rem 0.4rem' }}
              >
                123
              </Button>
              <Button
                variant={compareMode === 'indicator' ? 'primary' : 'outline-primary'}
                onClick={() => {
                  // Switch to indicator mode: set default reference, clear value
                  updateCondition({
                    referenceIndicator: 'EMA',
                    referenceParams: { period: 20 },
                    referenceInterval: condition.interval,
                    value: undefined,
                  });
                }}
                title="Compare against another indicator"
                style={{ fontSize: '0.75rem', padding: '0.15rem 0.4rem' }}
              >
                f(x)
              </Button>
            </ButtonGroup>
          </Col>
        )}

        {/* Value or Reference Indicator */}
        {compareMode === 'indicator' ? (
          <>
            <Col xs="auto">
              <Form.Select
                size="sm"
                value={condition.referenceIndicator || 'EMA'}
                onChange={(e) => {
                  const refInd = e.target.value as IndicatorType;
                  const refDef = INDICATOR_DEFINITIONS.find(i => i.value === refInd);
                  const refParams: Record<string, number | string> = {};
                  refDef?.params.forEach(p => {
                    refParams[p.name] = p.defaultValue;
                  });
                  updateCondition({ referenceIndicator: refInd, referenceParams: refParams });
                }}
                style={{ minWidth: '100px' }}
              >
                {INDICATOR_DEFINITIONS.filter(i =>
                  i.valueType === 'numeric' || i.valueType === 'band' || i.value === 'SUPERTREND'
                ).map(ind => (
                  <option key={ind.value} value={ind.value}>{ind.label}</option>
                ))}
              </Form.Select>
            </Col>
            {/* Reference indicator params */}
            {INDICATOR_DEFINITIONS.find(i => i.value === condition.referenceIndicator)?.params.map(param => (
              <Col xs="auto" key={`ref_${param.name}`}>
                {param.type === 'select' ? (
                  <Form.Select
                    size="sm"
                    value={condition.referenceParams?.[param.name] ?? param.defaultValue}
                    onChange={(e) => updateCondition({
                      referenceParams: { ...condition.referenceParams, [param.name]: e.target.value }
                    })}
                    style={{ minWidth: '80px' }}
                  >
                    {param.options?.map(opt => (
                      <option key={opt} value={opt}>{opt}</option>
                    ))}
                  </Form.Select>
                ) : (
                  <InputGroup size="sm" style={{ width: '80px' }}>
                    <Form.Control
                      type="number"
                      value={condition.referenceParams?.[param.name] ?? param.defaultValue}
                      onChange={(e) => updateCondition({
                        referenceParams: { ...condition.referenceParams, [param.name]: parseFloat(e.target.value) || 0 }
                      })}
                      placeholder={param.label}
                      title={param.label}
                    />
                  </InputGroup>
                )}
              </Col>
            ))}
            {/* Reference indicator interval */}
            <Col xs="auto">
              <Form.Select
                size="sm"
                value={condition.referenceInterval || condition.interval}
                onChange={(e) => updateCondition({ referenceInterval: e.target.value as CandleInterval })}
                style={{ minWidth: '80px' }}
              >
                {CANDLE_INTERVAL_DEFINITIONS.map(int => (
                  <option key={int.value} value={int.value}>{int.label}</option>
                ))}
              </Form.Select>
            </Col>
          </>
        ) : (
          <Col xs="auto">
            {/* Show string dropdown for string-valued indicators (SuperTrend GREEN/RED) when using
                state-based comparators (EQUAL, NOT_EQUAL, FLIP). For numeric comparators on SuperTrend,
                show numeric input since the comparator uses the trend line value. */}
            {indicatorDef?.valueType === 'string' &&
             (condition.comparator === 'EQUAL' || condition.comparator === 'NOT_EQUAL' || condition.comparator === 'FLIP') ? (
              <Form.Select
                size="sm"
                value={condition.value as string}
                onChange={(e) => updateCondition({ value: e.target.value })}
                style={{ minWidth: '80px' }}
              >
                {indicatorDef.stringValues?.map(v => (
                  <option key={v} value={v}>{v}</option>
                ))}
              </Form.Select>
            ) : (
              <InputGroup size="sm" style={{ width: '80px' }}>
                <Form.Control
                  type="number"
                  value={condition.value as number ?? 0}
                  onChange={(e) => updateCondition({ value: parseFloat(e.target.value) || 0 })}
                  placeholder="Value"
                />
              </InputGroup>
            )}
          </Col>
        )}

        {/* Delete Button */}
        <Col xs="auto" className="ms-auto">
          <Button variant="outline-danger" size="sm" onClick={onDelete} title="Delete condition">
            <BsTrash />
          </Button>
        </Col>
      </Row>

      {/* Condition Summary */}
      <div className="mt-1 text-ink-soft text-[0.875em]">
        <ConditionSummary condition={condition} />
      </div>
    </div>
  );
}

// ==================== Condition Summary ====================

function ConditionSummary({ condition }: { condition: RuleCondition }) {
  const comparatorDef = COMPARATOR_DEFINITIONS.find(c => c.value === condition.comparator);

  // Format indicator with params
  const formatIndicator = (ind: IndicatorType, params?: Record<string, number | string>): string => {
    const def = INDICATOR_DEFINITIONS.find(i => i.value === ind);
    if (!def) return ind;

    const paramStr = def.params
      .map(p => params?.[p.name] ?? p.defaultValue)
      .join(',');

    return paramStr ? `${def.label}(${paramStr})` : def.label;
  };

  // Format interval
  const formatInterval = (interval: CandleInterval): string => {
    const def = CANDLE_INTERVAL_DEFINITIONS.find(i => i.value === interval);
    return def?.label ?? interval;
  };

  if (condition.referenceIndicator) {
    const refInterval = condition.referenceInterval || condition.interval;
    const showRefInterval = refInterval !== condition.interval;
    return (
      <>
        <BsArrowRight className="me-1" />
        {formatIndicator(condition.indicator, condition.params)} {formatInterval(condition.interval)}{' '}
        <span className="text-primary-700 dark:text-primary-400">{comparatorDef?.symbol}</span>{' '}
        {formatIndicator(condition.referenceIndicator, condition.referenceParams)}
        {showRefInterval && <> {formatInterval(refInterval)}</>}
      </>
    );
  }

  return (
    <>
      <BsArrowRight className="me-1" />
      {formatIndicator(condition.indicator, condition.params)} {formatInterval(condition.interval)}{' '}
      <span className="text-primary-700 dark:text-primary-400">{comparatorDef?.symbol}</span>{' '}
      {condition.value}
    </>
  );
}

export default IndicatorRuleBuilder;

// ==================== Simplified Rule Set Editor ====================

interface SimplifiedRuleSetEditorProps {
  ruleSet: IndicatorRuleSet;
  onChange: (ruleSet: IndicatorRuleSet) => void;
  isDirectional: boolean;  // Strategy's directional flag
  tradeMode?: string;
}

/**
 * Simplified rule set editor following the new design:
 * - Entry Rules: TRUE/FALSE (WHEN to enter)
 * - Direction Rules: LONG/SHORT rules (WHICH side) - only shown if directional=true
 * - Exit Rules: TRUE/FALSE (optional)
 *
 * Flow:
 * 1. Entry rules -> TRUE/FALSE
 * 2. If TRUE and directional=true -> evaluate direction rules
 * 3. If TRUE and directional=false -> sell both CE and PE
 */
export function SimplifiedRuleSetEditor({
  ruleSet,
  onChange,
  isDirectional,
  tradeMode,
}: SimplifiedRuleSetEditorProps) {

  const updateEntryRules = (rules: RuleNode | null) => {
    onChange({ ...ruleSet, entryRules: rules ?? undefined });
  };

  const updateDirectionRules = (directionRules: DirectionRules | undefined) => {
    onChange({ ...ruleSet, directionRules });
  };

  const updateExitRules = (rules: RuleNode | null) => {
    onChange({ ...ruleSet, exitRules: rules ?? undefined });
  };

  const updateUseIndicatorExit = (useIndicatorExit: boolean) => {
    onChange({ ...ruleSet, useIndicatorExit });
  };

  return (
    <div>
      {/* Entry Rules Section */}
      <Card className="mb-4">
        <Card.Header className="bg-primary-500/10">
          <strong>Entry Rules</strong>
          <span className="text-ink-soft ms-2">- WHEN to enter (TRUE/FALSE)</span>
        </Card.Header>
        <Card.Body>
          <Alert variant="info" className="py-2 mb-4">
            Define conditions that must be TRUE to trigger an entry.
            {!isDirectional && (
              <span className="font-bold"> Since this strategy is non-directional, it will trade BOTH CE and PE when entry rules are satisfied.</span>
            )}
          </Alert>
          <SingleDirectionRuleEditor
            ruleNode={ruleSet.entryRules || null}
            onChange={updateEntryRules}
          />
        </Card.Body>
      </Card>

      {/* Direction Rules Section - only show if directional */}
      {isDirectional && (
        <Card className="mb-4">
          <Card.Header className="bg-warning-500/10">
            <strong>Direction Rules</strong>
            <span className="text-ink-soft ms-2">- WHICH side to trade (LONG/SHORT) - Optional</span>
          </Card.Header>
          <Card.Body>
            <Alert variant="warning" className="py-2 mb-4">
              Define conditions for LONG ({getDirectionLabels(tradeMode).longAction}) and SHORT ({getDirectionLabels(tradeMode).shortAction}) directions.
              If no direction rules match, the Direction Provider will be used as fallback.
            </Alert>
            <Row>
              {/* LONG Rules */}
              <Col md={6}>
                <Card className="mb-4 border-success-500">
                  <Card.Header className="bg-success-500/10 flex items-center gap-2 py-2">
                    <Badge bg="success" className="flex items-center gap-1">
                      <BsArrowUp /> LONG
                    </Badge>
                    <span className="text-[0.875em]">({getDirectionLabels(tradeMode).longAction} - Bullish)</span>
                  </Card.Header>
                  <Card.Body className="py-2">
                    <SingleDirectionRuleEditor
                      ruleNode={ruleSet.directionRules?.longRules || null}
                      onChange={(rules) => updateDirectionRules({
                        ...ruleSet.directionRules,
                        longRules: rules ?? undefined,
                      })}
                    />
                  </Card.Body>
                </Card>
              </Col>

              {/* SHORT Rules */}
              <Col md={6}>
                <Card className="mb-4 border-danger-500">
                  <Card.Header className="bg-danger-500/10 flex items-center gap-2 py-2">
                    <Badge bg="danger" className="flex items-center gap-1">
                      <BsArrowDown /> SHORT
                    </Badge>
                    <span className="text-[0.875em]">({getDirectionLabels(tradeMode).shortAction} - Bearish)</span>
                  </Card.Header>
                  <Card.Body className="py-2">
                    <SingleDirectionRuleEditor
                      ruleNode={ruleSet.directionRules?.shortRules || null}
                      onChange={(rules) => updateDirectionRules({
                        ...ruleSet.directionRules,
                        shortRules: rules ?? undefined,
                      })}
                    />
                  </Card.Body>
                </Card>
              </Col>
            </Row>

            <div className="p-2 bg-raised rounded-md border">
              <div className="font-bold text-[0.875em] mb-1">Evaluation Order:</div>
              <div className="text-[0.875em] text-ink-soft">
                1. Check LONG rules → if TRUE, trade LONG ({getDirectionLabels(tradeMode).longAction})<br/>
                2. Else check SHORT rules → if TRUE, trade SHORT ({getDirectionLabels(tradeMode).shortAction})<br/>
                3. If neither matches → use Direction Provider fallback
              </div>
            </div>
          </Card.Body>
        </Card>
      )}

      {/* Exit Rules Section */}
      <Card className="mb-4">
        <Card.Header className="flex justify-between items-center">
          <div>
            <strong>Exit Rules</strong>
            <span className="text-ink-soft ms-2">- Optional indicator-based exit</span>
          </div>
          <Form.Check
            type="switch"
            id="use-indicator-exit"
            label="Enable"
            checked={ruleSet.useIndicatorExit}
            onChange={(e) => updateUseIndicatorExit(e.target.checked)}
          />
        </Card.Header>
        {ruleSet.useIndicatorExit && (
          <Card.Body>
            <Alert variant="secondary" className="py-2 mb-4">
              Define conditions that trigger an exit. SL/target exits are always active in addition to these rules.
            </Alert>
            <SingleDirectionRuleEditor
              ruleNode={ruleSet.exitRules || null}
              onChange={updateExitRules}
            />
          </Card.Body>
        )}
      </Card>
    </div>
  );
}

// ==================== Single Direction Rule Editor (Internal) ====================

interface SingleDirectionRuleEditorProps {
  ruleNode: RuleNode | null;
  onChange: (node: RuleNode | null) => void;
}

function SingleDirectionRuleEditor({ ruleNode, onChange }: SingleDirectionRuleEditorProps) {
  // Create default condition - use FLIP to detect Supertrend state changes
  const createDefaultCondition = (): RuleCondition => ({
    indicator: 'SUPERTREND',
    params: { period: 10, multiplier: 3 },
    interval: '5minute',
    comparator: 'FLIP',
    value: 'GREEN',
  });

  // Create default rule node (single condition)
  const createDefaultNode = (): RuleNode => ({
    type: 'condition',
    condition: createDefaultCondition(),
  });

  // Add root node if none exists
  const handleAddRoot = () => {
    onChange({
      type: 'operator',
      operator: 'AND',
      children: [createDefaultNode()],
    });
  };

  // Render the rule tree
  const renderNode = (node: RuleNode, path: number[], depth: number = 0): JSX.Element => {
    // Check if this is an operator node (has operator field) or condition node (has condition field)
    const isOperatorNode = node.operator != null || node.type === 'operator';
    if (isOperatorNode) {
      return (
        <OperatorNode
          key={path.join('-')}
          node={node}
          path={path}
          depth={depth}
          onChange={(updatedNode) => updateNodeAtPath(path, updatedNode)}
          onDelete={() => deleteNodeAtPath(path)}
          onAddCondition={() => addChildToPath(path, createDefaultNode())}
          onAddGroup={() => addChildToPath(path, {
            type: 'operator',
            operator: 'AND',
            children: [createDefaultNode()],
          })}
          renderChild={(child, idx) => renderNode(child, [...path, idx], depth + 1)}
        />
      );
    } else {
      return (
        <ConditionNode
          key={path.join('-')}
          node={node}
          onChange={(updatedNode) => updateNodeAtPath(path, updatedNode)}
          onDelete={() => deleteNodeAtPath(path)}
        />
      );
    }
  };

  // Update node at specific path
  const updateNodeAtPath = (path: number[], updatedNode: RuleNode | null) => {
    if (!ruleNode) return;
    if (path.length === 0) {
      onChange(updatedNode);
      return;
    }
    const newRoot = JSON.parse(JSON.stringify(ruleNode));
    let current = newRoot;
    for (let i = 0; i < path.length - 1; i++) {
      current = current.children[path[i]];
    }
    if (updatedNode === null) {
      current.children.splice(path[path.length - 1], 1);
    } else {
      current.children[path[path.length - 1]] = updatedNode;
    }
    onChange(newRoot);
  };

  // Delete node at path
  const deleteNodeAtPath = (path: number[]) => {
    if (!ruleNode) return;
    if (path.length === 0) {
      onChange(null);
      return;
    }
    const newRoot = JSON.parse(JSON.stringify(ruleNode));
    let current = newRoot;
    for (let i = 0; i < path.length - 1; i++) {
      current = current.children[path[i]];
    }
    current.children.splice(path[path.length - 1], 1);
    // If operator has no children, remove it too
    if (current.children.length === 0) {
      if (path.length > 1) {
        deleteNodeAtPath(path.slice(0, -1));
      } else {
        // Root operator with no children — clear the entire rule
        onChange(null);
      }
    } else {
      onChange(newRoot);
    }
  };

  // Add child to operator at path
  const addChildToPath = (path: number[], child: RuleNode) => {
    if (!ruleNode) return;
    const newRoot = JSON.parse(JSON.stringify(ruleNode));
    let current = newRoot;
    for (const idx of path) {
      current = current.children[idx];
    }
    if (!current.children) {
      current.children = [];
    }
    current.children.push(child);
    onChange(newRoot);
  };

  return (
    <div>
      {!ruleNode ? (
        <div className="text-center py-4">
          <Button variant="outline-primary" size="sm" onClick={handleAddRoot}>
            <BsPlus className="me-1" /> Add Rule
          </Button>
        </div>
      ) : (
        renderNode(ruleNode, [])
      )}
    </div>
  );
}

// ==================== Direction Rules Only Editor ====================
// Used when directionProviderType === 'INDICATOR' on non-INDICATOR_ADVANCED templates

interface DirectionRulesOnlyEditorProps {
  ruleSet: IndicatorRuleSet;
  onChange: (ruleSet: IndicatorRuleSet) => void;
  tradeMode?: string;
}

/**
 * Simplified editor that only shows LONG/SHORT direction rules.
 * Used for scheduled strategies that want indicator-based direction determination.
 *
 * This is the UI for the INDICATOR direction provider when using templates
 * other than INDICATOR_ADVANCED_OPTIONS (which has its own full rule editor).
 */
export function DirectionRulesOnlyEditor({
  ruleSet,
  onChange,
  tradeMode,
}: DirectionRulesOnlyEditorProps) {

  const updateDirectionRules = (directionRules: DirectionRules | undefined) => {
    onChange({ ...ruleSet, directionRules });
  };

  return (
    <div>
      <Alert variant="info" className="py-2 mb-4">
        <strong>Indicator-based Direction:</strong> Configure LONG and SHORT rules to determine trade direction.
        At scheduled entry times, these rules will be evaluated to decide trade direction.
      </Alert>

      <Row>
        {/* LONG Rules */}
        <Col md={6}>
          <Card className="mb-4 border-success-500">
            <Card.Header className="bg-success-500/10 flex items-center gap-2 py-2">
              <Badge bg="success" className="flex items-center gap-1">
                <BsArrowUp /> LONG
              </Badge>
              <span className="text-[0.875em]">({getDirectionLabels(tradeMode).longAction} - Bullish)</span>
            </Card.Header>
            <Card.Body className="py-2">
              <SingleDirectionRuleEditor
                ruleNode={ruleSet.directionRules?.longRules || null}
                onChange={(rules) => updateDirectionRules({
                  ...ruleSet.directionRules,
                  longRules: rules ?? undefined,
                })}
              />
            </Card.Body>
          </Card>
        </Col>

        {/* SHORT Rules */}
        <Col md={6}>
          <Card className="mb-4 border-danger-500">
            <Card.Header className="bg-danger-500/10 flex items-center gap-2 py-2">
              <Badge bg="danger" className="flex items-center gap-1">
                <BsArrowDown /> SHORT
              </Badge>
              <span className="text-[0.875em]">({getDirectionLabels(tradeMode).shortAction} - Bearish)</span>
            </Card.Header>
            <Card.Body className="py-2">
              <SingleDirectionRuleEditor
                ruleNode={ruleSet.directionRules?.shortRules || null}
                onChange={(rules) => updateDirectionRules({
                  ...ruleSet.directionRules,
                  shortRules: rules ?? undefined,
                })}
              />
            </Card.Body>
          </Card>
        </Col>
      </Row>

      <div className="p-2 bg-raised rounded-md border">
        <div className="font-bold text-[0.875em] mb-1">How it works:</div>
        <div className="text-[0.875em] text-ink-soft">
          At each scheduled entry time, the engine will:<br/>
          1. Check LONG rules → if TRUE, trade LONG ({getDirectionLabels(tradeMode).longAction})<br/>
          2. Else check SHORT rules → if TRUE, trade SHORT ({getDirectionLabels(tradeMode).shortAction})<br/>
          3. If neither matches → no entry for this tranch
        </div>
      </div>
    </div>
  );
}
