import { Modal, Button } from '@/components/ui';

// Shared confirm dialog. Migrated to the Tailwind design-system ui/Modal +
// ui/Button; API unchanged so all 33 consumers work as-is.
export interface ConfirmModalProps {
  show: boolean;
  onHide?: () => void;
  onCancel?: () => void;
  onConfirm: () => void;
  title: string;
  message: string | React.ReactNode;
  confirmText?: string;
  confirmLabel?: string;
  cancelText?: string;
  confirmVariant?: 'primary' | 'danger' | 'warning';
  loading?: boolean;
  isLoading?: boolean;
}

const ConfirmModal: React.FC<ConfirmModalProps> = ({
  show,
  onHide,
  onCancel,
  onConfirm,
  title,
  message,
  confirmText,
  confirmLabel,
  cancelText = 'Cancel',
  confirmVariant = 'primary',
  loading,
  isLoading,
}) => {
  const handleClose = onHide || onCancel || (() => {});
  const isProcessing = loading || isLoading || false;
  const buttonText = confirmLabel || confirmText || 'Confirm';

  return (
    <Modal
      open={show}
      onClose={handleClose}
      size="sm"
      title={title}
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={handleClose} disabled={isProcessing}>
            {cancelText}
          </Button>
          <Button variant={confirmVariant} size="sm" onClick={onConfirm} disabled={isProcessing}>
            {isProcessing ? 'Please wait...' : buttonText}
          </Button>
        </>
      }
    >
      <div className="text-sm text-ink">{message}</div>
    </Modal>
  );
};

export default ConfirmModal;
