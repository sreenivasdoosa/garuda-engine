import { Navigate } from 'react-router-dom';
import type { ReactNode } from 'react';

import { useAuthStore } from '@/store/authStore';
import LoadingScreen from '@/components/common/LoadingScreen';

/**
 * Signed in, or sent to the login page.
 *
 * That is the whole authorization model. The engine this was copied from
 * gated routes on a rights matrix as well; there is one operator here and
 * they own every account on it, so being signed in is the only question.
 */
interface ProtectedRouteProps {
  children: ReactNode;
}

const ProtectedRoute: React.FC<ProtectedRouteProps> = ({ children }) => {
  const { isAuthenticated, isLoading } = useAuthStore();

  if (isLoading) {
    return <LoadingScreen />;
  }
  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
};

export default ProtectedRoute;
