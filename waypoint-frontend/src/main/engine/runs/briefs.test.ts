import {
  acceptanceSection,
  briefTitle,
  buildBrief,
  htmlToText,
  MAX_BRIEF_COMMENTS,
  scrubBriefText,
  type BriefInput,
} from './briefs';

// The brief for every verb, the seeded RCA, and the scrub
// (docs/design/w5a-investigate-fix.md §6).

function input(overrides: Partial<BriefInput> = {}): BriefInput {
  return {
    ticket: {
      id: 'wi-1',
      identifier: 'ROAD-116',
      title: 'Sessions anywhere',
      description:
        'The dialog should take a folder.\n\n## Acceptance\n- a folder picker\n- a recents list\n\n## Notes\nlater',
      projectId: 'proj-1',
      stateId: 'st-1',
      priority: 'high',
    },
    comments: [
      {
        id: 'cm-1',
        authorId: 'mem-1',
        bodyHtml: '<p>Repro&#39;d locally &amp; it is the <b>write</b>.</p>',
        createdAt: '2026-09-07T10:44:51.286Z',
      },
      {
        id: 'cm-2',
        authorId: 'mem-9',
        bodyHtml: 'plain text',
        createdAt: '2026-09-08T10:44:51.286Z',
      },
    ],
    members: [{ id: 'mem-1', fullName: 'Amaan Nawab', displayName: 'Amaan' }],
    stateName: 'In Progress',
    repoDisplayPath: '~/waypoint-electron',
    branch: 'agent/ROAD-116',
    baseRef: 'main',
    intent: 'investigate',
    ...overrides,
  };
}

describe('buildBrief', () => {
  it('Investigate: ticket first, plan-mode task last, the closing contract stated', () => {
    const brief = buildBrief(input());
    expect(
      brief.indexOf('## Ticket ROAD-116 — Sessions anywhere'),
    ).toBeLessThan(brief.indexOf('## Your task — Investigate'));
    expect(brief).toContain('Priority: high · State: In Progress');
    expect(brief).toContain('## Acceptance (from the ticket)');
    expect(brief).toContain('- a recents list');
    expect(brief).toContain(
      '## Acceptance (from the ticket)\n- a folder picker\n- a recents list\n\n## Comments',
    );
    expect(brief).toContain(
      "— Amaan, 2026-09-07 10:44:\nRepro'd locally & it is the write.",
    );
    expect(brief).toContain('— a teammate, 2026-09-08 10:44:\nplain text');
    expect(brief).toContain('Branch: agent/ROAD-116, from main');
    expect(brief).toContain('no node_modules');
    expect(brief).toContain('Do not change any file');
    expect(brief).toContain(
      'Waypoint reads only the final message of this turn',
    );
    expect(brief).not.toContain('## Root cause, as approved');
  });

  it('Fix: writes, commits, never pushes; seeded from the approved RCA when given', () => {
    const brief = buildBrief(
      input({
        intent: 'fix',
        approvedRca: 'The write is not guarded.',
        priorFixBranch: 'agent/ROAD-116-x1',
      }),
    );
    expect(brief).toContain(
      '## Root cause, as approved\nThe write is not guarded.',
    );
    expect(brief).toContain('## Your task — Fix');
    expect(brief).toContain('Do not push, open a pull request');
    expect(brief).toContain('Start from the approved root cause above');
    expect(brief).toContain(
      'An earlier Fix on this ticket left the branch agent/ROAD-116-x1',
    );
    expect(brief).toContain('proposes moving the ticket to review');
  });

  it('Fix without an RCA says nothing about one', () => {
    const brief = buildBrief(input({ intent: 'fix' }));
    expect(brief).not.toContain('Root cause');
    expect(brief).not.toContain('approved root cause');
  });

  it('Something else…: the instruction, and the switch decides plan or write', () => {
    const plan = buildBrief(
      input({ intent: 'custom', instructions: 'List every IPC channel.' }),
    );
    expect(plan).toContain('## Your task\nList every IPC channel.');
    expect(plan).toContain('plan mode');
    const write = buildBrief(
      input({
        intent: 'custom',
        instructions: 'Rename the dialog.',
        mayChangeFiles: true,
      }),
    );
    expect(write).toContain('You may edit files on this branch');
    expect(write).not.toContain('plan mode');
  });

  it('keeps the newest comments only and says how many were left out', () => {
    const comments = Array.from({ length: MAX_BRIEF_COMMENTS + 5 }, (_, i) => ({
      id: `cm-${i}`,
      authorId: 'mem-1',
      bodyHtml: `comment ${i}`,
      createdAt: `2026-09-${String(1 + (i % 28)).padStart(2, '0')}T00:00:00.000Z`,
    }));
    const brief = buildBrief(input({ comments }));
    expect(brief).toContain(
      `## Comments (newest ${MAX_BRIEF_COMMENTS} of ${MAX_BRIEF_COMMENTS + 5}, oldest first)`,
    );
    expect(brief).not.toContain('comment 4\n');
    expect(brief).toContain(`comment ${MAX_BRIEF_COMMENTS + 4}`);
  });

  it('carries no description, acceptance or comments sections when the ticket has none', () => {
    const brief = buildBrief(
      input({
        ticket: { ...input().ticket, description: null, priority: null },
        comments: [],
        stateName: null,
      }),
    );
    expect(brief).toContain('(no description)');
    expect(brief).not.toContain('## Acceptance');
    expect(brief).not.toContain('## Comments');
    expect(brief).not.toContain('Priority:');
  });

  it('scrubs a credential, a token-bearing URL and a raw account id wherever they came from', () => {
    const brief = buildBrief(
      input({
        ticket: {
          ...input().ticket,
          description:
            'See https://ci.example.com/job/1?token=abc123 and use ghp_abcdefghijklmnopqrstuvwxyz0123',
        },
        comments: [
          {
            id: 'cm-1',
            authorId: 'mem-1',
            bodyHtml:
              'ask [~accountid:712020:abcd-ef] — key AKIAABCDEFGHIJKLMNOP',
            createdAt: '2026-09-07T10:44:51.286Z',
          },
        ],
        instructions:
          'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.x',
        intent: 'custom',
      }),
    );
    expect(brief).not.toContain('token=abc123');
    expect(brief).not.toContain('ghp_');
    expect(brief).not.toContain('accountid');
    expect(brief).not.toContain('AKIA');
    expect(brief).not.toContain('eyJhbGci');
    expect(brief).toContain('[link removed]');
    expect(brief).toContain('@a teammate');
  });
});

