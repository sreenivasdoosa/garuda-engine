/**
 * Brokers: the venues' gatekeepers garuda has an adapter for.
 *
 * The set is fixed -- a broker is an adapter garuda ships, and the rows are
 * seeded -- so there is nothing to add here; the page edits what is editable
 * about each one. Two switches matter to the engine: Enabled decides whether
 * accounts at the broker are built at all, and Stop is the brake on every
 * account there at once. Both take effect when the engine next starts.
 */

import { BsBank } from 'react-icons/bs';
import { PageHeader, MissingBrokerExchangeConfigAlert } from '@/components/common';
import { Brokers } from '@/components/brokers';

const BrokersPage: React.FC = () => {

  // Permission flags for Brokers tool

  return (
    <div className="fade-in">
      <PageHeader
        title="Brokers"
        subtitle="The brokers garuda can trade through, and whether each is switched on"
        icon={<BsBank size={24} />}
      />

      <MissingBrokerExchangeConfigAlert />

      <Brokers
        title="Brokers"
        hideCreate
        hideDelete={false}
        hideEnableDisable={false}
        readOnly={false}
      />
    </div>
  );
};

export default BrokersPage;
