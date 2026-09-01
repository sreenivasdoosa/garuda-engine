import { useState } from 'react';
import { BsFileCode, BsGear } from 'react-icons/bs';
import clsx from 'clsx';

import { PageHeader } from '@/components/common';
import EngineMonitor from './EngineMonitor';
import StrategyTemplates from './StrategyTemplates';
import StrategyDefinitions from './StrategyDefinitions';

const TABS = [
  { key: 'templates', label: 'Templates', icon: <BsFileCode /> },
  { key: 'definitions', label: 'Definitions', icon: <BsGear /> },
];

const StrategyEnginePage: React.FC = () => {
  const [activeTab, setActiveTab] = useState('definitions');

  return (
    <div className="fade-in">
      <PageHeader title="Strategy Engine" subtitle="Event-driven strategy execution engine management" />

      {/* Engine Monitor (always visible) */}
      <EngineMonitor compact />

      {/* Tabbed interface for sub-sections */}
      <div className="mb-3 flex flex-wrap gap-1 border-b border-hairline">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setActiveTab(t.key)}
            className={clsx(
              '-mb-px flex items-center gap-2 border-b-2 px-4 py-2 text-sm font-medium transition-colors',
              activeTab === t.key ? 'border-primary-500 text-primary-500' : 'border-transparent text-ink-soft hover:text-ink',
            )}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>
      {activeTab === 'templates' ? <StrategyTemplates /> : <StrategyDefinitions />}
    </div>
  );
};

export default StrategyEnginePage;
