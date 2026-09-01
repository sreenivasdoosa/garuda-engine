import { Outlet } from 'react-router-dom';

import Header from '@/components/layout/Header';
import SectionNav from '@/components/layout/SectionNav';
import { HelpDrawer } from '@/components/common';
import { allHelpContent } from '@/data/help';

/**
 * The Console shell: a top bar carrying the sections, a row of that section's
 * pages under it, and everything else is content.
 *
 * The engine this was copied from navigated from a left rail. Horizontally the
 * wide tables get the full width of the window, and the chrome is a fixed
 * height rather than a fixed column.
 */
const ConsoleLayout: React.FC = () => (
  <div className="console-shell">
    <Header />
    <SectionNav />
    <main className="console-main">
      <Outlet />
    </main>
    <HelpDrawer contentMap={allHelpContent} />
  </div>
);

export default ConsoleLayout;
