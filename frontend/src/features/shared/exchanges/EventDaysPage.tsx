/**
 * Event Days Page (Shared)
 * Uses the reusable EventDays component
 */

import { BsCalendarEvent } from 'react-icons/bs';
import { PageHeader } from '@/components/common';
import { EventDays } from '@/components/exchanges';

const EventDaysPage: React.FC = () => {

  // Permission flags for Event Days tool

  return (
    <div className="fade-in">
      <PageHeader
        title="Event Days"
        subtitle="Manage high-impact event days (elections, Fed rates, budget) with reduced capital allocation to limit volatility risk"
        icon={<BsCalendarEvent size={24} />}
      />

      <EventDays
        title="Event Days"
        hideCreate={!true}
        hideDelete={!true}
        readOnly={!true}
      />
    </div>
  );
};

export default EventDaysPage;
