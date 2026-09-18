import { jiraGet, jiraPost, type JiraCredential, type JiraResult } from '../lib/jira/client.js';
import { adfToPlainText, type JiraAdfDoc } from '../lib/jira/adf.js';
import { JIRA_REF_PREFIX, isExternalRef } from '../lib/externalRefs.js';
import * as ticketRefs from '../services/ticketRefs.service.js';
import {
  ProviderUnavailableError,
  type NormalizedComment,
  type NormalizedTicket,
  type SearchOptions,
  type TicketProvider,
} from './types.js';

/**
 * Jira Cloud, behind the TicketProvider interface — plus, now, the three
 * writes an approved proposal can perform.
 *
 * The reads shipped and were proven against a real site first, on purpose.
 * The writes below are additions to that same class rather than a second one:
 * they authenticate the same way, fail the same way, and are reached through
 * the same per-request borrowed credential. What they are NOT is reachable
 * from a tool call — nothing here executes until a person clicks Approve
 * (see services/proposals.service.ts), which is the invariant the whole
 * propose/approve split exists to hold.
 *
 * Three writes and no more. There is no assignee change, no priority change,
 * no issue creation: each of those needs its own live-field negotiation with
 * a site's own schemes, and shipping one badly is worse than not shipping it.
 */

// Defined in lib/externalRefs.ts (no dependencies, so the validation layer
// can dispatch on the prefix too); re-exported here so every existing caller
// keeps importing them from the provider.
export { JIRA_REF_PREFIX, isExternalRef };

/**
 * The fields worth fetching, named explicitly rather than using `*all`.
 *
 * `*all` pulls every custom field a site has ever defined — on a mature Jira
 * instance that is hundreds of fields per issue, and all of it would be
 * flattened into a tool result and charged to the model's context window.
 * The desktop app asks for `*all` because it renders sprint and story-point
 * custom fields whose ids differ per site; nothing here does.
 */
const ISSUE_FIELDS = [
  'summary',
  'description',
  'status',
  'priority',
  'duedate',
  'assignee',
  'reporter',
  'project',
  'issuetype',
  'labels',
  'created',
  'updated',
].join(',');

/**
 * The shape of a Jira issue key: PROJECT-NUMBER.
 *
 * Checked before any request goes out, for two reasons. The obvious one is
 * that an identifier that cannot be a key cannot name an issue, so asking is
 * a guaranteed-wasted round trip. The load-bearing one is cost: the
 * identifier resolution deliberately asks Jira even when a native ticket
 * already matched (see mcp/ticketTools.ts), so this shape check is what keeps
 * that from meaning "every lookup of any string hits the network".
 *
 * Note that this does NOT distinguish a Jira key from a native identifier —
 * native identifiers are minted in exactly this shape too (see
 * tickets.service.ts). That overlap is the reason the resolution algorithm
 * exists; it is not something a regex can settle.
 */
const ISSUE_KEY = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;

/**
 * A bare positive integer — the shape of a Jira dashboard, gadget, and
 * filter id. Checked before any of those three is interpolated directly into
 * a request path or a JQL clause (`filter = <id>`, not `filter = "<id>"`,
 * since `filter =` takes a numeric id, not a quoted string) — jqlQuoted
 * cannot be reused for this the way it is for a free-text value, because a
 * numeric id has to reach Jira unquoted to mean "this filter", not "a string
 * matching this filter's name". This regex is what makes interpolating it
 * bare safe: anything that isn't only digits is refused before it ever
 * reaches a request.
 */
const NUMERIC_ID = /^\d+$/;

/**
 * A Jira Cloud accountId's shape — seen in practice as
 * "712020:05c45d40-ca2a-4829-84ad-df1f5429a4d0" (a numeric prefix, a colon,
 * a UUID) but not guaranteed to stay exactly that by Atlassian's own
 * documentation, so this is intentionally a permissive charset rather than
 * that literal shape: letters, digits, colon, and hyphen, nothing else. It
 * exists so a value this loose still cannot contain a quote, a backslash, or
 * whitespace that could matter to JQL — jqlQuoted is applied on top of this
 * regardless (see searchIssuesByFilter), so this is a second, independent
 * gate rather than the only one.
 */
const ACCOUNT_ID = /^[A-Za-z0-9:-]{1,128}$/;

/**
 * How many dashboards listDashboards asks Jira for, regardless of the
 * caller's own `limit` — matches mcp/ticketTools.ts's MAX_LIST_LIMIT (not
 * imported directly: providers/ is the layer mcp/ builds on, and importing
 * the other way would invert that). Fixed rather than tied to `limit`
 * because the name filter runs client-side against whatever this returns —
 * a small `limit` (the common case) must not also mean "search a smaller
 * pool for a name match" (round-1 review, ROAD-157).
 */
const DASHBOARD_FETCH_SIZE = 200;

/**
 * Quotes a value for JQL.
 *
 * This is the security boundary for a model-supplied search string. JQL is a
 * query language and `query` reaches it from tool input, so without quoting,
 * a crafted search term would be able to rewrite the query it was supposed to
 * be a term in — reading issues outside the intended scope, since the
 * credential's own permissions are the only other limit.
 *
 * Backslash first, then quote: reversing the order would re-escape the
 * backslashes this function just added. Control characters are stripped
 * rather than escaped — a newline inside a JQL string literal is not
 * something a legitimate search term contains, and JQL has no escape for it.
 *
 * Within the quoted string, Jira's `~` operator still interprets Lucene
 * syntax (`*`, `AND`, `~`), so a term can produce odd MATCHES. It cannot
 * produce a different QUERY, which is the property that matters.
 */
