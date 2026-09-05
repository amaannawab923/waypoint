# Review — JIRA test case set (JIRA-01 … JIRA-152)

Reviewer pass over the `## JIRA — My Jira companion (Round 1 — authoring only,
NOT executed)` section of `docs/qa/manual-test-cases.md`. Authored the same way
the original was: read against the shipped implementation
(`src/renderer/pages/jira/`, `src/renderer/components/domain/Jira*.tsx`,
`src/renderer/data/jiraApi.ts`, `src/renderer/lib/jiraStore.ts`,
`src/main/jira/`), **nothing executed**. No case below has a `Result:` line, for
the same reason the original doesn't.

---

## 1. Summary verdict

**Roughly 75% complete. Strong on the axis it chose; systematically blind on
three others.**

What the first pass did well, and I want to be specific because it's genuinely
unusual: every Coverage call I spot-checked against the code was accurate. The
sharp findings — JIRA-133 (all list errors render as an empty queue), JIRA-19
(the Connection tab claims a priority write that has no code path), JIRA-53/54
(the tombstone UI is fully built and permanently unreachable because `toTicket()`
hardcodes `isTombstoned: false`), JIRA-123 (`lastSyncAt` initialised at module
load, so "synced 0s ago" before any sync), JIRA-86 (oldest 100 comments, silently)
— are all real, all correctly diagnosed at the line level, and are the right
things to have found. The field-mapping coverage against `jiraMap.ts` is close to
exhaustive.

The gap is that the set was written **from the code outward**, and it stops at
the boundary of what the code says. Almost every case asks "does this function do
what it claims." Almost none ask "what does a person sitting in front of this
actually experience." That produces three blind spots, in descending order of
size:

1. **Rendering, layout and accessibility: zero of 152 cases.** Not "thin" —
   zero. No case checks that anything is *visible*, that a keyboard user can
   operate the list, that a screen reader gets anything, that long text doesn't
   overflow, or that the feature works in the dark theme the app ships a toggle
   for (CHROME-04). This is where I found the single most likely real defect in
   the feature (new JIRA-153: the transition popover is rendered inside an
   `overflow-hidden` container and will be clipped).
2. **Identity, tenancy and permissions: near zero.** The founder asked about
   service accounts, multiple sites under one org, and restricted issues. None
   of the three appears anywhere in 152 cases. The permission cases that do
   exist (JIRA-77, JIRA-97) are about a single narrow scenario each.
3. **Jira-side reactions to your own write: zero.** Automation rules, workflow
   validators and post-functions are how most real Jira instances behave on a
   transition, and `transitionTicket()` has a genuine race with them (it re-reads
   the issue immediately after POSTing, which may land before or after an
   automation fires). Nothing covers it.

Secondary problem, and it's a scheduling problem more than a quality one: about a
quarter of the existing set **cannot be executed on one Atlassian account by one
person**, and the section's Preconditions block doesn't say so. See §3.14.

**38 new cases below (JIRA-153 … JIRA-190). 18 corrections to existing cases.**

---

## 2. New test cases to add

Formatted to be appended directly. Suggested subsection placement is given as a
`###` heading; see §4 for why two of these are new subsections.

### Rendering, layout and visual correctness

- **JIRA-153** — Transition popover is clipped by the ticket list's clipping container
  Steps: Load a queue with at least 6 issues. Click the state chip on the **last**
  row in the list. Then click the state chip on the second-to-last row. Then on a
  transition badged "needs a field" on any row within 3 rows of the bottom.
  Expected: The full popover — heading, every transition option, and the "your
  Jira workflow allows" footer — is visible and clickable in every case.
  Coverage: **Supported** — the clip was real and is fixed. `MyJiraPage` still
  wraps the rows in `<div className="overflow-hidden rounded-… border …">` and
  each row is still `relative`, but `JiraTransitionPopover` no longer renders
  inside either: it is portaled to `document.body` and positioned `fixed` from
  the state chip's own `getBoundingClientRect()`, following the same pattern
  `DatePicker.tsx` already uses in this app and for the same reason. It flips
  above the chip when there isn't room below, clamps inside the viewport on both
  axes, and re-measures on scroll, on resize and on the swap into the
  required-field form (which is taller than the option list — the case that
  failed soonest). `z-30` became `z-[60]` so a body-level panel clears the ticket
  drawer's `z-50` backdrop while staying under ToastHost's `z-[200]`. Asserted in
  `MyJiraPage.test.tsx` — jsdom does no layout, so the tests pin the escape (the
  panel is a child of `<body>`, positioned `fixed`) rather than the pixels; the
  steps above are still the right live check.

- **JIRA-154** — A very long issue summary
  Steps: Find or create an issue with a 200+ character summary. Look at its row,
  then open its drawer.
  Expected: The row truncates to one line with an ellipsis and does not push the
  role tag, state chip, priority icon or avatar out of the row. The drawer shows
  the summary in full, wrapped.
  Coverage: **Supported** — the row's title button is `truncate` inside
  `min-w-0 flex-1`; the drawer's `<h3>` wraps freely. Worth confirming because
  every sibling element in the row is `shrink-0`, so a truncation failure would
  break the whole row layout rather than one cell.

- **JIRA-155** — A description or comment containing one very long unbroken string
  Steps: Put a 300-character URL, a base64 blob, or a long stack-trace frame with
  no spaces into a Jira description, and a second one into a comment. Open the
  drawer.
  Expected: Both wrap or scroll inside the 460px drawer; neither forces the
  drawer's content to scroll horizontally or pushes the close button off-screen.
  Coverage: **Not supported (untested/unknown)** — the description `<p>` and the
  comment body `<div>` carry no `break-words`/`break-all` and no `overflow-x`.
  A long unbroken token is the standard way this class of layout fails, and a
  pasted stack trace or URL in a bug ticket is the most ordinary content there is.

