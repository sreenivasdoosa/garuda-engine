import { api } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';
import type { HealthCheck, InitTimeline, SystemStatus } from '@/types/systemStatus';

const E = API_ENDPOINTS.SYSTEM_STATUS;

export const systemStatusService = {
  /** The whole page in one read. Cheap: in-memory except the counts. */
  getStatus: () => api.get<SystemStatus>(E.STATUS),

  /** A tick read and a history round-trip. Costs the network; on demand only. */
  runHealthCheck: () => api.get<HealthCheck>(E.HEALTH_CHECK),

  /** What starting up and starting the day did, newest first. */
  getInitTimeline: () => api.get<InitTimeline>(E.INIT_TIMELINE),
};