function jqlQuoted(value: string): string {
  // Written as explicit \u escapes rather than as a literal character class:
  // control characters are invisible in source, so a class typed literally is
  // both unreviewable and one keystroke away from being a printable range
  // (space-to-hyphen) that silently mangles ordinary search terms instead of
  // stripping anything.
  // eslint-disable-next-line no-control-regex
  const stripped = value.replace(/[\u0000-\u001F\u007F]/g, ' ');
  return `"${stripped.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Jira's priority names → this app's priority vocabulary.
 *
 * Mapped rather than passed through so that "high priority" means one thing
 * across both providers, which is the point of normalizing at all. It is
 * lossy in one place on purpose: Jira's default scheme has five levels either
 * side of Medium and this app has four plus "none", so Lowest collapses into
 * low. The raw name survives in the detail record, so nothing is hidden — a
 * caller that needs Jira's own word for it can still read it.
 *
 * An unrecognised name (sites can rename or replace the whole scheme) becomes
 * 'none' rather than a guess: 'none' already means "no priority information"
 * here, which is exactly the truth in that case.
 */
const PRIORITY_BY_NAME: Record<string, string> = {
  highest: 'urgent',
  high: 'high',
  medium: 'medium',
  low: 'low',
  lowest: 'low',
  urgent: 'urgent',
  none: 'none',
};

/**
 * Jira status category → this app's state_group vocabulary.
 *
 * The status NAME is per-site configurable and unbounded ("In Code Review",
 * "Awaiting Legal"), but its CATEGORY is one of three fixed values Jira
 * itself defines. That makes the category the only part of a Jira workflow
 * that can be mapped without knowing the site — which is what lets a caller
 * ask "is this done?" across providers.
 *
 * 'done' maps to 'completed', never 'cancelled': Jira does not distinguish
 * shipped from abandoned at the category level, and guessing 'cancelled'
 * would assert something the source does not say.
 */
const GROUP_BY_CATEGORY: Record<string, string> = {
  new: 'unstarted',
  indeterminate: 'started',
  done: 'completed',
};

type JiraIssue = {
  key?: unknown;
  fields?: Record<string, unknown>;
};

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * An id field, tolerant of Jira serializing it as either a JSON string or a
 * JSON number — confirmed live to differ BETWEEN dashboard endpoints on the
 * same site: `/rest/api/3/dashboard`'s own dashboard ids come back as
 * strings ("10000"), but that same dashboard's gadgets from
 * `/rest/api/3/dashboard/{id}/gadget` come back with a numeric `id` (10000,
 * no quotes). listTransitions above hit the identical inconsistency for
 * transition ids and solved it the same way (see its own comment). str()
 * alone would silently turn every numeric id into an empty string here —
 * exactly the bug a live-tested unit case caught in review, not something
 * this function's existence is guessing might happen.
 */
function idStr(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function nested(fields: Record<string, unknown>, field: string, key: string): string {
  const value = fields[field];
  if (!value || typeof value !== 'object') return '';
  return str((value as Record<string, unknown>)[key]);
}

function issueUrl(site: string, key: string): string {
  return `https://${site}/browse/${encodeURIComponent(key)}`;
}

/**
 * A minimal per-issue projection for search_dashboard_gadget_issues — not
 * toSummary/toNormalized's shape, and deliberately so: those exist to
 * satisfy TicketProvider's cross-provider contract (an `id`/`ref` a later
 * get_ticket call can use), but a gadget-query result is grouped by issue
 * type already, doesn't remember a ticket_refs row for every hit the way
 * search() does, and is meant to be read directly rather than drilled into.
 * Callers that want a full record still call get_ticket_by_identifier with
 * the key this returns.
 */
function toSummaryForGadget(
  issue: JiraIssue,
): { key: string; summary: string; status: string; issueType: string; updated: string } {
  const fields = issue.fields ?? {};
  const key = str(issue.key);
  return {
    key,
    summary: str(fields.summary),
    status: nested(fields, 'status', 'name'),
    issueType: nested(fields, 'issuetype', 'name'),
    updated: str(fields.updated),
  };
}

/**
 * A transition's DESTINATION status category, in this app's state_group
 * vocabulary — i.e. "where would this move the issue to".
 *
 * Separate from statusGroup below because the shape differs: an issue carries
 * `fields.status.statusCategory`, while a transition carries
 * `to.statusCategory`. Same mapping, one level deeper.
 */
function transitionGroup(transition: Record<string, unknown>): string | undefined {
  const to = transition.to;
  if (!to || typeof to !== 'object') return undefined;
  const category = (to as Record<string, unknown>).statusCategory;
  if (!category || typeof category !== 'object') return undefined;
  return GROUP_BY_CATEGORY[str((category as Record<string, unknown>).key)];
}

function statusGroup(fields: Record<string, unknown>): string | undefined {
  const status = fields.status;
  if (!status || typeof status !== 'object') return undefined;
  const category = (status as Record<string, unknown>).statusCategory;
  if (!category || typeof category !== 'object') return undefined;
  return GROUP_BY_CATEGORY[str((category as Record<string, unknown>).key)];
}

/**
 * The assignee, as a one-element list or an empty one.
 *
 * A list because the normalized shape is a list — this app's tickets have
 * many assignees and Jira issues have at most one, and flattening that
 * difference here means no caller has to special-case it. The accountId is
 * used as the id, so it is what a future assignee filter would have to send
 * back to Jira.
 */
function assignee(fields: Record<string, unknown>): { ids: string[]; names: string[] } {
  const id = nested(fields, 'assignee', 'accountId');
  if (!id) return { ids: [], names: [] };
  return { ids: [id], names: [nested(fields, 'assignee', 'displayName') || id] };
}

