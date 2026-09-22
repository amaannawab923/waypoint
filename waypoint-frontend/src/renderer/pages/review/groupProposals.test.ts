import type { ProposalView } from '@/types/entities';
// S1 (PR #88 review) round-trip test only: the real comment builder,
// cross-imported from main on purpose so a future change to its output
// shape breaks this test loudly instead of whyItExists silently
// mis-parsing it. Renderer RUNTIME code never imports main (runVerdict.ts's
// own header comment) — this is a test-only exception, verifying the
// contract between the two, not a boundary this file's own code crosses.
import { buildRunComment } from '../../../main/engine/runs/runComment';
import {
  clusterProposals,
  groupProposals,
  justificationOf,
  whyItExists,
} from './groupProposals';

const base = (over: Partial<ProposalView>): ProposalView =>
  ({
    id: 'p',
    conversationId: null,
    kind: 'comment',
    ticketId: 'wi-1',
    payload: {},
    snapshot: { identifier: 'PL-10', title: 'Greeting shows undefined' },
    anchorSeq: null,
    status: 'proposed',
    statusReason: null,
    resultInfo: null,
    disclosureText: 'This is a Waypoint session',
    expiresAt: '2026-10-21T00:00:00.000Z',
    modelNotifiedAt: null,
    resolvedAt: null,
    createdAt: '2026-09-21T00:00:00.000Z',
    origin: 'agent_run',
    projectId: 'proj-1',
    agentId: null,
    agentRunId: 'run-a',
    sourceRequestId: null,
    groupId: null,
    decidedBy: null,
    trustGrantId: null,
    decisionLatencyMs: null,
    ...over,
  }) as ProposalView;

const comment = (
  id: string,
  run: string,
  body = '**Verdict:** fixed\n\nThe name field was never read. Fixed it.',
) => base({ id, agentRunId: run, groupId: `${run}:1`, payload: { body } });
const state = (id: string, run: string, from = 'st-todo') =>
  base({
    id,
    kind: 'state_change',
    agentRunId: run,
    groupId: `${run}:1`,
    payload: { stateId: 'st-review' },
    snapshot: {
      identifier: 'PL-10',
      title: 'Greeting',
      fromStateId: from,
      fromStateName: 'Todo',
      toStateName: 'In Review',
    },
  });

describe('groupProposals', () => {
  it('pairs the comment and the state change of one report, comment first whatever the queue order', () => {
    const groups = groupProposals([
      state('s1', 'run-a'),
      comment('c1', 'run-a'),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].primary.id).toBe('c1');
    expect(groups[0].companion?.id).toBe('s1');
  });

  it('pairs an older run’s lone comment and lone state change (filed before group ids), and leaves anything ambiguous, or Copilot’s, alone', () => {
    const groups = groupProposals([
      base({ id: 'old-s', kind: 'state_change' }),
      base({ id: 'old-c' }),
      base({ id: 'b-c1', agentRunId: 'run-b' }),
      base({ id: 'b-c2', agentRunId: 'run-b' }),
      base({ id: 'b-s', kind: 'state_change', agentRunId: 'run-b' }),
      base({
        id: 'cp',
        origin: 'copilot',
        agentRunId: null,
        conversationId: 'conv-1',
      }),
    ]);
    expect(groups.map((g) => [g.primary.id, g.companion?.id ?? null])).toEqual([
      ['old-c', 'old-s'],
      ['b-c1', null],
      ['b-c2', null],
      ['b-s', null],
      ['cp', null],
    ]);
  });
});

