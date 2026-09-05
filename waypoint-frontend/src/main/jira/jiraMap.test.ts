import {
  adfToPlainText,
  buildTransitionFieldsPayload,
  formatFileSize,
  mapComment,
  mapIssue,
  mapPriority,
  mapStateCategory,
  mapTransitions,
  normalizeJiraSite,
} from './jiraMap';

// No Electron and no network in this file — these are the pure functions that
// decide what a Jira payload *means*, which is exactly the part worth pinning
// down against realistic shapes.

const ME = '5f8a1b2c3d4e5f6a7b8c9d0e';
const SOMEONE_ELSE = 'aaaabbbbccccddddeeeeffff';

describe('normalizeJiraSite', () => {
  it.each([
    ['waypoint123.atlassian.net', 'waypoint123.atlassian.net'],
    ['  WAYPOINT123.Atlassian.NET  ', 'waypoint123.atlassian.net'],
    ['https://waypoint123.atlassian.net', 'waypoint123.atlassian.net'],
    [
      'https://waypoint123.atlassian.net/jira/software/projects/ENG/boards/1',
      'waypoint123.atlassian.net',
    ],
    ['waypoint123.atlassian.net/', 'waypoint123.atlassian.net'],
    // The one convenience expansion: a bare site name.
    ['waypoint123', 'waypoint123.atlassian.net'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeJiraSite(input)).toBe(expected);
  });

  // These are the rejections that matter. A value carrying userinfo would
  // put a second identity in front of the Basic-auth pair; a port is a shape
  // no Jira Cloud site has. Both are refused rather than cleaned up, because
  // both are ways a pasted value could aim a live API token somewhere the
  // user didn't intend.
  it.each([
    ['', 'empty'],
    ['   ', 'blank'],
    ['attacker@evil.example', 'userinfo'],
    ['evil.example:8080', 'an explicit port'],
    ['not a hostname', 'spaces'],
    ['-leading-hyphen.example', 'an invalid label'],
  ])('rejects %j (%s)', (input) => {
    expect(normalizeJiraSite(input)).toBeNull();
  });
});

describe('adfToPlainText', () => {
  it('flattens paragraphs, hard breaks, mentions and emoji', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Above 500/min the receiver ' },
            { type: 'text', text: 'drops events.' },
          ],
        },
        {
          type: 'paragraph',
          content: [
            { type: 'mention', attrs: { id: ME, text: '@Priya Raman' } },
            { type: 'text', text: ' can you look? ' },
            { type: 'emoji', attrs: { shortName: ':eyes:', text: '👀' } },
          ],
        },
      ],
    };

    expect(adfToPlainText(doc).trim()).toBe(
      'Above 500/min the receiver drops events.\n@Priya Raman can you look? 👀',
    );
  });

  it('returns an empty string for a missing description rather than throwing', () => {
    expect(adfToPlainText(null)).toBe('');
    expect(adfToPlainText(undefined)).toBe('');
  });
});

describe('mapStateCategory / mapPriority / formatFileSize', () => {
  it('maps Jira status categories, which are the only portable grouping', () => {
    expect(mapStateCategory('new')).toBe('todo');
    expect(mapStateCategory('indeterminate')).toBe('in-progress');
    expect(mapStateCategory('done')).toBe('done');
    expect(mapStateCategory(undefined)).toBe('todo');
  });

  it('maps both of Atlassian’s standard priority schemes', () => {
    expect(mapPriority('Highest')).toBe('urgent');
    expect(mapPriority('Blocker')).toBe('urgent');
    expect(mapPriority('Medium')).toBe('medium');
    expect(mapPriority('Lowest')).toBe('low');
  });

  // A site with a custom priority scheme gets 'none' rather than being
  // forced into a bucket it may not belong in.
  it('reports an unrecognized priority as none', () => {
    expect(mapPriority('Yesterday')).toBe('none');
    expect(mapPriority(undefined)).toBe('none');
  });

  it('formats attachment sizes', () => {
    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(219136)).toBe('214 KB');
    expect(formatFileSize(3_145_728)).toBe('3.0 MB');
  });
});

