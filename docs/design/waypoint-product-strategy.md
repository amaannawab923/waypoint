# Waypoint product strategy

Status: argued position, with decisions marked as decisions. Companion to
`waypoint-defingerprinting-plan.md`, which handles the legal/optics work and
contains no product argument. This document contains no rename table.

The prior `waypoint-differentiation-audit.md` is superseded by these two files.
It got to the right question — "make the agent layer the product and the tracker
the substrate" — and stopped one sentence short of the consequence: *then why
are you building the substrate?* That question is §3 below and it is answered.

---

## 1. The thing that is actually true about the market

The prior audit claimed Waypoint's agent layer is "entirely its own." That was
true in 2024 and is not true now, and the audit never checked. It spent its
entire competitive budget on Plane and never looked at the market it is entering.

As of 2026:

- Linear reports roughly **half of all work items are now created by agents**, up
  from ~3% a year ago. Agents are assignees there.
- GitHub's Copilot coding agent is **assignable to issues in both Jira and
  Linear**.
- Agents in Jira went GA in May 2026, including third-party agents.

**"Agents as first-class assignees" is table stakes.** It is a feature every
incumbent shipped in the last twelve months, backed by a sales team and a
distribution channel Waypoint does not have. Building the product around it is
building the thing three funded competitors already finished.

### What is still genuinely Waypoint's

Strip out everything the incumbents also have and this is what is left:

> **The tracker runs on your machine. The agent runs on your own Claude
> subscription. It reads your actual checkout — the working tree, not a snapshot
> someone uploaded. Your code is never sent to a vendor. There is no per-seat AI
> tax, because there is no seat and no vendor.**

That is a real wedge and it is structural, not a feature. A cloud tracker cannot
copy it without becoming a desktop app and giving up its billing model. It is
the one claim on this list that Linear, Jira and Plane are *architecturally*
prevented from making.

It currently appears in the product as `ExecutionMethod =
'local-claude-subscription'` — a string in a select field on a settings page
behind a feature flag. That is the entire expression of the only defensible
position the product has.

### The honest version of the claim, which is stronger than the marketing version

"Nothing leaves your laptop" is **false** and must not be shipped. When the
Copilot runs, prompts go to Anthropic. What is true, and what should be said
exactly:

> Your code and your tickets are never uploaded to Waypoint. There is no Waypoint
> server. The only thing that leaves this machine is what you send to Anthropic
> under your own subscription — the same as running `claude` in your terminal —
> and this screen shows you exactly what that is.

This is more credible than the overclaim and it is also *checkable*, which is
the whole point. A product whose privacy claim is auditable in-app is doing
something no cloud competitor can do, and a product whose privacy claim is
slightly overstated is indistinguishable from every other privacy claim in the
market. **Decision: ship the precise version, and give it a screen.**

---

## 2. The spine: propose → approve

The best engineering in this repo is the Copilot proposal system, and the prior
mockup treated it as a card that shows up in three unrelated places.

What exists today (`src/main/copilot/`, `waypoint-backend/src/mcp/`,
`useCopilotProposals.ts`):

- Five `propose_*` MCP write tools that **never execute**. They insert proposal
  rows.
- Propose-time snapshots, so a card renders names rather than bare ids and does
  not silently lie after reality moves underneath it.
- A seven-state lifecycle: `proposed → executing → executed | rejected | stale |
  expired | superseded`.
- Server-computed self-disclosure prefixes on agent-authored comments.
- Outcomes reported back to the model as a bracketed system note exactly once, so
  it cannot claim a change happened when it did not.
- A read-only tool grant (`Read`, `Glob`, `Grep` — never Bash/Edit/Write) with a
  secrets denylist, and prompt-injection framing that covers ticket text as well
  as repo files.

This is better human-in-the-loop design than most shipping AI products have. It
is also invisible: there is no screen anywhere that answers **"what do my agents
want to do right now?"** — which is the question someone opens this app to
answer.

### Decision: propose→approve is the product's organising model, everywhere

One model, one component, one status vocabulary, four surfaces:

