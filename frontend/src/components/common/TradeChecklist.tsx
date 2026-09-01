/**
 * Trade Troubleshooting Checklist
 * A reference checklist for diagnosing why trades are not being placed for a user/strategy.
 * Displayed as an Offcanvas drawer triggered by a button.
 */

import { useState } from 'react';
import { BsClipboardCheck, BsArrowRight } from 'react-icons/bs';
import { Modal } from '@/components/ui';

interface ChecklistItem {
  title: string;
  description: string;
  where: string;
  category: string;
}

const CHECKLIST_ITEMS: ChecklistItem[] = [
  // --- Exchange & Market ---
  {
    category: 'Exchange & Market',
    title: 'Exchange is active',
    description: 'The exchange (NSE, BSE, MCX, etc.) for the strategy must be marked as active.',
    where: 'Console > Exchanges',
  },
  {
    category: 'Exchange & Market',
    title: 'Today is not a holiday for the exchange',
    description: 'No trades are placed on exchange holidays. Check the holiday calendar for the relevant exchange.',
    where: 'Console > Exchanges > Holidays tab',
  },
  {
    category: 'Exchange & Market',
    title: 'Market is currently open',
    description: 'Trades are only placed during market hours (between market open and market close times configured for the exchange).',
    where: 'Console > Exchanges',
  },
  // --- Broker ---
  {
    category: 'Broker',
    title: 'Broker is enabled',
    description: 'The broker must be enabled. A disabled broker blocks all operations.',
    where: 'Console > Brokers',
  },
  {
    category: 'Broker',
    title: 'Broker is not stopped',
    description: 'A stopped broker blocks all new trades (RMS breach: BROKER_STOPPED). Existing positions can still be managed.',
    where: 'Console > Brokers',
  },
  {
    category: 'Broker',
    title: 'Broker exchange config exists for each active exchange',
    description: 'A broker-exchange config must exist for every active exchange. This defines login timing, square-off timing, and order buffer settings. Missing configs will cause trade failures.',
    where: 'Console > Broker Configuration > Broker Exchange Configs tab',
  },
  // --- User ---
  {
    category: 'User',
    title: 'User is active',
    description: 'The user account must be active. Inactive users are skipped during auto-login and trade execution.',
    where: 'Console > Users',
  },
  {
    category: 'User',
    title: "User's enabled exchanges include the strategy's exchange",
    description: "The user's enabled exchanges list must contain the exchange the strategy trades on. If a user is not enabled for NSE, no NSE strategies will execute for them.",
    where: 'Console > Users > Edit user > Enabled Exchanges',
  },
  {
    category: 'User',
    title: 'User-broker is enabled',
    description: 'The user-broker mapping must be enabled. This controls whether the user can trade through a specific broker.',
    where: 'Console > User Brokers',
  },
  {
    category: 'User',
    title: 'User-broker is logged in',
    description: 'The user must have an active login session with the broker. Check alerts for login failures. If auto-login is enabled, ensure credentials (app key, secret, TOTP) are correctly configured.',
    where: 'Console > Alerts (filter by Login)',
  },
  // --- Strategy ---
  {
    category: 'Strategy',
    title: 'Strategy definition is active',
    description: 'The strategy must be in an active status that allows new trades. Strategies in WIND_DOWN or inactive status will not generate new entry signals.',
    where: 'Console > Strategy Engine > Definitions',
  },
  {
    category: 'Strategy',
    title: 'Strategy config exists',
    description: 'A strategy config must exist — at minimum a base-level config. Without this, the engine has no parameters for trade generation. Tranch-level configs override the base config for specific tranches.',
    where: 'Console > Strategy Engine > Config Tree',
  },
  // --- Subscription ---
  {
    category: 'Subscription',
    title: 'User subscription exists and is active',
    description: 'The user must have an active subscription to the strategy. Inactive or missing subscriptions will not generate trade signals.',
    where: 'Console > User Subscriptions',
  },
  {
    category: 'Subscription',
    title: 'Subscription has sufficient capital allocated',
    description: 'The subscription must have enough capital to take at least one lot. Capital per lot is defined in the strategy definition (capitalPerLot). If allocated capital is less than the capital required for one lot, no trades will be placed.',
    where: 'Console > User Subscriptions > Capital column',
  },
  // --- System & RMS ---
  {
    category: 'System & RMS',
    title: 'Engine is not in dry-run mode',
    description: 'In dry-run mode, signals are generated but not executed. Trades appear in logs with [DRY RUN] prefix but no actual orders are placed.',
    where: 'Console > Strategy Engine > Definitions',
  },
  {
    category: 'System & RMS',
    title: 'Kill switch is not active',
    description: 'Kill switches can be activated at global, exchange, broker, symbol, or user level. When active, new entry orders are blocked (exit orders are still allowed).',
    where: 'Console > RMS > Kill Switch',
  },
  {
    category: 'System & RMS',
    title: 'RMS order limits are not breached',
    description: 'Check that daily order limits, per-second rate limits, per-minute rate limits, and per-symbol limits are not exhausted. Also check that order quantity and value do not exceed configured maximums.',
    where: 'Console > RMS > Settings',
  },
  // --- Still Not Working ---
  {
    category: 'Still Not Working?',
    title: 'Check alerts for warnings and errors',
    description: 'Go to the Alerts page and filter by the specific user, user-broker, strategy, and RMS. Look for any WARNING or CRITICAL level alerts — these often contain the exact reason why a trade was not placed (e.g., login failure, order rejection, RMS breach, insufficient margin, kill switch triggered).',
    where: 'Console > Alerts (filter by User / Broker / Strategy / RMS)',
  },
  {
    category: 'Still Not Working?',
    title: 'Contact the technical team',
    description: 'If all the above checks pass and there are no relevant alerts, the issue may require deeper investigation. Reach out to the technical team with the user name, broker, strategy, exchange, and the date/time when the trade was expected.',
    where: 'Share details: user, broker, strategy, exchange, and timestamp',
  },
];

