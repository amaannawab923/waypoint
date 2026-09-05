import { readStoredJiraCredential, type JiraCredential } from './jiraAuth';
import {
  buildTransitionFieldsPayload,
  mapComment,
  mapIssue,
  mapPriorityOptions,
  mapTransitions,
  mapUserOptions,
} from './jiraMap';
import type {
  JiraFailure,
  JiraIdentity,
  JiraPriorityOption,
  JiraResult,
  JiraWireComment,
  JiraWireTicket,
  JiraWireTransition,
  JiraWireUser,
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

// A file transfer is not a JSON call and must not be timed like one. Twenty
// seconds is generous for "tell me about this issue" and plainly wrong for
// "send me a 40MB screen recording over hotel wifi" — a cap that aborts a
// transfer that was going fine is indistinguishable, from the user's side,
// from Jira being broken.
const TRANSFER_TIMEOUT_MS = 120_000;

/**
 * The largest attachment this app will move in either direction.
 *
 * 100MB, which is Atlassian's own maximum configurable attachment size on
 * Jira Cloud — so it is a ceiling no site can legitimately exceed, rather
 * than a number picked here. It is deliberately not a guess at any particular
 * site's limit: most sites run well below this (Cloud's default is 10MB), and
 * a *site's* real cap is Jira's to enforce and to explain, in its own words,
 * far better than a guessed local number could.
 *
 * What this guard is actually for is the main process's heap. A download is
 * buffered whole before it is written, and an upload is read whole before it
 * is sent; without a ceiling, either is an unbounded allocation driven by a
 * file this app did not choose.
 */
export const MAX_TRANSFER_BYTES = 100 * 1024 * 1024;

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
  // PUT is Jira's verb for editing an issue's own fields — the transition
  // endpoint is a POST because a move is an action, but changing a priority
  // is an edit of the issue itself.
  method: 'GET' | 'POST' | 'PUT';
  /** Absolute REST path, e.g. "/rest/api/3/myself". */
  path: string;
  query?: Record<string, string>;
  body?: unknown;
}

/** What `performRequest` needs, once a caller has decided how the body is
 * encoded and how long the call is allowed to take. Deliberately lower-level
 * than `JiraRequest`: `body` here is already a `BodyInit`, and `headers` is
 * whatever this particular flavour of request adds on top of the two every
 * Jira call carries. */
interface RawJiraRequest {
  method: 'GET' | 'POST' | 'PUT';
  path: string;
  query?: Record<string, string>;
  /** Merged over `Authorization` and `Accept`. Deliberately optional and
   * deliberately never defaulted to a `Content-Type`: `fetch` derives the
   * right one (with the boundary) from a `FormData` body, and setting it by
   * hand there produces a request Jira rejects. */
  headers?: Record<string, string>;
  /** The two encodings this client actually sends: a JSON string, or a
   * `FormData` for the attachment upload. Deliberately narrower than fetch's
   * own `BodyInit` — nothing here streams, and a union of exactly what is
   * sent is a union a reader can check against the call sites. */
  body?: string | FormData;
  timeoutMs: number;
}

/**
 * Every Jira request in this app goes through here, and this is the only place
 * that decides what a failure means.
 *
 * That single-place-ness is the entire reason it exists as its own function.
 * There are three body shapes to send (JSON, nothing, multipart) and two to
 * read back (JSON, raw bytes), and the combinations do not share a return
 * type — but they share every question worth getting right: which host the
 * request is pinned to, that the credential rides in a header and never a
 * URL, when to give up, and what a 401 versus a 403 versus a 429 versus an
 * ENOTFOUND actually means to a user. Copying that ladder per body shape
 * would leave three functions free to hold three different opinions about
 * what rate-limiting is, and they would drift, because nothing would notice.
 *
 * Returns the raw `Response` and reads no body on success — how the body is
 * read is precisely the part that differs. Every non-2xx status is fully
 * handled here, including reading and parsing Jira's own error body, because
 * an error body is JSON no matter what the caller asked for.
 */
