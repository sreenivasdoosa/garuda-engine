/**
 * The Live Feed: what every index is doing, and what the engine derives.
 *
 * Five tabs. The first is the indices themselves; the other four are the
 * series the engine prices for itself, one per tab because each has its own
 * scale and reading them on one axis tells you nothing -- a put-call ratio
 * near 1 and a straddle near 300 share no useful range.
 *
 * There is no Signals tab. A signal is a strategy's private reasoning and
 * belongs with the strategy, not on a market-data page; it was the one tab
 * here whose data had nothing to do with the feed.
 */

import { useState } from 'react';
import { Badge, Container, Nav } from '@/components/ui/rbShim';
import {
  BsActivity,
  BsBarChartLine,
  BsLayers,
  BsPercent,
  BsReception4,
} from 'react-icons/bs';
import { MarketDataProvider, useMarketData } from '@/context/MarketDataContext';
import IndexCards from './IndexCards';
import SeriesTab from './SeriesTab';

type TabKey = 'indices' | 'straddle' | 'iv' | 'pcr' | 'synthetic';

const TABS: { key: TabKey; label: string; icon: React.ReactNode }[] = [
  { key: 'indices', label: 'Indices', icon: <BsReception4 /> },
  { key: 'straddle', label: 'Rolling Straddle', icon: <BsLayers /> },
  { key: 'iv', label: 'Implied Volatility', icon: <BsPercent /> },
  { key: 'pcr', label: 'Put-Call Ratio', icon: <BsActivity /> },
  { key: 'synthetic', label: 'Synthetic Future', icon: <BsBarChartLine /> },
];

function LiveFeedContent() {
  const [tab, setTab] = useState<TabKey>('indices');
  const { isConnected, ticks, lastTickAt } = useMarketData();

  return (
    <Container fluid className="h-full flex flex-col py-4">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-4">
          <h5 className="mb-0 font-bold">Live Feed</h5>
          <Badge bg={isConnected ? 'success' : 'danger'}>
            {isConnected ? 'Connected' : 'Disconnected'}
          </Badge>
          {lastTickAt && (
            <small className="text-ink-soft">
              last tick {lastTickAt.toLocaleTimeString('en-IN', { hour12: false })}
            </small>
          )}
        </div>
        <Badge bg="secondary" pill>
          {ticks.size} quoting
        </Badge>
      </div>

      <Nav
        variant="tabs"
        activeKey={tab}
        onSelect={(k) => setTab((k as TabKey) || 'indices')}
        className="mb-4"
      >
        {TABS.map(({ key, label, icon }) => (
          <Nav.Item key={key}>
            <Nav.Link eventKey={key} className="flex items-center gap-2">
              {icon} {label}
            </Nav.Link>
          </Nav.Item>
        ))}
      </Nav>

      <div className="grow overflow-auto">
        {tab === 'indices' && <IndexCards />}
        {tab === 'straddle' && (
          <SeriesTab kind="STRADDLE" label="straddle" />
        )}
        {tab === 'iv' && (
          <SeriesTab kind="IV" label="IV" unit="%" precision={2} />
        )}
        {tab === 'pcr' && <SeriesTab kind="PCR" label="PCR" precision={3} />}
        {tab === 'synthetic' && (
          // The only series with comparisons: a synthetic future exists to be
          // read against the spot it is derived from and the listed future it
          // competes with.
          <SeriesTab
            kind="SYNFUT"
            label="synthetic future"
            comparable
          />
        )}
      </div>
    </Container>
  );
}

export default function LiveFeedPage() {
  return (
    <MarketDataProvider>
      <LiveFeedContent />
    </MarketDataProvider>
  );
}
