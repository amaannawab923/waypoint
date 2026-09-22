import {
  acceptanceSection,
  briefTitle,
  buildBrief,
  htmlToText,
  jiraBriefComments,
  jiraBriefTicket,
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
    expect(brief).toContain(
      'Verdict: <one of root-cause | not-a-bug | delivered | needs-info>',
    );
    expect(brief).toContain('## Summary');
    expect(brief).toContain('## Details');
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
    expect(brief).toContain(
      'Waypoint pushes this branch and opens the pull request itself',
    );
    expect(brief).toContain('must not say the branch was not pushed');
    expect(brief).not.toContain('Do not push');
    expect(brief).toContain(
      'Verdict: <one of fixed | partial | not-a-bug | wont-fix | needs-info>',
    );
    expect(brief).toContain('Start from the approved root cause above');
    expect(brief).toContain(
      'An earlier Fix on this ticket left the branch agent/ROAD-116-x1',
    );
    expect(brief).toContain(
      'proposes moving the ticket to review for fixed and partial, and closing it for not-a-bug and wont-fix',
    );
  });

  // Session verification (2026-09-20): the switch adds the browser task
  // and the Verification closing section to a writing session, and
  // nothing to a plan-mode one — a plan changes nothing to verify.
  it('Fix with the verify switch: the browser task, screenshots as transcript content, and a Verification section in the closing shape', () => {
    const brief = buildBrief(input({ intent: 'fix', verifyInBrowser: true }));
    expect(brief).toContain('Then verify the change in a browser.');
    expect(brief).toContain('waypoint-browser tools');
    expect(brief).toContain('with take_screenshot and NO filePath');
    expect(brief).toContain('lands in your transcript');
    expect(brief).not.toContain('.waypoint');
    expect(brief).toContain('## Verification');
    // Founder (2026-09-22): the QA cycle is timed, in one fixed shape —
    // tool calls when only the fine-grained tools exist, seconds too once
    // browser_task is registered.
    expect(brief).toContain(
      '"Verification: <n> tool calls via waypoint-browser"',
    );
    expect(brief).not.toContain('browser_task');
    const withUltrafast = buildBrief(
      input({ intent: 'fix', verifyInBrowser: true, ultrafastAvailable: true }),
    );
    expect(withUltrafast).toContain(
      '"Verification: <seconds> s via browser_task"',
    );
    expect(brief).toContain(
      'A change you could not verify this way is partial, not fixed',
    );
    // The section sits between Summary and Details, where the rule reads it.
    expect(brief.indexOf('## Summary')).toBeLessThan(
      brief.indexOf('## Verification'),
    );
    expect(brief.indexOf('## Verification')).toBeLessThan(
      brief.indexOf('## Details'),
    );
  });

  it('without the verify switch, and in plan mode regardless of it, no browser task', () => {
    expect(buildBrief(input({ intent: 'fix' }))).not.toContain(
      '## Verification',
    );
    expect(buildBrief(input({ intent: 'fix' }))).not.toContain(
      'waypoint-browser',
    );
    const plan = buildBrief(
      input({
        intent: 'custom',
        instructions: 'List every IPC channel.',
        mayChangeFiles: false,
        verifyInBrowser: true,
      }),
    );
    expect(plan).not.toContain('## Verification');
    expect(plan).not.toContain('waypoint-browser');
    const write = buildBrief(
      input({
        intent: 'custom',
        instructions: 'Rename the button.',
        mayChangeFiles: true,
        verifyInBrowser: true,
      }),
    );
    expect(write).toContain('## Verification');
    expect(write).toContain('waypoint-browser tools');
  });

  // Ultrafast browser tasks: the paragraph only appears alongside the
  // fine-grained waypoint-browser one, and only when the tool is actually
  // registered for this session (registration.ts's gate, threaded through
  // as ultrafastAvailable).
  it('with ultrafastAvailable, adds the browser_task paragraph beside the fine-grained tools', () => {
    const brief = buildBrief(
      input({ intent: 'fix', verifyInBrowser: true, ultrafastAvailable: true }),
    );
    expect(brief).toContain('waypoint-browser tools');
    expect(brief).toContain('call browser_task once with the URL');
    expect(brief).toContain('Its "done" is a claim, not proof');
    expect(brief.indexOf('waypoint-browser tools')).toBeLessThan(
      brief.indexOf('call browser_task once'),
    );
  });

  it('without ultrafastAvailable, says nothing about browser_task even with verifyInBrowser on', () => {
    const brief = buildBrief(
      input({
        intent: 'fix',
        verifyInBrowser: true,
        ultrafastAvailable: false,
      }),
    );
    expect(brief).toContain('waypoint-browser tools');
    expect(brief).not.toContain('browser_task');
  });

  it('ultrafastAvailable alone, without verifyInBrowser, adds neither paragraph', () => {
    const brief = buildBrief(
      input({
        intent: 'fix',
        verifyInBrowser: false,
        ultrafastAvailable: true,
      }),
    );
    expect(brief).not.toContain('## Verification');
    expect(brief).not.toContain('waypoint-browser');
    expect(brief).not.toContain('browser_task');
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

// W5b: the brief's view of a Jira issue, from main's own client's wire
// shape (docs/design/w5b-jira-dispatch.md §2.3).
describe('jiraBriefTicket / jiraBriefComments', () => {
  const issue = {
    id: '10042',
    key: 'ENG-4',
    projectKey: 'ENG',
    title: 'Checkout 500s',
    role: 'assignee' as const,
    stateName: 'In Progress',
    stateCategory: 'in-progress' as const,
    priority: 'none' as const,
    priorityId: null,
    priorityName: 'None',
    assigneeName: 'Unassigned',
    assigneeAccountId: null,
    reporterName: '',
    description: '   ',
    epicName: null,
    storyPoints: null,
    sprintName: null,
    labels: [],
    dueDate: null,
    subtasks: [],
    links: [],
    descriptionAdf: null,
    attachments: [],
    transitions: [],
    updatedAt: null,
  };

  it('names the issue, its URL and status; "None", "Unassigned" and a blank reporter are nothing, not words', () => {
    const facts = jiraBriefTicket(issue, 'yourteam.atlassian.net');
    expect(facts.ticket).toEqual({
      identifier: 'ENG-4',
      title: 'Checkout 500s',
      description: null,
      priority: null,
    });
    expect(facts.stateName).toBe('In Progress');
    expect(facts.jira).toEqual({
      url: 'https://yourteam.atlassian.net/browse/ENG-4',
      labels: [],
      assignee: null,
      reporter: null,
    });
    const brief = buildBrief(
      input({ ...facts, comments: [], intent: 'investigate' }),
    );
    expect(brief).toContain(
      '## Issue ENG-4 — Checkout 500s\nState: In Progress\n(no description)',
    );
    expect(brief).not.toContain('Priority:');
    expect(brief).not.toContain('Assignee:');
    expect(brief).toContain(
      'this session is in plan mode and the issue owner decides',
    );
  });

  it('keeps the site’s own priority label, and encodes the key in the URL', () => {
    const facts = jiraBriefTicket(
      {
        ...issue,
        key: 'ENG_2-7',
        priorityName: 'Blocker',
        assigneeName: 'Sam',
        reporterName: 'Priya',
      },
      'yourteam.atlassian.net',
    );
    expect(facts.ticket.priority).toBe('Blocker');
    expect(facts.jira).toMatchObject({
      url: 'https://yourteam.atlassian.net/browse/ENG_2-7',
      assignee: 'Sam',
      reporter: 'Priya',
    });
  });

  it('comments become named, flat, undated-tolerant lines', () => {
    const comments = jiraBriefComments([
      {
        id: 'c1',
        ticketId: 'ENG-4',
        authorName: 'Priya Raman',
        authorAccountId: null,
        updatedAt: null,
        updateAuthorName: null,
        body: 'Repro on staging.',
        createdAt: null,
        parentId: null,
        visibility: null,
        bodyAdf: null,
      },
    ]);
    expect(comments).toEqual([
      { author: 'Priya Raman', text: 'Repro on staging.', createdAt: null },
    ]);
    const brief = buildBrief(input({ comments }));
    expect(brief).toContain('— Priya Raman, undated:\nRepro on staging.');
  });
});