- **JIRA-156** — Duplicate attachment filenames on one issue
  Steps: In Jira, attach two different files with the same name to one issue
  (Jira permits this). Open that ticket's drawer in Waypoint; check the browser
  console.
  Expected: Both attachments are listed distinctly; no React duplicate-key
  warning.
  Coverage: **Gap worth flagging** — `JiraTicketDrawer` renders attachments with
  `key={a.fileName}`, and `mapAttachments` doesn't carry Jira's attachment id at
  all, so there is no unique value available to key on. Two `screenshot.png`
  uploads is an everyday occurrence on a bug ticket.

- **JIRA-157** — My Jira in a narrow window
  Steps: Resize the app window to roughly 900px wide, then to the narrowest the
  window manager allows. Work through the My work tab: filter chips, a row, a
  transition popover, the drawer.
  Expected: No horizontal page scroll, no overlapping controls, chips wrap, the
  drawer stays usable.
  Coverage: **Not supported (untested/unknown)** — the page is
  `max-w-6xl` with a fixed `ml-[41px]` gutter on every block, the rail is
  `sm:w-[292px] sm:min-w-[262px] sm:shrink-0`, and the drawer is
  `w-full max-w-[460px]`. Plausible but unverified; no case in the whole 152 set
  resizes anything.

- **JIRA-158** — Every My Jira surface in the dark theme
  Steps: Switch to dark theme (CHROME-04). Visit My Jira: the header chip, the
  sync indicator, filter chips, rows, project color swatches, the state chip, the
  transition popover, the required-field form, the drawer and its backdrop, the
  Connection tab's three banner blocks.
  Expected: Every surface is legible; no hardcoded light-mode color survives.
  Coverage: **Partial** — nearly everything uses theme tokens, but
  `JiraTicketDrawer`'s backdrop is a literal `bg-black/40` and the three project
  colors are fixed `--p-eng`/`--p-plat`/`--p-grw` references whose contrast in
  dark mode has never been checked against the row's `bg-surface`. Cheap to
  verify, and the app ships a theme toggle so a user will hit it.

### Accessibility and keyboard operation

