import { readStoredJiraCredential, type JiraCredential } from './jiraAuth';
import {
  buildTransitionFieldsPayload,
  mapComment,
  mapIssue,
  mapTransitions,
} from './jiraMap';
import type {
  JiraFailure,
  JiraIdentity,
  JiraResult,
  JiraWireComment,
  JiraWireTicket,
  JiraWireTransition,
} from './jiraTypes';

// The Jira Cloud REST client. Runs only in the main process, holds the API
// token only for the duration of a request, and never hands it to anything
// but the one site hostname stored with it.
//
// Auth is HTTP Basic with `email:apiToken` — Atlassian's own documented
// mechanism for a personal API token (the kind a user generates for
// themselves at id.atlassian.com/manage-profile/security/api-tokens). That
// deliberately means NO OAuth app registration, no admin consent, no
// redirect URI: a developer can connect their own Jira on their own machine
// with nothing but a token they made in thirty seconds. OAuth exists and is
// the right answer for a distributed/organizational install, but it is a
// separate, later mechanism, not a prerequisite for this one.

const REQUEST_TIMEOUT_MS = 20_000;

// One personal queue is 10-40 issues. 100 per page with a hard cap of 5 pages
// means the normal case is a single request and a pathological account still
// can't turn "load my work" into an unbounded crawl of someone's Jira.
const PAGE_SIZE = 100;
const MAX_PAGES = 5;

/**
 * The one query this whole feature is built around: everything the signed-in
 * person is on the hook for, across every project they can see, unresolved.
 *
 * The parentheses are load-bearing and are a deliberate deviation from the
 * unparenthesized form this was specified with. JQL binds AND tighter than
 * OR, so `a OR b OR c AND resolution = Unresolved` means
 * `a OR b OR (c AND unresolved)` — which quietly returns every issue ever
 * assigned to the user including long-closed ones, while only filtering the
 * watcher arm. Grouping the three role clauses is what makes the query mean
 * what both its own description and the My Jira page's on-screen copy say it
 * means.
 */
const MY_WORK_JQL =
  '(assignee = currentUser() OR reporter = currentUser() OR watcher = currentUser())' +
  ' AND resolution = Unresolved ORDER BY updated DESC';

// `*all` because the fields worth showing (story points, sprint) live in
// per-site custom fields there's no portable id for; `names` is what lets
// jiraMap.ts find them by their displayed label instead of guessing an id.
// `transitions` is requested here as an optimization only — see listMyTickets.
const SEARCH_EXPAND = 'renderedFields,transitions,transitions.fields,names';

type Credentialish = Pick<JiraCredential, 'site' | 'email' | 'apiToken'>;

/**
 * The Basic-auth header. Isolated in its own one-line function so there is
 * exactly one place in the codebase where the token is turned into something
 * transmittable — and so it is obvious at a glance that nothing ever puts it
 * in a URL, a query string, or a log line.
 */
function authorizationHeader(credential: Credentialish): string {
  return `Basic ${Buffer.from(
    `${credential.email}:${credential.apiToken}`,
  ).toString('base64')}`;
}

function failure(reason: JiraFailure['reason'], message: string): JiraFailure {
  return { ok: false, reason, message };
}

/** Jira reports problems as `{ errorMessages: [...], errors: { field: ... } }`
 * — surfacing its actual words is the difference between "Jira rejected the
 * move" and "Resolution is required", which is the whole point of asking. */
function messageFromErrorBody(body: unknown, fallback: string): string {
  if (!body || typeof body !== 'object') return fallback;
  const record = body as Record<string, unknown>;
  if (Array.isArray(record.errorMessages) && record.errorMessages.length > 0) {
    const first = record.errorMessages[0];
    if (typeof first === 'string' && first) return first;
  }
  if (record.errors && typeof record.errors === 'object') {
    const values = Object.values(record.errors as Record<string, unknown>);
    const first = values.find((v) => typeof v === 'string' && v);
    if (typeof first === 'string') return first;
  }
  return fallback;
}

