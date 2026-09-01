/**
 * Brokers Page (Shared)
 * Uses the reusable Brokers component
 */

import { BsBank } from 'react-icons/bs';
import { PageHeader, MissingBrokerExchangeConfigAlert } from '@/components/common';
import { Brokers } from '@/components/brokers';
import { usePermissions } from '@/hooks/usePermissions';

const BrokersPage: React.FC = () => {
  const permissions = usePermissions();

  // Permission flags for Brokers tool
  const canEdit = permissions.brokers.canEdit;
  const canManage = permissions.brokers.canManage;

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
        hideCreate={!canEdit}
        hideDelete={!canManage}
        hideEnableDisable={!canEdit}
        readOnly={!canEdit}
      />
    </div>
  );
};

export default BrokersPage;