- **JIRA-159** — Move a ticket without touching the mouse
  Steps: From the My work tab, Tab through the page. Reach a row's state chip,
  activate it with Enter/Space, and try to reach and choose a transition option
  using only the keyboard. Repeat for a transition that opens the required-field
  form.
  Expected: Focus moves into the popover when it opens, arrow keys or Tab reach
  every option, Escape returns focus to the chip that opened it.
  Coverage: **Not supported (untested/unknown)** — the options are real
  `<button>`s so Tab will reach them, but `JiraTransitionPopover` never moves
  focus into itself on open (it only calls `panelRef.current?.focus()` on the way
  *out*, as a blur guard), carries no `role="menu"`/`aria-expanded`/
  `aria-haspopup`, and restores focus nowhere on close. This no longer compounds
  with JIRA-153 (the panel is portaled and can't be clipped any more), but note
  that portaling moves the panel out of the row's DOM order, so Tab order is now
  wherever `<body>` puts it rather than immediately after the chip — worth
  checking as part of this case rather than assuming it improved.

- **JIRA-160** — Ticket drawer as a dialog
  Steps: Open a drawer with the keyboard. Tab repeatedly. Close with Escape.
  Expected: Focus enters the drawer, is trapped inside it while open, and returns
  to the row that opened it on close.
  Coverage: **Gap worth flagging** — `JiraTicketDrawer` has no `role="dialog"`,
  no `aria-modal`, no accessible name, no focus trap and no focus restoration; it
  is a portal with a backdrop and an Escape listener. Tabbing while it's open
  walks the list behind it. Worth checking against the app's existing
  `TicketDrawer` convention, which this one deliberately mirrors — if that one
  has the same shape, this is an app-wide finding rather than a Jira one.

- **JIRA-161** — In-flight and failed writes are announced
  Steps: With a screen reader running, transition a ticket and post a comment.
  Then force a failure (offline) and do both again.
  Expected: "Saving…"/"Posting…" and the resulting error are announced, not just
  rendered.
  Coverage: **Not supported (untested/unknown)** — the chip's "Saving…" is a
  plain text swap inside a button that is simultaneously `disabled`, and errors
  go to `showErrorToast`. Nothing is in an `aria-live` region. A screen-reader
  user gets no signal that a write started, finished, or failed.

- **JIRA-162** — Information carried only by color
  Steps: For each of: priority, workflow state, project — cover the color and ask
  whether the value is still readable. Then view the list through a
  deuteranopia/protanopia simulation.
  Expected: No value is conveyed by hue alone.
  Coverage: **Partial** — state and project both pair color with text (status
  name, project key), so those are fine. Priority is the exception: `PriorityIcon`
  distinguishes urgent/high/medium/low by both glyph *and* color, but `low` and
  `none` are `SignalLow` vs `Minus` at 14px in `--text-secondary` vs
  `--text-muted` — near-identical at a glance. And per JIRA-34 there is no
  priority label, tooltip, filter or sort anywhere to disambiguate.

### Text, language and content extremes

- **JIRA-163** — Non-Latin and right-to-left content
  Steps: Put a Japanese summary on one issue, an Arabic or Hebrew summary on a
  second, and post a comment in each script from Jira. Read all of it in
  Waypoint, then post an Arabic comment from Waypoint's composer and read it back
  in Jira.
  Expected: All text renders correctly; RTL text reads right-to-left within its
  own block; nothing renders as boxes or mojibake; the round-tripped comment is
  byte-identical in Jira.
  Coverage: **Not supported (untested/unknown)** — nothing sets `dir="auto"`
  anywhere, so RTL summaries will render LTR-ordered inside a `truncate` cell
  (which also truncates from the wrong end for RTL). Purely a rendering question;
  the transport is JSON throughout and should be clean.

- **JIRA-164** — Emoji in a summary and in a comment
  Steps: Add emoji to an issue summary and to a comment (using Jira's own emoji
  picker, which produces an ADF `emoji` node, not just a literal character).
  Read both in Waypoint.
  Expected: Emoji appear as emoji, or at worst as their `:shortname:`; never as
  an empty gap or a broken glyph.
  Coverage: **Supported** — `adfToPlainText` handles the `emoji` node type,
  preferring `attrs.text` and falling back to `attrs.shortName`. Worth exercising
  because it's the one ADF node type with a two-level fallback and no test data
  behind it.

- **JIRA-165** — Avatar initials for unusual display names
  Steps: Look at rows and comments whose author display name is: a single word
  ("Priya"), a non-Latin script, an email address, and a name with a leading
  emoji. Also check an unassigned issue's avatar.
  Expected: Something sensible in every case — never an empty circle or a crash.
  Coverage: **Partial** — every Jira surface uses the app's initials `Avatar`
  derived from a display-name string, including the literal string "Unassigned"
  (which will render "U"). Note separately that Jira **does** return a real
  avatar URL and the main process stores it (`JiraCredential.avatarUrl`,
  `JiraIdentity.avatarUrl`), but `JiraConnectionStatus` has no such field, so no
  surface can ever render it. See correction to JIRA-02.

- **JIRA-166** — A comment whose formatting depends on leading whitespace
  Steps: In Waypoint's composer, type a comment that begins with an indented
  block (a pasted code snippet, a bulleted list indented two spaces) and has
  trailing blank lines. Post it, then read it in Jira.
  Expected: What lands in Jira is what was typed.
  Coverage: **Gap worth flagging** — the body is trimmed twice on the way out:
  `JiraCommentComposer.handlePost` sends `draft.trim()`, and
  `jiraIpc.ts` applies `readString()` (also `.trim()`) again at the boundary.
  Leading indentation on the first line and trailing structure are silently
  removed. Small, but it's exactly the case a developer pasting a snippet hits,
  and JIRA-94 ("line breaks preserved") tests the middle of a comment while this
  tests its edges.

### Time, clocks and timezones

- **JIRA-167** — A timestamp from the future
  Steps: Find or produce a comment whose `created` is slightly ahead of the local
  clock (a machine whose clock is a few minutes behind, or a comment posted from
  another timezone with a skewed client). Read it in the drawer.
  Expected: A sane label, not a negative age.
  Coverage: **Partial** — `formatRelativeTime` computes `Date.now() - created`
  with no floor, so a future timestamp yields a negative `diffSec`, which lands
  under `< 45` and prints "just now". Benign by luck rather than design, and
  worth recording. `LiveSyncIndicator` and the row's relative-time helpers do
  clamp with `Math.max(0, …)`; `formatRelativeTime` is the one that doesn't.

- **JIRA-168** — Sleep, resume, and a changed clock
  Steps: Open My Jira, note "synced Ns ago". Close the laptop lid for an hour and
  reopen it. Then change the system clock forward a day and look again.
  Expected: The indicator's age should stay truthful about when the read actually
  happened, and should not present a very stale read in the same visual language
  as a fresh one.
  Coverage: **Gap worth flagging** — the age itself stays arithmetically correct
  (it's a real timestamp difference), but `LiveSyncIndicator` renders "synced 60m
  ago" in `text-success` beside an `animate-pulse` success-colored dot, and
  nothing degrades that treatment as the read gets older. JIRA-122 flags the
  visual-language problem at rest; this is the version a real user hits, because
  a laptop that slept is the normal way a Waypoint window ends up hours stale.

### Identity, tenancy and permissions

- **JIRA-169** — An issue with an issue-security level set
  Steps: On a project using an issue security scheme, put a security level on an
  issue in your queue. Refresh My Jira and open its drawer.
  Expected: The issue appears (you can see it), and its restricted status is
  indicated somewhere — or, if it isn't, confirm nothing about the row implies
  the issue is ordinary.
  Coverage: **Gap worth flagging** — `fields.security` is never read or mapped.
  A security-restricted issue renders identically to a public one, which matters
  most in the drawer: a user reading a restricted ticket has no cue that its
  contents are limited-audience, and (with the composer's "Posts to Jira as X ·
  plain text" footer as the only context) no cue about who will see their reply.
  Same class as JIRA-97 for comments, and arguably worse because it covers the
  whole issue.

- **JIRA-170** — An issue whose assignee or reporter you're not permitted to see
  Steps: Find or create an issue in your queue where the People fields are
  restricted by a field configuration or permission scheme (common on Service
  Management projects). Check its row's role tag and avatar, and the drawer's
  Assignee/Reporter chips.
  Expected: "Unassigned"/"Unknown" is acceptable; a *wrong role tag* is not.
  Coverage: **Gap worth flagging** — `roleOf()` in `jiraMap.ts` tests
  `assignee.accountId === myAccountId`, then `reporter.accountId ===
  myAccountId`, and **falls through to `'watcher'` unconditionally**. If Jira
  omits or redacts the assignee object, `accountIdOf` returns null and an issue
  assigned to you is labeled "watching" — and then disappears from the
  "Assigned" role filter (JIRA-27) while appearing under "Watching". The
  fall-through is safe only while both fields are always readable, which is
  precisely what a permission scheme breaks.

- **JIRA-171** — A ticket whose comments you aren't permitted to read
  Steps: Find a ticket in your queue in a project where your role can browse
  issues but not view comments (or where every comment is restricted to a group
  you're not in). Open its drawer.
  Expected: Something that distinguishes "you can't see these" from "there aren't
  any."
  Coverage: **Gap worth flagging** — a 403 on `jira:comments:list` produces a
  perfectly good message ("Your Jira account isn't allowed to do that."), which
  `JiraTicketDrawer` then discards because it destructures only `{ data }` from
  `useAsync`. The user reads "No comments yet." — a false factual claim about a
  ticket that may have a long restricted thread. Same root cause as JIRA-134 but
  a *reachable-today, no-outage-required* path to it, which makes it the better
  case to actually run.

- **JIRA-172** — Connecting a service/bot account rather than a person
  Steps: Connect using an Atlassian account that is a service account or a shared
  bot (`ci-bot@yourteam.com`), not a human. Open My Jira; open a drawer; post a
  comment; transition an issue.
  Expected: Document the whole experience — what the queue contains, what the
  composer footer says, and how the write is attributed in Jira.
  Coverage: **Not supported (untested/unknown)** — `currentUser()` resolves to
  the bot, so the queue is the bot's work (usually near-empty, since bots are
  rarely watchers), the composer footer reads "Posts to Jira as CI Bot", and the
  connect form's own promise — "Writes are attributed to you, not to a service
  account" (`AddProjectWizard`) — becomes literally false, since the connected
  identity *is* a service account. Nothing prevents or warns about this. The
  founder asked about it specifically and it appears nowhere in the 152.

- **JIRA-173** — One Atlassian org with more than one Jira site
  Steps: Using an account with access to two Jira Cloud sites in the same
  Atlassian org (`teamA.atlassian.net` and `teamB.atlassian.net`), connect one.
  Confirm which issues appear. Then look for any way to see the other site's
  work, or any indication that a second site exists.
  Expected: A user with work on both sites should be able to tell that Waypoint
  is showing them half of it.
  Coverage: **Gap worth flagging** — a credential is one `site` string and
  `jiraFetch` pins every request to `https://${credential.site}`, so exactly one
  site is ever visible. Combined with JIRA-15's silent single-credential
  overwrite, a two-site user who connects the second site loses the first with no
  warning and no way to have both. The Connection tab's "Not built yet" list
  doesn't mention it, and the confirm step's "your work across every project you
  can see" is true only within one site — the copy reads as broader than it is.

- **JIRA-174** — An Atlassian account with no Jira product access
  Steps: Connect an account that exists on the site (Confluence-only, or a
  Jira licence that was removed) with a valid API token.
  Expected: A message that names the actual problem, distinguishable from a bad
  token and from a wrong site address.
  Coverage: **Not supported (untested/unknown)** — `/rest/api/3/myself` may
  answer 200 with a valid `accountId` for such an account, in which case
  `validateCredential` succeeds, the wizard shows "Connected", and the confirm
  step reports "0 issues, 0 projects" — a green connection to a site the user
  can't actually use. Or the site returns 403, which maps to "Your Jira account
  isn't allowed to do that." on a *connect* button, which reads as nonsense.
  Both outcomes are worth documenting; neither is handled deliberately.

- **JIRA-175** — The connected account is deactivated or removed mid-session
  Steps: With Waypoint open and connected, have a Jira admin deactivate the
  account (or remove its Jira licence). Then refresh the list, open a drawer,
  transition, and comment.
  Expected: The app should stop presenting itself as connected and should say
  what happened.
  Coverage: **Gap worth flagging** — distinct from JIRA-136 (revoked token) in
  its status code: a deactivated account gets **403**, not 401, so the user is
  told "Your Jira account isn't allowed to do that" for every action, which
  points them at permissions rather than at their account. And as with JIRA-136,
  `jira:status` is a local file read, so the sidebar and the Connection tab stay
  green indefinitely. Same underlying defect, materially more confusing message.

### Workflow variation and Jira-side automation

- **JIRA-176** — Transition menu labels are target statuses, not transition names
  Steps: Pick a workflow with a transition whose *name* differs from its
  destination status — e.g. a transition called "Send back to dev" that leads to
  status "In Progress", or "Reject" leading to "Done". Open Jira's own issue view
  and note the button labels. Open the same issue's menu in Waypoint.
  Expected: The user should be able to map Waypoint's options onto the ones they
  know from Jira.
  Coverage: **Gap worth flagging** — `mapTransition` uses `to.name` first and
  falls back to the transition's own `name` only when the destination is missing,
  so Waypoint labels the menu with *destinations* while Jira labels it with
  *transitions*. On workflows where they coincide (the common case) this is
  invisible; on a workflow with named transitions it means the list a user
  recognises and the list Waypoint shows have different words in them. The
  popover's footer — "These are the transitions your Jira workflow allows … —
  Waypoint doesn't invent them" — makes an accuracy claim this labeling doesn't
  quite honour. See correction to JIRA-68.

- **JIRA-177** — Two transitions leading to the same status
  Steps: Find a workflow where two distinct transitions land on the same status
  (e.g. "Won't Do" and "Duplicate" both → Done, or "Reject" and "Cancel" both →
  Closed). Open that issue's menu.
  Expected: The two options are distinguishable before choosing one.
  Coverage: **Gap worth flagging** — follows directly from JIRA-176: both entries
  render the identical `to.name` label with the identical status-category dot,
  so the menu shows the same word twice with no way to tell which is which.
  Picking the wrong one runs a different post-function and records a different
  resolution. Cheap to fix (fall back to, or append, the transition's own name
  when two options share a destination) and not currently covered.

- **JIRA-178** — A Jira automation rule fires on your transition
  Steps: On a project with an automation rule triggered by an issue transition
  (auto-assign on "In Progress", auto-transition to "Done" when a subtask
  closes, auto-set a field), perform that transition from Waypoint. Watch the
  row's state chip, then refresh and compare against Jira.
  Expected: The chip should not settle on a state that is already wrong.
  Coverage: **Gap worth flagging** — `transitionTicket()` POSTs and then
  immediately calls `getTicket()` to re-read. That re-read races the automation:
  land first and the chip shows the pre-automation state and stays there
  (nothing polls); land second and it shows the post-automation state. The
  outcome is nondeterministic and the UI presents both with equal confidence.
  The design decision to re-read rather than predict is right — this is about the
  window the re-read leaves open, which is exactly the founder's question and is
  covered nowhere. Note that no existing case exercises a Jira-side reaction to a
  Waypoint write at all.

- **JIRA-179** — An automation posts a comment in response to your comment
  Steps: On a project whose automation replies to comments (common on Service
  Management), post a comment from Waypoint's composer and keep the drawer open.
  Expected: Document what the user sees.
  Coverage: **Partial** — the same mechanism as JIRA-98 (`onPosted` appends
  locally, nothing refetches), but worth its own case because here the missing
  comment is a *direct consequence of the user's own action*: they will look for
  it, not see it, and reasonably conclude the automation didn't run. JIRA-98 is
  about a colleague; this is about the app hiding the result of what you just did.

- **JIRA-180** — A workflow validator rejects the transition
  Steps: Find a transition with a validator (e.g. "assignee must be set", "field
  X is required", a permission validator). Trigger it from Waypoint from a state
  that will fail.
  Expected: Jira's own validator message reaches the user, and the row's chip
  returns to the old state.
  Coverage: **Partial** — `messageFromErrorBody` reads `errorMessages[0]` and
  then the first string in `errors`, so a validator message should surface. But
  Jira reports validator failures inconsistently (some as `errorMessages`, some
  as `errors` keyed by field id, some as a plain 400 with neither), and the
  fallback is the bare "Jira returned 400." A validator is the single most common
  way a transition fails on a mature workflow, and JIRA-82 only tests that *some*
  error appears, not that the message is usable.

- **JIRA-181** — A transition that requires a comment
  Steps: Use a transition whose screen has a **required** comment field (a
  standard "Reject requires a reason" setup). Open its menu entry in Waypoint.
  Expected: A usable field for the comment, labeled as a comment.
  Coverage: **Gap worth flagging** — `mapTransitionField` keeps required fields
  and gives anything without `allowedValues` `type: 'text'`, which
  `JiraTransitionPopover` renders as a **single-line `<input>` with the hardcoded
  placeholder `e.g. 3h 30m`**. A required transition comment therefore appears as
  a one-line box that suggests you type a duration into it. Concrete, common, and
  a sharper instance of JIRA-75 than the date/user-picker examples that case uses.

### Volume, rate limits and multiple instances

- **JIRA-182** — Realistic burst usage against Jira's rate limits
  Steps: With a queue of 30+ issues, in quick succession: press Refresh now five
  times; open the transition menu on ten different rows; open six drawers. Watch
  the network calls and the UI.
  Expected: No duplicate in-flight requests for the same thing, and if Jira
  starts returning 429 the user is told.
  Coverage: **Gap worth flagging** — there is no debounce, no in-flight dedup and
  no request queue anywhere. Each popover open that misses the cache is one
  `/transitions` call (`getJiraTransitions` only caches *non-empty* results, so a
  genuinely dead-end issue is re-fetched every single open); each drawer is one
  comment call; each Refresh is 1–5 search calls. And per JIRA-133/JIRA-135 a 429
  on the list or transitions path is swallowed entirely — the good message
  identified in JIRA-138 is only reachable from a write. This is the case that
  makes JIRA-138 actually testable end to end.

- **JIRA-183** — Two Waypoint instances sharing one credential file
  Steps: Launch a second Waypoint process (run the binary/`npm start` twice —
  there is no single-instance lock). Open My Jira in both. Transition a ticket in
  instance A. Then press Disconnect in instance A and keep using instance B.
  Expected: At minimum, instance B should not keep presenting a connection whose
  credential has been deleted from under it.
  Coverage: **Gap worth flagging** — `main.ts` creates exactly one
  `BrowserWindow` and never calls `requestSingleInstanceLock()`, so the reachable
  scenario is two *processes* sharing one `~/…/jira-auth.json`, not two windows
  (see correction to JIRA-151). After A disconnects, B's `jiraStore` still holds
  `connected: true` — the sidebar item, the badge and the green Connected pill all
  persist — while every actual call now fails `requireCredential()` with "No Jira
  account is connected", which per JIRA-133 renders as an empty queue. Also worth
  recording that a *connect* from B silently overwrites A's credential (JIRA-15's
  overwrite, reached without either window knowing).

### Wizard lifecycle

- **JIRA-184** — Abandoning the wizard after connecting
  Steps: Open the "+" wizard, go to step 3, connect a real account successfully.
  Then close the modal (X, Escape, or backdrop) **without** clicking "Create
  project" on step 4. Check the sidebar and `/my-jira`.
  Expected: Whatever happens should match what the user thinks they did.
  Coverage: **Gap worth flagging** — `handleConnectJira` writes the encrypted
  credential to disk and calls `setJiraConnection(status)` the moment Connect
  succeeds, so closing the wizard afterwards leaves a fully live connection: the
  sidebar "My Jira" item appears, the route works, and the token is stored. The
  user cancelled a creation flow and got an account connected anyway. There is no
  "cancel undoes the connect" path and nothing says the Connect button is the
  point of no return.

- **JIRA-185** — Reopening the wizard while an account is already connected
  Steps: With Jira connected, click "+" → Companion project → Jira → Continue to
  step 3.
  Expected: The step should reflect that an account is already connected.
  Coverage: **Gap worth flagging** — `AddProjectWizard` keeps `connectionStatus`
  in **local** state, reset to `null` by `resetAll()` on every close, and never
  reads `jiraStore` or `getJiraConnectionStatus()` on open. So step 3 shows an
  empty connect form, gives no hint that an account is connected, and — because
  `nextDisabled` on step 3 is `!connectionStatus?.connected` — cannot be advanced
  past *without re-entering a site, email and a fresh API token*. The credential
  that connect then writes silently replaces the existing one (JIRA-15). This is
  the concrete, reachable path into JIRA-15's silent overwrite, and it's also the
  only path a user has to change accounts, which makes it worth its own case.

- **JIRA-186** — "1 API call to load" on the confirm step
  Steps: On step 4, read the "1 · API call to load" stat. Count the actual
  requests the connect flow made (DevTools network, or main-process logging).
  Expected: The number shown should be the number of calls.
  Coverage: **Gap worth flagging** — `connectJira()` performs one
  `GET /rest/api/3/myself`, then `listMyJiraTickets()`, which is 1 to 5
  `GET /rest/api/3/search/jql` calls depending on queue size, then a local status
  read. So the minimum is 2 and the maximum is 6 — never 1. Small, but it is a
  hardcoded number presented as a measurement on the same screen as the two
  counts JIRA-11 correctly praises for being real, and it is the same class of
  finding as JIRA-19 and JIRA-131's "~400ms".

### Everyday failure composites, scope boundary, and consistency

- **JIRA-187** — Launching offline with Jira connected
  Steps: Connect Jira. Quit Waypoint. Disable networking. Launch Waypoint and,
  without touching anything else, look at the sidebar, then open My Jira, then
  open a ticket drawer, then try a transition.
  Expected: The app should not claim to be showing a current, complete queue.
  Coverage: **Partial** — the composite this case was written to name is gone.
  JIRA-123 and JIRA-133/134/135 are fixed, so offline-at-launch now shows a muted
  "not synced yet" instead of a pulsing green "synced 0s ago", and the list, the
  drawer's comments and the transition menu each read "Couldn't load … Couldn't
  reach Jira. Check your connection and try again." with a Try again button.
  What survives is JIRA-136's half: the sidebar still shows "My Jira" with a
  badge of **0** (the credential read is local and succeeds; `lastTickets` is
  empty), and the Connection tab still shows a green "Connected" pill for a site
  the app cannot reach. So the app no longer *claims* a fresh, empty queue — but
  two of its status surfaces still read as healthy. Worth running exactly as
  written, against those two.

- **JIRA-188** — An unposted comment draft when the drawer closes
  Steps: Open a drawer, type several paragraphs into the composer without
  posting. Press Escape. Reopen the same ticket.
  Expected: The draft survives, or the user is warned before it doesn't.
  Coverage: **Gap worth flagging** — the composer's `draft` is local `useState`
  in a component that unmounts with the drawer, and the drawer closes on Escape,
  on the X, and on any backdrop click with no guard. A half-written comment is
  gone silently, including from a misfired Escape aimed at a transition popover.
  Waypoint has a Drafts feature of its own (the DRAFT section of this sheet), so
  this is below the app's own established bar in the same way JIRA-84 and
  JIRA-112 are.

- **JIRA-189** — There is no way to see anyone else's queue
  Steps: Try, from within My Jira, to see a teammate's work: look for an account
  switcher, an assignee filter listing other people, an editable JQL box, a
  "team" view, or any control that would answer "what is Priya working on".
  Check the drawer and the Connection tab too.
  Expected: None exists, and nothing in the copy implies one does.
  Coverage: **Not supported (by design)** — the JQL is `currentUser()`-pinned in
  `jiraClient.ts` and printed read-only on the page, the credential is a single
  personal API token, and the only assignee shown anywhere is a display name with
  no filter attached. Recording this as a *deliberate, verified* boundary matters
  because "My Jira" is a personal mirror by design and a manager-view request is
  the most predictable scope-creep pressure this feature will face; there should
  be a case that pins the boundary rather than leaving it implicit. Same reason to
  note here that the fixed JQL means none of `membersOf()`, `openSprints()`,
  `endOfWeek()` or a user's own saved filters are reachable (JIRA-114/115).

- **JIRA-190** — Filter chip counts ignore the other active filter
  Steps: With issues across several projects, click the "Reported" role chip.
  Now read the "All N" chip and each project chip's number. Click a project chip
  and count the rows that appear.
  Expected: A chip's number should predict how many rows clicking it produces.
  Coverage: **Gap worth flagging** — in `MyJiraPage`, `projectCounts` and the
  "All {tickets.length}" chip are both computed from the **unfiltered** `tickets`
  array, while only the "N issues · M Jira projects" summary line uses `filtered`.
  So with a role filter active, "ENG 12" can produce 3 rows, and "All 30" can
  produce 8. The two numbers sit inches apart on screen and disagree. Not caught
  by JIRA-26 or JIRA-29, both of which only check the summary line.

---

## 3. Corrections to existing cases

### 3.1 JIRA-02 — Expected names an avatar that cannot render
"the form is replaced by the real account's avatar" is wrong. `ConnectStep`
renders `<Avatar name={connectionStatus.accountName} />` — the app's
initials-in-a-circle component. Jira's real avatar URL *is* fetched by
`validateCredential`, stored in `JiraCredential.avatarUrl` and carried across IPC
in `JiraIdentity`, but `JiraConnectionStatus` (the renderer-facing type) has no
`avatarUrl` field at all, so nothing downstream can display it.
**Fix:** change Expected to "an initials avatar, the display name, the email and
the site", and add a note that the fetched avatar URL is dead data — the same
class of finding as JIRA-119's dropped watcher count, but here the field was
plumbed two layers and then dropped at the last one.

### 3.2 JIRA-11 — accepts an unverified claim
The Expected repeats "1 API call to load" as if it were a fact to observe. It
isn't: connect makes 1 `/myself` + 1–5 `/search/jql` + a local status read.
**Fix:** keep the issue/project-count assertions (which are correct and well
reasoned), and move the call-count claim to new **JIRA-186** as a Gap.

### 3.3 JIRA-29 — Expected asserts a consistency that doesn't hold
"Intersection of both, with the count line consistent" is only half right. The
summary line is consistent; the chip counts are not, because they're derived
from unfiltered `tickets`.
**Fix:** downgrade to **Partial**, restrict the Expected to the summary line, and
cross-reference new **JIRA-190**.

### 3.4 JIRA-68 — "Identical sets" is the wrong assertion
Jira's own issue view labels workflow actions with **transition names**;
`mapTransition` labels them with `to.name`, the **destination status**. On a
workflow with named transitions the two lists contain different words, and on a
workflow with two transitions to one status Waypoint's list contains the same
word twice.
**Fix:** re-word Expected to "every destination Jira offers is present, and no
destination Jira doesn't offer appears", and add new **JIRA-176** / **JIRA-177**
for the labeling problem.

### 3.5 JIRA-70 — Steps are not reliably executable
"Pick a transition with no 'needs a field' badge" assumes such a transition is
findable. The badge renders on `requiresFields.length > 0`, and
`mapTransitionField` **keeps optional time-tracking fields**, so on any workflow
where transition screens carry time tracking, every option is badged and the
tester has nothing to pick.
**Fix:** state the precondition precisely — "a transition whose Jira transition
screen has no fields at all" — and note the fallback if none exists.

### 3.6 JIRA-71 — assumes exactly one required field
The popover's body copy is hardcoded to `formTransition.requiresFields[0]?.label`
("requires a Resolution") and its heading says "Jira needs **one** more field",
while the form below maps and renders *every* required field. A transition
requiring two fields displays copy naming only the first.
**Fix:** add a second Steps/Expected pair for a two-required-field transition,
and downgrade to **Partial**.

### 3.7 JIRA-73 — Coverage understates two concrete defects
The case correctly identifies the missing duration-format validation, but misses
two things visible in the same components:
(a) an **optional** time-tracking field still produces the "needs a field" badge
and the "Jira needs one more field" heading — the app asks for something it
labels as required and isn't;
(b) the `e.g. 3h 30m` placeholder is on **every** `type: 'text'` input in
`JiraTransitionPopover`, not just the time-tracking one.
**Fix:** fold both into the Coverage note; (a) also breaks JIRA-70's Steps.

### 3.8 JIRA-75 — incomplete on the same point
The case is right that a date or user picker collapses to a free-text box. It
should add that the box is labeled with the placeholder `e.g. 3h 30m`, so the
user isn't merely unguided — they're actively misdirected toward entering a
duration. See also new **JIRA-181** (required comment field), which is a more
common instance of this than a cascading select.

### 3.9 JIRA-86 — an unflagged prerequisite
"a long-running ticket with over 100 comments" is a real precondition most
testers won't have and can't produce in an afternoon. JIRA-31 handles the
equivalent problem honestly ("or simulate"); this one doesn't.
**Fix:** add "(or temporarily lower `maxResults` in `jiraClient.ts` to reproduce
in a scratch build)" and list the prerequisite in the section header.

### 3.10 JIRA-110 — the reasoning is aimed at the wrong risk
Jira project keys cannot contain hyphens (they're `[A-Z][A-Z0-9]+`), so "keys
with more than one hyphen" isn't a reachable case and a tester will waste time
looking for one. The genuine risk in `{projectKey}-{ticket.key.split('-')[1]}`
is that the two halves come from **different sources** — `projectKey` from
`fields.project.key` (with a `key.split('-')[0]` fallback) and the number from
`ticket.key` — so they can disagree whenever those two disagree, which is
exactly what a project move produces.
**Fix:** re-aim the Steps at a moved issue and merge with JIRA-111, which is
already about project moves.

### 3.11 JIRA-141 — one mechanism claim is wrong
"the Connection tab renders `<SkeletonListRows />` forever when `connection` is
falsy" is only true outside Electron. In the normal disconnected case
`useLoadedJiraConnection` resolves to a real `JiraConnectionStatus` object with
`connected: false`, so the skeleton is transient and what actually renders is the
**Disconnected panel** — an empty-initial avatar, a bare " · " line, a grey
"Disconnected" pill, and both buttons disabled. The finding (no connect CTA
anywhere) stands and is correct; the mechanism as written would come back as a
mismatch during execution.
**Fix:** correct the mechanism, keep the Gap.

### 3.12 JIRA-151 — the premise isn't reachable
`main.ts` constructs exactly one `BrowserWindow` and there is no window-spawning
path, so "two Waypoint windows" cannot be staged and the case will be filed NOT
TESTED for the wrong reason. The real and more interesting scenario is two app
**processes** (there is no `requestSingleInstanceLock`) sharing one
`jira-auth.json`.
**Fix:** replace with new **JIRA-183**, which also covers the disconnect-under-
the-other-instance case.

### 3.13 JIRA-53 / JIRA-57 — effectively one case
JIRA-57's own Coverage says it is "the sharpest form of JIRA-53", and its Steps
("have someone reassign away an issue you were assigned but did not report and do
not watch") are a strict specialisation of JIRA-53's. Both need a second person,
neither says so.
**Fix:** merge into one case with two Steps variants (still-reporter vs.
no-remaining-role), or keep both but make JIRA-53's Steps explicitly the
still-a-reporter path so they aren't testing the same thing twice.

### 3.14 Untestable-without-a-prerequisite, nowhere flagged — the biggest planning problem
The section's Preconditions block names only the feature flag and "a real
Atlassian Cloud account with an API token." At least these cases need more than
that, and none of them says so:

| Prerequisite | Cases |
|---|---|
| A **second real Jira user** to act as the other party | JIRA-53, 56, 57, 98, 120, 126, 127, and new 179 |
| A project where the connected account **lacks transition permission** | JIRA-77 |
| A **restricted/internal comment** (realistically a JSM project) | JIRA-97, and new 171 |
| A **>100-comment** ticket | JIRA-86 |
| A **>500-issue** queue | JIRA-31 |
| A site with a **custom priority scheme** | JIRA-35 |
| A **JWM/JSM site with no sprint field** | JIRA-63 |
| A **self-hosted Jira Server/DC** instance | JIRA-17 |
| **Revoking a token** / a token near expiry | JIRA-136, 137 |
| A machine with **`safeStorage` unavailable** | JIRA-16 |

That is ~18 of 152 that cannot be executed by one person on one account in one
sitting. **Fix:** add a Prerequisites table to the section header stating which
cases each unlocks, so the execution pass is scheduled around them rather than
discovering them one at a time and filing a run of NOT TESTED verdicts.

### 3.15 ~20 cases have no pass/fail criterion
JIRA-14, 15, 17, 24, 30, 33, 45, 47, 48, 49, 58, 78, 84, 95, 96, 105, 106, 112,
119, 128 and 132 all have an Expected of the form "Document what happens" or
"Document that none exists." As an *authoring* posture that's defensible and I'd
defend it — the author didn't want to assert an outcome they hadn't observed.
But as written, an execution pass over them produces prose, not verdicts, and
the Summary table at the end of this sheet has no bucket for "documented."
**Fix:** give each a binary assertion it can PASS or FAIL against — e.g. JIRA-112
becomes "no text input, key lookup or filter-by-title control exists on the My
work tab, and Cmd+K returns no Jira results", which is checkable in thirty
seconds and fails loudly if someone adds one later. This costs one line per case
and converts a fifth of the section from notes into regression coverage.

### 3.16 JIRA-36 — two scenarios in one case
"Connect an account with no unresolved issues in any role (**or** filter to a
project/role combination with none)" bundles a case needing a whole extra
account with one executable in two clicks, and they have *different* correct
expected results (a genuinely empty queue should say something like "nothing
assigned to, reported by or watched by you" — a filter miss should say what it
currently says).
**Fix:** split into JIRA-36a (empty filter combination, executable now,
**Supported**) and JIRA-36b (genuinely empty queue, prerequisite: second
account, **Partial**).

### 3.17 JIRA-19 — right finding, understated placement
This is the sharpest honesty finding in the section and it's buried as the last
item of "Connection & account setup". Given the app's stated honesty discipline
(and that the Summary's "What held up well" section specifically praises that
discipline holding "with no exceptions found" elsewhere), a banner claiming a
priority write that has no code path is the headline result of this whole round.
**Fix:** no change to the case itself — it's accurate. Promote it in whatever
prioritised list the execution pass produces, alongside JIRA-133 and JIRA-136.

### 3.18 JIRA-127 — mis-filed and near-redundant
"Last-write-wins on a comment race" is filed under "Staleness, concurrency and
conflicts", but its Coverage concludes there is no conflict and defers the entire
finding to JIRA-98 in "Collaboration & comments". It's a collaboration case
wearing a concurrency label.
**Fix:** move it next to JIRA-98, or fold it in as a second Expected on that case.

---

## 4. Structural feedback

The 14-subsection breakdown is close to right and I'd keep its spine. Four
changes:

**Add "Rendering, layout and accessibility."** Zero of 152 cases touch how any of
this looks or whether a keyboard user can operate it. That's the largest single
structural hole and it's where new JIRA-153 (clipped popover) lives — a defect
that a purely code-reading pass structurally cannot find, because the bug is in
the interaction between two files' CSS rather than in either file's logic.

**Add "Identity, tenancy and permissions."** Service accounts, multi-site orgs,
issue security levels, field-level restrictions and deactivated accounts are
currently either absent or scattered into "Connection & account setup", which is
really about the *connect form*. These are a distinct risk area: they're the
cases where the app shows the user something confidently wrong rather than
failing.

**Merge the two triage subsections.** "Due dates, priority views and overdue
work" (3 cases) and "Search, sort and saved views" (5 cases) are both really
"triage affordances that don't exist" — JIRA-33, 50, 51, 52 and 112 are five
statements of one finding. One subsection called "Triage: search, sort, filter,
due dates" would make the aggregate size of that gap legible, which the current
split actively obscures. Related: consider pulling all the deliberate-scope
negatives (JIRA-61, 65, 104, 114, 115, 116, 121, and new 189) into a single
**"Out-of-scope boundary"** subsection. Their shared purpose is proving a stated
boundary holds, and they read very differently as a group than as one-offs
scattered among defect cases.

**Three mis-filings.** JIRA-111 (issue moved between projects) sits under
"Content & structure — descriptions, attachments, links, time" but is a lifecycle
case; it belongs with "History & reassignment". JIRA-63 and JIRA-64 (sprint field
absent, issue in multiple sprints) are field-mapping cases filed under "Sprints,
backlog and boards" alongside pure scope-boundary assertions; they belong with
"Categorization". JIRA-127 as noted in §3.18.

**One addition to the format, not the structure:** add a **Severity** tag
alongside Coverage. Twenty-one cases carry "Gap worth flagging" with no ranking,
and JIRA-133 (every list error renders as an empty queue), JIRA-136 (a dead token
still shows green forever) and JIRA-19 (a banner claiming a capability that
doesn't exist) are not the same order of problem as JIRA-39 (three colors for
four projects). The founder will read 21 flagged gaps and have no way to know
which three to fix first. The bucket answers "does it work"; it doesn't answer
"does it matter."