function classifyNetworkError(err: unknown): JiraFailure {
  if (err instanceof Error && err.name === 'AbortError') {
    return failure('network', 'Jira took too long to respond — try again.');
  }
  const cause = (err as { cause?: { code?: string } } | undefined)?.cause;
  const code = typeof cause?.code === 'string' ? cause.code : '';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return failure(
      'site_not_found',
      "That site doesn't exist — check the address (e.g. yourteam.atlassian.net).",
    );
  }
  return failure(
    'network',
    "Couldn't reach Jira. Check your connection and try again.",
  );
}

interface JiraRequest {
  method: 'GET' | 'POST';
  /** Absolute REST path, e.g. "/rest/api/3/myself". */
  path: string;
  query?: Record<string, string>;
  body?: unknown;
}

async function jiraFetch<T>(
  credential: Credentialish,
  request: JiraRequest,
): Promise<JiraResult<T>> {
  const url = new URL(`https://${credential.site}${request.path}`);
  for (const [key, value] of Object.entries(request.query ?? {})) {
    url.searchParams.set(key, value);
  }

  // A hand-rolled controller rather than AbortSignal.timeout(): the latter is
  // a recent addition and is not guaranteed present in every environment this
  // module is loaded in (the test environment included), and a timeout is not
  // something worth making conditional.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: request.method,
      headers: {
        Authorization: authorizationHeader(credential),
        Accept: 'application/json',
        ...(request.body !== undefined
          ? { 'Content-Type': 'application/json' }
          : {}),
      },
      body:
        request.body !== undefined ? JSON.stringify(request.body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    return classifyNetworkError(err);
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401) {
    return failure(
      'invalid_credentials',
      'Jira rejected that email and API token. Check both, and that the token was generated for this Atlassian account.',
    );
  }
  if (response.status === 403) {
    return failure('forbidden', "Your Jira account isn't allowed to do that.");
  }
  if (response.status === 204) return { ok: true, value: undefined as T };

  let parsed: unknown;
  let parseFailed = false;
  try {
    const text = await response.text();
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parseFailed = true;
  }

  if (!response.ok) {
    if (response.status === 429) {
      return failure(
        'jira_error',
        'Jira is rate-limiting this account right now — wait a moment and try again.',
      );
    }
    return failure(
      'jira_error',
      messageFromErrorBody(parsed, `Jira returned ${response.status}.`),
    );
  }

  // A 200 that isn't JSON is not a Jira API response at all — it's almost
  // always a login page or a parked-domain page from a hostname that happens
  // to answer on https. Saying so beats a downstream "cannot read property
  // of undefined".
  if (parseFailed) {
    return failure(
      'site_not_found',
      'That address answered, but not like a Jira Cloud site — check the site address.',
    );
  }

  return { ok: true, value: parsed as T };
}

function requireCredential(): JiraResult<JiraCredential> {
  const credential = readStoredJiraCredential();
  if (!credential) {
    return failure('not_connected', 'No Jira account is connected.');
  }
  return { ok: true, value: credential };
}

// -----------------------------------------------------------------------
// 1. Validate + connect
// -----------------------------------------------------------------------

/**
 * Proves a candidate email/token pair actually works, before anything is
 * saved — the same posture copilotAuth.ts's probe takes, for the same reason:
 * a credential that has never been exercised is not a connection, and
 * discovering it was wrong on the user's first real action is a far worse
 * experience than discovering it on the button that says "Connect".
 *
 * `/myself` is the right probe because it needs no permissions beyond being
 * a valid session, and its answer is exactly the identity the UI then shows.
 */
