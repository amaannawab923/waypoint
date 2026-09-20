import {
  BROWSER_TOOL_PREFIX,
  browserGuardHooks,
  createBrowserGuard,
} from './browserGuard';

const t = (name: string) => `${BROWSER_TOOL_PREFIX}${name}`;

// The response shapes seen live from the bridge (SDK hooks probe, 2026-09-21).
const CREATED = [
  { type: 'text', text: 'Created new tab. Tab ID: 1121530135' },
  {
    type: 'text',
    text: '\n\nTab Context:\n- Executed on tabId: 1121530135\n- Available tabs:\n  • tabId 1121530134: "New tab" ("chrome://newtab/")\n  • tabId 1121530135: "New tab" ("")',
  },
];
const CONTEXT = [
  {
    type: 'text',
    text: '{"availableTabs":[{"tabId":1121530134,"title":"New Tab","url":"chrome://newtab/"}],"tabGroupId":1025656815}',
  },
];

describe('createBrowserGuard', () => {
  it("learns this turn's tabs from tabs_create_mcp and tabs_context_mcp responses, and from nothing else", () => {
    const g = createBrowserGuard();
    expect(g.tabs.size).toBe(0);
    g.observe(t('tabs_context_mcp'), CONTEXT);
    expect([...g.tabs]).toEqual([1121530134]);
    g.observe(t('tabs_create_mcp'), CREATED);
    expect([...g.tabs].sort()).toEqual([1121530134, 1121530135]);
    // A navigate's response also names tabs — not a source of ownership.
    g.observe(t('navigate'), [
      { type: 'text', text: 'Executed on tabId: 999' },
    ]);
    expect(g.tabs.has(999)).toBe(false);
  });

  it('always allows listing and creating tabs; never allows files, other browsers, shortcuts, or JavaScript', () => {
    const g = createBrowserGuard();
    for (const name of [
      'tabs_context_mcp',
      'tabs_create_mcp',
      'list_connected_browsers',
      'shortcuts_list',
    ]) {
      expect(g.decide(t(name), {})).toEqual({ allow: true });
    }
    g.observe(t('tabs_create_mcp'), CREATED);
    for (const name of [
      'file_upload',
      'upload_image',
      'switch_browser',
      'select_browser',
      'shortcuts_execute',
      'javascript_tool',
    ]) {
      const d = g.decide(t(name), { tabId: 1121530135 });
      expect(d.allow).toBe(false);
    }
    expect(g.decide(t('javascript_tool'), { tabId: 1121530135 })).toMatchObject(
      {
        reason: expect.stringContaining('read_page'),
      },
    );
  });

  it('acting tools must name a tab this turn opened — no tabId, an unknown tabId, and a string id all follow the same rule', () => {
    const g = createBrowserGuard();
    // Before any tab exists, nothing can act.
    expect(g.decide(t('computer'), { action: 'screenshot' }).allow).toBe(false);
    g.observe(t('tabs_create_mcp'), CREATED);
    expect(
      g.decide(t('computer'), { action: 'screenshot', tabId: 1121530135 }),
    ).toEqual({ allow: true });
    expect(g.decide(t('read_page'), { tabId: '1121530134' })).toEqual({
      allow: true,
    });
    expect(g.decide(t('computer'), { action: 'screenshot' })).toMatchObject({
      allow: false,
      reason: expect.stringContaining('may only act on a tab this turn opened'),
    });
    expect(g.decide(t('find'), { tabId: 4242, query: 'x' }).allow).toBe(false);
    expect(g.decide(t('tabs_close_mcp'), { tabId: 4242 }).allow).toBe(false);
    expect(g.decide(t('tabs_close_mcp'), { tabId: 1121530135 }).allow).toBe(
      true,
    );
  });

  it('navigate: http(s), bare hosts, back and forward only — on an owned tab', () => {
    const g = createBrowserGuard();
    g.observe(t('tabs_create_mcp'), CREATED);
    const tabId = 1121530135;
    expect(
      g.decide(t('navigate'), {
        tabId,
        url: 'https://jira.example.com/browse/ENG-4',
      }),
    ).toEqual({ allow: true });
    expect(g.decide(t('navigate'), { tabId, url: 'example.com' })).toEqual({
      allow: true,
    });
    expect(g.decide(t('navigate'), { tabId, url: 'back' })).toEqual({
      allow: true,
    });
    for (const url of [
      'chrome://settings',
      'file:///etc/passwd',
      ['java', 'script:alert(1)'].join(''), // spelled apart: the linter's no-script-url
      'chrome-extension://abc/x.html',
      '/local',
    ]) {
      expect(g.decide(t('navigate'), { tabId, url })).toMatchObject({
        allow: false,
        reason: expect.stringContaining('http(s)'),
      });
    }
    // The right URL on a tab that is not this turn's is still refused.
    expect(
      g.decide(t('navigate'), { tabId: 1, url: 'https://example.com' }).allow,
    ).toBe(false);
  });

  it('browser_batch is judged action by action; the first refused action names why', () => {
    const g = createBrowserGuard();
    g.observe(t('tabs_create_mcp'), CREATED);
    const tabId = 1121530135;
    expect(
      g.decide(t('browser_batch'), {
        actions: [
          { name: 'navigate', input: { tabId, url: 'https://example.com' } },
          { name: 'computer', input: { tabId, action: 'screenshot' } },
        ],
      }),
    ).toEqual({ allow: true });
    expect(
      g.decide(t('browser_batch'), {
        actions: [
          { name: 'navigate', input: { tabId, url: 'https://example.com' } },
          { name: t('computer'), input: { action: 'screenshot' } },
        ],
      }),
    ).toMatchObject({
      allow: false,
      reason: expect.stringContaining('computer may only act'),
    });
    expect(
      g.decide(t('browser_batch'), {
        actions: [{ name: 'javascript_tool', input: { tabId } }],
      }).allow,
    ).toBe(false);
    expect(g.decide(t('browser_batch'), {}).allow).toBe(false);
  });

  it('leaves tools that are not the browser alone', () => {
    const g = createBrowserGuard();
    expect(g.decide('mcp__waypoint__propose_comment', {})).toEqual({
      allow: true,
    });
    expect(g.decide('Read', { file_path: '/x' })).toEqual({ allow: true });
  });
});

