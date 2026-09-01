/**
 * useAlertNotifications Hook
 * Listens for alerts via WebSocket and manages notification state
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { useWebSocket } from './useWebSocket';
import { triggerAlertRefresh } from './useAlerts';
import type { AlertData, TerminalWebSocketMessage } from '@/types/terminal';

const MAX_VISIBLE_NOTIFICATIONS = 5;
const NOTIFICATION_AUTO_DISMISS_MS = 10000; // 10 seconds

export interface AlertNotification extends AlertData {
  id: string;
  receivedAt: number;
}

interface UseAlertNotificationsOptions {
  /** Enable WebSocket connection for alerts */
  enabled?: boolean;
  /** Max notifications to show at once */
  maxNotifications?: number;
  /** Auto-dismiss time in ms (0 = no auto-dismiss) */
  autoDismissMs?: number;
  /** Play sound on new alert */
  playSound?: boolean;
}

interface UseAlertNotificationsReturn {
  notifications: AlertNotification[];
  dismissNotification: (id: string) => void;
  dismissAll: () => void;
  isConnected: boolean;
}

// Sound file path - using a simple notification sound
// If this file doesn't exist, Web Audio API will be used as fallback
const ALERT_SOUND_URL = '/sounds/alert.mp3';

/**
 * Play a beep sound using Web Audio API (fallback when audio file not available)
 */
const playBeepWithWebAudio = () => {
  try {
    const audioContext = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);

    oscillator.frequency.value = 800; // Frequency in Hz
    oscillator.type = 'sine';
    gainNode.gain.value = 0.3;

    oscillator.start();

    // Fade out
    gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.3);

    oscillator.stop(audioContext.currentTime + 0.3);
  } catch (err) {
    console.debug('[AlertNotifications] Could not play beep sound:', err);
  }
};

export const useAlertNotifications = (
  options: UseAlertNotificationsOptions = {}
): UseAlertNotificationsReturn => {
  const {
    enabled = true,
    maxNotifications = MAX_VISIBLE_NOTIFICATIONS,
    autoDismissMs = NOTIFICATION_AUTO_DISMISS_MS,
    playSound = true,
  } = options;

  const [notifications, setNotifications] = useState<AlertNotification[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioLoadedRef = useRef(false);
  const notificationIdCounter = useRef(0);
  const lastSoundPlayedRef = useRef(0);
  const SOUND_THROTTLE_MS = 2000; // Max one sound per 2 seconds during floods

  // Initialize audio element
  useEffect(() => {
    if (playSound && typeof window !== 'undefined') {
      const audio = new Audio(ALERT_SOUND_URL);
      audio.volume = 0.5;

      // Check if audio file loads successfully
      audio.addEventListener('canplaythrough', () => {
        audioLoadedRef.current = true;
      });
      audio.addEventListener('error', () => {
        audioLoadedRef.current = false;
        console.debug('[AlertNotifications] Audio file not found, will use Web Audio API');
      });

      // Attempt to load
      audio.load();
      audioRef.current = audio;
    }
    return () => {
      audioRef.current = null;
      audioLoadedRef.current = false;
    };
  }, [playSound]);

  // Play notification sound (throttled to prevent audio spam during floods)
  const playNotificationSound = useCallback(() => {
    if (!playSound) return;

    const now = Date.now();
    if (now - lastSoundPlayedRef.current < SOUND_THROTTLE_MS) return;
    lastSoundPlayedRef.current = now;

    // Try to play audio file first
    if (audioLoadedRef.current && audioRef.current) {
      audioRef.current.currentTime = 0;
      audioRef.current.play().catch(() => {
        // Fallback to Web Audio API if play fails
        playBeepWithWebAudio();
      });
    } else {
      // Use Web Audio API as fallback
      playBeepWithWebAudio();
    }
  }, [playSound]);

  // Add a new notification
  const addNotification = useCallback(
    (alert: AlertData) => {
      const id = `alert-${++notificationIdCounter.current}-${Date.now()}`;
      const notification: AlertNotification = {
        ...alert,
        id,
        receivedAt: Date.now(),
      };

      setNotifications((prev) => {
        // Add new notification at the beginning, keep only maxNotifications
        const updated = [notification, ...prev].slice(0, maxNotifications);
        return updated;
      });

      // Play sound
      playNotificationSound();

      // Auto-dismiss after timeout
      if (autoDismissMs > 0) {
        setTimeout(() => {
          setNotifications((prev) => prev.filter((n) => n.id !== id));
        }, autoDismissMs);
      }
    },
    [maxNotifications, autoDismissMs, playNotificationSound]
  );

  // Dismiss a specific notification
  const dismissNotification = useCallback((id: string) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id));
  }, []);

  // Dismiss all notifications
  const dismissAll = useCallback(() => {
    setNotifications([]);
  }, []);

  // Handle WebSocket messages
  const handleWebSocketMessage = useCallback(
    (data: unknown) => {
      const message = data as TerminalWebSocketMessage;

      // Check if this is an alert message
      if (message.alert) {
        console.log('[AlertNotifications] Received alert:', message.alert);
        addNotification(message.alert);

        // Trigger refresh of alerts in bell icon (Header component)
        triggerAlertRefresh();
      }
    },
    [addNotification]
  );

  // WebSocket connection (reuses terminal subscription)
  const ws = useWebSocket({
    subscriptions: ['terminal'],
    autoReconnect: true,
    reconnectDelay: 3000,
    maxReconnectAttempts: 10,
    onMessage: handleWebSocketMessage,
    onConnect: () => {
      console.log('[AlertNotifications] WebSocket connected');
    },
  });

  // Connect on mount if enabled
  useEffect(() => {
    if (enabled) {
      ws.connect();
    }
    return () => {
      if (enabled) {
        ws.disconnect();
      }
    };
  }, [enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    notifications,
    dismissNotification,
    dismissAll,
    isConnected: ws.isConnected,
  };
};

export default useAlertNotifications;
