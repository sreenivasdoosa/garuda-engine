/**
 * FAQs Component
 * Table for listing FAQs with CRUD operations
 * Table structure: SNO (PK), QUESTION, ANSWER
 */

import { useState, useMemo } from 'react';
import { Card, Button, Form, InputGroup, Alert, Spinner, Table, Modal } from '@/components/ui/rbShim';
import { BsPlus, BsTrash, BsSearch, BsPencil, BsQuestionCircle, BsArrowClockwise } from 'react-icons/bs';
import { ConfirmModal } from '@/components/common';
import HelpIcon from '@/components/common/HelpIcon';
import { faqHelpContent } from '@/data/help/faq-help';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { faqService } from '@/services/admin/v2AdminService';
import { toast } from 'react-toastify';
import type { FAQ as FAQType, CreateFAQRequest } from '@/types/system';

export interface FAQsProps {
  /** Card title */
  title?: string;
  /** Hide add button */
  hideCreate?: boolean;
  /** Hide delete button */
  hideDelete?: boolean;
}

const FAQs: React.FC<FAQsProps> = ({
  title = 'FAQs',
  hideCreate = false,
  hideDelete = false,
}) => {
  const [search, setSearch] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [selectedFAQ, setSelectedFAQ] = useState<FAQType | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [formData, setFormData] = useState<CreateFAQRequest>({ question: '', answer: '' });
  const queryClient = useQueryClient();

  const { data: faqs = [], isLoading, error, refetch } = useQuery({
    queryKey: ['faqs'],
    queryFn: () => faqService.getAll(),
  });

  const createMutation = useMutation({
    mutationFn: (data: CreateFAQRequest) => faqService.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['faqs'] });
      toast.success('FAQ created successfully');
      handleCloseModal();
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to create FAQ');
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ sno, data }: { sno: number; data: CreateFAQRequest }) =>
      faqService.update(sno, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['faqs'] });
      toast.success('FAQ updated successfully');
      handleCloseModal();
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to update FAQ');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (sno: number) => faqService.delete(sno),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['faqs'] });
      toast.success('FAQ deleted successfully');
      setShowDeleteConfirm(false);
      setSelectedFAQ(null);
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to delete FAQ');
    },
  });

  const filteredFAQs = useMemo(() => {
    if (!faqs) return [];
    if (!search) return faqs;
    const searchLower = search.toLowerCase();
    return faqs.filter(
      (f) =>
        f.question?.toLowerCase().includes(searchLower) ||
        f.answer?.toLowerCase().includes(searchLower) ||
        String(f.sno).includes(search)
    );
  }, [faqs, search]);

  const handleOpenCreateModal = () => {
    setSelectedFAQ(null);
    setFormData({ question: '', answer: '' });
    setShowModal(true);
  };

  const handleOpenEditModal = (faq: FAQType) => {
    setSelectedFAQ(faq);
    setFormData({ question: faq.question, answer: faq.answer });
    setShowModal(true);
  };

  const handleCloseModal = () => {
    setShowModal(false);
    setSelectedFAQ(null);
    setFormData({ question: '', answer: '' });
  };

  const handleOpenDeleteConfirm = (faq: FAQType) => {
    setSelectedFAQ(faq);
    setShowDeleteConfirm(true);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.question.trim()) {
      toast.error('Question is required');
      return;
    }
    if (!formData.answer.trim()) {
      toast.error('Answer is required');
      return;
    }

    if (selectedFAQ) {
      updateMutation.mutate({ sno: selectedFAQ.sno, data: formData });
    } else {
      createMutation.mutate(formData);
    }
  };

  if (error) {
    return <Alert variant="danger">Failed to load FAQs: {(error as Error).message}</Alert>;
  }

  return (
    <>
      <Card>
        <Card.Header className="flex justify-between items-center">
          <h5 className="mb-0">
            <BsQuestionCircle className="me-2" />
            {title} ({filteredFAQs.length})
          </h5>
          <div className="flex gap-2">
            <InputGroup style={{ width: '300px' }}>
              <InputGroup.Text><BsSearch /></InputGroup.Text>
              <Form.Control
                placeholder="Search FAQs..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </InputGroup>
            <Button variant="outline-secondary" onClick={() => refetch()} title="Refresh">
              <BsArrowClockwise />
            </Button>
            {!hideCreate && (
              <Button variant="primary" onClick={handleOpenCreateModal}>
                <BsPlus className="me-1" /> Add FAQ
              </Button>
            )}
          </div>
        </Card.Header>
        <Card.Body className="p-0">
          {isLoading ? (
            <div className="text-center py-12">
              <Spinner animation="border" variant="primary" />
              <p className="mt-2 text-ink-soft">Loading FAQs...</p>
            </div>
          ) : filteredFAQs.length === 0 ? (
            <div className="text-center py-12 text-ink-soft">
              {search ? (
                <>No FAQs match your search.</>
              ) : (
                <>No FAQs found. Click &quot;Add FAQ&quot; to create one.</>
              )}
            </div>
          ) : (
            <Table hover responsive className="mb-0">
              <thead>
                <tr>
                  <th style={{ width: '60px' }}>SNO</th>
                  <th style={{ width: '35%' }}>Question</th>
                  <th style={{ width: '50%' }}>Answer</th>
                  <th style={{ width: '100px' }} className="text-end">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredFAQs.map((faq) => (
                  <tr key={faq.sno}>
                    <td className="text-ink-soft">{faq.sno}</td>
                    <td>
                      <div className="font-medium">
                        {faq.question.length > 80 ? faq.question.substring(0, 80) + '...' : faq.question}
                      </div>
                    </td>
                    <td>
                      <small className="text-ink-soft">
                        {faq.answer.length > 100 ? faq.answer.substring(0, 100) + '...' : faq.answer}
                      </small>
                    </td>
                    <td className="text-end">
                      <Button
                        variant="outline-primary"
                        size="sm"
                        className="me-1"
                        onClick={() => handleOpenEditModal(faq)}
                        title="Edit"
                      >
                        <BsPencil />
                      </Button>
                      {!hideDelete && (
                        <Button
                          variant="outline-danger"
                          size="sm"
                          onClick={() => handleOpenDeleteConfirm(faq)}
                          title="Delete"
                        >
                          <BsTrash />
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card.Body>
      </Card>

      {/* Add/Edit Modal */}
      <Modal show={showModal} onHide={handleCloseModal} size="lg" backdrop="static">
        <Modal.Header closeButton>
          <Modal.Title>
            <BsQuestionCircle className="me-2" />
            {selectedFAQ ? 'Edit FAQ' : 'Add FAQ'}
          </Modal.Title>
        </Modal.Header>
        <Form onSubmit={handleSubmit}>
          <Modal.Body>
            {selectedFAQ && (
              <Form.Group className="mb-4">
                <Form.Label>SNO</Form.Label>
                <Form.Control type="text" value={selectedFAQ.sno} disabled />
                <Form.Text className="text-ink-soft">SNO cannot be changed</Form.Text>
              </Form.Group>
            )}
            <Form.Group className="mb-4">
              <Form.Label className="flex items-center">Question <span className="text-danger-600 dark:text-danger-400">*</span> <HelpIcon article={faqHelpContent['faq.question']} /></Form.Label>
              <Form.Control
                type="text"
                placeholder="Enter the question"
                value={formData.question}
                onChange={(e) => setFormData({ ...formData, question: e.target.value })}
                required
              />
            </Form.Group>
            <Form.Group className="mb-4">
              <Form.Label className="flex items-center">Answer <span className="text-danger-600 dark:text-danger-400">*</span> <HelpIcon article={faqHelpContent['faq.answer']} /></Form.Label>
              <Form.Control
                as="textarea"
                rows={5}
                placeholder="Enter the answer"
                value={formData.answer}
                onChange={(e) => setFormData({ ...formData, answer: e.target.value })}
                required
              />
            </Form.Group>
          </Modal.Body>
          <Modal.Footer>
            <Button variant="secondary" onClick={handleCloseModal}>
              Cancel
            </Button>
            <Button
              variant="primary"
              type="submit"
              disabled={createMutation.isPending || updateMutation.isPending}
            >
              {(createMutation.isPending || updateMutation.isPending) ? (
                <>
                  <Spinner size="sm" className="me-2" />
                  Saving...
                </>
              ) : (
                selectedFAQ ? 'Update' : 'Add FAQ'
              )}
            </Button>
          </Modal.Footer>
        </Form>
      </Modal>

      {/* Delete Confirmation */}
      <ConfirmModal
        show={showDeleteConfirm}
        title="Delete FAQ"
        message={
          selectedFAQ
            ? `Are you sure you want to delete FAQ #${selectedFAQ.sno}?\n\nQuestion: "${selectedFAQ.question.substring(0, 50)}${selectedFAQ.question.length > 50 ? '...' : ''}"`
            : 'Are you sure you want to delete this FAQ?'
        }
        confirmLabel="Delete"
        confirmVariant="danger"
        onConfirm={() => selectedFAQ && deleteMutation.mutate(selectedFAQ.sno)}
        onCancel={() => { setShowDeleteConfirm(false); setSelectedFAQ(null); }}
        isLoading={deleteMutation.isPending}
      />
    </>
  );
};

export default FAQs;
