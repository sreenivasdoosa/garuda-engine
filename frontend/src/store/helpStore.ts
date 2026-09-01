import { create } from 'zustand';
import type { HelpArticle } from '@/types/help';

interface HelpState {
  isOpen: boolean;
  activeArticle: HelpArticle | null;
  history: HelpArticle[];

  openHelp: (article: HelpArticle) => void;
  closeHelp: () => void;
  navigateTo: (article: HelpArticle) => void;
  goBack: () => void;
}

export const useHelpStore = create<HelpState>((set) => ({
  isOpen: false,
  activeArticle: null,
  history: [],

  openHelp: (article) =>
    set({ isOpen: true, activeArticle: article, history: [] }),

  closeHelp: () =>
    set({ isOpen: false, activeArticle: null, history: [] }),

  navigateTo: (article) =>
    set((state) => ({
      activeArticle: article,
      history: state.activeArticle
        ? [...state.history, state.activeArticle]
        : state.history,
    })),

  goBack: () =>
    set((state) => {
      const newHistory = [...state.history];
      const previous = newHistory.pop();
      return {
        activeArticle: previous ?? state.activeArticle,
        history: newHistory,
      };
    }),
}));
