/**
 * Standalone Kill Switches page (sidebar: RMS section, below RMS Breaches).
 * Kill switches are RUNTIME STATE (who is blocked right now and why), not
 * configuration — they used to hide as a tab inside RMS Config.
 */
import { BsStopCircle } from 'react-icons/bs';
import { PageHeader } from '@/components/common';
import { usePermissions } from '@/hooks/usePermissions';
import { KillSwitchPanel } from './RMSPage';

export default function KillSwitchPage() {
  const permissions = usePermissions();
  const canEdit = permissions.rms.canEdit;
  return (
    <div className="admin-rms">
      <PageHeader
        title="Kill Switches"
        subtitle="Activate, monitor and clear trading kill switches"
        icon={<BsStopCircle size={24} />}
      />
      <KillSwitchPanel hideEdit={!canEdit} />
    </div>
  );
}
