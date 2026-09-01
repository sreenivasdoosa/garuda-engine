import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { BsPencil, BsTrash, BsSearch, BsArrowClockwise, BsFileCode, BsCheckCircle, BsXCircle, BsEye } from 'react-icons/bs';
import { toast } from 'react-toastify';

import HelpIcon from '@/components/common/HelpIcon';
import { strategyTemplateHelpContent } from '@/data/help/strategy-template-help';
import { useConfigStore } from '@/store/configStore';
import { strategyTemplateService } from '@/services/admin/strategyEngineService';
import type { StrategyTemplate, CreateStrategyTemplateRequest, UpdateStrategyTemplateRequest, AssetClass } from '@/types/strategy-engine';
import { Badge, Button, Spinner, Modal, Toggle } from '@/components/ui';
import type { Tone } from '@/components/ui';

const ctrl = 'w-full rounded border border-hairline bg-card px-2 py-1.5 text-sm text-ink placeholder:text-ink-faint focus-visible:outline-none focus:border-primary-500/60 disabled:opacity-60';
const label = 'mb-1 flex items-center text-sm font-medium text-ink';
const help = 'mt-1 block text-xs text-ink-soft';
const cell = 'px-3 py-2';
const infoBox = 'rounded border border-accent-500/30 bg-accent-500/10 px-3 py-2 text-sm text-ink';
const panel = 'rounded bg-raised p-3';

