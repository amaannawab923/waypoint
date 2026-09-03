import type { Cycle, StateGroup, WorkItem, WorkItemState } from '@/types/entities';

export type CycleStatus = 'active' | 'upcoming' | 'completed';

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function endOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
}

/** Active = today falls between start and end date (inclusive), Upcoming = starts later, Completed = already ended. */
export function getCycleStatus(cycle: Cycle, today: Date = new Date()): CycleStatus {
  const start = startOfDay(new Date(cycle.startDate));
  const end = endOfDay(new Date(cycle.endDate));
  if (today < start) return 'upcoming';
  if (today > end) return 'completed';
  return 'active';
}

/**
 * Returns the first existing cycle whose date range overlaps the given [startDate, endDate]
 * range (inclusive), or null if there's no conflict. Pass `excludeId` when checking an edit to
 * an existing cycle so it doesn't overlap-check against itself.
 */
export function findOverlappingCycle(
  cycles: Cycle[],
  startDate: string,
  endDate: string,
  excludeId?: string,
): Cycle | null {
  if (!startDate || !endDate) return null;
  for (const cycle of cycles) {
    if (cycle.id === excludeId) continue;
    if (startDate <= cycle.endDate && cycle.startDate <= endDate) return cycle;
  }
  return null;
}

export function formatDateRange(startDate: string, endDate: string): string {
  const start = new Date(startDate);
  const end = new Date(endDate);
  const sameYear = start.getFullYear() === end.getFullYear();
  const fmt = (d: Date, withYear: boolean) =>
    d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: withYear ? 'numeric' : undefined });
  return `${fmt(start, !sameYear)} – ${fmt(end, true)}`;
}

const BREAKDOWN_ORDER: StateGroup[] = ['backlog', 'unstarted', 'started', 'completed', 'cancelled'];
export { BREAKDOWN_ORDER };

export type Breakdown = Record<StateGroup, number>;

export function computeBreakdown(items: WorkItem[], states: WorkItemState[]): Breakdown {
  const stateById = new Map(states.map((s) => [s.id, s]));
  const counts: Breakdown = { backlog: 0, unstarted: 0, started: 0, completed: 0, cancelled: 0, triage: 0 };
  for (const item of items) {
    const state = stateById.get(item.stateId);
    if (state) counts[state.group] += 1;
  }
  return counts;
}

export interface CycleProgress {
  completed: number;
  total: number;
  percent: number;
}

export function computeProgress(items: WorkItem[], states: WorkItemState[]): CycleProgress {
  const breakdown = computeBreakdown(items, states);
  const total = items.length;
  const completed = breakdown.completed;
  const percent = total === 0 ? 0 : Math.round((completed / total) * 100);
  return { completed, total, percent };
}

/** The color representing a state group, taken from the first matching state configured on the project. */
export function stateGroupColor(states: WorkItemState[], group: StateGroup): string {
  return states.find((s) => s.group === group)?.color ?? 'var(--text-muted)';
}

export interface BurndownPoint {
  date: string;
  ideal: number;
  current: number | null;
}

/**
 * Ideal line: linear decrease from total item count on day 0 to 0 on the cycle's last day.
 * Current: exactly two real, unconnected data points — the cycle's starting total on day 0,
 * and today's actual remaining/non-completed count on today's index. There is no per-day
 * history recorded, so the chart (CycleStatsPanel) must render these as isolated markers,
 * never joined into a line — a joined line would read as daily tracking that doesn't exist.
 * See CAPABILITIES['sprints.burndown'].
 */
export function buildBurndownData(cycle: Cycle, items: WorkItem[], states: WorkItemState[], today: Date = new Date()): BurndownPoint[] {
  const stateById = new Map(states.map((s) => [s.id, s]));
  const dayMs = 24 * 60 * 60 * 1000;
  const startDay = startOfDay(new Date(cycle.startDate));
  const endDay = startOfDay(new Date(cycle.endDate));
  const todayDay = startOfDay(today);
  const totalDays = Math.max(1, Math.round((endDay.getTime() - startDay.getTime()) / dayMs));
  const total = items.length;

  const remainingNow = items.filter((item) => stateById.get(item.stateId)?.group !== 'completed').length;
  // Clamp "today" onto the cycle's own timeline so upcoming/completed cycles still render sensibly.
  const clampedToday = new Date(Math.min(Math.max(todayDay.getTime(), startDay.getTime()), endDay.getTime()));
  const todayIndex = Math.round((clampedToday.getTime() - startDay.getTime()) / dayMs);

  const points: BurndownPoint[] = [];
  for (let d = 0; d <= totalDays; d++) {
    const day = new Date(startDay.getTime() + d * dayMs);
    const ideal = Math.max(0, Math.round(((total - (total * d) / totalDays) + Number.EPSILON) * 10) / 10);
    let current: number | null = null;
    if (d === 0) current = total;
    if (d === todayIndex) current = remainingNow;
    points.push({
      date: day.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
      ideal,
      current,
    });
  }
  return points;
}
