# Shell UX v3 — one sidebar, not two

Status: design proposal, not yet built. Companion file:
`docs/design/shell-ux-v3-mockup.html` (open it — the transition is the
point, this doc is the argument for it). Visual language matches
`docs/design/provider-ux-v2-mockup.html` (tokens, type, reviewer-bar
pattern) and carries over `shell-ux-v2.md`'s IA and finish-defect analysis
where nothing here overturns them. Ticket: **ROAD-159**.

## The rule, stated once

> **The sidebar is always the same 56 px rail. Pinning it open — one
> global on/off switch, not a per-page behavior — is the only thing that
> ever makes it wider, and it stays that width everywhere until you
> switch it back.**

That sentence is the acceptance test this document has to pass. Read
`layouts/AppShell.tsx:20` today and try to say its rule in one sentence:
you can't, without saying "except on `/sessions`" — which is exactly the
founder's complaint ("I do not know why it is so inconsistent"). A rule
with an exception clause is a rule a user has to have the bug happen to
before they learn it. The rule above has no exception clause. It doesn't
need one, because it no longer depends on the route at all.

---

## 1. The central question: generalize the fold, or delete it?

Two proposals are on the table.

**A — Keep two shells** (`shell-ux-v2.md` §2): keep `isFocusWorkspace()`
exactly as architected, add a second member (Review's detail view) to the
focus-route table, polish the fold's finish (solid border, a "Sidebar"
label, a coach mark). The rail still only appears on some routes; there
are just two of them instead of one.

**B — One shell everywhere** (this document): delete the concept of a
focus route entirely. The rail is not a special mode a subset of pages
opt into — it is the sidebar, full stop. What today reads as "the normal
sidebar" is the rail pinned open; what reads as "the focus rail" is the
same component unpinned. There is exactly one boolean, it is global, and
the router never touches it.

### Why B and not A

**A does not fix the defect it's built to fix — it relocates it.**
`isFocusWorkspace()` today matches one regex. Under A it matches two
routes via a short table. The founder's diagnosis was never "the table
has too few rows," it was "I cannot predict when this happens." A
two-row table is exactly as unpredictable as a one-row table to a person
who hasn't memorized which routes are in it — they will hit Review's
detail view, watch the chrome refold, and have the identical "wait, where
did my sidebar go" reaction the ticket opens with, just on a different
page. Worse: the table is a standing liability. The next surface that
plausibly wants width — a diff view, a doc editor, a future transcript
somewhere else — is a judgment call someone has to remember to make, and
get right, forever. A's own mechanism is what produced the bug being
fixed. Route-conditional chrome doesn't stop being route-conditional
chrome because the route list grew by one.

**A also asks the user to hold a second piece of state in their head that
B doesn't: "is this a page that folds, or one that doesn't."** That's a
classification a person builds by trial and error over weeks of usage,
page by page, and it's invisible until it fires — the exact complaint.
B asks the user to hold nothing. The rail is just what the sidebar looks
like; wider is a click away, anywhere, and it comes back the same width
next time, anywhere.

**B costs the thing A protects — labels visible by default on pages that
aren't cramped — and that cost is real, so it's worth being honest about
it, not waving it away:**

- Under B's default (pinned/full — see §2), nothing changes for a user
  who never touches the toggle: the app looks exactly like today's
  "normal sidebar" everywhere, including on `/sessions`, until they
  choose otherwise.
- The moment they unpin — because a transcript or a diff wants the room
  — that choice is now permanent and global instead of local and
  automatic. If they then go read Home with the rail still collapsed,
  the labels are gone there too, whether or not Home needed the width.
- This is the trade the one-sentence rule is buying: a *little*
  inconvenience on pages that didn't need the width, in exchange for
  *zero* surprises anywhere. Given the founder's own words — "the UX
  needs to be consistent," stated with no qualifier about which pages —
  consistency is the more valuable of the two, and the peek interaction
  (hover the rail, get the full panel as a temporary overlay, no
  commitment) is specifically what makes the cost small: full nesting
  and labels are one hover away even collapsed, on every page, not
  reachable only via a special affordance that exists on some pages and
  not others.

**A's own author flagged the tell.** `shell-ux-v2.md` §2.4 has to add a
rule saying *don't* extend focus mode to ticket/project detail views,
because those already solve "give this more room" with drawers instead.
That's a second width-negotiation mechanism sitting next to the first one
in the same shell, with a written rule to keep them from colliding. B
doesn't need that rule, because there's only one mechanism: the sidebar
is 56 px by default everywhere, and any page that wants more room already
has it, for free, without asking the shell to change shape for it.

