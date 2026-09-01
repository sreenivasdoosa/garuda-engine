/**
 * Live Feed Page - Full-screen real-time market data display.
 * Uses TerminalLayout (no sidebar) like the trading terminal.
 * Wraps tab components in MarketDataProvider for WebSocket data.
 */

import { useState } from 'react';
import { Container, Nav, Badge } from '@/components/ui/rbShim';
import { BsReception4, BsLayers, BsBell } from 'react-icons/bs';
import { MarketDataProvider, useMarketData } from '@/context/MarketDataContext';
import TicksTab from './TicksTab';
import StraddlesTab from './StraddlesTab';
import SignalsTab from './SignalsTab';

type TabKey = 'ticks' | 'straddles' | 'signals';

function LiveFeedContent() {
  const [activeTab, setActiveTab] = useState<TabKey>('ticks');
  const { isConnected, lastHeartbeat, ticks, straddleTicks, signals } = useMarketData();

  const formatHeartbeat = () => {
    if (!lastHeartbeat) return '';
    return lastHeartbeat.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  return (
    <Container fluid className="h-full flex flex-col py-4">
      {/* Header bar */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-4">
          <h5 className="mb-0 font-bold">Live Feed</h5>
          <Badge bg={isConnected ? 'success' : 'danger'} className="flex items-center gap-1">
            <span className={`rounded-full inline-block ${isConnected ? 'bg-card' : 'bg-raised'}`} style={{ width: 6, height: 6 }}></span>
            {isConnected ? 'Connected' : 'Disconnected'}
          </Badge>
          {lastHeartbeat && (
            <small className="text-ink-soft">Last heartbeat: {formatHeartbeat()}</small>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Badge bg="secondary" pill>{ticks.size} ticks</Badge>
          <Badge bg="secondary" pill>{straddleTicks.size} straddles</Badge>
          <Badge bg="secondary" pill>{signals.size} signals</Badge>
        </div>
      </div>

      {/* Tabs */}
      <Nav variant="tabs" activeKey={activeTab} onSelect={(k) => setActiveTab((k as TabKey) || 'ticks')} className="mb-4">
        <Nav.Item>
          <Nav.Link eventKey="ticks" className="flex items-center gap-2">
            <BsReception4 /> Ticks
            {ticks.size > 0 && <Badge bg="primary" pill>{ticks.size}</Badge>}
          </Nav.Link>
        </Nav.Item>
        <Nav.Item>
          <Nav.Link eventKey="straddles" className="flex items-center gap-2">
            <BsLayers /> Straddles
            {straddleTicks.size > 0 && <Badge bg="primary" pill>{straddleTicks.size}</Badge>}
          </Nav.Link>
        </Nav.Item>
        <Nav.Item>
          <Nav.Link eventKey="signals" className="flex items-center gap-2">
            <BsBell /> Signals
            {signals.size > 0 && <Badge bg="primary" pill>{signals.size}</Badge>}
          </Nav.Link>
        </Nav.Item>
      </Nav>

      {/* Tab content */}
      <div className="grow overflow-hidden">
        {activeTab === 'ticks' && <TicksTab />}
        {activeTab === 'straddles' && <StraddlesTab />}
        {activeTab === 'signals' && <SignalsTab />}
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
