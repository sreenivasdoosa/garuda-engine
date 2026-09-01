/**
 * Symbols Page (Shared)
 * Uses the reusable Symbols component
 */

import { BsTags } from 'react-icons/bs';
import { PageHeader } from '@/components/common';
import { Symbols } from '@/components/symbols';
import { usePermissions } from '@/hooks/usePermissions';

const SymbolsPage: React.FC = () => {
  const permissions = usePermissions();

  const canEdit = permissions.symbolConfig.canEdit;

  return (
    <div className="fade-in">
      <PageHeader
        title="Symbols"
        subtitle="Manage trading symbols and their configurations"
        icon={<BsTags size={24} />}
      />

      <Symbols
        title="Trading Symbols"
        canEdit={canEdit}
        readOnly={!canEdit}
        hideSync
      />
    </div>
  );
};

export default SymbolsPage;
