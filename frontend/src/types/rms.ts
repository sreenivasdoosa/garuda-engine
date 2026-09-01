/**
 * Risk Management System (RMS) type definitions
 *
 * Note: The new hierarchical RMS system types are defined in:
 * - src/services/admin/v2AdminService.ts (RMSConfig, RMSBreachLog, etc.)
 *
 * Old RMS types (RMSParam, UserRMSParam, RMSStats) have been removed
 * as part of the RMS system migration.
 */

// Re-export RMS types from v2AdminService for convenience
export type { RMSConfig, RMSBreachLog, KillSwitchStatus } from '@/services/admin/v2AdminService';
