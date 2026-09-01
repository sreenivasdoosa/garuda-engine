/**
 * StockUniversesPage - Admin page for equity stock universes (watchlists).
 *
 * A universe is the set of stocks an equity strategy trades:
 * - PREDEFINED_INDEX universes mirror NSE index constituents (NIFTY 50, NIFTY 500, ...)
 *   and are materialized daily by the NSE downloader job — members are read-only here.
 * - CUSTOM universes are hand-managed watchlists — full CRUD including the member list.
 *
 * Backed by StockUniverseServletV2 at /api/v2/engine/universes (Resource.STRATEGY_ENGINE).
 */

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { BsPencil, BsTrash, BsSearch, BsArrowClockwise, BsCollection, BsPlus, BsCheckCircle, BsXCircle } from 'react-icons/bs';
import { toast } from 'react-toastify';

import { stockUniverseService } from '@/services/admin/stockUniverseService';
import type { StockUniverse } from '@/types/stock-universe';
import { Badge, Button, Spinner, Modal, Toggle } from '@/components/ui';

const ctrl = 'w-full rounded border border-hairline bg-card px-2 py-1.5 text-sm text-ink placeholder:text-ink-faint focus-visible:outline-none focus:border-primary-500/60 disabled:opacity-60';
const label = 'mb-1 flex items-center text-sm font-medium text-ink';
const help = 'mt-1 block text-xs text-ink-soft';
const cell = 'px-3 py-2';
const panel = 'rounded bg-raised p-3';

/** Parse a free-text member list (newline/comma/space separated) into clean symbols. */
const parseMembers = (text: string): string[] => {
  const seen = new Set<string>();
  return text
    .split(/[\s,;]+/)
    .map((s) => s.trim().toUpperCase())
    .filter((s) => {
      if (!s || seen.has(s)) return false;
      seen.add(s);
      return true;
    });
};

const formatTimestamp = (ts?: string): string => (ts ? new Date(ts).toLocaleString('en-IN') : '—');

