import { useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import {
  BsList,
  BsBell,
  BsPerson,
  BsBoxArrowRight,
  BsTerminal,
  BsGrid,
  BsReception4,
  BsEnvelope,
  BsPhone,
  BsCalendar,
  BsShieldCheck,
  BsShieldLock,
} from 'react-icons/bs';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import clsx from 'clsx';

import { useAuthStore } from '@/store/authStore';
import { useUIStore } from '@/store/uiStore';
import { useAuth } from '@/hooks/useAuth';
import { useRecentAlerts, useAlertsCount } from '@/hooks/useAlerts';
import { usePermissions } from '@/hooks/usePermissions';
import { BrandLogo, TradeChecklistButton } from '@/components/common';
import ThemeToggle from '@/components/ThemeToggle';
import AiAssistantHeaderButton from '@/components/ai/AiAssistantHeaderButton';
import MockSessionHeaderBadge from '@/components/layout/MockSessionHeaderBadge';
import RMSStatusHeaderBadge from '@/components/layout/RMSStatusHeaderBadge';
import HeaderIndexTickers from '@/components/layout/HeaderIndexTickers';
import {
  Badge,
  Dropdown,
  DropdownItem,
  DropdownDivider,
  DropdownHeader,
  Modal,
  Tooltip,
  Checkbox,
} from '@/components/ui';
import type { Tone } from '@/components/ui/Badge';
import { configService } from '@/services/config/configService';
import { emailPreferencesService } from '@/services/admin/v2AdminService';
import type { SystemAlert } from '@/types/common';
import type { UserEmailPreferences, EmailPreferenceCategory } from '@/types/email';

/** Map preference category key → UserEmailPreferences field name */
const PREF_CATEGORY_FIELD_MAP: Record<string, keyof UserEmailPreferences> = {
  daily_report: 'dailyReport',
  risk_alerts: 'riskAlerts',
  trade_notifications: 'tradeNotifications',
  engine_notifications: 'engineNotifications',
  broker_notifications: 'brokerNotifications',
  account_notifications: 'accountNotifications',
};

interface HeaderProps {
  showSidebarToggle?: boolean;
}

// Helper to format timestamp for display
const formatAlertTime = (timestamp: string): string => {
  try {
    // timestamp format: "2025-12-08 15:15:20.905"
    const parts = timestamp.split(' ');
    if (parts.length >= 2) {
      return parts[1].substring(0, 8); // HH:MM:SS
    }
    return timestamp;
  } catch {
    return timestamp;
  }
};

// Map alert level → design-system status tone
const alertTone = (level: string): Tone => {
  switch (level) {
    case 'CRITICAL':
      return 'danger';
    case 'WARNING':
      return 'warning';
    default:
      return 'info';
  }
};
const toneDot: Record<Tone, string> = {
  danger: 'bg-danger-500',
  warning: 'bg-warning-500',
  info: 'bg-primary-500',
  success: 'bg-success-500',
  primary: 'bg-primary-500',
  neutral: 'bg-ink-faint',
  blue: 'bg-blue-500',
};

const Header: React.FC<HeaderProps> = ({ showSidebarToggle = true }) => {
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuthStore();
  const { toggleSidebar } = useUIStore();
  const { logout } = useAuth();
  const { data: alerts, isLoading: isLoadingAlerts } = useRecentAlerts(50);
  const alertCounts = useAlertsCount();
  const { mockTrading: mockTradingPerms } = usePermissions();

  const isTerminalPage = location.pathname === '/terminal-admin';
  const isLiveFeedPage = location.pathname === '/live-feed';

  const { data: buildInfo } = useQuery({
    queryKey: ['build-info'],
    queryFn: () => configService.getBuildInfo(),
    staleTime: Infinity,
  });
  const versionLabel = buildInfo?.core?.version ? `v${buildInfo.core.version}` : null;
  // Use canManageUsers or isSysadmin to determine access to Console/Terminal
  const canAccessConsole = user?.canManageUsers || user?.isSysadmin;
  const queryClient = useQueryClient();

  // Admin profile modal
  const [showProfileModal, setShowProfileModal] = useState(false);

  const { data: emailPrefs, isLoading: prefsLoading } = useQuery({
    queryKey: ['myEmailPreferences'],
    queryFn: () => emailPreferencesService.get(),
    enabled: showProfileModal,
  });

  const { data: availableCategories, isLoading: categoriesLoading } = useQuery({
    queryKey: ['emailPreferenceCategories'],
    queryFn: () => emailPreferencesService.getAvailableCategories(),
    staleTime: 10 * 60 * 1000,
    enabled: showProfileModal,
  });

  const updatePrefsMutation = useMutation({
    mutationFn: (data: Partial<UserEmailPreferences>) => emailPreferencesService.update(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['myEmailPreferences'] });
      toast.success('Notification preferences updated');
    },
    onError: () => {
      toast.error('Failed to update notification preferences');
    },
  });

  const handleProfileClick = () => {
    if (canAccessConsole) {
      setShowProfileModal(true);
    } else {
      navigate('/profile');
    }
  };

  const handleTogglePref = (cat: EmailPreferenceCategory, checked: boolean) => {
    if (!emailPrefs) return;
    const field = PREF_CATEGORY_FIELD_MAP[cat.key];
    if (!field) return;
    updatePrefsMutation.mutate({ ...emailPrefs, [field]: checked });
  };

  const handleLogout = () => logout();

  const getPortalLabel = () => {
    if (!canAccessConsole) return '';
    if (isTerminalPage) return 'Terminal';
    if (isLiveFeedPage) return 'Live Feed';
    return 'Console';
  };

  // Display count: show total alerts count
  const displayCount = alertCounts.total;

  // Dark-header pill toggle (Live Feed / Terminal switchers)
  const pillClass = (active: boolean) =>
    clsx(
      'inline-flex items-center gap-1 rounded-control px-2.5 py-1.5 text-xs font-medium transition-colors',
      active
        ? 'bg-accent-gradient text-white shadow-glow'
        : 'border border-white/20 text-white/80 hover:bg-white/10 hover:text-white',
    );

  return (
    <header className="header">
      {/* Left section */}
      <div className="flex items-center">
        {showSidebarToggle && (
          <button
            className="mr-2 p-1 text-white/80 hover:text-white lg:hidden"
            onClick={toggleSidebar}
            aria-label="Toggle sidebar"
          >
            <BsList size={22} />
          </button>
        )}

        <Link to="/" className="header-brand flex flex-col no-underline">
          <BrandLogo height={36} />
          {versionLabel && (
            <span
              className="hidden md:block text-center text-white/50"
              style={{ fontSize: '0.6rem', marginTop: '2px', letterSpacing: '0.02em' }}
            >
              {versionLabel}
            </span>
          )}
        </Link>

        {/* Live index tickers (NIFTY / SENSEX), always-on /socket "ticks" channel. */}
        <HeaderIndexTickers />

        {/* Trade Checklist */}
        {canAccessConsole && (
          <div className="ml-3 flex items-center gap-2">
            {getPortalLabel() && (
              <span className="hidden md:inline-flex items-center rounded-full bg-white/15 px-2 py-0.5 text-xs font-medium text-white">
                {getPortalLabel()}
              </span>
            )}
            <TradeChecklistButton />
          </div>
        )}
      </div>

      {/* Right section */}
      <div className="ml-auto flex items-center gap-1">
        {/* Light/dark theme toggle (Tailwind design-system widget). */}
        <ThemeToggle className="mr-1" />

        {/* RMS kill-switch indicator (invisible unless rms.enabled === false). */}
        <RMSStatusHeaderBadge />

        {/* Mock-trading session indicator. */}
        <MockSessionHeaderBadge canView={mockTradingPerms.canView} />

        {/* AI assistant (AI_ANALYTICS gated — renders nothing without the tool). */}
        <AiAssistantHeaderButton />

        {/* Alerts */}
        <Dropdown
          align="end"
          menuClassName="w-[26rem]"
          trigger={
            <button
              type="button"
              className="relative p-2 text-white/80 hover:text-white transition-colors"
              aria-label="Alerts"
            >
              <BsBell size={20} />
              {displayCount > 0 && (
                <span
                  className={clsx(
                    'absolute top-0.5 right-0 min-w-[1.05rem] rounded-full px-1 text-center text-[0.65rem] font-semibold text-white',
                    alertCounts.critical > 0 ? 'bg-danger-600' : 'bg-primary-600',
                  )}
                >
                  {displayCount > 99 ? '99+' : displayCount}
                </span>
              )}
            </button>
          }
        >
          <DropdownHeader>
            <span className="inline-flex items-center gap-2">
              System Alerts
              {alertCounts.critical > 0 && <Badge tone="danger">{alertCounts.critical} Critical</Badge>}
            </span>
          </DropdownHeader>
          <div className="max-h-[60vh] overflow-y-auto">
            {isLoadingAlerts ? (
              <div className="px-3 py-2 text-sm text-ink-faint">Loading...</div>
            ) : alerts && alerts.length > 0 ? (
              alerts.slice(0, 10).map((alert: SystemAlert, index: number) => (
                <div
                  key={`${alert.timestamp}-${index}`}
                  className="flex items-start gap-2 px-3 py-2 text-sm"
                >
                  <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${toneDot[alertTone(alert.alertLevel)]}`} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium text-ink">
                        {alert.entityName} - {alert.operation}
                      </span>
                      <span className="shrink-0 text-xs text-ink-faint">{formatAlertTime(alert.timestamp)}</span>
                    </div>
                    <div className="truncate text-xs text-ink-soft">{alert.alertMessage}</div>
                  </div>
                </div>
              ))
            ) : (
              <div className="px-3 py-2 text-sm text-ink-faint">No alerts</div>
            )}
          </div>
          {alerts && alerts.length > 0 && (
            <>
              <DropdownDivider />
              <DropdownItem
                className="justify-center text-primary-500"
                onClick={() => navigate(canAccessConsole ? '/console/alerts' : '/alerts')}
              >
                View All Alerts ({alertCounts.total})
              </DropdownItem>
            </>
          )}
        </Dropdown>

        {canAccessConsole && (
          <Tooltip label={isLiveFeedPage ? 'Switch to Console' : 'Live Feed'}>
            <button
              type="button"
              className={pillClass(isLiveFeedPage)}
              onClick={() => navigate(isLiveFeedPage ? '/console' : '/live-feed')}
            >
              {isLiveFeedPage ? <BsGrid size={14} /> : <BsReception4 size={14} />}
              <span className="hidden md:inline">{isLiveFeedPage ? 'Console' : 'Live Feed'}</span>
            </button>
          </Tooltip>
        )}

        {/* Console/Terminal Toggle - Only for users who can manage users */}
        {canAccessConsole && (
          <Tooltip label={isTerminalPage ? 'Switch to Console' : 'Switch to Terminal'}>
            <button
              type="button"
              className={pillClass(isTerminalPage)}
              onClick={() => navigate(isTerminalPage ? '/console' : '/terminal-admin')}
            >
              {isTerminalPage ? <BsGrid size={14} /> : <BsTerminal size={14} />}
              <span className="hidden md:inline">{isTerminalPage ? 'Console' : 'Terminal'}</span>
            </button>
          </Tooltip>
        )}

        {/* User menu */}
        <Dropdown
          align="end"
          trigger={
            <button type="button" className="flex items-center gap-2 pl-1 text-white/90">
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-accent-gradient text-sm font-semibold text-white">
                {user?.name?.charAt(0).toUpperCase() || <BsPerson size={16} />}
              </div>
              <div className="hidden md:block text-left">
                <div className="text-sm font-medium">{user?.name}</div>
                <div className="text-xs text-white/60">{user?.email}</div>
              </div>
            </button>
          }
        >
          <div className="px-3 py-2 text-sm">
            <div className="font-semibold text-ink">{user?.name}</div>
            <div className="text-ink-soft">{user?.role}</div>
          </div>
          <DropdownDivider />
          <DropdownItem onClick={handleProfileClick}>
            <BsPerson size={16} /> Profile
          </DropdownItem>
          <DropdownDivider />
          <DropdownItem onClick={handleLogout} className="items-start">
            <BsBoxArrowRight size={16} className="mt-0.5 shrink-0" />
            <span>
              <span className="block">Sign Out</span>
            </span>
          </DropdownItem>
        </Dropdown>
      </div>

      {/* Admin Profile Modal */}
      <Modal
        open={showProfileModal}
        onClose={() => setShowProfileModal(false)}
        size="xl"
        title={
          <span className="inline-flex items-center gap-2">
            <BsPerson /> My Profile
          </span>
        }
      >
        {user && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Account Info */}
            <div>
              <div className="mb-4 flex items-center gap-3">
                <div className="flex h-16 w-16 items-center justify-center rounded-full bg-primary-500/10 text-2xl font-semibold text-primary-500">
                  {user.name?.charAt(0).toUpperCase() || 'U'}
                </div>
                <div>
                  <h5 className="font-display text-lg font-semibold text-ink">{user.name}</h5>
                  <div className="text-sm text-ink-faint">@{user.username}</div>
                </div>
              </div>
              <div className="space-y-3 text-sm">
                <div>
                  <div className="mb-0.5 flex items-center gap-1 text-xs text-ink-faint">
                    <BsEnvelope /> Email
                  </div>
                  <div className="text-ink">{user.email}</div>
                </div>
                {user.phone && (
                  <div>
                    <div className="mb-0.5 flex items-center gap-1 text-xs text-ink-faint">
                      <BsPhone /> Phone
                    </div>
                    <div className="text-ink">{user.phone}</div>
                  </div>
                )}
                <div>
                  <div className="mb-0.5 flex items-center gap-1 text-xs text-ink-faint">
                    <BsShieldLock /> Role
                  </div>
                  <Badge tone="danger">{user.role || user.roleCode}</Badge>
                </div>
                {user.createdAt && (
                  <div>
                    <div className="mb-0.5 flex items-center gap-1 text-xs text-ink-faint">
                      <BsCalendar /> Member Since
                    </div>
                    <div className="text-ink">
                      {new Date(user.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}
                    </div>
                  </div>
                )}
                {user.lastLogin && (
                  <div>
                    <div className="mb-0.5 flex items-center gap-1 text-xs text-ink-faint">
                      <BsShieldCheck /> Last Login
                    </div>
                    <div className="text-ink">
                      {new Date(user.lastLogin).toLocaleString('en-IN', {
                        day: 'numeric',
                        month: 'short',
                        year: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Email Notification Preferences */}
            <div className="rounded-card border border-hairline">
              <div className="border-b border-hairline px-4 py-3 text-sm font-semibold text-ink">
                Email Notification Preferences
              </div>
              <div className="p-4">
                {prefsLoading || categoriesLoading ? (
                  <div className="py-3 text-center text-sm text-ink-faint">Loading…</div>
                ) : availableCategories && availableCategories.length > 0 && emailPrefs ? (
                  <div className="space-y-3">
                    {availableCategories.map((cat) => {
                      const field = PREF_CATEGORY_FIELD_MAP[cat.key];
                      if (!field) return null;
                      const checked = (emailPrefs[field] as boolean) || false;
                      return (
                        <div key={cat.key}>
                          <Checkbox
                            label={cat.label}
                            checked={checked}
                            disabled={updatePrefsMutation.isPending}
                            onChange={(e) => handleTogglePref(cat, e.target.checked)}
                          />
                          <p className="ml-6 text-xs text-ink-faint">{cat.description}</p>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="text-sm text-ink-faint">No email notification categories available.</div>
                )}
              </div>
            </div>
          </div>
        )}
      </Modal>
    </header>
  );
};

export default Header;