function toNormalized(
  issue: JiraIssue,
  ref: string,
  site: string,
  options: { withDetail: boolean },
): NormalizedTicket {
  const key = str(issue.key);
  const fields = issue.fields ?? {};
  const { ids, names } = assignee(fields);
  const priorityName = nested(fields, 'priority', 'name');
  const normalized: NormalizedTicket = {
    provider: 'jira',
    ref,
    identifier: key,
    title: str(fields.summary),
    // The project KEY, not its numeric id: it is what a user says, what
    // appears in every issue key, and what search_tickets' projectId filter
    // needs to send back as JQL.
    projectId: nested(fields, 'project', 'key'),
    stateId: nested(fields, 'status', 'id'),
    stateName: nested(fields, 'status', 'name'),
    stateGroup: statusGroup(fields),
    priority: PRIORITY_BY_NAME[priorityName.toLowerCase()] ?? 'none',
    // Jira's duedate is already YYYY-MM-DD, the same format this app's
    // dueDate column uses, so no conversion (and no timezone question).
    dueDate: str(fields.duedate) || null,
    assigneeIds: ids,
    assigneeNames: names,
    url: issueUrl(site, key),
  };
  if (!options.withDetail) return normalized;
  return {
    ...normalized,
    detail: {
      provider: 'jira',
      id: ref,
      identifier: key,
      title: normalized.title,
      description: adfToPlainText(fields.description),
      url: normalized.url,
      projectId: normalized.projectId,
      projectName: nested(fields, 'project', 'name'),
      stateId: normalized.stateId,
      stateName: normalized.stateName,
      stateGroup: normalized.stateGroup,
      priority: normalized.priority,
      // Jira's own word for the priority, kept because the mapping above is
      // lossy and a user asking "why does it say high" deserves the source.
      priorityName: priorityName || null,
      dueDate: normalized.dueDate,
      assigneeIds: normalized.assigneeIds,
      assigneeNames: normalized.assigneeNames,
      reporterName: nested(fields, 'reporter', 'displayName') || null,
      issueType: nested(fields, 'issuetype', 'name') || null,
      labels: Array.isArray(fields.labels) ? fields.labels.filter((l) => typeof l === 'string') : [],
      createdAt: str(fields.created) || null,
      updatedAt: str(fields.updated) || null,
    },
  };
}

/**
 * Turns a transport failure into "I could not find out".
 *
 * Every reason EXCEPT not_found lands here. That asymmetry is the point: a
 * 404 is Jira answering, and its answer is usable; everything else is Jira
 * failing to answer, and treating those as "no such ticket" is how the
 * identifier resolution would come to assert an identifier is native-only
 * because Jira had a bad minute.
 */
function unavailable(failure: Extract<JiraResult<never>, { ok: false }>): never {
  throw new ProviderUnavailableError(failure.message);
}

export class JiraProvider implements TicketProvider {
  readonly kind = 'jira' as const;

  constructor(private readonly credential: JiraCredential) {}

  /** The site every read and write here goes to. Public because a proposal
   *  has to record it: a reviewer approving a write is entitled to know which
   *  Jira it lands on, and the propose handler is the only place that can
   *  capture it truthfully. */
  get site(): string {
    return this.credential.site;
  }

  /**
   * Whose Jira account a write posts as.
   *
   * Falls back to the account's email when the borrowed credential carries no
   * display name (an older desktop build) — a worse-reading answer to the
   * same question, never a missing one, because "as whom" is not a field a
   * write-approval banner may leave blank.
   *
   * Deliberately NOT the Waypoint user's name, which is a different fact:
   * Copilot acts on behalf of the Waypoint user, but it authenticates as this
   * Atlassian account, and it is the second one that the issue's watchers
   * will see.
   */
  get actorName(): string {
    return this.credential.displayName ?? this.credential.email;
  }

  /**
   * One live point-lookup for one exact issue key.
   *
   * Returns null ONLY on a real 404. See unavailable() above for why
   * everything else throws instead.
   */
  private async fetchIssue(key: string): Promise<JiraIssue | null> {
    const result = await jiraGet<JiraIssue>(
      this.credential,
      `/rest/api/3/issue/${encodeURIComponent(key)}`,
      { fields: ISSUE_FIELDS },
    );
    if (!result.ok) {
      if (result.reason === 'not_found') return null;
      unavailable(result);
    }
    return result.value ?? null;
  }

  async getByRef(ref: string): Promise<NormalizedTicket | null> {
    const row = await ticketRefs.findById(ref);
    // A ref for another site is not this provider's to answer. It happens
    // after a reconnect against a different Jira: the old handles survive
    // (they hold no secret and cost nothing) but must not resolve against a
    // site that knows nothing about them.
    if (!row || row.provider !== 'jira' || row.externalSite !== this.site) return null;

    const issue = await this.fetchIssue(row.externalId);
    if (!issue) return null;
    await this.remember(issue, row.externalId);
    return toNormalized(issue, row.id, this.site, { withDetail: true });
  }

  async getByIdentifier(identifier: string): Promise<NormalizedTicket | null> {
    const key = identifier.trim();
    if (!ISSUE_KEY.test(key)) return null;

    // The cache is consulted, but it does not short-circuit the read. It
    // cannot: a row here carries a title and a URL, not a description or a
    // status, so answering from it would hand the model stale content dressed
    // as a live read. What it is actually for is the OTHER direction —
    // knowing this identifier has been seen as a Jira issue before, which is
    // half of the ambiguity question — and it is refreshed below either way.
    const issue = await this.fetchIssue(key);
    if (!issue) return null;

    const row = await this.remember(issue, key);
    return toNormalized(issue, row.id, this.site, { withDetail: true });
  }

