/**
 * Header entry point for the AI assistant: icon-only button (next to the
 * alerts bell) opening the chat in a right-side drawer — same Drawer used by
 * the terminal's trade/order details. Renders nothing without the
 * AI_ANALYTICS tool.
 *
 * Closing the drawer is a MINIMIZE: the conversation lives in aiChatStore,
 * so it survives close/reopen and page navigation (go copy a trade id from
 * Trade Log, come back, paste). The icon shows a dot while a conversation
 * exists and pulses while an investigation is still running in the background.
 */
import { useState } from 'react';
import { BsStars } from 'react-icons/bs';
import clsx from 'clsx';

import { Drawer } from '@/components/ui/Drawer';
import AiChatPanel from '@/components/ai/AiChatPanel';
import { useAiChatStore } from '@/store/aiChatStore';
import { usePermissions } from '@/hooks/usePermissions';

const AiAssistantHeaderButton: React.FC = () => {
  const { aiAssistant } = usePermissions();
  const [open, setOpen] = useState(false);
  const hasConversation = useAiChatStore((s) => s.entries.length > 0);
  const pending = useAiChatStore((s) => s.pending);

  if (!aiAssistant.canView) return null;

  return (
    <>
      <button
        type="button"
        className="relative p-2 text-white/80 hover:text-white transition-colors"
        aria-label="AI Assistant"
        title={pending ? 'AI Assistant — investigation running' : 'AI Assistant'}
        onClick={() => setOpen(true)}
      >
        <BsStars size={20} />
        {(hasConversation || pending) && (
          <span
            className={clsx(
              'absolute top-1 right-1 h-2 w-2 rounded-full',
              pending ? 'animate-pulse bg-warning-500' : 'bg-primary-500',
            )}
          />
        )}
      </button>
      <Drawer open={open} onClose={() => setOpen(false)} title="AI Assistant" width="680px">
        <AiChatPanel heightClass="h-full" />
      </Drawer>
    </>
  );
};

export default AiAssistantHeaderButton;
