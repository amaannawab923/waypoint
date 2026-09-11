# Jira comment actions: feasibility

> **Correction (ROAD-41 threading follow-up):** §1's Reply row and §"Reply"
> below both claim Jira's comment payload has "no thread field, no
> parent-comment reference anywhere." That was wrong — re-verified live
> against ENG-84 on the founder's real Jira: a comment posted through Jira's
> own Reply button comes back carrying a real `parentId` (a JSON number,
> where `id` itself is a string), present only on a comment that has a
> parent and absent on every top-level one. It does not appear in
> Atlassian's published OpenAPI spec, which is why this doc's original
> read-only pass missed it — treat that spec's silence as silence, not as
> proof the field doesn't exist. Waypoint's Reply now sends `parentId` on
> the write and renders nested comments accordingly, believing only Jira's
> own response about whether a given reply actually nested (never the
> request) — see `main/jira/jiraTypes.ts`'s `JiraWireComment.parentId` and
> `JiraTicketDetail.tsx`'s `groupCommentsIntoThreads` for the resulting
> design. The rest of this document (Edit, Delete, Copy link, sizing) is
> unaffected and still reflects real, verified behavior.

Scope: Reply, Edit, Delete, Copy link on a "My Jira" comment. Reactions are
confirmed out of scope (no reaction data on the comment payload, no
documented public endpoint) and are not re-analysed below.

Everything marked **(live)** was verified this session against
`waypoint123.atlassian.net`, read-only (GET requests and UI observation
only — no write, edit, delete, or reaction was ever submitted). Everything
marked **(code)** was verified by reading the current
`feat/road-41-jira-parity` checkout. Anything I could not verify is called
out explicitly as unverified rather than assumed.

## 1. Verdict table

| Action | Feasible? | Why in one line | Size | Blocking dependency |
|---|---|---|---|---|
| Copy link | Yes | Permalink is `…/browse/{KEY}?focusedCommentId={id}` **(live)**, fully constructible from data already in the renderer — no new IPC, no new Jira call. | XS | None |
| Reply | Yes | Jira's own "Reply" is a plain new top-level comment prefilled with an `@author` mention **(live)** — Waypoint's composer and mention pipeline already do exactly this. | S | Comment payload must start carrying `author.accountId` (currently dropped — see §3) |
| Delete | Yes, with constraints | Endpoint is a single `DELETE`; permission is checkable via `mypermissions`, not present on the comment itself **(live)**. Must gate on it and guard with a confirm dialog. | S–M | `mypermissions` read per ticket, `author.accountId` on the comment, DELETE method support in the client |
| Edit | Yes, but only in a deliberately restricted form — see §2 | Waypoint has no ADF deserializer anywhere in the codebase **(code)**, and Jira's real comment editor is a full rich-text surface **(live)**, not a textarea. A general editor would silently flatten tables, panels, embeds, and action items on save. | M (restricted version) / not recommended (full-fidelity version) | A round-trip-verified deserializer limited to the composer's existing whitelist (§2) |

## 2. The Edit problem

**Recommendation: ship Edit only for comments whose ADF is provably within
the exact subset Waypoint's composer can already produce, verified by
round-tripping the edit back through the existing ADF builder before saving
— and refuse, honestly, on anything else. Never ship a "best effort" edit
that silently degrades content.**

### What's actually true today (verified)

- `buildCommentAdf` / `blockToAdf` / `groupLinesIntoBlocks` in
  `waypoint-frontend/src/renderer/data/jiraApi.ts` (lines ~842–1371) is
  **markdown-lite → ADF only**, one direction. It emits exactly: paragraph,
  heading (1–3), bulletList, orderedList, blockquote, codeBlock, mention,
  emoji, and the marks `strong`/`em`/`strike`/`code`/`link`.
- There is no function anywhere in `waypoint-frontend` or `waypoint-backend`
  that turns ADF back into editable source text. `adfToPlainText`
  (`waypoint-frontend/src/main/jira/jiraMap.ts:203`) and its backend
  counterpart in `waypoint-backend/src/lib/jira/adf.ts` both flatten to
  **display-only** plain text — headings, lists, and marks all collapse to
  bare words, which is fine for reading and unusable as a re-editable
  source, since re-parsing "some plain text" can't reconstruct which words
  were bold.
- Jira's own comment payload (fetched live from `ENG-84`) carries the raw
  ADF (`type: 'doc', version: 1, content: [...]`), not a rendered string —
  so a real edit has real structure to lose.