describe('scrubBriefText', () => {
  it.each([
    ['https://example.com/docs', 'https://example.com/docs'],
    ['https://user:pw@example.com/x', '[link removed]'],
    ['https://x.io/a?b=1&api_key=zzz', '[link removed]'],
    ['sk-ant-api03-abcdefghijklmnopqrstuvwxyz', '[redacted]'],
    ['xoxb-1234567890-abcdefgh', '[redacted]'],
    ['[~accountid:5b10ac8d82e05b22cc7d4ef5]', '@a teammate'],
  ])('%s → %s', (raw, expected) => {
    expect(scrubBriefText(raw)).toBe(expected);
  });
});

describe('htmlToText', () => {
  it("turns blocks into lines and decodes the editor's entities", () => {
    expect(
      htmlToText('<p>one</p><p>two &lt;3&gt;</p><ul><li>a</li><li>b</li></ul>'),
    ).toBe('one\ntwo <3>\n- a\n- b');
  });
});

describe('acceptanceSection', () => {
  it('reads the section under an Acceptance heading, up to the next heading', () => {
    expect(
      acceptanceSection(
        'intro\n### Acceptance criteria\n- x\n- y\n## Later\nz',
      ),
    ).toBe('- x\n- y');
  });
  it('is null without one', () => {
    expect(acceptanceSection('nothing here')).toBeNull();
  });
});

describe('briefTitle', () => {
  it('names the run by ticket and verb', () => {
    expect(briefTitle('ROAD-116', 'investigate')).toBe(
      'ROAD-116 · Investigate',
    );
    expect(briefTitle('ROAD-116', 'fix')).toBe('ROAD-116 · Fix');
    expect(briefTitle('ROAD-116', 'custom')).toBe('ROAD-116 · Session');
  });
});
