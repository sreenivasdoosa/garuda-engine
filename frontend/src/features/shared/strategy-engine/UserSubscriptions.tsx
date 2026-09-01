/**
 * User Subscriptions Component
 * Shows ALL user subscriptions across all users in a grouped table
 * Similar to UserStrategiesPage but for strategy engine subscriptions
 * Uses V2 API: /api/v2/engine/subscriptions
 */

import React, { useState, useMemo, useEffect } from 'react';
import TablePagination from '@/components/common/TablePagination';
import { DEFAULT_PAGE_SIZE } from '@/types/pagination';
import { Card, Button, Badge, Form, Row, Col, InputGroup, Alert, Table, Modal, Spinner } from '@/components/ui/rbShim';
import {
  BsPeople,
  BsPencil,
  BsTrash,
  BsSearch,
  BsToggleOn,
  BsToggleOff,
  BsPlusCircle,
  BsArrowClockwise,
  BsCheckCircle,
  BsXCircle,
  BsPencilSquare,
  BsEye,
} from 'react-icons/bs';
import Select from 'react-select';
import { ConfirmModal } from '@/components/common';
import HelpIcon from '@/components/common/HelpIcon';
import type { StrategyConfigTree } from '@/types/strategy-config-tree';
import { capitalGridFor } from '@/utils/capitalGrid';
import { strategyConfigTreeService } from '@/services/admin/v2AdminService';
import { userSubscriptionHelpContent } from '@/data/help/user-subscription-help';
import { usePermissions } from '@/hooks/usePermissions';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { userSubscriptionService, strategyCatalogService  } from '@/services/admin/strategyEngineService';
import { userManagementService, allocationModelService, userBrokerService } from '@/services/admin/v2AdminService';
import { toast } from 'react-toastify';
import type {
  UserStrategySubscription,
  CreateUserSubscriptionRequest,
  UpdateUserSubscriptionRequest,
  StrategyDefinition,
} from '@/types/strategy-engine';
import type { User, UserBrokerConfig, UpdateUserBrokerRequest } from '@/types/user_mgmt';
import type { AllocationModel, AllocationModelStrategy } from '@/types/billing';

// Grouped subscription for table display
interface SubscriptionGroup {
  username: string;
  broker: string;
  subscriptions: UserStrategySubscription[];
  totalCapital: number;
}

