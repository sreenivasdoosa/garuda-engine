/**
 * EventDays Component
 *
 * Two tabs, because there are two levels:
 *
 * 1. **Global** — an exchange-level event day. Every strategy on that
 *    exchange trades that percentage of its normal size on that date.
 * 2. **Strategy** — one named strategy's override of it. Set NSE to 50% and
 *    one strategy to 60%, and every other strategy still trades 50%.
 *
 * The engine this was copied from had four, adding a per-product and a
 * per-user level between them. Product is not a scope a strategy is
 * configured against here, and with one operator a per-user override is an
 * override of yourself.
 *
 * Uses: /api/event-days, /api/strategy-event-day-actions
 */

import { useState } from 'react';
import { Card, Tab, Tabs } from '@/components/ui/rbShim';
import HelpIcon from '@/components/common/HelpIcon';
import { eventDaysHelpContent as help } from '@/data/help';
import GlobalEventDays from './GlobalEventDays';
import StrategyEventDays from './StrategyEventDays';

export interface EventDaysProps {
  /** Card title */
  title?: string;
}

const EventDays: React.FC<EventDaysProps> = ({ title = 'Event Days Configuration' }) => {
  const [activeTab, setActiveTab] = useState<string>('global');

  return (
    <Card>
      <Card.Header>
        <h5 className="mb-0 flex items-center">
          {title}
          {help['eventDays.overview'] && <HelpIcon article={help['eventDays.overview']} />}
        </h5>
      </Card.Header>
      <Card.Body>
        <Tabs activeKey={activeTab} onSelect={(k) => setActiveTab(k || 'global')} className="mb-3">
          <Tab eventKey="global" title="Global Config">
            <GlobalEventDays />
          </Tab>
          <Tab eventKey="strategy" title="Strategy Config">
            <StrategyEventDays />
          </Tab>
        </Tabs>
      </Card.Body>
    </Card>
  );
};

export default EventDays;
