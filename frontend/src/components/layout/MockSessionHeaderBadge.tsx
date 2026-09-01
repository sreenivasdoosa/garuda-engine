/**
 * MockSessionHeaderBadge
 *
 * Sticky header indicator that flashes "MOCK ACTIVE" when an admin has
 * toggled a mock-trading session on. Visible on every page so admins
 * watching the user terminal, broker config, or strategy pages still
 * see at a glance that mock-mode is engaged.
 *
 * Polls /api/v2/engine/mock/status every 60s. Lightweight; one GET
 * per minute even when admin is on a different tab.
 */

import React, { useEffect, useState } from 'react';

import { mockSessionService } from '@/services/admin/mockSessionService';

interface Props {
  /** Whether the user has MOCK_TRADING.canView (V right). Sysadmins
      implicitly have all rights, so they pass this gate too. */
  canView: boolean;
}

/**
 * Format a UTC ISO instant as HH:mm in the user's locale, suitable for
 * rendering inside a compact header badge. Returns empty string on
 * missing / invalid input rather than throwing.
 */
const formatHHMM = (iso?: string | null): string => {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleTimeString('en-IN', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  } catch {
    return '';
  }
};

const MockSessionHeaderBadge: React.FC<Props> = ({ canView }) => {
  const [active, setActive] = useState(false);
  const [autoStopAt, setAutoStopAt] = useState<string | null>(null);

  useEffect(() => {
    if (!canView) return;
    let cancelled = false;
    const fetchOnce = async () => {
      try {
        const s = await mockSessionService.getStatus();
        if (cancelled) return;
        setActive(!!s.isActive);
        setAutoStopAt(s.effectiveStopAt ?? null);
      } catch {
        // silent — banner will refresh next tick
      }
    };
    fetchOnce();
    const id = window.setInterval(fetchOnce, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [canView]);

  if (!canView || !active) return null;

  const stopHHMM = formatHHMM(autoStopAt);
  const tooltip = stopHHMM
    ? `Mock trading session is active. Real broker orders are being placed for mock-tagged strategies. Auto-stops at ${stopHHMM} unless stopped manually.`
    : 'A mock trading session is active. Real broker orders are being placed for mock-tagged strategies.';

  return (
    <span
      className="mr-2 inline-flex items-center rounded-full bg-warning-400 px-3 py-1 text-xs font-semibold text-black"
      style={{ lineHeight: 1.3, animation: 'pulse 2s ease-in-out infinite' }}
      title={tooltip}
    >
      MOCK ACTIVE
      {stopHHMM && <span className="ml-1.5 font-normal opacity-85">· auto-stops {stopHHMM}</span>}
    </span>
  );
};

export default MockSessionHeaderBadge;