| Surface | Role |
|---|---|
| **Review** (new, primary nav) | The aggregate. Every pending proposal from every agent across every project. What is blocked. What ran overnight. Bulk approve/reject. |
| **Ticket detail** | Proposals scoped to this ticket, inline in the drawer, above comments. |
| **Requests** | An incoming request is a proposal with an external source. Same card, same actions. |
| **Copilot panel** | Proposals generated in this conversation, plus a pending count and "Reject all pending." |

The senior review's strongest line: *"If you build one thing from this exercise,
build the review queue."* That is correct. It is the missing spine, it is one
screen, and it converts the best code in the repo into the reason the app exists.

**The Review queue replaces "Agents" in the primary navigation.** Configuring an
agent is a low-frequency act — you do it once, then edit it quarterly. By the
frequency logic that governs navigation, agent *configuration* belongs in
settings, where it already was. What earns a primary slot is agent *output*.
Agents remains a full screen, reached from Workspace settings, and is linked from
every agent name in the Review queue.

### The three inbox-shaped nouns problem, resolved

Adding Review to a product that already has Requests and Notifications means
three queue-like surfaces. That needs a rule, stated in the product, or it is a
new IA collision of exactly the kind the Notes/Docs rename created.

The rule:

- **Notifications** — things that already happened. Read-only. You can ignore the
  whole screen and nothing breaks.
- **Requests** — work from outside the team asking to come in. Human-originated,
  project-scoped, has its own intake semantics.
- **Review** — an agent wants to do something and is blocked on you. **Nothing
  happens until you act.** This is the only one of the three where inaction has a
  cost.

Requests' agent-triage proposals also appear in Review, tagged with their source.
That is not duplication; it is the aggregate doing its job.

---

## 3. Should Waypoint build the tracker at all?

The senior review put this directly and it deserves a real answer rather than a
shrug. Taking the case against seriously first, because it is strong.

### The case for being a layer on Linear / GitHub Issues / Jira

1. **Zero clone risk.** The entire de-fingerprinting weekend disappears, along
   with the question in §0 of that plan.
2. **Distribution.** You reach people whose work is already in a tracker, with no
   migration. Migration is the single largest adoption barrier in this category
   and a layer skips it entirely.
3. **Focus.** ~23k lines of renderer currently reproduce a solved problem, and
   reproduce it with defects: filters silently do nothing in three of five
   layouts, board drag is disabled for five of six groupings, saved views can be
   created but never configured, there are no relations, no bulk selection
   anywhere, and no re-parenting. Every hour spent closing that gap is an hour
   not spent on the part nobody else has.
4. **The write path already generalises.** The MCP tool surface — nine read tools
   and five `propose_*` write tools — is *already* a tracker-agnostic port. Linear,
   GitHub and Jira all expose everything those fourteen tools need.

### The case against, honestly assessed

- *"Local-first requires owning the data."* — **Weak.** If tickets live in
  Linear's cloud, they already left; that was the customer's prior choice, not
  something Waypoint caused. The claim narrows to "your **code** never leaves
  your machine," which is the half people actually care about and which survives
  intact.
- *"You can't render propose→approve inside Linear."* — **True but not an
  argument for the tracker.** You would render it in your own desktop window
  regardless. That window is the product either way.
- *"Three integrations is expensive."* — **True and underrated.** Three APIs,
  three auth models, three webhook systems, three permission models, three rate
  limits, and you inherit each vendor's semantics for state, priority and labels
  — permanently, including their breaking changes. For a solo developer this is
  not obviously cheaper than a tracker that already works.
- *"No-account, works-on-a-plane is incompatible with a cloud backend."* —
  **True, and this is the real one.** If the pitch is "no signup, nothing
  uploaded, works offline," requiring a Linear workspace kills it. There is a
  genuine if small audience — solo developers and 2–4 person teams who do not
  want a SaaS tracker at all — for whom the local tracker *is* the feature.

### Position

**Build the agent console as the product. Keep the local tracker as its default
backend, and make the backend an interface rather than the product.**

Concretely:

1. **Formalise the port.** The MCP tool surface is already the boundary. Name it
   — `WorkBackend`, with `list / get / search / propose_*` — and make the local
   Postgres tracker one implementation behind it. This costs almost nothing today
   because the abstraction already exists by accident, and it costs a rewrite in
   six months if it is not named now.
