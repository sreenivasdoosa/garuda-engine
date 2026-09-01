import { create } from 'zustand';

interface UIState {
  // Sidebar state
  sidebarOpen: boolean;
  sidebarCollapsed: boolean;

  // Modal states
  activeModal: string | null;
  modalData: Record<string, unknown> | null;

  // Loading states
  globalLoading: boolean;
  loadingMessage: string | null;

  // Actions
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  openModal: (modalId: string, data?: Record<string, unknown>) => void;
  closeModal: () => void;
  setGlobalLoading: (loading: boolean, message?: string) => void;
}

export const useUIStore = create<UIState>((set) => ({
  // Initial state
  sidebarOpen: true,
  sidebarCollapsed: false,
  activeModal: null,
  modalData: null,
  globalLoading: false,
  loadingMessage: null,

  // Actions
  toggleSidebar: () =>
    set((state) => ({ sidebarOpen: !state.sidebarOpen })),

  setSidebarOpen: (open) => set({ sidebarOpen: open }),

  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),

  openModal: (modalId, data = {}) =>
    set({ activeModal: modalId, modalData: data }),

  closeModal: () => set({ activeModal: null, modalData: null }),

  setGlobalLoading: (loading, message) =>
    set({ globalLoading: loading, loadingMessage: message ?? null }),
}));
