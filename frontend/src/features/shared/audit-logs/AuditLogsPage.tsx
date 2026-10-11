/**
 * Audit Logs Page (Shared)
 * Uses the reusable AuditLogs component
 */

import { BsJournalText } from 'react-icons/bs';
import { PageHeader } from '@/components/common';
import { AuditLogs } from '@/components/audit-logs';

const AuditLogsPage: React.FC = () => {
  return (
    <div className="fade-in">
      <PageHeader
        title="Audit Logs"
        subtitle="Every change made in the Console: who, what, and what it was before"
        icon={<BsJournalText size={24} />}
      />

      <AuditLogs
        title="Audit log"
        defaultDays={90}
      />
    </div>
  );
};

export default AuditLogsPage;