const StrategyTemplates: React.FC = () => {
  const queryClient = useQueryClient();
  const [searchTerm, setSearchTerm] = useState('');
  const [showEditModal, setShowEditModal] = useState(false);
  const [showViewModal, setShowViewModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState<StrategyTemplate | null>(null);

  const { supportsEquity, supportsFnO } = useConfigStore();

  const [formData, setFormData] = useState<CreateStrategyTemplateRequest>({
    templateName: '',
    displayName: '',
    description: '',
    evaluatorClass: '',
    supportsTickTrigger: false,
    supportsScheduledTrigger: true,
    supportsSignalTrigger: false,
    supportsPeriodicTrigger: false,
    supportsHedgeManagement: false,
    isFnO: false,
    assetClass: 'FNO',
    supportTranches: false,
    defaultConfig: '',
  });

  // Absent assetClass means a legacy F&O template.
  const assetClassOf = (template: StrategyTemplate): AssetClass => template.assetClass ?? 'FNO';

  const { data: templates = [], isLoading, error, refetch } = useQuery({
    queryKey: ['strategy-templates'],
    queryFn: () => strategyTemplateService.getAll(),
  });

  const updateMutation = useMutation({
    mutationFn: ({ name, data }: { name: string; data: UpdateStrategyTemplateRequest }) => strategyTemplateService.update(name, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['strategy-templates'] });
      toast.success('Template updated successfully');
      handleCloseEditModal();
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to update template');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (name: string) => strategyTemplateService.delete(name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['strategy-templates'] });
      toast.success('Template deleted successfully');
      handleCloseDeleteModal();
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to delete template');
    },
  });

  const filteredTemplates = templates
    // App-mode gate: hide templates whose asset class isn't tradeable in this deployment.
    .filter((template) => (assetClassOf(template) === 'EQUITY' ? supportsEquity() : supportsFnO()))
    .filter(
      (template) =>
        template.templateName.toLowerCase().includes(searchTerm.toLowerCase()) ||
        template.displayName.toLowerCase().includes(searchTerm.toLowerCase()) ||
        (template.evaluatorClass && template.evaluatorClass.toLowerCase().includes(searchTerm.toLowerCase())),
    );

  const handleOpenEditModal = (template: StrategyTemplate) => {
    setSelectedTemplate(template);
    setFormData({
      templateName: template.templateName,
      displayName: template.displayName,
      description: template.description || '',
      evaluatorClass: template.evaluatorClass,
      supportsTickTrigger: template.supportsTickTrigger,
      supportsScheduledTrigger: template.supportsScheduledTrigger,
      supportsSignalTrigger: template.supportsSignalTrigger,
      supportsPeriodicTrigger: template.supportsPeriodicTrigger,
      supportsHedgeManagement: template.supportsHedgeManagement,
      isFnO: template.isFnO,
      assetClass: assetClassOf(template),
      supportTranches: template.supportTranches,
      defaultConfig: template.defaultConfig || '',
    });
    setShowEditModal(true);
  };

  const handleCloseEditModal = () => {
    setShowEditModal(false);
    setSelectedTemplate(null);
  };

  const handleCloseViewModal = () => {
    setShowViewModal(false);
    setSelectedTemplate(null);
  };

  const handleOpenDeleteModal = (template: StrategyTemplate) => {
    setSelectedTemplate(template);
    setShowDeleteModal(true);
  };

  const handleCloseDeleteModal = () => {
    setShowDeleteModal(false);
    setSelectedTemplate(null);
  };

  const handleUpdate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedTemplate) return;
    const { templateName: _tn, ...updateData } = formData;
    updateMutation.mutate({ name: selectedTemplate.templateName, data: updateData });
  };

  const handleDelete = () => {
    if (!selectedTemplate) return;
    deleteMutation.mutate(selectedTemplate.templateName);
  };

  const getCapabilityBadges = (template: StrategyTemplate) => {
    const badges: JSX.Element[] = [];
    const add = (key: string, tone: Tone, text: string) => badges.push(<Badge key={key} tone={tone} className="mr-1">{text}</Badge>);
    if (template.supportsTickTrigger) add('tick', 'primary', 'Tick');
    if (template.supportsScheduledTrigger) add('sched', 'info', 'Scheduled');
    if (template.supportsSignalTrigger) add('signal', 'warning', 'Signal');
    if (template.supportsPeriodicTrigger) add('periodic', 'neutral', 'Periodic');
    if (template.supportsHedgeManagement) add('hedge', 'success', 'Hedge Mgmt');
    if (assetClassOf(template) === 'EQUITY') add('equity', 'info', 'Equity');
    if (template.isFnO) add('fno', 'danger', 'F&O');
    if (template.supportTranches) add('tranch', 'neutral', 'Tranches');
    return badges;
  };

  const capabilityToggles: { key: keyof CreateStrategyTemplateRequest; label: string; help: string }[] = [
    { key: 'supportsTickTrigger', label: 'Tick Trigger', help: 'strategyTemplate.supportsTickTrigger' },
    { key: 'supportsScheduledTrigger', label: 'Scheduled Trigger', help: 'strategyTemplate.supportsScheduledTrigger' },
    { key: 'supportsSignalTrigger', label: 'Signal Trigger', help: 'strategyTemplate.supportsSignalTrigger' },
    { key: 'supportsPeriodicTrigger', label: 'Periodic Trigger', help: 'strategyTemplate.supportsPeriodicTrigger' },
    { key: 'supportsHedgeManagement', label: 'Hedge Mgmt', help: 'strategyTemplate.supportsHedgeManagement' },
    { key: 'isFnO', label: 'F&O Strategy', help: 'strategyTemplate.isFnO' },
    { key: 'supportTranches', label: 'Tranches', help: 'strategyTemplate.supportTranches' },
  ];

  if (error) {
    return <div className="rounded border border-danger-500/30 bg-danger-500/10 px-3 py-2 text-sm text-danger-600 dark:text-danger-400">Failed to load strategy templates: {(error as Error).message}</div>;
  }

  return (
    <div className="rounded-card border border-hairline bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline p-3">
        <h6 className="mb-0 flex items-center gap-2 font-semibold text-ink">
          <BsFileCode />
          Strategy Templates ({filteredTemplates.length})
        </h6>
        <div className="flex gap-2">
          <div className="flex" style={{ width: 300 }}>
            <span className="flex items-center rounded-l border border-r-0 border-hairline bg-raised px-2.5 text-ink-soft">
              <BsSearch />
            </span>
            <input type="text" className={`${ctrl} rounded-l-none`} placeholder="Search templates..." value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} />
          </div>
          <Button variant="secondary" onClick={() => refetch()} title="Refresh">
            <BsArrowClockwise />
          </Button>
        </div>
      </div>
      <div>
        {isLoading ? (
          <div className="py-10 text-center">
            <Spinner className="text-primary-500" />
            <p className="mt-2 text-ink-soft">Loading templates...</p>
          </div>
        ) : filteredTemplates.length === 0 ? (
          <div className="py-10 text-center text-ink-soft">
            {searchTerm ? 'No templates match your search.' : 'No templates found. Templates are registered automatically when new strategy classes are deployed.'}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm [&_tbody_tr]:border-b [&_tbody_tr]:border-hairline">
              <thead className="bg-raised text-xs uppercase text-ink-faint">
                <tr>
                  <th className={`${cell} text-left`}>Template Name</th>
                  <th className={`${cell} text-left`}>Display Name</th>
                  <th className={`${cell} text-left`}>Capabilities</th>
                  <th className={`${cell} text-left`}>Version</th>
                  <th className={`${cell} text-left`}>Status</th>
                  <th className={`${cell} text-right`}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredTemplates.map((template) => (
                  <tr key={template.templateName} className="hover:bg-raised/50">
                    <td className={cell}>
                      <code className="text-primary-500">{template.templateName}</code>
                    </td>
                    <td className={`${cell} text-ink`}>{template.displayName}</td>
                    <td className={cell}>{getCapabilityBadges(template)}</td>
                    <td className={cell}>
                      <Badge tone="neutral">v{template.version}</Badge>
                    </td>
                    <td className={cell}>
                      {template.isActive ? (
                        <Badge tone="success" icon={<BsCheckCircle />}>Active</Badge>
                      ) : (
                        <Badge tone="neutral" icon={<BsXCircle />}>Inactive</Badge>
                      )}
                    </td>
                    <td className={`${cell} text-right`}>

                        <div className="flex justify-end gap-1">
                          <Button variant="secondary" size="sm" onClick={() => handleOpenEditModal(template)} title="Edit">
                            <BsPencil />
                          </Button>
                          <Button variant="danger" size="sm" onClick={() => handleOpenDeleteModal(template)} title="Delete">
                            <BsTrash />
                          </Button>
                        </div>

                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Edit Modal */}
      <Modal
        open={showEditModal}
        onClose={handleCloseEditModal}
        size="lg"
        title={
          <span className="flex items-center gap-2">
            <BsPencil /> Edit Strategy Template
          </span>
        }
        footer={
          <>
            <Button variant="secondary" onClick={handleCloseEditModal}>Cancel</Button>
            <Button variant="primary" type="submit" form="edit-template-form" disabled={updateMutation.isPending}>
              {updateMutation.isPending ? (
                <>
                  <Spinner size="sm" /> Saving...
                </>
              ) : (
                'Save Changes'
              )}
            </Button>
          </>
        }
      >
        <form id="edit-template-form" onSubmit={handleUpdate}>
          <div className="mb-3">
            <label className={label}>Template Name <HelpIcon article={strategyTemplateHelpContent['strategyTemplate.templateName']} /></label>
            <input type="text" className={ctrl} value={selectedTemplate?.templateName || ''} disabled />
            <span className={help}>Template name cannot be changed</span>
          </div>
          <div className="mb-3">
            <label className={label}>Display Name <span className="text-danger-500">*</span> <HelpIcon article={strategyTemplateHelpContent['strategyTemplate.displayName']} /></label>
            <input type="text" className={ctrl} value={formData.displayName} onChange={(e) => setFormData({ ...formData, displayName: e.target.value })} required />
          </div>
          <div className="mb-3">
            <label className={label}>Description <HelpIcon article={strategyTemplateHelpContent['strategyTemplate.description']} /></label>
            <textarea rows={2} className={ctrl} value={formData.description} onChange={(e) => setFormData({ ...formData, description: e.target.value })} />
          </div>
          <div className="mb-3">
            <label className={label}>Evaluator Class <span className="text-danger-500">*</span> <HelpIcon article={strategyTemplateHelpContent['strategyTemplate.evaluatorClass']} /></label>
            <input type="text" className={ctrl} value={formData.evaluatorClass} onChange={(e) => setFormData({ ...formData, evaluatorClass: e.target.value })} required />
          </div>
          <div className="mb-3">
            <label className={label}>Asset Class <HelpIcon article={strategyTemplateHelpContent['strategyTemplate.assetClass']} /></label>
            <select
              className={ctrl}
              value={formData.assetClass ?? 'FNO'}
              onChange={(e) => setFormData({ ...formData, assetClass: e.target.value as AssetClass })}
            >
              <option value="FNO" disabled={!supportsFnO()}>F&O (index/options)</option>
              <option value="EQUITY" disabled={!supportsEquity()}>Equity (stock universe)</option>
            </select>
          </div>
          <div className="mb-3">
            <label className={label}>Capabilities</label>
            <div className="flex flex-wrap gap-x-6 gap-y-2">
              {capabilityToggles.map((c) => (
                <label key={c.key} className="flex cursor-pointer items-center gap-2">
                  <Toggle checked={!!formData[c.key]} onChange={(checked) => setFormData({ ...formData, [c.key]: checked })} />
                  <span className="flex items-center text-sm text-ink">
                    {c.label}
                    <HelpIcon article={strategyTemplateHelpContent[c.help]} />
                  </span>
                </label>
              ))}
            </div>
          </div>
          <div className="mb-1">
            <label className={label}>Default Configuration (JSON) <HelpIcon article={strategyTemplateHelpContent['strategyTemplate.defaultConfig']} /></label>
            <textarea rows={3} className={`${ctrl} font-mono`} value={formData.defaultConfig} onChange={(e) => setFormData({ ...formData, defaultConfig: e.target.value })} />
          </div>
        </form>
      </Modal>

      {/* View Modal (Read-only for non-sysadmin) */}
      <Modal
        open={showViewModal}
        onClose={handleCloseViewModal}
        size="lg"
        title={
          <span className="flex items-center gap-2">
            <BsEye /> View Template Details
          </span>
        }
        footer={<Button variant="secondary" onClick={handleCloseViewModal}>Close</Button>}
      >
        {selectedTemplate && (
          <>
            <div className={`${panel} mb-3`}>
              <p className="mb-1 text-ink"><strong>Template Name:</strong> <code>{selectedTemplate.templateName}</code></p>
              <p className="mb-1 text-ink"><strong>Display Name:</strong> {selectedTemplate.displayName}</p>
              <p className="mb-1 text-ink"><strong>Description:</strong> {selectedTemplate.description || 'N/A'}</p>
              <p className="mb-0 text-ink"><strong>Evaluator Class:</strong> <code className="break-words">{selectedTemplate.evaluatorClass}</code></p>
            </div>
            <div className="mb-3 text-ink">
              <strong>Capabilities:</strong>
              <div className="mt-2">{getCapabilityBadges(selectedTemplate)}</div>
            </div>
            <div className="mb-3 flex items-center gap-2 text-ink">
              <strong>Status:</strong>
              {selectedTemplate.isActive ? (
                <Badge tone="success" icon={<BsCheckCircle />}>Active</Badge>
              ) : (
                <Badge tone="neutral" icon={<BsXCircle />}>Inactive</Badge>
              )}
              <Badge tone="neutral">v{selectedTemplate.version}</Badge>
            </div>
            {selectedTemplate.defaultConfig && (
              <div className="text-ink">
                <strong>Default Configuration:</strong>
                <pre className="mt-2 rounded bg-raised p-2 text-[0.85rem] text-ink">{selectedTemplate.defaultConfig}</pre>
              </div>
            )}
            <div className={`${infoBox} mt-3`}>
              <small>Only sysadmin users can edit or delete templates.</small>
            </div>
          </>
        )}
      </Modal>

      {/* Delete Confirmation Modal */}
      <Modal
        open={showDeleteModal}
        onClose={handleCloseDeleteModal}
        title={
          <span className="flex items-center gap-2 text-danger-500">
            <BsTrash /> Delete Template
          </span>
        }
        footer={
          <>
            <Button variant="secondary" onClick={handleCloseDeleteModal}>Cancel</Button>
            <Button variant="danger" onClick={handleDelete} disabled={deleteMutation.isPending}>
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
        <div className="mb-3 rounded border border-warning-500/30 bg-warning-500/10 px-3 py-2 text-sm text-ink">Are you sure you want to delete this template?</div>
        {selectedTemplate && (
          <div className={panel}>
            <p className="mb-1 text-ink"><strong>Name:</strong> <code>{selectedTemplate.templateName}</code></p>
            <p className="mb-0 text-ink"><strong>Display:</strong> {selectedTemplate.displayName}</p>
          </div>
        )}
        <p className="m-0 mt-3 text-sm text-danger-500">
          <strong>Warning:</strong> This may affect strategy definitions using this template.
        </p>
      </Modal>
    </div>
  );
};

export default StrategyTemplates;