async function performRequest(
  credential: Credentialish,
  request: RawJiraRequest,
): Promise<JiraResult<Response>> {
  const url = new URL(`https://${credential.site}${request.path}`);
  for (const [key, value] of Object.entries(request.query ?? {})) {
    url.searchParams.set(key, value);
  }

  // A hand-rolled controller rather than AbortSignal.timeout(): the latter is
  // a recent addition and is not guaranteed present in every environment this
  // module is loaded in (the test environment included), and a timeout is not
  // something worth making conditional.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs);

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: request.method,
      headers: {
        Authorization: authorizationHeader(credential),
        Accept: 'application/json',
        ...(request.headers ?? {}),
      },
      body: request.body,
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

  if (!response.ok) {
    if (response.status === 429) {
      return failure(
        'jira_error',
        'Jira is rate-limiting this account right now — wait a moment and try again.',
      );
    }
    // Jira reports problems as JSON whatever the request asked to receive, so
    // reading the error body here rather than per-caller is what lets a failed
    // binary download still say "Resolution is required"-grade things.
    let parsed: unknown;
    try {
      const text = await response.text();
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    return failure(
      'jira_error',
      messageFromErrorBody(parsed, `Jira returned ${response.status}.`),
    );
  }

  return { ok: true, value: response };
}

/** Reads a successful response as JSON. The tail shared by `jiraFetch` and
 * `jiraFetchMultipart` — both send different bodies and both get JSON back. */
async function readJsonBody<T>(response: Response): Promise<JiraResult<T>> {
  if (response.status === 204) return { ok: true, value: undefined as T };

  let parsed: unknown;
  try {
    const text = await response.text();
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    // A 200 that isn't JSON is not a Jira API response at all — it's almost
    // always a login page or a parked-domain page from a hostname that happens
    // to answer on https. Saying so beats a downstream "cannot read property
    // of undefined".
    return failure(
      'site_not_found',
      'That address answered, but not like a Jira Cloud site — check the site address.',
    );
  }

  return { ok: true, value: parsed as T };
}

async function jiraFetch<T>(
  credential: Credentialish,
  request: JiraRequest,
): Promise<JiraResult<T>> {
  const sent = await performRequest(credential, {
    method: request.method,
    path: request.path,
    query: request.query,
    headers:
      request.body !== undefined
        ? { 'Content-Type': 'application/json' }
        : undefined,
    body: request.body !== undefined ? JSON.stringify(request.body) : undefined,
    timeoutMs: REQUEST_TIMEOUT_MS,
  });
  if (!sent.ok) return sent;
  return readJsonBody<T>(sent.value);
}

/**
 * The same request machinery again, sending `multipart/form-data`.
 *
 * Two things here are Jira's contract rather than this app's preference, and
 * both are easy to get wrong in a way that produces an unhelpful 4xx or 5xx
 * with nothing legible in it:
 *
 *  - `X-Atlassian-Token: no-check` is required on the attachment endpoint. It
 *    is Atlassian's XSRF guard, and Jira's own documentation is blunt about
 *    the consequence of omitting it: the request is blocked.
 *  - No `Content-Type` is set, and that omission is deliberate. `fetch`
 *    derives the header from the `FormData` instance *including the boundary
 *    parameter* that tells the far side where each part begins. Writing
 *    `Content-Type: multipart/form-data` by hand drops that boundary and
 *    produces a body Jira cannot parse — which is why the header map below
 *    has exactly one entry, and why jiraClient.test.ts asserts that no
 *    Content-Type was set on this path rather than trusting a comment.
 */
async function jiraFetchMultipart<T>(
  credential: Credentialish,
  request: { path: string; form: FormData },
): Promise<JiraResult<T>> {
  const sent = await performRequest(credential, {
    method: 'POST',
    path: request.path,
    headers: { 'X-Atlassian-Token': 'no-check' },
    body: request.form,
    timeoutMs: TRANSFER_TIMEOUT_MS,
  });
  if (!sent.ok) return sent;
  return readJsonBody<T>(sent.value);
}

function tooLargeMessage(bytes: number): string {
  return `That attachment is ${Math.round(bytes / (1024 * 1024))}MB, past the ${Math.round(
    MAX_TRANSFER_BYTES / (1024 * 1024),
  )}MB this app will transfer — download it in Jira instead.`;
}

/**
 * The same request machinery, reading raw bytes instead of JSON.
 *
 * The size guard sits here rather than in the caller because it needs the
 * response, and it has to run *before* `.arrayBuffer()` — the whole point is
 * not to allocate the thing. `content-length` is what Jira sends for an
 * attachment, so the declared-length check is the one that actually protects
 * the heap; the check after the read is a cheap backstop for a chunked
 * response that declared nothing, and is honest about only being able to
 * refuse the file after it has already arrived.
 */
async function jiraFetchBinary(
  credential: Credentialish,
  request: Omit<JiraRequest, 'body'>,
): Promise<JiraResult<Buffer>> {
  const sent = await performRequest(credential, {
    method: request.method,
    path: request.path,
    query: request.query,
    timeoutMs: TRANSFER_TIMEOUT_MS,
  });
  if (!sent.ok) return sent;

  const declared = Number(sent.value.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_TRANSFER_BYTES) {
    return failure('jira_error', tooLargeMessage(declared));
  }

  const bytes = Buffer.from(await sent.value.arrayBuffer());
  if (bytes.byteLength > MAX_TRANSFER_BYTES) {
    return failure('jira_error', tooLargeMessage(bytes.byteLength));
  }
  return { ok: true, value: bytes };
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
// 4. Priority
// -----------------------------------------------------------------------

/**
 * The issue's live edit metadata — what this user may change on this issue,
 * right now, on this site.
 *
 * Deliberately per-issue. A site can attach a different priority scheme to
 * each project, so the global `/rest/api/3/priority` list is a superset that
 * can contain values this particular issue would reject; and whether priority
 * is editable at all depends on the issue's own edit screen and this user's
 * permissions. Asking the issue is the only answer that is true for the issue.
 */
async function fetchEditmeta(
  ticketId: string,
): Promise<JiraResult<Record<string, unknown> | undefined>> {
  const credentialResult = requireCredential();
  if (!credentialResult.ok) return credentialResult;

  return jiraFetch<Record<string, unknown>>(credentialResult.value, {
    method: 'GET',
    path: `/rest/api/3/issue/${encodeURIComponent(ticketId)}/editmeta`,
  });
}

/**
 * The priorities this issue will actually accept.
 *
 * An empty array is a success, not a failure. `fields.priority` missing from
 * editmeta means priority isn't editable on this issue type — a real and
 * ordinary answer, the exact analogue of a workflow that offers no moves —
 * and reporting it as an error would put a red failure message in front of a
 * user whose Jira is behaving normally.
 */
export async function listPriorityOptions(
  ticketId: string,
): Promise<JiraResult<JiraPriorityOption[]>> {
  const meta = await fetchEditmeta(ticketId);
  if (!meta.ok) return meta;
  return { ok: true, value: mapPriorityOptions(meta.value) };
}

/**
 * Sets an issue's priority, then re-reads the issue so the caller gets the
 * state Jira actually landed on rather than the one the UI assumed.
 *
 * The editmeta re-read immediately before the write mirrors
 * `transitionTicket`'s own defense, for the same reason: the id in hand came
 * from a menu that may have been open for a while, and an admin changing the
 * project's priority scheme in that window would otherwise produce a bare 400
 * with nothing useful in it. Checking first means that case says what actually
 * happened — and, just as importantly, means the PUT is never attempted with a
 * value this issue has already stopped accepting.
 */
export async function setTicketPriority(
  ticketId: string,
  priorityId: string,
): Promise<JiraResult<JiraWireTicket>> {
  const credentialResult = requireCredential();
  if (!credentialResult.ok) return credentialResult;
  const credential = credentialResult.value;

  const meta = await fetchEditmeta(ticketId);
  if (!meta.ok) return meta;

  const options = mapPriorityOptions(meta.value);
  if (!options.some((option) => option.id === priorityId)) {
    return failure(
      'jira_error',
      "That priority isn't available on this issue any more — reopen the menu to see the current options.",
    );
  }

  // The generic issue-edit endpoint, which is what a priority change is. It
  // answers 204 with no body on success, so there is nothing here to map —
  // the re-read below is what produces the ticket the caller gets.
  const written = await jiraFetch<void>(credential, {
    method: 'PUT',
    path: `/rest/api/3/issue/${encodeURIComponent(ticketId)}`,
    body: { fields: { priority: { id: priorityId } } },
  });
  if (!written.ok) return written;

  return getTicket(ticketId);
}

// -----------------------------------------------------------------------
// 5. Assignee
// -----------------------------------------------------------------------

// One picker's worth. The endpoint's own default is 50; asking for fewer keeps
// a site with thousands of assignable users from turning one keystroke into a
// large response, and a typeahead that needs more than 20 rows is a typeahead
// the user should type another letter into.
const ASSIGNABLE_PAGE_SIZE = 20;

/**
 * The people this issue can actually be assigned to, narrowed by what the user
 * has typed.
 *
 * Per-issue, for the same reason `listPriorityOptions` reads the issue's own
 * editmeta rather than the site-wide priority list: assignability is a
 * project-level permission ("Assignable User"), so the set of people who can
 * take ENG-421 is not the set who can take OPS-3, and a site-wide user search
 * would happily offer someone Jira will then refuse.
 *
 * The `issueKey` parameter is the one place in this whole client that takes an
 * issue KEY rather than the numeric id everything else holds. That is Jira's
 * own parameter name and Jira's own contract on this endpoint — see the
 * caller, which passes `ticket.key` deliberately.
 *
 * A blank query is a real, useful call, not a no-op: it is what the panel does
 * on open, and Jira answers it with the first page of assignable users, which
 * is exactly the "who could I hand this to" list a picker should start from.
 *
 * Both this and the write below can 403 on a site that restricts "Browse users
 * and groups". That arrives here as `forbidden` through jiraFetch's existing
 * classification and is returned as a failure rather than an empty array,
 * which matters: an empty list renders as "nobody matches", and telling a user
 * their colleague does not exist because their admin restricted a permission
 * is a lie the picker would have no way to walk back.
 */
export async function searchAssignableUsers(
  issueKey: string,
  query: string,
): Promise<JiraResult<JiraWireUser[]>> {
  const credentialResult = requireCredential();
  if (!credentialResult.ok) return credentialResult;

  const result = await jiraFetch<unknown>(credentialResult.value, {
    method: 'GET',
    path: '/rest/api/3/user/assignable/search',
    query: {
      issueKey,
      query,
      maxResults: String(ASSIGNABLE_PAGE_SIZE),
    },
  });
  if (!result.ok) return result;

  return { ok: true, value: mapUserOptions(result.value) };
}

/**
 * Reassigns an issue, then re-reads it so the caller gets the state Jira
 * actually landed on rather than the one the UI assumed.
 *
 * `accountId: null` is Jira's documented payload for "unassign", not a missing
 * value — which is why it survives as a real `null` all the way from the
 * picker's Unassign row through the IPC boundary to this body. (`"-1"` means
 * "the project's default assignee" and is deliberately not offered: it is a
 * third outcome the user did not ask for, and Jira's own tracker has it
 * behaving inconsistently when addressed by account id.)
 *
 * The dedicated assignee endpoint, not the generic issue edit `PUT` that
 * `setTicketPriority` uses. They need different permissions — Jira grants
 * "Assign issues" separately from "Edit issues", specifically so a triager can
 * hand work around without being able to rewrite it — and the generic endpoint
 * additionally requires the assignee field to be on that issue type's edit
 * screen, which is a configuration this app has no business insisting on.
 *
 * There is deliberately no pre-flight re-read here, unlike `setTicketPriority`
 * and `transitionTicket`. Those two re-read live metadata because their
 * payload has to be *resolved* against it — a priority id must be in
 * allowedValues, a transition's field label must become an id — and a stale
 * value would otherwise produce a bare 400 with nothing legible in it. An
 * account id needs no resolving, and Jira's own answer when a user is not
 * assignable ("User cannot be assigned issues.") is already a clear sentence
 * that `messageFromErrorBody` surfaces verbatim. Spending a round trip to
 * restate it would be ceremony, not defense.
 */
export async function setTicketAssignee(
  ticketId: string,
  accountId: string | null,
): Promise<JiraResult<JiraWireTicket>> {
  const credentialResult = requireCredential();
  if (!credentialResult.ok) return credentialResult;
  const credential = credentialResult.value;

  // Answers 204 with no body on success, so there is nothing here to map —
  // the re-read below is what produces the ticket the caller gets.
  const written = await jiraFetch<void>(credential, {
    method: 'PUT',
    path: `/rest/api/3/issue/${encodeURIComponent(ticketId)}/assignee`,
    body: { accountId },
  });
  if (!written.ok) return written;

  return getTicket(ticketId);
}

// -----------------------------------------------------------------------
// 6. Attachments
// -----------------------------------------------------------------------

/**
 * The bytes of one attachment.
 *
 * The URL is built here, from the site stored with the credential plus the
 * caller's attachment id, and that is the whole security posture of this
 * function. Jira hands back a `content` URL on every attachment object and
 * this app deliberately never carries it (see `JiraWireAttachment`): a request
 * made with HTTP Basic `email:apiToken` is a request carrying a credential for
 * the user's entire Atlassian account, and the one thing that must never
 * decide where it goes is a string that arrived inside a response body. A
 * hostname validated at connect time and an id validated at the IPC boundary
 * are the only two inputs.
 *
 * Jira answers this endpoint with a redirect to a short-lived storage URL
 * rather than the bytes. `fetch` follows it, and the WHATWG fetch algorithm
 * that Node implements strips `Authorization` on a cross-origin redirect — so
 * the credential reaches Atlassian and stops there, which is exactly the
 * behaviour wanted and the reason the redirect is followed rather than being
 * turned off and re-issued by hand.
 *
 * Wrapped in an object rather than returning the Buffer bare, so a later
 * addition (the real filename Jira has, a content type) is a field rather than
 * a breaking change at every call site.
 */
export async function downloadAttachment(
  attachmentId: string,
): Promise<JiraResult<{ bytes: Buffer }>> {
  const credentialResult = requireCredential();
  if (!credentialResult.ok) return credentialResult;

  const result = await jiraFetchBinary(credentialResult.value, {
    method: 'GET',
    path: `/rest/api/3/attachment/content/${encodeURIComponent(attachmentId)}`,
  });
  if (!result.ok) return result;
  return { ok: true, value: { bytes: result.value } };
}

/**
 * Attaches one file to an issue, then re-reads the issue.
 *
 * The re-read is the same pattern every other write here uses, and it earns
 * its round trip twice over on this one. Jira's own answer is an array of
 * attachment objects for the files just uploaded — not the issue — so without
 * it the caller would have to splice a new attachment into a ticket it already
 * held and hope the two agree. It also means the caller learns Jira's real
 * filename for the file, which can differ from the one sent (a site can
 * rename on collision).
 *
 * The form field must be called `file`. That is Jira's parameter name, not a
 * convention: the endpoint looks for exactly that.
 *
 * One file per call, deliberately. The endpoint accepts several `file` parts
 * in one request, and a multi-file upload raises partial success — three of
 * five stored, which two failed, what the ticket now says — as a real problem
 * needing a real answer in the UI. That is a reasonable later expansion and
 * not something to half-build now.
 */
export async function uploadAttachment(
  ticketId: string,
  fileName: string,
  bytes: Buffer,
  mimeType: string,
): Promise<JiraResult<JiraWireTicket>> {
  const credentialResult = requireCredential();
  if (!credentialResult.ok) return credentialResult;
  const credential = credentialResult.value;

  if (bytes.byteLength > MAX_TRANSFER_BYTES) {
    return failure('jira_error', tooLargeMessage(bytes.byteLength));
  }

  // A Buffer's own `buffer` is typed `ArrayBufferLike`, which TypeScript will
  // not narrow to the `ArrayBuffer` a BlobPart wants — the gap is
  // SharedArrayBuffer, which nothing here can produce (`fs.readFile` and
  // `Buffer.from` both allocate ordinary ArrayBuffers). The alternative,
  // `new Uint8Array(bytes)`, copies — and `new Blob` already copies, so
  // satisfying the checker that way would mean holding a third copy of a file
  // up to the transfer cap in main's heap. The cast is the cheaper honesty.
  const part = bytes as unknown as Uint8Array<ArrayBuffer>;

  const form = new FormData();
  form.append('file', new Blob([part], { type: mimeType }), fileName);

  const posted = await jiraFetchMultipart<unknown>(credential, {
    path: `/rest/api/3/issue/${encodeURIComponent(ticketId)}/attachments`,
    form,
  });
  if (!posted.ok) return posted;

  return getTicket(ticketId);
}

// -----------------------------------------------------------------------
// 7. Comments
// -----------------------------------------------------------------------

// Reads go through v3, writes through v2 — a deliberate split, not an
// oversight on either side.
//
// Reads: v2 pre-flattens an ADF-authored comment into legacy wiki markup and
// hands it back as a plain string, which turns a real Jira @mention into the
// literal `[~accountid:712020:...]` — live-confirmed against a real connected
// site. v3 returns the ADF tree itself, where a mention node carries
// `attrs.text` ("@Amaan Nawab") and the account id stays where it belongs.
// jiraMap.ts's `mapComment` already flattens ADF correctly and already
// deliberately never surfaces an account id; reading v3 is simply what makes
// that already-correct path the one that runs.
//
// Writes: v3 requires the body to be an ADF tree, while v2 takes the plain
// string this app's composer actually produces. Comments written here are
// plain text, so the simpler API is also the correct one — and this path is
// unchanged.
const COMMENT_READ_PATH = (ticketId: string) =>
  `/rest/api/3/issue/${encodeURIComponent(ticketId)}/comment`;
const COMMENT_WRITE_PATH = (ticketId: string) =>
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
      path: COMMENT_READ_PATH(ticketId),
      // `-created` (newest first), not `created`. The cap is 100, and on a
      // busy ticket ascending order means those 100 are the *oldest* hundred
      // — a thread whose most recent activity is invisible, which is the one
      // thing a comment list exists to show.
      query: { orderBy: '-created', maxResults: '100' },
    },
  );
  if (!result.ok) return result;

  const comments = (result.value?.comments ?? [])
    .map((raw) => mapComment(raw, ticketId))
    .filter((c): c is JiraWireComment => c !== null);
  // Fetched newest-first, returned oldest-first: the drawer renders in array
  // order and appends a freshly posted comment with `[...cs, comment]`, so
  // ascending is the contract callers already depend on.
  comments.reverse();
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
      path: COMMENT_WRITE_PATH(ticketId),
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
