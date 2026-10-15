import { api } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';
import type {
  DayAllocation,
  EngineMonitor,
  NewSubscription,
  StrategyCatalog,
  StrategyDefinitionEdit,
  StrategyDefinitionLive,
  StrategyRulesEdit,
  StrategyRulesLive,
  SubscriptionEdit,
  SubscriptionLive,
} from '@/types/strategy-live';

const E = API_ENDPOINTS.STRATEGIES;

/** Strategies as garuda serves them. Keyed by trading client, never by user. */
export const strategyLiveService = {
  catalog: () => api.get<StrategyCatalog>(E.CATALOG),

  definitions: () => api.get<StrategyDefinitionLive[]>(E.DEFINITIONS),
  definition: (id: number) => api.get<StrategyDefinitionLive>(E.DEFINITION(id)),
  createDefinition: (data: StrategyDefinitionEdit) =>
    api.post<StrategyDefinitionLive>(E.DEFINITIONS, data),
  updateDefinition: (id: number, data: StrategyDefinitionEdit) =>
    api.put<StrategyDefinitionLive>(E.DEFINITION(id), data),
  changeStatus: (id: number, status: string) =>
    api.put<StrategyDefinitionLive>(E.STATUS(id, status), {}),
  deleteDefinition: (id: number) => api.delete(E.DEFINITION(id)),

  rules: (name: string) => api.get<StrategyRulesLive>(E.RULES(name)),
  saveRules: (name: string, data: StrategyRulesEdit) =>
    api.put<StrategyRulesLive>(E.RULES(name), data),

  subscriptions: () => api.get<SubscriptionLive[]>(E.SUBSCRIPTIONS),
  subscribe: (data: NewSubscription) => api.post<SubscriptionLive>(E.SUBSCRIPTIONS, data),
  updateSubscription: (id: number, data: SubscriptionEdit) =>
    api.put<SubscriptionLive>(E.SUBSCRIPTION(id), data),
  activate: (id: number) => api.put<SubscriptionLive>(E.ACTIVATE(id), {}),
  deactivate: (id: number) => api.put<SubscriptionLive>(E.DEACTIVATE(id), {}),
  unsubscribe: (id: number) => api.delete(E.SUBSCRIPTION(id)),

  monitor: () => api.get<EngineMonitor>(E.MONITOR),
  dayAllocation: (name: string) => api.get<DayAllocation>(E.DAY_ALLOCATION(name)),
  saveDayAllocation: (name: string, data: Omit<DayAllocation, 'strategyName'>) =>
    api.put<DayAllocation>(E.DAY_ALLOCATION(name), data),
};
