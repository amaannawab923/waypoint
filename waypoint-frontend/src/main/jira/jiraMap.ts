import type {
  JiraPriority,
  JiraPriorityOption,
  JiraStateCategory,
  JiraTicketRole,
  JiraWireAttachment,
  JiraWireComment,
  JiraWireTicket,
  JiraWireTransition,
  JiraWireTransitionField,
} from './jiraTypes';

// Pure translation between Jira Cloud's REST payloads and this app's wire
// shapes. Split out of jiraClient.ts deliberately: none of this needs a
// network, a credential, or Electron, so all of it is directly unit-testable
// against real captured response shapes — which matters more here than
// anywhere else in the feature, because these are the functions that decide
// what a ticket "is" when Jira's own answer is loosely typed.
//
// Everything below is defensive by construction. Jira's `fields` object is
// site-specific: custom field ids differ per site, half the fields are null on
// any given issue, and `*all` returns whatever that site happens to have. A
// missing field must degrade to a sensible empty value, never throw — one
// unusual issue must not take the whole list down with it.

// -----------------------------------------------------------------------
// Site hostname
// -----------------------------------------------------------------------

// Standard hostname shape, lowercased: labels of alphanumerics/hyphens, at
// least one dot, nothing longer than 253 characters.
const HOSTNAME_RE =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * Turns whatever a user types in the connect form into the one bare hostname
 * every request is then pinned to, or null if it can't be one.
 *
 * People type all of "waypoint123", "waypoint123.atlassian.net",
 * "https://waypoint123.atlassian.net/jira/software/projects/ENG" — all three
 * mean the same site, and asking someone to strip their own URL by hand is a
 * pointless failure mode.
 *
 * The rejections matter as much as the normalization: a value carrying
 * userinfo ("user@host", which would silently override the Basic-auth
 * identity) or an explicit port is refused outright rather than cleaned up,
 * because both are shapes a legitimate Jira Cloud site never has and both are
 * ways a mistyped or pasted value could aim a real API token somewhere the
 * user didn't mean. A bare word with no dot is the one convenience expansion,
 * since `.atlassian.net` is what every Jira Cloud site is under by default.
 */
