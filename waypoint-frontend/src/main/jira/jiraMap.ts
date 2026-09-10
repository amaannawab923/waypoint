import type {
  JiraPriority,
  JiraPriorityOption,
  JiraStateCategory,
  JiraTicketRole,
  JiraWireAttachment,
  JiraWireComment,
  JiraWireIssueLink,
  JiraWireSubtask,
  JiraWireTicket,
  JiraWireTransition,
  JiraWireTransitionField,
  JiraWireUser,
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
  // Jira's "Action items" checklist. Its items are line-level exactly like
  // listItem, and leaving them out ran a whole checklist together as one
  // unbroken sentence — "buy milkbuy eggs" — which is not lost formatting but
  // lost meaning: acceptance criteria stop being separate criteria.
  'taskItem',
  // Jira's own node index documents `blockTaskItem`, not `taskItem`. The
  // editor emits taskItem, so both are listed rather than betting on one:
  // getting this wrong reproduces the exact run-together defect the taskItem
  // entry above exists to fix.
  'blockTaskItem',
  'decisionItem',
  // NOTE what is deliberately NOT here: blockCard, embedCard, expand,
  // nestedExpand and media. Each is handled as a leaf below and RETURNS
  // before this set is ever consulted, so listing them would be dead weight
  // that misinforms the next reader about where their newline comes from —
  // it comes from the explicit `\n` in their own branch. An earlier version
  // listed them here with a comment claiming the early return was the reason
  // to list them, which is exactly backwards.
  //
  // mediaSingle and mediaGroup are likewise absent: they are containers, and
  // their `media` children now terminate their own lines. Leaving mediaSingle
  // here would put a blank line after every image.
  'panel',
  'rule',
  'tableRow',
]);

/** Reads one string attr, the shape almost every leaf node here needs. */
function attrString(record: Record<string, unknown>, key: string): string {
  const attrs = record.attrs as Record<string, unknown> | undefined;
  const value = attrs?.[key];
  return typeof value === 'string' ? value : '';
}

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
/** A card's visible text. `data` OR `url`, never both, per Atlassian — and
 *  the `data` variant is a JSON-LD object whose `url` (or failing that,
 *  `name`) is the part a reader needs. */
function cardText(record: Record<string, unknown>): string {
  const direct = attrString(record, 'url');
  if (direct) return direct;
  const attrs = record.attrs as Record<string, unknown> | undefined;
  const data = attrs?.data;
  if (!data || typeof data !== 'object') return '';
  const asRec = data as Record<string, unknown>;
  const url = typeof asRec.url === 'string' ? asRec.url : '';
  if (url) return url;
  return typeof asRec.name === 'string' ? asRec.name : '';
}

/**
 * An ADF date node's calendar date, or '' when it is not one.
 *
 * Three guards, each for a wrong answer the previous version gave:
 *
 *  - `.trim()` before the emptiness check. `Number('   ')` is 0, so a
 *    whitespace-only timestamp rendered 1970-01-01 — precisely the
 *    "confident wrong answer" the old comment claimed to prevent.
 *  - digits only. `Number('0x1000')` is 4096, and hex is not a timestamp.
 *  - a RANGE check, not just `Number.isFinite`. JavaScript's Date tops out
 *    at +/-8.64e15 ms and `toISOString()` THROWS past it, so a nanosecond
 *    timestamp (a realistic mistake for an integration) threw out of
 *    mapIssue. getTicket and listComments do not wrap their mapping, so that
 *    escaped ipcMain.handle and rejected the IPC call instead of returning a
 *    JiraResult failure — one bad node blanking a whole ticket or thread.
 *    This file's contract is that a malformed field degrades, never throws.
 *
 * UTC slicing is deliberate and correct: Jira stores the picked calendar day
 * as UTC midnight and reads it back with getUTC*, so slicing in UTC is the
 * matching reader. Using local getters would shift the day for every viewer
 * west of Greenwich.
 */
