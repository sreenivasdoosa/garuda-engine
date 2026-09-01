import { NavLink, useLocation } from 'react-router-dom';
import clsx from 'clsx';

import { sectionFor } from '@/config/navigation';

/**
 * The pages of whichever section you are in, as a row under the top bar.
 *
 * The sections themselves live in the top bar beside the brand; this is the
 * second half of that pair. The engine this was copied from put both in a left
 * rail — horizontally, the wide tables and the Terminal grid get the whole
 * width instead, which is what they were designed for.
 *
 * The row scrolls sideways rather than wrapping, so the chrome is the same
 * height on every screen and the content below never shifts.
 */
const SectionNav: React.FC = () => {
  const { pathname } = useLocation();
  const active = sectionFor(pathname);

  return (
    <nav className="section-nav" aria-label={`${active.title} pages`}>
      {active.items.map(({ path, label, icon: Icon }) => (
        <NavLink
          key={path}
          to={path}
          end={path === '/console'}
          className={({ isActive }) => clsx('section-page', isActive && 'is-active')}
        >
          <Icon size={14} aria-hidden />
          <span>{label}</span>
        </NavLink>
      ))}
    </nav>
  );
};

export default SectionNav;