2. **Ship local-only first.** Not because the layer is wrong, but because the
   sequencing is: an agent console with no proof it is good, plugged into Linear,
   competes head-on with Linear's own agents on Linear's turf. An agent console
   that is unambiguously good, running locally, with a privacy claim no cloud
   product can match, is a thing people will then want pointed at their Linear.
   The adapter is a two-week project *later*. It is not two weeks of work you can
   afford *now*.
3. **Freeze the tracker.** This is the operational half of the decision and the
   part that will hurt.

### The feature freeze list — what the tracker never gets

Not scheduled. **Not built.** If one of these appears in a sprint, the decision
above has been quietly reversed and someone should say so out loud:

Work-item relations beyond `parentId`. Custom fields. Custom work item types.
Time tracking and worklogs. Dashboards. Initiatives / teamspaces / portfolio
layers. Templates. Multi-user real-time collaboration. Comment rich text.
Attachments. SSO. Roles beyond admin/member. Milestones. Releases. Customers.

The tracker gets exactly enough to stop being embarrassing — working filters in
all five layouts, bulk selection, a keyboard layer, saved views that actually
save a filter, and the defect list in §7 — and then it stops. That list is
finite and takes about three weeks. After that, **every hour goes to the
console.**

This is a falsifiable commitment. That is the point of writing it down.

---

## 4. What "local-first" looks like when it drives the IA

Today it is a select field. If the position is real, it shows up in four places
in the product's structure, not in its settings.

**a) A persistent machine strip, not a config value.** The sidebar footer carries
a live indicator — like a VPN status, always visible: `● Local · Compass Web
grounded · Claude connected`. It is chrome, not a page you visit.

**b) A "This machine" screen, reached from that strip.** The honest version of
§1's claim, made checkable:

- Where the data actually lives (the SQLite/Postgres path), with "Reveal in
  Finder."
- Which repos are linked, per project, and their current branch.
- Claude Code detection — **real detection**, with a real "not detected" state.
  See §7; this is currently fabricated and is the most damaging bug in the repo.
- A **"What leaves this machine"** table: Tickets → never. Code → never.
  Agent prompts → to Anthropic, under your own subscription, only when you send
  one. Telemetry → off / on, with the toggle right there.

This screen is what a cloud competitor cannot ship. It should be linked from
onboarding, from the Copilot panel's grounding chip, and from the README.

**c) Grounding as chrome.** The Copilot's repo grounding follows whichever
project route is open (`useCurrentRouteProject.ts`) and changes *silently* as you
navigate. For a product whose pitch is "the AI reads your codebase," the absence
of a persistent "grounded in {project} · {repo}" chip was the largest UX gap in
the app. The chip is in the mockup and should ship.

**d) Desktop-shaped behaviour.** A local-first desktop app that behaves exactly
like a web app in a frame has not cashed the position. Minimum:

- A real keyboard layer. `⌘K` is currently the only global binding in the entire
  app. `g`-prefixed navigation, `j`/`k` list traversal, `x` to select, `e`/`r` to
  approve/reject in the review queue, `?` for the cheatsheet.
- Correct offline behaviour, visibly indicated — everything works except the
  agent, and the app says so rather than failing.
- Later, the things only a local app can do: watch the working tree, notice the
  branch you just checked out, offer to open the ticket that matches it, run an
  agent on file save. **This is where the second wedge is**, and none of it is
  possible for a cloud tracker.

---

## 5. Agents own saved views, not a grouping primitive — reversing a prior decision

The prior mockup made Workstreams "agent-native": an agent owns a workstream and
runs against its "standing brief." The senior review took this apart correctly
and I am withdrawing it.

The objections, all valid:

- Instructions ended up in **two** places — the agent's `instructionsFile`
  (`agent.md`) and the workstream's standing brief — with no rule for which wins.
  That is a modelling conflict, not a detail.
- One agent held three simultaneous relationships (configured on Agents, owner of
  the Payments workstream, assignee on CW-141): three mental models for one
  entity.
- A project with no agents was left with a Workstreams nav item that had no
  purpose.
