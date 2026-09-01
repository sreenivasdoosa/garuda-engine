/**
 * ConnectionStatus Component
 * Displays WebSocket connection status. Tailwind design system.
 */

import React from 'react';
import { BsWifi, BsWifiOff } from 'react-icons/bs';
import { Spinner } from '@/components/ui';

interface ConnectionStatusProps {
  isConnected: boolean;
  isConnecting: boolean;
  reconnectAttempts?: number;
  onReconnect?: () => void;
}

const pill = 'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium';

const ConnectionStatus: React.FC<ConnectionStatusProps> = ({ isConnected, isConnecting, reconnectAttempts = 0, onReconnect }) => {
  if (isConnecting) {
    return (
      <span className={`${pill} gap-2 bg-warning-500/15 text-warning-600 dark:text-warning-400`}>
        <Spinner size="sm" />
        <span>Connecting{reconnectAttempts > 0 ? ` (${reconnectAttempts})` : ''}...</span>
      </span>
    );
  }

  if (isConnected) {
    return (
      <span className={`${pill} bg-success-500/15 text-success-700 dark:text-success-400`}>
        <BsWifi size={14} />
        <span>Live</span>
      </span>
    );
  }

  return (
    <span
      className={`${pill} bg-danger-500/15 text-danger-600 dark:text-danger-400`}
      style={{ cursor: onReconnect ? 'pointer' : 'default' }}
      onClick={onReconnect}
    >
      <BsWifiOff size={14} />
      <span>{onReconnect ? 'Reconnect' : 'Disconnected'}</span>
    </span>
  );
};

export default ConnectionStatus;
