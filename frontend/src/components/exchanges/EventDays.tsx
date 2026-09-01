/**
 * EventDays Component
 * Tabbed interface for managing event days configuration:
 * 1. Global Config - Exchange-level event days (applies to all strategies/users)
 * 2. Product Config - Product-specific capital percentage overrides
 * 3. Strategy Config - Strategy-specific capital percentage overrides
 * 4. User Config - User-specific capital percentage overrides
 * Uses V2 API: /api/v2/event-days, /api/v2/product-event-day-actions, /api/v2/strategy-event-day-actions, /api/v2/user-event-day-actions
 */

import { useState } from 'react';
import { Card, Tab, Tabs } from '@/components/ui/rbShim';
import GlobalEventDays from './GlobalEventDays';
import ProductEventDays from './ProductEventDays';
import StrategyEventDays from './StrategyEventDays';
import UserEventDays from './UserEventDays';

export interface EventDaysProps {
  /** Card title */
  title?: string;
  /** Hide add button */
  hideCreate?: boolean;
  /** Hide delete button */
  hideDelete?: boolean;
  /** Read-only mode - shows View button instead of Edit */
  readOnly?: boolean;
}

const EventDays: React.FC<EventDaysProps> = ({
  title = 'Event Days Configuration',
  hideCreate = false,
  hideDelete = false,
  readOnly = false,
}) => {
  const [activeTab, setActiveTab] = useState<string>('global');

  return (
    <Card>
      <Card.Header>
        <h5 className="mb-0">{title}</h5>
      </Card.Header>
      <Card.Body>
        <Tabs
          activeKey={activeTab}
          onSelect={(k) => setActiveTab(k || 'global')}
          className="mb-4"
        >
          <Tab eventKey="global" title="Global Config">
            <GlobalEventDays hideCreate={hideCreate} hideDelete={hideDelete} readOnly={readOnly} />
          </Tab>
          <Tab eventKey="product" title="Product Config">
            <ProductEventDays hideCreate={hideCreate} hideDelete={hideDelete} readOnly={readOnly} />
          </Tab>
          <Tab eventKey="strategy" title="Strategy Config">
            <StrategyEventDays hideCreate={hideCreate} hideDelete={hideDelete} readOnly={readOnly} />
          </Tab>
          <Tab eventKey="user" title="User Config">
            <UserEventDays hideCreate={hideCreate} hideDelete={hideDelete} readOnly={readOnly} />
          </Tab>
        </Tabs>
      </Card.Body>
    </Card>
  );
};

export default EventDays;
