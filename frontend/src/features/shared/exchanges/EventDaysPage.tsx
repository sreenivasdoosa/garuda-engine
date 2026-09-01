/**
 * Event Days Page (Shared)
 * Uses the reusable EventDays component
 */

import { BsCalendarEvent } from 'react-icons/bs';
import { PageHeader } from '@/components/common';
import { EventDays } from '@/components/exchanges';

const EventDaysPage: React.FC = () => {
  return (
    <div className="fade-in">
      <PageHeader
        title="Event Days"
        subtitle="Dates to trade at reduced size — a budget, an election, a policy decision"
        icon={<BsCalendarEvent size={24} />}
      />

      <EventDays title="Event Days" />
    </div>
  );
};

export default EventDaysPage;