- There was no supporting UI anyway — no trigger, cadence, run history or output.
  It was a rationalisation for keeping two grouping primitives, written after the
  decision.

**The better model was already sitting in the mockup, unused.** The Views screen
contains a saved view named "Needs triage review · label: agent-flagged" and
nothing connected it to anything.

### Decision: an agent is a brief plus a scope, and the scope is a saved view

```
Agent = instructions (agent.md, one place, always)
      + scope   (saved views it watches — "everything matching label:security")
      + autonomy (plan-only → ask-before-write → ask-before-PR → full-auto)
      + trigger (on assign / on comment mention / on label / on a view's contents changing)
```

Why this is strictly better:

- **One place for instructions.** The two-brief conflict disappears by
  construction.
- **A view is a scope, which is what "brief with a scope" actually meant.**
  "Watch everything matching `label:security`" is expressible today; "own the
  Payments workstream" required a new relationship on a primitive.
- **It composes.** Assigning an agent to a single ticket is just a scope of one.
  Same model, no special case.
- **It uses a feature that exists and is currently useless.** Saved views can be
  created but never configured (`ProjectViewsPage.tsx:239` calls
  `createView(project.id, name, {})` — empty filters, no filter editor anywhere).
  Giving views a job is the forcing function that makes someone build the filter
  editor.
- **A project with no agents is unaffected.** Nothing appears that has no
  purpose.

Workstreams reverts to being a plain human grouping primitive. Cycles/Modules
staying as two primitives is the founder's call and stands; it just no longer has
a fabricated agent story attached to it.

---

## 6. Views: one concept

Related to §5 and to the de-fingerprinting plan's §2.7. Today there are two
different things called Views: a project-level saved-filter feature that is real
but unconfigurable, and a workspace-level nav slot that opens a flat unfilterable
table titled "All work items."

The mockup renamed the second to "All tickets," which describes the broken thing
accurately without fixing it and locks in the flat table. The review is right.

**Decision: a view is a saved filter, and scope is part of the filter.** One
concept, one component, one filter editor. A project view is a view whose filter
includes that project. The workspace slot is the same surface with no project
filter applied, and it carries "Save as view" — which delivers workspace-level
saved views, the thing people actually want, at zero additional concept cost.

Both the project ticket list and the workspace ticket list are then the same
component with different defaults. That is one filter/group/bulk implementation
instead of two, and it removes the "two things called Views" collision without
renaming anything.

---

## 7. The honesty problems — these come before everything else in this document

A separate forensic read of the codebase found a set of surfaces that assert
things that are not true. This matters more than any IA question, for a reason
that is specific rather than moralising: **the product's entire remaining
differentiation is a trust claim.** "It runs on your machine and nothing is
uploaded" is not verifiable by a user. They have to believe it. A product whose
password page says the password changed when nothing was called, and whose Claude
connection badge reports a version number it invented, has spent the credibility
that claim runs on.

### The governing rule

> **No surface may assert a state it does not verify.**

That is mechanically checkable and it catches every finding below. Adopt it as
the review rule for the repo.

### Tier 0 — before any other work in this document. About a day.

These are the ones where a user *acts on a false statement*.

| Finding | File | Why it is Tier 0 |
|---|---|---|
| **"Change password" calls no API.** Clears three fields and shows "Password updated." | `profile-settings/Security.tsx:36-43` | A user believes their password rotated. It did not. Every other fake thing in the repo is inert; this one is actively unsafe. |
| **`detectLocalClaudeCode()` is hardcoded** to resolve `{status:'connected', version:'2.4.1'}` after a random 500–900ms fake delay, regardless of machine — then renders "● Connected — Claude Code CLI v2.4.1, signed in as \<your real email\>" | `mock/api.ts:212-225`, `AgentDetailPage.tsx:483` | It fabricates a specific version number and pulls the user's real email in to look live, on a machine that may have no Claude Code at all. **It is a lie about the one component the entire product position rests on.** Nothing else in §1 or §4 is credible while this ships. |
| **Comment box is an XSS sink.** Plain textarea posted as `bodyHtml`, rendered with `dangerouslySetInnerHTML` | `WorkItemDetailPage.tsx:580`, `:858-861` | A security bug. Note the care gap: `CopilotProposalCard.tsx:160-162` deliberately renders model text as plain React nodes *with a comment explaining why*, and the human comment path on the same ticket does the opposite. |
| **Two fabricated logged-in devices** in "San Francisco, US"; "Revoke" has no handler | `profile-settings/Security.tsx:17-20`, `:133` | Same page, same class of harm: a security surface reporting invented facts. |
| **`/admin`** — six pages of fake save flashes including a full SMTP form and OAuth client-secret collection that is discarded on save, with no entry point anywhere | `pages/admin/**` | Delete the directory. Covered in the de-fingerprinting plan §3; listed here because collecting a client secret and throwing it away is a security smell, not just dead weight. |

