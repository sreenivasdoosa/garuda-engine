/**
 * RiskProfileChart Component
 * Displays risk profile at different index movement levels
 * Supports toggle between Algo and Broker positions with percentage display
 */

import React, { useMemo, useState } from 'react';
import { Bar } from 'react-chartjs-2';
import clsx from 'clsx';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  Title,
  Tooltip,
  Legend,
} from 'chart.js';
import { useChartTheme } from '@/hooks/useChartTheme';

// Register Chart.js components
ChartJS.register(CategoryScale, LinearScale, BarElement, Title, Tooltip, Legend);

type RiskProfileSource = 'algo' | 'broker';

interface RiskProfileChartProps {
  /** Risk profile based on Algo positions */
  riskProfile: Record<string, number>;
  /** Risk profile based on Broker positions */
  brokerRiskProfile?: Record<string, number>;
  /** Algo deployed capital (for percentage calculation) */
  algoCapital?: number;
  /** External capital (added to algo capital for broker percentage) */
  externalCapital?: number;
  height?: number;
  /** Unique ID prefix for toggle buttons (to avoid conflicts with multiple instances) */
  id?: string;
  /** Algo-only mode: render just the algo risk profile with no Algo/Broker toggle. Used by the
   *  admin terminal when the viewer lacks ALGO_BROKER_COMPARE. Default false (show both). */
  algoOnly?: boolean;
}