const UserSubscriptions: React.FC = () => {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  const canEdit = permissions.userSubscriptions.canEdit;
  const canManage = permissions.userSubscriptions.canManage;

  // Filter and search state
  const [search, setSearch] = useState('');
  const [strategyFilter, setStrategyFilter] = useState<string>('all');
  const [brokerFilter, setBrokerFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [paperFilter, setPaperFilter] = useState<string>('all');

  // All filters are applied SERVER-SIDE (the query below re-fetches whenever any
  // filter changes), so the data is always the full matching set across every
  // user — not a single page. The grouped rows are then paginated CLIENT-SIDE over
  // user+broker groups (see pagedGroups), which keeps the page count in step with
  // the active filters and lets us still show users that have no subscriptions yet.
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);
  // Any filter change (or page-size change) resets to page 1.
  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, statusFilter, strategyFilter, brokerFilter, paperFilter, pageSize]);

  // Modal state
  const [selectedSubscription, setSelectedSubscription] = useState<UserStrategySubscription | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [addForUsername, setAddForUsername] = useState<string>('');

  // Bulk edit modal state
  const [showBulkEditModal, setShowBulkEditModal] = useState(false);
  const [bulkEditGroup, setBulkEditGroup] = useState<SubscriptionGroup | null>(null);

  // Delete all confirmation state
  const [showDeleteAllConfirm, setShowDeleteAllConfirm] = useState(false);
  const [deleteAllGroup, setDeleteAllGroup] = useState<SubscriptionGroup | null>(null);

  // Form state for add/edit modal
  const [formData, setFormData] = useState<CreateUserSubscriptionRequest>({
    username: '',
    strategyName: '',
    brokerName: '',
    capital: 0,
    isPaperTrading: false,
  });
  const [editCapital, setEditCapital] = useState<number>(0);
  const [editRiskPercentage, setEditRiskPercentage] = useState<string>('');
  const [editAbsoluteMaxRisk, setEditAbsoluteMaxRisk] = useState<string>('');
  const [editIsPaperTrading, setEditIsPaperTrading] = useState<boolean>(false);
  // Equity overrides (leverage clamped server-side to strategy [minLeverage, maxLeverage])
  const [editLeverage, setEditLeverage] = useState<string>('');
  const [editMaxActivePositions, setEditMaxActivePositions] = useState<string>('');

  // Data fetching — server-side FILTERED set (all matching rows for active users).
  // Re-fetches on every filter change so the grouping/pagination below always works
  // over the complete result, never a stale single page.
  const { data: subscriptions = [], isLoading, error, refetch } = useQuery({
    queryKey: ['user-subscriptions', debouncedSearch, statusFilter, strategyFilter, brokerFilter, paperFilter],
    queryFn: () => userSubscriptionService.getFiltered({
      status: statusFilter,
      search: debouncedSearch || undefined,
      strategy: strategyFilter,
      broker: brokerFilter,
      paper: paperFilter,
    }),
  });

  // Fetch users for grouping and user info
  const { data: users = [] } = useQuery({
    queryKey: ['users'],
    queryFn: () => userManagementService.getUsers(),
  });

  // Active SYSTEM-scope strategy catalog (public + private) for the filter + Add-subscription picker.
  // Shared admin-console catalog endpoint (management-gated), so a supervisor sees the assignable
  // strategies WITHOUT needing STRATEGY_DEFINITIONS (QUANT-188).
  const { data: strategyDefinitions = [] } = useQuery({
    queryKey: ['strategy-catalog'],
    queryFn: () => strategyCatalogService.getOptions(),
  });

  // Mutations
  const createMutation = useMutation({
    mutationFn: (data: CreateUserSubscriptionRequest) => userSubscriptionService.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['user-subscriptions'] });
      toast.success('Subscription created successfully');
      handleCloseAddModal();
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to create subscription');
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: UpdateUserSubscriptionRequest }) =>
      userSubscriptionService.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['user-subscriptions'] });
      toast.success('Subscription updated successfully');
      handleCloseEditModal();
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to update subscription');
    },
  });

  const activateMutation = useMutation({
    mutationFn: (id: number) => userSubscriptionService.activate(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['user-subscriptions'] });
      toast.success('Subscription activated');
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to activate subscription');
    },
  });

  const deactivateMutation = useMutation({
    mutationFn: (id: number) => userSubscriptionService.deactivate(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['user-subscriptions'] });
      toast.success('Subscription deactivated');
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to deactivate subscription');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => userSubscriptionService.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['user-subscriptions'] });
      toast.success('Subscription deleted successfully');
      setShowDeleteConfirm(false);
      setSelectedSubscription(null);
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to delete subscription');
    },
  });

  const deleteByUserMutation = useMutation({
    mutationFn: (username: string) => userSubscriptionService.deleteByUser(username),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['user-subscriptions'] });
      queryClient.invalidateQueries({ queryKey: ['capitalChangeHistory'] });
      toast.success('All subscriptions deleted successfully');
      setShowDeleteAllConfirm(false);
      setDeleteAllGroup(null);
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to delete subscriptions');
    },
  });

  // Get strategy display name
  const getStrategyDisplayName = (strategyName: string): string => {
    const def = strategyDefinitions.find((d: StrategyDefinition) => d.strategyName === strategyName);
    return def?.displayName || strategyName;
  };

  // Get strategy's capital per lot for step value
  // Capital grid: for watchlist-driven strategies the effective step is
  // capitalPerLot x maxActivePositions (capital splits per stock BEFORE lot math).
  const getCapitalGrid = (strategyName: string, capital?: number) => {
    const def = strategyDefinitions.find((d: StrategyDefinition) => d.strategyName === strategyName);
    return capitalGridFor(def, capital, undefined, getTranchCount(strategyName));
  };

  // Base (strategy-level) config-tree rows: the per-tranch rows define how many tranches a
  // strategy actually runs, which the capital hint needs (lots deploy sequentially per tranch).
  const { data: baseConfigs = [] } = useQuery({
    queryKey: ['strategy-config-tree', 'base-configs'],
    queryFn: () => strategyConfigTreeService.getBaseConfigs(),
  });

  const getTranchCount = (strategyName: string): number => {
    const tranches = new Set(
      baseConfigs
        .filter((c: StrategyConfigTree) => c.strategyName === strategyName && c.tranchNumber != null && c.tranchNumber > 0)
        .map((c: StrategyConfigTree) => c.tranchNumber)
    );
    return tranches.size || 1;
  };

  // Get strategy's risk settings
  const getStrategyRiskSettings = (strategyName: string) => {
    const def = strategyDefinitions.find((d: StrategyDefinition) => d.strategyName === strategyName);
    return {
      // Use != null to catch both null and undefined (backend may return null for unset fields)
      isRiskEnabled: def?.riskPercentage != null || def?.absoluteMaxRisk != null,
      defaultRiskPct: def?.riskPercentage,
      minRiskPct: def?.minRiskPercentage,
      maxRiskPct: def?.maxRiskPercentage,
    };
  };

  // Get strategy's equity settings (leverage override bounds; tradeMode === 'EQUITY')
  const getStrategyEquitySettings = (strategyName: string) => {
    const def = strategyDefinitions.find((d: StrategyDefinition) => d.strategyName === strategyName);
    return {
      isEquity: def?.tradeMode === 'EQUITY',
      defaultLeverage: def?.leverage,
      minLeverage: def?.minLeverage,
      maxLeverage: def?.maxLeverage,
      defaultMaxActivePositions: def?.maxActivePositions,
    };
  };

  // Get user display name
  const getUserDisplayName = (username: string): string => {
    const user = users.find((u: User) => u.username === username);
    return user?.alias ? `${username} (${user.alias})` : username;
  };

  // Only ACTIVE users are shown here — the server already returns subscriptions for
  // active users only, so empty-group rows (users with no subscriptions yet) must be
  // built from the same active subset to stay consistent. Suspended/closed/pending
  // users are omitted on both sides.
  const activeUsers = useMemo(
    () => users.filter((u: User) => u.status === 'ACTIVE'),
    [users]
  );

  // Group subscriptions by username-broker (using active users as base, like legacy UserStrategiesPage)
  const groupedSubscriptions = useMemo(() => {
    if (!activeUsers || activeUsers.length === 0) return [];

    const groups: SubscriptionGroup[] = [];

    // Create a map of subscriptions by username-broker for quick lookup
    const subscriptionMap = new Map<string, UserStrategySubscription[]>();
    subscriptions.forEach((sub: UserStrategySubscription) => {
      const key = `${sub.username}-${sub.brokerName}`;
      if (!subscriptionMap.has(key)) {
        subscriptionMap.set(key, []);
      }
      subscriptionMap.get(key)!.push(sub);
    });

    // Iterate through all active users and their brokers
    activeUsers.forEach((user: User) => {
      if (user.brokers && user.brokers.length > 0) {
        // Create a group for each broker the user has
        user.brokers.forEach((userBroker) => {
          const key = `${user.username}-${userBroker.broker}`;
          const userSubscriptions = subscriptionMap.get(key) || [];

          // Sort subscriptions by strategy name
          userSubscriptions.sort((a, b) =>
            getStrategyDisplayName(a.strategyName).localeCompare(getStrategyDisplayName(b.strategyName))
          );

          const totalCapital = userSubscriptions.reduce((sum, sub) => sum + (sub.capital || 0), 0);

          groups.push({
            username: user.username,
            broker: userBroker.broker,
            subscriptions: userSubscriptions,
            totalCapital,
          });
        });
      } else {
        // User has no brokers configured - show with placeholder
        groups.push({
          username: user.username,
          broker: '-',
          subscriptions: [],
          totalCapital: 0,
        });
      }
    });

    // Sort groups by username
    return groups.sort((a, b) => a.username.localeCompare(b.username));
  }, [activeUsers, subscriptions, strategyDefinitions]);

  // Strategy filter options — derived from the full strategy-definition list (a STABLE
  // source), not the currently-filtered subscriptions. Deriving from the filtered set
  // would collapse the dropdown to just the selected strategy once a filter is applied.
  const strategyFilterOptions = useMemo(() => {
    return strategyDefinitions
      .map((d: StrategyDefinition) => ({ value: d.strategyName, label: d.displayName || d.strategyName }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [strategyDefinitions]);

  // Broker filter options — derived from every active user's broker config (a STABLE
  // source) so the dropdown lists ALL configured brokers regardless of the active
  // filters or whether a broker currently has any subscriptions.
  const uniqueBrokers = useMemo(() => {
    const brokerSet = new Set<string>();
    activeUsers.forEach((user: User) => {
      (user.brokers || []).forEach((userBroker) => {
        if (userBroker.broker) brokerSet.add(userBroker.broker);
      });
    });
    return Array.from(brokerSet).sort();
  }, [activeUsers]);

  const brokerFilterOptions = useMemo(() => {
    return [{ value: 'all', label: 'All Brokers' }, ...uniqueBrokers.map((broker) => ({ value: broker, label: broker }))];
  }, [uniqueBrokers]);

  const addBrokerOptions = useMemo(() => {
    const selectedUser = users.find((user: User) => user.username === formData.username);
    return Array.from(new Set((selectedUser?.brokers || []).map((broker: UserBrokerConfig) => broker.broker).filter(Boolean) as string[]))
      .sort()
      .map((broker) => ({ value: broker, label: broker }));
  }, [users, formData.username]);

  // Filter groups
  const filteredGroups = useMemo(() => {
    return groupedSubscriptions
      .map((group) => {
        // Broker filter
        if (brokerFilter !== 'all' && group.broker !== brokerFilter) {
          return null;
        }

        // For groups without subscriptions
        if (group.subscriptions.length === 0) {
          // If strategy / status / paper filter is active, exclude empty groups
          if (strategyFilter !== 'all') return null;
          if (statusFilter !== 'all') return null;
          if (paperFilter !== 'all') return null;

          // Search filter - only match username for empty groups
          if (search) {
            const searchLower = search.toLowerCase();
            const matchesUsername = group.username.toLowerCase().includes(searchLower);
            if (!matchesUsername) return null;
          }
          return group;
        }

        // Filter subscriptions within group
        const filteredSubs = group.subscriptions.filter((sub) => {
          // Strategy filter
          if (strategyFilter !== 'all' && sub.strategyName !== strategyFilter) {
            return false;
          }

          // Status filter
          if (statusFilter !== 'all') {
            if (statusFilter === 'active' && !sub.isActive) return false;
            if (statusFilter === 'inactive' && sub.isActive) return false;
          }

          // Paper / live filter
          if (paperFilter !== 'all') {
            if (paperFilter === 'paper' && !sub.isPaperTrading) return false;
            if (paperFilter === 'live' && sub.isPaperTrading) return false;
          }

          // Search filter
          if (search) {
            const searchLower = search.toLowerCase();
            const matchesUsername = group.username.toLowerCase().includes(searchLower);
            const matchesBroker = group.broker.toLowerCase().includes(searchLower);
            const matchesStrategy =
              sub.strategyName.toLowerCase().includes(searchLower) ||
              getStrategyDisplayName(sub.strategyName).toLowerCase().includes(searchLower);

            if (!matchesUsername && !matchesBroker && !matchesStrategy) {
              return false;
            }
          }

          return true;
        });

        if (filteredSubs.length === 0) {
          return null;
        }

        // Recalculate total capital for filtered subscriptions
        const totalCapital = filteredSubs.reduce((sum, sub) => sum + (sub.capital || 0), 0);

        return {
          ...group,
          subscriptions: filteredSubs,
          totalCapital,
        };
      })
      .filter((group): group is SubscriptionGroup => group !== null);
  }, [groupedSubscriptions, search, strategyFilter, brokerFilter, statusFilter, paperFilter]);

  // Total subscriptions count (across all filtered groups, not just the visible page)
  const totalSubscriptionsCount = useMemo(() => {
    return filteredGroups.reduce((sum, g) => sum + g.subscriptions.length, 0);
  }, [filteredGroups]);

  // Client-side pagination over GROUPS (user+broker). Page count tracks the number of
  // filtered groups, so it shrinks as filters narrow the result. Page is clamped so a
  // filter change that reduces the group count never strands us on an empty page.
  const totalGroups = filteredGroups.length;
  const totalPages = Math.max(1, Math.ceil(totalGroups / pageSize));
  const currentPage = Math.min(page, totalPages);
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);
  const pagedGroups = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return filteredGroups.slice(start, start + pageSize);
  }, [filteredGroups, currentPage, pageSize]);

  // Modal handlers
  const handleAddClick = (username: string, broker: string) => {
    setAddForUsername(username);
    setFormData({
      username: username,
      strategyName: '',
      brokerName: broker,
      capital: 0,
      isPaperTrading: false,
    });
    setShowAddModal(true);
  };

  const handleCloseAddModal = () => {
    setShowAddModal(false);
    setAddForUsername('');
    setFormData({ username: '', strategyName: '', brokerName: '', capital: 0, isPaperTrading: false });
  };

  const handleBulkEditClick = (group: SubscriptionGroup) => {
    const fullGroup = groupedSubscriptions.find(
      (candidate) => candidate.username === group.username && candidate.broker === group.broker
    );

    setBulkEditGroup(fullGroup || group);
    setShowBulkEditModal(true);
  };

  const handleCloseBulkEditModal = () => {
    setShowBulkEditModal(false);
    setBulkEditGroup(null);
  };

  const handleBulkEditSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['user-subscriptions'] });
    queryClient.invalidateQueries({ queryKey: ['users'] }); // Refresh broker config data
    handleCloseBulkEditModal();
  };

  const handleDeleteAllClick = (group: SubscriptionGroup) => {
    setDeleteAllGroup(group);
    setShowDeleteAllConfirm(true);
  };

  const handleConfirmDeleteAll = () => {
    if (deleteAllGroup) {
      deleteByUserMutation.mutate(deleteAllGroup.username);
    }
  };

  const handleEditClick = (subscription: UserStrategySubscription) => {
    setSelectedSubscription(subscription);
    setEditCapital(subscription.capital || 0);
    setEditRiskPercentage(subscription.riskPercentage !== undefined ? String(subscription.riskPercentage) : '');
    setEditAbsoluteMaxRisk(subscription.absoluteMaxRisk !== undefined ? String(subscription.absoluteMaxRisk) : '');
    setEditIsPaperTrading(subscription.isPaperTrading ?? false);
    setEditLeverage(subscription.leverage != null ? String(subscription.leverage) : '');
    setEditMaxActivePositions(subscription.maxActivePositions != null ? String(subscription.maxActivePositions) : '');
    setShowEditModal(true);
  };

  const handleCloseEditModal = () => {
    setShowEditModal(false);
    setSelectedSubscription(null);
    setEditCapital(0);
    setEditRiskPercentage('');
    setEditAbsoluteMaxRisk('');
    setEditIsPaperTrading(false);
    setEditLeverage('');
    setEditMaxActivePositions('');
  };

  const handleToggle = (subscription: UserStrategySubscription) => {
    if (!subscription.subscriptionId) return;
    if (subscription.isActive) {
      deactivateMutation.mutate(subscription.subscriptionId);
    } else {
      activateMutation.mutate(subscription.subscriptionId);
    }
  };

  const handleDeleteClick = (subscription: UserStrategySubscription) => {
    setSelectedSubscription(subscription);
    setShowDeleteConfirm(true);
  };

  const handleConfirmDelete = () => {
    if (selectedSubscription?.subscriptionId) {
      deleteMutation.mutate(selectedSubscription.subscriptionId);
    }
  };

  const handleCreateSubmit = () => {
    if (!formData.username || !formData.strategyName || !formData.brokerName) {
      toast.error('Please fill in all required fields');
      return;
    }
    createMutation.mutate(formData);
  };

  const handleUpdateSubmit = () => {
    if (!selectedSubscription?.subscriptionId) return;
    updateMutation.mutate({
      id: selectedSubscription.subscriptionId,
      data: {
        capital: editCapital,
        riskPercentage: editRiskPercentage ? Number(editRiskPercentage) : undefined,
        absoluteMaxRisk: editAbsoluteMaxRisk ? Number(editAbsoluteMaxRisk) : undefined,
        isPaperTrading: editIsPaperTrading,
        leverage: editLeverage ? Number(editLeverage) : undefined,
        maxActivePositions: editMaxActivePositions ? Number(editMaxActivePositions) : undefined,
      },
    });
  };

  // Format capital display
  const formatCapital = (capital?: number) => {
    if (capital === undefined || capital === null) return '-';
    return capital.toLocaleString('en-IN');
  };

  // Prepare strategy options for dropdown
  const strategyOptions = useMemo(() => {
    return strategyDefinitions.map((d: StrategyDefinition) => ({
      value: d.strategyName,
      label: d.displayName || d.strategyName,
    }));
  }, [strategyDefinitions]);

  if (error) {
    return (
      <Alert variant="danger">
        Failed to load user subscriptions: {(error as Error).message}
      </Alert>
    );
  }

  return (
    <>
      <Card>
        {/* flex-wrap: toolbar must wrap inside the panel on small widths. */}
        <Card.Header className="flex flex-wrap justify-between items-center gap-2">
          <div className="flex items-center gap-2">
            <BsPeople className="me-1" />
            <h5 className="mb-0">User Subscriptions</h5>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Badge bg="secondary">{totalSubscriptionsCount} subscription(s)</Badge>
            <Button variant="outline-secondary" size="sm" onClick={() => refetch()} title="Refresh">
              <BsArrowClockwise />
            </Button>
          </div>
        </Card.Header>
        <Card.Body>
          {/* Pagination controls (top of table) — paginates user+broker groups */}
          {totalGroups > 0 && (
            <TablePagination
              page={currentPage}
              pageSize={pageSize}
              totalCount={totalGroups}
              totalPages={totalPages}
              onPageChange={setPage}
              onPageSizeChange={setPageSize}
              itemLabel="user/broker groups"
              loading={isLoading}
            />
          )}
          {/* Filters */}
          <Row className="mb-4 ">
            <Col md={3}>
              <InputGroup>
                <InputGroup.Text>
                  <BsSearch />
                </InputGroup.Text>
                <Form.Control
                  placeholder="Search username, strategy, broker..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </InputGroup>
            </Col>
            <Col md={3}>
              <Select<{ value: string; label: string }>
                options={[{ value: 'all', label: 'All Strategies' }, ...strategyFilterOptions]}
                value={
                  strategyFilter === 'all'
                    ? { value: 'all', label: 'All Strategies' }
                    : strategyFilterOptions.find(opt => opt.value === strategyFilter) || { value: 'all', label: 'All Strategies' }
                }
                onChange={(selected) => setStrategyFilter(selected?.value || 'all')}
                placeholder="Filter by strategy..."
                isClearable={false}
                isSearchable
                classNamePrefix="react-select"
              />
            </Col>
            <Col md={2}>
              <Select<{ value: string; label: string }>
                options={brokerFilterOptions}
                value={brokerFilterOptions.find((option) => option.value === brokerFilter) || brokerFilterOptions[0]}
                onChange={(selected) => setBrokerFilter(selected?.value || 'all')}
                placeholder="All Brokers"
                isClearable={false}
                isSearchable
                classNamePrefix="react-select"
              />
            </Col>
            <Col md={2}>
              <Form.Select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
              >
                <option value="all">All Status</option>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </Form.Select>
            </Col>
            <Col md={2}>
              <Form.Select
                value={paperFilter}
                onChange={(e) => setPaperFilter(e.target.value)}
                title="Filter by live / paper trading"
              >
                <option value="all">Live &amp; Paper</option>
                <option value="live">Live only</option>
                <option value="paper">Paper only</option>
              </Form.Select>
            </Col>
          </Row>

          {/* Grouped Data Table */}
          {isLoading ? (
            <div className="text-center py-6">
              <Spinner animation="border" variant="primary" />
              <p className="mt-2 text-ink-soft">Loading subscriptions...</p>
            </div>
          ) : filteredGroups.length === 0 ? (
            <div className="text-center py-6 text-ink-soft">
              {search || strategyFilter !== 'all' || brokerFilter !== 'all' || statusFilter !== 'all' || paperFilter !== 'all'
                ? 'No subscriptions match your filters.'
                : 'No subscriptions found.'}
            </div>
          ) : (
            <Table responsive hover className="align-middle">
              <thead>
                <tr>
                  <th style={{ width: '14%' }}>Username</th>
                  <th style={{ width: '22%' }}>Strategy</th>
                  <th style={{ width: '11%' }}>Broker</th>
                  <th style={{ width: '13%' }}>Capital</th>
                  <th style={{ width: '10%' }}>Paper</th>
                  <th style={{ width: '12%' }}>Status</th>
                  <th style={{ width: '18%' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {pagedGroups.map((group, groupIndex) => (
                  group.subscriptions.length === 0 ? (
                    // No subscriptions row
                    <tr key={`${group.username}-${group.broker}-no-sub`} className={groupIndex % 2 === 0 ? 'bg-raised' : ''}>
                      <td className="font-medium">{getUserDisplayName(group.username)}</td>
                      <td className="text-ink-soft">No subscriptions configured</td>
                      <td>
                        {group.broker !== '-' && (
                          <Badge bg="primary">{group.broker}</Badge>
                        )}
                      </td>
                      <td colSpan={3}></td>
                      <td>
                        <div className="flex gap-1">
                          {canEdit && (
                            <Button
                              variant="outline-success"
                              size="sm"
                              onClick={() => handleAddClick(group.username, group.broker)}
                              title="Add Subscription"
                              disabled={group.broker === '-'}
                            >
                              <BsPlusCircle />
                            </Button>
                          )}
                          {canEdit && (
                            <Button
                              variant="primary"
                              size="sm"
                              onClick={() => handleBulkEditClick(group)}
                              title="Edit All Subscriptions"
                              disabled={group.broker === '-'}
                            >
                              <BsPencilSquare className="me-1" />
                              Edit All
                            </Button>
                          )}
                          {canManage && group.subscriptions.length > 0 && (
                            <Button
                              variant="outline-danger"
                              size="sm"
                              onClick={() => handleDeleteAllClick(group)}
                              title="Delete All Subscriptions"
                              disabled={group.broker === '-'}
                            >
                              <BsTrash className="me-1" />
                              Delete All
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ) : (
                    // Subscription rows for group
                    <React.Fragment key={`${group.username}-${group.broker}`}>
                      {group.subscriptions.map((sub, subIndex) => (
                        <tr
                          key={`${group.username}-${group.broker}-${sub.strategyName}`}
                          className={groupIndex % 2 === 0 ? 'bg-raised' : ''}
                        >
                          {/* Show username only on first row of group */}
                          {subIndex === 0 ? (
                            <td rowSpan={group.subscriptions.length + 1} className="font-medium align-top">
                              {getUserDisplayName(group.username)}
                            </td>
                          ) : null}
                          <td>
                            <span className="font-medium">{getStrategyDisplayName(sub.strategyName)}</span>
                          </td>
                          <td><Badge bg="primary">{sub.brokerName}</Badge></td>
                          <td className="font-medium">{formatCapital(sub.capital)}</td>
                          <td>
                            {sub.isPaperTrading ? (
                              <Badge bg="warning" text="dark" title="Paper trading — simulated orders, no real broker order">Paper</Badge>
                            ) : (
                              <span className="text-ink-soft text-[0.875em]">Live</span>
                            )}
                          </td>
                          <td>
                            {sub.isActive ? (
                              <Badge bg="success"><BsCheckCircle className="me-1" />Active</Badge>
                            ) : (
                              <Badge bg="secondary"><BsXCircle className="me-1" />Inactive</Badge>
                            )}
                          </td>
                          <td>
                            <div className="flex gap-1">
                              <Button
                                variant="outline-primary"
                                size="sm"
                                onClick={() => handleEditClick(sub)}
                                title={canEdit ? 'Edit' : 'View'}
                              >
                                {canEdit ? <BsPencil /> : <BsEye />}
                              </Button>
                              {canEdit && (sub.isActive ? (
                                <Button
                                  variant="outline-warning"
                                  size="sm"
                                  onClick={() => handleToggle(sub)}
                                  title="Deactivate"
                                  disabled={activateMutation.isPending || deactivateMutation.isPending}
                                >
                                  <BsToggleOff />
                                </Button>
                              ) : (
                                <Button
                                  variant="outline-success"
                                  size="sm"
                                  onClick={() => handleToggle(sub)}
                                  title="Activate"
                                  disabled={activateMutation.isPending || deactivateMutation.isPending}
                                >
                                  <BsToggleOn />
                                </Button>
                              ))}
                              {canManage && (
                                <Button
                                  variant="outline-danger"
                                  size="sm"
                                  onClick={() => handleDeleteClick(sub)}
                                  title="Delete"
                                >
                                  <BsTrash />
                                </Button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                      {/* Total row */}
                      <tr
                        key={`${group.username}-${group.broker}-total`}
                        className={groupIndex % 2 === 0 ? 'bg-raised' : ''}
                        style={{ borderTop: '2px solid rgb(var(--c-hairline))' }}
                      >
                        <td className="text-end font-bold text-ink-soft">Total</td>
                        <td><Badge bg="secondary">{group.broker}</Badge></td>
                        <td className="font-bold">{formatCapital(group.totalCapital)}</td>
                        <td></td>
                        <td></td>
                        <td>
                          <div className="flex gap-1">
                            {canEdit && (
                              <Button
                                variant="outline-success"
                                size="sm"
                                onClick={() => handleAddClick(group.username, group.broker)}
                                title="Add Subscription"
                              >
                                <BsPlusCircle />
                              </Button>
                            )}
                            {canEdit && (
                              <Button
                                variant="primary"
                                size="sm"
                                onClick={() => handleBulkEditClick(group)}
                                title="Edit All Subscriptions"
                              >
                                <BsPencilSquare className="me-1" />
                                Edit All
                              </Button>
                            )}
                            {canManage && group.subscriptions.length > 0 && (
                              <Button
                                variant="outline-danger"
                                size="sm"
                                onClick={() => handleDeleteAllClick(group)}
                                title="Delete All Subscriptions"
                              >
                                <BsTrash className="me-1" />
                                Delete All
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    </React.Fragment>
                  )
                ))}
              </tbody>
            </Table>
          )}
        </Card.Body>
      </Card>

      {/* Add Subscription Modal */}
      <Modal show={showAddModal} onHide={handleCloseAddModal} backdrop="static">
        <Modal.Header closeButton>
          <Modal.Title>Add Subscription for {addForUsername}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Form.Group className="mb-4">
            <Form.Label className="flex items-center">Strategy <span className="text-danger-600 dark:text-danger-400">*</span> <HelpIcon article={userSubscriptionHelpContent['userSubscription.strategyName']} /></Form.Label>
            <Select
              options={strategyOptions}
              value={strategyOptions.find(opt => opt.value === formData.strategyName) || null}
              onChange={(selected) => setFormData({ ...formData, strategyName: selected?.value || '' })}
              placeholder="Search and select strategy..."
              isClearable
              isSearchable
              classNamePrefix="react-select"
            />
          </Form.Group>
          <Form.Group className="mb-4">
            <Form.Label className="flex items-center">Broker <HelpIcon article={userSubscriptionHelpContent['userSubscription.brokerName']} /></Form.Label>
            <Select
              options={addBrokerOptions}
              value={addBrokerOptions.find((option) => option.value === formData.brokerName) || null}
              onChange={(selected) => setFormData({ ...formData, brokerName: selected?.value || '' })}
              placeholder="Search and select broker..."
              isClearable
              isSearchable
              classNamePrefix="react-select"
            />
          </Form.Group>
          <Form.Group className="mb-4">
            <Form.Label className="flex items-center">Capital <HelpIcon article={userSubscriptionHelpContent['userSubscription.capital']} /></Form.Label>
            <Form.Control
              type="number"
              step={formData.strategyName ? getCapitalGrid(formData.strategyName).step : 1}
              min={0}
              value={formData.capital || 0}
              onChange={(e) => setFormData({ ...formData, capital: parseInt(e.target.value) || 0 })}
            />
            {formData.strategyName && (() => {
              const grid = getCapitalGrid(formData.strategyName, formData.capital);
              if (grid.hint) return <Form.Text className="text-ink-soft">{grid.hint}</Form.Text>;
              if (grid.step > 1) return <Form.Text className="text-ink-soft">Step: {grid.step.toLocaleString('en-IN')}</Form.Text>;
              return null;
            })()}
          </Form.Group>
          {formData.strategyName && getStrategyEquitySettings(formData.strategyName).isEquity && (
            <>
              <Form.Group className="mb-4">
                <Form.Label className="flex items-center">Leverage Override <HelpIcon article={userSubscriptionHelpContent['userSubscription.leverage']} /></Form.Label>
                <Form.Control
                  type="number"
                  step={0.5}
                  min={getStrategyEquitySettings(formData.strategyName).minLeverage || 1}
                  max={getStrategyEquitySettings(formData.strategyName).maxLeverage || undefined}
                  placeholder={getStrategyEquitySettings(formData.strategyName).defaultLeverage
                    ? `Default: ${getStrategyEquitySettings(formData.strategyName).defaultLeverage}×`
                    : 'Strategy default'}
                  value={formData.leverage ?? ''}
                  onChange={(e) => setFormData({ ...formData, leverage: e.target.value ? Number(e.target.value) : undefined })}
                />
                <Form.Text className="text-ink-soft">
                  {getStrategyEquitySettings(formData.strategyName).minLeverage != null && getStrategyEquitySettings(formData.strategyName).maxLeverage != null
                    ? `Clamped to ${getStrategyEquitySettings(formData.strategyName).minLeverage}× – ${getStrategyEquitySettings(formData.strategyName).maxLeverage}×`
                    : 'Buying power = capital × leverage (Cash Buy always 1×)'}
                </Form.Text>
              </Form.Group>
              <Form.Group className="mb-4">
                <Form.Label className="flex items-center">Max Active Positions Override <HelpIcon article={userSubscriptionHelpContent['userSubscription.maxActivePositions']} /></Form.Label>
                <Form.Control
                  type="number"
                  min={1}
                  placeholder={getStrategyEquitySettings(formData.strategyName).defaultMaxActivePositions
                    ? `Default: ${getStrategyEquitySettings(formData.strategyName).defaultMaxActivePositions}`
                    : 'Strategy default'}
                  value={formData.maxActivePositions ?? ''}
                  onChange={(e) => setFormData({ ...formData, maxActivePositions: e.target.value ? Number(e.target.value) : undefined })}
                />
                <Form.Text className="text-ink-soft">Cap on concurrent stock positions for this user</Form.Text>
              </Form.Group>
            </>
          )}
          <Form.Group className="mb-4">
            <Form.Check
              type="switch"
              id="add-subscription-paper-trading"
              label="Paper Trading (simulate orders — no real broker order placed)"
              checked={formData.isPaperTrading ?? false}
              onChange={(e) => setFormData({ ...formData, isPaperTrading: e.target.checked })}
            />
          </Form.Group>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={handleCloseAddModal}>Cancel</Button>
          <Button
            variant="primary"
            onClick={handleCreateSubmit}
            disabled={createMutation.isPending || !formData.strategyName || !formData.brokerName}
          >
            {createMutation.isPending ? <><Spinner size="sm" className="me-2" />Creating...</> : 'Add Subscription'}
          </Button>
        </Modal.Footer>
      </Modal>

      {/* View/Edit Subscription Modal */}
      <Modal show={showEditModal} onHide={handleCloseEditModal} backdrop={!canEdit ? true : 'static'}>
        <Modal.Header closeButton>
          <Modal.Title>{canEdit ? 'Edit' : 'View'} Subscription</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Form.Group className="mb-4">
            <Form.Label>User</Form.Label>
            <Form.Control type="text" value={selectedSubscription?.username || ''} disabled />
          </Form.Group>
          <Form.Group className="mb-4">
            <Form.Label>Strategy</Form.Label>
            <Form.Control
              type="text"
              value={selectedSubscription ? getStrategyDisplayName(selectedSubscription.strategyName) : ''}
              disabled
            />
          </Form.Group>
          <Form.Group className="mb-4">
            <Form.Label>Broker</Form.Label>
            <Form.Control type="text" value={selectedSubscription?.brokerName || ''} disabled />
          </Form.Group>
          <Form.Group className="mb-4">
            <Form.Label className="flex items-center">Capital <HelpIcon article={userSubscriptionHelpContent['userSubscription.capital']} /></Form.Label>
            <Form.Control
              type="number"
              step={selectedSubscription ? getCapitalGrid(selectedSubscription.strategyName).step : 1}
              min={0}
              value={editCapital}
              onChange={(e) => setEditCapital(parseInt(e.target.value) || 0)}
              disabled={!canEdit}
            />
            {selectedSubscription && (() => {
              const grid = getCapitalGrid(selectedSubscription.strategyName, editCapital);
              if (grid.hint) return <Form.Text className="text-ink-soft">{grid.hint}</Form.Text>;
              if (grid.step > 1) return <Form.Text className="text-ink-soft">Step: {grid.step.toLocaleString('en-IN')}</Form.Text>;
              return null;
            })()}
          </Form.Group>
          <Form.Group className="mb-4">
            <Form.Check
              type="switch"
              id="edit-subscription-paper-trading"
              label="Paper Trading (simulate orders — no real broker order placed)"
              checked={editIsPaperTrading}
              onChange={(e) => setEditIsPaperTrading(e.target.checked)}
              disabled={!canEdit}
            />
          </Form.Group>

          {selectedSubscription && getStrategyEquitySettings(selectedSubscription.strategyName).isEquity && (
            <>
              <hr className="my-4" />
              <h6 className="mb-4">Equity Overrides (Optional)</h6>

              <Form.Group className="mb-4">
                <Form.Label className="flex items-center">Leverage Override <HelpIcon article={userSubscriptionHelpContent['userSubscription.leverage']} /></Form.Label>
                <Form.Control
                  type="number"
                  step={0.5}
                  min={getStrategyEquitySettings(selectedSubscription.strategyName).minLeverage || 1}
                  max={getStrategyEquitySettings(selectedSubscription.strategyName).maxLeverage || undefined}
                  placeholder={getStrategyEquitySettings(selectedSubscription.strategyName).defaultLeverage
                    ? `Default: ${getStrategyEquitySettings(selectedSubscription.strategyName).defaultLeverage}×`
                    : 'Strategy default'}
                  value={editLeverage}
                  onChange={(e) => setEditLeverage(e.target.value)}
                  disabled={!canEdit}
                />
                <Form.Text className="text-ink-soft">
                  {getStrategyEquitySettings(selectedSubscription.strategyName).minLeverage != null &&
                   getStrategyEquitySettings(selectedSubscription.strategyName).maxLeverage != null
                    ? `Clamped to ${getStrategyEquitySettings(selectedSubscription.strategyName).minLeverage}× – ${getStrategyEquitySettings(selectedSubscription.strategyName).maxLeverage}×`
                    : 'Buying power = capital × leverage (Cash Buy always 1×)'}
                </Form.Text>
              </Form.Group>

              <Form.Group className="mb-4">
                <Form.Label className="flex items-center">Max Active Positions Override <HelpIcon article={userSubscriptionHelpContent['userSubscription.maxActivePositions']} /></Form.Label>
                <Form.Control
                  type="number"
                  min={1}
                  placeholder={getStrategyEquitySettings(selectedSubscription.strategyName).defaultMaxActivePositions
                    ? `Default: ${getStrategyEquitySettings(selectedSubscription.strategyName).defaultMaxActivePositions}`
                    : 'Strategy default'}
                  value={editMaxActivePositions}
                  onChange={(e) => setEditMaxActivePositions(e.target.value)}
                  disabled={!canEdit}
                />
                <Form.Text className="text-ink-soft">Cap on concurrent stock positions for this user</Form.Text>
              </Form.Group>
            </>
          )}

          {selectedSubscription && getStrategyRiskSettings(selectedSubscription.strategyName).isRiskEnabled && (
            <>
              <hr className="my-4" />
              <h6 className="mb-4">Risk Allocation (Optional)</h6>

              <Form.Group className="mb-4">
                <Form.Label className="flex items-center">Risk Percentage Override <HelpIcon article={userSubscriptionHelpContent['userSubscription.riskPercentage']} /></Form.Label>
                <Form.Control
                  type="number"
                  value={editRiskPercentage}
                  onChange={(e) => setEditRiskPercentage(e.target.value)}
                  placeholder={getStrategyRiskSettings(selectedSubscription.strategyName).defaultRiskPct
                    ? `Default: ${getStrategyRiskSettings(selectedSubscription.strategyName).defaultRiskPct}%`
                    : 'Enter risk percentage'}
                  min={getStrategyRiskSettings(selectedSubscription.strategyName).minRiskPct || 0}
                  max={getStrategyRiskSettings(selectedSubscription.strategyName).maxRiskPct || 100}
                  step={0.1}
                  disabled={!canEdit}
                />
                <Form.Text className="text-ink-soft">
                  {getStrategyRiskSettings(selectedSubscription.strategyName).minRiskPct !== undefined &&
                   getStrategyRiskSettings(selectedSubscription.strategyName).maxRiskPct !== undefined
                    ? `Allowed range: ${getStrategyRiskSettings(selectedSubscription.strategyName).minRiskPct}% - ${getStrategyRiskSettings(selectedSubscription.strategyName).maxRiskPct}%`
                    : 'Percentage of capital as daily risk budget'}
                </Form.Text>
              </Form.Group>

              <Form.Group className="mb-4">
                <Form.Label className="flex items-center">Absolute Max Risk Override <HelpIcon article={userSubscriptionHelpContent['userSubscription.absoluteMaxRisk']} /></Form.Label>
                <Form.Control
                  type="number"
                  value={editAbsoluteMaxRisk}
                  onChange={(e) => setEditAbsoluteMaxRisk(e.target.value)}
                  placeholder="Enter absolute max risk amount"
                  min={0}
                  step={1000}
                  disabled={!canEdit}
                />
                <Form.Text className="text-ink-soft">
                  Fixed maximum risk amount in rupees (overrides percentage)
                </Form.Text>
              </Form.Group>
            </>
          )}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={handleCloseEditModal}>{canEdit ? 'Cancel' : 'Close'}</Button>
          {canEdit && (
            <Button
              variant="primary"
              onClick={handleUpdateSubmit}
              disabled={updateMutation.isPending}
            >
              {updateMutation.isPending ? <><Spinner size="sm" className="me-2" />Saving...</> : 'Save Changes'}
            </Button>
          )}
        </Modal.Footer>
      </Modal>

      {/* Delete Confirmation */}
      <ConfirmModal
        show={showDeleteConfirm}
        title="Delete Subscription"
        message={`Are you sure you want to delete subscription for strategy "${selectedSubscription ? getStrategyDisplayName(selectedSubscription.strategyName) : ''}" from user "${selectedSubscription?.username}"?`}
        confirmLabel="Delete"
        confirmVariant="danger"
        onConfirm={handleConfirmDelete}
        onCancel={() => { setShowDeleteConfirm(false); setSelectedSubscription(null); }}
        isLoading={deleteMutation.isPending}
      />

      {/* Delete All Confirmation */}
      <ConfirmModal
        show={showDeleteAllConfirm}
        title="Delete All Subscriptions"
        message={`Are you sure you want to delete ALL ${deleteAllGroup?.subscriptions.length || 0} subscriptions for user "${deleteAllGroup?.username}" - broker "${deleteAllGroup?.broker}"? This action cannot be undone.`}
        confirmLabel="Delete All"
        confirmVariant="danger"
        onConfirm={handleConfirmDeleteAll}
        onCancel={() => { setShowDeleteAllConfirm(false); setDeleteAllGroup(null); }}
        isLoading={deleteByUserMutation.isPending}
      />

      {/* Bulk Edit Modal */}
      {bulkEditGroup && (
        <BulkSubscriptionEditModal
          show={showBulkEditModal}
          username={bulkEditGroup.username}
          broker={bulkEditGroup.broker}
          userSubscriptions={bulkEditGroup.subscriptions}
          allStrategyDefinitions={strategyDefinitions}
          userBrokerConfig={users.find((u) => u.username === bulkEditGroup.username)?.brokers?.find((b) => b.broker === bulkEditGroup.broker)}
          onClose={handleCloseBulkEditModal}
          onSuccess={handleBulkEditSuccess}
        />
      )}
    </>
  );
};

// ==================== BULK SUBSCRIPTION EDIT MODAL ====================

interface BulkSubscriptionEditModalProps {
  show: boolean;
  username: string;
  broker: string;
  userSubscriptions: UserStrategySubscription[];
  allStrategyDefinitions: StrategyDefinition[];
  userBrokerConfig?: UserBrokerConfig;
  onClose: () => void;
  onSuccess: () => void;
}

// Internal subscription state for editing
interface SubscriptionEditState {
  strategyName: string;
  strategyDisplayName: string;
  displayOrder: number;
  capital: number;
  newCapital: number;
  capitalPerLot: number;
  /** Rounding grid: capitalPerLot, or capitalPerLot x maxActivePositions for watchlist strategies. */
  capitalGridUnit: number;
  isActive: boolean;
  oldIsActive: boolean;
  newIsPaperTrading: boolean;
  oldIsPaperTrading: boolean;
  subscriptionId?: number;
  isNew: boolean; // True if subscription doesn't exist for user yet
}

const BulkSubscriptionEditModal: React.FC<BulkSubscriptionEditModalProps> = ({
  show,
  username,
  broker,
  userSubscriptions,
  allStrategyDefinitions,
  userBrokerConfig,
  onClose,
  onSuccess,
}) => {
  const [subscriptions, setSubscriptions] = useState<SubscriptionEditState[]>([]);
  const [updateInProgress, setUpdateInProgress] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [strategySearch, setStrategySearch] = useState<string>('');
  const [showOnlyActive, setShowOnlyActive] = useState(false);

  // Allocation model and capital state
  const [selectedAllocationModel, setSelectedAllocationModel] = useState<string>('');
  const [allocatedCapital, setAllocatedCapital] = useState<number>(0);
  const [allocatedExternalIntradayCapital, setAllocatedExternalIntradayCapital] = useState<number>(0);
  const [allocatedExternalPositionalCapital, setAllocatedExternalPositionalCapital] = useState<number>(0);

  // Fetch allocation models
  const { data: allocationModels = [] } = useQuery<AllocationModel[]>({
    queryKey: ['allocationModels'],
    queryFn: () => allocationModelService.getAll(),
    enabled: show,
  });

  // Fetch strategies for selected allocation model
  const { data: modelStrategies = [] } = useQuery<AllocationModelStrategy[]>({
    queryKey: ['allocationModelStrategies', selectedAllocationModel],
    queryFn: () => allocationModelService.getStrategies(selectedAllocationModel),
    enabled: !!selectedAllocationModel,
  });

  // Get selected allocation model details
  const selectedModelData = useMemo(() => {
    return allocationModels.find((m) => m.name === selectedAllocationModel);
  }, [allocationModels, selectedAllocationModel]);

  // Initialize subscriptions and broker config from props
  React.useEffect(() => {
    if (!show) return;

    const subscriptionStates: SubscriptionEditState[] = [];

    // Add all strategy definitions (merge with user's existing subscriptions)
    allStrategyDefinitions.forEach((def) => {
      const userSub = userSubscriptions.find(
        (us) => us.strategyName === def.strategyName && us.brokerName === broker
      );

      subscriptionStates.push({
        strategyName: def.strategyName,
        strategyDisplayName: def.displayName || def.strategyName,
        displayOrder: def.displayOrder || 0,
        capital: userSub?.capital || 0,
        newCapital: userSub?.capital || 0,
        capitalPerLot: def.capitalPerLot || 1,
        capitalGridUnit: capitalGridFor(def).step,
        isActive: userSub?.isActive || false,
        oldIsActive: userSub?.isActive || false,
        newIsPaperTrading: userSub?.isPaperTrading || false,
        oldIsPaperTrading: userSub?.isPaperTrading || false,
        subscriptionId: userSub?.subscriptionId,
        isNew: !userSub,
      });
    });

    // Sort by display order
    subscriptionStates.sort((a, b) => a.displayOrder - b.displayOrder);

    setSubscriptions(subscriptionStates);
    setError(null);
    setStrategySearch('');
    setShowOnlyActive(false);

    // Initialize allocation model and capital from broker config
    if (userBrokerConfig) {
      setSelectedAllocationModel(userBrokerConfig.allocationModel || '');
      setAllocatedCapital(userBrokerConfig.allocatedCapital || 0);
      setAllocatedExternalIntradayCapital(userBrokerConfig.allocatedExternalIntradayCapital || 0);
      setAllocatedExternalPositionalCapital(userBrokerConfig.allocatedExternalPositionalCapital || 0);
    } else {
      setSelectedAllocationModel('');
      setAllocatedCapital(0);
      setAllocatedExternalIntradayCapital(0);
      setAllocatedExternalPositionalCapital(0);
    }
  }, [show, allStrategyDefinitions, userSubscriptions, broker, userBrokerConfig]);

  // Filter subscriptions based on search
  const filteredSubscriptions = useMemo(() => {
    return subscriptions.filter((s) => {
      if (showOnlyActive && !s.isActive) {
        return false;
      }

      if (!strategySearch.trim()) {
        return true;
      }

      const searchLower = strategySearch.toLowerCase().trim();
      return (
        s.strategyName.toLowerCase().includes(searchLower) ||
        s.strategyDisplayName.toLowerCase().includes(searchLower)
      );
    });
  }, [subscriptions, strategySearch, showOnlyActive]);

  // Handle allocation model change - recalculate all strategy capitals
  const handleAllocationModelChange = React.useCallback((modelName: string) => {
    setSelectedAllocationModel(modelName);
    // Reset allocated capital when model changes
    if (!modelName) {
      setAllocatedCapital(0);
    }
  }, []);

  // Handle allocated capital change - recalculate all strategy capitals based on model
  const applyAllocationModel = React.useCallback(() => {
    if (!selectedModelData || !modelStrategies.length || allocatedCapital <= 0) {
      return;
    }

    // Calculate multiplier: user's capital / model's base capital
    const multiplier = allocatedCapital / selectedModelData.capital;

    setSubscriptions((prev) =>
      prev.map((s) => {
        // Find this strategy in the model's strategy mappings
        const modelStrategy = modelStrategies.find((ms) => ms.strategyName === s.strategyName);

        if (modelStrategy) {
          // Calculate lots based on multiplier
          const userLots = Math.floor(modelStrategy.numOfLots * multiplier);
          // Calculate capital = lots × capitalPerLot
          const newCapital = userLots * s.capitalPerLot;
          return { ...s, newCapital, isActive: newCapital > 0 };
        }

        // Strategy not in model - set to 0
        return { ...s, newCapital: 0, isActive: false };
      })
    );
  }, [selectedModelData, modelStrategies, allocatedCapital]);

  // Calculate total capital
  const totalCapital = useMemo(() => {
    return subscriptions.reduce((sum, s) => sum + s.newCapital, 0);
  }, [subscriptions]);

  // Check if broker config has changed
  const hasBrokerConfigChanges = useMemo(() => {
    if (!userBrokerConfig) return selectedAllocationModel || allocatedCapital > 0 || allocatedExternalIntradayCapital > 0 || allocatedExternalPositionalCapital > 0;
    return (
      selectedAllocationModel !== (userBrokerConfig.allocationModel || '') ||
      allocatedCapital !== (userBrokerConfig.allocatedCapital || 0) ||
      allocatedExternalIntradayCapital !== (userBrokerConfig.allocatedExternalIntradayCapital || 0) ||
      allocatedExternalPositionalCapital !== (userBrokerConfig.allocatedExternalPositionalCapital || 0)
    );
  }, [userBrokerConfig, selectedAllocationModel, allocatedCapital, allocatedExternalIntradayCapital, allocatedExternalPositionalCapital]);

  // Handle capital change
  const handleCapitalChange = React.useCallback((strategyName: string, value: number) => {
    setSubscriptions((prev) =>
      prev.map((s) => {
        if (s.strategyName === strategyName) {
          let newCapital = value;
          // Validate against the capital grid (capitalPerLot, or x maxActivePositions for
          // watchlist strategies where capital splits per stock before lot math)
          if (s.capitalGridUnit > 0 && newCapital > 0) {
            newCapital = Math.floor(newCapital / s.capitalGridUnit) * s.capitalGridUnit;
          }
          if (newCapital < 0) newCapital = 0;
          return { ...s, newCapital };
        }
        return s;
      })
    );
  }, []);

  // Toggle active state
  const toggleActive = React.useCallback((strategyName: string) => {
    setSubscriptions((prev) =>
      prev.map((s) => {
        if (s.strategyName === strategyName) {
          return { ...s, isActive: !s.isActive };
        }
        return s;
      })
    );
  }, []);

  // Toggle paper-trading state
  const togglePaper = React.useCallback((strategyName: string) => {
    setSubscriptions((prev) =>
      prev.map((s) => {
        if (s.strategyName === strategyName) {
          return { ...s, newIsPaperTrading: !s.newIsPaperTrading };
        }
        return s;
      })
    );
  }, []);

  // Check if capital has changed
  const isCapitalChanged = React.useCallback((strategyName?: string) => {
    if (strategyName) {
      const s = subscriptions.find((sub) => sub.strategyName === strategyName);
      return s ? s.capital !== s.newCapital : false;
    }
    return subscriptions.some((s) => s.capital !== s.newCapital);
  }, [subscriptions]);

  // Check if active state has changed
  const isActiveChanged = React.useCallback(() => {
    return subscriptions.some((s) => s.isActive !== s.oldIsActive);
  }, [subscriptions]);

  // Check if paper-trading state has changed
  const isPaperChanged = React.useCallback(() => {
    return subscriptions.some((s) => s.newIsPaperTrading !== s.oldIsPaperTrading);
  }, [subscriptions]);

  // Check if any data has changed
  const hasChanges = useMemo(() => {
    return isCapitalChanged() || isActiveChanged() || isPaperChanged() || hasBrokerConfigChanges;
  }, [isCapitalChanged, isActiveChanged, isPaperChanged, hasBrokerConfigChanges]);

  // Validate capital (must be multiples of capitalPerLot)
  const getCapitalError = React.useCallback((subscription: SubscriptionEditState) => {
    if (subscription.newCapital < 0) return 'Cannot be negative';
    if (subscription.capitalPerLot > 0 && subscription.newCapital > 0 && subscription.newCapital % subscription.capitalPerLot !== 0) {
      return `Must be multiples of ${subscription.capitalPerLot.toLocaleString('en-IN')}`;
    }
    return null;
  }, []);

  // Check if update button should be disabled
  const shouldDisableUpdate = useMemo(() => {
    if (updateInProgress) return true;
    if (!hasChanges) return true;
    // Check for validation errors
    return subscriptions.some((s) => getCapitalError(s) !== null);
  }, [updateInProgress, hasChanges, subscriptions, getCapitalError]);

  // Handle update
  const handleUpdate = React.useCallback(async () => {
    setUpdateInProgress(true);
    setError(null);

    // Separate subscriptions into: to create, to update, to delete
    const toCreate: CreateUserSubscriptionRequest[] = [];
    const toUpdate: { id: number; data: UpdateUserSubscriptionRequest }[] = [];
    const toDelete: number[] = [];

    subscriptions.forEach((s) => {
      // Check if any value changed
      const hasChanged = s.capital !== s.newCapital || s.isActive !== s.oldIsActive
        || s.newIsPaperTrading !== s.oldIsPaperTrading;
      if (!hasChanged) return;

      // Existing subscription with capital set to 0 - delete it
      if (s.newCapital === 0 && !s.isNew && s.subscriptionId && s.capital > 0) {
        toDelete.push(s.subscriptionId);
        return;
      }

      // Skip new subscription with 0 capital (don't create it)
      if (s.newCapital === 0 && s.isNew) {
        return;
      }

      // New subscription - create it
      if (s.isNew && s.newCapital > 0) {
        toCreate.push({
          username,
          strategyName: s.strategyName,
          brokerName: broker,
          capital: s.newCapital,
          isActive: s.isActive,
          isPaperTrading: s.newIsPaperTrading,
        });
        return;
      }

      // Existing subscription - update it
      if (!s.isNew && s.subscriptionId) {
        toUpdate.push({
          id: s.subscriptionId,
          data: {
            capital: s.newCapital,
            isActive: s.isActive,
            isPaperTrading: s.newIsPaperTrading,
          },
        });
      }
    });

    const hasSubscriptionChanges = toCreate.length > 0 || toUpdate.length > 0 || toDelete.length > 0;

    if (!hasSubscriptionChanges && !hasBrokerConfigChanges) {
      setUpdateInProgress(false);
      setError('No changes to save');
      return;
    }

    try {
      const promises: Promise<unknown>[] = [];

      // Create new subscriptions
      toCreate.forEach((data) => {
        promises.push(userSubscriptionService.create(data));
      });

      // Update existing subscriptions
      toUpdate.forEach(({ id, data }) => {
        promises.push(userSubscriptionService.update(id, data));
      });

      // Delete subscriptions
      toDelete.forEach((id) => {
        promises.push(userSubscriptionService.delete(id));
      });

      // Update broker config if changed. The capitals MUST be sent even when 0:
      // the backend merge keeps the existing value for absent (null) fields, so
      // `0 || undefined` made zero unsendable (couldn't clear a capital).
      if (hasBrokerConfigChanges) {
        const brokerUpdate: UpdateUserBrokerRequest = {
          allocationModel: selectedAllocationModel || undefined,
          allocatedCapital,
          allocatedExternalIntradayCapital,
          allocatedExternalPositionalCapital,
        };
        promises.push(userBrokerService.updateUserBroker(username, broker, brokerUpdate));
      }

      await Promise.all(promises);

      setUpdateInProgress(false);
      const messages: string[] = [];
      if (hasSubscriptionChanges) {
        messages.push(`Created ${toCreate.length}, updated ${toUpdate.length}, deleted ${toDelete.length} subscriptions`);
      }
      if (hasBrokerConfigChanges) {
        messages.push('Broker config updated');
      }
      toast.success(messages.join('. '));
      onSuccess();
    } catch (err) {
      setUpdateInProgress(false);
      const error = err as { message?: string };
      setError(error.message || 'Failed to save changes');
      toast.error(error.message || 'Failed to save changes');
    }
  }, [subscriptions, username, broker, onSuccess, hasBrokerConfigChanges, selectedAllocationModel, allocatedCapital, allocatedExternalIntradayCapital, allocatedExternalPositionalCapital]);

  // Format capital display
  const formatCapital = (capital: number) => {
    return capital.toLocaleString('en-IN');
  };

  return (
    <Modal show={show} onHide={onClose} size="xl" scrollable backdrop="static">
      <Modal.Header closeButton>
        <Modal.Title className="flex items-center gap-2">
          <BsPencilSquare />
          Edit Subscriptions for {username} ({broker})
        </Modal.Title>
      </Modal.Header>
      <Modal.Body>
        {/* Allocation Model & Capital Section */}
        <Card className="mb-4 border-primary-500">
          <Card.Header className="bg-primary-500 text-white py-2">
            <strong>Allocation Model Configuration</strong>
          </Card.Header>
          <Card.Body>
            <Row className="mb-4">
              <Col md={4}>
                <Form.Group>
                  <Form.Label className="font-bold flex items-center">Allocation Model <HelpIcon article={userSubscriptionHelpContent['userSubscription.allocationModel']} /></Form.Label>
                  <Form.Select
                    value={selectedAllocationModel}
                    onChange={(e) => handleAllocationModelChange(e.target.value)}
                    disabled={updateInProgress}
                  >
                    <option value="">-- Select Allocation Model --</option>
                    {allocationModels.map((m) => (
                      <option key={m.name} value={m.name}>
                        {m.name} (Base: {formatCapital(m.capital)})
                      </option>
                    ))}
                  </Form.Select>
                  <Form.Text className="text-ink-soft">
                    Select a model to auto-calculate strategy capitals
                  </Form.Text>
                </Form.Group>
              </Col>
              <Col md={4}>
                <Form.Group>
                  <Form.Label className="font-bold flex items-center">Allocated Capital <HelpIcon article={userSubscriptionHelpContent['userSubscription.allocatedCapital']} /></Form.Label>
                  <InputGroup>
                    <InputGroup.Text>₹</InputGroup.Text>
                    <Form.Control
                      type="number"
                      step={selectedModelData?.capital || 100000}
                      min={0}
                      value={allocatedCapital}
                      onChange={(e) => setAllocatedCapital(parseInt(e.target.value) || 0)}
                      disabled={updateInProgress || !selectedAllocationModel}
                    />
                  </InputGroup>
                  {selectedModelData && (
                    <Form.Text className="text-ink-soft">
                      Step: {formatCapital(selectedModelData.capital)} | Multiplier: {allocatedCapital > 0 ? (allocatedCapital / selectedModelData.capital).toFixed(1) : 0}x
                    </Form.Text>
                  )}
                </Form.Group>
              </Col>
              <Col md={4} className="flex items-end">
                <Button
                  variant="primary"
                  onClick={applyAllocationModel}
                  disabled={updateInProgress || !selectedAllocationModel || allocatedCapital <= 0}
                  className="mb-4"
                >
                  Apply to Strategies
                </Button>
              </Col>
            </Row>
            <Row>
              <Col md={4}>
                <Form.Group>
                  <Form.Label className="font-bold flex items-center">External Intraday Capital <HelpIcon article={userSubscriptionHelpContent['userSubscription.allocatedExternalIntradayCapital']} /></Form.Label>
                  <InputGroup>
                    <InputGroup.Text>₹</InputGroup.Text>
                    <Form.Control
                      type="number"
                      min={0}
                      step={100000}
                      value={allocatedExternalIntradayCapital}
                      onChange={(e) => setAllocatedExternalIntradayCapital(parseInt(e.target.value) || 0)}
                      disabled={updateInProgress}
                    />
                  </InputGroup>
                  <Form.Text className="text-ink-soft">
                    External intraday capital for reports (step: 1L)
                  </Form.Text>
                </Form.Group>
              </Col>
              <Col md={4}>
                <Form.Group>
                  <Form.Label className="font-bold flex items-center">External Positional Capital <HelpIcon article={userSubscriptionHelpContent['userSubscription.allocatedExternalPositionalCapital']} /></Form.Label>
                  <InputGroup>
                    <InputGroup.Text>₹</InputGroup.Text>
                    <Form.Control
                      type="number"
                      min={0}
                      step={100000}
                      value={allocatedExternalPositionalCapital}
                      onChange={(e) => setAllocatedExternalPositionalCapital(parseInt(e.target.value) || 0)}
                      disabled={updateInProgress}
                    />
                  </InputGroup>
                  <Form.Text className="text-ink-soft">
                    External positional capital for reports (step: 1L)
                  </Form.Text>
                </Form.Group>
              </Col>
            </Row>
          </Card.Body>
        </Card>

        {/* Strategy Search */}
        <Row className="mb-4">
          <Col md={6}>
            <Form.Group>
              <Form.Label className="font-bold">Search Strategy</Form.Label>
              <InputGroup>
                <InputGroup.Text>
                  <BsSearch />
                </InputGroup.Text>
                <Form.Control
                  type="text"
                  placeholder="Filter strategies..."
                  value={strategySearch}
                  onChange={(e) => setStrategySearch(e.target.value)}
                  disabled={updateInProgress}
                />
              </InputGroup>
              <Form.Text className="text-ink-soft">
                Showing {filteredSubscriptions.length} of {subscriptions.length} strategies
              </Form.Text>
            </Form.Group>
          </Col>
          <Col md={6} className="flex items-end">
            <Form.Check
              type="checkbox"
              id="bulk-subscriptions-show-only-active"
              label="Show only active subscriptions"
              checked={showOnlyActive}
              onChange={(e) => setShowOnlyActive(e.target.checked)}
              disabled={updateInProgress}
              className="mb-2"
            />
          </Col>
        </Row>

        {/* Subscriptions Table */}
        <Table responsive size="sm" className="align-middle">
          <thead>
            <tr>
              <th style={{ width: '36%' }}>Strategy</th>
              <th style={{ width: '18%' }}>Current Capital</th>
              <th style={{ width: '22%' }}>New Capital</th>
              <th style={{ width: '12%' }} className="text-center" title="Paper trading — simulate orders, no real broker order">Paper</th>
              <th style={{ width: '12%' }} className="text-center">Active</th>
            </tr>
          </thead>
          <tbody>
            {filteredSubscriptions.map((subscription) => {
              const capitalError = getCapitalError(subscription);

              return (
                <tr key={subscription.strategyName} className={subscription.isNew ? 'bg-raised' : ''}>
                  <td>
                    <div className="font-medium">{subscription.strategyDisplayName}</div>
                    {subscription.strategyDisplayName !== subscription.strategyName && (
                      <small className="text-ink-soft">{subscription.strategyName}</small>
                    )}
                    {subscription.isNew && (
                      <Badge bg="info" className="ms-1">New</Badge>
                    )}
                  </td>
                  <td className="text-ink-soft">
                    {formatCapital(subscription.capital)}
                  </td>
                  <td>
                    <Form.Control
                      type="number"
                      step={subscription.capitalPerLot || 1}
                      min={0}
                      value={subscription.newCapital}
                      onChange={(e) => handleCapitalChange(subscription.strategyName, parseInt(e.target.value) || 0)}
                      disabled={updateInProgress}
                      className={isCapitalChanged(subscription.strategyName) ? 'text-success-500 dark:text-success-400 border-success-500' : ''}
                      isInvalid={!!capitalError}
                      size="sm"
                    />
                    {capitalError && (
                      <Form.Text className="text-danger-600 dark:text-danger-400">{capitalError}</Form.Text>
                    )}
                  </td>
                  <td className="text-center">
                    <Form.Check
                      type="checkbox"
                      checked={subscription.newIsPaperTrading}
                      onChange={() => togglePaper(subscription.strategyName)}
                      disabled={updateInProgress}
                      className={subscription.newIsPaperTrading !== subscription.oldIsPaperTrading ? 'text-warning-700 dark:text-warning-400' : ''}
                      title="Paper trading"
                    />
                  </td>
                  <td className="text-center">
                    <Form.Check
                      type="checkbox"
                      checked={subscription.isActive}
                      onChange={() => toggleActive(subscription.strategyName)}
                      disabled={updateInProgress}
                      className={subscription.isActive !== subscription.oldIsActive ? 'text-success-500 dark:text-success-400' : ''}
                    />
                  </td>
                </tr>
              );
            })}
            {/* Total Row */}
            <tr className="bg-raised font-bold">
              <td>TOTAL</td>
              <td></td>
              <td>{formatCapital(totalCapital)}</td>
              <td></td>
              <td></td>
            </tr>
          </tbody>
        </Table>

        {/* Error Message */}
        {error && (
          <div className="mb-3 rounded border px-3 py-2 text-sm border-danger-500/30 bg-danger-500/10 text-danger-700 dark:text-danger-300 mt-4">{error}</div>
        )}

        {/* Update Progress */}
        {updateInProgress && (
          <div className="text-center mt-4">
            <Spinner size="sm" className="me-2" />
            Updating subscriptions... Please wait.
          </div>
        )}
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={onClose} disabled={updateInProgress}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={handleUpdate}
          disabled={shouldDisableUpdate}
        >
          {updateInProgress ? (
            <>
              <Spinner size="sm" className="me-1" />
              Updating...
            </>
          ) : (
            'Update Subscriptions'
          )}
        </Button>
      </Modal.Footer>
    </Modal>
  );
};

export default UserSubscriptions;
