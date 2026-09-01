/**
 * TerminalLayout Component
 * Full-screen layout for the trading terminal (no sidebar)
 * Used for live trades and positions monitoring
 */

import { Outlet } from 'react-router-dom';
import Header from '@/components/layout/Header';
import { LicenseActivationBanner } from '@/components/common';

const TerminalLayout: React.FC = () => {
  return (
    <div className="app-wrapper admin-layout">
      <Header showSidebarToggle={false} />
      <main className="main-content no-sidebar">
        <LicenseActivationBanner />
        <Outlet />
      </main>
    </div>
  );
};

export default TerminalLayout;
