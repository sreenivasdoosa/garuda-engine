import { useState } from 'react';
import { Card, Table, Button, Form, Modal, Badge, InputGroup, Spinner, Alert } from '@/components/ui/rbShim';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  BsPlus,
  BsPencil,
  BsTrash,
  BsSearch,
  BsArrowClockwise,
  BsKey,
  BsFileText,
} from 'react-icons/bs';
import { toast } from 'react-toastify';

import { PageHeader } from '@/components/common';
import HelpIcon from '@/components/common/HelpIcon';
import { systemConfigHelpContent } from '@/data/help/system-config-help';
import {
  systemConfigService,
  SystemConfigEntry,
  CreateSystemConfigRequest,
  UpdateSystemConfigRequest,
} from '@/services/admin/v2AdminService';

const SystemConfig: React.FC = () => {
  const queryClient = useQueryClient();
  const [searchTerm, setSearchTerm] = useState('');
  const [showAddModal, setShowAddModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [selectedConfig, setSelectedConfig] = useState<SystemConfigEntry | null>(null);

  // Permission flags for System Config tool

  // Form state
  const [formData, setFormData] = useState<CreateSystemConfigRequest>({
    property: '',
    value: '',
  });

  // Fetch all configs
  const {
    data: configs = [],
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ['system-configs'],
    queryFn: () => systemConfigService.getAll(),
  });

  // Create mutation
  const createMutation = useMutation({
    mutationFn: (data: CreateSystemConfigRequest) => systemConfigService.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['system-configs'] });
      toast.success('Config created successfully');
      handleCloseAddModal();
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to create config');
    },
  });

  // Update mutation
  const updateMutation = useMutation({
    mutationFn: ({ property, data }: { property: string; data: UpdateSystemConfigRequest }) =>
      systemConfigService.update(property, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['system-configs'] });
      toast.success('Config updated successfully');
      handleCloseEditModal();
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to update config');
    },
  });

  // Delete mutation
  const deleteMutation = useMutation({
    mutationFn: (property: string) => systemConfigService.delete(property),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['system-configs'] });
      toast.success('Config deleted successfully');
      handleCloseDeleteModal();
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to delete config');
    },
  });

  // Filter configs based on search term
  const filteredConfigs = configs.filter(
    (config) =>
      config.property.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (config.value && config.value.toLowerCase().includes(searchTerm.toLowerCase()))
  );

  // Modal handlers
  const handleOpenAddModal = () => {
    setFormData({ property: '', value: '' });
    setShowAddModal(true);
  };

  const handleCloseAddModal = () => {
    setShowAddModal(false);
    setFormData({ property: '', value: '' });
  };

  const handleOpenEditModal = (config: SystemConfigEntry) => {
    setSelectedConfig(config);
    setFormData({
      property: config.property,
      value: config.value || '',
    });
    setShowEditModal(true);
  };

  const handleCloseEditModal = () => {
    setShowEditModal(false);
    setSelectedConfig(null);
    setFormData({ property: '', value: '' });
  };

  const handleOpenDeleteModal = (config: SystemConfigEntry) => {
    setSelectedConfig(config);
    setShowDeleteModal(true);
  };

  const handleCloseDeleteModal = () => {
    setShowDeleteModal(false);
    setSelectedConfig(null);
  };

  // Form submission handlers
  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.property.trim()) {
      toast.error('Property name is required');
      return;
    }
    createMutation.mutate(formData);
  };

  const handleUpdate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedConfig) return;
    updateMutation.mutate({
      property: selectedConfig.property,
      data: {
        value: formData.value,
      },
    });
  };

  const handleDelete = () => {
    if (!selectedConfig) return;
    deleteMutation.mutate(selectedConfig.property);
  };

  // Determine if a value looks like a boolean, number, or URL for display purposes
  const getValueBadge = (value: string | null) => {
    if (!value) return null;
    if (value === 'true' || value === 'false') {
      return (
        <Badge bg={value === 'true' ? 'success' : 'secondary'} className="ms-2">
          {value}
        </Badge>
      );
    }
    if (!isNaN(Number(value)) && value.trim() !== '') {
      return (
        <Badge bg="info" className="ms-2">
          number
        </Badge>
      );
    }
    if (value.startsWith('http://') || value.startsWith('https://')) {
      return (
        <Badge bg="primary" className="ms-2">
          URL
        </Badge>
      );
    }
    return null;
  };

  if (error) {
    return (
      <div className="fade-in">
        <PageHeader title="System Configuration" subtitle="Manage system-wide settings" />
        <Alert variant="danger">
          Failed to load system configuration: {(error as Error).message}
        </Alert>
      </div>
    );
  }

  return (
    <div className="fade-in">
      <PageHeader
        title="System Configuration"
        subtitle="Manage system-wide key-value configuration settings"
      />

      <Card>
        <Card.Header className="flex justify-between items-center">
          <div className="flex items-center gap-4">
            <h6 className="mb-0">
              <BsKey className="me-2" />
              Configuration Properties ({filteredConfigs.length})
            </h6>
          </div>
          <div className="flex gap-2">
            <InputGroup style={{ width: '300px' }}>
              <InputGroup.Text>
                <BsSearch />
              </InputGroup.Text>
              <Form.Control
                type="text"
                placeholder="Search by property or value..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </InputGroup>
            <Button variant="outline-secondary" onClick={() => refetch()} title="Refresh">
              <BsArrowClockwise />
            </Button>
                          <Button variant="primary" onClick={handleOpenAddModal}>
                <BsPlus className="me-1" />
                Add Config
              </Button>
            
          </div>
        </Card.Header>
        <Card.Body className="p-0">
          {isLoading ? (
            <div className="text-center py-12">
              <Spinner animation="border" variant="primary" />
              <p className="mt-2 text-ink-soft">Loading configurations...</p>
            </div>
          ) : filteredConfigs.length === 0 ? (
            <div className="text-center py-12 text-ink-soft">
              {searchTerm ? (
                <>No configurations match your search.</>
              ) : (
                <>No configurations found. Click &quot;Add Config&quot; to create one.</>
              )}
            </div>
          ) : (
            <Table hover responsive className="mb-0">
              <thead>
                <tr>
                  <th style={{ width: '40%' }}>Property</th>
                  <th style={{ width: '50%' }}>Value</th>
                  <th style={{ width: '10%' }} className="text-end">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {filteredConfigs.map((config) => (
                  <tr key={config.property}>
                    <td>
                      <code className="text-primary-700 dark:text-primary-400">{config.property}</code>
                    </td>
                    <td>
                      <span
                        className="truncate inline-block"
                        style={{ maxWidth: '400px' }}
                        title={config.value || ''}
                      >
                        {config.value || <em className="text-ink-soft">null</em>}
                      </span>
                      {getValueBadge(config.value)}
                    </td>
                    <td className="text-end">
                                              <Button
                          variant="outline-primary"
                          size="sm"
                          className="me-1"
                          onClick={() => handleOpenEditModal(config)}
                          title="Edit"
                        >
                          <BsPencil />
                        </Button>
                      
                                              <Button
                          variant="outline-danger"
                          size="sm"
                          onClick={() => handleOpenDeleteModal(config)}
                          title="Delete"
                        >
                          <BsTrash />
                        </Button>
                      
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card.Body>
      </Card>

      {/* Add Modal */}
      <Modal show={showAddModal} onHide={handleCloseAddModal} backdrop="static">
        <Modal.Header closeButton>
          <Modal.Title>
            <BsPlus className="me-2" />
            Add Configuration
          </Modal.Title>
        </Modal.Header>
        <Form onSubmit={handleCreate}>
          <Modal.Body>
            <Form.Group className="mb-4">
              <Form.Label className="flex items-center">
                Property <span className="text-danger-600 dark:text-danger-400">*</span> <HelpIcon article={systemConfigHelpContent['systemConfig.property']} />
              </Form.Label>
              <Form.Control
                type="text"
                placeholder="e.g., app.feature.enabled"
                value={formData.property}
                onChange={(e) => setFormData({ ...formData, property: e.target.value })}
                required
              />
              <Form.Text className="text-ink-soft">
                Use dot notation for hierarchical keys (e.g., app.setting.name)
              </Form.Text>
            </Form.Group>
            <Form.Group className="mb-4">
              <Form.Label className="flex items-center">
                Value <span className="text-danger-600 dark:text-danger-400">*</span> <HelpIcon article={systemConfigHelpContent['systemConfig.value']} />
              </Form.Label>
              <Form.Control
                as="textarea"
                rows={3}
                placeholder="Enter the configuration value"
                value={formData.value}
                onChange={(e) => setFormData({ ...formData, value: e.target.value })}
                required
              />
            </Form.Group>
          </Modal.Body>
          <Modal.Footer>
            <Button variant="secondary" onClick={handleCloseAddModal}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" disabled={createMutation.isPending}>
              {createMutation.isPending ? (
                <>
                  <Spinner size="sm" className="me-2" />
                  Creating...
                </>
              ) : (
                'Create'
              )}
            </Button>
          </Modal.Footer>
        </Form>
      </Modal>

      {/* Edit Modal */}
      <Modal show={showEditModal} onHide={handleCloseEditModal} backdrop="static">
        <Modal.Header closeButton>
          <Modal.Title>
            <BsPencil className="me-2" />
            Edit Configuration
          </Modal.Title>
        </Modal.Header>
        <Form onSubmit={handleUpdate}>
          <Modal.Body>
            <Form.Group className="mb-4">
              <Form.Label className="flex items-center">Property <HelpIcon article={systemConfigHelpContent['systemConfig.property']} /></Form.Label>
              <Form.Control type="text" value={selectedConfig?.property || ''} disabled />
              <Form.Text className="text-ink-soft">Property name cannot be changed</Form.Text>
            </Form.Group>
            <Form.Group className="mb-4">
              <Form.Label className="flex items-center">
                Value <span className="text-danger-600 dark:text-danger-400">*</span> <HelpIcon article={systemConfigHelpContent['systemConfig.value']} />
              </Form.Label>
              <Form.Control
                as="textarea"
                rows={3}
                placeholder="Enter the configuration value"
                value={formData.value}
                onChange={(e) => setFormData({ ...formData, value: e.target.value })}
                required
              />
            </Form.Group>
          </Modal.Body>
          <Modal.Footer>
            <Button variant="secondary" onClick={handleCloseEditModal}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" disabled={updateMutation.isPending}>
              {updateMutation.isPending ? (
                <>
                  <Spinner size="sm" className="me-2" />
                  Saving...
                </>
              ) : (
                'Save Changes'
              )}
            </Button>
          </Modal.Footer>
        </Form>
      </Modal>

      {/* Delete Confirmation Modal */}
      <Modal show={showDeleteModal} onHide={handleCloseDeleteModal}>
        <Modal.Header closeButton>
          <Modal.Title className="text-danger-600 dark:text-danger-400">
            <BsTrash className="me-2" />
            Delete Configuration
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Alert variant="warning">
            <BsFileText className="me-2" />
            Are you sure you want to delete this configuration?
          </Alert>
          {selectedConfig && (
            <div className="p-4 bg-raised rounded-md">
              <p className="mb-1">
                <strong>Property:</strong> <code>{selectedConfig.property}</code>
              </p>
              <p className="mb-0">
                <strong>Value:</strong> {selectedConfig.value || <em>null</em>}
              </p>
            </div>
          )}
          <p className="mt-4 text-danger-600 dark:text-danger-400 mb-0">
            <strong>Warning:</strong> This action cannot be undone. Deleting a configuration may
            affect system behavior.
          </p>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={handleCloseDeleteModal}>
            Cancel
          </Button>
          <Button variant="danger" onClick={handleDelete} disabled={deleteMutation.isPending}>
            {deleteMutation.isPending ? (
              <>
                <Spinner size="sm" className="me-2" />
                Deleting...
              </>
            ) : (
              'Delete'
            )}
          </Button>
        </Modal.Footer>
      </Modal>
    </div>
  );
};

export default SystemConfig;
