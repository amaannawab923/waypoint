import type { TranscriptTurn } from '@emdash/core/runtimes/acp/api/client' with {
  'resolution-mode': 'import',
};
import type { AgentRunEvent } from '@/types/agentRuns';
import { deriveMarkers, overlayMarkers } from './markerFold';

// Markers (never-lock, design §5): what Waypoint did to a run, drawn from
// its events and laid into the transcript as `role:'thought'` rows —
// after the turn they belong to, never a turn of their own conversation.

const event = (
  seq: number,
  kind: string,
  payload: Record<string, unknown>,
): AgentRunEvent => ({
  runId: 'run-abc1234',
  seq,
  kind,
  payload,
  at: `2026-09-20T00:00:0${seq}.000Z`,
});

const turn = (id: string, seq: number, n = 2): TranscriptTurn =>
  ({
    id,
    seq,
    initiator: 'user',
    items: Array.from({ length: n }, (_, i) => ({
      kind: 'message',
      id: `${id}-m${i + 1}`,
      seq: i + 1,
      role: i === 0 ? 'user' : 'assistant',
      text: `${id} ${i + 1}`,
    })),
  }) as TranscriptTurn;

describe('deriveMarkers', () => {
  it('a first finalize reads "Completed …" with the verdict, the PR and the proposals; a later one "Follow-up n filed"', () => {
    const [first, second] = deriveMarkers(
      [
        event(7, 'finalized', {
          sequence: 1,
          verdict: 'fixed',
          proposals: ['p1', 'p2'],
          pr: { action: 'opened', url: 'https://github.com/o/r/pull/42' },
          afterTurnId: 't3',
        }),
        event(9, 'finalized', {
          sequence: 2,
          verdict: null,
          proposals: [],
          pr: { action: 'updated', url: 'https://github.com/o/r/pull/42' },
          afterTurnId: 't5',
        }),
      ],
      'ROAD-116 · Fix',
    );
    expect(first).toEqual({
      id: 'marker:7',
      seq: 7,
      afterTurnId: 't3',
      text: 'Waypoint · Completed ROAD-116 · Fix · verdict fixed · [PR #42 opened](https://github.com/o/r/pull/42) · 2 proposals filed for review',
    });
    expect(second.text).toBe(
      'Waypoint · Follow-up 2 filed for ROAD-116 · Fix · [PR #42 updated](https://github.com/o/r/pull/42)',
    );
  });

  it('says why a report was not published, and nothing about a PR when none was tried', () => {
    const [skipped, failed, none] = deriveMarkers(
      [
        event(1, 'finalized', {
          sequence: 1,
          verdict: 'fixed',
          proposals: [],
          pr: { action: 'skipped', reason: 'ROAD-116 has a live writer' },
        }),
        event(2, 'finalized', {
          sequence: 1,
          verdict: 'fixed',
          proposals: [],
          pr: { action: 'failed', reason: 'auth' },
        }),
        event(3, 'finalized', {
          sequence: 1,
          verdict: 'clean',
          pr: { action: 'none' },
        }),
      ],
      'X',
    );
    expect(skipped.text).toMatch(/not published: ROAD-116 has a live writer$/);
    expect(failed.text).toMatch(/not published: auth$/);
    expect(none.text).toBe('Waypoint · Completed X · verdict clean');
    expect(none.afterTurnId).toBeNull();
  });

  it('a resume reads "Continued from <status>" with what the provider did and what happened to the worktree', () => {
    const [loaded, fresh, recreated] = deriveMarkers(
      [
        event(1, 'session_resumed', {
          from: 'done',
          outcome: 'loaded',
          afterTurnId: 't1',
        }),
        event(2, 'session_resumed', {
          from: 'failed',
          outcome: 'replaced-by-new',
        }),
        event(3, 'session_resumed', {
          from: 'cancelled',
          outcome: 'loaded',
          worktreeRecreated: true,
          branchReused: false,
        }),
      ],
      'X',
    );
    expect(loaded.text).toBe(
      'Waypoint · Continued from done · conversation restored',
    );
    expect(fresh.text).toBe(
      'Waypoint · Continued from failed · fresh session in the same worktree',
    );
    expect(recreated.text).toMatch(/worktree recreated on a fresh branch$/);
  });

  it('unpublished commits and a superseded PR are notes worth a line; other notes and events are not', () => {
    const markers = deriveMarkers(
      [
        event(1, 'note', {
          stage: 'finalize',
          unpublishedCommits: 3,
          afterTurnId: 't2',
        }),
        event(2, 'note', {
          stage: 'finalize',
          message: 'No report in the closing message',
        }),
        event(3, 'note', {
          stage: 'resume',
          publish: 'pr-superseded',
          previousUrl: 'https://github.com/o/r/pull/7',
        }),
        event(4, 'prompt_sent', {
          by: 'user',
          kind: 'message',
          continued: true,
        }),
        event(5, 'status_changed', { from: 'running', to: 'done' }),
        event(6, 'session_started', {}),
      ],
      'X',
    );
    expect(markers.map((m) => m.id)).toEqual(['marker:1', 'marker:3']);
    expect(markers[0].text).toBe(
      'Waypoint · 3 new commits on the branch, not published — ask the agent to summarize its changes to publish',
    );
    expect(markers[1].text).toMatch(
      /\[the earlier PR #7\]\(https:\/\/github.com\/o\/r\/pull\/7\) is superseded/,
    );
  });
});

describe('overlayMarkers', () => {
  const markers = deriveMarkers(
    [
      event(5, 'finalized', {
        sequence: 1,
        verdict: 'fixed',
        afterTurnId: 't2',
      }),
      event(8, 'session_resumed', {
        from: 'done',
        outcome: 'loaded',
        afterTurnId: 't2',
      }),
      event(9, 'note', {
        stage: 'finalize',
        unpublishedCommits: 1,
        afterTurnId: 'gone',
      }),
    ],
    'X',
  );

  it('appends each marker to its turn as a thought row, in event order, with item seqs past the turn’s own; an unknown anchor follows the last turn', () => {
    const turns = [turn('t1', 1), turn('t2', 2), turn('t3', 3)];
    const out = overlayMarkers(turns, markers);
    expect(out).toHaveLength(3);
    expect(out[0]).toBe(turns[0]);
    const t2 = out[1].items.map((i) => ({
      id: i.id,
      seq: i.seq,
      role: (i as { role?: string }).role,
    }));
    expect(t2).toEqual([
      { id: 't2-m1', seq: 1, role: 'user' },
      { id: 't2-m2', seq: 2, role: 'assistant' },
      { id: 'marker:5', seq: 3, role: 'thought' },
      { id: 'marker:8', seq: 4, role: 'thought' },
    ]);
    expect(out[2].items.map((i) => i.id)).toEqual([
      't3-m1',
      't3-m2',
      'marker:9',
    ]);
    // The daemon's own items are untouched.
    expect(out[1].items.slice(0, 2)).toEqual(turns[1].items);
  });

  it('with no turns at all the markers make one trailing turn, so what happened still shows', () => {
    const out = overlayMarkers([], markers);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('markers');
    expect(out[0].items.map((i) => i.id)).toEqual([
      'marker:5',
      'marker:8',
      'marker:9',
    ]);
  });

  it('is the identity for no markers, and never mutates its input', () => {
    const turns = [turn('t1', 1)];
    expect(overlayMarkers(turns, [])).toEqual(turns);
    overlayMarkers(turns, markers);
    expect(turns[0].items).toHaveLength(2);
  });
});