  async search(query: string, { projectId, limit }: SearchOptions): Promise<NormalizedTicket[]> {
    // `summary ~` rather than `text ~`, to match what search_tickets already
    // means for native tickets: a title keyword search (an ilike over
    // tickets.title, see tickets.service.ts). Searching Jira's full text
    // while searching only native titles would make one tool mean two things
    // depending on which provider answered.
    const clauses = [`summary ~ ${jqlQuoted(query)}`];
    if (projectId) clauses.push(`project = ${jqlQuoted(projectId)}`);
    const jql = `${clauses.join(' AND ')} ORDER BY updated DESC`;

    const result = await jiraGet<{ issues?: unknown[] }>(this.credential, '/rest/api/3/search/jql', {
      jql,
      fields: ISSUE_FIELDS,
      maxResults: String(limit),
    });
    if (!result.ok) unavailable(result);

    const issues = (result.value?.issues ?? []).filter(
      (issue): issue is JiraIssue => !!issue && typeof issue === 'object' && !!str((issue as JiraIssue).key),
    );
    if (issues.length === 0) return [];

    // Handles for every hit, in ONE upsert. Without this the results would be
    // unusable as refs: a model that searched and then called get_ticket on a
    // result would have nothing to pass.
    const rows = await ticketRefs.rememberMany(
      issues.map((issue) => this.rememberInput(issue, str(issue.key))),
    );
    return issues
      .map((issue) => {
        const row = rows.get(str(issue.key));
        return row ? toNormalized(issue, row.id, this.site, { withDetail: false }) : null;
      })
      .filter((t): t is NormalizedTicket => t !== null);
  }

  async listComments(ref: string, limit: number): Promise<NormalizedComment[]> {
    const row = await ticketRefs.findById(ref);
    if (!row || row.provider !== 'jira' || row.externalSite !== this.site) return [];

    const result = await jiraGet<{ comments?: unknown[] }>(
      this.credential,
      `/rest/api/3/issue/${encodeURIComponent(row.externalId)}/comment`,
      // Newest first, then reversed below. On a busy issue the cap would
      // otherwise return the OLDEST N — a thread whose recent activity is
      // invisible, which is the one thing a comment list exists to show.
      { orderBy: '-created', maxResults: String(limit) },
    );
    if (!result.ok) unavailable(result);

    const comments = (result.value?.comments ?? [])
      .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
      .map((comment) => ({
        id: str(comment.id),
        ticketId: ref,
        authorId: nested(comment, 'author', 'accountId'),
        authorName: nested(comment, 'author', 'displayName') || nested(comment, 'author', 'accountId'),
        body: adfToPlainText(comment.body),
        bodyFormat: 'text' as const,
        createdAt: str(comment.created),
      }));
    // Returned oldest-first, matching what list_comments already does for
    // native comments (ordered by createdAt ascending in commentsService).
    return comments.reverse();
  }

  // ---------------------------------------------------------------------
  // Dashboards, gadgets, and filters (ROAD-157).
  //
  // Jira Cloud's public API exposes dashboard METADATA and per-gadget
  // CONFIGURATION, but never a gadget's own rendered output — there is no
  // "read this table" endpoint, and this deliberately does not try to
  // reimplement one. A dashboard's Two-Dimensional Filter Statistics gadget
  // (and every other stats/filter-results gadget) is always backed by a
  // saved Jira filter — a normal search, not a gadget-specific computation —
  // so the shape here is: resolve a gadget to the filter (or project) behind
  // it, then run an ordinary JQL search against that. searchIssuesByFilter
  // below returns the matching issues flat, in Jira's own order; grouping
  // them by field (issue type, status, or not at all) is a presentation
  // choice that lives in mcp/dashboardTools.ts, the same division search
  // Jira's own gadget uses — Jira computes the answer, something above it
  // decides how to bucket it for display — rather than this provider baking
  // in one grouping.
  // ---------------------------------------------------------------------

