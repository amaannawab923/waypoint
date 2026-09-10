import {
  adfToPlainText,
  buildTransitionFieldsPayload,
  formatFileSize,
  mapAttachments,
  mapComment,
  mapIssue,
  mapPriority,
  mapPriorityOptions,
  mapStateCategory,
  mapTransitions,
  mapUserOption,
  mapUserOptions,
  normalizeJiraSite,
  wikiMarkupToPlainText,
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

  // Nodes that carry their whole content in `attrs` and have no `content`
  // array. Each of these used to fall through to the generic branch and
  // return '' — content loss, not lost formatting.
  describe('leaf nodes whose text lives in attrs', () => {
    const para = (...content: unknown[]) => ({
      type: 'doc',
      content: [{ type: 'paragraph', content }],
    });

    // Jira auto-converts a pasted Jira/Confluence link into an inlineCard, so
    // a description that was one pasted link rendered completely empty.
    it('renders an inlineCard as its URL', () => {
      expect(
        adfToPlainText(
          para(
            { type: 'text', text: 'see ' },
            { type: 'inlineCard', attrs: { url: 'https://x.dev/ENG-1' } },
          ),
        ).trim(),
      ).toBe('see https://x.dev/ENG-1');
    });

    // Block-level, unlike inlineCard — so they end their line. Without the
    // newline the URL glues to whatever follows ("…/pages/12345The API
    // returns 500"), which is the same run-together defect `taskItem` is in
    // the block set to prevent.
    it('renders blockCard and embedCard as their URL, on their own line', () => {
      expect(
        adfToPlainText({
          type: 'blockCard',
          attrs: { url: 'https://x.dev/a' },
        }),
      ).toBe('https://x.dev/a\n');
      expect(
        adfToPlainText({
          type: 'embedCard',
          attrs: { url: 'https://x.dev/b' },
        }),
      ).toBe('https://x.dev/b\n');
    });

    it('does not run a block card into the paragraph after it', () => {
      const out = adfToPlainText({
        type: 'doc',
        content: [
          { type: 'blockCard', attrs: { url: 'https://x.dev/a' } },
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'The API returns 500' }],
          },
        ],
      });
      expect(out).toBe('https://x.dev/a\nThe API returns 500\n');
    });

    // Atlassian: "Either data or url must be provided, but not both." Reading
    // only `url` left the data variant rendering empty — the exact symptom
    // these branches exist to fix.
    it('reads a card that carries data instead of url', () => {
      expect(
        adfToPlainText({
          type: 'inlineCard',
          attrs: {
            data: { '@type': 'Object', name: 'ENG-1', url: 'https://x.dev/1' },
          },
        }),
      ).toBe('https://x.dev/1');
      // Falls back to the human-readable name when data carries no url.
      expect(
        adfToPlainText({
          type: 'inlineCard',
          attrs: { data: { '@type': 'Object', name: 'ENG-1 Fix login' } },
        }),
      ).toBe('ENG-1 Fix login');
    });

    // A description that is one screenshot — a common way to file a bug —
    // rendered completely blank. Alt text is the only thing an image can
    // contribute to a plain-text surface.
    it('renders an image as its alt text', () => {
      expect(
        adfToPlainText({
          type: 'doc',
          content: [
            {
              type: 'mediaSingle',
              content: [
                {
                  type: 'media',
                  attrs: {
                    type: 'file',
                    id: 'abc',
                    alt: 'architecture diagram',
                  },
                },
              ],
            },
          ],
        }).trim(),
      ).toBe('architecture diagram');
    });

    // The suite was green while this was broken, because it only ever covered
    // mediaSingle. mediaGroup is what the editor emits for MORE than one
    // attachment, and without it every alt ran into the next and then into
    // the following paragraph.
    it('keeps images in a media group on their own lines', () => {
      expect(
        adfToPlainText({
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'Login fails. See:' }],
            },
            {
              type: 'mediaGroup',
              content: [
                { type: 'media', attrs: { alt: 'error toast' } },
                { type: 'media', attrs: { alt: 'network tab' } },
              ],
            },
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'Repro on staging only.' }],
            },
          ],
        }).trim(),
      ).toBe(
        'Login fails. See:\nerror toast\nnetwork tab\nRepro on staging only.',
      );
    });

    // A caption is a legal sibling of the media inside mediaSingle, and is not
    // a block — so the image has to end its own line or the two run together.
    it('does not run an image into its own caption', () => {
      expect(
        adfToPlainText({
          type: 'mediaSingle',
          content: [
            { type: 'media', attrs: { alt: 'architecture diagram' } },
            {
              type: 'caption',
              content: [{ type: 'text', text: 'Figure 1' }],
            },
          ],
        }).trim(),
      ).toBe('architecture diagram\nFigure 1');
    });

    it('renders an inline image as its alt text', () => {
      expect(
        adfToPlainText({
          type: 'mediaInline',
          attrs: { type: 'file', id: 'abc', alt: 'signature' },
        }),
      ).toBe('signature');
    });

    // Silent rather than inventing a filename: an unlabelled image has no
    // text a reader can use, and "abc-1234.png" is noise, not content.
    it('says nothing for an image with no alt text', () => {
      expect(
        adfToPlainText({
          type: 'media',
          attrs: { type: 'file', id: 'abc-1234' },
        }),
      ).toBe('');
    });

    it('renders a status lozenge as its word', () => {
      expect(
        adfToPlainText(
          para({ type: 'status', attrs: { text: 'BLOCKED', color: 'red' } }),
        ).trim(),
      ).toBe('BLOCKED');
    });

    it('renders a date as a date, with no invented time of day', () => {
      expect(
        adfToPlainText(
          para({ type: 'date', attrs: { timestamp: '1767225600000' } }),
        ).trim(),
      ).toBe('2026-01-01');
    });

    // A date node whose value is out of JavaScript's Date range made
    // toISOString THROW, and neither getTicket nor listComments wraps its
    // mapping — so it escaped ipcMain.handle and rejected the IPC call rather
    // than returning a JiraResult failure. One bad node blanked a whole
    // ticket or comment thread. This file's contract is that a malformed
    // field degrades, never throws.
    it.each([
      ['nanoseconds', '1710460800000000000'],
      ['just past the Date range', '8640000000000001'],
      ['whitespace only', '   '],
      ['hex', '0x1000'],
      ['not a number at all', 'soon'],
    ])('renders nothing, and does not throw, for a %s timestamp', (_l, ts) => {
      const doc = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'date', attrs: { timestamp: ts } }],
          },
        ],
      };
      expect(() => adfToPlainText(doc)).not.toThrow();
      expect(adfToPlainText(doc).trim()).toBe('');
    });

    // Above year 9999 ISO 8601 uses the expanded form
    // ("+010000-01-01T…"), and slicing ten characters off that gives
    // "+010000-01" — a date with no day. A microsecond epoch (the same units
    // mistake as nanoseconds, one order down) lands inside the range guard
    // and rendered exactly that.
    it.each([
      ['a microsecond epoch', '1582152559000000'],
      ['the year-10000 boundary', '253402300800000'],
      ['the far negative end', '-8640000000000000'],
    ])('renders nothing for %s rather than a date with no day', (_l, ts) => {
      const out = adfToPlainText({
        type: 'date',
        attrs: { timestamp: ts },
      });
      expect(out).not.toContain('+');
      expect(out).toBe('');
    });

    // Atlassian's own published example for this node is "1582152559" — ten
    // digits, SECONDS — so a producer following the docs literally had every
    // date render as some day in January 1970 (that value read as ms).
    it('reads a seconds epoch as seconds, not as January 1970', () => {
      expect(
        adfToPlainText({ type: 'date', attrs: { timestamp: '1582152559' } }),
      ).toBe('2020-02-19');
    });

    // The band that still has to work.
    it('still renders an ordinary millisecond timestamp', () => {
      expect(
        adfToPlainText({ type: 'date', attrs: { timestamp: '1710460800000' } }),
      ).toBe('2024-03-15');
    });

    it('keeps a collapsible section\u2019s title, which lives in attrs', () => {
      expect(
        adfToPlainText({
          type: 'expand',
          attrs: { title: 'Acceptance criteria' },
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'must log in' }],
            },
          ],
        }).trim(),
      ).toBe('Acceptance criteria\nmust log in');
    });

    it('keeps documented blockTaskItem entries on their own lines', () => {
      expect(
        adfToPlainText({
          type: 'doc',
          content: [
            {
              type: 'taskList',
              content: [
                {
                  type: 'blockTaskItem',
                  content: [{ type: 'text', text: 'buy milk' }],
                },
                {
                  type: 'blockTaskItem',
                  content: [{ type: 'text', text: 'buy eggs' }],
                },
              ],
            },
          ],
        }).trim(),
      ).toBe('buy milk\nbuy eggs');
    });

    it('does not throw on a malformed date or a card with no url', () => {
      expect(adfToPlainText(para({ type: 'date', attrs: {} })).trim()).toBe('');
      expect(
        adfToPlainText(para({ type: 'date', attrs: { timestamp: 'soon' } })),
      ).toBe('\n');
      expect(adfToPlainText(para({ type: 'inlineCard' })).trim()).toBe('');
    });
  });

  // The checklist Jira calls "Action items". Without taskItem in the block
  // set these ran together as one sentence, so separate acceptance criteria
  // stopped reading as separate.
  it('keeps task list items on their own lines', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'taskList',
          content: [
            {
              type: 'taskItem',
              content: [{ type: 'text', text: 'buy milk' }],
            },
            {
              type: 'taskItem',
              content: [{ type: 'text', text: 'buy eggs' }],
            },
          ],
        },
      ],
    };

    expect(adfToPlainText(doc).trim()).toBe('buy milk\nbuy eggs');
  });

  // ---- Regression pins for behavior that must NOT change ----------------
  //
  // adfToPlainText renders every description and every comment, so a change
  // here moves text on every ticket at once. These pin the shapes that
  // already worked, so a future edit to the block set or the leaf branches
  // cannot quietly alter them.
  describe('existing flattening, pinned', () => {
    it('keeps headings, quotes, code blocks and list items line-separated', () => {
      const doc = {
        type: 'doc',
        content: [
          {
            type: 'heading',
            attrs: { level: 2 },
            content: [{ type: 'text', text: 'Steps' }],
          },
          {
            type: 'bulletList',
            content: [
              {
                type: 'listItem',
                content: [
                  {
                    type: 'paragraph',
                    content: [{ type: 'text', text: 'one' }],
                  },
                ],
              },
              {
                type: 'listItem',
                content: [
                  {
                    type: 'paragraph',
                    content: [{ type: 'text', text: 'two' }],
                  },
                ],
              },
            ],
          },
          {
            type: 'blockquote',
            content: [
              { type: 'paragraph', content: [{ type: 'text', text: 'said' }] },
            ],
          },
          {
            type: 'codeBlock',
            content: [{ type: 'text', text: 'const x = 1;' }],
          },
        ],
      };

      expect(adfToPlainText(doc).trim()).toBe(
        'Steps\none\n\ntwo\n\nsaid\n\nconst x = 1;',
      );
    });

    // Documented, deliberate and unchanged: a table flattens to its cell
    // text, one line per ROW. Cells are not separated, which is why this is
    // pinned rather than left to drift — the fix above deliberately did not
    // touch tables.
    it('still flattens a table to one line per row', () => {
      const doc = {
        type: 'doc',
        content: [
          {
            type: 'table',
            content: [
              {
                type: 'tableRow',
                content: [
                  {
                    type: 'tableCell',
                    content: [
                      {
                        type: 'paragraph',
                        content: [{ type: 'text', text: 'a' }],
                      },
                    ],
                  },
                  {
                    type: 'tableCell',
                    content: [
                      {
                        type: 'paragraph',
                        content: [{ type: 'text', text: 'b' }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      };

      // One line per cell-paragraph, no separator between cells — pre-existing
      // and deliberately untouched here.
      expect(adfToPlainText(doc).trim()).toBe('a\nb');
    });

    it('still never surfaces a mention account id', () => {
      const out = adfToPlainText({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'mention',
                attrs: { id: '712020:8f1e-aaa', text: '@Priya Raman' },
              },
            ],
          },
        ],
      });
      expect(out).toContain('@Priya Raman');
      expect(out).not.toContain('712020');
    });

    it('still ignores an unknown node type without throwing', () => {
      expect(
        adfToPlainText({
          type: 'doc',
          content: [
            {
              type: 'somethingAtlassianAddedLater',
              content: [{ type: 'text', text: 'inner' }],
            },
          ],
        }),
      ).toBe('inner');
    });
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

describe('mapAttachments', () => {
  // A realistic attachment object, with every field a real Jira Cloud response
  // carries — including the three URL fields this mapper deliberately drops.
  const ATTACHMENT = {
    self: 'https://waypoint123.atlassian.net/rest/api/3/attachment/10050',
    id: '10050',
    filename: 'replay-log.txt',
    author: { accountId: 'acct-sam', displayName: 'Sam Lee' },
    created: '2026-09-01T09:00:00.000+0000',
    size: 219136,
    mimeType: 'text/plain',
    content:
      'https://waypoint123.atlassian.net/rest/api/3/attachment/content/10050',
    thumbnail:
      'https://waypoint123.atlassian.net/rest/api/3/attachment/thumbnail/10050',
  };

  it('carries the id, the raw byte count and the mime type alongside the label', () => {
    expect(mapAttachments([ATTACHMENT])).toEqual([
      {
        id: '10050',
        fileName: 'replay-log.txt',
        sizeLabel: '214 KB',
        sizeBytes: 219136,
        mimeType: 'text/plain',
        uploaderName: 'Sam Lee',
      },
    ]);
  });

  it('coerces a numeric id rather than losing the download over it', () => {
    expect(mapAttachments([{ ...ATTACHMENT, id: 10050 }])[0].id).toBe('10050');
  });

  // Not dropped, unlike an idless priority option or assignable user: the name
  // and size are still true and still worth showing. It is only the download
  // that becomes impossible, and null is how the UI is told so.
  it('keeps an attachment with no usable id, marking it unaddressable', () => {
    expect(mapAttachments([{ ...ATTACHMENT, id: null }])[0]).toMatchObject({
      id: null,
      fileName: 'replay-log.txt',
    });
  });

  it('degrades a payload that is missing everything instead of throwing', () => {
    expect(mapAttachments([{}])).toEqual([
      {
        id: null,
        fileName: 'attachment',
        sizeLabel: '0 B',
        sizeBytes: 0,
        mimeType: 'application/octet-stream',
        uploaderName: 'Someone',
      },
    ]);
  });

  /**
   * The security property this whole shape exists for.
   *
   * A download is an authenticated request carrying HTTP Basic
   * `email:apiToken` — a bearer credential for the user's entire Atlassian
   * account. If the URL for that request were read out of a JSON response
   * body, then whatever host that field named would receive the credential.
   * `content` is a field Jira fills in and this app cannot verify.
   *
   * The strongest available proof is structural rather than behavioural: a
   * caller cannot misuse a field that does not exist on the type it is handed.
   * So this asserts on the mapped object's own keys — not merely that a
   * hostile URL went unused on some particular code path today, but that there
   * is no property on the wire shape a future caller could reach for at all.
   */
  it('never carries a URL out of the response, hostile or otherwise', () => {
    const [mapped] = mapAttachments([
      {
        ...ATTACHMENT,
        content: 'https://evil.example/x',
        self: 'https://evil.example/self',
        thumbnail: 'https://evil.example/thumb',
      },
    ]);

    expect(Object.keys(mapped).sort()).toEqual([
      'fileName',
      'id',
      'mimeType',
      'sizeBytes',
      'sizeLabel',
      'uploaderName',
    ]);
    expect(JSON.stringify(mapped)).not.toContain('evil.example');
    expect(JSON.stringify(mapped)).not.toContain('http');
  });

  it('reports a non-array attachment field as no attachments', () => {
    expect(mapAttachments(undefined)).toEqual([]);
    expect(mapAttachments(null)).toEqual([]);
  });
});

describe('mapPriorityOptions', () => {
  it('reads the allowedValues off an issue’s editmeta', () => {
    expect(
      mapPriorityOptions({
        fields: {
          summary: { required: true, name: 'Summary' },
          priority: {
            required: false,
            name: 'Priority',
            schema: { type: 'priority', system: 'priority' },
            allowedValues: [
              {
                self: 'https://waypoint123.atlassian.net/rest/api/3/priority/1',
                iconUrl: 'https://waypoint123.atlassian.net/images/highest.svg',
                name: 'Highest',
                id: '1',
              },
              { name: 'Medium', id: '3' },
            ],
          },
        },
      }),
    ).toEqual([
      { id: '1', name: 'Highest' },
      { id: '3', name: 'Medium' },
    ]);
  });

  // Priority missing from editmeta means it is not editable on this issue
  // type — a real, ordinary answer. It has to be distinguishable from a
  // failure by the caller, so it produces an empty list rather than throwing.
  it.each<[unknown, string]>([
    [{ fields: { summary: { required: true } } }, 'no priority field at all'],
    [{ fields: { priority: { name: 'Priority' } } }, 'no allowedValues key'],
    [{ fields: { priority: { allowedValues: [] } } }, 'an empty allowedValues'],
    [{ fields: {} }, 'no editable fields'],
    [{}, 'no fields key'],
    [null, 'a null body'],
    ['not an object', 'a non-object body'],
  ])('returns [] for %#: %s', (editmeta) => {
    expect(mapPriorityOptions(editmeta)).toEqual([]);
  });

  // An option the picker cannot write back is worse than one not offered:
  // the only thing clicking it could do is fail.
  it('drops an entry with no usable id', () => {
    expect(
      mapPriorityOptions({
        fields: {
          priority: {
            allowedValues: [
              { name: 'Highest' },
              { id: '3', name: 'Medium' },
              null,
            ],
          },
        },
      }),
    ).toEqual([{ id: '3', name: 'Medium' }]);
  });

  // A real priority the issue accepts, offered under its id rather than
  // hidden — hiding it would be this app deciding the user may not pick
  // something their own Jira allows.
  it('keeps a nameless option, labelled by its id', () => {
    expect(
      mapPriorityOptions({
        fields: { priority: { allowedValues: [{ id: 7 }] } },
      }),
    ).toEqual([{ id: '7', name: '7' }]);
  });
});

describe('mapUserOption', () => {
  // A realistic /user/assignable/search entry: Jira sends considerably more
  // than the picker needs, including personal details about a colleague.
  const RAW_USER = {
    self: 'https://waypoint123.atlassian.net/rest/api/3/user?accountId=aaaa',
    accountId: SOMEONE_ELSE,
    accountType: 'atlassian',
    emailAddress: 'sam@northwind.dev',
    avatarUrls: {
      '48x48': 'https://avatar.example/48',
      '24x24': 'https://avatar.example/24',
    },
    displayName: 'Sam Lee',
    active: true,
    timeZone: 'Europe/London',
    locale: 'en_GB',
  };

  it('reduces a user to the id, the name and an avatar', () => {
    expect(mapUserOption(RAW_USER)).toEqual({
      accountId: SOMEONE_ELSE,
      displayName: 'Sam Lee',
      avatarUrl: 'https://avatar.example/48',
    });
  });

  // A picker needs a name and a write needs an id. A colleague's email
  // address is neither, and it has no business crossing into the renderer
  // because a typeahead happened to match them.
  it('leaves a colleague’s email and locale behind at the boundary', () => {
    const mapped = mapUserOption(RAW_USER);

    expect(JSON.stringify(mapped)).not.toContain('sam@northwind.dev');
    expect(mapped).not.toHaveProperty('emailAddress');
    expect(mapped).not.toHaveProperty('locale');
  });

  it('falls back through the avatar sizes, and to null when there are none', () => {
    expect(
      mapUserOption({
        accountId: SOMEONE_ELSE,
        displayName: 'Sam Lee',
        avatarUrls: { '24x24': 'https://avatar.example/24' },
      }),
    ).toMatchObject({ avatarUrl: 'https://avatar.example/24' });
    expect(
      mapUserOption({ accountId: SOMEONE_ELSE, displayName: 'Sam Lee' }),
    ).toMatchObject({ avatarUrl: null });
  });

  // An account id is not a name — putting one on screen is the same leak
  // adfToPlainText deliberately refuses to make for a mention node.
  it('labels a nameless user "Unknown" rather than by their account id', () => {
    const mapped = mapUserOption({ accountId: SOMEONE_ELSE });

    expect(mapped).toMatchObject({ displayName: 'Unknown' });
    expect(mapped?.displayName).not.toContain(SOMEONE_ELSE);
  });

  // The only thing a row with no id could do is fail on click, which is worse
  // than not offering it — the same call mapPriorityOptions makes.
  it('drops a user with no account id', () => {
    expect(mapUserOption({ displayName: 'Ghost' })).toBeNull();
    expect(mapUserOption(null)).toBeNull();
  });

  it('mapUserOptions drops the unusable entries and survives a non-array', () => {
    expect(mapUserOptions([RAW_USER, { displayName: 'Ghost' }, null])).toEqual([
      {
        accountId: SOMEONE_ELSE,
        displayName: 'Sam Lee',
        avatarUrl: 'https://avatar.example/48',
      },
    ]);
    expect(mapUserOptions({ values: [] })).toEqual([]);
    expect(mapUserOptions(undefined)).toEqual([]);
  });
});

describe('mapIssue', () => {
  // A description and a comment arrive in the same payloads and can arrive in
  // the same two shapes. `mapComment` guarded the string shape from the start;
  // `mapIssue` did not, so the account id this file says "must never reach the
  // screen" reached it through the description while the comment thread right
  // below it was clean.
  describe('description, when Jira answers with wiki markup', () => {
    function describedAs(description: unknown) {
      return mapIssue(
        { id: '10421', key: 'ENG-421', fields: { description } },
        ME,
      )?.description;
    }

    it('never renders a raw account id', () => {
      const out = describedAs(
        'Please look [~accountid:712020:8f1e-aaa] at this',
      );
      expect(out).not.toContain('accountid');
      expect(out).not.toContain('712020');
      expect(out).toBe('Please look @a teammate at this');
    });

    // The prefix-less form, which Server-era and Server->Cloud-migrated
    // bodies carry and where the "username" is frequently the account id.
    it('never renders a raw account id in the prefix-less mention form', () => {
      const out = describedAs('hi [~712020:8f1e-aaa] please look');
      expect(out).not.toContain('712020');
      expect(out).toBe('hi @a teammate please look');
    });

    it('strips wiki markers rather than showing them', () => {
      expect(describedAs('a *bold* word and {noformat}raw{noformat}')).toBe(
        'a bold word and raw',
      );
    });

    // The ADF path is the normal one and must be untouched by the guard.
    it('still reads a real ADF description', () => {
      expect(
        describedAs({
          type: 'doc',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'plain' }] },
          ],
        }),
      ).toBe('plain');
    });
  });

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
        priority: { id: '1', name: 'Highest' },
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
      priorityId: '1',
      priorityName: 'Highest',
      assigneeName: 'Max Chen',
      assigneeAccountId: ME,
      reporterName: 'Sam Lee',
      description: 'Details.',
    });
  });

  // The queue's default sort keys on this field (useMyJiraQueue.ts's
  // compareTickets), so a fabricated "now" here used to pin an untouched
  // issue to the top of every refresh.
  describe('updatedAt, when Jira omits `updated`', () => {
    it('maps null rather than the current time', () => {
      expect(mapIssue(issue({ updated: undefined }), ME)).toMatchObject({
        updatedAt: null,
      });
    });

    it('still carries a real `updated` through untouched', () => {
      expect(
        mapIssue(issue({ updated: '2026-09-01T10:00:00.000+0000' }), ME),
      ).toMatchObject({ updatedAt: '2026-09-01T10:00:00.000+0000' });
    });
  });

  // The same split priority already has between its display word and its
  // writable id: `assigneeName` is a label (and "Unassigned" is this app's own
  // fallback, not something Jira said), while the account id is the only thing
  // an assignee write can be built from and the only thing that tells the two
  // apart.
  describe('the assignee’s account id, alongside the display name', () => {
    it('carries the real account id of whoever is assigned', () => {
      expect(
        mapIssue(
          issue({
            assignee: { accountId: SOMEONE_ELSE, displayName: 'Sam Lee' },
          }),
          ME,
        ),
      ).toMatchObject({
        assigneeName: 'Sam Lee',
        assigneeAccountId: SOMEONE_ELSE,
      });
    });

    it('reports a genuinely unassigned issue as a null id, not an empty string', () => {
      expect(mapIssue(issue({ assignee: null }), ME)).toMatchObject({
        assigneeName: 'Unassigned',
        assigneeAccountId: null,
      });
    });

    // The case the name alone cannot express: an assignee object Jira returned
    // without a readable display name still renders as "Unassigned", so the id
    // is what stops the picker from believing nobody is on the issue.
    it('keeps the id when Jira returns an assignee with no display name', () => {
      expect(
        mapIssue(issue({ assignee: { accountId: SOMEONE_ELSE } }), ME),
      ).toMatchObject({
        assigneeName: 'Unassigned',
        assigneeAccountId: SOMEONE_ELSE,
      });
    });
  });

  // The normalized bucket and the site's own id/name are both carried, and
  // neither substitutes for the other: 'urgent' is what PriorityIcon draws,
  // and it is also a word no real Jira site has a priority called — so a
  // write has to be built from the id.
  describe('the site’s own priority id and name, alongside the bucket', () => {
    it('carries a custom scheme’s real label even when the bucket is none', () => {
      expect(
        mapIssue(
          issue({ priority: { id: '10100', name: 'Drop everything' } }),
          ME,
        ),
      ).toMatchObject({
        priority: 'none',
        priorityId: '10100',
        priorityName: 'Drop everything',
      });
    });

    // Current Jira returns the id as a string; older and proxied payloads
    // hand back a number, and dropping it there would silently make the
    // ticket unwritable.
    it('coerces a numeric id rather than dropping it', () => {
      expect(
        mapIssue(issue({ priority: { id: 3, name: 'Medium' } }), ME),
      ).toMatchObject({ priorityId: '3', priorityName: 'Medium' });
    });

    it('reports no id, and "None" as a display fallback, when the issue has no priority', () => {
      expect(mapIssue(issue({ priority: null }), ME)).toMatchObject({
        priority: 'none',
        priorityId: null,
        priorityName: 'None',
      });
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
          watches: { watchCount: 2, isWatching: true },
        }),
        ME,
      )?.role,
    ).toBe('watcher');
  });

  describe('when none of the three roles is yours', () => {
    // The bug this replaced: 'watcher' was the unconditional fallback, so
    // any issue that wasn't yours by assignee or reporter was reported as
    // one you watch — whether or not you do. Reassigning a ticket away from
    // yourself makes that the common case, because every write re-reads its
    // issue through getTicket, which runs no JQL and so cannot support the
    // "it's in your queue, so it must be one of the three" inference.
    it('reports "none" when Jira says outright that you are not watching', () => {
      expect(
        mapIssue(
          issue({
            assignee: { accountId: SOMEONE_ELSE, displayName: 'Sam Lee' },
            reporter: { accountId: SOMEONE_ELSE },
            watches: { watchCount: 1, isWatching: false },
          }),
          ME,
        )?.role,
      ).toBe('none');
    });

    // Absent assignee/reporter objects are a real, documented case — a
    // project's permission scheme can restrict who may see those fields — so
    // "not yours" must be reached from Jira's own answer about watching, not
    // from the fields that went missing.
    it('reports "none" even when the assignee and reporter were withheld entirely', () => {
      expect(
        mapIssue(
          issue({
            assignee: null,
            reporter: null,
            watches: { watchCount: 0, isWatching: false },
          }),
          ME,
        )?.role,
      ).toBe('none');
    });

    // The one case that must NOT change. A payload with no `watches` at all
    // has not said you are not watching; for an issue the my-work search
    // returned, watching is the only role left, and that inference is the
    // whole reason the old fallback existed. `undefined` is not `false`.
    it('still infers "watcher" when the payload says nothing about watching', () => {
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
  });

  it('degrades an unassigned, priority-less, description-less issue instead of throwing', () => {
    const mapped = mapIssue(
      issue({ assignee: null, priority: null, description: null }),
      ME,
    );

    expect(mapped).toMatchObject({
      assigneeName: 'Unassigned',
      priority: 'none',
      priorityId: null,
      priorityName: 'None',
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

  // The Greenhopper-era sprint field serializes ACTIVE|CLOSED|FUTURE; only the
  // modern object form is lower case. Comparing case-sensitively meant no
  // sprint matched on the older shape, so a carried-over ticket fell through
  // to "the last listed" and showed the name of a CLOSED sprint.
  it.each([['active'], ['ACTIVE'], ['Active']])(
    'finds the active sprint when its state is spelled %s',
    (state) => {
      const mapped = mapIssue(
        {
          id: '10421',
          key: 'ENG-421',
          fields: {
            summary: 's',
            project: { key: 'ENG' },
            status: { name: 'To Do', statusCategory: { key: 'new' } },
            // The active sprint is listed FIRST on purpose. With it last, the
            // "fall back to the last listed" path returns the same name by
            // coincidence and the test passes even when the casing check is
            // broken — which is exactly what happened on the first draft of
            // this test.
            customfield_10020: [
              { name: 'Ingest 24', state },
              { name: 'Ingest 23', state: 'closed' },
            ],
          },
        },
        ME,
        { customfield_10020: 'Sprint' },
      );
      expect(mapped).toMatchObject({ sprintName: 'Ingest 24' });
    },
  );

  // Regression pin: with no active sprint at all, the documented fallback is
  // still the last listed.
  it('still falls back to the last sprint listed when none is active', () => {
    const mapped = mapIssue(
      {
        id: '10421',
        key: 'ENG-421',
        fields: {
          summary: 's',
          project: { key: 'ENG' },
          status: { name: 'To Do', statusCategory: { key: 'new' } },
          customfield_10020: [
            { name: 'Ingest 23', state: 'closed' },
            { name: 'Ingest 24', state: 'closed' },
          ],
        },
      },
      ME,
      { customfield_10020: 'Sprint' },
    );
    expect(mapped).toMatchObject({ sprintName: 'Ingest 24' });
  });

  // ticket.id keys every subsequent write, so this is coercion, not cosmetics.
  it('carries a numeric issue id rather than falling back to the key', () => {
    expect(
      mapIssue(
        {
          id: 10421,
          key: 'ENG-421',
          fields: {
            summary: 's',
            project: { key: 'ENG' },
            status: { name: 'To Do', statusCategory: { key: 'new' } },
          },
        },
        ME,
      ),
    ).toMatchObject({ id: '10421' });
  });

  // isSafeInteger and > 0, not isFinite. The looser check made this strictly
  // worse than the fallback it replaced: ticket.id keys every write, so a
  // float id turned a graceful degradation to the key (which works as
  // issueIdOrKey in every Jira URL) into a 404 on the next transition.
  it.each([
    ['a float', 1.5],
    ['a negative', -5],
    ['zero', 0],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['NaN', Number.NaN],
    ['a non-id type', true],
  ])('falls back to the key rather than trusting %s as an id', (_l, id) => {
    expect(
      mapIssue(
        {
          id,
          key: 'ENG-7',
          fields: {
            summary: 's',
            project: { key: 'ENG' },
            status: { name: 'To Do', statusCategory: { key: 'new' } },
          },
        },
        ME,
      ),
    ).toMatchObject({ id: 'ENG-7' });
  });

  // Jira returns ids as STRINGS on every current API version, so validating
  // only the number branch validated the shape that almost never arrives.
  it.each([['1.5'], ['-3'], ['0'], ['1e21'], ['   ']])(
    'falls back to the key for the implausible string id %p',
    (id) => {
      expect(
        mapIssue(
          {
            id,
            key: 'ENG-7',
            fields: {
              summary: 's',
              project: { key: 'ENG' },
              status: { name: 'To Do', statusCategory: { key: 'new' } },
            },
          },
          ME,
        ),
      ).toMatchObject({ id: 'ENG-7' });
    },
  );

  it('keeps a large string id exactly, without number rounding', () => {
    expect(
      mapIssue(
        {
          id: '10000000000000000001',
          key: 'ENG-7',
          fields: {
            summary: 's',
            project: { key: 'ENG' },
            status: { name: 'To Do', statusCategory: { key: 'new' } },
          },
        },
        ME,
      ),
    ).toMatchObject({ id: '10000000000000000001' });
  });

  it('still falls back to the key when there is no usable id at all', () => {
    expect(
      mapIssue(
        {
          key: 'ENG-421',
          fields: {
            summary: 's',
            project: { key: 'ENG' },
            status: { name: 'To Do', statusCategory: { key: 'new' } },
          },
        },
        ME,
      ),
    ).toMatchObject({ id: 'ENG-421' });
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

  // ROAD-41 parity fields: labels, dueDate, subtasks, links, descriptionAdf.
  // `fields: '*all'` (jiraClient.ts) already asks Jira for every one of
  // these on both the search and the single-issue read, so the shapes below
  // are exactly what a real response carries — nothing here required a new
  // request parameter, only a mapping.
  describe('labels', () => {
    it('maps a real label list', () => {
      expect(
        mapIssue(issue({ labels: ['backend', 'needs-design'] }), ME),
      ).toMatchObject({ labels: ['backend', 'needs-design'] });
    });

    it('degrades to an empty array rather than throwing when labels are absent', () => {
      expect(mapIssue(issue({ labels: undefined }), ME)).toMatchObject({
        labels: [],
      });
    });
  });

  describe('dueDate', () => {
    // Jira's own shape for this field: a calendar date, no time, no offset.
    it('carries the date-only string through exactly as Jira sent it', () => {
      expect(mapIssue(issue({ duedate: '2026-09-18' }), ME)).toMatchObject({
        dueDate: '2026-09-18',
      });
    });

    // Not "today", not an ISO datetime with a fabricated time-of-day — see
    // this file's own note on updatedAt for why an invented value is worse
    // than an honest null.
    it('maps a missing duedate to null, never a fabricated date', () => {
      expect(mapIssue(issue({ duedate: undefined }), ME)).toMatchObject({
        dueDate: null,
      });
      expect(mapIssue(issue({ duedate: null }), ME)).toMatchObject({
        dueDate: null,
      });
    });
  });

  describe('subtasks', () => {
    it('maps exactly what JiraWireSubtask declares, nothing invented', () => {
      expect(
        mapIssue(
          issue({
            subtasks: [
              {
                id: '10501',
                key: 'ENG-422',
                fields: {
                  summary: 'Add a migration',
                  status: {
                    name: 'Done',
                    statusCategory: { key: 'done' },
                  },
                },
              },
            ],
          }),
          ME,
        ),
      ).toMatchObject({
        subtasks: [
          {
            id: '10501',
            key: 'ENG-422',
            title: 'Add a migration',
            stateName: 'Done',
            stateCategory: 'done',
          },
        ],
      });
    });

    it('maps an issue with no subtasks to an empty array, not null', () => {
      expect(mapIssue(issue({ subtasks: undefined }), ME)).toMatchObject({
        subtasks: [],
      });
      expect(mapIssue(issue({ subtasks: [] }), ME)).toMatchObject({
        subtasks: [],
      });
    });
  });

  describe('links', () => {
    // Jira nests inward/outward asymmetrically: only one side is present per
    // entry, and it names the direction THIS link was found in — the phrase
    // has to come from that side's own word, not the other one.
    it('reads the outward phrase and issue when found on the outward side', () => {
      expect(
        mapIssue(
          issue({
            issuelinks: [
              {
                id: '10900',
                type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
                outwardIssue: {
                  id: '10422',
                  key: 'ENG-423',
                  fields: {
                    summary: 'Ship the migration',
                    status: {
                      name: 'To Do',
                      statusCategory: { key: 'new' },
                    },
                  },
                },
              },
            ],
          }),
          ME,
        ),
      ).toMatchObject({
        links: [
          {
            id: '10422',
            relation: 'blocks',
            key: 'ENG-423',
            title: 'Ship the migration',
            stateName: 'To Do',
            stateCategory: 'todo',
          },
        ],
      });
    });

    it('reads the inward phrase and issue when found on the inward side', () => {
      expect(
        mapIssue(
          issue({
            issuelinks: [
              {
                id: '10901',
                type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
                inwardIssue: {
                  id: '10424',
                  key: 'ENG-425',
                  fields: {
                    summary: 'Cut the release',
                    status: {
                      name: 'In Progress',
                      statusCategory: { key: 'indeterminate' },
                    },
                  },
                },
              },
            ],
          }),
          ME,
        ),
      ).toMatchObject({
        links: [
          {
            id: '10424',
            relation: 'is blocked by',
            key: 'ENG-425',
            title: 'Cut the release',
            stateName: 'In Progress',
            stateCategory: 'in-progress',
          },
        ],
      });
    });

    it('maps an issue with no links to an empty array, not null', () => {
      expect(mapIssue(issue({ issuelinks: undefined }), ME)).toMatchObject({
        links: [],
      });
      expect(mapIssue(issue({ issuelinks: [] }), ME)).toMatchObject({
        links: [],
      });
    });
  });

  describe('descriptionAdf', () => {
    it('carries the raw ADF node alongside the flattened description', () => {
      const adf = {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'Details.' }] },
        ],
      };
      expect(mapIssue(issue({ description: adf }), ME)).toMatchObject({
        description: 'Details.',
        descriptionAdf: adf,
      });
    });

    // A description that is absent entirely — not present on the payload at
    // all, the trimmed-response case, distinct from an explicit null.
    it('maps null when the description is absent entirely', () => {
      expect(mapIssue(issue({ description: undefined }), ME)).toMatchObject({
        description: '',
        descriptionAdf: null,
      });
    });

    it('maps null when Jira explicitly returns no description', () => {
      expect(mapIssue(issue({ description: null }), ME)).toMatchObject({
        description: '',
        descriptionAdf: null,
      });
    });

    // Legacy wiki markup is a string, not an ADF document tree — carrying it
    // under descriptionAdf would mislabel it as something a rich renderer
    // could walk as a node.
    it('does not carry legacy wiki-markup text as if it were ADF', () => {
      expect(
        mapIssue(issue({ description: 'a *bold* word' }), ME),
      ).toMatchObject({
        description: 'a bold word',
        descriptionAdf: null,
      });
    });
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

  // This test used to assert `{ timeSpent }` and was named for getting the
  // shape right, which is how the wrong shape survived review: Jira's
  // TimeTrackingJsonBean has only `originalEstimate` and `remainingEstimate`,
  // and `timeSpent` belongs to `worklog` — a different field, written through
  // `update`, not `fields`. The old payload was accepted-and-ignored or
  // rejected, so a user who typed "3h 30m" on the way to Done believed they
  // had logged time against an issue with no worklog entry.
  it('sends time tracking as a remaining estimate, the member this field has', () => {
    expect(
      buildTransitionFieldsPayload(TRANSITION, { timetracking: '3h 30m' }),
    ).toEqual({ timetracking: { remainingEstimate: '3h 30m' } });
  });

  // The guard's own comment says an unknown field is dropped because it would
  // be a guaranteed 400. A bare `fields[key]` bracket read walks the
  // prototype chain, so these six names were all truthy and sailed straight
  // through it.
  it.each([
    ['constructor'],
    ['__proto__'],
    ['toString'],
    ['valueOf'],
    ['hasOwnProperty'],
    ['isPrototypeOf'],
  ])('drops the inherited property name %s', (key) => {
    expect(buildTransitionFieldsPayload(TRANSITION, { [key]: 'x' })).toEqual(
      {},
    );
  });

  // The guard must still drop what it always dropped, and still keep what it
  // always kept — this is the payload for every transition write.
  it('still drops an unknown field and a blank value, and still keeps a real one', () => {
    expect(
      buildTransitionFieldsPayload(TRANSITION, { notAFieldHere: 'x' }),
    ).toEqual({});
    expect(
      buildTransitionFieldsPayload(TRANSITION, { resolution: '   ' }),
    ).toEqual({});
    expect(
      buildTransitionFieldsPayload(TRANSITION, { resolution: 'Fixed' }),
    ).toEqual({ resolution: { id: '10000' } });
  });

  // The bare `fields[key]` read was doing two jobs; the prototype-chain fix
  // replaced only one of them. An OWN key whose metadata is falsy has no
  // schema and no allowedValues, so it would be forwarded as a raw string.
  it('drops an own field whose metadata is falsy', () => {
    expect(
      buildTransitionFieldsPayload(
        { fields: { customfield_1: null } },
        { customfield_1: 'hello' },
      ),
    ).toEqual({});
  });

  it('never sends timeSpent, which this field does not accept', () => {
    const payload = buildTransitionFieldsPayload(TRANSITION, {
      timetracking: '3h 30m',
    }) as Record<string, unknown>;
    expect(JSON.stringify(payload)).not.toContain('timeSpent');
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
      authorAccountId: null,
      body: 'Replay log attached.',
      createdAt: '2026-09-01T09:00:00.000+0000',
      parentId: null,
    });
  });

  // JiraTicketDetail.tsx's formatRelativeTime renders this field, and a
  // fabricated "now" would have shown a freshly-omitted `created` as
  // "just now" rather than the honest "Unknown".
  it('maps null, not the current time, when Jira omits `created`', () => {
    expect(
      mapComment(
        { id: '10502', author: { displayName: 'Sam Lee' }, body: 'No date.' },
        '10421',
      ),
    ).toEqual({
      id: '10502',
      ticketId: '10421',
      authorName: 'Sam Lee',
      authorAccountId: null,
      body: 'No date.',
      createdAt: null,
      parentId: null,
    });
  });

  // Live-confirmed against ENG-84: Jira sends `parentId` as a JSON number on
  // a comment that has a parent (`id` itself is a string on the very same
  // payload) — the same asymmetry `idOf` already exists to paper over for
  // every other id `mapIssue`/`mapComment` coerce.
  it("coerces a numeric parentId to a string, matching id's own coercion", () => {
    expect(
      mapComment(
        {
          id: '10192',
          author: { displayName: 'Sam Lee' },
          body: 'Reply should be like this.',
          created: '2026-09-01T09:05:00.000+0000',
          parentId: 10158,
        },
        '10421',
      ),
    ).toMatchObject({ id: '10192', parentId: '10158' });
  });

  // Jira only includes the key at all on a comment that HAS a parent — it is
  // absent, not present-and-null, on a top-level comment.
  it('maps a missing parentId to null, not to a fabricated top-level answer', () => {
    expect(
      mapComment(
        {
          id: '10158',
          author: { displayName: 'Sam Lee' },
          body: 'Hello',
          created: '2026-09-01T09:00:00.000+0000',
        },
        '10421',
      ),
    ).toMatchObject({ id: '10158', parentId: null });
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

  // A string body is legacy wiki markup, not plain text. Before this, the
  // string branch returned it verbatim, which is how a real Jira @mention
  // reached the screen as `[~accountid:...]`.
  describe('wikiMarkupToPlainText', () => {
    const CASES: Array<[name: string, input: string, expected: string]> = [
      ['heading markers', 'h2. Rollout plan', 'Rollout plan'],
      ['h1 through h6', 'h6. Small heading', 'Small heading'],
      ['bullet markers', '* first\n* second', 'first\nsecond'],
      ['nested bullets', '** deeper', 'deeper'],
      ['numbered list markers', '# one\n# two', 'one\ntwo'],
      ['bold', 'Ship *today* please', 'Ship today please'],
      ['emphasis', 'Ship _today_ please', 'Ship today please'],
      ['monospace', 'Run {{npm test}} first', 'Run npm test first'],
      [
        'links',
        'See [the doc|https://example.com/x] first',
        'See the doc (https://example.com/x) first',
      ],
      ['images', '!diagram.png!', '[image: diagram.png]'],
      [
        'images with attributes',
        '!diagram.png|thumbnail!',
        '[image: diagram.png]',
      ],
      ['noformat blocks', '{noformat}raw text{noformat}', 'raw text'],
      ['code blocks', '{code}const a = 1;{code}', 'const a = 1;'],
      ['code blocks with a language', '{code:java}int a;{code}', 'int a;'],
      ['quote blocks', '{quote}they said no{quote}', 'they said no'],
      // A bullet marker and a bold marker are both `*`; the line-level rule
      // has to run first or each corrupts the other.
      ['a bold run inside a bullet', '* *ship* it', 'ship it'],
    ];

    it.each(CASES)('unwraps %s', (_name, input, expected) => {
      expect(wikiMarkupToPlainText(input)).toBe(expected);
    });

    // A deliberate non-choice: hyphens and tildes are ordinary prose
    // characters, so stripping them would corrupt more than it fixed.
    it('leaves strikethrough and subscript markers alone', () => {
      const input = 'Window 2026-09-01 - 2026-09-05, -kept- and ~kept~';
      expect(wikiMarkupToPlainText(input)).toBe(input);
    });

    it('does not eat the underscores in a snake_case identifier', () => {
      expect(wikiMarkupToPlainText('set custom_field_name to 3')).toBe(
        'set custom_field_name to 3',
      );
    });

    // The property this whole fix exists to guarantee.
    const ACCOUNT_IDS = [
      '712020:6d51d3e3-1111-2222-3333-444455556666',
      '5f8a1b2c3d4e5f6a7b8c9d0e',
      '557058:abcd-efgh-ijkl',
      '63a1b2c3d4e5f60012345678',
    ];

    it.each(ACCOUNT_IDS)(
      'never renders the account id in a mention (%s)',
      (accountId) => {
        const output = wikiMarkupToPlainText(
          `[~accountid:${accountId}] can you take a look?`,
        );
        expect(output).toBe('@a teammate can you take a look?');
        expect(output).not.toContain('accountid');
        expect(output).not.toContain(accountId);
      },
    );

    it('uses a resolved display name when one is available', () => {
      const output = wikiMarkupToPlainText(
        '[~accountid:712020:6d51d3e3] please review',
        () => 'Amaan Nawab',
      );
      expect(output).toBe('@Amaan Nawab please review');
      expect(output).not.toContain('accountid');
    });

    it('falls back to the vague name when the resolver has no answer', () => {
      const output = wikiMarkupToPlainText(
        '[~accountid:712020:6d51d3e3] please review',
        () => null,
      );
      expect(output).toBe('@a teammate please review');
      expect(output).not.toContain('accountid');
    });

    it('handles several mentions in one body', () => {
      const output = wikiMarkupToPlainText(
        '[~accountid:111] and [~accountid:222] are both on this',
      );
      expect(output).toBe('@a teammate and @a teammate are both on this');
      expect(output).not.toContain('accountid');
    });

    it('returns an empty string for an empty body', () => {
      expect(wikiMarkupToPlainText('')).toBe('');
    });
  });

  it('runs a wiki-markup body through the flattener, mention and all', () => {
    const body = mapComment(
      {
        id: '10503',
        author: { displayName: 'Sam Lee' },
        body: '[~accountid:712020:6d51d3e3-1111] see *this* {{patch}}',
        created: '2026-09-01T11:00:00.000+0000',
      },
      '10421',
    )?.body;

    expect(body).toBe('@a teammate see this patch');
    expect(body).not.toContain('accountid');
  });
});
