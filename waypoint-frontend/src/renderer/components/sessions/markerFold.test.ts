import type { TranscriptTurn } from '@emdash/core/runtimes/acp/api/client' with {
  'resolution-mode': 'import',
};
import type { AgentRunEvent } from '@/types/agentRuns';
import { deriveMarkers, foldHiddenNotes, overlayMarkers } from './markerFold';

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

  // Founder (2026-09-22): the QA-cycle time next to every verdict — how
  // long the browser walk took and through which tool.
  it('names the verification time and tool the session reported', () => {
    const [jev, manual, none] = deriveMarkers(
      [
        event(3, 'finalized', {
          sequence: 1,
          verdict: 'fixed',
          proposals: [],
          pr: { action: 'none' },
          verificationTiming: {
            seconds: 6.8,
            toolCalls: null,
            via: 'browser_task',
          },
          afterTurnId: 't1',
        }),
        event(5, 'finalized', {
          sequence: 2,
          verdict: 'fixed',
          proposals: [],
          pr: { action: 'none' },
          verificationTiming: {
            seconds: null,
            toolCalls: 14,
            via: 'waypoint-browser',
          },
          afterTurnId: 't2',
        }),
        event(7, 'finalized', {
          sequence: 3,
          verdict: 'fixed',
          proposals: [],
          pr: { action: 'none' },
          verificationTiming: null,
          afterTurnId: 't3',
        }),
      ],
      'PL-10 · Fix',
    );
    expect(jev.text).toBe(
      'Waypoint · Completed PL-10 · Fix · verdict fixed · verified in 6.8 s via `browser_task`',
    );
    expect(manual.text).toBe(
      'Waypoint · Follow-up 2 filed for PL-10 · Fix · verdict fixed · verified in 14 tool calls via `waypoint-browser`',
    );
    expect(none.text).toBe(
      'Waypoint · Follow-up 3 filed for PL-10 · Fix · verdict fixed',
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

  // Founder, 2026-09-20: "conversation restored" on literally every
  // message pollutes the chat history — never-lock's whole point is
  // that continuing feels seamless, so the ordinary, expected outcome
  // (loaded, nothing rebuilt) gets no marker at all; only a genuinely
  // noteworthy one does.
  it('is silent for an ordinary resume (loaded, nothing rebuilt) — the routine case gets no marker', () => {
    const markers = deriveMarkers(
      [
        event(1, 'session_resumed', {
          from: 'done',
          outcome: 'loaded',
          afterTurnId: 't1',
        }),
      ],
      'X',
    );
    expect(markers).toEqual([]);
  });

  it('a resume that lost the conversation, or had to rebuild the worktree, still gets a line', () => {
    const [fresh, recreated] = deriveMarkers(
      [
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
    expect(fresh.text).toBe(
      'Waypoint · Continued from failed · fresh session in the same worktree',
    );
    expect(recreated.text).toMatch(/worktree recreated on a fresh branch$/);
  });

  it('a command that may still be running gets a warning line naming it', () => {
    const [m] = deriveMarkers(
      [
        event(3, 'note', {
          stage: 'finalize',
          kind: 'possible-leftover-process',
          command: 'open /tmp/shot.png',
          afterTurnId: 't2',
        }),
      ],
      'X',
    );
    expect(m.text).toBe(
      'Waypoint · ⚠ this session ran a command that may still be running on your machine — `open /tmp/shot.png`',
    );
  });

  it('a follow-up suppressed for lacking a Summary gets a line saying so', () => {
    const [m] = deriveMarkers(
      [
        event(4, 'note', {
          stage: 'finalize',
          suppressed: 'verdict-without-summary',
          afterTurnId: 't3',
        }),
      ],
      'X',
    );
    expect(m).toMatchObject({
      afterTurnId: 't3',
      text: 'Waypoint · Verdict line found without a Summary — treated as conversation, nothing filed',
    });
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
        // Boot reconcile's re-attach/adopt bookkeeping: the same kind,
        // no `from` — found live as a wall of "Continued" lines.
        event(7, 'session_resumed', {
          at: 'boot',
          note: 'daemon session found live; re-attached',
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

  // Never-lock (found in review): `finalized`/`session_resumed`/`note`
  // are all in the backend's CLIENT_EVENT_KINDS — any workspace member
  // can POST one with an arbitrary payload, and this text renders as
  // real Markdown in every viewer's transcript. A run's title (`label`),
  // a verdict, a PR failure reason, and a resumed run's `from` all ride
  // in from that payload unescaped before this fix.
  describe('untrusted text is never live Markdown (security)', () => {
    it('escapes link/emphasis/code/raw-HTML syntax in the run label, the verdict, and a PR failure reason', () => {
      const [spoofedLabel] = deriveMarkers(
        [event(1, 'finalized', { sequence: 1, verdict: 'fixed' })],
        '[click me](https://evil.example) <img src=x onerror=alert(1)>',
      );
      expect(spoofedLabel.text).toBe(
        'Waypoint · Completed \\[click me\\]\\(https://evil.example\\) \\<img src=x onerror=alert\\(1\\)\\> · verdict fixed',
      );
      expect(spoofedLabel.text).not.toMatch(/(?<!\\)[[(<]/);

      const [spoofedVerdict] = deriveMarkers(
        [event(1, 'finalized', { sequence: 1, verdict: '`rm -rf /`' })],
        'X',
      );
      expect(spoofedVerdict.text).toBe(
        'Waypoint · Completed X · verdict \\`rm -rf /\\`',
      );

      const [spoofedReason] = deriveMarkers(
        [
          event(1, 'finalized', {
            sequence: 1,
            pr: { action: 'failed', reason: '[bait](javascript:alert(1))' },
          }),
        ],
        'X',
      );
      expect(spoofedReason.text).toBe(
        'Waypoint · Completed X · not published: \\[bait\\]\\(javascript:alert\\(1\\)\\)',
      );
    });

    // Round 4 of review: the escape set covered inline syntax and `#`,
    // but block syntax — a `---` underline turning the marker into a
    // heading, a `- [x]` list — starts at a line start, and a payload
    // carrying its own newlines could put one there. Every marker is one
    // line; every kind of line break in untrusted text becomes a space.
    it('collapses line breaks in untrusted text, so block Markdown (a rule, a list, a heading underline) can never start on a line of its own', () => {
      const [marker] = deriveMarkers(
        [
          event(1, 'finalized', {
            sequence: 1,
            verdict:
              'fixed\n\n---\n\n- [x] fake step\r\n1. numbered\u2028> quoted',
          }),
        ],
        'ROAD-116 · Fix',
      );
      expect(marker.text).toBe(
        'Waypoint · Completed ROAD-116 · Fix · verdict fixed --- - \\[x\\] fake step 1. numbered \\> quoted',
      );
      expect(marker.text).not.toMatch(/[\r\n\u2028\u2029]/);
      // Ordinary prose with the same characters is untouched.
      expect(
        deriveMarkers(
          [event(2, 'finalized', { sequence: 1, verdict: 'v1.2-rc' })],
          'ROAD-1',
        )[0].text,
      ).toBe('Waypoint · Completed ROAD-1 · verdict v1.2-rc');
    });

    it('escapes a forged `from` on session_resumed', () => {
      const [marker] = deriveMarkers(
        [
          event(1, 'session_resumed', {
            from: '`code`',
            outcome: 'replaced-by-new',
          }),
        ],
        'X',
      );
      expect(marker.text).toBe(
        'Waypoint · Continued from \\`code\\` · fresh session in the same worktree',
      );
    });

    it('refuses a non-http(s) PR url as a link — it renders as text, never as a clickable href', () => {
      const [marker] = deriveMarkers(
        [
          event(1, 'finalized', {
            sequence: 1,
            // eslint-disable-next-line no-script-url -- exactly the href scheme the fix must refuse
            pr: { action: 'opened', url: 'javascript:alert(document.cookie)' },
          }),
        ],
        'X',
      );
      expect(marker.text).toBe('Waypoint · Completed X · PR opened');
      // eslint-disable-next-line no-script-url -- asserting the scheme's own text never appears
      expect(marker.text).not.toContain('javascript:');
      expect(marker.text).not.toContain('[');
    });

    it('still links a genuine https PR url — the fix does not break the ordinary case', () => {
      const [marker] = deriveMarkers(
        [
          event(1, 'finalized', {
            sequence: 1,
            pr: { action: 'opened', url: 'https://github.com/o/r/pull/9' },
          }),
        ],
        'X',
      );
      expect(marker.text).toContain(
        '[PR #9 opened](https://github.com/o/r/pull/9)',
      );
    });

    it('refuses a non-http(s) previousUrl on a superseded PR note the same way', () => {
      const [marker] = deriveMarkers(
        [
          event(1, 'note', {
            stage: 'resume',
            publish: 'pr-superseded',
            previousUrl: 'data:text/html,<script>alert(1)</script>',
          }),
        ],
        'X',
      );
      expect(marker.text).toBe(
        'Waypoint · the branch was recreated; the earlier PR is superseded — the next report opens a new one',
      );
      expect(marker.text).not.toContain('data:');
    });
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
        outcome: 'replaced-by-new',
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

describe('foldHiddenNotes', () => {
  const CONTINUATION =
    "This run's last report was already filed on ROAD-122 (verdict: not-a-bug). If you make changes in this conversation, end that turn with the same `Verdict:` / `## Summary` report you gave before, so Waypoint publishes them and files a follow-up. When you are only answering a question, reply normally, without a Verdict line — nothing is filed for a plain answer.";
  const RESUME =
    'Waypoint resumed this run after an interruption, but your previous conversation could not be restored, so this is a fresh session in the same worktree. Here is where things stand.\n\nBranch: agent/ROAD-122 (from main)\nCommits on this branch since main:\n(none)\n\nUncommitted changes:\n(none)';

  const userTurn = (id: string, text: string): TranscriptTurn =>
    ({
      id,
      seq: 7,
      initiator: 'user',
      items: [
        { kind: 'message', id: `${id}-u`, seq: 1, role: 'user', text },
        {
          kind: 'message',
          id: `${id}-a`,
          seq: 2,
          role: 'assistant',
          text: 'ok',
        },
      ],
      outcome: { kind: 'done' },
    }) as unknown as TranscriptTurn;

  it('cuts the continuation note the agent’s replay glued onto the person’s message into a marker row above it', () => {
    const [out] = foldHiddenNotes([userTurn('t9', `line one${CONTINUATION}`)]);
    expect(out.items).toHaveLength(3);
    expect(out.items[0]).toMatchObject({
      kind: 'message',
      role: 'thought',
      id: 'note:t9:t9-u',
    });
    expect((out.items[0] as { text: string }).text).toMatch(
      /^Waypoint · This run's last report was already filed on ROAD-122/,
    );
    expect(out.items[1]).toMatchObject({
      id: 't9-u',
      role: 'user',
      text: 'line one',
    });
    expect(out.items[2]).toMatchObject({ id: 't9-a' });
  });

  it('summarises a glued branch-state note to its first sentence instead of pasting the git log', () => {
    const [out] = foldHiddenNotes([userTurn('t9', `what next?\n\n${RESUME}`)]);
    const marker = out.items[0] as { text: string };
    expect(marker.text).toBe(
      'Waypoint · Waypoint resumed this run after an interruption, but your previous conversation could not be restored, so this is a fresh session in the same worktree. Here is where things stand. \\(branch state given to the agent\\)',
    );
    expect(out.items[1]).toMatchObject({ text: 'what next?' });
  });

  it('shows one note once: the copy every later message carries is cut out without a second marker', () => {
    const out = foldHiddenNotes([
      userTurn('t1', `first${CONTINUATION}`),
      userTurn('t2', `second${CONTINUATION}`),
    ]);
    expect(out[0].items.map((i) => i.id)).toEqual([
      'note:t1:t1-u',
      't1-u',
      't1-a',
    ]);
    expect(out[1].items.map((i) => i.id)).toEqual(['t2-u', 't2-a']);
    expect(out[1].items[0]).toMatchObject({ text: 'second' });
  });

  it('leaves messages without a note alone, and never mutates its input', () => {
    const turns = [userTurn('t1', 'plain question')];
    const out = foldHiddenNotes(turns);
    expect(out[0]).toBe(turns[0]);
    expect(turns[0].items).toHaveLength(2);
  });
});