**Fixes:** wire the password change or remove the form and say "coming soon."
Replace `detectLocalClaudeCode` with a real `which claude` / version probe that
has a genuine *not detected* state, and let that state be the front door to
setup. Sanitise or plain-text the comment renderer. Delete the device list.
Delete `/admin`.

### Tier 1 — the week after. Everything that ships looking finished and is not.

**Rule: ship it working, ship it visibly labelled "not yet," or delete it. Never
ship it looking done.**

- **Webhooks** — the UI promises "Send an HTTP POST … whenever selected events
  happen." `services/webhooks.service.ts` contains no `fetch` and no dispatch.
- **Exports** — `createExport` inserts a row with `status:'completed'` and
  returns. No file, no download.
- **Automations** — `autoArchiveEnabled` / `autoCloseEnabled` are stored and read
  back with zero consumers.
- **Profile → Notifications** — four toggles, local `useState`, never persisted.
- **Preferences → first day of week** — local-only *and* unused; `CalendarView`
  hardcodes Mon–Fri.
- **The public intake form toggle** — local state revealing a fabricated
  `https://waypoint.app/i/<id>` URL that resolves to nothing.
- **Cycle favourite stars** — local `useState(false)`. Pages' stars persist, so
  the same icon means two different things in one product.
- **The burndown chart** — two data points (day 0 and today) joined with
  `connectNulls` so it renders as a continuous line, shown next to real numbers.
  The code comment is honest ("there is no per-day history to reconstruct"); the
  chart is not. Either record daily snapshots or draw two points.
- **Drafts** — a top-level nav slot that can never populate. `isDraft` exists on
  the type and in `CreateWorkItemInput` and no UI ever sets it. Either wire the
  create modal's "save as draft," or remove the nav item.
- **Home → Quicklinks** — a permanent empty state on the primary landing screen
  advertising a pinning feature that does not exist.
- **Notifications** — nothing in the codebase ever *creates* one outside the
  seed. The inbox and the bell badge can only shrink.

### Tier 2 — the flag inversion

The shipped product today is a Plane clone plus an agent-configuration UI where
nothing runs:

| Layer | Reality | Ships |
|---|---|---|
| Copilot | Real — Claude Agent SDK subprocess, streaming, session resume, MCP server, full propose→approve→execute lifecycle | **OFF** |
| Sessions | Prototype — localStorage plus a three-string array of canned replies | OFF |
| Agents (settings) | Data modelling only. Nothing ever executes | **ON** |

**Unflag Copilot. It is the best thing in the repo and it is the product.** Then
resolve the two surfaces that ship a promise with no runtime — §8 and §9.

---

## 8. Kill or ship: Sessions

**Kill it.**

`/sessions` is ~900 lines behind a second feature flag: localStorage-backed,
seeded from `mockSessions.ts`, hardcoded to a single agent named "Ethan," with
replies drawn from a three-string array and a `setTimeout(1200)` that unblocks
blocked sessions. It is a well-crafted prototype and it shares no execution path,
no model, no identity and no code file with either Copilot or Agents. It is a
third, unconnected agent story in a product that cannot support one.

The senior review calls it "arguably the most differentiated surface in the
product" and notes that ambiguity costs more than either answer. The second half
is right. The first half overrates it: what is differentiated about Sessions is
not the full-viewport dispatch console, which is a chat UI. It is **one idea**:

> **Dispatch intents.** "Research & give RCA" · "Comment on the ticket" ·
> "Follow up on the ticket" · "Start working on this bug" · "Custom instruction."