const MAX_TIMESTAMP_MS = 8.64e15;

/** Below this, a value cannot be a millisecond timestamp for any date after
 *  1973, and is comfortably a seconds timestamp for any date before 5138. */
const SECONDS_EPOCH_CEILING = 1e11;

function dateText(rawTimestamp: string): string {
  const raw = rawTimestamp.trim();
  if (!/^-?\d+$/.test(raw)) return '';
  const parsed = Number(raw);
  if (Math.abs(parsed) > MAX_TIMESTAMP_MS) return '';
  // Seconds or milliseconds. The editor writes milliseconds, but Atlassian's
  // own published example for this node is `"1582152559"` — ten digits,
  // SECONDS — so any producer following the documentation literally rendered
  // every date as some day in January 1970 (that value read as ms is
  // 1970-01-19). Magnitude tells the two apart unambiguously in the range
  // that matters: a millisecond timestamp for any date after 1973 exceeds
  // 1e11, and a seconds timestamp does not reach 1e11 until the year 5138.
  // Anything below the threshold is therefore seconds, whichever way you
  // read it.
  const timestamp =
    Math.abs(parsed) < SECONDS_EPOCH_CEILING ? parsed * 1000 : parsed;
  if (Math.abs(timestamp) > MAX_TIMESTAMP_MS) return '';
  const iso = new Date(timestamp).toISOString();
  // The range check alone stops the THROW but not the wrong answer. Outside
  // years 1000-9999 ISO 8601 switches to the expanded form
  // ("+010000-01-01T00:00:00.000Z"), and slicing ten characters off that
  // yields "+010000-01" — a string with no day in it. A microsecond epoch
  // (the same units mistake as nanoseconds, one order down) lands inside the
  // accepted range and rendered exactly that into a description. Testing the
  // shape of the output is stricter than any numeric bound and needs no
  // magic constant for the year-9999 boundary.
  if (!/^\d{4}-\d{2}-\d{2}T/.test(iso)) return '';
  // Date only, no time: an ADF date node carries no time of day, so
  // rendering one would invent precision the source does not have.
  return iso.slice(0, 10);
}

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
  // Leaf nodes that carry their whole content in attrs and have no `content`
  // array. Falling through to the generic branch below returned '' for each
  // of them, which is content loss rather than lost formatting: Jira
  // auto-converts a pasted Jira or Confluence link into an inlineCard, so a
  // description consisting of one pasted link rendered completely empty.
  if (type === 'inlineCard' || type === 'blockCard' || type === 'embedCard') {
    // `data` OR `url`, never both — Atlassian's own wording. Reading only
    // `url` left the `data` variant rendering empty, which is the very
    // symptom this branch was added to fix.
    const text = cardText(record);
    // A block card ends its line; an inline one does not. Without this the
    // URL glues to the next paragraph — "…/pages/12345The API returns 500" —
    // which is the run-together defect `taskItem` was added to fix, shipped
    // again one branch below it.
    return type === 'inlineCard' ? text : `${text}\n`;
  }
  // An image contributes exactly one thing to a plain-text surface: its alt
  // text. Without this a description that is one screenshot — a common way to
  // file a bug — rendered completely blank, which is the same content loss as
  // the pasted-link case above rather than the formatting loss this file's
  // disclaimer covers. `media` is the node inside a mediaSingle/mediaGroup
  // wrapper; `mediaInline` is the inline spelling. Both are silent when the
  // uploader gave no alt, because inventing a filename would be worse than
  // saying nothing.
  if (type === 'media' || type === 'mediaInline') {
    const alt = attrString(record, 'alt');
    if (!alt) return '';
    // The image ends its own line, rather than relying on a wrapper to do it.
    // Relying on the wrapper is what broke the first version: only
    // `mediaSingle` was in the block set, so a `mediaGroup` — what the editor
    // emits for MORE than one attachment — ran every alt into the next and
    // then into the following paragraph ("error toastnetwork tabRepro on
    // staging only"). That is the same run-together defect `taskItem` and
    // `blockCard` are both here to prevent, shipped a third time. An inline
    // image is inline, so it does not.
    return type === 'mediaInline' ? alt : `${alt}\n`;
  }
  // A status lozenge ("BLOCKED") and an inline date are both words a reader
  // needs; both vanished entirely.
  if (type === 'status') return attrString(record, 'text');
  if (type === 'date') return dateText(attrString(record, 'timestamp'));
  if (type === 'expand' || type === 'nestedExpand') {
    // The title is dropped by the generic path because it lives in attrs, not
    // content. It is usually the heading its content sits under ("Acceptance
    // criteria"), so losing it loses the label rather than the formatting.
    const title = attrString(record, 'title');
    const inner = adfToPlainText(record.content);
    const body = title ? `${title}\n${inner}` : inner;
    // Its own trailing newline, for the same reason as the cards above: this
    // branch returns before the block set is consulted. It happened to look
    // right only because an expand's children are usually paragraphs, which
    // bring their own — luck, not a guard, and it failed the moment the child
    // was a bare text node or a media group.
    return body.endsWith('\n') ? body : `${body}\n`;
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
  // `accountid:` is optional. Server-era markup and Server->Cloud migrated
  // bodies carry the bare `[~<id>]` form, and on migrated Cloud data that id
  // is frequently the account id itself — so the narrower pattern let through
  // exactly the string this function exists to stop, and no later rule caught
  // it either (the link rule needs a `|`).
  text = text.replace(
    /\[~(?:accountid:)?([^\]\s]+)\]/g,
    (_match, accountId) => {
      const name = resolveMentionName?.(String(accountId)) ?? null;
      return `@${name && name.trim() ? name.trim() : 'a teammate'}`;
    },
  );

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

