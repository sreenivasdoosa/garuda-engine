/**
 * Event Days Page (Shared)
 * Uses the reusable EventDays component
 */

import { BsCalendarEvent } from 'react-icons/bs';
import { PageHeader } from '@/components/common';
import { EventDays } from '@/components/exchanges';
import { usePermissions } from '@/hooks/usePermissions';

const EventDaysPage: React.FC = () => {
  const permissions = usePermissions();

  // Permission flags for Event Days tool
  const canEdit = permissions.eventDays.canEdit;
  const canManage = permissions.eventDays.canManage;

  return (
    <div className="fade-in">
      <PageHeader
        title="Event Days"
        subtitle="Manage high-impact event days (elections, Fed rates, budget) with reduced capital allocation to limit volatility risk"
        icon={<BsCalendarEvent size={24} />}
      />

      <EventDays
        title="Event Days"
        hideCreate={!canEdit}
        hideDelete={!canManage}
        readOnly={!canEdit}
      />
    </div>
  );
};

export default EventDaysPage;