const RiskProfileChart: React.FC<RiskProfileChartProps> = ({
  riskProfile,
  brokerRiskProfile,
  algoCapital = 0,
  externalCapital = 0,
  height = 200,
  algoOnly = false,
}) => {
  const [source, setSource] = useState<RiskProfileSource>('broker');
  const chartTheme = useChartTheme();
  // In algo-only mode the toggle is hidden and we always show the algo profile.
  const effectiveSource: RiskProfileSource = algoOnly ? 'algo' : source;

  // Select which risk profile to display
  const activeRiskProfile = effectiveSource === 'algo' ? riskProfile : (brokerRiskProfile || {});

  // Calculate capital for percentage based on source
  const capitalForPercent = effectiveSource === 'algo'
    ? algoCapital
    : algoCapital + externalCapital;

  const chartData = useMemo(() => {
    // Expected keys: "-10", "-7.5", "-5", "-2.5", "0", "2.5", "5", "7.5", "10"
    const sortedKeys = Object.keys(activeRiskProfile)
      .map(k => parseFloat(k))
      .sort((a, b) => a - b)
      .map(k => k.toString());

    const labels = sortedKeys.map(k => `${k}%`);
    const values = sortedKeys.map(k => activeRiskProfile[k] || 0);

    const backgroundColors = values.map(v => {
      if (v > 0) return 'rgba(40, 167, 69, 0.7)';  // Green
      if (v < 0) return 'rgba(220, 53, 69, 0.7)'; // Red
      return 'rgba(108, 117, 125, 0.5)';          // Gray
    });

    const borderColors = values.map(v => {
      if (v > 0) return 'rgba(40, 167, 69, 1)';
      if (v < 0) return 'rgba(220, 53, 69, 1)';
      return 'rgba(108, 117, 125, 1)';
    });

    return {
      labels,
      datasets: [
        {
          label: `P&L at Index Movement (${effectiveSource === 'algo' ? 'Algo' : 'Broker'})`,
          data: values,
          backgroundColor: backgroundColors,
          borderColor: borderColors,
          borderWidth: 1,
          borderRadius: 4,
        },
      ],
    };
  }, [activeRiskProfile, effectiveSource]);

  // Calculate percentage values for table
  const tableData = useMemo(() => {
    const sortedKeys = Object.keys(activeRiskProfile)
      .map(k => parseFloat(k))
      .sort((a, b) => a - b)
      .map(k => k.toString());

    return sortedKeys.map(k => {
      const pnl = activeRiskProfile[k] || 0;
      const percent = capitalForPercent > 0 ? (pnl / capitalForPercent) * 100 : 0;
      return {
        movement: k,
        pnl,
        percent,
      };
    });
  }, [activeRiskProfile, capitalForPercent]);

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        display: false,
      },
      tooltip: {
        callbacks: {
          label: (context: { raw: number; dataIndex: number }) => {
            const value = context.raw;
            const percent = capitalForPercent > 0 ? (value / capitalForPercent) * 100 : 0;
            return [
              `P&L: ₹${value.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`,
              `${percent >= 0 ? '+' : ''}${percent.toFixed(2)}% of Capital`,
            ];
          },
        },
      },
    },
    scales: {
      x: {
        grid: {
          display: false,
        },
        ticks: { color: chartTheme.axisTick },
        title: {
          display: true,
          text: 'Index Movement',
          color: chartTheme.axisTick,
          font: { size: 10 },
        },
      },
      y: {
        grid: {
          color: chartTheme.grid,
        },
        ticks: {
          color: chartTheme.axisTick,
          callback: (value: number) => {
            if (Math.abs(value) >= 100000) {
              return `₹${(value / 100000).toFixed(1)}L`;
            }
            if (Math.abs(value) >= 1000) {
              return `₹${(value / 1000).toFixed(0)}K`;
            }
            return `₹${value}`;
          },
        },
      },
    },
  };

  const hasAlgoData = Object.keys(riskProfile).length > 0;
  const hasBrokerData = !algoOnly && brokerRiskProfile && Object.keys(brokerRiskProfile).length > 0;

  if (!hasAlgoData && !hasBrokerData) {
    return (
      <div className="py-3 text-center text-ink-soft" style={{ height }}>
        No risk profile data
      </div>
    );
  }

  const toggleBtn = (val: RiskProfileSource, label: string, disabled: boolean) => (
    <button
      type="button"
      disabled={disabled}
      onClick={() => setSource(val)}
      className={clsx(
        'px-3 py-1 text-sm transition-colors',
        source === val ? 'bg-primary-500 text-white' : 'text-ink hover:bg-raised',
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      {label}
    </button>
  );

  return (
    <div>
      {/* Toggle between Algo and Broker — hidden in algo-only mode */}
      <div className="mb-3 flex items-center justify-between">
        {!algoOnly && (
          <div className="inline-flex divide-x divide-hairline overflow-hidden rounded border border-hairline">
            {toggleBtn('broker', 'Broker Positions', !hasBrokerData)}
            {toggleBtn('algo', 'Algo Positions', !hasAlgoData)}
          </div>
        )}
        <small className="text-ink-soft">
          Capital: ₹{capitalForPercent.toLocaleString('en-IN')}
          {effectiveSource === 'broker' && externalCapital > 0 && <span className="ml-1">(incl. ₹{externalCapital.toLocaleString('en-IN')} ext.)</span>}
        </small>
      </div>

      {/* Chart */}
      <div style={{ height }}>
        <Bar data={chartData} options={options as never} />
      </div>

      {/* Table with P&L and Percentage */}
      <div className="mt-3 overflow-x-auto">
        <table className="w-full border border-hairline text-xs [&_td]:border [&_td]:border-hairline [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-hairline [&_th]:px-2 [&_th]:py-1">
          <thead className="bg-raised text-ink-faint">
            <tr>
              <th className="text-center">Index Move</th>
              {tableData.map((d) => (
                <th key={d.movement} className="text-center">
                  {d.movement}%
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="text-center font-medium text-ink">P&L (₹)</td>
              {tableData.map((d) => (
                <td key={d.movement} className={clsx('text-center tabular-nums', d.pnl > 0 ? 'text-success-500' : d.pnl < 0 ? 'text-danger-500' : 'text-ink')}>
                  {d.pnl >= 0 ? '+' : ''}
                  {d.pnl.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                </td>
              ))}
            </tr>
            <tr>
              <td className="text-center font-medium text-ink">% of Capital</td>
              {tableData.map((d) => (
                <td key={d.movement} className={clsx('text-center tabular-nums', d.percent > 0 ? 'text-success-500' : d.percent < 0 ? 'text-danger-500' : 'text-ink')}>
                  {d.percent >= 0 ? '+' : ''}
                  {d.percent.toFixed(2)}%
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default RiskProfileChart;
