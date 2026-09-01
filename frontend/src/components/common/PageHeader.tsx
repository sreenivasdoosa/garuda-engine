import { Link } from 'react-router-dom';

// Compact console/admin page header. Migrated to the Tailwind design system
// (tokens +  prefix); API unchanged so all 59 consumers re-skin for free.

interface BreadcrumbItem {
  label: string;
  path?: string;
}

export interface PageHeaderProps {
  title: string;
  subtitle?: string;
  breadcrumbs?: BreadcrumbItem[];
  actions?: React.ReactNode;
  icon?: React.ReactNode;
}

const PageHeader: React.FC<PageHeaderProps> = ({ title, subtitle, breadcrumbs, actions, icon }) => {
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        {breadcrumbs && breadcrumbs.length > 0 && (
          <nav className="mb-1 flex flex-wrap items-center gap-1 text-[0.7rem] text-ink-faint">
            {breadcrumbs.map((item, index) => (
              <span key={index} className="flex items-center gap-1">
                {index > 0 && <span className="opacity-60">/</span>}
                {item.path ? (
                  <Link to={item.path} className="hover:text-primary-500">
                    {item.label}
                  </Link>
                ) : (
                  <span className="text-ink-soft">{item.label}</span>
                )}
              </span>
            ))}
          </nav>
        )}
        <h1 className="mb-0 flex items-center gap-2 font-display text-base font-semibold text-ink">
          {icon && <span className="text-primary-500">{icon}</span>}
          {title}
        </h1>
        {subtitle && <p className="mb-0 mt-1 text-[0.7rem] text-ink-soft">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
};

export default PageHeader;
