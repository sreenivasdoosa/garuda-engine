import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuthStore } from '@/store/authStore';
import { v2BrokerService, userManagementService } from '@/services/admin/v2AdminService';

/**
 * Broker names the current admin-console user may filter by:
 * - admin / full-access (sysadmin || canManageRights) → the full broker catalog;
 * - a non-admin supervisor (e.g. Portfolio Manager) → only the brokers their OWN (server-scoped)
 *   users actually use, so a filter dropdown can't expose brokers outside their assignment.
 *
 * Each branch fetches only its own source (the catalog for admins, the scoped user list for
 * supervisors). QUANT-188. Returns a sorted, de-duplicated list of broker names.
 */
export function useScopedBrokerNames(): string[] {
  const { user } = useAuthStore();
  const isFullAccess = !!(user?.isSysadmin || user?.canManageRights);

  const { data: allBrokers } = useQuery({
    queryKey: ['admin', 'brokers'],
    queryFn: () => v2BrokerService.getAll(),
    enabled: isFullAccess,
    staleTime: 5 * 60 * 1000,
  });

  const { data: scopedUsers } = useQuery({
    queryKey: ['admin', 'users', 'broker-scope'],
    queryFn: () => userManagementService.getUsers(),
    enabled: !isFullAccess,
    staleTime: 5 * 60 * 1000,
  });

  return useMemo(() => {
    if (isFullAccess) {
      return Array.from(new Set((allBrokers || []).map((b) => b.name).filter(Boolean))).sort();
    }
    const set = new Set<string>();
    (scopedUsers || []).forEach((u) =>
      (u.brokers || []).forEach((b) => { if (b.broker) set.add(b.broker); }));
    return Array.from(set).sort();
  }, [isFullAccess, allBrokers, scopedUsers]);
}
