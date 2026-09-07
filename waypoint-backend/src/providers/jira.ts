import { jiraGet, type JiraCredential, type JiraResult } from '../lib/jira/client.js';
import { adfToPlainText } from '../lib/jira/adf.js';
import * as ticketRefs from '../services/ticketRefs.service.js';
import {
  ProviderUnavailableError,
  type NormalizedComment,
  type NormalizedTicket,
  type SearchOptions,
  type TicketProvider,
} from './types.js';

/**
 * Jira Cloud, behind the TicketProvider interface.
 *
 * Read-only by construction: there is no write path here, and that is the
 * whole shape of this slice — proving Copilot can genuinely read a Jira
 * ticket before anything is allowed to change one.
 */

export const JIRA_REF_PREFIX = 'tref-';

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

function nested(fields: Record<string, unknown>, field: string, key: string): string {
  const value = fields[field];
  if (!value || typeof value !== 'object') return '';
  return str((value as Record<string, unknown>)[key]);
}

function issueUrl(site: string, key: string): string {
  return `https://${site}/browse/${encodeURIComponent(key)}`;
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

class JiraProvider implements TicketProvider {
  readonly kind = 'jira' as const;

  constructor(private readonly credential: JiraCredential) {}

  private get site() {
    return this.credential.site;
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

/** Whether a bare id names a ticket_refs row rather than a native ticket. */
export function isExternalRef(id: string): boolean {
  return id.startsWith(JIRA_REF_PREFIX);
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
 */
export function getJiraProvider(credential: JiraCredential | null): TicketProvider | null {
  return credential ? new JiraProvider(credential) : null;
}
