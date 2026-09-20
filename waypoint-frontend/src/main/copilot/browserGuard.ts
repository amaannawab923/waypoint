import type { Options } from './claudeSdkClient';

/**
 * Tool-level guardrails for Copilot's "use my Chrome" (found in review,
 * PR #83: the never-do list lived only in the system prompt, and a model
 * that ignored it was not stopped by anything). The browser is signed in
 * as the person, so the rules are enforced where a prompt cannot be
 * ignored — a PreToolUse hook on the SDK, which runs before permission
 * rules and so blocks a tool even though the wildcard in allowedTools
 * would have let it through without a prompt (verified live: the model
 * receives `<error>GUARD: …</error>` and changes course). `canUseTool`
 * stays unset for Copilot, as claudeSession.ts requires for zero-friction
 * propose_* execution.
 *
 * The rules, in order:
 *  1. A few tools are never allowed: files from disk into a page, other
 *     browsers, canned shortcuts, and arbitrary JavaScript on a page the
 *     person is logged into (read_page / get_page_text / find are enough).
 *  2. Listing and creating tabs is always allowed — that is how the turn
 *     gets its own tabs.
 *  3. Everything else must name a tab THIS turn opened (or the tab group
 *     the extension created for it): the `tabId` in the input must be one
 *     seen in a tabs_create_mcp / tabs_context_mcp response. No tabId —
 *     "act on the fronted tab" — is refused, since the fronted tab may be
 *     anything the person has open.
 *  4. navigate only goes to http(s) (or back/forward): no chrome://,
 *     file://, javascript: in a signed-in browser.
 *  5. browser_batch is checked action by action under the same rules.
 *
 * Per turn: the runner creates one guard per `copilot:run`, so a tab from
 * an earlier turn is not "this turn's". Pure decisions; the hooks are a
 * thin adapter. Table-tested in browserGuard.test.ts.
 */
export const BROWSER_TOOL_PREFIX = 'mcp__claude-in-chrome__';

const NEVER: ReadonlyMap<string, string> = new Map([
  [
    'file_upload',
    'Copilot does not upload files from this computer into a page.',
  ],
  [
    'upload_image',
    'Copilot does not upload files from this computer into a page.',
  ],
  ['switch_browser', 'Copilot only uses the Chrome the person enabled.'],
  ['select_browser', 'Copilot only uses the Chrome the person enabled.'],
  ['shortcuts_execute', 'Copilot does not run browser shortcuts.'],
  [
    'javascript_tool',
    'Copilot does not run JavaScript in a browser signed in as the person; use read_page, get_page_text or find.',
  ],
]);

const ALWAYS: ReadonlySet<string> = new Set([
  'tabs_context_mcp',
  'tabs_create_mcp',
  'list_connected_browsers',
  'shortcuts_list',
]);

const TAB_RULE =
  "pass the tabId of a tab this turn opened (tabs_create_mcp, or the tab group tabs_context_mcp created with createIfEmpty) — never a tab that was already open, and never 'the fronted tab'.";

export type GuardDecision = { allow: true } | { allow: false; reason: string };

export interface BrowserGuard {
  /** The rule for one tool call; browser_batch is judged action by action. */
  decide(toolName: string, input: unknown): GuardDecision;
  /** Learns this turn's tab ids from a tool's response. */
  observe(toolName: string, response: unknown): void;
  /** The tabs this turn may act on. */
  readonly tabs: ReadonlySet<number>;
}

function shortName(toolName: string): string | null {
  return toolName.startsWith(BROWSER_TOOL_PREFIX)
    ? toolName.slice(BROWSER_TOOL_PREFIX.length)
    : null;
}

function tabIdOf(input: unknown): number | null {
  if (!input || typeof input !== 'object') return null;
  const raw = (input as { tabId?: unknown }).tabId;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && /^\d+$/.test(raw)) return Number(raw);
  return null;
}

