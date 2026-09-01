import { useEffect, useRef, useState } from 'react';
import { BsShieldLock, BsArrowRight } from 'react-icons/bs';

import { useAuth } from '@/hooks/useAuth';
import { useTheme } from '@/context/ThemeContext';
import { useConfigStore } from '@/store/configStore';
import { configService } from '@/services/config/configService';
import { brandTheme } from '@/layouts/AuthLayout';
import { Button, Spinner } from '@/components/ui';

/**
 * Login page with SSO (Distributed) or username/password (Standalone) support.
 * Automatically detects edition from server config.
 */
const inputClass =
  'w-full bg-app text-ink border border-hairline rounded-control px-3 py-3 text-base placeholder:text-ink-faint focus-visible:outline-none focus:border-primary-500/60 transition-colors';

const LoginPage: React.FC = () => {
  const { handleLocalLogin, isLocalLoginLoading } = useAuth();
  const { brandConfig } = useTheme();
  const { setServerConfig } = useConfigStore();
  const [isConfigLoading, setIsConfigLoading] = useState(false);

  const theme = brandTheme;

  // Local login form state
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const usernameRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  // Force reload server config on login page mount to ensure config is fresh
  useEffect(() => {
    const loadConfig = async () => {
      console.log('[Login] Config not in store, fetching from server...');
      setIsConfigLoading(true);
      try {
        const serverConfig = await configService.getServerConfig();
        console.log('[Login] Server config loaded:', serverConfig);
        setServerConfig(serverConfig);
      } catch (error) {
        console.error('[Login] Failed to load server config:', error);
      } finally {
        setIsConfigLoading(false);
      }
    };

    loadConfig();
  }, [setServerConfig]);

  const handleLocalLoginSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // Use DOM values as fallback — browser autofill doesn't always fire onChange
    const user = username || usernameRef.current?.value || '';
    const pass = password || passwordRef.current?.value || '';
    if (user.trim() && pass) {
      handleLocalLogin({ username: user.trim(), password: pass });
    }
  };


  return (
    <div className="fade-in">
      {/* Welcome Section */}
      <div className="mb-4 text-center">
        <div
          className="mb-3 inline-flex h-14 w-14 items-center justify-center rounded-full"
          style={{ background: theme.iconBg }}
        >
          <BsShieldLock size={24} style={{ color: theme.accentColor }} />
        </div>
        <h4 className="mb-1 font-display text-xl font-bold text-ink">Welcome Back</h4>
        <p className="mb-0 text-sm text-ink-soft">
          Sign in to access your {brandConfig.displayName} dashboard
        </p>
      </div>

      {/* Login Form / Button */}
      {isConfigLoading ? (
        <Button variant="primary" size="md" disabled className="w-full py-3 text-base">
          <Spinner size="sm" />
          <span>Loading...</span>
        </Button>
      ) : (
        <form onSubmit={handleLocalLoginSubmit} className="space-y-3">
          <input
            ref={usernameRef}
            type="text"
            placeholder="Username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoFocus
            className={inputClass}
          />
          <input
            ref={passwordRef}
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            className={inputClass}
          />
          <Button type="submit" variant="primary" size="md" disabled={isLocalLoginLoading} className="w-full py-3 text-base">
            {isLocalLoginLoading ? (
              <>
                <Spinner size="sm" />
                <span>Signing in...</span>
              </>
            ) : (
              <>
                <span>Sign In</span>
                <BsArrowRight size={18} />
              </>
            )}
          </Button>
        </form>
      )}

      {/* Footer Note */}
      <p className="mb-0 mt-4 text-center text-xs text-ink-faint">
        By signing in, you agree to our{' '}
        <a
          href={brandConfig.termsUrl || `${brandConfig.website}/terms`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary-600 hover:underline dark:text-primary-400"
        >
          Terms of Service
        </a>{' '}
        and{' '}
        <a
          href={brandConfig.privacyUrl || `${brandConfig.website}/privacy`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary-600 hover:underline dark:text-primary-400"
        >
          Privacy Policy
        </a>
      </p>
    </div>
  );
};

export default LoginPage;
