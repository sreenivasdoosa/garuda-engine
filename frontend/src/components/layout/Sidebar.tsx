import { useState, useCallback } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { IconType } from 'react-icons';
import { BsChevronDown } from 'react-icons/bs';
import clsx from 'clsx';

import { useUIStore } from '@/store/uiStore';

// Migrated to the Tailwind design system (Phase 1). The outer `.sidebar` class
// is kept for geometry only (fixed position / width / collapse / mobile
// off-canvas from global.scss, coupled to `.main-content` margins); the nav
// internals no longer use Bootstrap or the `.nav-link` (!important) rules, so
// the active accent is now brand-aware via `primary-*` tokens instead of a
// hardcoded green. Classes carry the migration `` prefix.

export interface SidebarItem {
  path: string;
  label: string;
  icon: IconType;
  badge?: string | number;
  badgeColor?: string;
}

export interface SidebarSection {
  title?: string;
  items: SidebarItem[];
}

interface SidebarProps {
  sections: SidebarSection[];
}

const Sidebar: React.FC<SidebarProps> = ({ sections }) => {
  const { sidebarOpen, sidebarCollapsed } = useUIStore();
  const location = useLocation();

  // Auto-expand section containing the active route, collapse others
  const getInitialExpanded = useCallback(() => {
    const expanded: Record<number, boolean> = {};
    sections.forEach((section, idx) => {
      const hasActiveItem = section.items.some(item => location.pathname.startsWith(item.path));
      expanded[idx] = hasActiveItem;
    });
    return expanded;
  }, [sections, location.pathname]);

  const [expandedSections, setExpandedSections] = useState<Record<number, boolean>>(getInitialExpanded);

  const toggleSection = (index: number) => {
    setExpandedSections(prev => ({ ...prev, [index]: !prev[index] }));
  };

  const isSectionActive = (section: SidebarSection) => {
    return section.items.some(item => location.pathname.startsWith(item.path));
  };

  return (
    <aside
      className={clsx('sidebar', {
        open: sidebarOpen,
        collapsed: sidebarCollapsed,
      })}
    >
      <nav className="flex flex-col h-full gap-0.5 p-3 overflow-y-auto">
        {sections.map((section, sectionIndex) => {
          const isExpanded = expandedSections[sectionIndex] ?? isSectionActive(section);
          const hasTitle = !!section.title;

          return (
            <div key={sectionIndex}>
              {hasTitle && !sidebarCollapsed ? (
                <button
                  type="button"
                  onClick={() => toggleSection(sectionIndex)}
                  className="w-full flex items-center justify-between px-3 pt-3 pb-1.5 text-[0.7rem] font-semibold uppercase tracking-wider text-white/45 hover:text-white/70 transition-colors select-none"
                >
                  <span>{section.title}</span>
                  <BsChevronDown
                    className="text-[0.65rem] opacity-70 transition-transform"
                    style={{ transform: isExpanded ? 'rotate(0deg)' : 'rotate(-90deg)' }}
                  />
                </button>
              ) : hasTitle && sidebarCollapsed ? (
                <div className="h-4" />
              ) : null}

              <div
                className="overflow-hidden transition-[max-height] duration-200"
                style={{ maxHeight: !hasTitle || isExpanded || sidebarCollapsed ? '600px' : '0' }}
              >
                {section.items.map((item) => (
                  <NavLink
                    key={item.path}
                    to={item.path}
                    title={sidebarCollapsed ? item.label : undefined}
                    className={({ isActive }) =>
                      clsx(
                        'group relative flex items-center gap-3 my-0.5 px-4 py-2.5 rounded-control text-sm font-medium transition-colors',
                        sidebarCollapsed && 'justify-center',
                        isActive
                          ? 'bg-primary-500/20 text-white font-semibold'
                          : 'text-white/70 hover:text-white hover:bg-primary-500/15',
                      )
                    }
                  >
                    {({ isActive }) => (
                      <>
                        {isActive && (
                          <span className="absolute left-0 top-1/2 -translate-y-1/2 h-[70%] w-1 rounded-r bg-accent-gradient shadow-glow" />
                        )}
                        <item.icon
                          className={clsx(
                            'text-lg shrink-0 transition-colors',
                            isActive ? 'text-primary-400' : 'text-white/70 group-hover:text-primary-400',
                          )}
                        />
                        {!sidebarCollapsed && (
                          <>
                            <span className="truncate">{item.label}</span>
                            {item.badge !== undefined && (
                              <span className="ml-auto rounded-full bg-primary-500/25 text-primary-200 text-xs font-semibold px-2 py-0.5">
                                {item.badge}
                              </span>
                            )}
                          </>
                        )}
                      </>
                    )}
                  </NavLink>
                ))}
              </div>
            </div>
          );
        })}
      </nav>
    </aside>
  );
};

export default Sidebar;
