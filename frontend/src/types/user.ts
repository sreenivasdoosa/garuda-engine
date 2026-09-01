/**
 * The operator. There is one, and they own every account on this engine, so
 * there are no rights, no role hierarchy and no admin flag -- signing in is
 * the whole of the authorization model.
 */
export interface User {
  id: string;
  username: string;
  email: string;
  name: string;
  phone?: string;
  role?: string;      // Alias for roleCode
  roleCode?: string;  // Role code from auth service (e.g., 'ADMIN', 'MANAGER', 'USER')
  brokers: UserBroker[];
  isActive: boolean;
  createdAt?: string;  // Optional - auth service may not provide this
  updatedAt?: string;
  lastLogin?: string;
  settings?: UserSettings;
}

export interface UserBroker {
  id: string;
  broker: string;
  brokerName: string;
  clientId: string;
  isActive: boolean;
  loginStatus: 'logged_in' | 'logged_out' | 'error' | 'pending';
  lastLoginAt?: string;
  errorMessage?: string;
}

export interface UserSettings {
  notifications: {
    email: boolean;
    sms: boolean;
    push: boolean;
  };
  tradingPreferences: {
    autoLogin: boolean;
    soundAlerts: boolean;
  };
}

// Matches the server model (USER_NOTES table): ONE note per user per DAY —
// PK (username, date), PUT is an upsert. date is 'yyyy-MM-dd'.
export interface UserNote {
  username: string;
  date: string;
  notes: string;
  /** Admin who last created/updated the note (null on pre-audit rows). */
  lastUpdatedBy?: string | null;
  /** 'yyyy-MM-dd HH:mm:ss' of the last change (DB-maintained). */
  lastUpdatedAt?: string | null;
}

export interface UserAlert {
  id: string;
  userId: string;
  level: 'CRITICAL' | 'WARNING' | 'INFO';
  title: string;
  message: string;
  isRead: boolean;
  createdAt: string;
}

export interface UserPayment {
  id: string;
  userId: string;
  amount: number;
  currency: string;
  status: 'pending' | 'completed' | 'failed' | 'refunded';
  paymentMethod: string;
  transactionId?: string;
  createdAt: string;
}

export interface UserPlan {
  id: string;
  userId: string;
  planId: string;
  planName: string;
  status: 'active' | 'expired' | 'cancelled';
  startDate: string;
  endDate: string;
  features: string[];
}

export interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}

export interface UpdateProfileRequest {
  name?: string;
  email?: string;
  phone?: string;
  settings?: Partial<UserSettings>;
}
