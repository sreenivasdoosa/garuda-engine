import { NavLink, useLocation } from 'react-router-dom';
import clsx from 'clsx';

import { NAV_SECTIONS, sectionFor } from '@/config/navigation';

/**
 * The seven Console sections, in the top bar.
 *
 * Clicking one lands on its first page; which pages it holds is the row
 * underneath (`SectionNav`). Highlighting follows the path rather than the
 * click, so a link from anywhere still lights the right section.
 */
const HeaderSections: React.FC = () => {
  const { pathname } = useLocation();
  const active = sectionFor(pathname);

  return (
    <div className="header-sections" role="tablist" aria-label="Console sections">
      {NAV_SECTIONS.map((section) => {
        const isActive = section.title === active.title;
        return (
          <NavLink
            key={section.title}
            to={section.items[0].path}
            role="tab"
            aria-selected={isActive}
            className={clsx('header-section', isActive && 'is-active')}
          >
            {section.title}
          </NavLink>
        );
      })}
    </div>
  );
};

export default HeaderSections;
