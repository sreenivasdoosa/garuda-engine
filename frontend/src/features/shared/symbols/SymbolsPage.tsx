/**
 * Symbols Page (Shared)
 * Uses the reusable Symbols component
 */

import { BsTags } from 'react-icons/bs';
import { PageHeader } from '@/components/common';
import { Symbols } from '@/components/symbols';

const SymbolsPage: React.FC = () => {


  return (
    <div className="fade-in">
      <PageHeader
        title="Symbols"
        subtitle="Manage trading symbols and their configurations"
        icon={<BsTags size={24} />}
      />

      <Symbols
        title="Trading Symbols"
        hideSync
      />
    </div>
  );
};

export default SymbolsPage;