describe('browserGuardHooks', () => {
  it('matches only the browser tools, denies through PreToolUse with a GUARD reason, and observes through PostToolUse', async () => {
    const g = createBrowserGuard();
    const hooks = browserGuardHooks(g);
    expect(hooks.PreToolUse?.[0].matcher).toBe('mcp__claude-in-chrome__.*');
    expect(hooks.PostToolUse?.[0].matcher).toBe('mcp__claude-in-chrome__.*');
    const pre = hooks.PreToolUse![0].hooks[0];
    const post = hooks.PostToolUse![0].hooks[0];
    const opts = { signal: new AbortController().signal };

    const denied = await pre(
      {
        hook_event_name: 'PreToolUse',
        tool_name: t('computer'),
        tool_input: { action: 'screenshot' },
      } as never,
      'tu-1',
      opts,
    );
    expect(denied).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: expect.stringMatching(/^GUARD: /),
      },
    });

    await post(
      {
        hook_event_name: 'PostToolUse',
        tool_name: t('tabs_create_mcp'),
        tool_input: {},
        tool_response: CREATED,
      } as never,
      'tu-2',
      opts,
    );
    const allowed = await pre(
      {
        hook_event_name: 'PreToolUse',
        tool_name: t('computer'),
        tool_input: { action: 'screenshot', tabId: 1121530135 },
      } as never,
      'tu-3',
      opts,
    );
    expect(allowed).toEqual({});
  });
});
