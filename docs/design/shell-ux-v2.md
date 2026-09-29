# Shell UX v2 — left sidebar and application shell

Status: design proposal, not yet built. Companion file:
`docs/design/shell-ux-v2-mockup.html` (open it, don't just read this).
Visual language matches `docs/design/provider-ux-v2-mockup.html` (the most
recently built, best-liked reference) — same tokens, same reviewer-bar
pattern for switching states.

This responds directly to the founder's own diagnosis:

> "Notifications and scratchpad: I do not know why we even have them.
> Whenever I go into sessions, it becomes a rail. Otherwise, it's a normal
> sidebar. I do not know why it is so inconsistent... the most problematic
> section of the app is currently the left-hand sidebar. It is very
> difficult to go to an agent session."

Every claim below is checked against the code as it exists today
(`waypoint-frontend/src/renderer/layouts/{AppShell,Sidebar,SidebarRail}.tsx`,
`capabilities.ts`, `pages/sessions/`, `components/sessions/`), not against
what the docs say it does. Where a doc (`w3-sessions-rail.md`,
`w4-start-session.md`) describes something the code doesn't actually do,
that's called out explicitly — it's a second, smaller instance of the same
honesty problem `capabilities.ts` exists to catch.

---

## 1. The three dead nav items

| Item | Verdict | Why |
|---|---|---|
| **Notifications** | **Delete the sidebar row. Keep the topbar bell.** | `layouts/Sidebar.tsx:477-481` and `layouts/Topbar.tsx:410-414` are two separate controls that both navigate to `/notifications` — the sidebar row is a straight duplicate of a control that already exists in the topbar, on top of being dead. There is nothing to consolidate *into*; one of the two copies is just redundant chrome. Keep the topbar bell (badge included) as the single home for this. The schema, read API and page can stay — they're not the problem, the second, dead entry point is. |
| **Drafts** | **Delete the nav item and the route.** | You said it yourself: this arguably shouldn't be a destination. `CreateTicketModal.tsx` never sets `isDraft`; nothing autosaves. A list that structurally can never fill is worse than an empty state — it's a standing lie about a feature that doesn't exist yet. If ticket-draft autosave gets built later, don't resurrect this as a top-level nav row: surface it as a "Resume draft" affordance on the **New ticket** control itself (the thing that would have produced the draft), the way a browser tab or Notion resumes unsent work at the point of creation, not in a separate graveyard page nobody thinks to check. |
| **Scratchpad** | **Delete the nav item and the page.** | Two problems stack here: (1) the founder doesn't know why it exists — no stated product thesis, and it doesn't fit "PM companion syncing external trackers" — and (2) editing is actively broken (`scratchNotes.service.ts` has no `update`; "editing" is delete-and-recreate, which **reassigns the note's color at random** on every edit — a bug a user will notice and never fully trust an explanation for). This isn't a capability gap to caveat with `<NotWired/>`; it's a feature with no reason to exist in its current form. Remove it. If personal scratch notes turn out to be wanted, they belong as a mode of the Copilot panel (which already has a persistent per-user surface) rather than a seventh sidebar destination — that's a separate product decision, not a UI patch. |

Net effect: **9 top-level items → 6** before any other IA change, with zero
loss of anything that currently works.

### `capabilities.ts` gap

The prompt's own framing is correct: this file is accurate for what's in
it, but Notifications, Drafts-creation and Scratchpad-editing aren't in it
at all — the exact kind of surface this file exists to catch. Two
outcomes, matched to the calls above:

- **Scratchpad-editing** is *already* in `capabilities.ts` as
  `'scratchpad.editing'` (`partial`) — that entry is fine; it's the nav
  entry point to it that's the problem, not the disclosure.
- **Notifications** and **drafts-creation** have never had entries because
  they were never routed through a "does this promise something real"
  review. Recommend adding, even though both surfaces are being removed
  from top-level nav by this proposal — until the code changes land, the
  dead routes are still reachable by URL and deserve the same honesty:

```ts
'notifications.production': {
  state: 'not-wired',
  note: 'Nothing in the product produces a notification yet — the schema, API and badge are real, but the only writer is the dev seed script.',
  ref: 'waypoint-backend/src/db/seed.ts:1075 is the only insert into notifications',
},
'tickets.draftAutosave': {
  state: 'not-wired',
  note: 'Nothing saves a draft, so a ticket you start and abandon is lost, not recoverable here.',
  ref: 'CreateTicketModal.tsx never sets isDraft; no autosave exists',
},
```

---

## 2. The rail/sidebar inconsistency

**Verdict: the idea is right, the execution is under-committed.** Judged
on its own, `w3-sessions-rail.md`'s reasoning holds up — a transcript
needs width, a 250+310px sidebar+list combo left ~700px at 1280px, and
folding chrome to 56px to buy that width back is a real, defensible trade.
The founder's own complaint isn't "the rail is wrong," it's "it's
inconsistent" — and it *is*, but not because folding is a bad idea. It's
inconsistent because **exactly one route in the entire app does it.**
`isFocusWorkspace()` in `AppShell.tsx:20` matches only
`/^\/sessions(\/|$)/`. With a sample size of one, there's no way for a
user to learn "some places compress the shell to buy width" as a pattern
— every time it happens it reads as a fresh surprise, indistinguishable
from a layout bug, because there's nothing else in the product to compare
it to.

**Fix: make it a named, general layout mode with more than one member —
not sessions-specific magic.**

1. Promote `isFocusWorkspace(pathname)` to a small explicit table of
   *focus routes* rather than a single regex: `/sessions*` today, and
   **Review's detail view** (`/review/:id` or equivalent — currently a
   full-width single page already, but sharing no chrome behavior with
   sessions) as the second member. Both are the same shape of problem: a
   single deep working surface (a transcript, a diff) that wants the
   width a 300px+ sidebar is taking. Two members is enough to make it a
   *pattern* a user can recognize the second time, not a one-off.
2. Keep the mechanics exactly as built — 56px rail, pin (`⌘B`,
   `localStorage`), 200ms peek, 150ms width tween, `prefers-reduced-motion`
   respected. These are good decisions already; the problem was never the
   collapse mechanism, it was the mechanism having only one occasion to
   fire.
3. **Make the transition read as deliberate, not accidental:**
   - The expand affordance today is a dashed-border chevron button
     (`SidebarRail.tsx:252`, `border-dashed border-border-strong`) — a
     "this is unfinished" visual signal by convention (dashed borders
     mean placeholder almost everywhere else in the design system). Give
     it a real state: solid border, and a **persistent one-line label**
     under the logo ("Sidebar") so the rail never looks like a sidebar
     that broke — it looks like a sidebar that's *choosing* to be
     narrow, with a visible control to undo that choice.
   - The six rail icons keep the exact vertical order and spacing their
     full-sidebar equivalents have (Home, My work, My sessions, Review,
     Projects, Settings) — already true today — so the collapse reads as
     a width change, not a re-navigation. Keep this; it's the one thing
     already making the transition feel continuous.
   - Add a one-time, dismissible coach mark the first time any user hits
     a focus route ("The sidebar tucks away here for more room — hover
     the arrow to peek, click to keep it open"), stored alongside
     `waypoint:sidebarPinned`. Costs one localStorage key, removes the
     "wait, where did my sidebar go" moment entirely for a first-time
     hit, and never shows again.
4. **Do not** extend focus mode to ticket or project detail views. Those
   already use drawer/overlay patterns (`TicketDrawer.tsx`) that solve
   the same "give this more room" problem without touching the shell —
   adding a third mechanism for the same goal is exactly the kind of
   inconsistency being fixed here.

---

## 3. Making "start a session" obvious

Today, starting a session requires: notice "My sessions" exists in the
sidebar → click it → notice the small "+" in the list header, or the "+"
in the empty state → get an actual, real dialog (`NewSessionDialog.tsx`,
shipped per `w4-start-session.md` — **W4 has landed**, this part of the
docs is current) with Project / Provider / Base branch / Title. The
mechanism is fine. The problem is entirely discoverability: it's reachable
from exactly one place in the app, and that place is buried behind an
already-hard-to-find nav item deep in a list of nine.

**A dispatched agent run is the product's thesis, and a ticket is where
that thesis starts. So the entry point belongs on the ticket, not
exclusively inside a separate "sessions" destination.**

### What's actually wired today (verified in code, not docs)

- `NewSessionDialog.tsx` has **no `ticketId` concept at all** — it only
  ever asks for a *project*. There is no way, today, to open it already
  scoped to a specific ticket.
- `w3-sessions-rail.md` §4.8 describes a planned "Runs" section on the
  ticket drawer with an "Open session →" link. It does not exist —
  `TicketDetailPage.tsx` and `TicketDrawer.tsx` have no such section; the
  only trace is a code comment in `SessionsPage.tsx` referencing it as a
  future arrival point.
- Separately — and worth flagging on its own — `TicketDetailPage.tsx`
  already has a *different*, older "assign an agent to this ticket"
  affordance (`toggleTicketAgent`, `listAgentAssignments`,
  `AgentStatusBadge` with its own `queued/running/needs-review/blocked/
  done/failed` vocabulary). This is a **separate data model** from the
  real ledger-backed `agent-runs` sessions system (W3/W4) — different
  status enums, different service, no code path connecting the two that
  this pass found. Two things in the same product both named "agent,"
  attached to a ticket, with no visible relationship, is its own
  confusion the founder hasn't flagged yet but likely will. **This needs
  a decision from the team before the entry point below ships**: either
  retire the legacy assignment UI in favor of real runs, or make the
  relationship between them explicit. This proposal assumes the real
  ledger-backed system wins, since it's the one with an actual daemon
  behind it — but that's a call for whoever owns that legacy surface, not
  something to quietly overwrite.

### The entry point

One control, "**Run agent**," reachable everywhere a ticket is visible:

1. **Ticket row (list and board).** A small robot-icon button in the
   row's existing hover-action cluster, beside whatever "..." overflow
   already lives there. Click → `NewSessionDialog`, opened with the
   ticket's project preselected and locked (not just defaulted), title
   pre-filled from the ticket's title, and — new — a `ticketId` passed
   through so the resulting run is associated with the ticket from
   creation, not bolted on after.
2. **Ticket detail page / drawer header.** A primary-style "Run agent"
   button beside the existing header actions. Same prefilled dialog.
   Once a run exists for this ticket, this slot becomes the "Runs"
   section §4.8 already specified but never built: status pill(s) +
   "Open session →", reusing `AGENT_STATUS_CONFIG`'s real
   `AgentRunStatus` vocabulary (not the legacy assignment one).
3. **Command palette.** With a ticket in view or focused in a list,
   ⌘K → typing "run" surfaces "Run agent on `<ticket key>`" as a direct
   action — no navigation detour through Sessions at all.
4. **`NewSessionDialog`'s `Project` field**, when opened from any of the
   above, accepts an optional `ticketId` and — when present — hides the
   project picker entirely (it's already decided by the ticket) in favor
   of a small non-editable "for `<ticket key>` · `<project name>`" line.
   This turns a 4-field generic dialog into effectively a 2-field one
   (branch, title) for the common case, which is most of what "obvious"
   means here: fewer decisions between intent and action.

This keeps `/sessions` as the right home for *managing* runs in
progress — the list, the rail, the transcript — while making *starting*
one a one-gesture action from wherever the work that justifies it already
lives. It doesn't touch `NewSessionDialog`'s validated logic (provider
default, base-branch resolution, disabled-until-valid state) — it only
adds a second, prefilled way to reach the same dialog.

---

## 4. Information architecture

Nine flat items plus an unindicated projects tree, with three of the nine
dead, is the root cause the founder is reacting to even when the specific
complaint is about the rail. Fixing item count alone (§1) helps; grouping
what's left turns a list into a hierarchy a person can scan instead of
read.

### Proposed structure

```
[Workspace name]                              ← unchanged, logo + name row

Home
My work
My sessions                                    · alert badge
My Jira                                         · count badge  (conditional)
────────────────────────────────────────────
Review                                          · alert badge  ("Agent output"
                                                   label dropped — one item
                                                   doesn't need a section
                                                   header, see §5)
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

[Local · 6 repos · Claude ready]                ← unchanged status strip
```

**What moved or left, and why:**

- **Notifications, Drafts, Scratchpad** — removed per §1.
- **"Agent output" section header** — dropped. A labeled section
  containing exactly one item (`Review`) isn't grouping, it's a caption.
  Once there's a second agent-output-shaped destination it earns the
  label back; until then it reads as padding, and padding is part of
  what makes the sidebar feel unpolished (§5).
- **My work / My sessions / My Jira** — kept together as "things that are
  yours," unlabeled (the section header would say "You," which is
  self-evident from position directly under Home and doesn't need
  stating — this mirrors how the group above Projects already goes
  unlabeled today).
- **Projects tree** — unchanged structure (this part of the sidebar
  already works and the founder didn't flag it); only the count of
  things competing with it for attention above it goes down.
- **Archive / Analytics / Workspace settings** — unchanged position,
  bottom utility row.

### What becomes a command instead of a destination

The prompt is right that a `⌘K` palette and a `g`-chord layer already
exist and are underused as an IA release valve. Concretely, using what's
already wired in `lib/useGlobalKeyboardShortcuts.ts`:

- `g h` Home, `g m` My work, `g e` My sessions, `g r` Review, `g a` All
  tickets, `g l` Machine/Local — **all already bound**. None of this is
  new work; it's already true that power users don't need the sidebar for
  primary nav. The IA problem is that this is *invisible* — nothing in
  the sidebar hints the chords exist beyond the separate shortcuts modal.
  Fix: the sidebar's own item hover state shows its chord (`g h`, `g m`,
  etc.) the way the topbar's search field already shows `⌘K` inline
  (`Topbar.tsx`) — free discoverability for a system that's already built
  and already correct, just unadvertised.
- **Settings destinations that are really preferences, not places**
  (first-day-of-week, notification prefs, auto-archive/close) already
  live under Settings, correctly — no change; flagging only that they
  should *stay* commands/toggles inside Settings and never earn their own
  top-level nav row as the product grows, which is exactly the pattern
  that produced Notifications/Drafts/Scratchpad in the first place.

---

## 5. Where the finish is actually lost

Specific, not general — each of these is visible in the real running app
(`layouts/Sidebar.tsx`, `layouts/SidebarRail.tsx`, screenshotted at
1728×1080 for this pass):

1. **Two different "active" visual languages in the same sidebar.** A
   top-nav active item gets `bg-accent-soft-bg text-accent-soft-text
   font-medium` (`Sidebar.tsx:60-62`); an active-but-folded project row
   gets `bg-surface-2/60` with no text-color or weight change
   (`Sidebar.tsx:209`). These read as two different components' idea of
   "you are here," in one sidebar, a few hundred pixels apart. Pick one
   active treatment (the accent-soft one is stronger and already used
   for the thing users navigate to most) and use it everywhere something
   is "current."
2. **Icon size is not a scale, it's whatever the nearest call site
   picked.** `15px` for top-nav icons, `17px` for rail icons, `13-14px`
   for sub-nav and settings-gear icons, `12px` for the rail's own
   expand-chevron. None of this is a deliberate two- or three-step type
   scale (the way spacing has one, loosely) — it's per-call-site
   judgment. Fix: two icon sizes, period — 16px for anything that is a
   primary nav target (top-level items, rail items), 13px for anything
   secondary (sub-nav rows, inline affordances, chevrons).
3. **The expand affordance's dashed border reads as "unfinished," not
   "collapsed"** (`SidebarRail.tsx:252`) — covered in §2, repeated here
   because it's as much a finish problem as a behavior one. Dashed
   borders elsewhere in this design system mean "placeholder, not
   real" (empty states, add-new outlines) — reusing that exact visual
   grammar for a shipped, working control undercuts trust in the control
   itself.
4. **Badge treatment is inconsistent between the two shell states.** The
   full sidebar's `CountBadge`/`AlertBadge` are flat pills with no ring
   (`Sidebar.tsx:76`, `86`); the rail's `RailBadge` adds a `ring-2
   ring-bg-inset` because it's floating over an icon rather than sitting
   inline (`SidebarRail.tsx:52`). That's a legitimate reason for the
   *rail* version to need a ring — but nothing unifies them as "the same
   badge, two contexts." Define one badge component with a `context:
   'inline' | 'floating'` prop instead of two independent
   implementations that happen to agree on color.
5. **Vertical rhythm has no declared scale.** Section-to-section spacing
   in `Sidebar.tsx` alternates `my-3` (12px, `Sidebar.tsx:493`, `510`),
   `mt-2` (8px, `540`), `mt-1` (4px, `525`) with no visible logic for
   which gets which — it reads as tuned-by-eye per section rather than
   drawn from a spacing scale. A four-step token (4/8/12/16, matching
   what's already informally in use) declared once and applied
   consistently removes this without changing the sidebar's actual
   density, which is otherwise reasonable (32px/8px row height is a fine
   choice for a nav this dense).
6. **The workspace header has no separation from the nav below it** —
   logo + name sits directly above `Home` with only padding, no border or
   background shift (`Sidebar.tsx:426-460`). A hairline border here (the
   rail already has one, `SidebarRail.tsx:257`) costs nothing and gives
   the eye a place to land before the list starts.
7. **The rail's projects flyout and the full sidebar's project tree
   disagree on affordance for "more projects exist."** The flyout caps at
   6 with a text row (`SidebarRail.tsx:37`, `110-111`); the full sidebar
   just... scrolls, with no indication of a project count or "N more."
   Minor, but it's another spot where the rail and the sidebar were
   clearly designed at different times by different reasoning rather than
   as one system with two widths.

None of the above requires new components — every fix is a shared token
or a single existing component absorbing two call sites that currently
duplicate its logic slightly differently. That's most of why the sidebar
currently reads as "not polished" despite every individual piece being
reasonable on its own: nothing declares the system; every screen re-derives
it.

---

## 6. What the mockup shows

`shell-ux-v2-mockup.html` is self-contained (no build step) and switches
between three states from its own reviewer bar, top of page — light/dark
toggle included, same pattern as `provider-ux-v2-mockup.html`:

- **Sidebar** — the full shell with the IA from §4, the finish fixes from
  §5, chord hints on hover.
- **Focus rail** — `/sessions`-shaped, generalized per §2: solid-border
  expand affordance with its "Sidebar" label, coach-mark shown once.
- **Start a session** — a ticket row and a ticket detail header both
  showing the "Run agent" entry point from §3, with the prefilled dialog
  open (project locked, branch + title only).

Nothing in the mockup is wired to real data; every count, name and ticket
is representative copy, not a data contract.