/**
 * A Jira body field as display text, whichever of the two shapes it arrives
 * in. Extracted so a description and a comment cannot drift apart again: the
 * string branch is the wiki-markup floor, the object branch is real ADF.
 */
export function plainTextFromJiraBody(body: unknown): string {
  return typeof body === 'string'
    ? wikiMarkupToPlainText(body)
    : tidyPlainText(adfToPlainText(body));
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
  // one exception, because updating the remaining estimate on the way out of
  // a state is the common case and the popover already models an optional
  // field with a hint.
  //
  // This is the estimate field, NOT "log your time on the way out", which is
  // what this comment used to claim. Logging work is Jira's `worklog` field
  // (schema type `array` of `worklog`), written through `update` rather than
  // `fields`; being an array it is not `timetracking`, so when it is optional
  // the line below drops it and when it is required the transition fails with
  // Jira's own message. Neither outcome is silent, which is the point.
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

  // `remainingEstimate`, not `timeSpent`. Jira's TimeTrackingJsonBean — the
  // shape `fields.timetracking` accepts — has exactly two members,
  // `originalEstimate` and `remainingEstimate`. `timeSpent` is not one of
  // them: logging work is a different field entirely (`worklog`, written as
  // `update: { worklog: [{ add: { timeSpent } }] }`, not through `fields` at
  // all). Sending it here meant the value was either rejected outright or,
  // worse, accepted-and-ignored — the transition succeeded, the re-read came
  // back clean, and the user believed they had logged time against an issue
  // that has no worklog entry.
  //
  // Of the two members this field really has, the remaining estimate is the
  // one a transition screen exists to update ("how much is left on this?"),
  // and it is the one that leaves an untouched original estimate intact.
  // Logging work is deliberately still not supported; see the caller's
  // comment, which no longer claims otherwise.
  if (schemaType === 'timetracking') return { remainingEstimate: value };

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

/**
 * A Jira id as a string, whether it arrived as one or as a number.
 *
 * `isSafeInteger` and `> 0`, not `isFinite`. The looser check accepted
 * floats, negatives and zero, which made this strictly WORSE than the
 * fallback it replaced: `id: 1.5` used to degrade to the issue key, which
 * works as `issueIdOrKey` in every Jira URL, and instead became the literal
 * "1.5" — and since ticket.id keys every subsequent write, that turns a
 * graceful degradation into a 404 on the next transition or comment.
 *
 * The SAME rule applies to strings, which is where it actually matters: Jira
 * returns ids as strings on every current API version, so a version that
 * validated only the number branch was validating the shape that almost never
 * arrives. A string that looks numeric must be a positive integer; one that
 * does not look numeric at all passes through, since this cannot know what a
 * future or proxied id may legitimately look like.
 *
 * Precision beyond MAX_SAFE_INTEGER is not something this can fix: JSON.parse
 * has already rounded such a value before it arrives. A long digit STRING
 * passes through exactly, which is the shape that preserves it.
 */
const NUMERIC_SHAPED = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

function idOf(raw: unknown): string | null {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (!NUMERIC_SHAPED.test(trimmed)) return trimmed;
    return /^\d+$/.test(trimmed) && trimmed !== '0'.repeat(trimmed.length)
      ? trimmed
      : null;
  }
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0) {
    return String(raw);
  }
  return null;
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
      // `hasOwnProperty.call`, not a bare `fields[key]`. The bracket read
      // walks the prototype chain, so `constructor`, `__proto__`, `toString`,
      // `valueOf`, `hasOwnProperty` and `isPrototypeOf` were all truthy and
      // sailed past this guard — `{ constructor: "x" }` reached Jira as
      // `{"fields":{"constructor":"x"}}`, a guaranteed 400 that the comment
      // above says cannot happen. (No prototype pollution was possible: the
      // accumulator uses a computed key in an object literal, which defines
      // an own property. The defect was a false guard, not a write primitive.)
      // Both halves matter. `hasOwnProperty.call` is the prototype-chain fix;
      // the `fields[key]` truthiness check is kept because the bare bracket
      // read was also doing a second job — rejecting an OWN key whose
      // metadata is falsy. Dropping it let `{ customfield_1: null }` through
      // as a raw unschema'd string, an unremarked behaviour change in a
      // function that writes to Jira.
      if (
        !value ||
        !Object.prototype.hasOwnProperty.call(fields, key) ||
        !fields[key]
      ) {
        return payload;
      }
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

