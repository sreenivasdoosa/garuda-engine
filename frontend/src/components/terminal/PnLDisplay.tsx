/**
 * PnLDisplay Component
 * Displays P&L with color coding and animations
 */

import React from 'react';
import clsx from 'clsx';

interface PnLDisplayProps {
  value: number;
  showSign?: boolean;
  showPercentage?: boolean;
  percentageValue?: number;
  size?: 'sm' | 'md' | 'lg';
  animate?: boolean;
  className?: string;
  /** If true, show full number in Indian format (1,40,000) instead of abbreviated (1.4L) */
  fullFormat?: boolean;
}

const PnLDisplay: React.FC<PnLDisplayProps> = ({
  value,
  showSign = true,
  showPercentage = false,
  percentageValue,
  size = 'md',
  animate = true,
  className,
  fullFormat = false,
}) => {
  const safeValue = value ?? 0;
  const isPositive = safeValue > 0;
  const isNegative = safeValue < 0;
  const isZero = safeValue === 0;

  const formatValue = (val: number): string => {
    if (val == null) return '0.00';

    // If fullFormat, show complete number in Indian format
    if (fullFormat) {
      return Math.round(val).toLocaleString('en-IN');
    }

    // Otherwise, use abbreviated format (K, L)
    const absVal = Math.abs(val);
    if (absVal >= 100000) {
      return `${(val / 100000).toFixed(2)}L`;
    }
    if (absVal >= 1000) {
      return `${(val / 1000).toFixed(2)}K`;
    }
    return val.toFixed(2);
  };

  const sizeClasses = {
    sm: 'text-[0.85rem]',
    md: 'text-base',
    lg: 'text-xl font-bold',
  };

  return (
    <span
      className={clsx(
        'pnl-display',
        sizeClasses[size],
        {
          'text-success-500 dark:text-success-400': isPositive,
          'text-danger-600 dark:text-danger-400': isNegative,
          'text-ink-soft': isZero,
          'pnl-animate': animate && !isZero,
        },
        className
      )}
    >
      {showSign && isPositive && '+'}
      {formatValue(safeValue)}
      {showPercentage && percentageValue !== undefined && (
        <span className="pnl-percentage ms-1 text-ink-soft">
          ({percentageValue > 0 ? '+' : ''}{percentageValue.toFixed(2)}%)
        </span>
      )}
    </span>
  );
};

export default PnLDisplay;
