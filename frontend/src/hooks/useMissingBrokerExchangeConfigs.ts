import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { v2BrokerService, brokerExchangeConfigService, exchangeService } from '@/services/admin/v2AdminService';

export interface MissingConfig {
  exchange: string;
  brokers: string[];
}

/**
 * Computes which active exchanges are missing broker exchange configs for enabled brokers.
 * Returns a list of { exchange, brokers[] } entries.
 */
export const useMissingBrokerExchangeConfigs = () => {
  const { data: brokers } = useQuery({
    queryKey: ['brokers'],
    queryFn: () => v2BrokerService.getAll(),
    staleTime: 10 * 60 * 1000,
  });

  const { data: exchanges } = useQuery({
    queryKey: ['admin', 'exchanges'],
    queryFn: () => exchangeService.getAll(),
    staleTime: 10 * 60 * 1000,
  });

  const { data: configs } = useQuery({
    queryKey: ['admin', 'brokerExchangeConfigs'],
    queryFn: () => brokerExchangeConfigService.getAll(),
    staleTime: 10 * 60 * 1000,
  });

  const missingConfigs = useMemo((): MissingConfig[] => {
    if (!brokers || !exchanges || !configs) return [];

    const enabledBrokers = brokers.filter((b) => b.enabled);
    const activeExchanges = exchanges.filter((e) => e.isActive);

    if (enabledBrokers.length === 0 || activeExchanges.length === 0) return [];

    // Build a set of existing configs for quick lookup: "brokerName|exchangeCode"
    const configSet = new Set(configs.map((c) => `${c.brokerName}|${c.exchangeCode}`));

    const result: MissingConfig[] = [];
    for (const exchange of activeExchanges) {
      const missing = enabledBrokers
        .filter((b) => !configSet.has(`${b.name}|${exchange.exchange}`))
        .map((b) => b.name);
      if (missing.length > 0) {
        result.push({ exchange: exchange.exchange, brokers: missing });
      }
    }
    return result;
  }, [brokers, exchanges, configs]);

  return missingConfigs;
};
