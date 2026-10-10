/**
 * What the log page and the timeline page share: how an event's category
 * reads, and how a moment and a price are shown.
 */

import { useState } from 'react';
import { BsCheck2, BsClipboard } from 'react-icons/bs';
import type { Tone } from '@/components/ui';
import type { TradeLogEventCategory } from '@/types/tradeLog';

export const categoryTone = (cat?: TradeLogEventCategory | null): Tone => {
  switch (cat) {
    case 'ENTRY':
      return 'primary';
    case 'SL':
      return 'warning';
    case 'TARGET':
      return 'success';
    case 'HEDGE':
      return 'info';
    case 'ERROR':
      return 'danger';
    default:
      return 'neutral';
  }
};

/** Dot colours on the timeline rail: fixed hues so the rail reads at a glance in either theme. */
export const categoryColorHex = (cat?: TradeLogEventCategory | null): string => {
  switch (cat) {
    case 'ENTRY':
      return '#6b8cff';
    case 'SL':
      return '#ffc107';
    case 'TARGET':
      return '#22c55e';
    case 'HEDGE':
      return '#0dcaf0';
    case 'ERROR':
      return '#ef4444';
    default:
      return '#94a3b8';
  }
};

/** A moment with its date, in the viewer's locale. */
export const formatWhen = (iso?: string | null): string => (iso ? new Date(iso).toLocaleString() : '');

/** Just the clock, with milliseconds, for a timeline whose day is already known. */
export const formatClock = (iso?: string | null): string => {
  if (!iso) return '';
  const d = new Date(iso);
  const hms = d.toLocaleTimeString(undefined, { hour12: false });
  return `${hms}.${String(d.getMilliseconds()).padStart(3, '0')}`;
};

/** Money arrives as a string and is shown, never computed. */
export const formatPrice = (value?: string | null): string => {
  if (value === null || value === undefined || value === '') return '';
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(2) : value;
};

/** A small copy-to-clipboard affordance that confirms without a toast. */
export const CopyButton: React.FC<{ value: string; className?: string }> = ({ value, className = 'ml-1 text-xs' }) => {
  const [copied, setCopied] = useState(false);
  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // clipboard denied or unavailable -- nothing to do
    }
  };
  return (
    <span
      role="button"
      title={copied ? 'Copied' : `Copy ${value}`}
      onClick={handleCopy}
      className={`cursor-pointer ${className} ${copied ? 'text-success-500' : 'text-ink-faint hover:text-ink'}`}
    >
      {copied ? <BsCheck2 /> : <BsClipboard />}
    </span>
  );
};