  /** The dashboards this account can see. `nameContains` is applied here,
   *  not sent to Jira: `/rest/api/3/dashboard` has no name-filter query
   *  parameter (unlike `/rest/api/3/filter/search`, which does), so an
   *  unfiltered page is fetched and narrowed client-side. Exists so Copilot
   *  can turn "my scrum master's dashboard" into a real id instead of
   *  guessing one.
   *
   *  Unlike searchFilters below, an absent `nameContains` here returns
   *  everything rather than refusing — deliberately, not an inconsistency:
   *  this IS list_jira_dashboards' own advertised contract ("optionally
   *  narrowed by name"), every row is a dashboard the account already sees
   *  and only carries {id, name, isFavourite}, and the result is bounded by
   *  DASHBOARD_FETCH_SIZE/limit either way. searchFilters is never itself a
   *  tool — only an unrequested-disclosure risk if it fell back the same
   *  way (round-3 review, ROAD-157). */
  async listDashboards(
    nameContains: string | undefined,
    limit: number,
  ): Promise<{ dashboards: { id: string; name: string; isFavourite: boolean }[]; truncated: boolean }> {
    // Always requests DASHBOARD_FETCH_SIZE from Jira, not `limit` — the name
    // filter below runs client-side against whatever Jira returns, so tying
    // the fetch size to the caller's final result-count cap would make a
    // small `limit` (the common case) silently search a smaller pool for a
    // name match, which is the opposite of what limit means for every other
    // list tool in this codebase. Fixed at the tool schema's own ceiling
    // (MAX_LIST_LIMIT) so this can never under-serve a caller regardless of
    // what `limit` they asked for (round-1 review, ROAD-157: this
    // previously hardcoded '100', silently below that ceiling).
    const result = await jiraGet<{
      dashboards?: { id?: unknown; name?: unknown; isFavourite?: unknown }[];
      total?: unknown;
    }>(this.credential, '/rest/api/3/dashboard', { maxResults: String(DASHBOARD_FETCH_SIZE) });
    if (!result.ok) unavailable(result);

    const rawDashboards = result.value?.dashboards ?? [];
    // The endpoint's own authoritative count of dashboards on the site —
    // confirmed live (round-6 review, ROAD-157) that `/rest/api/3/dashboard`
    // really does return this, same as any standard Jira paginated bean.
    // Preferred over the round-2 heuristic (rawDashboards.length >=
    // DASHBOARD_FETCH_SIZE), which is only a correct "there may be more"
    // signal if Jira happens to honor maxResults exactly — but kept as the
    // fallback for the one case a real `total` can't cover: a response that
    // omits it entirely (a future API version, a proxy that strips unknown
    // fields), rather than trusting an absent field as "there is no more".
    const rawTotal = result.value?.total;
    const sitePoolTruncated =
      typeof rawTotal === 'number' ? rawTotal > rawDashboards.length : rawDashboards.length >= DASHBOARD_FETCH_SIZE;
    const needle = nameContains?.trim().toLowerCase();
    const dashboards = rawDashboards
      .filter((d): d is Record<string, unknown> => !!d && typeof d === 'object')
      .map((d) => ({ id: idStr(d.id), name: str(d.name), isFavourite: d.isFavourite === true }))
      .filter((d) => d.id && (!needle || d.name.toLowerCase().includes(needle)));
    return {
      dashboards: dashboards.slice(0, limit),
      // True on EITHER of two distinct reasons the caller saw an
      // incomplete picture — merged into one flag because every other list
      // tool's `truncated` means exactly one thing ("there was more than
      // this returned"), and round-3 review found this field diverging
      // from that meaning was itself the bug: it used to report only the
      // second reason below, so a real name match beyond `limit` (matches.length
      // > limit, the ordinary, everyday case) silently reported
      // truncated: false, the same as a genuinely complete result.
      //  1. dashboards.length > limit — more NAME MATCHES existed than the
      //     requested page size returned (the ordinary meaning, matching
      //     ticketTools.ts's page() convention elsewhere in this codebase).
      //  2. sitePoolTruncated — the site's own reported dashboard count
      //     exceeds what this account-wide, unpaginated read actually
      //     fetched, so there may be MORE dashboards than this saw AT ALL,
      //     before the name filter even runs (round-2 review, tightened in
      //     round-6 to read the real total instead of only inferring it) —
      //     without this, a name search against a site with more
      //     dashboards than this read covers can come back with a plain
      //     empty result indistinguishable from "no such dashboard".
      truncated: dashboards.length > limit || sitePoolTruncated,
    };
  }

  /** The gadgets placed on one dashboard — id, title, moduleKey. Read-only
   *  metadata; resolving what each one is BOUND to is a separate step (see
   *  resolveGadgetBinding), because that needs a second call per gadget and
   *  a caller listing gadgets to pick one from doesn't need it yet. */
  async getDashboardGadgets(
    dashboardId: string,
  ): Promise<{ id: string; title: string; moduleKey: string }[] | null> {
    const result = await jiraGet<{
      gadgets?: { id?: unknown; title?: unknown; moduleKey?: unknown }[];
    }>(this.credential, `/rest/api/3/dashboard/${encodeURIComponent(dashboardId)}/gadget`);
    if (!result.ok) {
      // Deliberately narrower than getGadgetConfig/getFilter's own
      // not_found-or-forbidden → null (round-3 review flagged the
      // divergence; this is the considered answer, not an oversight).
      // Here, unlike those two, null carries an overloaded meaning callers
      // rely on: dashboardTools.ts treats a null return from THIS method as
      // "the dashboard itself doesn't exist" (see describeJiraDashboardHandler
      // and the needsBinding branch, both `if (!gadgets) return
      // notFoundResult('dashboard')`). Folding 'forbidden' in here would
      // make "I can see this dashboard but not its gadget list" report as
      // "this dashboard doesn't exist" — a worse, actively misleading
      // answer, not just a less helpful one. A forbidden gadget-list read
      // surfacing as "Jira could not be reached" is the honest fallback
      // until this method's return type can distinguish all three cases
      // explicitly.
      if (result.reason === 'not_found') return null;
      unavailable(result);
    }
    return (result.value?.gadgets ?? [])
      .filter((g): g is Record<string, unknown> => !!g && typeof g === 'object')
      .map((g) => ({ id: idStr(g.id), title: str(g.title), moduleKey: str(g.moduleKey) }))
      .filter((g) => g.id);
  }

  /** One gadget's stored preferences, or null if it has none under the
   *  "config" key (Jira's own convention for a gadget's user preferences —
   *  confirmed live against real dashboard items: every configurable stock
   *  gadget exposes exactly this key, e.g. the Activity Stream gadget's
   *  preferences come back as {"numofentries":"5","keys":"__all_projects__",...}
   *  under the same key). Values are always strings — Jira's gadget
   *  preference storage is a flat string-to-string map, never nested JSON. */
  private async getGadgetConfig(
    dashboardId: string,
    gadgetId: string,
  ): Promise<Record<string, string> | null> {
    const result = await jiraGet<{ key?: unknown; value?: unknown }>(
      this.credential,
      `/rest/api/3/dashboard/${encodeURIComponent(dashboardId)}/items/${encodeURIComponent(gadgetId)}/properties/config`,
    );
    if (!result.ok) {
      // 'forbidden', not just 'not_found', is treated as "nothing to
      // resolve" (round-1 review, ROAD-157): describeJiraDashboardHandler
      // resolves every gadget on a dashboard concurrently, and one gadget
      // this account can't read the config of must not fail the whole
      // batch — same posture getFilter below already takes for the
      // equivalent case on a filter.
      if (result.reason === 'not_found' || result.reason === 'forbidden') return null;
      unavailable(result);
    }
    const value = result.value?.value;
    if (!value || typeof value !== 'object') return null;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  }

