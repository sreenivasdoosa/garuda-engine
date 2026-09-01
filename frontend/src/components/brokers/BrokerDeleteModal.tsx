/**
 * BrokerDeleteModal — smart confirm dialog for deleting a broker.
 *
 * Fetches GET /api/v2/brokers/{name}/usage on open. Renders one of three
 * states based on the response:
 *   1. blockers present  → list them, refuse to delete (operator must clear first)
 *   2. only historical counts → show as info, allow delete
 *   3. no references at all → simple "are you sure?"
 */
import { useMemo } from 'react';
import { Modal, Button, Spinner, Alert, Table, Badge } from '@/components/ui/rbShim';
import { useQuery } from '@tanstack/react-query';

import { brokerService } from '@/services/broker/brokerService';
import type { BrokerUsage } from '@/types/broker';

interface BrokerDeleteModalProps {
  show: boolean;
  brokerName: string | null;
  onCancel: () => void;
  onDelete: () => void;
  isDeleting: boolean;
}

const formatCount = (n: number): string => {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace('.0', '') + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace('.0', '') + 'k';
  return String(n);
};

const BrokerDeleteModal: React.FC<BrokerDeleteModalProps> = ({
  show,
  brokerName,
  onCancel,
  onDelete,
  isDeleting,
}) => {
  const usageQuery = useQuery({
    queryKey: ['broker', 'usage', brokerName],
    queryFn: () => brokerService.getUsage(brokerName!),
    enabled: show && !!brokerName,
    staleTime: 0,
  });

  const usage: BrokerUsage | undefined = usageQuery.data;

  const blockerEntries = useMemo(
    () => usage ? Object.entries(usage.blockers).filter(([, n]) => n > 0) : [],
    [usage]
  );
  const historicalEntries = useMemo(
    () => usage ? Object.entries(usage.historical).filter(([, n]) => n > 0) : [],
    [usage]
  );
  const hasBlockers = blockerEntries.length > 0;

  return (
    <Modal show={show} onHide={onCancel} backdrop="static" size="lg">
      <Modal.Header closeButton>
        <Modal.Title>
          {hasBlockers ? 'Cannot delete broker' : 'Delete broker'}
          {brokerName && <code className="ms-2">{brokerName}</code>}
        </Modal.Title>
      </Modal.Header>

      <Modal.Body>
        {usageQuery.isLoading && (
          <div className="text-center py-6">
            <Spinner animation="border" size="sm" className="me-2" />
            Checking dependencies...
          </div>
        )}

        {usageQuery.isError && (
          <Alert variant="danger">
            Failed to fetch broker usage: {(usageQuery.error as Error).message}
          </Alert>
        )}

        {usage && hasBlockers && (
          <>
            <Alert variant="danger">
              <strong>Active dependencies must be removed first.</strong>{' '}
              The database will reject the delete while these rows reference{' '}
              <code>{usage.broker}</code>.
            </Alert>

            <Table striped size="sm" bordered>
              <thead className="bg-raised">
                <tr>
                  <th>Table</th>
                  <th className="text-end" style={{ width: '110px' }}>Rows</th>
                </tr>
              </thead>
              <tbody>
                {blockerEntries.map(([table, count]) => (
                  <tr key={table}>
                    <td><code style={{ fontSize: '0.85rem' }}>{table}</code></td>
                    <td className="text-end">
                      <Badge bg="danger">{formatCount(count as number)}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>

            {usage.sampleUsers && usage.sampleUsers.length > 0 && (
              <div className="text-ink-soft text-[0.875em] mt-2">
                Sample users still mapped:{' '}
                {usage.sampleUsers.map((u, i) => (
                  <span key={u}>
                    <code>{u}</code>{i < usage.sampleUsers!.length - 1 ? ', ' : ''}
                  </span>
                ))}
                {usage.blockers['USER_BROKERS_MAP'] > usage.sampleUsers.length && (
                  <span> ... and {usage.blockers['USER_BROKERS_MAP'] - usage.sampleUsers.length} more</span>
                )}
              </div>
            )}
          </>
        )}

        {usage && !hasBlockers && (
          <>
            <Alert variant="warning">
              <strong>No active dependencies.</strong> The broker row will be deleted.
              {historicalEntries.length > 0 && (
                <> Historical rows below will <strong>not</strong> be deleted — they stay as a reference for past trades and reports.</>
              )}
            </Alert>

            {historicalEntries.length > 0 && (
              <Table striped size="sm" bordered>
                <thead className="bg-raised">
                  <tr>
                    <th>Table (historical, kept after delete)</th>
                    <th className="text-end" style={{ width: '110px' }}>Rows</th>
                  </tr>
                </thead>
                <tbody>
                  {historicalEntries.map(([table, count]) => (
                    <tr key={table}>
                      <td><code style={{ fontSize: '0.85rem' }}>{table}</code></td>
                      <td className="text-end">
                        <Badge bg="secondary">{formatCount(count as number)}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}

            {historicalEntries.length === 0 && (
              <p className="text-ink-soft mb-0">No historical rows reference this broker either.</p>
            )}
          </>
        )}
      </Modal.Body>

      <Modal.Footer>
        <Button variant="secondary" onClick={onCancel} disabled={isDeleting}>
          {hasBlockers ? 'Close' : 'Cancel'}
        </Button>
        {usage && !hasBlockers && (
          <Button variant="danger" onClick={onDelete} disabled={isDeleting}>
            {isDeleting ? (
              <><Spinner animation="border" size="sm" className="me-1" /> Deleting...</>
            ) : 'Delete broker'}
          </Button>
        )}
      </Modal.Footer>
    </Modal>
  );
};

export default BrokerDeleteModal;
