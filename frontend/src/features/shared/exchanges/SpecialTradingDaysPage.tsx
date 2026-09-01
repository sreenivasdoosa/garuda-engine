/**
 * Special Trading Days Page (Shared)
 * Uses the reusable SpecialTradingDays component
 */

import { BsCalendarCheck } from 'react-icons/bs';
import { PageHeader } from '@/components/common';
import { SpecialTradingDays } from '@/components/exchanges';

const SpecialTradingDaysPage: React.FC = () => {

  return (
    <div className="fade-in">
      <PageHeader
        title="Special Trading Days"
        subtitle="Manage special trading days (e.g., Muhurat Trading)"
        icon={<BsCalendarCheck size={24} />}
      />

      <SpecialTradingDays title="Special Trading Days" />
    </div>
  );
};

export default SpecialTradingDaysPage;