describe('mapIssue', () => {
  function issue(overrides: Record<string, unknown> = {}) {
    return {
      id: '10421',
      key: 'ENG-421',
      fields: {
        summary: 'Webhook receiver drops events past 500/min',
        project: { key: 'ENG' },
        status: {
          name: 'In Progress',
          statusCategory: { key: 'indeterminate' },
        },
        priority: { name: 'Highest' },
        assignee: { accountId: ME, displayName: 'Max Chen' },
        reporter: { accountId: SOMEONE_ELSE, displayName: 'Sam Lee' },
        updated: '2026-09-01T10:00:00.000+0000',
        description: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'Details.' }],
            },
          ],
        },
        ...overrides,
      },
    };
  }

  it('maps a real issue shape, including the id rather than the key as its handle', () => {
    const mapped = mapIssue(issue(), ME);

    expect(mapped).toMatchObject({
      id: '10421',
      key: 'ENG-421',
      projectKey: 'ENG',
      title: 'Webhook receiver drops events past 500/min',
      role: 'assignee',
      stateName: 'In Progress',
      stateCategory: 'in-progress',
      priority: 'urgent',
      assigneeName: 'Max Chen',
      reporterName: 'Sam Lee',
      description: 'Details.',
    });
  });

  // The JQL matches on three roles at once and a person is often more than
  // one of them; this is the precedence the single-role-per-row UI renders.
  it('picks the strongest role claim: assignee, then reporter, then watcher', () => {
    expect(mapIssue(issue(), ME)?.role).toBe('assignee');
    expect(
      mapIssue(
        issue({
          assignee: { accountId: SOMEONE_ELSE },
          reporter: { accountId: ME },
        }),
        ME,
      )?.role,
    ).toBe('reporter');
    expect(
      mapIssue(
        issue({
          assignee: { accountId: SOMEONE_ELSE },
          reporter: { accountId: SOMEONE_ELSE },
        }),
        ME,
      )?.role,
    ).toBe('watcher');
  });

  it('degrades an unassigned, priority-less, description-less issue instead of throwing', () => {
    const mapped = mapIssue(
      issue({ assignee: null, priority: null, description: null }),
      ME,
    );

    expect(mapped).toMatchObject({
      assigneeName: 'Unassigned',
      priority: 'none',
      description: '',
      attachments: [],
    });
  });

  // Story points and sprint live in per-site custom fields with no portable
  // id, which is why the search asks for `expand=names` — matching on the
  // displayed field name is what makes this work on a site we've never seen.
  it('finds story points and sprint by their displayed field names, not a hardcoded id', () => {
    const mapped = mapIssue(
      {
        ...issue(),
        fields: {
          ...issue().fields,
          customfield_10016: 5,
          customfield_10020: [
            { name: 'Ingest 23', state: 'closed' },
            { name: 'Ingest 24', state: 'active' },
          ],
          parent: { fields: { summary: 'Ingest hardening' } },
        },
      },
      ME,
      {
        customfield_10016: 'Story point estimate',
        customfield_10020: 'Sprint',
      },
    );

    expect(mapped).toMatchObject({
      storyPoints: 5,
      sprintName: 'Ingest 24',
      epicName: 'Ingest hardening',
    });
  });

  it('leaves story points and sprint null when the site has no such fields', () => {
    expect(mapIssue(issue(), ME)).toMatchObject({
      storyPoints: null,
      sprintName: null,
      epicName: null,
    });
  });

  // For a sub-task, `fields.parent` is the parent *story* — taking it as the
  // epic labelled that story "Epic ·" in the drawer. The value was right; the
  // label was a lie.
  describe('the epic chip only ever names an actual epic', () => {
    function withParent(
      parentFields: Record<string, unknown>,
      extraFields: Record<string, unknown> = {},
      names: Record<string, string> = {},
    ) {
      return mapIssue(
        {
          ...issue(),
          fields: {
            ...issue().fields,
            parent: { fields: parentFields },
            ...extraFields,
          },
        },
        ME,
        names,
      );
    }

    it('takes the parent when it is an epic, by hierarchy level', () => {
      expect(
        withParent({
          summary: 'Ingest hardening',
          issuetype: { name: 'Epic', hierarchyLevel: 1 },
        }),
      ).toMatchObject({ epicName: 'Ingest hardening' });
    });

    it('takes the parent when it is an epic by name alone, on a site with no hierarchy level', () => {
      expect(
        withParent({
          summary: 'Ingest hardening',
          issuetype: { name: 'Epic' },
        }),
      ).toMatchObject({ epicName: 'Ingest hardening' });
    });

    it("does not call a sub-task's parent story an epic", () => {
      expect(
        withParent({
          summary: 'Rewrite the ingest pipeline',
          issuetype: { name: 'Story', hierarchyLevel: 0, subtask: false },
        }),
      ).toMatchObject({ epicName: null });
    });

    it('falls back to Epic Link for a sub-task, so the real epic still shows', () => {
      expect(
        withParent(
          {
            summary: 'Rewrite the ingest pipeline',
            issuetype: { name: 'Story', hierarchyLevel: 0 },
          },
          { customfield_10014: 'Ingest hardening' },
          { customfield_10014: 'Epic Link' },
        ),
      ).toMatchObject({ epicName: 'Ingest hardening' });
    });

    // Every other field in this mapper degrades toward what the caller had
    // before; a parent with no issuetype is a trimmed payload, not evidence
    // of a sub-task.
    it('still trusts a parent whose payload carries no issue type', () => {
      expect(withParent({ summary: 'Ingest hardening' })).toMatchObject({
        epicName: 'Ingest hardening',
      });
    });
  });

  it('returns null for a payload that is not an issue', () => {
    expect(mapIssue({ nope: true }, ME)).toBeNull();
  });
});