export async function validateCredential(
  candidate: Credentialish,
): Promise<JiraResult<JiraIdentity>> {
  const result = await jiraFetch<Record<string, unknown>>(candidate, {
    method: 'GET',
    path: '/rest/api/3/myself',
  });
  if (!result.ok) return result;

  const me = result.value ?? {};
  const accountId = typeof me.accountId === 'string' ? me.accountId : '';
  if (!accountId) {
    return failure(
      'site_not_found',
      'That address answered, but not like a Jira Cloud site — check the site address.',
    );
  }
  const avatars = (me.avatarUrls ?? {}) as Record<string, unknown>;
  const avatar = avatars['48x48'] ?? avatars['32x32'];

  return {
    ok: true,
    value: {
      site: candidate.site,
      accountId,
      // Atlassian hides emailAddress unless the account's profile visibility
      // allows it, so the address the user typed is the reliable one to show
      // back to them.
      email:
        typeof me.emailAddress === 'string' && me.emailAddress
          ? me.emailAddress
          : candidate.email,
      displayName:
        typeof me.displayName === 'string' && me.displayName
          ? me.displayName
          : candidate.email,
      avatarUrl: typeof avatar === 'string' ? avatar : null,
    },
  };
}

// -----------------------------------------------------------------------
// 2. List "my" tickets
// -----------------------------------------------------------------------

interface SearchResponse {
  issues?: unknown[];
  names?: Record<string, string>;
  nextPageToken?: string;
  isLast?: boolean;
}

export async function listMyTickets(): Promise<JiraResult<JiraWireTicket[]>> {
  const credentialResult = requireCredential();
  if (!credentialResult.ok) return credentialResult;
  const credential = credentialResult.value;

  const tickets: JiraWireTicket[] = [];
  let nextPageToken: string | undefined;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const query: Record<string, string> = {
      jql: MY_WORK_JQL,
      fields: '*all',
      expand: SEARCH_EXPAND,
      maxResults: String(PAGE_SIZE),
    };
    if (nextPageToken) query.nextPageToken = nextPageToken;

    // eslint-disable-next-line no-await-in-loop
    const result = await jiraFetch<SearchResponse>(credential, {
      method: 'GET',
      path: '/rest/api/3/search/jql',
      query,
    });
    if (!result.ok) return result;

    const body = result.value ?? {};
    const names = body.names ?? {};
    tickets.push(
      ...(body.issues ?? [])
        .map((issue) => mapIssue(issue, credential.accountId, names))
        // One unusual issue must not take the whole list down with it, so
        // anything that couldn't be mapped is skipped rather than thrown on.
        .filter((t): t is JiraWireTicket => t !== null),
    );

    nextPageToken = body.nextPageToken;
    if (!nextPageToken || body.isLast === true) break;
  }

  return { ok: true, value: tickets };
}

// -----------------------------------------------------------------------
// 3. Transitions
// -----------------------------------------------------------------------

/**
 * The per-issue transitions endpoint, used both as the lazy fallback when a
 * bulk search didn't populate an issue's transitions and as the pre-flight
 * read before every actual move.
 *
 * Whether `expand=transitions` on the bulk search reliably returns a
 * *populated* array for an authenticated user is not something this
 * integration takes on faith — an empty array there is indistinguishable from
 * "this issue genuinely has no legal moves", and quietly showing a user an
 * empty transition menu on a ticket they can obviously move is worse than one
 * extra request. So the bulk result is treated as an optimization and this is
 * treated as the answer of record.
 */
export async function listTransitions(
  ticketId: string,
): Promise<JiraResult<JiraWireTransition[]>> {
  const raw = await fetchRawTransitions(ticketId);
  if (!raw.ok) return raw;
  return { ok: true, value: mapTransitions(raw.value) };
}

async function fetchRawTransitions(
  ticketId: string,
): Promise<JiraResult<unknown[]>> {
  const credentialResult = requireCredential();
  if (!credentialResult.ok) return credentialResult;

  const result = await jiraFetch<{ transitions?: unknown[] }>(
    credentialResult.value,
    {
      method: 'GET',
      path: `/rest/api/3/issue/${encodeURIComponent(ticketId)}/transitions`,
      query: { expand: 'transitions.fields' },
    },
  );
  if (!result.ok) return result;
  return { ok: true, value: result.value?.transitions ?? [] };
}

/**
 * Moves an issue, then re-reads it so the caller gets the state Jira actually
 * landed on rather than the state the UI assumed it would.
 *
 * The transition list is re-read first, immediately before the write. That is
 * not redundancy: the field values arriving from the popover are human-
 * readable labels, and only that transition's live `allowedValues` can turn
 * "Won't Do" into the id this site uses for it (see
 * buildTransitionFieldsPayload). It also means a transition that stopped
 * being legal while the popover was open fails with a clear message instead
 * of a bare 400.
 */