That is genuinely good. It converts a blank prompt box into a menu of things the
agent is actually good at, and it is the closest thing in the repo to an
onboarding for the AI features.

**Decision: delete `pages/sessions/**` and the flag. Harvest the intents into an
"Ask Copilot to…" menu on the ticket detail and in the ticket list's bulk bar.
Runs land in the Review queue like everything else.**

That keeps the one valuable idea, removes 900 lines of prototype, removes a
second flag, and removes the third competing agent story. `INTENT_NEEDS_DIRECTORY`
— which already knows that only `rca` and `full-coding` need a local checkout —
survives as the rule for when to require a linked repo.

---

## 9. Kill or ship: the Agents configuration surface

**Ship it, but only after it does something — and until then, tell the truth on
the screen.**

Today: you define an agent with an instructions file, an autonomy level, triggers
and a model. You assign it to a ticket. **Nothing runs.**
`instructionsFile.contentMarkdown`, `autonomy` and `triggers` are stored and read
by no runtime. The Copilot runner has its own hardcoded system prompt and no
knowledge that Agents exist. `AgentAssignment.status` only ever goes `queued` →
`done`; `running` / `needs-review` / `blocked` / `failed` appear **only in
`db/seed.ts`**, so the demo data shows a rich lifecycle and anything a user
creates is stuck at "Queued" forever.

This is the worst combination available: the fake surface ships on, the real one
ships off.

The two systems are not far apart. The Copilot runner already spawns the Claude
Agent SDK against the user's subscription, already has the MCP server, already
has the propose→approve loop. What is missing is that the runner does not read
the agent's `agent.md` as its system prompt, does not respect `autonomy` as a
tool-grant policy, and is not invoked by `triggers`.

**Sequence:**

1. **Now (Tier 0):** replace the fabricated connection badge with real detection.
2. **Now:** on any agent with no runtime, the detail page says so plainly —
   *"This agent is configured but not yet running. Assignments will queue."* An
   agent that cannot run must not render a green dot.
3. **Then (the 6→7 work):** make the runner honour `instructionsFile` as its
   system prompt, `autonomy` as the tool-grant and approval policy (`plan-only`
   → read tools only, no `propose_*`; `ask-before-write` → today's behaviour;
   `full-auto` → auto-approve non-destructive kinds), and `triggers` as the
   invocation path. Then `AgentAssignment.status` can move through its real
   lifecycle because there is something moving it.
4. **Then:** Agents moves permanently to Workspace settings; Review holds the
   primary nav slot.

If step 3 has not started within a month, delete the Agents surface. A
configuration screen for a thing that does not exist is worse than no screen.

---

## 10. Roadmap, mapped to the rating scale

The senior review rated the current app **5/10** and the prior mockup **6/10**.
Below is what each point costs, with effort stated honestly for one developer.

### 5 → 6 · about two weeks

The credibility floor. Nothing here is product work.

- **Tier 0 honesty pass** (§7) — one day.
- **Tier 1 sweep** (§7) — three days. Every inert surface labelled, wired or
  deleted.
- **Delete `/admin`, delete `pages/sessions/**`** — half a day of net deletion.
- **Unflag Copilot** and ship the grounding chip — one day.
- **The de-fingerprinting weekend** — separate document.
- **The bug list**: topbar "New ticket" files into `projects[0]` from anywhere;
  filters silently do nothing in Calendar/Spreadsheet/Gantt (each creates its own
  unfiltered `useWorkItemsView` instance while the toolbar keeps its active-filter
  badge, and the header count disagrees with the screen); agent assignees render
  as "Unassigned" in Spreadsheet, cycle lists and the workspace table; board drag
  silently disabled for five of six groupings; three of four items in the ticket
  overflow menu are `console.log`; editing a sticky deletes and recreates it,
  randomly changing its colour; "Copy link" produces an `app://` URL that is not a
  route; no 404. — one week.

**At 6 the app is honest and not broken. It is still a tracker with no reason to
exist.**

### 6 → 7 · about six weeks

The point at which it stops being "a tracker with an AI panel" and becomes "an
AI-native tracker." This is the largest single step on the list and the one that
matters.

