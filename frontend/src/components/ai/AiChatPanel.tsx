/**
 * AI analytics assistant chat panel — v3 agentic investigation.
 *
 * Free-text questions only: the SERVER decides what to check (SQL / alerts /
 * logs / live state) via a Claude-Code-style tool loop and returns the answer
 * plus a collapsible investigation trace. Example chips seed an empty chat.
 *
 * Conversation state lives in the zustand aiChatStore, NOT here — closing
 * the drawer or navigating pages is a MINIMIZE: the chat (and any in-flight
 * investigation, which keeps polling in the store) is exactly where you left
 * it. Only "New chat" resets.
 */
import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BsCheck2, BsChevronDown, BsChevronRight, BsClipboard, BsLightningCharge, BsSend, BsStars, BsTrash } from 'react-icons/bs';
import { useState } from 'react';
import clsx from 'clsx';

import { aiService } from '@/services/admin/aiService';
import { useAiChatStore } from '@/store/aiChatStore';
import { getAiMaxQuestionChars } from '@/config/featureFlags';
import type { AiTraceStep } from '@/types/ai';
import { Spinner } from '@/components/ui';
import AiMarkdown from '@/components/ai/AiMarkdown';

const card = 'rounded-card border border-hairline bg-card';

// Keep growing this list as §18 roadmap phases land — the chips are the
// user's discovery surface for new assistant capabilities.
const EXAMPLE_QUESTIONS = [
  'How many trades got cancelled today, for which users, and why?',
  'Why did strategy CRACKER-BNF place no trades yesterday?',
  'Why did user <username> get NO trades today? Run the full no-trades diagnosis.',
  'Which users have broker login failures right now?',
  'Analyze trade <paste trade id> — walk me through what happened and the root cause.',
  'Any token errors, RMS blocks, or order rejections this morning?',
  'What happened in the square-off window today — anything stuck or retried?',
  'What SL% and target% applies for strategy REBOUND-IV-SENSEX on expiry day (zero-DTE)?',
  'What are the tranch entry timings configured for strategy BID-BNF?',
  'Is user <username> subscribed to strategy X — and can that subscription actually trade?',
  'What brokerage and statutory charges does user <username> pay on broker Y for options intraday?',
  'Any RMS kill switches active today? Show recent RMS breaches.',
  'Is tomorrow a market holiday? Any event days this week with reduced capital?',
  'Is everything healthy right now — market data flowing, broker sockets connected, RMS on?',
  'Which broker is slowest at placing orders today? Compare avg/max API latency per broker.',
  'Is today zero-DTE for SENSEX? When are the next NIFTY weekly and monthly expiries?',
  'What RMS limits actually apply for user <username> on OPTIONS — max qty, order value, loss?',
  'When does the next tranch of strategy X fire today, and which tranches already went?',
  'Is the morning hedge replace done for all positional strategies? Any pending or failed?',
  'How is the system doing — RAM, CPU, thread pools, queue backlogs?',
  'How do I set a broker-specific order rate limit from the console? Walk me through it.',
  'Is this rejection from OUR internal RMS or from the broker? <paste the error message>',
];

/** Copy-to-clipboard for an assistant answer (raw Markdown), claude.ai style. */
const CopyButton: React.FC<{ text: string }> = ({ text }) => {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable (http/permissions) — silently ignore */
    }
  };
  return (
    <button
      type="button"
      onClick={copy}
      title={copied ? 'Copied!' : 'Copy response'}
      className="flex items-center gap-1 rounded px-1 py-0.5 text-[11px] text-ink-faint hover:text-ink"
    >
      {copied ? <BsCheck2 size={12} className="text-success-500" /> : <BsClipboard size={11} />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
};

/** Collapsible per-answer investigation trace — what the assistant checked. */
const TraceView: React.FC<{ trace: AiTraceStep[] }> = ({ trace }) => {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-2 border-t border-hairline pt-1.5">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 text-[11px] font-medium text-ink-faint hover:text-ink"
      >
        {open ? <BsChevronDown size={10} /> : <BsChevronRight size={10} />}
        Investigation — {trace.length} step{trace.length === 1 ? '' : 's'}
      </button>
      {open && (
        <>
          <div className="mt-1 flex justify-end">
            {/* Separate from the answer copy: this grabs the INTERNALS —
                per-step tool + summary + detail (the exact SQL queries). */}
            <CopyButton
              text={trace
                .map((step, i) => `${i + 1}. [${step.tool}] ${step.summary}${step.detail ? '\n' + step.detail : ''}`)
                .join('\n\n')}
            />
          </div>
          <ol className="mt-1.5 space-y-1">
          {trace.map((step, i) => (
            <li key={i} className="text-[11px] leading-snug">
              <span
                className={clsx(
                  'mr-1.5 rounded px-1 py-0.5 font-mono text-[10px]',
                  step.error ? 'bg-danger-500/15 text-danger-500' : 'bg-primary-500/10 text-primary-500',
                )}
              >
                {step.tool}
              </span>
              <span className="text-ink-soft">{step.summary}</span>
              {step.detail && (
                <pre className="mt-0.5 overflow-x-auto rounded bg-raised px-2 py-1 font-mono text-[10px] text-ink-faint">
                  {step.detail}
                </pre>
              )}
            </li>
          ))}
          </ol>
        </>
      )}
    </div>
  );
};

