import { api } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';
import type {
  ConfigCatalog,
  ConfigEdit,
  ConfigRow,
  ConfiguredStrategy,
  EffectiveConfig,
} from '@/types/strategy-config-live';

const E = API_ENDPOINTS.STRATEGY_CONFIG_TREE;

export const strategyConfigLiveService = {
  catalog: () => api.get<ConfigCatalog>(E.CATALOG),
  strategies: () => api.get<ConfiguredStrategy[]>(E.STRATEGY_NAMES),
  rows: (strategyName: string) => api.get<ConfigRow[]>(E.BY_STRATEGY(strategyName)),
  exists: (strategyName: string, tranchNumber: number | null, dayCondition: string | null) =>
    api.get<{ exists: boolean; id: number | null }>(E.EXISTS, {
      strategyName,
      ...(tranchNumber !== null ? { tranchNumber } : {}),
      ...(dayCondition ? { dayCondition } : {}),
    }),
  effective: (strategyName: string, tranchNumber: number, dayConditions: string[]) =>
    api.get<EffectiveConfig>(E.EFFECTIVE, {
      strategyName,
      tranchNumber,
      ...(dayConditions.length ? { dayCondition: dayConditions.join(',') } : {}),
    }),
  create: (data: ConfigEdit) => api.post<ConfigRow>(E.BASE, data),
  update: (id: number, data: ConfigEdit) => api.put<ConfigRow>(E.DETAILS(id), data),
  remove: (id: number) => api.delete(E.DETAILS(id)),
};
