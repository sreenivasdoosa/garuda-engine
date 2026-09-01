/**
 * Holidays Page (Shared)
 * Distributed: read-only, synced from Market Data Service
 * Standalone: directly managed in shared DB
 */

import { BsCalendar } from 'react-icons/bs';
import { PageHeader } from '@/components/common';
import { Holidays } from '@/components/exchanges';
import { usePermissions } from '@/hooks/usePermissions';

const HolidaysPage: React.FC = () => {
  const permissions = usePermissions();
  const canEdit = permissions.holidays.canEdit;

  return (
    <div className="fade-in">
      <PageHeader
        title="Holidays"
        subtitle="Manage exchange holidays"
        icon={<BsCalendar size={24} />}
      />

      <Holidays title="Holidays" hideSync canEdit={canEdit} />
    </div>
  );
};

export default HolidaysPage;