export function normalizeJiraSite(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  let value = raw.trim().toLowerCase();
  if (!value) return null;
  value = value.replace(/^https?:\/\//, '');
  // Drop any path/query/fragment someone pasted along with the host.
  [value] = value.split(/[/?#]/);
  if (value.includes('@') || value.includes(':')) return null;
  if (value.endsWith('.')) value = value.slice(0, -1);
  if (!value) return null;
  if (!value.includes('.')) value = `${value}.atlassian.net`;
  return HOSTNAME_RE.test(value) ? value : null;
}

// -----------------------------------------------------------------------
// Atlassian Document Format → plain text
// -----------------------------------------------------------------------

const ADF_BLOCK_TYPES = new Set([
  'paragraph',
  'heading',
  'blockquote',
  'codeBlock',
  'listItem',
  'panel',
  'rule',
  'tableRow',
  'mediaSingle',
]);

/**
 * Flattens an ADF document to plain text.
 *
 * The v3 REST API returns `description` (and v3 comments) as an Atlassian
 * Document Format tree, not a string. This app renders ticket bodies as plain
 * text in a `whitespace-pre-wrap` block — so the alternative to flattening
 * here would be either rendering `[object Object]` or introducing this
 * codebase's first innerHTML surface to display `expand=renderedFields`'s
 * HTML, which is not a trade worth making to show a ticket description
 * (JiraCommentComposer.tsx already made the same call for the same reason).
 *
 * Rich structure is genuinely lost — tables become their cell text, code
 * blocks lose their fencing. That's the honest consequence of a plain-text
 * surface, and the Connection tab already says rich text isn't built.
 */
export function adfToPlainText(node: unknown): string {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(adfToPlainText).join('');
  if (typeof node !== 'object') return '';

  const record = node as Record<string, unknown>;
  const type = typeof record.type === 'string' ? record.type : '';

  if (type === 'text' && typeof record.text === 'string') return record.text;
  if (type === 'hardBreak') return '\n';
  // A mention's own rendered label, e.g. "@Priya Raman" — the accountId in
  // attrs is deliberately not surfaced.
  if (type === 'mention') {
    const attrs = record.attrs as Record<string, unknown> | undefined;
    return typeof attrs?.text === 'string' ? attrs.text : '';
  }
  if (type === 'emoji') {
    const attrs = record.attrs as Record<string, unknown> | undefined;
    if (typeof attrs?.text === 'string') return attrs.text;
    return typeof attrs?.shortName === 'string' ? attrs.shortName : '';
  }

  const inner = adfToPlainText(record.content);
  return ADF_BLOCK_TYPES.has(type) ? `${inner}\n` : inner;
}

/** Collapses the trailing/duplicated newlines block flattening leaves behind,
 * so a description doesn't render with a ragged tail of blank lines. */
export function tidyPlainText(text: string): string {
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

// -----------------------------------------------------------------------
// Legacy wiki markup → plain text
// -----------------------------------------------------------------------

/**
 * Flattens Jira's legacy wiki markup to plain text.
 *
 * This is a safety net, not the mechanism. The real fix for a leaked
 * `[~accountid:...]` is that comments are read through v3, which returns ADF
 * (see jiraClient.ts) — `adfToPlainText` handles a mention node properly and
 * has always done so. But a string body is still a shape this app can be
 * handed: an intermediary proxy, an older API version, or a revert of that
 * endpoint switch all put one back on screen. Before this existed, the string
 * branch of `mapComment` returned the body completely unprocessed, so
 * whatever markup Jira flattened into it was rendered verbatim.
 *
 * Deliberately modest in scope. It covers the markers that show up in a
 * flattened comment and nothing more; it is not a wiki-markup parser, and it
 * does not try to reconstruct structure (bullets become plain lines) on a
 * plain-text surface that could not render it anyway.
 *
 * `resolveMentionName` is a seam for a future live account lookup. Nothing
 * passes one today — on this fallback path a mention becomes "@a teammate",
 * which is vague but true. The one thing that must never happen, with or
 * without a resolver, is the raw account id reaching the screen.
 */
export function wikiMarkupToPlainText(
  raw: string,
  resolveMentionName?: (accountId: string) => string | null,
): string {
  if (typeof raw !== 'string' || !raw) return '';

  let text = raw;

  // Mentions first, before any bracket-based rule: an account id is
  // structured data that must be consumed here rather than left for a later
  // pass to mangle into something that still contains it.
  text = text.replace(/\[~accountid:([^\]]+)\]/g, (_match, accountId) => {
    const name = resolveMentionName?.(String(accountId)) ?? null;
    return `@${name && name.trim() ? name.trim() : 'a teammate'}`;
  });

  // Block macros: keep the content, drop the markers.
  text = text.replace(/\{noformat\}([\s\S]*?)\{noformat\}/g, '$1');
  text = text.replace(/\{code(?::[^}\n]*)?\}([\s\S]*?)\{code\}/g, '$1');
  text = text.replace(/\{quote\}([\s\S]*?)\{quote\}/g, '$1');

  // Line-level rules run before inline ones, and the order is load-bearing:
  // a `*` at the start of a line is a bullet, while `*text*` mid-line is
  // bold. Running the inline bold rule first would consume the bullet marker
  // as an opening delimiter and corrupt both.
  text = text.replace(/^[ \t]*h[1-6]\.[ \t]*/gm, '');
  text = text.replace(/^[ \t]*[*#]{1,4}[ \t]+/gm, '');

  // Inline markers.
  text = text.replace(/\*([^*\n]+)\*/g, '$1');
  // Underscores are guarded by non-word boundaries on both sides, unlike the
  // other inline rules: `snake_case_identifiers` are ordinary content in a
  // developer's comment, and an unguarded rule silently eats their
  // underscores.
  text = text.replace(/(^|[^\w])_([^_\n]+)_(?=$|[^\w])/g, '$1$2');
  text = text.replace(/\{\{([^}\n]*)\}\}/g, '$1');
  text = text.replace(/\[([^\]|\n]+)\|([^\]\n]+)\]/g, '$1 ($2)');
  text = text.replace(/!([^!\s|]+)(?:\|[^!\n]*)?!/g, '[image: $1]');

  // `-strikethrough-` and `~subscript~` are deliberately left alone: hyphens
  // and tildes are ordinary characters in ordinary prose (date ranges,
  // hyphenated words, approximations), so the false-positive rate of
  // stripping them would do more damage than an occasional stray marker.

  return tidyPlainText(text);
}

// -----------------------------------------------------------------------
// Scalar mappings
// -----------------------------------------------------------------------

/** Jira's `statusCategory.key` is the only status property that means the
 * same thing on every site — status *names* are per-workflow and unbounded
 * ("Ready for QA", "Blocked"), so grouping by name would be guesswork. */
export function mapStateCategory(raw: unknown): JiraStateCategory {
  const key = typeof raw === 'string' ? raw.toLowerCase() : '';
  if (key === 'done') return 'done';
  if (key === 'indeterminate') return 'in-progress';
  return 'todo';
}

// Jira's default scheme is Highest/High/Medium/Low/Lowest, but plenty of
// sites use the older Blocker/Critical/Major/Minor/Trivial set or a custom
// one. Both standard sets are mapped; anything unrecognized reports 'none'
// rather than being forced into a bucket it might not belong in.
const PRIORITY_BY_NAME: Record<string, JiraPriority> = {
  highest: 'urgent',
  blocker: 'urgent',
  critical: 'urgent',
  high: 'high',
  major: 'high',
  medium: 'medium',
  normal: 'medium',
  low: 'low',
  minor: 'low',
  lowest: 'low',
  trivial: 'low',
  none: 'none',
};

export function mapPriority(raw: unknown): JiraPriority {
  const name = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return PRIORITY_BY_NAME[name] ?? 'none';
}

export function formatFileSize(bytes: unknown): string {
  const size = typeof bytes === 'number' && Number.isFinite(bytes) ? bytes : 0;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

// -----------------------------------------------------------------------
// Transitions
// -----------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

/** The display string for one of a field's allowedValues. Jira is not
 * consistent about which property carries it — a resolution uses `name`, a
 * custom select uses `value`, some carry `label` — so all three are tried. */
function allowedValueLabel(entry: unknown): string | null {
  const record = asRecord(entry);
  const candidate = ['value', 'name', 'label']
    .map((key) => record[key])
    .find((v): v is string => typeof v === 'string' && v.length > 0);
  return candidate ?? null;
}

/** A transition field's declared type — "resolution", "timetracking",
 * "string", "array" — or '' when the site didn't declare one. */
function schemaTypeOf(meta: Record<string, unknown>): string {
  const { type } = asRecord(meta.schema);
  return typeof type === 'string' ? type : '';
}

function mapTransitionField(
  fieldId: string,
  meta: Record<string, unknown>,
): JiraWireTransitionField | null {
  const required = meta.required === true;
  const schemaType = schemaTypeOf(meta);
  // Optional fields are dropped — a transition screen can carry a dozen of
  // them and this popover is not a full issue editor. Time tracking is the
  // one exception: it's the common "log your time on the way out" field, and
  // the popover already models an optional field with a hint, so offering it
  // costs nothing and skipping it would quietly lose data the user meant to
  // record.
  if (!required && schemaType !== 'timetracking') return null;

  const allowedValues = Array.isArray(meta.allowedValues)
    ? meta.allowedValues
    : [];
  const options = allowedValues
    .map(allowedValueLabel)
    .filter((label): label is string => label !== null);

  return {
    key: fieldId,
    label: typeof meta.name === 'string' && meta.name ? meta.name : fieldId,
    type: options.length > 0 ? 'select' : 'text',
    required,
    ...(options.length > 0 ? { options } : {}),
    ...(schemaType === 'timetracking' && !required
      ? { hint: 'Optional on this workflow.' }
      : {}),
  };
}

/** The status a transition leads to, falling back to the transition's own name
 * (which is usually the same word) and finally to a placeholder — a menu entry
 * with no legible destination is worse than one labelled "Unknown". */
function transitionTargetName(
  to: Record<string, unknown>,
  record: Record<string, unknown>,
): string {
  if (typeof to.name === 'string' && to.name) return to.name;
  if (typeof record.name === 'string' && record.name) return record.name;
  return 'Unknown';
}

export function mapTransition(raw: unknown): JiraWireTransition | null {
  const record = asRecord(raw);
  const { id } = record;
  if (typeof id !== 'string' && typeof id !== 'number') return null;

  const to = asRecord(record.to);
  const fields = asRecord(record.fields);
  const requiresFields = Object.entries(fields)
    .map(([fieldId, meta]) => mapTransitionField(fieldId, asRecord(meta)))
    .filter((field): field is JiraWireTransitionField => field !== null);

  return {
    id: String(id),
    targetStateName: transitionTargetName(to, record),
    targetStateCategory: mapStateCategory(
      asRecord(to.statusCategory).key ?? undefined,
    ),
    requiresFields,
  };
}

export function mapTransitions(raw: unknown): JiraWireTransition[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(mapTransition)
    .filter((t): t is JiraWireTransition => t !== null);
}

/**
 * Turns the popover's `{ fieldKey: "display string" }` into the shape Jira's
 * transition endpoint actually accepts, using that transition's OWN field
 * metadata as the source of truth.
 *
 * This is why jiraClient.ts re-reads the transition list immediately before
 * writing rather than trusting what the renderer holds: a select's value
 * arrives here as the human-readable label ("Won't Do"), and only the live
 * `allowedValues` know that label's real id. Sending `{ name }` blind works
 * for stock resolutions and silently 400s for anything a site has renamed;
 * resolving against allowedValues and falling back to `{ name }` only when
 * there's genuinely no match gets both cases right.
 *
 * A value with no matching field metadata is dropped rather than passed
 * through — an unknown key on a transition screen is a guaranteed 400 from
 * Jira, and if the field was genuinely required its absence produces a much
 * clearer error from Jira than a rejected unknown field would.
 */
/** One field's value in Jira's own shape, or `undefined` for "don't send
 * this at all" — separated out so the outer function is a plain map/filter
 * rather than a ladder of early exits. */
function transitionFieldPayload(
  meta: Record<string, unknown>,
  value: string,
): unknown {
  const schemaType = schemaTypeOf(meta);

  if (schemaType === 'timetracking') return { timeSpent: value };

  const allowedValues = Array.isArray(meta.allowedValues)
    ? meta.allowedValues
    : [];
  const match = allowedValues.find(
    (entry) => allowedValueLabel(entry)?.toLowerCase() === value.toLowerCase(),
  );
  if (match) {
    const { id } = asRecord(match);
    const resolved = id === undefined ? { name: value } : { id: String(id) };
    return schemaType === 'array' ? [resolved] : resolved;
  }

  if (schemaType === 'number') {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : undefined;
  }
  if (allowedValues.length > 0) {
    // A select whose chosen label isn't in the live allowedValues any more —
    // send it by name and let Jira be the one to reject it, rather than
    // silently dropping a field the user explicitly filled in.
    return schemaType === 'array' ? [{ name: value }] : { name: value };
  }
  return value;
}

export function buildTransitionFieldsPayload(
  transitionRaw: unknown,
  fieldValues: Record<string, string>,
): Record<string, unknown> {
  const fields = asRecord(asRecord(transitionRaw).fields);

  return Object.entries(fieldValues).reduce<Record<string, unknown>>(
    (payload, [key, rawValue]) => {
      const value = typeof rawValue === 'string' ? rawValue.trim() : '';
      // A blank value, or a key this transition screen doesn't have, is
      // dropped: an unknown field on a transition is a guaranteed 400 from
      // Jira, and a genuinely required field's absence produces a far clearer
      // message from Jira than a rejected unknown one would.
      if (!value || !fields[key]) return payload;
      const resolved = transitionFieldPayload(asRecord(fields[key]), value);
      return resolved === undefined ? payload : { ...payload, [key]: resolved };
    },
    {},
  );
}

// -----------------------------------------------------------------------
// Priority
// -----------------------------------------------------------------------

/**
 * The priorities a site actually offers *on one specific issue*, read out of
 * that issue's `/editmeta`.
 *
 * Per-issue, not global, and that is the whole reason this reads editmeta
 * rather than `/rest/api/3/priority`: Jira lets an admin attach a different
 * priority scheme to each project, so the global list is a superset that can
 * contain values this issue would 400 on. Editmeta is the same
 * ask-the-site-what-is-legal-right-now principle `mapTransition` and
 * `buildTransitionFieldsPayload` already work on.
 *
 * An editmeta with no `fields.priority` at all is a real and unremarkable
 * answer — it means priority is not editable on this issue type, or by this
 * user — and it produces an empty array here rather than anything error-
 * shaped. Callers render that as "no options", the same way a workflow with
 * no legal moves renders as "no transitions".
 *
 * An entry with no usable id is dropped: an option the picker cannot write
 * back is worse than one that isn't offered, since the only thing it could do
 * is fail on click.
 */
export function mapPriorityOptions(editmeta: unknown): JiraPriorityOption[] {
  const field = asRecord(asRecord(asRecord(editmeta).fields).priority);
  const allowedValues = Array.isArray(field.allowedValues)
    ? field.allowedValues
    : [];

  return allowedValues
    .map((entry): JiraPriorityOption | null => {
      const { id } = asRecord(entry);
      if (typeof id !== 'string' && typeof id !== 'number') return null;
      const name = allowedValueLabel(entry);
      // A nameless option still gets offered, labelled by its id: it is a real
      // priority this issue accepts, and hiding it would be this app deciding
      // the user may not pick something their Jira allows.
      return { id: String(id), name: name ?? String(id) };
    })
    .filter((option): option is JiraPriorityOption => option !== null);
}

// -----------------------------------------------------------------------
// Issues
// -----------------------------------------------------------------------

function accountIdOf(value: unknown): string | null {
  const id = asRecord(value).accountId;
  return typeof id === 'string' ? id : null;
}

function displayNameOf(value: unknown, fallback: string): string {
  const name = asRecord(value).displayName;
  return typeof name === 'string' && name ? name : fallback;
}

/**
 * Which of the three "this is mine" reasons put this issue in the user's
 * queue. The JQL matches on assignee OR reporter OR watcher, and a person is
 * frequently more than one of them at once, so this picks the strongest claim
 * — the same single-role-per-row model the UI already renders.
 *
 * The last two branches are the ones worth explaining. This used to fall
 * through to 'watcher' unconditionally, which was an inference from the query
 * rather than a reading of the issue: if something is in the my-work queue and
 * it is not yours by assignee or reporter, watching is the only reason left.
 * That inference is sound for an issue the search returned, and it is why an
 * absent `watches` still resolves to 'watcher' below — a project's permission
 * scheme can hide `assignee`/`reporter` from a payload, and a trimmed or
 * proxied response can drop `watches` entirely, and in neither case does this
 * function know better than the query that put the issue on screen.
 *
 * What the inference cannot survive is `mapIssue` being reached any other way,
 * and it routinely is: every write here re-reads its issue through
 * `getTicket`, which runs no JQL at all. A ticket just reassigned away from
 * you — where you are genuinely not the assignee, not the reporter and not a
 * watcher — came back through this function with nothing left to claim, and
 * the old fallback labelled it "watching" anyway. Jira answers that question
 * outright: `fields.watches.isWatching` is exactly that boolean, for the
 * calling user. When it positively says false, all three roles have been ruled
 * out and the honest answer is 'none'.
 */
function roleOf(
  fields: Record<string, unknown>,
  myAccountId: string,
): JiraTicketRole {
  if (accountIdOf(fields.assignee) === myAccountId) return 'assignee';
  if (accountIdOf(fields.reporter) === myAccountId) return 'reporter';
  // Only an explicit `false` rules watching out. `undefined` means this
  // payload did not say, which is a different answer and must not be read as
  // one — that path keeps the JQL inference described above.
  if (asRecord(fields.watches).isWatching === false) return 'none';
  return 'watcher';
}

/**
 * Finds a field by its human-readable name, using the `names` map the
 * `expand=names` parameter returns alongside the issues.
 *
 * Story points and sprint live in per-site custom fields — `customfield_10016`
 * is only the *usual* Cloud default for story points, not a guarantee, and
 * hardcoding an id would silently show the wrong number (or nothing) on any
 * site that differs. Matching on the displayed field name is what makes this
 * work on a site we've never seen.
 */
function findNamedField(
  fields: Record<string, unknown>,
  names: Record<string, string>,
  pattern: RegExp,
): unknown {
  const match = Object.entries(names).find(
    ([fieldId, label]) => pattern.test(label) && fields[fieldId] != null,
  );
  return match ? fields[match[0]] : undefined;
}

/**
 * Whether a `fields.parent.fields.issuetype` describes an epic.
 *
 * Two signals, because neither alone is portable: `hierarchyLevel` is the
 * structural one (0 is a standard issue, 1 is an epic, sub-tasks are -1) but
 * isn't returned by every site or API version, and `name` is always there but
 * is renameable per site ("Initiative", a localized label). Positive on
 * either.
 *
 * Absence is deliberately treated as "yes": every other field in this mapper
 * degrades toward what the caller had before, and a parent with no issuetype
 * at all is far more likely to be a trimmed payload for a story under an epic
 * — the case that already worked — than a sub-task. The lie this exists to
 * stop needs a parent that positively says it is something else.
 */
function isEpicIssueType(value: unknown): boolean {
  const issueType = asRecord(value);
  if (Object.keys(issueType).length === 0) return true;
  const { hierarchyLevel, name } = issueType;
  if (typeof hierarchyLevel === 'number') return hierarchyLevel >= 1;
  if (typeof name === 'string') return name.trim().toLowerCase() === 'epic';
  return true;
}

function sprintNameOf(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  // An issue can sit in several sprints (a carried-over ticket); the active
  // one is what the user means by "the sprint", falling back to the last
  // listed when none is active.
  const active = value.find((entry) => asRecord(entry).state === 'active');
  const chosen = asRecord(active ?? value[value.length - 1]);
  return typeof chosen.name === 'string' ? chosen.name : null;
}

function mapAttachments(value: unknown): JiraWireAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const record = asRecord(entry);
    return {
      fileName:
        typeof record.filename === 'string' ? record.filename : 'attachment',
      sizeLabel: formatFileSize(record.size),
      uploaderName: displayNameOf(record.author, 'Someone'),
    };
  });
}

