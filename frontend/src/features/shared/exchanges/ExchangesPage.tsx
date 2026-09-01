/**
 * Exchanges Page (Shared)
 * Uses the reusable Exchanges component
 */

import { BsGlobe } from 'react-icons/bs';
import { PageHeader } from '@/components/common';
import { Exchanges } from '@/components/exchanges';

const ExchangesPage: React.FC = () => {

  // Permission flags for Exchanges tool

  return (
    <div className="fade-in">
      <PageHeader
        title="Exchanges"
        subtitle="Configure exchanges and market hours"
        icon={<BsGlobe size={24} />}
      />

      <Exchanges
        title="Exchanges"
        hideCreate={!true}
        hideDelete={!true}
        hideEnableDisable={!true}
        readOnly={!true}
      />
    </div>
  );
};

export default ExchangesPage;