const CATEGORY_DOT: Record<string, string> = {
  'Exchange & Market': 'bg-accent-500',
  'Broker': 'bg-primary-500',
  'User': 'bg-success-500',
  'Strategy': 'bg-warning-500',
  'Subscription': 'bg-danger-500',
  'System & RMS': 'bg-ink-faint',
  'Still Not Working?': 'bg-ink',
};

const TradeChecklistButton: React.FC = () => {
  const [show, setShow] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setShow(true)}
        className="inline-flex items-center gap-1 rounded-control border border-warning-500/50 px-2.5 py-1.5 text-xs font-medium text-warning-400 transition-colors hover:bg-warning-500/10"
      >
        <BsClipboardCheck size={14} />
        <span className="hidden md:inline">Checklist</span>
      </button>

      <Modal
        open={show}
        onClose={() => setShow(false)}
        size="lg"
        title={
          <span className="inline-flex items-center gap-2">
            <BsClipboardCheck />
            Trade Troubleshooting Checklist
          </span>
        }
      >
        <div className="-m-5">
          <div className="border-b border-hairline px-4 py-2 text-sm text-ink-soft">
            Verify these items in order when trades are not being placed for a user/strategy
          </div>
          {(() => {
            const grouped = CHECKLIST_ITEMS.reduce<Record<string, ChecklistItem[]>>((acc, item) => {
              (acc[item.category] ??= []).push(item);
              return acc;
            }, {});
            let stepNumber = 0;
            return Object.entries(grouped).map(([category, items]) => (
              <div key={category}>
                <div className="sticky top-0 z-[1] flex items-center gap-1.5 border-b border-hairline bg-raised px-4 py-2 text-sm font-semibold text-ink">
                  <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${CATEGORY_DOT[category] ?? 'bg-ink-faint'}`} />
                  {category === 'Still Not Working?' ? category : `${category} Checklist`}
                </div>
                {items.map((item) => {
                  stepNumber++;
                  return (
                    <div key={stepNumber} className="flex gap-2 border-b border-hairline px-4 py-2">
                      <div
                        className="flex shrink-0 items-center justify-center rounded-full bg-raised font-bold text-ink-soft"
                        style={{ width: 28, height: 28, fontSize: '0.8rem', marginTop: 2 }}
                      >
                        {stepNumber}
                      </div>
                      <div>
                        <div className="mb-1 font-semibold text-ink">{item.title}</div>
                        <div className="mb-1 text-ink-soft" style={{ fontSize: '0.85rem', lineHeight: 1.6 }}>
                          {item.description}
                        </div>
                        <div className="flex items-center gap-1 text-primary-500" style={{ fontSize: '0.8rem' }}>
                          <BsArrowRight size={12} />
                          {item.where}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ));
          })()}
        </div>
      </Modal>
    </>
  );
};

export default TradeChecklistButton;
