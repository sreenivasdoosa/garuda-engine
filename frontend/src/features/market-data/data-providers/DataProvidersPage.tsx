/**
 * Data Providers Page (Standalone mode only)
 * Shows login status for Zerodha, XTS, and TrueData.
 * Enables manual login for Zerodha (SSO) and XTS (API).
 */

import { useEffect } from 'react';
import { Card, Row, Col, Badge, Button, Alert, Spinner } from '@/components/ui/rbShim';
import { BsPlug, BsCheckCircleFill, BsXCircleFill, BsDashCircle, BsBoxArrowUpRight, BsArrowClockwise } from 'react-icons/bs';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'react-toastify';
import { PageHeader } from '@/components/common';
import { dataProviderService } from '@/services/admin/v2AdminService';
import type { DataProviderStatus } from '@/services/admin/v2AdminService';

const PROVIDER_DISPLAY: Record<string, { label: string; description: string; color: string }> = {
  zerodha: {
    label: 'Zerodha (Kite Connect)',
    description: 'Requires one-time manual login via Zerodha\'s authorization page. After that, auto-login works daily.',
    color: '#387ed1',
  },
  xts: {
    label: 'XTS (Symphony Fintech)',
    description: 'API-based login using app key and secret. No browser authorization needed.',
    color: '#e85d04',
  },
  truedata: {
    label: 'TrueData',
    description: 'Authenticates automatically using credentials. Access token is fetched on demand for HTTP APIs, WebSocket uses credentials directly.',
    color: '#2d6a4f',
  },
};

const DataProvidersPage: React.FC = () => {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  const { data: providers, isLoading, refetch } = useQuery({
    queryKey: ['data-providers-status'],
    queryFn: () => dataProviderService.getStatus(),
    refetchInterval: 30000,
  });

  // Handle callback query params from Zerodha redirect
  useEffect(() => {
    const login = searchParams.get('login');
    const error = searchParams.get('error');
    if (login === 'success') {
      toast.success('Zerodha login successful! Auto-login is now enabled.');
      setSearchParams({});
      refetch();
    } else if (error) {
      toast.error(`Login failed: ${error}`);
      setSearchParams({});
    }
  }, [searchParams]);

  const zerodhaLoginMutation = useMutation({
    mutationFn: async () => {
      const result = await dataProviderService.getZerodhaLoginUrl();
      window.location.href = result.url;
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to get Zerodha login URL');
    },
  });

  const xtsLoginMutation = useMutation({
    mutationFn: () => dataProviderService.loginXts(),
    onSuccess: (result) => {
      if (result.success) {
        toast.success('XTS login successful');
      } else {
        toast.error(result.message || 'XTS login failed');
      }
      queryClient.invalidateQueries({ queryKey: ['data-providers-status'] });
    },
    onError: (error: Error) => {
      toast.error(error.message || 'XTS login failed');
    },
  });

  const renderStatusBadge = (provider: DataProviderStatus) => {
    if (!provider.configured) {
      return <Badge bg="secondary"><BsDashCircle className="me-1" />Not Configured</Badge>;
    }
    if (provider.loginType === 'none') {
      return <Badge bg="info"><BsCheckCircleFill className="me-1" />No Login Required</Badge>;
    }
    if (provider.loginType === 'auto') {
      return provider.loggedIn
        ? <Badge bg="success"><BsCheckCircleFill className="me-1" />Authenticated</Badge>
        : <Badge bg="warning" text="dark">Pending (on first use)</Badge>;
    }
    if (provider.loggedIn) {
      return <Badge bg="success"><BsCheckCircleFill className="me-1" />Logged In</Badge>;
    }
    return <Badge bg="danger"><BsXCircleFill className="me-1" />Not Logged In</Badge>;
  };

  const renderLoginButton = (provider: DataProviderStatus) => {
    if (!provider.configured || provider.loginType === 'none') return null;

    if (provider.name === 'zerodha') {
      return (
        <Button
          variant={provider.loggedIn ? 'outline-primary' : 'primary'}
          size="sm"
          onClick={() => zerodhaLoginMutation.mutate()}
          disabled={zerodhaLoginMutation.isPending}
        >
          {zerodhaLoginMutation.isPending ? (
            <><Spinner size="sm" className="me-1" />Redirecting...</>
          ) : (
            <><BsBoxArrowUpRight className="me-1" />{provider.loggedIn ? 'Re-Login' : 'Login via Zerodha'}</>
          )}
        </Button>
      );
    }

    if (provider.name === 'xts') {
      return (
        <Button
          variant={provider.loggedIn ? 'outline-primary' : 'primary'}
          size="sm"
          onClick={() => xtsLoginMutation.mutate()}
          disabled={xtsLoginMutation.isPending}
        >
          {xtsLoginMutation.isPending ? (
            <><Spinner size="sm" className="me-1" />Logging in...</>
          ) : (
            provider.loggedIn ? 'Re-Login' : 'Login'
          )}
        </Button>
      );
    }

    return null;
  };

  return (
    <div className="fade-in">
      <PageHeader
        title="Data Providers"
        subtitle="Manage market data provider connections"
        icon={<BsPlug size={24} />}
        actions={
          <Button variant="outline-secondary" size="sm" onClick={() => refetch()}>
            <BsArrowClockwise className="me-1" />
            Refresh
          </Button>
        }
      />

      {isLoading ? (
        <div className="text-center py-12">
          <Spinner animation="border" />
          <p className="mt-2 text-ink-soft">Loading provider status...</p>
        </div>
      ) : (
        <Row className="">
          {providers?.map((provider) => {
            const display = PROVIDER_DISPLAY[provider.name] || { label: provider.name, description: '', color: '#6c757d' };
            return (
              <Col md={4} key={provider.name}>
                <Card className={`h-full ${provider.active ? 'border-primary-500' : ''}`}>
                  <Card.Header className="flex justify-between items-center">
                    <div className="flex items-center gap-2">
                      <div
                        style={{
                          width: 10, height: 10, borderRadius: '50%',
                          backgroundColor: display.color,
                        }}
                      />
                      <strong style={{ fontSize: '0.9rem' }}>{display.label}</strong>
                    </div>
                    {provider.active && <Badge bg="primary">Active</Badge>}
                  </Card.Header>
                  <Card.Body>
                    <div className="mb-4">
                      <div className="text-ink-soft text-[0.875em] mb-2">{display.description}</div>
                      <div className="flex items-center gap-2">
                        <span className="text-[0.875em] font-medium">Status:</span>
                        {renderStatusBadge(provider)}
                      </div>
                    </div>

                    {/* Zerodha: manual login required warning */}
                    {provider.name === 'zerodha' && provider.configured && !provider.manualLoginDone && (
                      <Alert variant="warning" className="py-2 mb-4" style={{ fontSize: '0.8rem' }}>
                        <strong>Manual login required.</strong> Click "Login via Zerodha" to authorize this app.
                        Auto-login will be enabled after the first successful manual login.
                      </Alert>
                    )}

                    {/* Zerodha: auto-login enabled */}
                    {provider.name === 'zerodha' && provider.manualLoginDone && (
                      <div className="mb-4">
                        <Badge bg="outline-success" className="border border-success-500 text-success-500 dark:text-success-400" style={{ fontSize: '0.75rem' }}>
                          <BsCheckCircleFill className="me-1" />Auto-login enabled
                        </Badge>
                      </div>
                    )}

                    {renderLoginButton(provider)}
                  </Card.Body>
                </Card>
              </Col>
            );
          })}
        </Row>
      )}
    </div>
  );
};

export default DataProvidersPage;
