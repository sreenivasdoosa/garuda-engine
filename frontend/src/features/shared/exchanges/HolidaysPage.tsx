/**
 * Holidays Page (Shared)
 * Distributed: read-only, synced from Market Data Service
 * Standalone: directly managed in shared DB
 */

import { BsCalendar } from 'react-icons/bs';
import { PageHeader } from '@/components/common';
import { Holidays } from '@/components/exchanges';

const HolidaysPage: React.FC = () => {

  return (
    <div className="fade-in">
      <PageHeader
        title="Holidays"
        subtitle="Manage exchange holidays"
        icon={<BsCalendar size={24} />}
      />

      <Holidays title="Holidays" hideSync />
    </div>
  );
};

export default HolidaysPage;