// -----------------------------------------------------------------------
// Users
// -----------------------------------------------------------------------

/**
 * One entry from `/user/assignable/search`, reduced to the three things the
 * assignee picker needs.
 *
 * A user with no `accountId` is dropped rather than offered, on the same
 * principle `mapPriorityOptions` drops an option with no id: the only thing an
 * unwritable row could do is fail on click, so it is worse than not being
 * there. Everything else Jira sends about a user — `emailAddress`,
 * `accountType`, `locale`, `timeZone`, the group and application-role lists —
 * is deliberately left behind at this boundary rather than carried to the
 * renderer, because a picker needs a name and a write needs an id and nothing
 * about either needs a colleague's email address in the browser process.
 */
export function mapUserOption(raw: unknown): JiraWireUser | null {
  const record = asRecord(raw);
  const accountId = accountIdOf(record);
  if (!accountId) return null;

  const avatars = asRecord(record.avatarUrls);
  const avatar = avatars['48x48'] ?? avatars['32x32'] ?? avatars['24x24'];

  return {
    accountId,
    // "Unknown" rather than the account id: an id is not a name, and putting
    // one on screen is the same leak `adfToPlainText` refuses to make for a
    // mention. A nameless row is still pickable and still writes correctly.
    displayName: displayNameOf(record, 'Unknown'),
    avatarUrl: typeof avatar === 'string' ? avatar : null,
  };
}

