/**
 * AlertNotifications Component
 * Displays real-time alert notifications in bottom-right corner.
 * Migrated to the Tailwind design system (tokens +  prefix). The companion
 * AlertNotifications.scss still provides container positioning + slide-in.
 */

import React from 'react';
import { BsExclamationTriangleFill, BsExclamationCircleFill, BsInfoCircleFill } from 'react-icons/bs';
import { useAlertNotifications, AlertNotification } from '@/hooks/useAlertNotifications';

import './AlertNotifications.scss';

interface AlertNotificationsProps {
  /** Enable the notifications system */
  enabled?: boolean;
  /** Max notifications to show */
  maxNotifications?: number;
  /** Auto-dismiss time in ms */
  autoDismissMs?: number;
  /** Play sound on new alert */
  playSound?: boolean;
}

// OPAQUE cards: solid bg-card base with the level tint layered via a uniform
// gradient (background-image composites OVER background-color) — a bare /10
// tint alone is see-through and unreadable on top of page content. Thick
// colored left border marks the level (Bootstrap-alert-era look).
const levelStyles: Record<string, { box: string; icon: string }> = {
  CRITICAL: { box: 'border-danger-500/40 bg-card bg-gradient-to-r from-danger-500/10 to-danger-500/10 border-l-4 border-l-danger-500', icon: 'text-danger-500' },
  WARNING: { box: 'border-warning-500/40 bg-card bg-gradient-to-r from-warning-500/10 to-warning-500/10 border-l-4 border-l-warning-500', icon: 'text-warning-500' },
  INFO: { box: 'border-accent-500/40 bg-card bg-gradient-to-r from-accent-500/10 to-accent-500/10 border-l-4 border-l-accent-500', icon: 'text-accent-500' },
};
const styleFor = (level: string) => levelStyles[level] ?? levelStyles.INFO;

const getAlertIcon = (level: string): React.ReactNode => {
  switch (level) {
    case 'CRITICAL':
      return <BsExclamationTriangleFill className={`mr-2 shrink-0 ${styleFor(level).icon}`} />;
    case 'WARNING':
      return <BsExclamationCircleFill className={`mr-2 shrink-0 ${styleFor(level).icon}`} />;
    case 'INFO':
    default:
      return <BsInfoCircleFill className={`mr-2 shrink-0 ${styleFor('INFO').icon}`} />;
  }
};

const formatTimestamp = (timestamp: string): string => {
  try {
    // Timestamp format: "2025-12-10 14:30:45.123"
    const parts = timestamp.split(' ');
    if (parts.length >= 2) {
      return parts[1].substring(0, 8); // HH:mm:ss
    }
    return timestamp;
  } catch {
    return timestamp;
  }
};

const SingleNotification: React.FC<{
  notification: AlertNotification;
  onDismiss: (id: string) => void;
}> = ({ notification, onDismiss }) => {
  const icon = getAlertIcon(notification.alertLevel);

  return (
    <div className={`alert-notification animate-slide-in mb-2 rounded-card border p-3 shadow-lg ${styleFor(notification.alertLevel).box}`}>
      <div className="flex items-start">
        <div className="min-w-0 flex-grow">
          <div className="mb-1 flex items-center">
            {icon}
            <strong className="mr-2 text-ink">{notification.alertLevel}</strong>
            <small className="text-ink-faint">{formatTimestamp(notification.timestamp)}</small>
          </div>
          <div>
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-raised px-2 py-0.5 text-xs text-ink-soft">{notification.entityType}</span>
              <span className="font-medium text-ink">{notification.entityName}</span>
              {notification.operation && <span className="text-xs text-ink-faint">({notification.operation})</span>}
            </div>
            <div className="text-sm text-ink-soft">{notification.alertMessage}</div>
          </div>
        </div>
        <button
          type="button"
          onClick={() => onDismiss(notification.id)}
          aria-label="Dismiss"
          className="ml-2 shrink-0 rounded p-1 text-lg leading-none text-ink-faint hover:bg-raised hover:text-ink"
        >
          ×
        </button>
      </div>
    </div>
  );
};

const AlertNotifications: React.FC<AlertNotificationsProps> = ({
  enabled = true,
  maxNotifications = 5,
  autoDismissMs = 10000,
  playSound = true,
}) => {
  const { notifications, dismissNotification, dismissAll } = useAlertNotifications({
    enabled,
    maxNotifications,
    autoDismissMs,
    playSound,
  });

  if (notifications.length === 0) {
    return null;
  }

  return (
    <div className="alert-notifications-container">
      {notifications.length > 1 && (
        <div className="dismiss-all-wrapper mb-1 flex justify-end">
          <button
            type="button"
            className="rounded-control border border-hairline bg-card px-2 py-1 text-xs text-ink-soft hover:bg-raised hover:text-ink"
            onClick={dismissAll}
          >
            Dismiss All ({notifications.length})
          </button>
        </div>
      )}
      {notifications.map((notification, index) => (
        <div key={notification.id} className={`alert-notification-wrapper ${index === 0 ? 'front' : 'stacked'}`}>
          <SingleNotification notification={notification} onDismiss={dismissNotification} />
        </div>
      ))}
    </div>
  );
};

export default AlertNotifications;
