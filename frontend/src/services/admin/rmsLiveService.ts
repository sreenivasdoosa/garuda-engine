import { api } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';
import type {
  Breach,
  BreachFilters,
  BreachPage,
  EffectiveRisk,
  KillSwitchEntry,
  KillSwitchRequest,
  KillSwitchStatus,
  RiskCatalog,
  RiskEdit,
  RiskRow,
  RiskStatus,
} from '@/types/rms-live';

const E = API_ENDPOINTS.RMS;

export interface BreachQuery {
  page: number;
  pageSize: number;
  tradingClientId?: string;
  type?: string;
  category?: string;
  severity?: string;
  startDate?: string;
  endDate?: string;
  search?: string;
}

export const rmsLiveService = {
  catalog: () => api.get<RiskCatalog>(E.CATALOG),
  status: () => api.get<RiskStatus>(E.STATUS),
  rows: () => api.get<RiskRow[]>(E.LIST),
  effective: (params: {
    segmentType?: string;
    exchange?: string;
    symbol?: string;
    tradingClientId?: string;
  }) =>
    api.get<EffectiveRisk>(
      E.EFFECTIVE,
      Object.fromEntries(Object.entries(params).filter(([, v]) => v)),
    ),
  create: (data: RiskEdit) => api.post<RiskRow>(E.LIST, data),
  update: (id: number, data: RiskEdit) => api.put<RiskRow>(E.DETAILS(id), data),
  remove: (id: number) => api.delete(E.DETAILS(id)),

  breachFilters: () => api.get<BreachFilters>(E.BREACH_FILTERS),
  breachesToday: () => api.get<Breach[]>(E.BREACHES_TODAY),
  breaches: (query: BreachQuery) =>
    api.get<BreachPage>(
      E.BREACHES,
      Object.fromEntries(Object.entries(query).filter(([, v]) => v !== undefined && v !== '')),
    ),

  killSwitches: () => api.get<KillSwitchStatus>(E.KILL_SWITCH),
  activate: (request: KillSwitchRequest) => api.post<KillSwitchEntry>(E.KILL_SWITCH, request),
  deactivate: (keys: string[]) =>
    api.post<{ deactivated: string[]; unknown: string[] }>(E.KILL_SWITCH_DEACTIVATE, { keys }),
  removeSwitches: (keys: string[]) =>
    api.post<{ removed: string[]; unknown: string[] }>(E.KILL_SWITCH_REMOVE, { keys }),
  removeAllSwitches: () => api.post<{ removed: string[] }>(E.KILL_SWITCH_REMOVE_ALL, {}),
  setSource: (source: string, enabled: boolean, alsoRemoveInstances: boolean) =>
    api.post<{ source: string; enabled: boolean; instancesRemoved: number }>(E.KILL_SWITCH_TYPE, {
      source,
      enabled,
      alsoRemoveInstances,
    }),
};