- Jira's own Edit UI **(live)**, confirmed by opening it in the browser, is
  not a plain-text box: it's the same rich editor as new-comment composition,
  opened in place, with full formatting live-editable. Matching that
  experience exactly is out of scope for a textarea-based composer; matching
  its *outcome* (no silent data loss) is the bar that has to be hit instead.
- `waypoint-frontend/src/main/jira/jiraMap.ts`'s own `ADF_BLOCK_TYPES` set
  (line 73) and `adfToPlainText` explicitly enumerate node types the read
  path already knows it flattens lossily: `table`/`tableRow` (cell text
  only, structure gone), `panel` (content only, the callout type/color
  gone), `media`/`mediaInline` (alt text only, the image gone),
  `inlineCard`/`blockCard`/`embedCard` (a bare URL), `status`, `date`,
  `expand`/`nestedExpand`. None of these has a serializer back to ADF in
  the composer. Nested lists beyond one level and combined marks
  (bold-and-italic-together) aren't produced by the composer's parser
  either — its own header comment says so explicitly.

### Why "restrict to simple comments" is not automatically safe either

The obvious middle path — allow Edit only on comments that "look simple" —
has a failure mode that isn't about node types at all: **text-level
ambiguity**. The markdown-lite parser treats `*`, `_`, `` ` ``, `~~`, and
`[text](url)`-shaped runs as syntax. A perfectly plain-text Jira comment
that happens to contain a literal `*` (bullet character in prose, an
emphasis mark someone typed by hand, a footnote marker) or wraps a snake
case identifier in underscores would, on deserialize-then-reserialize,
have those characters reinterpreted as formatting — changing content the
user never asked to change. The composer's own header comment already
admits this gap: "not escaping a literal delimiter character." A
"simple-ADF-only" allowlist by node type does not, by itself, catch this.

### The strategy I recommend

1. **Deserializer, scoped exactly to the composer's existing whitelist.**
   Walk the comment's ADF; if every node is one of
   {paragraph, heading, blockquote, codeBlock, bulletList, orderedList,
   listItem, mention, emoji, text} and every mark is one of
   {strong, em, strike, code, link}, with no nesting the composer doesn't
   already produce, reconstruct the markdown-lite source text and the
   `JiraMentionSpan[]` for it. This direction is genuinely buildable — it's
   the mechanical inverse of a well-tested one-way pipeline that already
   exists — and is the module I'd size at M.
2. **Round-trip verification before Save is ever enabled, not just before
   node-type checking.** After the deserializer produces source text, run
   it back through the existing `buildCommentAdf` and deep-compare the
   result to the original ADF (normalized). If they match, editing is
   provably lossless for *this specific comment*, structure and text both —
   this is what catches the delimiter-escaping problem above without having
   to enumerate every possible corruption mode by hand. If they don't
   match, for *any* reason, Edit is refused.
3. **Refuse honestly, don't degrade.** A comment that fails either check
   gets no Edit affordance (or a disabled one with a real reason — see UX
   note below), never a "some formatting may be lost" edit box that posts
   anyway. This is the direct implementation of the brief's own standard: a
   partial-fidelity editor that silently destroys real content in the
   user's real Jira is worse than no edit button, and there is no approval
   step or undo standing between a bad save and the user's actual data.

### Alternatives considered and rejected

- **Full ADF ↔ rich-text round trip (build the deserializer for
  table/panel/media/status/date/expand/inlineCard too).** Rejected as a
  goal, not deferred as a "later phase": matching Jira's real editor means
  building a rich text editor, not extending a regex parser, and even a
  complete effort never fully closes the gap (a *future* ADF node type
  Jira adds is unrepresentable by definition until this app is updated
  again). I'd size this XL and recommend never pursuing it — the restricted
  version below gets nearly all the real-world value (most comments are
  plain prose with basic marks) for a fraction of the risk and cost.
- **Restrict Edit to comments Waypoint itself posted.** Rejected as
  unnecessary rather than wrong: `toComment` in
  `waypoint-frontend/src/renderer/data/jiraApi.ts:316` already documents
  that Waypoint keeps no record of what it posted (`postedByWaypoint`
  is hardcoded `false` on every read), so this would require a new local
  ledger with all the usual problems (lost on reinstall, doesn't survive a
  second device) — and it doesn't even buy extra safety, since
  Waypoint-authored comments are already a strict subset of "provably
  simple ADF" by construction (the composer can't produce anything outside
  that whitelist today). §2's strategy already covers every comment this
  rule would have covered, plus the ones Jira's own web UI authored, as
  long as they also happen to be simple.
- **UX coherence of "some comments are editable, some aren't."** I don't
  think this is actually confusing in practice, because Jira's own UI
  already works this way: the pencil icon is conditionally rendered based
  on permission with zero explanation today. A disabled Edit with a
  tooltip — "This comment uses formatting Waypoint can't edit without
  risking it (tables, panels, or an embed) — edit it in Jira instead" — is
  more explanation than Jira itself gives, and is consistent with this
  repo's existing "said plainly" convention for capability gaps (see the
  "Not built yet" list in `JiraConnectionPanel.tsx`).

## 3. Per-action strategy

### Copy link

- **Format (live-verified):** `https://{site}/browse/{ISSUE-KEY}?focusedCommentId={commentId}`.
  Confirmed by monkey-patching `navigator.clipboard.writeText` and
  triggering Jira's own "Copy link" menu item on a real comment on
  `ENG-84`; the captured value was
  `https://waypoint123.atlassian.net/browse/ENG-84?focusedCommentId=10158`.
