/**
 * AI assistant conversation store (zustand, module-scoped) — the chat
 * SURVIVES closing the header drawer and navigating between console pages:
 * closing is effectively "minimize". The async send flow lives HERE (not in
 * the component), so an in-flight investigation keeps polling while the
 * drawer is closed and the answer is waiting when it reopens. "New chat" is
 * the only thing that resets. Per browser tab (no persistence).
 */
import { create } from 'zustand';

import { aiService } from '@/services/admin/aiService';
import type { AiChatMessage, AiResult, AiTraceStep } from '@/types/ai';

export interface AiTurnMeta {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  steps: number;
}

export interface AiChatEntry extends AiChatMessage {
  meta?: AiTurnMeta; // assistant turns only
  trace?: AiTraceStep[];
  error?: boolean;
}

interface AiChatState {
  conversationId: string;
  entries: AiChatEntry[];
  draft: string;
  deep: boolean;
  pending: boolean;

  setDraft: (draft: string) => void;
  setDeep: (deep: boolean) => void;
  newChat: () => void;
  /** Submit + poll; safe across component unmounts. Returns when terminal. */
  send: (question: string) => Promise<void>;
}

export const useAiChatStore = create<AiChatState>((set, get) => ({
  conversationId: crypto.randomUUID(),
  entries: [],
  draft: '',
  deep: false,
  pending: false,

  setDraft: (draft) => set({ draft }),
  setDeep: (deep) => set({ deep }),

  newChat: () =>
    set({
      conversationId: crypto.randomUUID(),
      entries: [],
      draft: '',
      deep: false,
      // Deliberately NOT clearing pending: an in-flight turn belongs to the
      // old conversation and its completion handler checks the id below.
    }),

  send: async (question) => {
    const state = get();
    if (state.pending || !question.trim()) return;
    const q = question.trim();
    const conversationId = state.conversationId;
    const history: AiChatMessage[] = state.entries
      .filter((e) => !e.error)
      .map(({ role, content }) => ({ role, content }));

    set({
      entries: [...state.entries, { role: 'user', content: q }],
      draft: '',
      pending: true,
    });

    let entry: AiChatEntry;
    try {
      const result: AiResult = await aiService.analyzeAndWait({
        question: q,
        history,
        deep: get().deep,
        conversationId,
      });
      entry =
        result.status === 'OK'
          ? {
              role: 'assistant',
              content: result.analysis ?? '',
              trace: result.trace ?? undefined,
              meta: {
                model: result.model,
                inputTokens: result.inputTokens,
                outputTokens: result.outputTokens,
                cacheReadTokens: result.cacheReadTokens,
                steps: result.steps,
              },
            }
          : { role: 'assistant', content: result.errorMessage ?? 'AI analysis failed', error: true };
    } catch (err: unknown) {
      const message =
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message ??
        (err instanceof Error ? err.message : 'AI request failed');
      entry = { role: 'assistant', content: message, error: true };
    }

    // If the user hit "New chat" while this was in flight, drop the stale
    // answer rather than appending it to the fresh conversation.
    if (get().conversationId !== conversationId) {
      set({ pending: false });
      return;
    }
    set({ entries: [...get().entries, entry], pending: false });
  },
}));