describe('clusterProposals', () => {
  it('clusters a ticket’s run proposals and counts runs competing to move it out of the same state', () => {
    const clusters = clusterProposals([
      comment('c1', 'run-a'),
      state('s1', 'run-a'),
      comment('c2', 'run-b'),
      state('s2', 'run-b'),
      comment('c3', 'run-c'),
      state('s3', 'run-c'),
      // An Investigate on the same ticket: comment only, never competing.
      base({
        id: 'c4',
        agentRunId: 'run-d',
        groupId: 'run-d:1',
        payload: { body: 'x' },
      }),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toMatchObject({
      ticketId: 'wi-1',
      identifier: 'PL-10',
      competingRuns: 3,
    });
    expect(clusters[0].groups.map((g) => g.key)).toEqual([
      'run-a:1',
      'run-b:1',
      'run-c:1',
      'run-d:1',
    ]);
  });

  it('two runs moving the ticket from different states do not compete; a decided state change no longer counts', () => {
    const clusters = clusterProposals([
      state('s1', 'run-a', 'st-todo'),
      state('s2', 'run-b', 'st-progress'),
      { ...state('s3', 'run-c', 'st-todo'), status: 'superseded' },
    ]);
    expect(clusters[0].competingRuns).toBe(0);
  });

  it('never clusters Copilot proposals — two people’s own comments are not a conflict', () => {
    const clusters = clusterProposals([
      base({
        id: 'a',
        origin: 'copilot',
        agentRunId: null,
        conversationId: 'conv-1',
      }),
      base({
        id: 'b',
        origin: 'copilot',
        agentRunId: null,
        conversationId: 'conv-2',
      }),
    ]);
    expect(clusters).toHaveLength(2);
  });
});

describe('justificationOf / whyItExists', () => {
  it('takes the first sentence after the Follow-up and Verdict lines, without markdown marks, clipped', () => {
    expect(
      justificationOf(
        '**Follow-up 2**\n\n**Verdict:** fixed\n\nThe `name` field was **never read**. Fixed it.\n\nMore.',
      ),
    ).toBe('The name field was never read.');
    expect(
      justificationOf(`**Verdict:** fixed\n\n${'x'.repeat(200)}`),
    ).toHaveLength(140);
    expect(justificationOf('')).toBeNull();
  });

  it('says why a card is in the queue', () => {
    expect(whyItExists(comment('c', 'run-a'))).toBe(
      "this run's closing report — verdict fixed",
    );
    expect(
      whyItExists(
        comment(
          'c',
          'run-a',
          '**Follow-up 2**\n\n**Verdict:** not a bug\n\nNope.',
        ),
      ),
    ).toBe("follow-up 2 of this run's report — verdict not a bug");
    expect(whyItExists(base({ origin: 'copilot', agentRunId: null }))).toBe(
      'Copilot proposed it in your conversation',
    );
  });

  // S1 (PR #88 review): the run's own `verdict` column (passed as the
  // second argument — the same value CopilotProposalCard.tsx reads via
  // useAgentRunSummary) is now the source of truth, not the body. It
  // wins even over a body that disagrees or names no verdict at all.
  it('prefers the run’s own verdict over anything in the body', () => {
    expect(
      whyItExists(
        comment('c', 'run-a', 'No verdict line here at all.'),
        'partial',
      ),
    ).toBe("this run's closing report — verdict partly fixed");
    expect(
      whyItExists(
        comment('c', 'run-a', '**Verdict:** fixed\n\nDone.'),
        'needs-info',
      ),
    ).toBe("this run's closing report — verdict needs a decision");
  });

  // S1: `126a2dc` removed buildRunComment's verdict tag from most
  // comments, so the old unanchored regex mostly matched nothing — until
  // a summary sentence happened to contain the bare word "verdict",
  // which it then mis-parsed as a declaration. Anchored to a line start
  // now, exactly like justificationOf's own filter above; without a
  // runVerdict (the fallback path — a run summary still loading, or one
  // that could not be read), prose mentioning "verdict" produces no
  // false match, only a genuine `Verdict:` line does.
  it('the body fallback is anchored to a line start — a summary that merely mentions "verdict" is never mistaken for one', () => {
    expect(
      whyItExists(
        comment(
          'c',
          'run-a',
          'The verdict is that the API was already correct; nothing changed.',
        ),
      ),
    ).toBe("this run's closing report");
    expect(
      whyItExists(
        comment(
          'c',
          'run-a',
          '**Verdict:** fixed\n\nThe verdict is that the API was already correct.',
        ),
      ),
    ).toBe("this run's closing report — verdict fixed");
  });

  // S1: a round-trip against the CURRENT buildRunComment (main's own
  // comment builder, runComment.ts) — the same drift that broke this
  // once (the body's shape changed out from under this module's regex)
  // fails loudly here instead of silently mis-parsing prose.
  it('round-trips against the current buildRunComment for every plan/verdict combination it can produce', () => {
    const cases: Array<{
      verdict:
        | 'root-cause'
        | 'fixed'
        | 'partial'
        | 'not-a-bug'
        | 'wont-fix'
        | 'delivered'
        | 'needs-info';
      plan: 'review' | 'close' | 'complete' | null;
      label: string;
    }> = [
      { verdict: 'root-cause', plan: null, label: 'root cause found' },
      { verdict: 'needs-info', plan: null, label: 'needs a decision' },
      { verdict: 'fixed', plan: 'review', label: 'fixed' },
      { verdict: 'not-a-bug', plan: 'close', label: 'not a bug' },
      { verdict: 'delivered', plan: 'complete', label: 'already delivered' },
    ];
    cases.forEach(({ verdict, plan, label }) => {
      const body = buildRunComment({
        report: {
          verdict,
          hasSummaryHeading: true,
          summary: 'The verdict is what a person reads here, not a tag.',
          verification: null,
          details: null,
        },
        runLabel: 'ROAD-1 · Fix',
        published: null,
        verdict,
        plan,
      });
      const why = whyItExists(comment('c', 'run-a', body), verdict);
      expect(why).toBe(`this run's closing report — verdict ${label}`);
    });
  });
});