- **Build the Review queue** (§2) — the aggregate screen, bulk approve/reject,
  blocked runs, an overnight audit trail. Two weeks.
- **Proposals in ticket detail** and the Requests queue on the same component —
  one week.
- **Wire Agents to the runtime** (§9 step 3) — `agent.md` as system prompt,
  autonomy as policy, triggers as invocation. Two weeks. **This is the hard
  one and everything else in the tier depends on it.**
- **Agent triage on Requests** (`IntakePage.tsx` has *zero* agent code today —
  this is entirely net-new) — folded into the above.
- **A real keyboard layer** (§4d) — three days.
- **The tracker's finite list**: working filters in all five layouts, bulk
  selection, a saved-view filter editor. One week. Then the freeze (§3).

**At 7 the answer to "why this and not Linear" is "because the agent reads my
actual checkout and I approve its work in one place." That is a sentence someone
would repeat.**

### 7 → 8 · about two months

The point at which the position, not the feature list, drives the product.

- **The machine surface and the honest privacy claim** (§4a, §4b) — one week,
  and it depends on real Claude detection landing in Tier 0.
- **Agents own saved views** (§5) — requires the filter editor from the previous
  tier. One week.
- **Onboarding that leads with local-first** rather than with "create a project."
  Rewrite the README, which currently claims "the world's first project
  management tool that actually ships as a native desktop app" — false (Linear,
  Jira and Height all ship desktop apps) — and then lists the Plane noun set as
  the value proposition. Three days.
- **One thing only a local desktop app can do.** Watch the working tree; notice
  the branch checkout; offer the matching ticket; run an agent on save. Pick one
  and build it well. Three weeks. **This is the second wedge and it is the item
  most likely to get cut. Do not cut it — everything above it is defensive, and
  this is the only offensive item on the roadmap.**
- **Name the `WorkBackend` port** (§3) even though nothing else implements it
  yet. Two days now, a rewrite later.

**At 8 the product does something no competitor structurally can, and says so
accurately.**

### 8 → 9 · not an engineering question

Nothing on any list above gets to 9, and it is worth being blunt about why.

At 8 the product is coherent, honest, differentiated and unproven. **9 requires
evidence that people use it** — specifically, that the Review queue is opened
daily and acted on. The prior audit ran to 1,000 lines without a single mention
of who this is for or what any user said. That was forgivable at 13 days. It will
not be forgivable at 13 weeks.

The metric that decides whether any of this worked:

> **Proposals approved per active day, per user.** If an agent proposes something
> a person approves several times a day, the product is real. If the Review queue
> is empty most mornings, the whole thesis is wrong and no amount of IA fixes it.

Instrument that before building the review queue, not after. Everything else —
DAU, tickets created, projects — measures whether someone is using a tracker,
which is a question already answered by four other companies.

---

## 11. Decisions register

For the founder to accept, reject or amend. Each of these is a decision, not a
recommendation.

| # | Decision | Reversibility |
|---|---|---|
| 1 | Position is **local-first execution on your own subscription**, stated precisely (§1), not "agents as assignees" | Easy now, hard after the README and onboarding ship |
| 2 | **Propose→approve is the organising model**, and Review takes the primary nav slot Agents held | Easy |
| 3 | **Build the console; keep the local tracker as one backend behind a named port**; ship local-only first; a Linear adapter is a later two-week project | Moderate — the port must be named now or it is a rewrite |
| 4 | **Freeze the tracker** at the finite list in §3 | The list is the commitment; adding to it reverses decision 3 |
| 5 | **Agents own saved views, not workstreams** (§5) | Easy — the prior model was never built |
| 6 | **One Views concept, scope is part of the filter** (§6) | Easy |
| 7 | **Delete Sessions; harvest dispatch intents** (§8) | One-way; the code is in git |
| 8 | **Agents surface ships honest-and-inert now, wired within a month, deleted if not** | The deadline is the decision |
| 9 | **"No surface may assert a state it does not verify"** becomes the repo's review rule | Easy to adopt, hard to keep |
| 10 | **Instrument proposals-approved-per-active-day before building the review queue** | Trivial now, impossible retroactively |