function urlAllowed(url: unknown): boolean {
  if (typeof url !== 'string') return false;
  if (url === 'back' || url === 'forward') return true;
  const trimmed = url.trim();
  // A bare host ("example.com") is http(s) by the tool's own convention;
  // anything with an explicit scheme must be http or https.
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed);
  return scheme ? /^https?$/i.test(scheme[1]) : !trimmed.startsWith('/');
}

/** Every "tabId 123" / "Tab ID: 123" in a response's text blocks. */
function tabIdsIn(response: unknown): number[] {
  const texts: string[] = [];
  const collect = (value: unknown): void => {
    if (typeof value === 'string') texts.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') {
      const raw = value as { text?: unknown; content?: unknown };
      if (typeof raw.text === 'string') texts.push(raw.text);
      if (raw.content !== undefined) collect(raw.content);
    }
  };
  collect(response);
  const ids: number[] = [];
  texts.forEach((text) => {
    Array.from(text.matchAll(/tab\s*id[":\s]*(\d+)/gi)).forEach((m) =>
      ids.push(Number(m[1])),
    );
  });
  return ids;
}

export function createBrowserGuard(): BrowserGuard {
  const tabs = new Set<number>();

  const decide = (toolName: string, input: unknown): GuardDecision => {
    const short = shortName(toolName);
    if (short === null) return { allow: true };
    const never = NEVER.get(short);
    if (never) return { allow: false, reason: never };
    if (ALWAYS.has(short)) return { allow: true };

    if (short === 'browser_batch') {
      const actions =
        input && typeof input === 'object'
          ? (input as { actions?: unknown }).actions
          : undefined;
      if (!Array.isArray(actions))
        return { allow: false, reason: 'browser_batch needs an actions list.' };
      const denied = actions
        .map((action) => {
          const a = action as { name?: unknown; input?: unknown };
          const name = typeof a.name === 'string' ? a.name : '';
          return decide(
            name.startsWith(BROWSER_TOOL_PREFIX)
              ? name
              : `${BROWSER_TOOL_PREFIX}${name}`,
            a.input,
          );
        })
        .find((d): d is { allow: false; reason: string } => !d.allow);
      return denied ?? { allow: true };
    }

    if (short === 'navigate') {
      const url =
        input && typeof input === 'object'
          ? (input as { url?: unknown }).url
          : undefined;
      if (!urlAllowed(url)) {
        return {
          allow: false,
          reason:
            'Copilot only navigates to http(s) pages in the person’s browser.',
        };
      }
    }

    const tabId = tabIdOf(input);
    if (tabId === null || !tabs.has(tabId)) {
      return {
        allow: false,
        reason: `${short} may only act on a tab this turn opened: ${TAB_RULE}`,
      };
    }
    return { allow: true };
  };

  const observe = (toolName: string, response: unknown): void => {
    const short = shortName(toolName);
    if (short !== 'tabs_context_mcp' && short !== 'tabs_create_mcp') return;
    tabIdsIn(response).forEach((id) => tabs.add(id));
  };

  return { decide, observe, tabs };
}

/** The guard as SDK hooks: a PreToolUse deny and a PostToolUse observer, browser tools only. */
export function browserGuardHooks(
  guard: BrowserGuard,
): NonNullable<Options['hooks']> {
  const matcher = `${BROWSER_TOOL_PREFIX}.*`;
  return {
    PreToolUse: [
      {
        matcher,
        hooks: [
          async (input) => {
            if (input.hook_event_name !== 'PreToolUse') return {};
            const decision = guard.decide(input.tool_name, input.tool_input);
            if (decision.allow) return {};
            return {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'deny',
                permissionDecisionReason: `GUARD: ${decision.reason}`,
              },
            };
          },
        ],
      },
    ],
    PostToolUse: [
      {
        matcher,
        hooks: [
          async (input) => {
            if (input.hook_event_name === 'PostToolUse')
              guard.observe(input.tool_name, input.tool_response);
            return {};
          },
        ],
      },
    ],
  };
}
