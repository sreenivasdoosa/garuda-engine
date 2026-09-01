/**
 * BrokerSetupRequired - Guard components that block pages when no broker is configured in Standalone mode.
 *
 * In Standalone mode, a fresh install has an empty BROKERS table. Pages that depend on broker details
 * (exchange configs, user brokers, instruments) are broken until an admin configures the broker.
 * These guards replace page content with a setup prompt.
 *
 * No-op in Distributed mode — renders children directly.
 * Migrated to the Tailwind design system (tokens +  prefix).
 */

import { type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { BsExclamationTriangleFill, BsGear } from 'react-icons/bs';
import { useBrokers } from '@/hooks/useBrokers';
import { Spinner } from '@/components/ui';

interface BrokerSetupRequiredProps {
  children: ReactNode;
}

const LoadingBlock = () => (
  <div className="flex items-center justify-center text-primary-500" style={{ minHeight: '200px' }}>
    <Spinner />
  </div>
);

export const BrokerSetupRequired: React.FC<BrokerSetupRequiredProps> = ({ children }) => {
  const { data: brokers, isLoading } = useBrokers();

  if (isLoading) return <LoadingBlock />;

  if (!brokers || brokers.length === 0) {
    return (
      <div className="m-3 rounded-card border border-warning-500/30 bg-warning-500/10 p-4">
        <div className="flex items-start gap-3">
          <BsExclamationTriangleFill size={24} className="mt-1 shrink-0 text-warning-500" />
          <div>
            <h6 className="mb-1 font-semibold text-ink">Broker Not Configured</h6>
            <p className="mb-2 text-sm text-ink-soft">
              No broker has been set up yet. This page requires at least one broker to be configured before it can be used.
            </p>
            <Link
              to="/console/brokers"
              className="inline-flex items-center gap-1 rounded-control bg-warning-500 px-3 py-1.5 text-xs font-medium text-black no-underline hover:bg-warning-600"
            >
              <BsGear />
              Go to Broker Management
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return <>{children}</>;
};

export const UserPortalBrokerSetupRequired: React.FC<BrokerSetupRequiredProps> = ({ children }) => {
  const { data: brokers, isLoading } = useBrokers();

  if (isLoading) return <LoadingBlock />;

  if (!brokers || brokers.length === 0) {
    return (
      <div className="m-4 rounded-card border border-accent-500/30 bg-accent-500/10 p-4">
        <div className="flex items-start gap-3">
          <BsExclamationTriangleFill size={24} className="mt-1 shrink-0 text-accent-500" />
          <div>
            <h6 className="mb-1 font-semibold text-ink">Broker Not Available</h6>
            <p className="mb-0 text-sm text-ink-soft">
              No broker has been configured yet. Please contact your administrator to set up the broker before you can use this page.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return <>{children}</>;
};

export default BrokerSetupRequired;