  /**
   * Resolves a gadget to what backs it: a saved filter, a project, or
   * unresolved.
   *
   * The preference key names below (`filterid` holding `filter-<id>` or
   * `project-<id>`, `filterId`, `projectOrFilterId`) are Jira's known gadget-
   * preference conventions for its stats/filter-results gadget family
   * (Two-Dimensional Filter Statistics, Filter Results, Pie Chart, and
   * others) — confirmed live only for what "config" itself returns (real,
   * per-gadget key/value data), NOT yet confirmed against a live
   * Two-Dimensional Filter Statistics gadget specifically, since none exists
   * on the Jira site this was developed against. Tried in order; the first
   * one present wins. A gadget whose config matches none of them comes back
   * `unresolved` rather than a guess — see describe_jira_dashboard's tool
   * description, which tells Copilot this is an expected, first-class
   * outcome to ask the user about, not an error to retry.
   */
  async resolveGadgetBinding(
    dashboardId: string,
    gadgetId: string,
  ): Promise<
    | { kind: 'filter'; filterId: string; filterName: string; jql: string }
    | { kind: 'project'; projectKey: string }
    | { kind: 'unresolved'; reason: string }
  > {
    const config = await this.getGadgetConfig(dashboardId, gadgetId);
    if (!config) {
      return { kind: 'unresolved', reason: 'This gadget has no stored configuration to resolve.' };
    }

    const combined = config.filterid ?? config.projectOrFilterId;
    if (combined) {
      const filterMatch = /^filter-(\d+)$/.exec(combined);
      // Anchored to Jira's own project-key shape (round-2 review, ROAD-157)
      // — this used to be `/^project-(.+)$/`, which accepted anything
      // (quotes, whitespace, arbitrary length) as a "project key" that
      // dashboardTools.ts then echoes verbatim inside an imperative,
      // model-facing sentence ("Use search_tickets with ... projectKey=…").
      // The gadget config is Jira-controlled, not model-controlled, but
      // it's still authored by whoever configured the dashboard — an
      // unbounded match would let that person's text ride into Copilot's
      // context wrapped in a directive. A value that doesn't look like a
      // real project key falls through to unresolved below rather than
      // being trusted.
      const projectMatch = /^project-([A-Z][A-Z0-9_]{1,9})$/.exec(combined);
      if (filterMatch) {
        const filter = await this.getFilter(filterMatch[1]);
        if (filter) return { kind: 'filter', filterId: filter.id, filterName: filter.name, jql: filter.jql };
        return {
          kind: 'unresolved',
          reason: `This gadget is bound to filter ${filterMatch[1]}, which could not be read (deleted, or not shared with this account).`,
        };
      }
      if (projectMatch) return { kind: 'project', projectKey: projectMatch[1] };
    }

    const bareFilterId = config.filterId && NUMERIC_ID.test(config.filterId) ? config.filterId : undefined;
    if (bareFilterId) {
      const filter = await this.getFilter(bareFilterId);
      if (filter) return { kind: 'filter', filterId: filter.id, filterName: filter.name, jql: filter.jql };
    }

    return {
      kind: 'unresolved',
      reason:
        "This gadget's configuration doesn't match a recognized filter or project binding — pass a filterId directly instead.",
    };
  }

  /** One saved filter's id, name, and JQL — or null if it doesn't exist or
   *  isn't shared with this account. `filterId` must already be validated
   *  numeric by the caller (see NUMERIC_ID); it is interpolated bare into the
   *  path, never into JQL text here. */
  async getFilter(filterId: string): Promise<{ id: string; name: string; jql: string } | null> {
    const result = await jiraGet<{ id?: unknown; name?: unknown; jql?: unknown }>(
      this.credential,
      `/rest/api/3/filter/${encodeURIComponent(filterId)}`,
    );
    if (!result.ok) {
      if (result.reason === 'not_found' || result.reason === 'forbidden') return null;
      unavailable(result);
    }
    if (!result.value || !idStr(result.value.id)) return null;
    return { id: idStr(result.value.id), name: str(result.value.name), jql: str(result.value.jql) };
  }

  /**
   * Saved filters visible to this account, narrowed by name. `filterName` IS
   * a real query parameter on `/rest/api/3/filter/search` (unlike dashboard
   * listing above) — sent straight through rather than filtered
   * client-side.
   *
   * Requires a real, non-empty `nameContains` — this does NOT fall back to
   * "return an unfiltered page" the way listDashboards' own name filter
   * does. Round-3 review (ROAD-157): the guard against handing the model an
   * arbitrary, unrequested page of every saved filter this account can see
   * (round-1/round-2's finding) used to live only at dashboardTools.ts's one
   * call site — a future second caller that forgot the same ternary would
   * silently reopen it, and nothing here would stop it. Putting the refusal
   * in the producer means every current and future caller inherits it,
   * matching how resolveGadgetBinding's own projectKey fix was placed in the
   * producer rather than trusted to each consumer.
   */
  async searchFilters(
    nameContains: string | undefined,
    limit: number,
  ): Promise<{ filters: { id: string; name: string }[]; truncated: boolean }> {
    const needle = nameContains?.trim();
    if (!needle) return { filters: [], truncated: false };
    const result = await jiraGet<{
      values?: { id?: unknown; name?: unknown }[];
      isLast?: unknown;
    }>(this.credential, '/rest/api/3/filter/search', { maxResults: String(limit), filterName: needle });
    if (!result.ok) unavailable(result);
    const filters = (result.value?.values ?? [])
      .filter((f): f is Record<string, unknown> => !!f && typeof f === 'object')
      .map((f) => ({ id: idStr(f.id), name: str(f.name) }))
      .filter((f) => f.id);
    // `/rest/api/3/filter/search` is a real, standard paginated endpoint —
    // confirmed live: its response carries its own `isLast` (round-6
    // review, ROAD-157: every truncation signal in this feature used to be
    // inferred from row counts against the requested page size, and this
    // one had none at all). `isLast === false` is the authoritative "there
    // is more" signal; a row-count comparison is not needed alongside it.
    return { filters, truncated: result.value?.isLast === false };
  }