**What A gets right, B keeps.** The mechanics — 56 px rail, `⌘B`, peek
(200 ms hover → overlay, no resize), pin (persisted), 150 ms width tween,
`prefers-reduced-motion` — are good, and none of the argument above is
about the mechanism. It's about what decides when the mechanism fires: a
route table (A) or the user, once, globally (B).

### Where the honest answer is "delete this rather than design it"

`isFocusWorkspace()`, the `focusWorkspace` prop threading through
`AppShell`/`Sidebar`, and the route-conditional `showRail` branch in
`AppShell.tsx:98` should be deleted outright, not extended. There is
nothing in the current architecture worth generalizing — it's a
single-purpose conditional that did its job for one route and was never
built to be a general layout primitive (compare: `w3-sessions-rail.md`
§1.2 titles it "My sessions" throughout, not "focus workspace" — the
generalization was retrofitted in v2's own proposal, not present in the
original design). Building A means keeping that retrofit and adding a
maintenance obligation on top of it. Building B means deleting it and
replacing the whole "is this page special" question with "is the pin on."

---

## 2. The mechanism, generalized

One component (`Sidebar.tsx` absorbs `SidebarRail.tsx` — see §6), one
piece of state, no route input anywhere in it.

1. **Always rendered as the 56 px rail**, full stop — the width used to
   be conditional on the route; now it's the base state, period.
2. **`pinned: boolean`**, global, persisted at `waypoint:sidebarPinned`
   (the key survives unchanged — see §6 for the one-time migration this
   implies). Pinned → the panel renders at 256 px in the document flow,
   pushing content over, everywhere, until unpinned. This is the only
   thing that changes the rail's width, and it is never read from
   `useLocation()`.
3. **Peek**, unchanged from today's mechanism: hovering the rail's own
   expand control for ≥ 200 ms overlays the full 256 px panel on top of
   the workspace (`position: absolute`, `z-40`, matching
   `w3-sessions-rail.md` §1.3) without resizing anything underneath;
   moving off it with a 300 ms linger closes it. This is what keeps the
   labels-hidden cost in §1 small — full nav is one hover away on every
   route, not gated to routes that happen to render the full panel.
4. **`⌘B`** toggles the pin, globally, from anywhere — not gated to a
   route family (`AppShell.tsx:106-121`'s `if (!focusWorkspace) return`
   guard is deleted along with the rest of the conditional).
5. **Default: pinned (256 px), matching today's non-`/sessions` behavior**
   — see the trade-off in §1. First run and every existing user land on
   the shell they already know; the rail is discovered by unpinning it
   once (⌘B, the collapse chevron, or the coach mark in §5), not imposed
   as a new default nobody asked for.
6. **150 ms width tween**, `prefers-reduced-motion` respected — unchanged
   from today, now the only transition the shell ever runs, because
   there is only one state machine left to animate.

Net effect on the pixel budget `w3-sessions-rail.md` §1.6 cared about:
unchanged when unpinned (56 px rail either way), and now available on
*every* route, not only `/sessions*` — Review's diff view, or anything
built later that wants width, gets it automatically, with no table entry
required. That's what "generalized" should have meant.

---

## 3. Information architecture

Unchanged from `shell-ux-v2.md` §4 — that analysis is sound and nothing
about the one-shell decision affects it. Restated here so this doc is
self-contained, against the surviving item set (Drafts, Scratchpad, and
the Notifications *row* are assumed already removed per ROAD-160 and the
topbar-bell consolidation; this doc designs against the result, not the
deletion):

```
[Workspace name]                              ← logo + name, hairline below
────────────────────────────────────────────
Home
My work
My sessions                                    · alert badge
My Jira                                         · count badge  (conditional)
────────────────────────────────────────────
Review                                          · alert badge
────────────────────────────────────────────
Projects                                                              [+]
  All projects
  All tickets
  ▸ Compass Web                                 · ~/code/compass-web
      Tickets · Sprints · Workstreams · Views · Requests · Docs
  ▸ Jira Import (POC)
  ▸ Product Launch                              · count badge
  ...
────────────────────────────────────────────
Archive
Analytics
Workspace settings

[Local · 4 repos · Claude ready]                ← unchanged status strip
```

- No "Agent output" section label above a single item (Review) — a
  caption on one row isn't a group.