const StockUniversesPage: React.FC = () => {
  const queryClient = useQueryClient();

  const [searchTerm, setSearchTerm] = useState('');
  const [showFormModal, setShowFormModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [selectedUniverse, setSelectedUniverse] = useState<StockUniverse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // Form state (create when selectedUniverse == null, edit otherwise)
  const [formName, setFormName] = useState('');
  const [formExchange, setFormExchange] = useState('NSE');
  const [formIsActive, setFormIsActive] = useState(true);
  const [formMembersText, setFormMembersText] = useState('');

  const { data: universes = [], isLoading, error, refetch } = useQuery({
    queryKey: ['stock-universes'],
    queryFn: () => stockUniverseService.getAll(),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['stock-universes'] });
    queryClient.invalidateQueries({ queryKey: ['stock-universes', 'active'] });
  };

  const createMutation = useMutation({
    mutationFn: () => stockUniverseService.create({
      name: formName.trim(),
      universeType: 'CUSTOM',
      exchange: formExchange || 'NSE',
      isActive: formIsActive,
      members: parseMembers(formMembersText),
    }),
    onSuccess: () => {
      invalidate();
      toast.success('Universe created successfully');
      handleCloseFormModal();
    },
    onError: (error: Error) => toast.error(error.message || 'Failed to create universe'),
  });

  const updateMutation = useMutation({
    mutationFn: (universe: StockUniverse) => stockUniverseService.update(universe.universeId!, {
      name: formName.trim(),
      exchange: formExchange || universe.exchange,
      // The server applies isActive unconditionally — always send it.
      isActive: formIsActive,
      // Members are replaced only when supplied; predefined lists stay job-managed.
      members: universe.universeType === 'CUSTOM' ? parseMembers(formMembersText) : undefined,
    }),
    onSuccess: () => {
      invalidate();
      toast.success('Universe updated successfully');
      handleCloseFormModal();
    },
    onError: (error: Error) => toast.error(error.message || 'Failed to update universe'),
  });

  const deleteMutation = useMutation({
    mutationFn: (universeId: number) => stockUniverseService.delete(universeId),
    onSuccess: () => {
      invalidate();
      toast.success('Universe deleted successfully');
      setShowDeleteModal(false);
      setSelectedUniverse(null);
    },
    onError: (error: Error) => toast.error(error.message || 'Failed to delete universe'),
  });

  const filteredUniverses = universes.filter(
    (u) =>
      u.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (u.indexKey || '').toLowerCase().includes(searchTerm.toLowerCase()),
  );

  const handleOpenCreateModal = () => {
    setSelectedUniverse(null);
    setFormName('');
    setFormExchange('NSE');
    setFormIsActive(true);
    setFormMembersText('');
    setShowFormModal(true);
  };

  // Open view/edit: fetch the detail (list rows don't carry members)
  const handleOpenDetailModal = async (universe: StockUniverse) => {
    setSelectedUniverse(universe);
    setFormName(universe.name);
    setFormExchange(universe.exchange || 'NSE');
    setFormIsActive(universe.isActive);
    setFormMembersText('');
    setShowFormModal(true);
    setDetailLoading(true);
    try {
      const detail = await stockUniverseService.getById(universe.universeId!);
      setSelectedUniverse(detail);
      setFormMembersText((detail.members || []).join('\n'));
    } catch {
      toast.error('Failed to load universe members');
    } finally {
      setDetailLoading(false);
    }
  };

  const handleCloseFormModal = () => {
    setShowFormModal(false);
    setSelectedUniverse(null);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!formName.trim()) {
      toast.error('Universe name is required');
      return;
    }
    if (selectedUniverse) {
      updateMutation.mutate(selectedUniverse);
    } else {
      if (parseMembers(formMembersText).length === 0) {
        toast.error('Add at least one member symbol');
        return;
      }
      createMutation.mutate();
    }
  };

  const isPredefined = selectedUniverse?.universeType === 'PREDEFINED_INDEX';
  const memberCount = parseMembers(formMembersText).length;
  const saving = createMutation.isPending || updateMutation.isPending;

  if (error) {
    return <div className="rounded border border-danger-500/30 bg-danger-500/10 px-3 py-2 text-sm text-danger-600 dark:text-danger-400">Failed to load stock universes: {(error as Error).message}</div>;
  }

  return (
    <div className="rounded-card border border-hairline bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline p-3">
        <h6 className="mb-0 flex items-center gap-2 font-semibold text-ink">
          <BsCollection />
          Stock Universes ({filteredUniverses.length})
        </h6>
        <div className="flex gap-2">
          <div className="flex" style={{ width: 300 }}>
            <span className="flex items-center rounded-l border border-r-0 border-hairline bg-raised px-2.5 text-ink-soft">
              <BsSearch />
            </span>
            <input type="text" className={`${ctrl} rounded-l-none`} placeholder="Search universes..." value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} />
          </div>
          <Button variant="secondary" onClick={() => refetch()} title="Refresh">
            <BsArrowClockwise />
          </Button>
                      <Button variant="primary" onClick={handleOpenCreateModal}>
              <BsPlus /> Add Custom Universe
            </Button>
          
        </div>
      </div>
      <div>
        {isLoading ? (
          <div className="py-10 text-center">
            <Spinner className="text-primary-500" />
            <p className="mt-2 text-ink-soft">Loading universes...</p>
          </div>
        ) : filteredUniverses.length === 0 ? (
          <div className="py-10 text-center text-ink-soft">
            {searchTerm ? 'No universes match your search.' : 'No stock universes found. Predefined NSE index universes are seeded by migration and refreshed by the daily NSE download job.'}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm [&_tbody_tr]:border-b [&_tbody_tr]:border-hairline">
              <thead className="bg-raised text-xs uppercase text-ink-faint">
                <tr>
                  <th className={`${cell} text-left`}>Name</th>
                  <th className={`${cell} text-left`}>Type</th>
                  <th className={`${cell} text-left`}>Exchange</th>
                  <th className={`${cell} text-left`}>Source</th>
                  <th className={`${cell} text-left`}>Last Refreshed</th>
                  <th className={`${cell} text-left`}>Status</th>
                  <th className={`${cell} text-right`}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredUniverses.map((universe) => (
                  <tr key={universe.universeId} className="hover:bg-raised/50">
                    <td className={cell}>
                      <span className="font-medium text-ink">{universe.name}</span>
                      {universe.indexKey && <code className="ms-2 text-xs text-ink-soft">{universe.indexKey}</code>}
                    </td>
                    <td className={cell}>
                      {universe.universeType === 'PREDEFINED_INDEX'
                        ? <Badge tone="info">NSE Index</Badge>
                        : <Badge tone="primary">Custom</Badge>}
                    </td>
                    <td className={`${cell} text-ink`}>{universe.exchange}</td>
                    <td className={`${cell} text-ink-soft`}>{universe.source || '—'}</td>
                    <td className={`${cell} text-ink-soft`}>{formatTimestamp(universe.lastRefreshedAt)}</td>
                    <td className={cell}>
                      {universe.isActive ? (
                        <Badge tone="success" icon={<BsCheckCircle />}>Active</Badge>
                      ) : (
                        <Badge tone="neutral" icon={<BsXCircle />}>Inactive</Badge>
                      )}
                    </td>
                    <td className={`${cell} text-right`}>
                      <div className="flex justify-end gap-1">
                        <Button variant="secondary" size="sm" onClick={() => handleOpenDetailModal(universe)} title={'View / Edit'}>
                          {<BsPencil />}
                        </Button>
                        {universe.universeType === 'CUSTOM' && (
                          <Button variant="danger" size="sm" onClick={() => { setSelectedUniverse(universe); setShowDeleteModal(true); }} title="Delete">
                            <BsTrash />
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Create / View / Edit Modal */}
      <Modal
        open={showFormModal}
        onClose={handleCloseFormModal}
        size="lg"
        title={
          <span className="flex items-center gap-2">
            <BsCollection /> {selectedUniverse ? ('Edit') + ' Universe' : 'Add Custom Universe'}
          </span>
        }
        footer={
          <>
            <Button variant="secondary" onClick={handleCloseFormModal}>{'Cancel'}</Button>
                          <Button variant="primary" type="submit" form="universe-form" disabled={saving || detailLoading}>
                {saving ? (
                  <>
                    <Spinner size="sm" /> Saving...
                  </>
                ) : selectedUniverse ? (
                  'Save Changes'
                ) : (
                  'Create Universe'
                )}
              </Button>
            
          </>
        }
      >
        <form id="universe-form" onSubmit={handleSubmit}>
          {isPredefined && (
            <div className="mb-3 rounded border border-accent-500/30 bg-accent-500/10 px-3 py-2 text-sm text-ink">
              Predefined NSE index universe — the member list is refreshed automatically by the daily
              NSE constituent download job and cannot be edited here.
              {selectedUniverse?.lastRefreshedAt && <> Last refreshed: <strong>{formatTimestamp(selectedUniverse.lastRefreshedAt)}</strong>.</>}
            </div>
          )}
          <div className="mb-3">
            <label className={label}>Name <span className="text-danger-500">*</span></label>
            <input type="text" className={ctrl} value={formName} onChange={(e) => setFormName(e.target.value)} disabled={!true} required placeholder="e.g. My Momentum Basket" />
          </div>
          <div className="mb-3 flex flex-wrap items-end gap-6">
            <div style={{ width: 160 }}>
              <label className={label}>Exchange</label>
              <input type="text" className={ctrl} value={formExchange} onChange={(e) => setFormExchange(e.target.value.toUpperCase())} disabled={!true || isPredefined} />
            </div>
            <label className="flex cursor-pointer items-center gap-2 pb-1.5">
              <Toggle checked={formIsActive} onChange={setFormIsActive} disabled={!true} />
              <span className="text-sm text-ink">Active</span>
            </label>
          </div>
          <div className="mb-1">
            <label className={label}>Members ({detailLoading ? '…' : memberCount})</label>
            {detailLoading ? (
              <div className="py-4 text-center">
                <Spinner size="sm" className="text-primary-500" /> <span className="text-sm text-ink-soft">Loading members...</span>
              </div>
            ) : (
              <textarea
                rows={10}
                className={`${ctrl} font-mono`}
                value={formMembersText}
                onChange={(e) => setFormMembersText(e.target.value)}
                disabled={!true || isPredefined}
                placeholder={'One NSE trading symbol per line (or comma-separated), e.g.\nRELIANCE\nTCS\nHDFCBANK'}
              />
            )}
            {!isPredefined && <span className={help}>NSE cash (NSE_EQ) trading symbols — separated by newlines, commas, or spaces; duplicates are dropped. Saving replaces the whole member list.</span>}
          </div>
        </form>
      </Modal>

      {/* Delete Confirmation Modal */}
      <Modal
        open={showDeleteModal}
        onClose={() => { setShowDeleteModal(false); setSelectedUniverse(null); }}
        title={
          <span className="flex items-center gap-2 text-danger-500">
            <BsTrash /> Delete Universe
          </span>
        }
        footer={
          <>
            <Button variant="secondary" onClick={() => { setShowDeleteModal(false); setSelectedUniverse(null); }}>Cancel</Button>
            <Button variant="danger" onClick={() => selectedUniverse?.universeId && deleteMutation.mutate(selectedUniverse.universeId)} disabled={deleteMutation.isPending}>
              {deleteMutation.isPending ? (
                <>
                  <Spinner size="sm" /> Deleting...
                </>
              ) : (
                'Delete'
              )}
            </Button>
          </>
        }
      >
        <div className="mb-3 rounded border border-warning-500/30 bg-warning-500/10 px-3 py-2 text-sm text-ink">Are you sure you want to delete this universe?</div>
        {selectedUniverse && (
          <div className={panel}>
            <p className="mb-0 text-ink"><strong>Name:</strong> {selectedUniverse.name}</p>
          </div>
        )}
        <p className="m-0 mt-3 text-sm text-danger-500">
          <strong>Warning:</strong> Equity strategies referencing this universe will stop resolving members and skip entries.
        </p>
      </Modal>
    </div>
  );
};

export default StockUniversesPage;