export function mapUserOptions(raw: unknown): JiraWireUser[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(mapUserOption).filter((u): u is JiraWireUser => u !== null);
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
  // Lowercased before comparing, like every other string compare in this
  // file. The Greenhopper-era sprint custom field serializes
  // `ACTIVE|CLOSED|FUTURE`; only the modern object form is lower case. On a
  // site returning the older shape no sprint matched, so a carried-over
  // ticket fell through to "the last listed" and displayed the name of a
  // CLOSED sprint — a wrong value, not a missing one.
  const active = value.find(
    (entry) => String(asRecord(entry).state ?? '').toLowerCase() === 'active',
  );
  const chosen = asRecord(active ?? value[value.length - 1]);
  return typeof chosen.name === 'string' ? chosen.name : null;
}

/**
 * One issue's attachments, reduced to what this app can act on.
 *
 * The omission is the design. A real Jira attachment object carries a `content`
 * URL (and a `self`, and a `thumbnail`), and none of the three is carried
 * across the wire — see `JiraWireAttachment`'s own note. A download is an
 * authenticated request made with a whole-account credential, and the host it
 * is aimed at is built in jiraClient.ts from the stored site plus `id`, never
 * read out of a response body. Dropping the field here rather than "just not
 * using it" is what makes that unfalsifiable: there is no property on the wire
 * type a later caller could reach for by accident.
 *
 * `id` degrades to null rather than dropping the whole attachment: an
 * attachment with no id is still worth *showing* (its name and size are true),
 * it simply cannot be downloaded, and the UI can say so. That is the opposite
 * call from `mapPriorityOptions`/`mapUserOption`, which drop an idless entry —
 * because those are rows whose only purpose is to be clicked.
 */
export function mapAttachments(value: unknown): JiraWireAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const record = asRecord(entry);
    const { id, size, mimeType } = record;
    return {
      // Coerced from a number the same way `priorityId` is, for the same
      // reason: current Cloud sends a string, older and proxied payloads a
      // number, and neither is worth losing a download over.
      id: typeof id === 'string' || typeof id === 'number' ? String(id) : null,
      fileName:
        typeof record.filename === 'string' ? record.filename : 'attachment',
      sizeLabel: formatFileSize(size),
      sizeBytes: typeof size === 'number' && Number.isFinite(size) ? size : 0,
      mimeType:
        typeof mimeType === 'string' && mimeType
          ? mimeType
          : 'application/octet-stream',
      uploaderName: displayNameOf(record.author, 'Someone'),
    };
  });
}

/**
 * One entry from `fields.labels`, reduced to a plain string array.
 *
 * Jira's own shape for this field already IS `string[]` — unlike almost
 * everything else in this mapper, there is no per-site variance to defend
 * against here. The filter exists only for a trimmed or proxied payload that
 * slipped something else into the array; it is not evidence any real site
 * does that.
 */
function mapLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((label): label is string => typeof label === 'string');
}

/**
 * One entry from `fields.subtasks`, reduced to exactly what `JiraWireSubtask`
 * declares.
 *
 * Jira returns a subtask as a flat summary object on the PARENT issue's own
 * payload — `id`, `key`, and a `fields` object carrying only `summary` and
 * `status` (never the full issue shape `mapIssue` reads), so this reads
 * nothing beyond what is actually there. A full subtask fetch would need a
 * request per subtask, which this app does not do.
 */
function mapSubtask(raw: unknown): JiraWireSubtask | null {
  const record = asRecord(raw);
  const key = typeof record.key === 'string' ? record.key : null;
  if (!key) return null;
  const fields = asRecord(record.fields);
  const status = asRecord(fields.status);
  return {
    // Same coercion `mapIssue`'s own `id` uses, for the same reason: an older
    // or proxied payload can hand this back as a number, and the key is a
    // worse handle to fall back to only because nothing else here needs to.
    id: idOf(record.id) ?? key,
    key,
    title: typeof fields.summary === 'string' ? fields.summary : key,
    stateName: typeof status.name === 'string' ? status.name : 'Unknown',
    stateCategory: mapStateCategory(asRecord(status.statusCategory).key),
  };
}

