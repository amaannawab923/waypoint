import { useMemo } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { Cycle, Ticket, TicketState } from '@/types/entities';
import { STATE_GROUP_LABEL } from '@/components/domain/StateIcon';
import { Dot } from '@/components/ui/Badge';
import { NotWired } from '@/components/ui/NotWired';
import { BREAKDOWN_ORDER, buildBurndownData, computeBreakdown, computeProgress, stateGroupColor } from './cycle-utils';

/**
 * Progress ring + state-group breakdown + burndown chart for a single cycle's tickets.
 * Shared between the featured "active cycle" card on CyclesPage and the full CycleDetailPage.
 */
export function CycleStatsPanel({
  cycle,
  items,
  states,
  chartHeight = 200,
}: {
  cycle: Cycle;
  items: Ticket[];
  states: TicketState[];
  chartHeight?: number;
}) {
  const progress = useMemo(() => computeProgress(items, states), [items, states]);
  const breakdown = useMemo(() => computeBreakdown(items, states), [items, states]);
  const burndown = useMemo(() => buildBurndownData(cycle, items, states), [cycle, items, states]);
  const total = items.length;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-4">
        <div
          className="relative flex size-14 shrink-0 items-center justify-center rounded-full"
          style={{ background: `conic-gradient(var(--accent) ${progress.percent * 3.6}deg, var(--surface-2) 0deg)` }}
        >
          <div className="flex size-11 items-center justify-center rounded-full bg-surface font-display text-sm font-medium text-text">
            {progress.percent}%
          </div>
        </div>
        <div>
          <p className="text-sm font-medium text-text">
            {progress.completed} of {total} done
          </p>
          <p className="text-xs text-text-muted">Tickets completed in this cycle</p>
        </div>
      </div>

      {total === 0 ? (
        <p className="text-xs text-text-muted">No tickets assigned to this cycle yet.</p>
      ) : (
        <>
          <div className="space-y-2">
            <div className="flex h-2 overflow-hidden rounded-full bg-surface-2">
              {BREAKDOWN_ORDER.filter((g) => breakdown[g] > 0).map((g) => (
                <div key={g} style={{ width: `${(breakdown[g] / total) * 100}%`, background: stateGroupColor(states, g) }} />
              ))}
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              {BREAKDOWN_ORDER.map((g) => (
                <div key={g} className="flex items-center gap-1.5 text-xs text-text-secondary">
                  <Dot color={stateGroupColor(states, g)} />
                  {STATE_GROUP_LABEL[g]}
                  <span className="font-mono text-text-muted">{breakdown[g]}</span>
                </div>
              ))}
            </div>
          </div>

          <div>
            <div className="mb-2 flex items-center gap-4 text-xs text-text-secondary">
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-0.5 w-3 rounded-full" style={{ background: 'var(--text-muted)' }} />
                Ideal
              </span>
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-0.5 w-3 rounded-full" style={{ background: 'var(--accent)' }} />
                Current
              </span>
            </div>
            <div style={{ width: '100%', height: chartHeight }}>
              <ResponsiveContainer>
                <LineChart data={burndown} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                  <CartesianGrid stroke="var(--border)" vertical={false} />
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
                    tickLine={false}
                    axisLine={{ stroke: 'var(--border)' }}
                    interval="preserveStartEnd"
                    minTickGap={24}
                  />
                  <YAxis tick={{ fontSize: 11, fill: 'var(--text-muted)' }} tickLine={false} axisLine={false} allowDecimals={false} width={28} />
                  <Tooltip
                    contentStyle={{
                      background: 'var(--surface)',
                      border: '1px solid var(--border)',
                      borderRadius: 'var(--radius-sm)',
                      fontSize: 12,
                    }}
                    labelStyle={{ color: 'var(--text)' }}
                  />
                  <Line type="monotone" dataKey="ideal" name="Ideal" stroke="var(--text-muted)" strokeDasharray="4 3" strokeWidth={2} dot={false} isAnimationActive={false} />
                  {/* No `connectNulls`: only the sprint-start and today counts are real, and
                      joining them into a line would read as daily tracking that was never
                      recorded. `dot` marks just those two points; `strokeWidth={0}` keeps
                      recharts from drawing any segment between them. */}
                  <Line
                    type="monotone"
                    dataKey="current"
                    name="Current"
                    stroke="var(--accent)"
                    strokeWidth={0}
                    dot={{ r: 4, fill: 'var(--accent)', strokeWidth: 0 }}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-3">
              <NotWired capability="sprints.burndown" />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
