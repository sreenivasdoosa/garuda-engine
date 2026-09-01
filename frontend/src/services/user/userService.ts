import { api } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';
import type {
  User,
  UserNote,
  UserAlert,
  UserPayment,
  UserPlan,
  ChangePasswordRequest,
  UpdateProfileRequest,
} from '@/types/user';

// The new backend sends note dates as 'yyyy-MM-dd' strings; an older backend
// serialized the DATE as epoch millis (Instant via the V2 mapper). Normalize so
// the UI renders and date-matches correctly against either build.
const normalizeUserNote = (note: UserNote): UserNote => {
  const raw = note.date as unknown;
  if (typeof raw === 'number') {
    const d = new Date(raw);
    const pad = (n: number) => String(n).padStart(2, '0');
    return { ...note, date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` };
  }
  return note;
};

export const userService = {
  /**
   * Get current user details
   */
  async getDetails(): Promise<User> {
    return api.get<User>(API_ENDPOINTS.USER.DETAILS);
  },

  /**
   * Update user profile
   */
  async updateProfile(data: UpdateProfileRequest): Promise<User> {
    return api.put<User>(API_ENDPOINTS.USER.DETAILS, data);
  },

  /**
   * Change user password
   */
  async changePassword(data: ChangePasswordRequest): Promise<{ success: boolean; message: string }> {
    return api.put(API_ENDPOINTS.USER.PASSWORD, data);
  },

  /**
   * Close/delete user account
   */
  async closeAccount(username: string): Promise<{ success: boolean }> {
    return api.delete(API_ENDPOINTS.USER.DETAILS, { username });
  },

  /**
   * All notes for one user (newest first). Server enforces per-user access
   * (403 unless admin / self / supervised user) + USER_NOTES View right.
   */
  async getNotes(username: string): Promise<UserNote[]> {
    const list = await api.get<UserNote[]>(`${API_ENDPOINTS.USER.NOTES}/${encodeURIComponent(username)}`);
    return list.map(normalizeUserNote);
  },

  /**
   * Recent notes across the requester's AUTHORIZED users (admin = all) —
   * the server returns the last 3 notes PER USER (window query); backs the
   * User Notes page overview.
   */
  async getRecentNotesAllUsers(): Promise<UserNote[]> {
    const list = await api.get<UserNote[]>(API_ENDPOINTS.USER.NOTES);
    return list.map(normalizeUserNote);
  },

  /**
   * Create OR update the note for a day (server upsert — one note per user
   * per day, PK username+date). Requires USER_NOTES Edit.
   */
  async upsertNote(username: string, date: string, notes: string): Promise<void> {
    return api.put(`${API_ENDPOINTS.USER.NOTES}/${encodeURIComponent(username)}`, { date, notes });
  },

  /**
   * Delete the note for a day. Requires USER_NOTES Manage.
   */
  async deleteNote(username: string, date: string): Promise<void> {
    return api.delete(`${API_ENDPOINTS.USER.NOTES}/${encodeURIComponent(username)}`, { date });
  },

  /**
   * Get user alerts
   */
  async getAlerts(): Promise<UserAlert[]> {
    return api.get<UserAlert[]>(API_ENDPOINTS.USER.ALERTS);
  },

  /**
   * Mark alert as read
   */
  async markAlertRead(alertId: string): Promise<{ success: boolean }> {
    return api.put(`${API_ENDPOINTS.USER.ALERTS}/${alertId}/read`, {});
  },

  /**
   * Get user payments
   */
  async getPayments(): Promise<UserPayment[]> {
    return api.get<UserPayment[]>(API_ENDPOINTS.USER.PAYMENTS);
  },

  /**
   * Get user plans
   */
  async getPlans(): Promise<UserPlan[]> {
    return api.get<UserPlan[]>(API_ENDPOINTS.USER.PLANS);
  },
};
