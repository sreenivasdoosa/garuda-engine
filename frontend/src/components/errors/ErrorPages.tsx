/**
 * Shared 403 (Forbidden) and 404 (Not Found) pages.
 *
 * Replaces the previous silent `<Navigate to=…>` redirects so an unauthorized or
 * unknown URL shows a real message + a way out, instead of bouncing to the
 * dashboard. The "home" button is role-aware (mirrors App.getDefaultPath):
 * management users → /console, portal users → /dashboard, signed-out → /login.
 */

import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/rbShim';
import { BsShieldLock, BsSignpost2, BsHouseDoor, BsArrowLeft } from 'react-icons/bs';
import { useAuthStore } from '@/store/authStore';

/** Role-aware home path — the same rule as App.getDefaultPath(). */
function useHomePath(): string {
  const { user, isAuthenticated } = useAuthStore();
  return useMemo(() => {
    if (!isAuthenticated || !user) return '/login';
    return user.canManageUsers || user.isSysadmin ? '/console' : '/dashboard';
  }, [user, isAuthenticated]);
}

interface ErrorLayoutProps {
  icon: React.ReactNode;
  code: string;
  title: string;
  message: string;
}

const ErrorLayout: React.FC<ErrorLayoutProps> = ({ icon, code, title, message }) => {
  const navigate = useNavigate();
  const homePath = useHomePath();
  const homeLabel = homePath === '/console' ? 'Go to Console'
    : homePath === '/dashboard' ? 'Go to Dashboard'
    : 'Go to Login';

  return (
    <div
      className="flex flex-col items-center justify-center text-center px-4"
      style={{ minHeight: '60vh', width: '100%' }}
    >
      <div className="text-ink-soft mb-4" style={{ fontSize: '3.5rem', lineHeight: 1 }}>
        {icon}
      </div>
      <div className="text-ink-soft font-bold" style={{ letterSpacing: '0.1em' }}>{code}</div>
      <h3 className="mt-1 mb-2">{title}</h3>
      <p className="text-ink-soft mb-6" style={{ maxWidth: 480 }}>{message}</p>
      <div className="flex gap-2">
        <Button variant="outline-secondary" onClick={() => navigate(-1)}>
          <BsArrowLeft className="me-1" /> Go Back
        </Button>
        <Button variant="primary" onClick={() => navigate(homePath, { replace: true })}>
          <BsHouseDoor className="me-1" /> {homeLabel}
        </Button>
      </div>
    </div>
  );
};

/** 403 — authenticated but not authorized for this page. */
export const Forbidden: React.FC = () => (
  <ErrorLayout
    icon={<BsShieldLock />}
    code="403 — FORBIDDEN"
    title="You are not authorized to access this page"
    message="Your account doesn't have permission to view this page. If you think this is a mistake, contact your administrator."
  />
);

/** 404 — route does not exist. */
export const NotFound: React.FC = () => (
  <ErrorLayout
    icon={<BsSignpost2 />}
    code="404 — NOT FOUND"
    title="Page not found"
    message="The page you're looking for doesn't exist or may have been moved."
  />
);

export default { Forbidden, NotFound };