  /**
   * Runs a saved filter's JQL, narrowed by assignee and (optionally) issue
   * type, and groups the results by issue type.
   *
   * The filter's own JQL is never parsed or concatenated as text — it is
   * referenced by id (`filter = <id>`, Jira's own supported JQL function),
   * which composes safely with anything appended after it regardless of what
   * the filter's saved query contains (its own ORDER BY, a nested filter,
   * anything). filterId must already be validated numeric by the caller.
   * assigneeScope 'me' emits the literal `currentUser()` and never touches
   * caller input; an explicit accountId goes through jqlQuoted like any other
   * model-influenced string. issueTypes go through jqlQuoted individually.
   */
  async searchIssuesByFilter(options: {
    filterId: string;
    assigneeScope: 'me' | 'accountId';
    accountId?: string;
    issueTypes?: string[];
    limit: number;
  }): Promise<{
    jql: string;
    issues: ReturnType<typeof toSummaryForGadget>[];
    truncated: boolean;
  }> {
    // Defense in depth: the MCP tool schema (dashboardTools.ts) already
    // shapes filterId as \d+ and accountId against a strict charset before
    // either reaches here, but this method builds JQL from both directly, so
    // it re-checks rather than trusting the caller — the same posture
    // jqlQuoted's own doc comment takes for free-text input.
    if (!NUMERIC_ID.test(options.filterId)) {
      throw new Error('searchIssuesByFilter: filterId must be a bare numeric id.');
    }
    if (options.assigneeScope === 'accountId' && !ACCOUNT_ID.test(options.accountId ?? '')) {
      throw new Error('searchIssuesByFilter: accountId has an unexpected shape.');
    }

    const clauses = [`filter = ${options.filterId}`];
    clauses.push(
      options.assigneeScope === 'me' ? 'assignee = currentUser()' : `assignee = ${jqlQuoted(options.accountId ?? '')}`,
    );
    if (options.issueTypes?.length) {
      clauses.push(`issuetype IN (${options.issueTypes.map(jqlQuoted).join(', ')})`);
    }
    const jql = `${clauses.join(' AND ')} ORDER BY issuetype ASC, updated DESC`;

    // `/rest/api/3/search/jql` is Jira's cursor-paginated issue-search
    // endpoint — confirmed live (round-6 review, ROAD-157) that it answers
    // with `isLast`/`nextPageToken`, not a `total`, and that a page shorter
    // than `maxResults` is fully within its contract even when more issues
    // match. The previous approach (request limit+1, call it truncated if
    // more than `limit` came back) assumed classic offset pagination this
    // endpoint doesn't use — a response could legitimately return exactly
    // `limit` rows with nothing left, or fewer than `limit` rows with more
    // still to come, and the row-count comparison would get BOTH wrong.
    // `isLast` is the endpoint's own authoritative answer, so this now
    // requests exactly `limit` (no sentinel row) and trusts that field
    // directly instead of inferring anything from how many rows came back.
    const result = await jiraGet<{ issues?: unknown[]; isLast?: unknown }>(
      this.credential,
      '/rest/api/3/search/jql',
      { jql, fields: ISSUE_FIELDS, maxResults: String(options.limit) },
    );
    if (!result.ok) unavailable(result);

    const issues = (result.value?.issues ?? []).filter(
      (issue): issue is JiraIssue => !!issue && typeof issue === 'object' && !!str((issue as JiraIssue).key),
    );
    const truncated = result.value?.isLast === false;

    return { jql, issues: issues.map((issue) => toSummaryForGadget(issue)), truncated };
  }

  // ---------------------------------------------------------------------
  // Writes. Reached only from an approved proposal, never from a tool call.
  // ---------------------------------------------------------------------

  /**
   * The live transition list for one issue.
   *
   * The `id` in each entry is a Jira TRANSITION id, not a status id, and that
   * distinction is the whole reason this exists rather than reusing the
   * status id already on the ticket. Jira does not move an issue to a status;
   * it applies a named transition, and which transitions exist depends on the
   * issue's current status, its workflow, and this account's permissions. So
   * a state_change proposal against Jira carries a transition id in its
   * `stateId` payload — the only value applyTransition can act on.
   *
   * It also means the set is not stable between propose and approve: someone
   * else moving the issue changes which transitions are legal. checkStaleness
   * re-reads this list for exactly that reason.
   *
   * `name` is the transition's own label ("Start progress"), which is what a
   * person picking one reads; `group` is the DESTINATION status's category,
   * mapped to the same vocabulary a native state carries, so a caller can ask
   * "does this finish the ticket" without knowing one site's workflow.
   */
  async listTransitions(
    ref: string,
  ): Promise<{ id: string; name: string; group: string | undefined }[] | null> {
    const key = await this.resolveKey(ref);
    if (!key) return null;

    const result = await jiraGet<{ transitions?: unknown[] }>(
      this.credential,
      `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`,
    );
    if (!result.ok) {
      if (result.reason === 'not_found') return null;
      unavailable(result);
    }

    return (result.value?.transitions ?? [])
      .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
      .map((transition) => ({
        // Jira answers with a string id, but it is a number in its own
        // database and has been seen serialized both ways by proxies; String()
        // makes the comparison in checkStaleness total rather than lucky.
        id: String(transition.id ?? ''),
        name: str(transition.name),
        group: transitionGroup(transition),
      }))
      .filter((t) => t.id !== '');
  }