describe('mapTransitions', () => {
  const RAW = [
    {
      id: '21',
      to: { name: 'In Review', statusCategory: { key: 'indeterminate' } },
      fields: {},
    },
    {
      id: '31',
      to: { name: 'Done', statusCategory: { key: 'done' } },
      fields: {
        resolution: {
          required: true,
          name: 'Resolution',
          schema: { type: 'resolution' },
          allowedValues: [
            { id: '10000', name: 'Done' },
            { id: '10001', name: "Won't Do" },
          ],
        },
        timetracking: {
          required: false,
          name: 'Time tracking',
          schema: { type: 'timetracking' },
        },
        summary: {
          required: false,
          name: 'Summary',
          schema: { type: 'string' },
        },
      },
    },
  ];

  it('maps a transition with no screen to an empty field list', () => {
    expect(mapTransitions(RAW)[0]).toEqual({
      id: '21',
      targetStateName: 'In Review',
      targetStateCategory: 'in-progress',
      requiresFields: [],
    });
  });

  it('keeps required fields and time tracking, and drops every other optional field', () => {
    const done = mapTransitions(RAW)[1];

    expect(done.requiresFields.map((f) => f.key)).toEqual([
      'resolution',
      'timetracking',
    ]);
    expect(done.requiresFields[0]).toMatchObject({
      label: 'Resolution',
      type: 'select',
      required: true,
      options: ['Done', "Won't Do"],
    });
    expect(done.requiresFields[1]).toMatchObject({
      type: 'text',
      required: false,
      hint: 'Optional on this workflow.',
    });
  });

  it('returns an empty list rather than throwing when transitions are absent', () => {
    expect(mapTransitions(undefined)).toEqual([]);
  });
});

describe('buildTransitionFieldsPayload', () => {
  const TRANSITION = {
    id: '31',
    fields: {
      resolution: {
        required: true,
        schema: { type: 'resolution' },
        allowedValues: [
          { id: '10000', value: 'Fixed' },
          { id: '10001', value: "Won't Do" },
        ],
      },
      timetracking: { required: false, schema: { type: 'timetracking' } },
      storypoints: { required: false, schema: { type: 'number' } },
    },
  };

  // The whole reason the client re-reads the transition immediately before
  // writing: the popover hands back the human-readable label, and only the
  // live allowedValues know this site's id for it.
  it('resolves a select label to the id this site actually uses', () => {
    expect(
      buildTransitionFieldsPayload(TRANSITION, { resolution: "Won't Do" }),
    ).toEqual({ resolution: { id: '10001' } });
  });

  it('matches a label case-insensitively', () => {
    expect(
      buildTransitionFieldsPayload(TRANSITION, { resolution: 'fixed' }),
    ).toEqual({ resolution: { id: '10000' } });
  });

  it('sends time tracking in the shape Jira expects, not as a bare string', () => {
    expect(
      buildTransitionFieldsPayload(TRANSITION, { timetracking: '3h 30m' }),
    ).toEqual({ timetracking: { timeSpent: '3h 30m' } });
  });

  it('coerces a numeric field', () => {
    expect(
      buildTransitionFieldsPayload(TRANSITION, { storypoints: '5' }),
    ).toEqual({ storypoints: 5 });
  });

  it('drops blank values and fields this transition screen does not have', () => {
    expect(
      buildTransitionFieldsPayload(TRANSITION, {
        resolution: '   ',
        somethingElse: 'x',
      }),
    ).toEqual({});
  });

  // Rather than silently discarding a field the user explicitly filled in,
  // send it by name and let Jira be the one to reject it.
  it('falls back to sending a stale select value by name', () => {
    expect(
      buildTransitionFieldsPayload(TRANSITION, { resolution: 'Renamed' }),
    ).toEqual({ resolution: { name: 'Renamed' } });
  });
});

describe('mapComment', () => {
  it('maps a v2 comment, whose body is already a plain string', () => {
    expect(
      mapComment(
        {
          id: '10500',
          author: { displayName: 'Sam Lee' },
          body: 'Replay log attached.',
          created: '2026-09-01T09:00:00.000+0000',
        },
        '10421',
      ),
    ).toEqual({
      id: '10500',
      ticketId: '10421',
      authorName: 'Sam Lee',
      body: 'Replay log attached.',
      createdAt: '2026-09-01T09:00:00.000+0000',
    });
  });

  // Defensive: a v3-shaped body must not render as "[object Object]".
  it('flattens an ADF body if one arrives anyway', () => {
    expect(
      mapComment(
        {
          id: '10501',
          author: { displayName: 'Max Chen' },
          body: {
            type: 'doc',
            content: [
              {
                type: 'paragraph',
                content: [{ type: 'text', text: 'Taking it.' }],
              },
            ],
          },
          created: '2026-09-01T09:30:00.000+0000',
        },
        '10421',
      )?.body,
    ).toBe('Taking it.');
  });
});
