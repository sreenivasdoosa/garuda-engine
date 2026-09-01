/**
 * Displays warning alerts when enabled brokers are missing exchange configs for active exchanges.
 * Shows one line per exchange with the list of unconfigured brokers.
 * Migrated to the Tailwind design system (tokens +  prefix).
 */

import { Link } from 'react-router-dom';
import { BsExclamationTriangleFill, BsArrowRight } from 'react-icons/bs';
import { useMissingBrokerExchangeConfigs } from '@/hooks/useMissingBrokerExchangeConfigs';

const MissingBrokerExchangeConfigAlert: React.FC = () => {
  const missingConfigs = useMissingBrokerExchangeConfigs();

  if (missingConfigs.length === 0) return null;

  return (
    <div className="mb-3 rounded-card border border-warning-500/30 bg-warning-500/10 p-3">
      <div className="flex items-start gap-2">
        <BsExclamationTriangleFill className="mt-1 shrink-0 text-warning-500" />
        <div className="text-sm text-ink">
          <strong>Missing Broker Exchange Configurations</strong>
          <div className="mt-1 text-ink-soft">
            {missingConfigs.map(({ exchange, brokers }) => (
              <div key={exchange}>
                Exchange <strong className="text-ink">{exchange}</strong> not configured for brokers:{' '}
                <strong className="text-ink">{brokers.join(', ')}</strong>
              </div>
            ))}
          </div>
          <div className="mt-2">
            <Link
              to="/console/broker-config"
              className="inline-flex items-center gap-1 font-semibold text-warning-600 no-underline hover:underline dark:text-warning-400"
            >
              <BsArrowRight />
              Go to Broker Configuration
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
};

export default MissingBrokerExchangeConfigAlert;