  /**
   * Applies one transition.
   *
   * Returns `{ ok: false }` rather than throwing for every outcome that is
   * about THIS issue and this account — a deleted issue, a transition that
   * stopped being legal, a permission the account does not have. All three
   * are things the reviewer can act on and none of them gets better by
   * retrying, so they finalize the proposal (stale, with Jira's own words)
   * instead of reverting it to a card that invites the same failing click
   * forever. Only a genuine outage — auth, rate limit, network, a site that
   * stopped resolving — throws, because that one IS worth retrying.
   */
  async applyTransition(
    ref: string,
    transitionId: string,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const key = await this.resolveKey(ref);
    if (!key) {
      return { ok: false, message: 'That Jira issue is no longer reachable from this workspace.' };
    }

    // 204 with an empty body on success — jiraPost returns that as ok with an
    // undefined value, which is why nothing here reads the result's value.
    const result = await jiraPost<void>(
      this.credential,
      `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`,
      { transition: { id: transitionId } },
    );
    if (result.ok) return { ok: true };
    // 'jira_error' is where an illegal transition lands: Jira answers 400 with
    // its own explanation ("Transition id 31 is not valid for issue ENG-4"),
    // which messageFromErrorBody has already lifted out for us — a better
    // sentence than anything this file could invent about someone else's
    // workflow.
    if (result.reason === 'not_found' || result.reason === 'forbidden' || result.reason === 'jira_error') {
      return { ok: false, message: result.message };
    }
    unavailable(result);
  }

  /**
   * Posts one comment, and returns the id Jira minted for it.
   *
   * The ADF document is built by the caller (lib/jira/adf.ts) rather than
   * here, so that the self-disclosure prefix is added at execute time from
   * the real acting account — the same rule the native comment path follows.
   * This function's job is transport, and it deliberately cannot construct a
   * body of its own.
   */
  async postComment(
    ref: string,
    adf: JiraAdfDoc,
  ): Promise<{ ok: true; commentId: string } | { ok: false; message: string } | null> {
    const key = await this.resolveKey(ref);
    if (!key) return null;

    const result = await jiraPost<{ id?: unknown }>(
      this.credential,
      `/rest/api/3/issue/${encodeURIComponent(key)}/comment`,
      { body: adf },
    );
    if (!result.ok) {
      if (result.reason === 'not_found') return null;
      // Same three reasons applyTransition treats as terminal, and for the
      // same reason: a reviewer can act on "you don't have comment
      // permission on this project" or "Jira rejected this comment body",
      // but retrying the identical request never fixes either — only a
      // genuine outage (auth, rate limit, network, a site that stopped
      // resolving) is worth surfacing as retryable via ProviderUnavailableError.
      if (result.reason === 'forbidden' || result.reason === 'jira_error') {
        return { ok: false, message: result.message };
      }
      unavailable(result);
    }
    return { ok: true, commentId: str(result.value?.id) };
  }

  /**
   * A tref handle → the issue key it stands for, or null.
   *
   * The same two-part guard getByRef applies, and for the same reason it
   * matters more here: a ref minted against a different site must not resolve
   * against this one. On a read that would return someone else's issue; on a
   * write it would CHANGE someone else's issue.
   */
  private async resolveKey(ref: string): Promise<string | null> {
    const row = await ticketRefs.findById(ref);
    if (!row || row.provider !== 'jira' || row.externalSite !== this.site) return null;
    return row.externalId;
  }

  private rememberInput(issue: JiraIssue, key: string): ticketRefs.RememberInput {
    return {
      provider: 'jira',
      site: this.site,
      externalId: key,
      identifier: key,
      title: str(issue.fields?.summary),
      url: issueUrl(this.site, key),
    };
  }

  private remember(issue: JiraIssue, key: string) {
    return ticketRefs.remember(this.rememberInput(issue, key));
  }
}

/**
 * The Jira provider for one request's borrowed credential, or null.
 *
 * The credential is a PARAMETER, not something this looks up: it belongs to
 * the request, arriving on a header from the desktop app that holds the one
 * persisted copy (see lib/jira/credentialHeader.ts). Nothing in this process
 * stores it, so there is nowhere for this to read it from — which is the
 * point, and also why this is now synchronous. Construction does no I/O; the
 * first network call happens when a tool actually asks for something.
 *
 * Null covers both "the request carried no credential" and "it carried one
 * this process refused to use" (malformed, or a site that does not normalize)
 * — the two are the same fact from here: there is no way to reach Jira.
 * Callers must read null as "Jira is off", never as "Jira had nothing", which
 * is the same distinction ProviderUnavailableError draws one level down.
 *
 * The return type is the concrete class rather than TicketProvider. That is a
 * type-only widening with no behavior change — JiraProvider still implements
 * TicketProvider, so every existing read caller is unaffected — and it exists
 * because the writes are deliberately NOT on the TicketProvider interface:
 * "a source of tickets" is a read abstraction the native provider also
 * satisfies, and putting listTransitions/applyTransition/postComment on it
 * would oblige the native provider to answer questions its own tickets do not
 * have (a Waypoint ticket has states, not transitions). A caller that needs a
 * Jira write asks for a Jira provider by name and gets a Jira-shaped API.
 */
export function getJiraProvider(credential: JiraCredential | null): JiraProvider | null {
  return credential ? new JiraProvider(credential) : null;
}