- **Data needed:** `site` (already available via `useJiraConnection()` /
  `jiraStore`, and already imported into `JiraCommentComposer.tsx`),
  `ticket.key` (already a prop on the comment thread), `comment.id`
  (already on `JiraComment`). Nothing new has to cross the IPC boundary.
- **Client:** none — this is pure renderer code. It never touches
  `jiraClient.ts` in either process, and it's the one candidate action that
  is not a write to Jira, so it shouldn't go in the capability register's
  "writes straight to Jira" list (§4).
- **UI shape:** an icon in the comment's action row (next to Reply), a
  `navigator.clipboard.writeText(...)` call, a toast confirmation ("Link
  copied").
- **Permissions:** none — this reads only data already fetched.
- **Failure modes:** clipboard write can throw (rare, e.g. permission
  denied in an unusual embedding); catch and toast rather than let it
  throw uncaught.
- **Tests:** a pure string-formatting unit test given a fixture ticket key
  + comment id + site.

### Reply

- **What it means, precisely (live-verified against Jira's own UI):**
  Jira's "Reply" opens the *same* new-comment composer, pre-populated with
  a real `@AuthorName` mention (backed by the author's actual
  `accountId`), cursor placed after it, and posts as an ordinary top-level
  comment — there is no thread field, no parent-comment reference anywhere
  in the payload I fetched. Waypoint's Reply should do exactly this and
  nothing more: prefill `JiraCommentComposer`'s draft with a
  `JiraMentionSpan` for the original author and open/focus the composer.
  It must not render any visual nesting, indentation, "in reply to" thread
  line, or reply count — Jira's own UI doesn't either, and inventing one in
  Waypoint would show a threading relationship the data does not have,
  which is the exact failure mode the brief warns against.
- **Endpoint/payload:** identical to today's comment post —
  `POST /rest/api/3/issue/{id}/comment` with the same ADF body shape
  `buildCommentAdf` already produces. No new Jira endpoint.
- **Blocking dependency:** `mapComment` in
  `waypoint-frontend/src/main/jira/jiraMap.ts:1161` currently reads
  `authorName` only and discards `record.author.accountId` entirely — the
  live payload has it (`author.accountId`,
  confirmed as `"712020:05c45d40-…"` on ENG-84). Building a real ADF
  `mention` node requires the accountId, not just the display name (per
  `buildCommentAdf`'s own contract). This means `JiraWireComment` and
  `JiraComment` both need a new `authorAccountId` field, and `mapComment`
  needs to start populating it.
- **Client:** `waypoint-frontend/src/main/jira/jiraMap.ts` (mapping change)
  only. No change to `waypoint-backend/src/lib/jira/client.ts` — Copilot's
  MCP tools only ever propose *new* comments (`propose_comment` in
  `waypoint-backend/src/mcp/proposalTools.ts:551`), never a reply-flavoured
  one, so there is no drift risk to manage between the two clients for
  this action.
- **UI shape:** a "Reply" affordance on each comment (matching Jira's own
  icon/position) that scrolls to and focuses the existing composer with
  the mention pre-seeded.
- **Permissions:** same as any comment post — `ADD_COMMENTS`, already
  implicitly required today.
- **Failure modes:** identical to today's comment post path.
- **Tests:** the mention-prefill logic (composer opens with the correct
  `JiraMentionSpan`) and a `mapComment` test asserting `authorAccountId` is
  now carried through.

### Delete

- **Endpoint:** `DELETE /rest/api/3/issue/{issueIdOrKey}/comment/{commentId}`.
  Per Atlassian's documented contract this returns `204` on success; I did
  not exercise it live (writes are prohibited for this task), so its exact
  behavior is **unverified by me directly** — flagging that rather than
  asserting it as tested.
- **Permissions (live-verified):** the comment object itself carries no
  permission hint of any kind — the full live payload for a comment on
  `ENG-84` is exactly `{self, id, author, body, updateAuthor, created,
  updated, jsdPublic}`, no `editable`/`deletable`/`visibility` field.
  `GET /rest/api/3/mypermissions?issueKey={key}&permissions=DELETE_OWN_COMMENTS,DELETE_ALL_COMMENTS`
  does exist and does answer per-project, real booleans — verified live
  (the connected account, which is a site admin, showed both `true`). This
  is the mechanism to use: fetch it once per ticket (cache it the same way
  `transitionsByTicketId` and priority options are already cached
  per-ticket in `jiraApi.ts`), then show Delete on a comment when
  `DELETE_ALL_COMMENTS` is true, or `DELETE_OWN_COMMENTS` is true and
  `comment.authorAccountId === connection.accountId` (same accountId
  dependency as Reply, above).
- **Optimistic vs. hide-on-uncertain:** prefer showing the button and
  handling a `403` gracefully (toast, no state change) over hiding it,
  matching this codebase's own stated precedent —
  `searchAssignableUsers`' own comment in `jiraClient.ts` explicitly
  rejects turning "a permission I couldn't check" into "this doesn't
  exist," calling that "a lie the picker would have no way to walk back."
  The same principle applies here: if the `mypermissions` read itself
  fails, don't silently hide Delete everywhere — show it and let a real
  `403` from the delete call be the final word.
- **Client:** `waypoint-frontend/src/main/jira/jiraClient.ts` needs (a) a
  new exported `deleteComment(ticketId, commentId)`, and (b) `'DELETE'`
  added to the `method` union on both `JiraRequest` and `RawJiraRequest`
  (currently `'GET' | 'POST' | 'PUT'` only, lines ~168 and ~184) — a small,
  contained interface change. `jiraIpc.ts` needs a `jira:comments:delete`
  handler, `preload.ts` a bridge method, `jiraApi.ts` a `deleteJiraComment`
  export. No change to `waypoint-backend` — Copilot never deletes
  comments.
- **UI shape:** the same `window.confirm`-guarded pattern this repo already
  uses for irreversible Jira actions (`disconnectJiraConfirmMessage` in
  `JiraConnectionPanel.tsx`, `archiveConfirmMessage` in
  `projectArchiveCopy.ts`). A new, equally explicit message is warranted:
  something like "Delete this comment? Waypoint deletes it from Jira
  immediately — there's no undo, in Waypoint or in Jira." should live
  alongside the other two confirm-message functions.
- **Failure modes:** on `403`, toast and leave the comment in place (don't
  optimistically remove it before the server confirms). On success, remove
  it from local `comments` state directly — no need to re-fetch the whole
  thread — and decrement `commentTotal`, mirroring how `postJiraComment`'s
  caller already increments it.
- **Tests:** permission-gating logic (own comment vs. all-comments
  permission vs. neither), the confirm-message content, and the client's
  `403`-vs-`204` handling.

## 4. Cross-cutting

### Conflict-banner interaction — verified, and it already has a bug today

Live-verified: posting a comment on `ENG-84` bumped
`fields.updated` on the *issue itself* to the exact same timestamp as the
comment's own `created`. Jira treats any comment activity as an issue
update.

`postJiraComment` in `jiraApi.ts:1382` does **not** re-fetch the ticket —
it calls `toComment` on the write response, never `toTicket`, so
`lastTickets`' cached entry for that ticket keeps its *pre-write*
`updatedAt`. The next real queue read (pressing Refresh, or the next time
My Jira mounts) fetches the ticket fresh, sees the *new*, comment-bumped
`updated`, compares it against the stale cached value via `detectConflict`
(`jiraApi.ts:223`), and — because the two now differ — sets
`hasConflict: true`, attributing the change to `'Someone'`. This is not
cosmetic: `ticket.hasConflict` gates real writes off
(`JiraTicketDetail.tsx:457,688,715,742`, `JiraTicketRow.tsx:300,310` all
disable on it, with the tooltip "Write paused until reloaded").

**This is already true today, for the comment-posting path that's already
shipped** — I want to flag it as a live, pre-existing defect independent
of these four actions, not something Reply/Edit/Delete introduce. Adding
Edit and Delete (both of which will also bump `issue.updated` the same
way, since they're the same kind of Jira activity) makes it fire more
often, which raises the priority of fixing it now rather than later.

**Fix, using a pattern the file already establishes:** every other write
in `jiraApi.ts` (`transitionJiraTicket`, `setJiraTicketPriority`,
`setJiraTicketAssignee`, `uploadJiraAttachment`) calls `toTicket(wire)`
with **no** `previous` argument specifically so the write can't flag
itself — see `toTicket`'s own extensive comment on this at
`jiraApi.ts:243`. Comment writes should do the same: after a successful
post/edit/delete, patch `lastTickets`' cached `updatedAt` for that ticket
(a cheap local field update, or a full `getTicket` + `.map()` re-read
matching the existing writes' shape) so the cache's baseline reflects the
write that just happened, rather than leaving it stale until the next
unrelated read notices the drift and misattributes it.

### Capability register

`JiraConnectionPanel.tsx` (~lines 236–259) states, in one governed
sentence per its own commit history (referenced there as commit
`e9e1ec9`'s lesson): "moving a ticket … posting a comment … priority …
reassigning … attaching a file … Those five are the whole set." Reply,
Edit, and Delete are all real new writes to Jira and must be added to this
sentence in the same commit that ships each of them — the file's own
comment treats an inaccurate version of this list as equal in severity to
a broken feature, and the review history backs that up. Copy link is not a
write and should not be added here. Concretely: "posting a comment" can
absorb "or replying to one" (Reply is the same write, just prefilled); Edit
and Delete each need their own clause, phrased with the same honesty this
panel already uses elsewhere (e.g. stating that Edit only works on
comments Waypoint can safely round-trip, matching §2).

### Optimistic update vs. refetch, and failure behavior

Today's pattern is genuinely split by cost: the four ticket-field writes
all re-`GET` the whole ticket after writing, because their payload has to
be *resolved* against live metadata anyway (`transitionJiraTicket`,
`setJiraTicketPriority` both re-check live options first). Comment posting
does not re-fetch anything — it trusts the write response and appends
locally. Reply should do the same (it's the same write). Edit and Delete
should follow the same "trust the response, don't refetch the thread"
shape: a successful `PUT` returns the updated comment body to splice into
local state at the same index; a successful `DELETE` (204, no body) means
remove it locally. On failure, neither should mutate visible state — and
specifically for Edit, a failed save should leave the inline editor open
with the user's in-progress edit intact rather than discarding it, so a
transient network failure doesn't compound into losing what they typed.

## 5. Recommended sequencing

1. **Fix the conflict-cache bug first, standalone.** It's already live and
   already mis-fires on ordinary comment posting; it isn't gated on any of
   the four actions below and is the lowest-risk, highest-leverage change
   on this list.
2. **Copy link.** Zero risk, zero new server-side surface, immediate value.
3. **Reply.** Small, reuses the composer and mention pipeline verbatim,
   and is verified to match Jira's own real semantics exactly rather than
   inventing new ones.
4. **Delete.** Needs the `mypermissions` plumbing and a new confirm
   message, but the endpoint itself is simple and the permission model is
   checkable, not guessed.
5. **Hold Edit until the restricted, round-trip-verified version in §2 is
   built and reviewed on its own.** Do not ship any interim version that
   trades fidelity for coverage. This is the one action where shipping
   something that merely looks done is worse than the current inert state.

## 6. What I would refuse to build

- **A full-fidelity ADF round-trip editor.** Sized XL, never fully closes
  (a new ADF node type Jira adds tomorrow reopens the gap), and the
  restricted version captures nearly all the everyday value at a fraction
  of the risk.
- **Any "best effort" Edit that saves with a fidelity disclaimer.** The
  brief's own standard applies directly: a partial-fidelity editor that
  can silently destroy real content in the user's real Jira, with no
  approval step and no undo, is worse than no edit button. §2's
  round-trip check exists specifically so this can never ship by accident.
- **Visual reply-threading in Waypoint's UI** — indentation, "in reply to"
  connectors, reply counts. Jira's comment schema has no parent/thread
  field and its own UI shows no nesting either; adding any in Waypoint
  would depict a relationship the data doesn't have and Jira's own web UI
  will never agree with.
- **Editing or deleting another person's comment past what
  `EDIT_ALL_COMMENTS`/`DELETE_ALL_COMMENTS` actually grants.** Respect
  Jira's real permission model as read from `mypermissions`, rather than
  trying to be more permissive than the site's own admin configured it to
  be.
- **Emoji reactions** — already established unbuildable; not re-litigated
  here per the brief.
