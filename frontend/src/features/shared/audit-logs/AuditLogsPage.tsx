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
        subtitle="View system activity and security logs"
        icon={<BsJournalText size={24} />}
      />

      <AuditLogs
        title="System Audit Logs"
        defaultDays={90}
      />
    </div>
  );
};

export default AuditLogsPage;
