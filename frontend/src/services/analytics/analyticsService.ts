import { api } from '@/api/client';
import type { AnalyticsAnswer, AnalyticsOptions, AnalyticsQuestion } from '@/types/analytics';

const BASE = '/api/analytics';

export const analyticsService = {
  getOptions: () => api.get<AnalyticsOptions>(`${BASE}/options`),
  ask: (question: AnalyticsQuestion) =>
    api.get<AnalyticsAnswer>(
      `${BASE}/query`,
      Object.fromEntries(Object.entries(question).filter(([, v]) => v !== undefined && v !== '')),
    ),
};
