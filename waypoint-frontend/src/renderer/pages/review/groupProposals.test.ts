import type { ProposalView } from '@/types/entities';
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
});
