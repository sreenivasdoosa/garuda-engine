import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { BsPlus, BsPencil, BsTrash, BsSearch, BsArrowClockwise, BsClock, BsCheckCircle, BsXCircle } from 'react-icons/bs';
import { toast } from 'react-toastify';

import HelpIcon from '@/components/common/HelpIcon';
import { tranchScheduleHelpContent } from '@/data/help/tranch-schedule-help';
import { tranchScheduleService, strategyDefinitionService } from '@/services/admin/strategyEngineService';
import { exchangeService } from '@/services/admin/exchangeService';
import type { TranchSchedule, CreateTranchScheduleRequest, UpdateTranchScheduleRequest, StrategyDefinition } from '@/types/strategy-engine';
import type { Exchange } from '@/types/exchange';
import { Badge, Button, Spinner, Modal } from '@/components/ui';

const ctrl = 'w-full rounded border border-hairline bg-card px-2 py-1.5 text-sm text-ink placeholder:text-ink-faint focus-visible:outline-none focus:border-primary-500/60 disabled:opacity-60';
const label = 'mb-1 flex items-center text-sm font-medium text-ink';
const help = 'mt-1 block text-xs text-ink-soft';
const cell = 'px-3 py-2';
const panel = 'rounded bg-raised p-3';

const TranchSchedules: React.FC = () => {
  const queryClient = useQueryClient();
  const [searchTerm, setSearchTerm] = useState('');
  const [filterStrategy, setFilterStrategy] = useState('');
  const [showAddModal, setShowAddModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [selectedSchedule, setSelectedSchedule] = useState<TranchSchedule | null>(null);

  const [formData, setFormData] = useState<CreateTranchScheduleRequest>({
    strategyName: '',
    tranchNumber: 1,
    scheduledTime: '09:30:00',
    minGapSeconds: 0,
    maxPositionsPerTranch: undefined,
    validFrom: undefined,
    validUntil: undefined,
  });

  const { data: schedules = [], isLoading, error, refetch } = useQuery({
    queryKey: ['tranch-schedules'],
    queryFn: () => tranchScheduleService.getAll(),
  });
  const { data: strategies = [] } = useQuery({
    queryKey: ['strategy-definitions'],
    queryFn: () => strategyDefinitionService.getActive(),
  });
  const { data: exchanges = [] } = useQuery({
    queryKey: ['exchanges'],
    queryFn: () => exchangeService.getAll(),
  });

  const getExchangeMarketOpen = (exchangeCode: string): string => {
    const exchange = exchanges.find((e: Exchange) => e.exchange === exchangeCode);
    return exchange?.marketOpen || '09:15:00';
  };

  const getStrategyExchange = (strategyName: string): string => {
    const strategy = strategies.find((s: StrategyDefinition) => s.strategyName === strategyName);
    return strategy?.exchange || 'NSE';
  };

  const getDefaultScheduledTime = (strategyName: string): string => {
    const exchange = getStrategyExchange(strategyName);
    const marketOpen = getExchangeMarketOpen(exchange);
    const [hours, minutes] = marketOpen.split(':').map(Number);
    const defaultMinutes = minutes + 15;
    const adjustedHours = hours + Math.floor(defaultMinutes / 60);
    const adjustedMinutes = defaultMinutes % 60;
    return `${String(adjustedHours).padStart(2, '0')}:${String(adjustedMinutes).padStart(2, '0')}:00`;
  };

  const createMutation = useMutation({
    mutationFn: (data: CreateTranchScheduleRequest) => tranchScheduleService.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tranch-schedules'] });
      toast.success('Schedule created successfully');
      handleCloseAddModal();
    },
    onError: (error: Error) => toast.error(error.message || 'Failed to create schedule'),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: UpdateTranchScheduleRequest }) => tranchScheduleService.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tranch-schedules'] });
      toast.success('Schedule updated successfully');
      handleCloseEditModal();
    },
    onError: (error: Error) => toast.error(error.message || 'Failed to update schedule'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => tranchScheduleService.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tranch-schedules'] });
      toast.success('Schedule deleted successfully');
      handleCloseDeleteModal();
    },
    onError: (error: Error) => toast.error(error.message || 'Failed to delete schedule'),
  });

  const filteredSchedules = schedules.filter((schedule) => {
    const matchesSearch = schedule.strategyName.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesFilter = !filterStrategy || schedule.strategyName === filterStrategy;
    return matchesSearch && matchesFilter;
  });

  const groupedSchedules = filteredSchedules.reduce((acc, schedule) => {
    if (!acc[schedule.strategyName]) acc[schedule.strategyName] = [];
    acc[schedule.strategyName].push(schedule);
    return acc;
  }, {} as Record<string, TranchSchedule[]>);
  Object.keys(groupedSchedules).forEach((key) => groupedSchedules[key].sort((a, b) => a.tranchNumber - b.tranchNumber));

  const handleOpenAddModal = () => {
    const defaultStrategy = strategies.length > 0 ? strategies[0].strategyName : '';
    setFormData({
      strategyName: defaultStrategy,
      tranchNumber: 1,
      scheduledTime: defaultStrategy ? getDefaultScheduledTime(defaultStrategy) : '09:30:00',
      minGapSeconds: 0,
      maxPositionsPerTranch: undefined,
      validFrom: undefined,
      validUntil: undefined,
    });
    setShowAddModal(true);
  };

  const handleCloseAddModal = () => setShowAddModal(false);

  const handleOpenEditModal = (schedule: TranchSchedule) => {
    setSelectedSchedule(schedule);
    setFormData({
      strategyName: schedule.strategyName,
      tranchNumber: schedule.tranchNumber,
      scheduledTime: schedule.scheduledTime,
      minGapSeconds: schedule.minGapSeconds,
      maxPositionsPerTranch: schedule.maxPositionsPerTranch || undefined,
      validFrom: schedule.validFrom || undefined,
      validUntil: schedule.validUntil || undefined,
    });
    setShowEditModal(true);
  };

  const handleCloseEditModal = () => {
    setShowEditModal(false);
    setSelectedSchedule(null);
  };

  const handleOpenDeleteModal = (schedule: TranchSchedule) => {
    setSelectedSchedule(schedule);
    setShowDeleteModal(true);
  };

  const handleCloseDeleteModal = () => {
    setShowDeleteModal(false);
    setSelectedSchedule(null);
  };

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.strategyName || !formData.scheduledTime) {
      toast.error('Strategy and scheduled time are required');
      return;
    }
    createMutation.mutate(formData);
  };

  const handleUpdate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedSchedule?.scheduleId) return;
    updateMutation.mutate({ id: selectedSchedule.scheduleId, data: formData });
  };

  const handleDelete = () => {
    if (!selectedSchedule?.scheduleId) return;
    deleteMutation.mutate(selectedSchedule.scheduleId);
  };

  const uniqueStrategies: string[] = [...new Set(schedules.map((s) => s.strategyName))];

  if (error) {
    return <div className="rounded border border-danger-500/30 bg-danger-500/10 px-3 py-2 text-sm text-danger-600 dark:text-danger-400">Failed to load tranch schedules: {(error as Error).message}</div>;
  }

  return (
    <div className="rounded-card border border-hairline bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline p-3">
        <h6 className="mb-0 flex items-center gap-2 font-semibold text-ink">
          <BsClock />
          Tranch Schedules ({filteredSchedules.length})
        </h6>
        <div className="flex flex-wrap gap-2">
          <div className="flex" style={{ width: 200 }}>
            <span className="flex items-center rounded-l border border-r-0 border-hairline bg-raised px-2.5 text-ink-soft">
              <BsSearch />
            </span>
            <input type="text" className={`${ctrl} rounded-l-none`} placeholder="Search..." value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} />
          </div>
          <select className={ctrl} style={{ width: 200 }} value={filterStrategy} onChange={(e) => setFilterStrategy(e.target.value)}>
            <option value="">All Strategies</option>
            {uniqueStrategies.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <Button variant="secondary" onClick={() => refetch()} title="Refresh">
            <BsArrowClockwise />
          </Button>
          <Button variant="primary" onClick={handleOpenAddModal}>
            <BsPlus /> Add Schedule
          </Button>
        </div>
      </div>
      <div>
        {isLoading ? (
          <div className="py-10 text-center">
            <Spinner className="text-primary-500" />
            <p className="mt-2 text-ink-soft">Loading schedules...</p>
          </div>
        ) : Object.keys(groupedSchedules).length === 0 ? (
          <div className="py-10 text-center text-ink-soft">
            {searchTerm || filterStrategy ? 'No schedules match your filters.' : 'No schedules found. Click "Add Schedule" to create one.'}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm [&_tbody_tr]:border-b [&_tbody_tr]:border-hairline">
              <thead className="bg-raised text-xs uppercase text-ink-faint">
                <tr>
                  <th className={`${cell} text-left`}>Strategy</th>
                  <th className={`${cell} text-left`}>Exchange</th>
                  <th className={`${cell} text-left`}>Tranch</th>
                  <th className={`${cell} text-left`}>Time</th>
                  <th className={`${cell} text-left`}>Min Gap</th>
                  <th className={`${cell} text-left`}>Max Positions</th>
                  <th className={`${cell} text-left`}>Validity</th>
                  <th className={`${cell} text-left`}>Status</th>
                  <th className={`${cell} text-right`}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {(Object.entries(groupedSchedules) as [string, TranchSchedule[]][]).map(([strategyName, strategySchedules]) =>
                  strategySchedules.map((schedule: TranchSchedule, idx: number) => (
                    <tr key={schedule.scheduleId} className="hover:bg-raised/50">
                      {idx === 0 ? (
                        <>
                          <td rowSpan={strategySchedules.length} className={`${cell} align-middle`}>
                            <code className="text-primary-500">{strategyName}</code>
                          </td>
                          <td rowSpan={strategySchedules.length} className={`${cell} align-middle`}>
                            <Badge tone="info">{getStrategyExchange(strategyName)}</Badge>
                          </td>
                        </>
                      ) : null}
                      <td className={cell}>
                        <Badge tone="primary">T{schedule.tranchNumber}</Badge>
                      </td>
                      <td className={cell}>
                        <code className="text-ink">{schedule.scheduledTime}</code>
                      </td>
                      <td className={`${cell} text-ink`}>{schedule.minGapSeconds}s</td>
                      <td className={`${cell} text-ink`}>{schedule.maxPositionsPerTranch || '-'}</td>
                      <td className={cell}>
                        {schedule.validFrom || schedule.validUntil ? (
                          <small className="text-ink-soft">{schedule.validFrom || 'Start'} - {schedule.validUntil || 'End'}</small>
                        ) : (
                          <span className="text-ink-soft">Always</span>
                        )}
                      </td>
                      <td className={cell}>
                        {schedule.isActive ? (
                          <Badge tone="success" icon={<BsCheckCircle />}>Active</Badge>
                        ) : (
                          <Badge tone="neutral" icon={<BsXCircle />}>Inactive</Badge>
                        )}
                      </td>
                      <td className={`${cell} text-right`}>
                        <div className="flex justify-end gap-1">
                          <Button variant="secondary" size="sm" onClick={() => handleOpenEditModal(schedule)} title="Edit">
                            <BsPencil />
                          </Button>
                          <Button variant="danger" size="sm" onClick={() => handleOpenDeleteModal(schedule)} title="Delete">
                            <BsTrash />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Add Modal */}
      <Modal
        open={showAddModal}
        onClose={handleCloseAddModal}
        title={<span className="flex items-center gap-2"><BsPlus /> Add Tranch Schedule</span>}
        footer={
          <>
            <Button variant="secondary" onClick={handleCloseAddModal}>Cancel</Button>
            <Button variant="primary" type="submit" form="add-tranch-form" disabled={createMutation.isPending}>
              {createMutation.isPending ? (<><Spinner size="sm" /> Creating...</>) : 'Create'}
            </Button>
          </>
        }
      >
        <form id="add-tranch-form" onSubmit={handleCreate}>
          <div className="mb-3">
            <label className={label}>Strategy <span className="text-danger-500">*</span> <HelpIcon article={tranchScheduleHelpContent['tranchSchedule.strategyName']} /></label>
            <select
              className={ctrl}
              value={formData.strategyName}
              onChange={(e) => {
                const newStrategy = e.target.value;
                setFormData({ ...formData, strategyName: newStrategy, scheduledTime: newStrategy ? getDefaultScheduledTime(newStrategy) : formData.scheduledTime });
              }}
              required
            >
              <option value="">Select Strategy...</option>
              {strategies.map((s) => (
                <option key={s.strategyName} value={s.strategyName}>{s.strategyName} ({s.exchange || 'NSE'})</option>
              ))}
            </select>
            {formData.strategyName && (
              <span className={`${help} flex items-center gap-1`}>
                Exchange: <Badge tone="info">{getStrategyExchange(formData.strategyName)}</Badge> | Market Open: {getExchangeMarketOpen(getStrategyExchange(formData.strategyName))}
              </span>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="mb-3">
              <label className={label}>Tranch Number <span className="text-danger-500">*</span> <HelpIcon article={tranchScheduleHelpContent['tranchSchedule.tranchNumber']} /></label>
              <input type="number" min={1} className={ctrl} value={formData.tranchNumber} onChange={(e) => setFormData({ ...formData, tranchNumber: parseInt(e.target.value) })} required />
            </div>
            <div className="mb-3">
              <label className={label}>Scheduled Time <span className="text-danger-500">*</span> <HelpIcon article={tranchScheduleHelpContent['tranchSchedule.scheduledTime']} /></label>
              <input type="time" step={1} className={ctrl} value={formData.scheduledTime?.substring(0, 5) || ''} onChange={(e) => setFormData({ ...formData, scheduledTime: e.target.value + ':00' })} required />
            </div>
            <div className="mb-3">
              <label className={label}>Min Gap (seconds) <HelpIcon article={tranchScheduleHelpContent['tranchSchedule.minGapSeconds']} /></label>
              <input type="number" min={0} className={ctrl} value={formData.minGapSeconds} onChange={(e) => setFormData({ ...formData, minGapSeconds: parseInt(e.target.value) || 0 })} />
            </div>
            <div className="mb-3">
              <label className={label}>Max Positions <HelpIcon article={tranchScheduleHelpContent['tranchSchedule.maxPositionsPerTranch']} /></label>
              <input type="number" min={1} className={ctrl} value={formData.maxPositionsPerTranch || ''} onChange={(e) => setFormData({ ...formData, maxPositionsPerTranch: parseInt(e.target.value) || undefined })} placeholder="Unlimited" />
            </div>
            <div className="mb-3">
              <label className={label}>Valid From <HelpIcon article={tranchScheduleHelpContent['tranchSchedule.validFrom']} /></label>
              <input type="date" className={ctrl} value={formData.validFrom || ''} onChange={(e) => setFormData({ ...formData, validFrom: e.target.value || undefined })} />
            </div>
            <div className="mb-3">
              <label className={label}>Valid Until <HelpIcon article={tranchScheduleHelpContent['tranchSchedule.validUntil']} /></label>
              <input type="date" className={ctrl} value={formData.validUntil || ''} onChange={(e) => setFormData({ ...formData, validUntil: e.target.value || undefined })} />
            </div>
          </div>
        </form>
      </Modal>

      {/* Edit Modal */}
      <Modal
        open={showEditModal}
        onClose={handleCloseEditModal}
        title={<span className="flex items-center gap-2"><BsPencil /> Edit Tranch Schedule</span>}
        footer={
          <>
            <Button variant="secondary" onClick={handleCloseEditModal}>Cancel</Button>
            <Button variant="primary" type="submit" form="edit-tranch-form" disabled={updateMutation.isPending}>
              {updateMutation.isPending ? (<><Spinner size="sm" /> Saving...</>) : 'Save Changes'}
            </Button>
          </>
        }
      >
        <form id="edit-tranch-form" onSubmit={handleUpdate}>
          <div className="mb-3">
            <label className={label}>Strategy <HelpIcon article={tranchScheduleHelpContent['tranchSchedule.strategyName']} /></label>
            <input type="text" className={ctrl} value={selectedSchedule?.strategyName || ''} disabled />
            {selectedSchedule?.strategyName && (
              <span className={`${help} flex items-center gap-1`}>
                Exchange: <Badge tone="info">{getStrategyExchange(selectedSchedule.strategyName)}</Badge> | Market Open: {getExchangeMarketOpen(getStrategyExchange(selectedSchedule.strategyName))}
              </span>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="mb-3">
              <label className={label}>Tranch Number <HelpIcon article={tranchScheduleHelpContent['tranchSchedule.tranchNumber']} /></label>
              <input type="number" className={ctrl} value={formData.tranchNumber} disabled />
            </div>
            <div className="mb-3">
              <label className={label}>Scheduled Time <HelpIcon article={tranchScheduleHelpContent['tranchSchedule.scheduledTime']} /></label>
              <input type="time" step={1} className={ctrl} value={formData.scheduledTime?.substring(0, 5) || ''} onChange={(e) => setFormData({ ...formData, scheduledTime: e.target.value + ':00' })} />
            </div>
            <div className="mb-3">
              <label className={label}>Min Gap (seconds) <HelpIcon article={tranchScheduleHelpContent['tranchSchedule.minGapSeconds']} /></label>
              <input type="number" min={0} className={ctrl} value={formData.minGapSeconds} onChange={(e) => setFormData({ ...formData, minGapSeconds: parseInt(e.target.value) || 0 })} />
            </div>
            <div className="mb-3">
              <label className={label}>Max Positions <HelpIcon article={tranchScheduleHelpContent['tranchSchedule.maxPositionsPerTranch']} /></label>
              <input type="number" min={1} className={ctrl} value={formData.maxPositionsPerTranch || ''} onChange={(e) => setFormData({ ...formData, maxPositionsPerTranch: parseInt(e.target.value) || undefined })} placeholder="Unlimited" />
            </div>
            <div className="mb-3">
              <label className={label}>Valid From <HelpIcon article={tranchScheduleHelpContent['tranchSchedule.validFrom']} /></label>
              <input type="date" className={ctrl} value={formData.validFrom || ''} onChange={(e) => setFormData({ ...formData, validFrom: e.target.value || undefined })} />
            </div>
            <div className="mb-3">
              <label className={label}>Valid Until <HelpIcon article={tranchScheduleHelpContent['tranchSchedule.validUntil']} /></label>
              <input type="date" className={ctrl} value={formData.validUntil || ''} onChange={(e) => setFormData({ ...formData, validUntil: e.target.value || undefined })} />
            </div>
          </div>
        </form>
      </Modal>

      {/* Delete Confirmation Modal */}
      <Modal
        open={showDeleteModal}
        onClose={handleCloseDeleteModal}
        title={<span className="flex items-center gap-2 text-danger-500"><BsTrash /> Delete Schedule</span>}
        footer={
          <>
            <Button variant="secondary" onClick={handleCloseDeleteModal}>Cancel</Button>
            <Button variant="danger" onClick={handleDelete} disabled={deleteMutation.isPending}>
              {deleteMutation.isPending ? (<><Spinner size="sm" /> Deleting...</>) : 'Delete'}
            </Button>
          </>
        }
      >
        <div className="mb-3 rounded border border-warning-500/30 bg-warning-500/10 px-3 py-2 text-sm text-ink">Are you sure you want to delete this tranch schedule?</div>
        {selectedSchedule && (
          <div className={panel}>
            <p className="mb-1 text-ink"><strong>Strategy:</strong> <code>{selectedSchedule.strategyName}</code></p>
            <p className="mb-1 text-ink"><strong>Tranch:</strong> T{selectedSchedule.tranchNumber}</p>
            <p className="mb-0 text-ink"><strong>Time:</strong> {selectedSchedule.scheduledTime}</p>
          </div>
        )}
      </Modal>
    </div>
  );
};

export default TranchSchedules;