export function mapSubtasks(value: unknown): JiraWireSubtask[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(mapSubtask)
    .filter((subtask): subtask is JiraWireSubtask => subtask !== null);
}

/**
 * One entry from `fields.issuelinks`, flattened to the OTHER issue plus the
 * phrase describing THIS issue's relationship to it.
 *
 * Jira nests a link asymmetrically: `type.inward`/`type.outward` are a site's
 * own words for the two directions ("blocks" / "is blocked by", and so on for
 * every link type this site has, including ones this app has never seen), and
 * exactly one of `inwardIssue`/`outwardIssue` is present per entry — never
 * both — naming which direction THIS link was found in. Reading the phrase
 * off Jira's own `type` object rather than hardcoding a table of link names is
 * what makes this correct for a renamed or custom link type, not just the
 * default set.
 *
 * An entry with neither side present, or whose other issue carries no key, is
 * dropped rather than shown as a link to nothing.
 */
function mapIssueLink(raw: unknown): JiraWireIssueLink | null {
  const record = asRecord(raw);
  const type = asRecord(record.type);
  const isInward = record.inwardIssue != null;
  const other = asRecord(isInward ? record.inwardIssue : record.outwardIssue);
  const key = typeof other.key === 'string' ? other.key : null;
  if (!key) return null;

  const phrase = isInward ? type.inward : type.outward;
  const otherFields = asRecord(other.fields);
  const status = asRecord(otherFields.status);

  return {
    id: idOf(other.id) ?? key,
    relation: typeof phrase === 'string' && phrase ? phrase : 'relates to',
    key,
    title: typeof otherFields.summary === 'string' ? otherFields.summary : key,
    stateName: typeof status.name === 'string' ? status.name : 'Unknown',
    stateCategory: mapStateCategory(asRecord(status.statusCategory).key),
  };
}

export function mapIssueLinks(value: unknown): JiraWireIssueLink[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(mapIssueLink)
    .filter((link): link is JiraWireIssueLink => link !== null);
}

/**
 * A body field's raw ADF node, carried alongside its flattened plain-text
 * sibling rather than replacing it — see `JiraWireTicket.descriptionAdf` and
 * `JiraWireComment.bodyAdf` for why both travel together in each of the two
 * places this is used (an issue's description, a comment's body).
 *
 * Only the object shape counts. A string body is legacy wiki markup (see
 * `plainTextFromJiraBody`), not ADF, and handing that string back under an
 * `*Adf` field would mislabel it as a document tree a rich renderer (or the
 * comment editor's losslessness round-trip) could walk. `null` — Jira's own
 * shape for "nothing here" — and a missing field both degrade to null here,
 * same as the string branch: none of the three is an ADF document.
 */