- "My work / My sessions / My Jira" stay grouped, unlabeled, directly
  under Home — self-evident from position, the way the row above
  Projects already goes unlabeled today.
- The projects tree is unchanged structure; this pass doesn't touch it.
- `g`-chord hints surface on row hover in the pinned panel (`g h`, `g m`,
  `g e`, `g r`, `g a`, `g l` — all already bound in
  `useGlobalKeyboardShortcuts.ts`), the same way the topbar search field
  already shows `⌘K` inline. Free discoverability for a system that
  already works.
- **Collapsed (rail) mapping**: Home, My work, My sessions (badge),
  Review (badge), Projects (one icon, hover flyout — `ProjectsFlyout`
  unchanged), Settings, Local dot. My Jira joins the rail set when
  connected (it didn't in the original W3 rail because W3 predates My
  Jira's sidebar promotion — Fix 9 in the customer-feedback pass moved it
  to always-visible, so the rail needs to carry it too, or the same
  "why did this disappear" complaint recurs for Jira users specifically).
  Archive and Analytics stay panel-only, reachable via peek or `⌘K` —
  utility rows, not primary nav, the same judgment call W3 already made
  for six of today's nine items.

---

## 4. Finish defects — fixed, not just cited

Each of these is cited from the running code (screenshotted at
1728×1080 against the live app, and against `Sidebar.tsx`/
`SidebarRail.tsx` directly), matching `shell-ux-v2.md` §5's findings.
Fixes below apply once, to the single merged component, instead of twice.

1. **Dashed border on the expand affordance
   (`SidebarRail.tsx:252`, `border-dashed border-border-strong`).** This
   design system uses dashed borders for placeholders (empty states,
   "add new" outlines) — a shipped, working control wearing that
   convention tells the eye "unfinished" every time it's seen, which is
   most of the time given the rail is now the default-visible state
   everywhere. Fixed: solid `border-border-strong`, matching every other
   real control in the shell. No dashed border appears anywhere in v3.
2. **Two active-state treatments in one sidebar** (`Sidebar.tsx:60-62`
   top-nav `bg-accent-soft-bg text-accent-soft-text font-medium` vs.
   `Sidebar.tsx:209` folded-project-row `bg-surface-2/60` with no text
   change). Fixed: one active treatment, `accent-soft-bg` +
   `accent-soft-text` + `font-medium`, applied everywhere something is
   "current" — top nav, rail items, and the folded-project row alike.
3. **No declared icon-size scale** (15 / 17 / 13 / 12 px across
   `Sidebar.tsx` and `SidebarRail.tsx`). Fixed: two sizes, period —
   **16 px** for anything that's a primary nav target (top-level items,
   rail items — matches the topbar's own `IconBell` at 16, `Topbar.tsx`),
   **13 px** for anything secondary (sub-nav rows, the settings gear,
   chevrons, inline affordances). Declared as `--icon-primary: 16px` /
   `--icon-secondary: 13px` in the mockup; every icon in the shell maps
   to one of the two, no per-call-site judgment left.
4. **Two independently-implemented badges** (`CountBadge`/`AlertBadge` in
   `Sidebar.tsx:67-90`, flat pills with no ring; `RailBadge` in
   `SidebarRail.tsx:47-59`, same colors plus `ring-2 ring-bg-inset`
   because it floats over an icon). Fixed: one `Badge` component,
   `context: 'inline' | 'floating'` (ring only in floating context) ×
   `tone: 'neutral' | 'alert'` (color only). Same component, same source
   of truth, used at every call site in both the panel and the rail —
   there's no longer a "panel version" and a "rail version" to keep in
   sync, because collapsing/expanding doesn't remount into a different
   component tree.
5. **Undeclared spacing scale** (`my-3` / `mt-2` / `mt-1`, no visible
   logic — `Sidebar.tsx:493`, `510`, `540`, `525`). Fixed: a four-step
   token, `--space-1: 4px` / `--space-2: 8px` / `--space-3: 12px` /
   `--space-4: 16px`. Applied with actual logic instead of per-section
   eyeballing: `--space-3` between labeled groups (the hairline
   separators), `--space-1` inside a group between related rows. Row
   height/padding (32px / 8px) is unchanged — it was already fine.
6. **No separation between the workspace header and the nav below it**
   (`Sidebar.tsx:426-460` — logo + name sits on padding alone, no border).
   Fixed: a full-bleed hairline border under the header row, in both the
   pinned panel and the rail (the rail already half-does this today at
   `SidebarRail.tsx:257`, but centered at 26px instead of full-width —
   made consistent and full-bleed in both widths).
