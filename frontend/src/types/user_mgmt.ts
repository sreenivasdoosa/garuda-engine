/**
 * User Management type definitions
 * Covers User, User Broker, User Strategy, User Capital, and User Manager mappings
 * Matches: UserDetails.java, UserBrokerDetails.java, UserStrategyDetails.java
 */

// ==================== USER ====================

// User status constants
export const UserStatus = {
  ACTIVE: 'ACTIVE',
  SUSPENDED: 'SUSPENDED',
  CLOSED: 'CLOSED',
  PENDING_SETUP: 'PENDING_SETUP',
} as const;

export type UserStatusType = typeof UserStatus[keyof typeof UserStatus];

export interface User {
  username: string;
  // Auth service fields (from /api/admin/users)
  fullName?: string; // From auth service - replaces firstname+lastname
  email: string;
  phone?: string;
  roleCode?: string; // Original role code from auth service (ADMIN, MANAGER, USER, etc.)
  roleName?: string; // Display name for role
  roleHierarchyLevel?: number; // Role hierarchy level for access control
  isSysadmin?: boolean; // System admin flag
  isEmailVerified?: boolean;
  authLastLoginAt?: string; // Last login timestamp from auth service
  authCreatedAt?: string; // User created timestamp from auth service
  // Legacy/backward compatibility fields
  role: string; // Mapped from roleCode
  name?: string; // Alias for fullName (backward compatibility)
  alias?: string;
  // Core trading fields
  status: UserStatusType; // ACTIVE, SUSPENDED, CLOSED
  disabledReason?: string; // Reason for suspension
  isPrepaidBilling: boolean; // Note: API returns 'isPrepaidBilling'
  prepaidMode?: boolean; // Alias for backward compatibility
  autoLogin: boolean; // Auto login enabled for user
  maxAllowedCapital: number; // Maximum allowed capital for user
  billingPlan?: string;
  enabledExchanges?: string[];
  referralCode?: string;
  clientManager?: string; // Note: API returns 'clientManager' not 'managedBy'
  managedBy?: string; // Alias for backward compatibility
  createdAt?: string; // Note: API returns ISO timestamp string
  lastUpdatedAt?: string; // Note: API returns ISO timestamp string
  // Populated by server - user's brokers
  brokers?: UserBrokerConfig[];
}

export interface CreateUserRequest {
  username: string;
  fullName: string; // Full name (replaces firstname+lastname)
  alias?: string;
  email: string;
  phone?: string;
  password: string;
  roleCode?: string; // Role code from auth service
  isPrepaidBilling?: boolean;
  maxAllowedCapital?: number;
  billingPlan?: string;
  enabledExchanges?: string[];
  referralCode?: string;
}

export interface UpdateUserRequest {
  fullName?: string; // Full name (replaces firstname+lastname)
  alias?: string;
  email?: string;
  phone?: string;
  roleCode?: string; // Role code from auth service
  isPrepaidBilling?: boolean;
  autoLogin?: boolean;
  maxAllowedCapital?: number;
  billingPlan?: string;
  enabledExchanges?: string[];
}

// ==================== USER BROKER ====================

export interface UserBrokerConfig {
  username: string;
  broker: string;
  brokeragePlan?: string;
  isPro: boolean;
  clientID: string;
  // Sensitive fields: clientPassword, clientPIN are never returned
  // totpKey and appSecret are returned for UI editing
  appKey?: string;
  appSecret?: string;
  totpKey?: string;
  panOrDOB?: string;
  autoLogin: boolean;
  enabled: boolean;
  seatAssigned: boolean;
  licenseKey?: string;
  loginVerified: boolean;
  useApiOf?: string;
  allocationModel?: string;
  // Capital allocation fields (user-broker level)
  allocatedCapital?: number;
  allocatedExternalIntradayCapital?: number;
  allocatedExternalPositionalCapital?: number;
  xtremeAgentUrl?: string;
  xtremeAgentBypass: boolean;
  webSocketEnabled: boolean;
  // Per-user override of broker.useDealerAPIs.
  // null/undefined = inherit broker setting; true/false = explicit override.
  useDealerAPIs?: boolean | null;
}

export interface CreateUserBrokerRequest {
  broker: string;
  clientID: string;
  clientPassword?: string;
  clientPIN?: string;
  totpKey?: string;
  panOrDOB?: string;
  appKey?: string;
  appSecret?: string;
  autoLogin?: boolean;
  brokeragePlan?: string;
  allocationModel?: string;
  // Capital allocation fields (user-broker level)
  allocatedCapital?: number;
  allocatedExternalIntradayCapital?: number;
  allocatedExternalPositionalCapital?: number;
  useApiOf?: string;
  isPro?: boolean;
  xtremeAgentUrl?: string;
  xtremeAgentBypass?: boolean;
  webSocketEnabled?: boolean;
  useDealerAPIs?: boolean | null;
}

export interface UpdateUserBrokerRequest extends Partial<CreateUserBrokerRequest> {}

// ==================== USER CAPITAL ====================

export interface UserCapitalMap {
  username: string;
  broker: string;
  strategy: string;
  capital: number;
  capitalType: 'FIXED' | 'PERCENTAGE';
  effectiveDate: string;
  createdAt: string;
}

export interface CreateUserCapitalRequest {
  username: string;
  broker: string;
  strategy: string;
  capital: number;
  capitalType: 'FIXED' | 'PERCENTAGE';
  effectiveDate: string;
}

// ==================== USER MARGIN ====================

export interface UserMargin {
  username: string;
  broker: string;
  date: string;
  availableMargin: number;
  usedMargin: number;
  totalMargin: number;
  marginUtilization: number;
}
