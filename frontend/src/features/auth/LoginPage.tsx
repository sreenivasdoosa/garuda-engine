import { useEffect, useRef, useState } from 'react';
import { BsArrowRight } from 'react-icons/bs';

import { Button, Spinner } from '@/components/ui';
import { authTheme } from '@/layouts/AuthLayout';
import { configService } from '@/services/config/configService';
import { useAuth } from '@/hooks/useAuth';
import { useConfigStore } from '@/store/configStore';

/**
 * Signing in. One admin, a username and a password.
 *
 * The first-run password is named on the page on purpose. It is a default an
 * installer sets and an operator is meant to change, and a default nobody is
 * told about is a default nobody changes.
 */

const field =
  'w-full rounded-lg border border-white/10 bg-white/[0.04] px-3.5 py-3 text-[0.95rem] text-white ' +
  'placeholder:text-white/30 transition-colors focus:border-indigo-400/60 focus-visible:outline-none';

const LoginPage: React.FC = () => {
  const { handleLocalLogin, isLocalLoginLoading } = useAuth();
  const { setServerConfig } = useConfigStore();
  const [isConfigLoading, setIsConfigLoading] = useState(false);

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const usernameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const loadConfig = async () => {
      setIsConfigLoading(true);
      try {
        setServerConfig(await configService.getServerConfig());
      } catch (error) {
        console.error('[Login] could not read the server config:', error);
      } finally {
        setIsConfigLoading(false);
      }
    };
    loadConfig();
  }, [setServerConfig]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!username.trim() || !password) {
      usernameRef.current?.focus();
      return;
    }
    handleLocalLogin({ username: username.trim(), password });
  };

  return (
    <div className="fade-in">
      <h2 className="font-display text-xl font-semibold text-white">Sign in</h2>
      <p className="mt-1 text-sm text-white/45">
        The one account on this engine.
      </p>

      <form onSubmit={submit} className="mt-6 space-y-3">
        <input
          ref={usernameRef}
          type="text"
          placeholder="Username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          autoFocus
          className={field}
        />
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          className={field}
        />
        <Button
          type="submit"
          variant="primary"
          size="md"
          disabled={isLocalLoginLoading || isConfigLoading}
          className="w-full py-3 text-base"
          style={{
            background: 'linear-gradient(100deg, #4f46e5, #6366f1 55%, #8b5cf6)',
            border: 'none',
            boxShadow: `0 8px 24px -10px ${authTheme.ring}`,
          }}
        >
          {isLocalLoginLoading ? (
            <>
              <Spinner size="sm" />
              <span>Signing in…</span>
            </>
          ) : (
            <>
              <span>Sign in</span>
              <BsArrowRight size={17} />
            </>
          )}
        </Button>
      </form>

      <p className="mt-6 border-t border-white/[0.07] pt-4 text-xs leading-relaxed text-white/35">
        A fresh install signs in as <code className="text-white/60">admin</code> with{' '}
        <code className="text-white/60">garuda@777</code>. Change it from the Console before this
        machine is reachable by anyone else.
      </p>
    </div>
  );
};

export default LoginPage;