export async function transitionTicket(
  ticketId: string,
  transitionId: string,
  fieldValues: Record<string, string>,
): Promise<JiraResult<JiraWireTicket>> {
  const credentialResult = requireCredential();
  if (!credentialResult.ok) return credentialResult;
  const credential = credentialResult.value;

  const rawTransitions = await fetchRawTransitions(ticketId);
  if (!rawTransitions.ok) return rawTransitions;

  const target = rawTransitions.value.find(
    (t) => String((t as { id?: unknown }).id) === transitionId,
  );
  if (!target) {
    return failure(
      'jira_error',
      "That move isn't available on this issue any more — reopen the menu to see the current options.",
    );
  }

  const fields = buildTransitionFieldsPayload(target, fieldValues);
  const posted = await jiraFetch<void>(credential, {
    method: 'POST',
    path: `/rest/api/3/issue/${encodeURIComponent(ticketId)}/transitions`,
    body: {
      transition: { id: transitionId },
      ...(Object.keys(fields).length > 0 ? { fields } : {}),
    },
  });
  if (!posted.ok) return posted;

  return getTicket(ticketId);
}

export async function getTicket(
  ticketId: string,
): Promise<JiraResult<JiraWireTicket>> {
  const credentialResult = requireCredential();
  if (!credentialResult.ok) return credentialResult;
  const credential = credentialResult.value;

  const result = await jiraFetch<Record<string, unknown>>(credential, {
    method: 'GET',
    path: `/rest/api/3/issue/${encodeURIComponent(ticketId)}`,
    query: { fields: '*all', expand: SEARCH_EXPAND },
  });
  if (!result.ok) return result;

  const names = (result.value?.names ?? {}) as Record<string, string>;
  const mapped = mapIssue(result.value, credential.accountId, names);
  if (!mapped) {
    return failure('jira_error', "Jira didn't return that issue.");
  }
  return { ok: true, value: mapped };
}

// -----------------------------------------------------------------------
// 4. Comments
// -----------------------------------------------------------------------

// v2, not v3, for both reading and writing comments — a considered choice,
// not an oversight. v2 takes and returns a plain string body, which is
// exactly what this app's composer produces and what its comment list
// renders. v3 requires the body to be an Atlassian Document Format tree, and
// has a live-confirmed defect rendering posted bodies back. Comments here are
// plain text; the simpler API is also the correct one.
const COMMENT_PATH = (ticketId: string) =>
  `/rest/api/2/issue/${encodeURIComponent(ticketId)}/comment`;

export async function listComments(
  ticketId: string,
): Promise<JiraResult<JiraWireComment[]>> {
  const credentialResult = requireCredential();
  if (!credentialResult.ok) return credentialResult;

  const result = await jiraFetch<{ comments?: unknown[] }>(
    credentialResult.value,
    {
      method: 'GET',
      path: COMMENT_PATH(ticketId),
      query: { orderBy: 'created', maxResults: '100' },
    },
  );
  if (!result.ok) return result;

  const comments = (result.value?.comments ?? [])
    .map((raw) => mapComment(raw, ticketId))
    .filter((c): c is JiraWireComment => c !== null);
  return { ok: true, value: comments };
}

export async function postComment(
  ticketId: string,
  body: string,
): Promise<JiraResult<JiraWireComment>> {
  const credentialResult = requireCredential();
  if (!credentialResult.ok) return credentialResult;

  const result = await jiraFetch<Record<string, unknown>>(
    credentialResult.value,
    {
      method: 'POST',
      path: COMMENT_PATH(ticketId),
      body: { body },
    },
  );
  if (!result.ok) return result;

  const mapped = mapComment(result.value, ticketId);
  if (!mapped) {
    return failure(
      'jira_error',
      "The comment posted, but Jira didn't return it — reopen the ticket to see it.",
    );
  }
  return { ok: true, value: mapped };
}
