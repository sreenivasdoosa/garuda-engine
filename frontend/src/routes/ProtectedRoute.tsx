import { Navigate, useLocation } from 'react-router-dom';
import { Spinner } from '@/components/ui/rbShim';
import { useAuthStore } from '@/store/authStore';

interface ProtectedRouteProps {
  children: React.ReactNode;
  /**
   * If true, requires user to have canManageUsers permission (or isSysadmin).
   * Used for Console/Terminal routes that require management access.
   */
  requiresManagement?: boolean;
}

const ProtectedRoute: React.FC<ProtectedRouteProps> = ({
  children,
  requiresManagement,
}) => {
  const location = useLocation();
  const { isAuthenticated, user, isLoading } = useAuthStore();

  // Wait for auth initialization to complete before making redirect decisions
  if (isLoading) {
    return (
      <div className="flex justify-center items-center" style={{ minHeight: '100vh' }}>
        <Spinner animation="border" variant="primary" />
      </div>
    );
  }

  // Not authenticated - redirect to login
  if (!isAuthenticated || !user) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  // Check permission-based access
  if (requiresManagement) {
    const hasManagementAccess = user.canManageUsers || user.isSysadmin;
    if (!hasManagementAccess) {
      // Regular users without management access go to dashboard
      return <Navigate to="/dashboard" replace />;
    }
  }

  return <>{children}</>;
};

export default ProtectedRoute;
