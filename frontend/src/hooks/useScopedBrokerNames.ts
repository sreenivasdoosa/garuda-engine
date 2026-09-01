import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';

import { v2BrokerService } from '@/services/admin/v2AdminService';

/**
 * The brokers this engine knows about.
 *
 * The engine this was copied from narrowed the list to the brokers a user was
 * scoped to. There is one operator here and every account is theirs, so the
 * list is simply the list.
 */
export function useScopedBrokerNames(): string[] {
  const { data: brokers } = useQuery({
    queryKey: ['admin', 'brokers'],
    queryFn: () => v2BrokerService.getAll(),
    staleTime: 5 * 60 * 1000,
  });

  return useMemo(
    () => Array.from(new Set((brokers || []).map((b) => b.name).filter(Boolean))).sort() as string[],
    [brokers],
  );
}
