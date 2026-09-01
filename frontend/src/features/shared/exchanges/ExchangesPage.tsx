/**
 * Exchanges Page (Shared)
 * Uses the reusable Exchanges component
 */

import { BsGlobe } from 'react-icons/bs';
import { PageHeader } from '@/components/common';
import { Exchanges } from '@/components/exchanges';
import { usePermissions } from '@/hooks/usePermissions';

const ExchangesPage: React.FC = () => {
  const permissions = usePermissions();

  // Permission flags for Exchanges tool
  const canEdit = permissions.exchanges.canEdit;
  const canManage = permissions.exchanges.canManage;

  return (
    <div className="fade-in">
      <PageHeader
        title="Exchanges"
        subtitle="Configure exchanges and market hours"
        icon={<BsGlobe size={24} />}
      />

      <Exchanges
        title="Exchanges"
        hideCreate={!canEdit}
        hideDelete={!canManage}
        hideEnableDisable={!canEdit}
        readOnly={!canEdit}
      />
    </div>
  );
};

export default ExchangesPage;
