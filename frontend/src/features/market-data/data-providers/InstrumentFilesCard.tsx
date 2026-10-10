/**
 * The instrument files: the master, and each provider's catalogue.
 *
 * Modelled on the reference service's Instruments admin page -- the last
 * status, then a download button -- because the question it answers is the
 * first one asked when a chain will not price: is today's file loaded, and
 * when was it fetched? A master from before 08:00 has yesterday's weekly
 * strikes and looks healthy in every other way.
 *
 * Download is **forced**: it fetches whatever the cache says. The day's
 * tasks and a login already re-use today's file when it is good; this button
 * is for the morning it is not. It is awaited, with the row showing it in
 * progress, and the count changing is the confirmation.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { Alert, Badge, Button, Card, Spinner } from '@/components/ui/rbShim';
import { BsCloudDownload } from 'react-icons/bs';
import { ConfirmModal } from '@/components/common';
import { dataProvidersService } from '@/services/admin/dataProviderService';
import type { InstrumentFileStatus } from '@/types/data-provider';

const when = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString('en-IN', {
        hour12: false,
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
    : 'never';

const describe = (file: InstrumentFileStatus) =>
  file.kind === 'master'
    ? `${file.provider} instrument master`
    : `${file.provider} catalogue`;

function freshness(file: InstrumentFileStatus) {
  if (file.inProgress) return <Badge bg="info">Downloading…</Badge>;
  if (!file.loaded) return <Badge bg="danger">Not loaded</Badge>;
  if (file.isStale) return <Badge bg="warning">Stale</Badge>;
  return <Badge bg="success">Today’s</Badge>;
}

export const InstrumentFilesCard: React.FC = () => {
  const queryClient = useQueryClient();
  const [asking, setAsking] = useState<InstrumentFileStatus | null>(null);

  const { data: files, isLoading, error } = useQuery({
    queryKey: ['market-data', 'instruments'],
    queryFn: () => dataProvidersService.instrumentFiles(),
    // A login downloads in the background; the row should be seen to change.
    refetchInterval: 5000,
    retry: false,
  });

  const download = useMutation({
    mutationFn: (name: string) => dataProvidersService.downloadInstrumentFile(name),
    onSuccess: (next) => {
      toast.success(`${describe(next)}: ${next.count.toLocaleString('en-IN')} instruments`);
      queryClient.invalidateQueries({ queryKey: ['market-data', 'instruments'] });
    },
    onError: (e: Error) => toast.error(e.message),
    onSettled: () => setAsking(null),
  });

  return (
    <Card className="mb-4">
      <Card.Header>
        <h5 className="mb-0">Instrument files</h5>
      </Card.Header>
      <Card.Body>
        <p className="text-ink-soft mb-3 text-sm">
          Fetched at the start of the day and again on any login. A file from before 08:00 carries
          yesterday’s weekly strikes; download fetches a fresh one whatever the cache says.
        </p>
        {isLoading && <Spinner />}
        {error && (
          <Alert variant="warning" className="mb-0">
            {(error as Error).message}
          </Alert>
        )}
        {files && files.length === 0 && (
          <Alert variant="info" className="mb-0">
            The engine has no instrument files registered yet.
          </Alert>
        )}
        {files && files.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-ink-faint text-xs uppercase">
                <tr>
                  <th className="py-1 text-left">File</th>
                  <th className="py-1 text-left">Status</th>
                  <th className="py-1 text-right">Instruments</th>
                  <th className="py-1 text-left">File from</th>
                  <th className="py-1 text-left">Last attempt</th>
                  <th className="py-1 text-right" />
                </tr>
              </thead>
              <tbody>
                {files.map((file) => (
                  <tr key={file.name} className="border-t border-hairline">
                    <td className="py-2 pr-3">
                      <span className="capitalize">{describe(file)}</span>
                      <div className="text-ink-faint font-mono text-xs">{file.name}</div>
                    </td>
                    <td className="py-2 pr-3">{freshness(file)}</td>
                    <td className="py-2 pr-3 text-right font-mono tabular-nums">
                      {file.loaded ? file.count.toLocaleString('en-IN') : '—'}
                    </td>
                    <td className="py-2 pr-3 font-mono text-xs">{when(file.cachedAt)}</td>
                    <td className="py-2 pr-3 text-xs">
                      {file.lastError ? (
                        <span className="text-danger">
                          {when(file.lastAttemptAt)} failed: {file.lastError}
                        </span>
                      ) : file.lastSuccessAt ? (
                        <span className="text-ink-soft">
                          {when(file.lastSuccessAt)}{' '}
                          {file.lastDownloaded ? 'downloaded' : 'read from today’s cache'}
                        </span>
                      ) : (
                        <span className="text-ink-faint">—</span>
                      )}
                      {file.skippedBecause && (
                        <div className="text-ink-faint">{file.skippedBecause}</div>
                      )}
                    </td>
                    <td className="py-2 text-right">
                      <Button
                        variant={file.loaded && !file.isStale ? 'outline-secondary' : 'primary'}
                        size="sm"
                        disabled={download.isPending || file.inProgress}
                        onClick={() => setAsking(file)}
                      >
                        <BsCloudDownload className="me-1" />
                        {download.isPending && download.variables === file.name
                          ? 'Downloading…'
                          : 'Download'}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card.Body>

      <ConfirmModal
        show={asking !== null}
        onHide={() => setAsking(null)}
        onConfirm={() => asking && download.mutate(asking.name)}
        title={asking ? `Download the ${describe(asking)}` : ''}
        message={
          asking
            ? `Fetch a fresh ${describe(asking)} from the vendor now, replacing the cached file? It takes a few seconds, and every strike resolves against the new one as soon as it lands.`
            : ''
        }
        confirmLabel="Download now"
        loading={download.isPending}
      />
    </Card>
  );
};

export default InstrumentFilesCard;