7. **The rail's projects flyout and the panel's project tree disagree on
   "more projects exist"** (`SidebarRail.tsx:37` caps at 6 with a text
   row; the panel just scrolls). Left as `shell-ux-v2.md` §5.7 flagged
   it — minor, not in this pass's critical path, worth a follow-up once
   the flyout and the tree are the same component's two render paths
   rather than two files (§6), since fixing it once there fixes it in
   both places by construction.

---

## 5. Making the transition read as deliberate

The width change itself (§2.6) is unchanged and already reads as
intentional — the problem was never the tween, it was that a user only
ever saw it once, on one route, with nothing to compare it to. B fixes
that by construction: the same collapse/expand now happens on every
route, so a user learns it the first time they touch the pin control
anywhere, and the same interaction is already-known everywhere else.

A one-time, dismissible coach mark still earns its keep for a first-run
user who has never touched the pin at all: the first time the shell
mounts, "Pin the sidebar open anytime — hover the arrow to peek, click to
keep it open," stored alongside `waypoint:sidebarPinned`. Shown once,
ever, regardless of which route it happens to mount on first — not
per-route like v2's proposal, because there's no longer a "first focus
route" to key it off.

---

## 6. Build plan — what actually changes

- **Delete**: `isFocusWorkspace()`, the `focusWorkspace` computation and
  prop-threading in `AppShell.tsx`, `SidebarRail.tsx` as a separate file,
  `Sidebar.tsx`'s `onCollapse` prop (collapsing is no longer conditional
  on being inside a focus workspace — it's just what the pin control
  does, always available).
- **Merge**: `Sidebar.tsx` gains a `pinned: boolean` render path instead
  of being one of two components `AppShell` chooses between. The rail
  markup (icons, `ProjectsFlyout`, badges) and the panel markup become
  two branches of one component sharing one `navItems` data structure,
  so the IA (§3) and the badge/icon/spacing tokens (§4) are declared
  once and rendered twice, not maintained in two files that happen to
  agree.
- **`AppShell.tsx`**: owns one `pinned` state (renamed from
  `showRail`'s inverse — same `waypoint:sidebarPinned` key, no migration
  needed since the value's meaning — "is the full panel open" — is
  unchanged, only what decides whether to *ask* it changes), the peek
  overlay, and `⌘B`, all unconditional on route. `useLocation()` is no
  longer imported by `AppShell.tsx` for this purpose (it's still needed
  for the run-focus navigate effect at line 125 — unrelated).
- **Migration risk**: near zero. Existing users' `waypoint:sidebarPinned`
  value already means "keep the full panel open" (it was written that
  way for the focus-workspace pin) — it now just applies globally
  instead of only inside `/sessions*`, which for the overwhelming
  majority of existing users (who never visited `/sessions` unpinned)
  means nothing observable changes on upgrade.
- **Tests**: `AppShell.rail.test.tsx` and `AppShell.flag-disabled.test.tsx`
  need rewriting against the new unconditional pin state rather than
  route-based fixtures; `Sidebar.sessions.flag-on.test.tsx` and
  `Sidebar.review-badge.test.tsx` continue to exercise the merged
  component's panel branch unchanged.

---

## 7. What the mockup shows

`shell-ux-v3-mockup.html` is self-contained (no build step), light **and**
dark, with a reviewer bar (matching `provider-ux-v2-mockup.html`'s
pattern) that switches between:

- **Rail** (default/unpinned) — Home, on the far side of the fold, proving
  the rail is not sessions-specific: this is what *every* route looks
  like unpinned, shown here on a page that has nothing to do with
  sessions.
- **Panel** (pinned) — the same Home route, same data, pin on — the full
  IA from §3, the finish fixes from §4.
- **Sessions, rail** — `/sessions`, unpinned — same rail as the Home
  screenshot above it, same component, proving the point: nothing about
  this page's chrome differs from Home's except the content to its
  right.
- **Peek** — rail state, hovering the expand control, panel overlaid
  without resizing the workspace underneath.
- **First run** — the one-time coach mark from §5.

A live width-tween control (not just static endpoint screenshots) lets
the founder drag or click through the 150 ms collapse/expand itself, on
more than one route's content, to see that it is the same motion
everywhere rather than reading the claim.

Nothing in the mockup is wired to real data; every count, name and
ticket is representative copy, not a data contract.