function adfBodyOf(value: unknown): unknown | null {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value;
  }
  return null;
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
    // Coerced rather than abandoned. A numeric `id` (older payloads, some
    // proxies — the same shapes `priorityId` and `mapAttachments` already
    // coerce for) silently fell back to the key, which works as
    // `issueIdOrKey` everywhere but defeats the reason jiraTypes.ts gives for
    // carrying an id at all: it survives an issue being moved to another
    // project, and the key does not.
    id: idOf(issue.id) ?? key,
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
    // Same two-branch guard `mapComment` uses, and for the same reason.
    // `adfToPlainText` returns a string input verbatim, so a description that
    // arrives as wiki markup rather than ADF — a proxy, a reverted endpoint,
    // an older API version, the three cases this file's own comments name —
    // went straight to the screen carrying `[~accountid:...]` and unstripped
    // `*bold*`/`{code}` markers. Comments were protected; descriptions came
    // from the same payloads and were not.
    description: plainTextFromJiraBody(fields.description),
    epicName: typeof epicName === 'string' ? epicName : null,
    storyPoints:
      typeof storyPointsRaw === 'number' && Number.isFinite(storyPointsRaw)
        ? storyPointsRaw
        : null,
    sprintName: sprintNameOf(sprintRaw),
    labels: mapLabels(fields.labels),
    // Jira's `duedate` is a date-only string ("2026-09-18"), not a timestamp —
    // carried through exactly as given rather than coerced into an ISO
    // datetime, which would fabricate a time of day and a timezone Jira never
    // supplied. Missing or non-string degrades to null, the same "we don't
    // know" this file uses everywhere else, never today's date or any other
    // invented value.
    dueDate:
      typeof fields.duedate === 'string' && fields.duedate
        ? fields.duedate
        : null,
    subtasks: mapSubtasks(fields.subtasks),
    links: mapIssueLinks(fields.issuelinks),
    descriptionAdf: adfBodyOf(fields.description),
    attachments: mapAttachments(fields.attachment),
    transitions: mapTransitions(issue.transitions),
    // Fall back to null rather than to "now". `listComments`'s `total`
    // fallback (jiraClient.ts) states the one thing still known to be true
    // when Jira omits a field; there is no equivalent honest guess for a
    // missing `updated` — the issue was not, in fact, just touched, and
    // stamping it with the current time is a claim this file cannot back up.
    // The renderer's sort (useMyJiraQueue.ts's compareTickets) treats null as
    // "unknown", not "most recent", so a trimmed payload no longer pins an
    // untouched issue to the top of the queue.
    updatedAt: typeof fields.updated === 'string' ? fields.updated : null,
  };
}

/** Comments are read AND written through v3 (see jiraClient.ts) — this
 * comment used to say writes went through v2, which stopped being true when
 * the composer started sending real ADF, and a stale claim about which API
 * answers is exactly the kind that makes a reader mis-model where a leak can
 * happen. Both body shapes are still handled and the string branch is not
 * dead: a proxy, a reverted endpoint or an older API version can still put
 * legacy markup here, and it is flattened through the wiki-markup pass
 * rather than rendered verbatim, which is what leaked a raw
 * `[~accountid:...]` on screen. `mapIssue` shares that guard now. */
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
    // Same helper the ticket's assignee id goes through, so the two cannot
    // disagree about what counts as a usable account id.
    authorAccountId: accountIdOf(record.author),
    // ROAD-41 contract: declared and defaulted so every consumer compiles
    // against the final shape. Implemented for real alongside the freshness
    // check - a default that silently stayed would claim a comment has never
    // been edited, which is exactly the lie this field exists to prevent.
    updatedAt: null,
    updateAuthorName: null,
    // The shared helper, not a reinlined copy of it. `plainTextFromJiraBody`
    // was extracted so a description and a comment "cannot drift apart
    // again", and then this — the one function that comment names — kept its
    // own duplicate of the ternary, leaving the drift the extraction was for.
    body: plainTextFromJiraBody(record.body),
    // The same helper mapIssue's own descriptionAdf goes through, kept in
    // sync for the same reason plainTextFromJiraBody is shared just above —
    // see JiraWireComment.bodyAdf's own comment for what this feeds.
    bodyAdf: adfBodyOf(record.body),
    // Same reasoning as mapIssue's updatedAt: null, not "now". A comment
    // whose `created` Jira omitted was not just posted, and a fabricated
    // timestamp would tell JiraTicketDetail.tsx's formatRelativeTime a lie it
    // would happily render as "just now".
    createdAt: typeof record.created === 'string' ? record.created : null,
    // The same `idOf` every other id on this wire goes through — Jira sends
    // this one as a JSON number while `id` itself is a string, and `idOf`
    // already exists to coerce exactly that asymmetry consistently rather
    // than at each call site. Null both when Jira omitted the key (a
    // top-level comment) and when it sent something `idOf` can't validate as
    // an id — see JiraWireComment.parentId's own comment for why the field is
    // trusted at all despite appearing nowhere in Atlassian's published spec.
    parentId: idOf(record.parentId),
  };
}
