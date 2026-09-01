/**
 * MismatchBadge Component
 * Displays position mismatch severity indicator. Tailwind design system.
 */

import React from 'react';
import { BsExclamationTriangleFill, BsExclamationCircleFill, BsCheckCircleFill } from 'react-icons/bs';
import { Badge, Tooltip } from '@/components/ui';

interface MismatchBadgeProps {
  severity: 'NONE' | 'WARNING' | 'CRITICAL';
  mismatchCount?: number;
  hasQtyMismatch?: boolean;
  hasSymbolMismatch?: boolean;
  hasPnlMismatch?: boolean;
  showDetails?: boolean;
}

const MismatchBadge: React.FC<MismatchBadgeProps> = ({
  severity,
  mismatchCount = 0,
  hasQtyMismatch = false,
  hasSymbolMismatch = false,
  hasPnlMismatch = false,
  showDetails = true,
}) => {
  if (severity === 'NONE') {
    return (
      <Badge tone="success" icon={<BsCheckCircleFill size={12} />}>
        Match
      </Badge>
    );
  }

  const getTooltipContent = () => {
    const issues: string[] = [];
    if (hasQtyMismatch) issues.push('Quantity mismatch');
    if (hasSymbolMismatch) issues.push('Symbol mismatch');
    if (hasPnlMismatch) issues.push('P&L mismatch (>10%)');
    return issues.length > 0 ? issues.join(', ') : `${mismatchCount} mismatch(es)`;
  };

  const badge = (
    <Badge
      tone={severity === 'CRITICAL' ? 'danger' : 'warning'}
      icon={severity === 'CRITICAL' ? <BsExclamationTriangleFill size={12} /> : <BsExclamationCircleFill size={12} />}
    >
      {severity === 'CRITICAL' ? 'Critical' : 'Warning'}
      {mismatchCount > 0 && ` (${mismatchCount})`}
    </Badge>
  );

  if (showDetails) {
    return (
      <Tooltip label={getTooltipContent()} placement="top">
        {badge}
      </Tooltip>
    );
  }

  return badge;
};

export default MismatchBadge;
