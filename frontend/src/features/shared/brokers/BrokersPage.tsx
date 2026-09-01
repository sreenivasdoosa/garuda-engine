/**
 * Brokers Page (Shared)
 * Uses the reusable Brokers component
 */

import { BsBank } from 'react-icons/bs';
import { PageHeader, MissingBrokerExchangeConfigAlert } from '@/components/common';
import { Brokers } from '@/components/brokers';

const BrokersPage: React.FC = () => {

  // Permission flags for Brokers tool

  return (
    <div className="fade-in">
      <PageHeader
        title="Broker Management"
        subtitle="Configure supported brokers"
        icon={<BsBank size={24} />}
      />

      <MissingBrokerExchangeConfigAlert />

      <Brokers
        title="All Brokers"
        hideCreate={!true}
        hideDelete={!true}
        hideEnableDisable={!true}
        readOnly={!true}
      />
    </div>
  );
};

export default BrokersPage;
