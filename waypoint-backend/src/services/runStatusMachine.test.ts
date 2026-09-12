import { describe, it, expect } from 'vitest';
import {
  AGENT_RUN_STATUSES,
  canTransition,
  describeRefusedTransition,
  isAgentRunStatus,
  isLive,
  isTerminal,
  type AgentRunStatus,
} from './runStatusMachine.js';

// Every arrow, written out, so a change to the table is a visible change
// here — the machine IS the spec ROAD-54 asked to "pick once".
const EXPECTED: Record<AgentRunStatus, AgentRunStatus[]> = {
  queued: ['provisioning', 'failed', 'cancelled'],
  provisioning: ['running', 'interrupted', 'failed', 'cancelled'],
  running: ['blocked', 'finishing', 'interrupted', 'failed', 'cancelled'],
  blocked: ['running', 'interrupted', 'failed', 'cancelled'],
  finishing: ['needs-review', 'done', 'interrupted', 'failed', 'cancelled'],
  'needs-review': ['done'],
  done: [],
  interrupted: ['provisioning', 'running', 'failed', 'cancelled'],
  failed: [],
  cancelled: [],
};

describe('runStatusMachine', () => {
  it('allows exactly the documented arrows and nothing else', () => {
    for (const from of AGENT_RUN_STATUSES) {
      for (const to of AGENT_RUN_STATUSES) {
        expect({ from, to, allowed: canTransition(from, to) }).toEqual({
          from,
          to,
          allowed: EXPECTED[from].includes(to),
        });
      }
    }
  });

  it('never allows a status to transition to itself', () => {
    for (const s of AGENT_RUN_STATUSES) expect(canTransition(s, s)).toBe(false);
  });

  it('terminal statuses have no way out; interrupted is not terminal', () => {
    for (const s of ['done', 'failed', 'cancelled'] as const) {
      expect(isTerminal(s)).toBe(true);
      expect(EXPECTED[s]).toEqual([]);
    }
    expect(isTerminal('interrupted')).toBe(false);
    expect(canTransition('interrupted', 'running')).toBe(true);
  });

  it('live statuses are the ones reconcile expects a daemon session for', () => {
    const live = AGENT_RUN_STATUSES.filter(isLive);
    expect(live).toEqual(['provisioning', 'running', 'blocked', 'finishing']);
  });

  it('every status is reachable from queued', () => {
    const seen = new Set<AgentRunStatus>(['queued']);
    const frontier: AgentRunStatus[] = ['queued'];
    while (frontier.length) {
      const s = frontier.pop()!;
      for (const next of EXPECTED[s]) {
        if (!seen.has(next)) {
          seen.add(next);
          frontier.push(next);
        }
      }
    }
    expect([...seen].sort()).toEqual([...AGENT_RUN_STATUSES].sort());
  });

  it('a blocked run cannot skip to finishing — it has not finished anything', () => {
    expect(canTransition('blocked', 'finishing')).toBe(false);
    expect(canTransition('blocked', 'running')).toBe(true);
  });

  it('isAgentRunStatus guards unknown strings', () => {
    expect(isAgentRunStatus('running')).toBe(true);
    expect(isAgentRunStatus('awaiting_review')).toBe(false);
    expect(isAgentRunStatus(42)).toBe(false);
  });

  it('describes a refusal as a sentence naming the legal moves', () => {
    expect(describeRefusedTransition('done', 'running')).toBe(
      'A done run is finished; it cannot become running.',
    );
    expect(describeRefusedTransition('blocked', 'finishing')).toBe(
      'A blocked run cannot become finishing; it can become running, interrupted, failed, cancelled.',
    );
    expect(describeRefusedTransition('running', 'running')).toBe('The run is already running.');
  });
});
