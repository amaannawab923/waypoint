import { parseISO } from 'date-fns';
import type { Sprint, StateGroup, Ticket, TicketState } from '@/types/entities';

export type SprintStatus = 'active' | 'upcoming' | 'completed';

/**
 * Sprint `startDate`/`endDate` are Drizzle `date()` columns, so the API returns bare
 * `yyyy-MM-dd` strings. `new Date(str)` parses a date-only string as UTC midnight, but every
 * reader in this module (and its callers) works in local time — `startOfDay`/`endOfDay`, and
 * `toLocaleDateString` further down. For any timezone west of UTC that silently shifts every
 * sprint date a day earlier (e.g. `endDate: '2026-09-10'` resolving to Sep 9 locally). `date-fns`'
 * `parseISO` resolves a date-only string against local time instead, avoiding the mismatch —
 * see `DatePicker.tsx`, which documents and works around the identical hazard. Centralized
 * here so every sprint-date-to-Date conversion (in this file and its callers) goes through the
 * same fix instead of each re-deriving it and drifting out of sync.
 */
export function parseSprintDate(value: string): Date {
  return parseISO(value);
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function endOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
}

/** Active = today falls between start and end date (inclusive), Upcoming = starts later, Completed = already ended. */
export function getSprintStatus(sprint: Sprint, today: Date = new Date()): SprintStatus {
  const start = startOfDay(parseSprintDate(sprint.startDate));
  const end = endOfDay(parseSprintDate(sprint.endDate));
  if (today < start) return 'upcoming';
  if (today > end) return 'completed';
  return 'active';
}

/**
 * Returns the first existing sprint whose date range overlaps the given [startDate, endDate]
 * range (inclusive), or null if there's no conflict. Pass `excludeId` when checking an edit to
 * an existing sprint so it doesn't overlap-check against itself.
 */
export function findOverlappingSprint(
  sprints: Sprint[],
  startDate: string,
  endDate: string,
  excludeId?: string,
): Sprint | null {
  if (!startDate || !endDate) return null;
  for (const sprint of sprints) {
    if (sprint.id === excludeId) continue;
    if (startDate <= sprint.endDate && sprint.startDate <= endDate) return sprint;
  }
  return null;
}

export function formatDateRange(startDate: string, endDate: string): string {
  const start = parseSprintDate(startDate);
  const end = parseSprintDate(endDate);
  const sameYear = start.getFullYear() === end.getFullYear();
  const fmt = (d: Date, withYear: boolean) =>
    d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: withYear ? 'numeric' : undefined });
  return `${fmt(start, !sameYear)} – ${fmt(end, true)}`;
}

const BREAKDOWN_ORDER: StateGroup[] = ['backlog', 'unstarted', 'started', 'completed', 'cancelled'];
export { BREAKDOWN_ORDER };

export type Breakdown = Record<StateGroup, number>;

export function computeBreakdown(items: Ticket[], states: TicketState[]): Breakdown {
  const stateById = new Map(states.map((s) => [s.id, s]));
  const counts: Breakdown = { backlog: 0, unstarted: 0, started: 0, completed: 0, cancelled: 0 };
  for (const item of items) {
    const state = stateById.get(item.stateId);
    if (state) counts[state.group] += 1;
  }
  return counts;
}

export interface SprintProgress {
  completed: number;
  total: number;
  percent: number;
}

export function computeProgress(items: Ticket[], states: TicketState[]): SprintProgress {
  const breakdown = computeBreakdown(items, states);
  const total = items.length;
  const completed = breakdown.completed;
  const percent = total === 0 ? 0 : Math.round((completed / total) * 100);
  return { completed, total, percent };
}

/** The color representing a state group, taken from the first matching state configured on the project. */
export function stateGroupColor(states: TicketState[], group: StateGroup): string {
  return states.find((s) => s.group === group)?.color ?? 'var(--text-muted)';
}

export interface BurndownPoint {
  date: string;
  ideal: number;
  current: number | null;
}

/**
 * Ideal line: linear decrease from total item count on day 0 to 0 on the sprint's last day.
 * Current: exactly two real, unconnected data points — the sprint's starting total on day 0,
 * and today's actual remaining/non-completed count on today's index. There is no per-day
 * history recorded, so the chart (SprintStatsPanel) must render these as isolated markers,
 * never joined into a line — a joined line would read as daily tracking that doesn't exist.
 * See CAPABILITIES['sprints.burndown'].
 */
export function buildBurndownData(sprint: Sprint, items: Ticket[], states: TicketState[], today: Date = new Date()): BurndownPoint[] {
  const stateById = new Map(states.map((s) => [s.id, s]));
  const dayMs = 24 * 60 * 60 * 1000;
  const startDay = startOfDay(parseSprintDate(sprint.startDate));
  const endDay = startOfDay(parseSprintDate(sprint.endDate));
  const todayDay = startOfDay(today);
  const totalDays = Math.max(1, Math.round((endDay.getTime() - startDay.getTime()) / dayMs));
  const total = items.length;

  const remainingNow = items.filter((item) => stateById.get(item.stateId)?.group !== 'completed').length;
  // Clamp "today" onto the sprint's own timeline so upcoming/completed sprints still render sensibly.
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