export function mapIssue(
  raw: unknown,
  myAccountId: string,
  names: Record<string, string> = {},
): JiraWireTicket | null {
  const issue = asRecord(raw);
  const key = typeof issue.key === 'string' ? issue.key : null;
  if (!key) return null;
  const fields = asRecord(issue.fields);
  const status = asRecord(fields.status);

  // The epic an issue belongs to is `parent` on a modern Cloud site and a
  // named custom field on an older one; both are checked, parent first —
  // but only when the parent is actually an epic. For a sub-task,
  // `fields.parent` is the parent *story*, and taking it unconditionally
  // meant the drawer labelled that story "Epic". The value was right; the
  // label was a lie, on any team that uses sub-tasks. When the parent isn't
  // an epic this falls through to the Epic Link custom field, which on many
  // sites still resolves the sub-task's real epic — and when that's absent
  // too, no chip is rendered rather than a wrong one.
  const parentFields = asRecord(asRecord(fields.parent).fields);
  const parentSummary = isEpicIssueType(parentFields.issuetype)
    ? parentFields.summary
    : undefined;
  const epicFromName = findNamedField(fields, names, /^epic (link|name)$/i);
  const epicName =
    typeof parentSummary === 'string' ? parentSummary : epicFromName;
  const storyPointsRaw = findNamedField(fields, names, /^story point/i);
  const sprintRaw = findNamedField(fields, names, /^sprint$/i);
  const projectKey = asRecord(fields.project).key;
  // Both the normalized bucket AND the site's own id/name. The bucket is what
  // PriorityIcon draws; the id is the only thing a priority *write* can be
  // built from, because "urgent" is this app's word and no site has a
  // priority by that name.
  const priority = asRecord(fields.priority);

  return {
    id: typeof issue.id === 'string' ? issue.id : key,
    key,
    // The key's own prefix is the fallback: an issue key is always
    // PROJECT-NUMBER, so it carries the project key even if `fields.project`
    // was not returned.
    projectKey: typeof projectKey === 'string' ? projectKey : key.split('-')[0],
    title: typeof fields.summary === 'string' ? fields.summary : key,
    role: roleOf(fields, myAccountId),
    stateName: typeof status.name === 'string' ? status.name : 'Unknown',
    stateCategory: mapStateCategory(asRecord(status.statusCategory).key),
    priority: mapPriority(priority.name),
    // Jira returns the id as a string on every current API version, but it is
    // a number in enough older/proxied payloads to be worth coercing rather
    // than silently dropping.
    priorityId:
      typeof priority.id === 'string' || typeof priority.id === 'number'
        ? String(priority.id)
        : null,
    priorityName:
      typeof priority.name === 'string' && priority.name
        ? priority.name
        : 'None',
    assigneeName: displayNameOf(fields.assignee, 'Unassigned'),
    // Carried alongside the name for the same reason priorityId is carried
    // alongside priorityName: a display string cannot be written back, and
    // "Unassigned" is this app's fallback word rather than something Jira
    // returned — the id is the only thing that says which of those two an
    // issue actually is.
    assigneeAccountId: accountIdOf(fields.assignee),
    reporterName: displayNameOf(fields.reporter, 'Unknown'),
    description: tidyPlainText(adfToPlainText(fields.description)),
    epicName: typeof epicName === 'string' ? epicName : null,
    storyPoints:
      typeof storyPointsRaw === 'number' && Number.isFinite(storyPointsRaw)
        ? storyPointsRaw
        : null,
    sprintName: sprintNameOf(sprintRaw),
    attachments: mapAttachments(fields.attachment),
    transitions: mapTransitions(issue.transitions),
    updatedAt:
      typeof fields.updated === 'string'
        ? fields.updated
        : new Date().toISOString(),
  };
}

/** Comments are read through v3 and written through v2 (see jiraClient.ts),
 * so both body shapes are real here and both are flattened: an ADF tree from
 * a read, a plain string from a freshly posted comment echoed back. The
 * string branch runs the wiki-markup pass rather than passing the body
 * through untouched — a v2-shaped body is legacy markup, not plain text, and
 * rendering it verbatim is what leaked a raw `[~accountid:...]` on screen. */
export function mapComment(
  raw: unknown,
  ticketId: string,
): JiraWireComment | null {
  const record = asRecord(raw);
  const { id } = record;
  if (typeof id !== 'string' && typeof id !== 'number') return null;
  return {
    id: String(id),
    ticketId,
    authorName: displayNameOf(record.author, 'Unknown'),
    body:
      typeof record.body === 'string'
        ? wikiMarkupToPlainText(record.body)
        : tidyPlainText(adfToPlainText(record.body)),
    createdAt:
      typeof record.created === 'string'
        ? record.created
        : new Date().toISOString(),
  };
}
