import { Outlet } from 'react-router-dom';

import Header from '@/components/layout/Header';

/**
 * The Terminal runs full screen.
 *
 * It is the page you watch during market hours, so it gets the top bar and
 * nothing else: no sections, no page row, no padding around the grid. Getting
 * back to the Console is the switcher in the bar.
 */
const TerminalLayout: React.FC = () => (
  <div className="console-shell is-terminal">
    <Header showSections={false} />
    <main className="console-main is-flush">
      <Outlet />
    </main>
  </div>
);

export default TerminalLayout;
