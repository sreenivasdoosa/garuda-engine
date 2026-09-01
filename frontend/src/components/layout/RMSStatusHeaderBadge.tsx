/**
 * RMSStatusHeaderBadge
 *
 * Sticky header indicator that flashes "RMS DISABLED" in red when the
 * system-wide kill-switch property `rms.enabled` is set to `'false'` in
 * SYSTEM_CONFIG. Mirrors {@link MockSessionHeaderBadge} so admins watching
 * any page see at a glance that order-level risk gates are not running.
 *
 * RMS off means the entire validator chain (price deviation, position
 * limits, daily loss, rate limits, kill switches, broker-stopped check)
 * is a no-op and every order goes through unchecked — see RMSService
 * .validateOrder line 255. That's a state the operator should always be
 * aware of, hence danger styling.
 *
 * Polls /api/v2/system-config/rms.enabled every 60s. Silently fails on
 * permission errors so the badge degrades to invisible for users who
 * lack SYSTEM_CONFIG view rights.
 */

import React, { useEffect, useState } from 'react';
import { BsExclamationTriangleFill } from 'react-icons/bs';

import { systemConfigService } from '@/services/admin/v2AdminService';

const RMSStatusHeaderBadge: React.FC = () => {
  const [rmsDisabled, setRmsDisabled] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const fetchOnce = async () => {
      try {
        const entry = await systemConfigService.getByProperty('rms.enabled');
        if (cancelled) return;
        // Treat anything that's not the string "true" (case-insensitive)
        // as disabled — matches SystemConfig.getBooleanValue semantics on
        // the server side, which only accepts "true" / "1" / "yes" /
        // "on" as truthy.
        const v = (entry?.value ?? '').trim().toLowerCase();
        const enabled = v === 'true' || v === '1' || v === 'yes' || v === 'on';
        setRmsDisabled(!enabled);
      } catch {
        // Forbidden / missing row / network error — don't show the
        // badge. We refuse to display "disabled" speculatively because
        // a false alarm is worse than silence.
        if (!cancelled) setRmsDisabled(false);
      }
    };
    fetchOnce();
    const id = window.setInterval(fetchOnce, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  if (!rmsDisabled) return null;

  return (
    <span
      className="mr-2 inline-flex items-center gap-1.5 rounded-full bg-danger-600 px-3 py-1 text-xs font-semibold text-white"
      style={{ lineHeight: 1.3, animation: 'pulse 2s ease-in-out infinite' }}
      title="RMS is disabled at the system-config level (rms.enabled=false). All order-level risk gates — price deviation, position limits, daily loss, rate limits, kill switches — are bypassed. Every order is sent to the broker unchecked."
    >
      <BsExclamationTriangleFill aria-hidden="true" />
      <span>RMS DISABLED</span>
    </span>
  );
};

export default RMSStatusHeaderBadge;
