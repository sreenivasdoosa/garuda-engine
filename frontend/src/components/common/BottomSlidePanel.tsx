import { useEffect, type ReactNode } from 'react';
import { BsGraphUp, BsXLg } from 'react-icons/bs';

interface BottomSlidePanelProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  height?: string;
  children: ReactNode;
}

/**
 * Reusable bottom slide-out panel component.
 * Slides up from the bottom of the screen - ideal for charts and wide content.
 */
export default function BottomSlidePanel({
  isOpen,
  onClose,
  title,
  subtitle,
  height = '60vh',
  children,
}: BottomSlidePanelProps) {
  // Close on Escape key
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);

  // Prevent body scroll when panel is open
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed top-0 start-0 w-full h-full"
        style={{
          backgroundColor: 'rgba(0, 0, 0, 0.5)',
          zIndex: 1040,
          animation: 'fadeIn 0.2s ease-out',
        }}
        onClick={onClose}
      />

      {/* Panel */}
      <div
        className="fixed bottom-0 start-0 w-full bg-card shadow-lg flex flex-col"
        style={{
          height,
          maxHeight: '90vh',
          zIndex: 1050,
          borderTopLeftRadius: '16px',
          borderTopRightRadius: '16px',
          animation: 'slideInUp 0.3s ease-out',
        }}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b">
          <div className="flex items-center gap-4">
            {/* Drag handle indicator */}
            <div
              style={{
                width: '40px',
                height: '4px',
                backgroundColor: '#d1d5db',
                borderRadius: '2px',
                position: 'absolute',
                top: '8px',
                left: '50%',
                transform: 'translateX(-50%)',
              }}
            />
            <div>
              <h5 className="mb-0">
                <BsGraphUp className="me-2 text-success-500 dark:text-success-400" />
                {title}
              </h5>
              {subtitle && <small className="text-ink-soft">{subtitle}</small>}
            </div>
          </div>
          <button
            className="inline-flex items-center justify-center gap-1.5 rounded-control font-medium transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 border border-hairline text-ink hover:bg-raised px-2.5 py-1 text-xs"
            onClick={onClose}
            title="Close (Esc)"
          >
            <BsXLg />
          </button>
        </div>

        {/* Content */}
        <div className="grow overflow-hidden">
          {children}
        </div>
      </div>

      {/* Animations */}
      <style>{`
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes slideInUp {
          from { transform: translateY(100%); }
          to { transform: translateY(0); }
        }
      `}</style>
    </>
  );
}
