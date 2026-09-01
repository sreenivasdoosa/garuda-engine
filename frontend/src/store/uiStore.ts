import { create } from 'zustand';

interface UIState {
  // Modal states
  activeModal: string | null;
  modalData: Record<string, unknown> | null;

  // Loading states
  globalLoading: boolean;
  loadingMessage: string | null;

  // Actions
  openModal: (modalId: string, data?: Record<string, unknown>) => void;
  closeModal: () => void;
  setGlobalLoading: (loading: boolean, message?: string) => void;
}

export const useUIStore = create<UIState>((set) => ({
  // Initial state
  activeModal: null,
  modalData: null,
  globalLoading: false,
  loadingMessage: null,

  // Actions
  openModal: (modalId, data = {}) =>
    set({ activeModal: modalId, modalData: data }),

  closeModal: () => set({ activeModal: null, modalData: null }),

  setGlobalLoading: (loading, message) =>
    set({ globalLoading: loading, loadingMessage: message ?? null }),
}));