interface AiChatPanelProps {
  /** Override the page-sized default when embedding (e.g. 'h-full' in the header drawer). */
  heightClass?: string;
}

const AiChatPanel: React.FC<AiChatPanelProps> = ({ heightClass }) => {
  const queryClient = useQueryClient();
  const { entries, draft, deep, pending, setDraft, setDeep, newChat, send } = useAiChatStore();
  const scrollRef = useRef<HTMLDivElement>(null);

  const { data: usage } = useQuery({
    queryKey: ['ai', 'usage'],
    queryFn: aiService.getUsage,
  });

  // Follow the conversation tail — also fires when reopening onto new content.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [entries.length, pending]);

  const submit = (text?: string) => {
    const q = (text ?? draft).trim();
    if (!q || pending) return;
    void send(q).finally(() =>
      queryClient.invalidateQueries({ queryKey: ['ai', 'usage'] }));
  };

  if (usage && !usage.enabled) {
    return (
      <div className={clsx(card, 'p-6 text-sm text-ink-soft')}>
        The AI assistant is currently disabled (<code>ai.enabled</code>). Ask a system
        administrator to configure the API key and enable it in System Config.
      </div>
    );
  }

  return (
    <div className={clsx(card, 'flex flex-col', heightClass ?? 'h-[calc(100vh-14rem)] min-h-[28rem]')}>
      {/* header: usage + new chat */}
      <div className="flex items-center justify-between border-b border-hairline px-4 py-2">
        <div className="flex items-center gap-2 text-sm font-semibold text-ink">
          <BsStars className="text-primary-500" /> Chat
        </div>
        <div className="flex items-center gap-3 text-xs text-ink-faint">
          {usage && (
            <span>
              {usage.requestsUsedToday}/{usage.requestLimitPerDay} requests today
            </span>
          )}
          <button
            type="button"
            onClick={newChat}
            className="flex items-center gap-1 rounded border border-hairline px-2 py-1 text-xs text-ink-soft hover:text-ink"
          >
            <BsTrash size={12} /> New chat
          </button>
        </div>
      </div>

      {/* messages */}
      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-4">
        {entries.length === 0 && (
          <div className="mx-auto mt-6 max-w-xl">
            <div className="mb-3 text-center text-sm text-ink-soft">
              Ask anything about your trading platform — trades, P&L, cancellations, login issues,
              strategies, alerts. The assistant investigates the database, alerts, and application
              logs itself. Closing this panel keeps the conversation — come back anytime. For
              example:
            </div>
            <div className="flex flex-wrap justify-center gap-2">
              {EXAMPLE_QUESTIONS.map((example) => (
                <button
                  key={example}
                  type="button"
                  onClick={() =>
                    example.includes('<paste') ? setDraft(example) : submit(example)
                  }
                  className="rounded-full border border-hairline bg-card px-3 py-1.5 text-left text-xs font-medium text-ink shadow-sm transition-colors hover:border-primary-500/60 hover:bg-primary-500/10"
                >
                  {example}
                </button>
              ))}
            </div>
          </div>
        )}
        {entries.map((entry, i) => (
          <div key={i} className={clsx('flex', entry.role === 'user' ? 'justify-end' : 'justify-start')}>
            <div
              className={clsx(
                'max-w-[85%] rounded-lg px-3 py-2 text-sm',
                entry.role === 'user'
                  ? 'bg-primary-500/20 text-ink'
                  : entry.error
                    ? 'border border-danger-500/40 bg-danger-500/10 text-ink'
                    : 'border border-hairline bg-card text-ink shadow-sm',
              )}
            >
              {entry.role === 'assistant' && !entry.error ? (
                // Assistant answers are Markdown (headings/tables/bold) — render rich.
                <div className="break-words">
                  <AiMarkdown content={entry.content} />
                </div>
              ) : (
                <div className="whitespace-pre-wrap break-words">{entry.content}</div>
              )}
              {entry.trace && entry.trace.length > 0 && <TraceView trace={entry.trace} />}
              {entry.role === 'assistant' && !entry.error && (
                <div className="mt-2 flex items-center justify-between border-t border-hairline pt-1 text-[11px] text-ink-faint">
                  {entry.meta ? (
                    <span>
                      {entry.meta.model} · {entry.meta.steps} step{entry.meta.steps === 1 ? '' : 's'} ·{' '}
                      {entry.meta.inputTokens} in / {entry.meta.outputTokens} out
                      {entry.meta.cacheReadTokens > 0 && <> · {entry.meta.cacheReadTokens} cached</>}
                    </span>
                  ) : (
                    <span />
                  )}
                  {/* Copies the ANSWER text only — the investigation trace (SQL etc.)
                      has its own copy inside the expanded trace. */}
                  <CopyButton text={entry.content} />
                </div>
              )}
            </div>
          </div>
        ))}
        {pending && (
          <div className="flex items-center gap-2 text-sm text-ink-faint">
            <Spinner size="sm" /> Investigating — checking database, alerts, and logs as needed…
            <span className="text-[11px]">(you can close this panel; the answer will be here)</span>
          </div>
        )}
      </div>

      {/* input */}
      <div className="space-y-2 border-t border-hairline p-3">
        <div className="flex items-end gap-2">
          <textarea
            rows={3}
            maxLength={getAiMaxQuestionChars()}
            className="flex-1 resize-none rounded border border-hairline bg-card px-2 py-1.5 text-sm text-ink focus-visible:outline-none focus:border-primary-500/60"
            placeholder="Ask about trades, users, strategies, failures — the assistant will investigate…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              if (e.shiftKey) return; // native newline
              if (e.altKey || e.ctrlKey) {
                // Browsers do NOT insert a newline on Alt/Ctrl+Enter — do it
                // manually at the cursor so all three modifiers mean "new line".
                e.preventDefault();
                const el = e.currentTarget;
                const start = el.selectionStart ?? draft.length;
                const end = el.selectionEnd ?? draft.length;
                setDraft(draft.slice(0, start) + '\n' + draft.slice(end));
                requestAnimationFrame(() => {
                  el.selectionStart = el.selectionEnd = start + 1;
                });
                return;
              }
              e.preventDefault();
              submit();
            }}
          />
          <div className="flex flex-col items-end gap-1.5">
            {/* Gated by ai.deep.analysis.enabled (also enforced server-side). */}
            {usage?.deepAnalysisEnabled && (
              <label
                className="flex cursor-pointer items-center gap-1.5 text-xs text-ink-soft"
                title="Deep Analysis routes this question to the expensive model — use for hard investigations"
              >
                <input
                  type="checkbox"
                  checked={deep}
                  onChange={(e) => setDeep(e.target.checked)}
                  className="accent-primary-500"
                />
                <BsLightningCharge size={12} className={deep ? 'text-warning-500' : ''} />
                Deep
              </label>
            )}
            <button
              type="button"
              onClick={() => submit()}
              disabled={!draft.trim() || pending}
              className={clsx(
                'flex h-9 items-center gap-1.5 rounded px-3 text-sm font-medium',
                draft.trim() && !pending
                  ? 'bg-primary-500 text-white hover:bg-primary-600'
                  : 'cursor-not-allowed bg-raised text-ink-faint',
              )}
            >
              <BsSend size={13} /> Send
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AiChatPanel;
