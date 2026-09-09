import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { CAPABILITIES } from '@/capabilities';
import type { Sprint, Ticket, TicketState } from '@/types/entities';
import { SprintStatsPanel } from './SprintStatsPanel';

const STATE: TicketState = {
  id: 'state-1',
  projectId: 'proj-1',
  name: 'In Progress',
  group: 'started',
  color: '#5865f2',
  isDefault: true,
  sortOrder: 0,
};

const STATES: TicketState[] = [STATE];

const TICKETS: Ticket[] = [
  {
    id: 'tick-1',
    projectId: 'proj-1',
    identifier: 'WAY-1',
    sequenceId: 1,
    title: 'Ship the thing',
    description: '',
    stateId: STATE.id,
    priority: 'medium',
    source: 'manual',
    assigneeIds: [],
    labelIds: [],
    workstreamId: null,
    sprintId: 'spr-1',
    parentId: null,
    estimatePoints: null,
    estimateValue: null,
    startDate: null,
    dueDate: null,
    createdById: 'mem-1',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    attachmentCount: 0,
    linkCount: 0,
    links: [],
    isDraft: false,
  },
];

function toDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function daysFromNow(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return toDateOnly(d);
}

function sprint(overrides: Partial<Sprint>): Sprint {
  return {
    id: 'spr-1',
    projectId: 'proj-1',
    name: 'Sprint 12',
    description: '',
    startDate: daysFromNow(-3),
    endDate: daysFromNow(3),
    ...overrides,
  };
}

describe('SprintStatsPanel → burndown banner', () => {
  it("tells an active sprint's banner in the present tense — today and the sprint start", () => {
    const activeSprint = sprint({ startDate: daysFromNow(-3), endDate: daysFromNow(3) });

    render(<SprintStatsPanel sprint={activeSprint} items={TICKETS} states={STATES} />);

    expect(
      screen.getByText(CAPABILITIES['sprints.burndown'].note!),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(CAPABILITIES['sprints.burndownCompleted'].note!),
    ).not.toBeInTheDocument();
  });

  it("tells a completed sprint's banner in the past tense — sprint start and close, never today", () => {
    const completedSprint = sprint({ startDate: daysFromNow(-44), endDate: daysFromNow(-30) });

    render(<SprintStatsPanel sprint={completedSprint} items={TICKETS} states={STATES} />);

    expect(
      screen.getByText(CAPABILITIES['sprints.burndownCompleted'].note!),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(CAPABILITIES['sprints.burndown'].note!),
    ).not.toBeInTheDocument();
  });

  // Caught in review: an earlier version of this fix only branched
  // active-vs-completed, so a sprint that hasn't started yet — reachable
  // from SprintDetailPage for any sprint, not just the currently-active one
  // — still fell through to the active-sprint copy and claimed a "today"
  // measurement that doesn't exist for it (buildBurndownData clamps its one
  // real point onto the sprint's own start day, not today).
  it("tells an upcoming sprint's banner it hasn't started yet, never today or the completed copy", () => {
    const upcomingSprint = sprint({ startDate: daysFromNow(30), endDate: daysFromNow(44) });

    render(<SprintStatsPanel sprint={upcomingSprint} items={TICKETS} states={STATES} />);

    expect(
      screen.getByText(CAPABILITIES['sprints.burndownUpcoming'].note!),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(CAPABILITIES['sprints.burndown'].note!),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(CAPABILITIES['sprints.burndownCompleted'].note!),
    ).not.toBeInTheDocument();
  });
});
