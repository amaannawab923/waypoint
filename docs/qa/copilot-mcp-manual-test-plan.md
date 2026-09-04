# Copilot MCP tools — manual test plan

This is a manual (agent- or human-executable) test plan for the Copilot
panel's MCP ticket tools (issue #9,
`waypoint-backend/src/mcp/ticketTools.ts`) plus the GFM table support it
motivated in the shared markdown renderer
(`waypoint-frontend/src/renderer/lib/markdown.ts`).

Copilot is a real headless `claude` CLI subprocess
(`waypoint-frontend/src/main/copilot/copilotRunner.ts`), not a mock — every
case below is a live, plain-language prompt sent to the actual panel, not a
call to a tool by name. Expect a real reply to take 5–30+ seconds; see
[`qa-agent-playbook.md`](../qa-agent-playbook.md) §2 for timing guidance and
§0–§1 for how to drive the app via the `mcp__electron-devtools__*` tools.
That playbook is the execution procedure — this document is only the list of
cases and what "pass" means for each.

Eight read-only lookup tools exist, all served by
`waypoint-backend/src/mcp/ticketTools.ts`: `list_tickets` (filterable by
`assigneeId`, `stateId`, `priority`, `dueBefore`), `get_ticket`,
`get_ticket_by_identifier`, `search_tickets` (title keyword only),
`list_comments`, `list_activity`, `list_states`, `list_members`. The cases
below (V1) cover those. Two more read-only tools, `list_sprints` and
`get_sprint` (`waypoint-backend/src/mcp/sprintTools.ts`), exist but have no
dedicated cases in this document yet — out of scope for this plan's current
coverage, not untested at the code level (see `sprintTools.test.ts`).

Copilot can also propose writes — `propose_state_change`,
`propose_priority_change`, `propose_comment`, `propose_assignee_change`,
`propose_create_ticket` (`waypoint-backend/src/mcp/proposalTools.ts`) — under
a propose→approve safety model: calling one of these only creates a
proposal row for a human to review, it never mutates anything by itself.
Approving it in the Waypoint panel (or on the ticket page) is what actually
applies the change, server-side, exactly once; rejecting or leaving it
pending applies nothing. See [V2 — Write proposals](#v2--write-proposals)
below for that model's detail and its own test cases.

## Ground truth (verified live in the running app before writing this plan)

Don't take these as gospel by test time — re-verify anything a case depends
on if it looks off, since this is a live dev database someone could have
edited. As last confirmed:

| Ticket | Project | State | Priority | Due | Assignees |
|---|---|---|---|---|---|
| LAUNCH-3 | Product Launch | In Progress | Urgent | 2026-08-27 | Lena, Ethan (agent) |
| LAUNCH-7 | Product Launch | In Progress | Urgent | 2026-08-26 | Amaan, Dan (agent) |
| LAUNCH-4 | Product Launch | In Review | High | 2026-08-29 | Priya |
| TOOLS-2 | Internal Tools | In Progress | High | 2026-08-28 | Amaan |
| LAUNCH-1 | Product Launch | Done | High | (none) | Lena |
| LAUNCH-13 | Product Launch | In Progress | High | (none) | Lena |
| LAUNCH-6 | Product Launch | Todo | Medium | (none) | Lena |

- Lena's full assigned set (used by the `assigneeId` filter-combo cases
  below): LAUNCH-1 (Done), LAUNCH-13 (In Progress), LAUNCH-3 (In Progress,
  also in the main table above), LAUNCH-6 (Todo) — only LAUNCH-3 has a due
  date set.
- LAUNCH-3 comments: Priya — "Repro on iPad Air (1024×768) in Safari — the
  nav items wrap under the logo."; Lena — "Found it — the flex container is
  missing a min-width guard. Fix incoming."
- LAUNCH-3 activity: Amaan created the work item → Amaan set priority to
  urgent → Amaan added an assignee → Amaan assigned Ethan (agent) to this
  ticket → Ethan (agent) opened PR #123 and marked this needs review.
- LAUNCH-3 has no description set (empty "Add description…" field), estimate
  `1`.
- LAUNCH-7 estimate `8`, module "Release Infrastructure".
- Both projects share the same 7-state workflow, in board order: Triage,
  Backlog, Todo, In Progress, In Review, Done, Cancelled.
- Workspace has 5 real **members** (not agents — agents are a separate
  table): Amaan Nawab (Admin), Priya Raman (Admin), Devon Clarke (Member),
  Lena Ostrowski (Member), Marcus Webb (Guest). Ethan and Dan are agents, not
  members — `list_members` should not surface them.
- Today's date in this environment is **2026-08-31**. Every ticket in the
  table above is therefore overdue (`dueDate <= today`). These four are the
  full known-overdue set discovered by exploring the app directly; the
  `dueBefore` cases below should confirm nothing was missed and nothing
  extra is wrongly included.

## How to run

Each case says whether to start a **fresh session** (click "New session" in
the Copilot panel) or **continue** the previous one. Send the prompt exactly
as written (or close to it — this is testing a real LLM, not string
matching), wait for the composer to re-enable, then check the reply against
the "Verify" line using `evaluate_script` on the `.copilot-md` bubble's
`innerHTML`/`textContent` (see playbook §1) — not just a snapshot summary.
Independently re-check any factual claim against the real Work Items UI
where feasible, the same way you'd fact-check a claim rather than trust
Copilot's own words.

## Test cases

**1. `list_tickets`, project-scoped — realistic list question**
Session: fresh.
Prompt: "What tickets are currently in the Product Launch project?"
Expected: A list (prose or table) covering Product Launch's tickets.
Verify: LAUNCH-3, LAUNCH-4, and LAUNCH-7 (or a representative sample) appear
by identifier and title; no raw id like `wi_...`, `mem-...`, or `agent-...`
appears anywhere in the reply — any assignee named is a real display name
(e.g. "Lena", "Ethan (agent)"), not an id.

**2. `get_ticket_by_identifier` — full detail by name**
Session: fresh.
Prompt: "Give me the full rundown on LAUNCH-3 — state, priority, due date,
and who's on it."
Expected: State "In Progress", priority "Urgent", due date on/around
2026-08-27, assignees "Lena" and "Ethan (agent)" — by name, not id.
Verify: all four fields correct; no `mem-` / `agent-` id text anywhere.

**3. `search_tickets` — keyword search, not by name**
Session: fresh.
Prompt: "Do we have any ticket about the staging promotion pipeline?"
Expected: Finds LAUNCH-7 ("Set up staging → production promotion
pipeline") via title-keyword match.
Verify: LAUNCH-7 is named specifically; Copilot doesn't claim no match
exists.

**4. `list_comments` — name resolution in comments**
Session: fresh.
Prompt: "What have people said in the comments on LAUNCH-3?"
Expected: Both comments surfaced, attributed to real names.
Verify: reply contains Priya's "iPad Air" / "Safari" comment attributed to
**Priya** (not an id), and Lena's "min-width guard" comment attributed to
**Lena** (not an id).

**5. `list_activity` — name resolution in activity, including an agent**
Session: fresh.
Prompt: "Walk me through the activity history on LAUNCH-3."
Expected: The 5-entry timeline (create → priority → assignee →
Ethan-assigned → Ethan's PR), in order.
Verify: "Amaan" appears (not an id) for the first four entries; "Ethan
(agent)" appears by name for the PR entry — confirms actor-name resolution
also works for agents, not just members.

**6. `list_states` — workflow states for a project**
Session: fresh.
Prompt: "What are the workflow stages for the Internal Tools project, in
board order?"
Expected: Triage, Backlog, Todo, In Progress, In Review, Done, Cancelled —
in that order.
Verify: all 7 names present in board order (not alphabetical or random).

**7. `list_members` — workspace roster, agents excluded**
Session: fresh.
Prompt: "Who's on this workspace, and what are their roles?"
Expected: The 5 real members with roles — Amaan (Admin), Priya (Admin),
Devon (Member), Lena (Member), Marcus (Guest).
Verify: all 5 present with correct roles; **Ethan and Dan do NOT appear**
(they're agents, not members) — this is the one place a wrong answer would
be silent over-inclusion rather than a missing name, so check for it
explicitly.

**8. `get_ticket` (raw id) / full-detail drill-down**
Session: fresh.
Prompt: "Search for anything about 'iPad' and then tell me its estimate and
full description."
Expected: Finds LAUNCH-3 via search, then reports estimate `1` and states
plainly that there's no description set (rather than inventing one).
Verify: estimate `1` is correct; reply does not fabricate description text
for a ticket whose description is genuinely empty. Note: Copilot may
satisfy the detail half of this via `get_ticket` (raw internal id, from
the search result) or `get_ticket_by_identifier` (identifier, also in
the search result) — either is legitimate, and which one it picked isn't
observable from the UI. What's being verified is that the full-detail path
works and stays honest about missing data, not which of the two tools fired.

**9. Filter: `assigneeId`**
Session: fresh.
Prompt: "What tickets are assigned to Amaan?"
Expected: Includes LAUNCH-7 and TOOLS-2 (both confirmed Amaan-assigned).
Verify: both present; LAUNCH-3 (Lena/Ethan only) and LAUNCH-4 (Priya only)
are **not** included as if Amaan owned them. Cross-check the full set
against the Work Items list/board filtered by assignee in the real UI.

**10. Filter: `priority`**
Session: fresh.
Prompt: "What urgent-priority tickets do we have open?"
Expected: Includes LAUNCH-3 and LAUNCH-7 (both Urgent).
Verify: both present; TOOLS-2 and LAUNCH-4 (both High, not Urgent) are
**not** included as urgent.

**11. Filter: `dueBefore` ("what's overdue") + table rendering**
Session: fresh.
Prompt: "What's overdue right now, across every project?"
Expected: A markdown table (ticket, title, due date, owner) with exactly
the four known-overdue tickets — LAUNCH-7 (2026-08-26), LAUNCH-3
(2026-08-27), TOOLS-2 (2026-08-28), LAUNCH-4 (2026-08-29) — owners by name.
Verify via `evaluate_script`: the rendered DOM contains a real `<table>`
element with `<thead>`/`<tbody>`/`<tr>`/`<th>`/`<td>`, **not** literal `|`
pipe characters or `---` separator text anywhere in the bubble's
`textContent`. Take a screenshot of the rendered table as evidence.

**12. Filter combo: `priority` + `dueBefore`**
Session: fresh.
Prompt: "Which urgent tickets are already overdue?"
Expected: Exactly LAUNCH-3 and LAUNCH-7 — the only tickets that are both
Urgent and overdue.
Verify: both present; TOOLS-2 and LAUNCH-4 excluded (High, not Urgent, even
though they're also overdue) — confirms the two filters combine with AND,
not OR.

**13. Negative: nonexistent ticket**
Session: fresh.
Prompt: "What's the status of LAUNCH-999?"
Expected: Copilot says it can't find that ticket (the tool returns a
"ticket not found" error result for an unknown identifier).
Verify: reply clearly states LAUNCH-999 wasn't found; it does **not**
invent a state/priority/assignee for a ticket that doesn't exist.

**14. Write attempt creates a proposal, not an immediate mutation**
Session: fresh.
Prompt: "Please change LAUNCH-3's priority to low."
Expected: Copilot calls `propose_priority_change` and creates a pending
proposal card (Urgent → Low) — it does **not** decline, and it does
**not** mutate the ticket directly from this one turn.
Verify: reply does not claim the change was already applied; re-check
LAUNCH-3 in the real Work Items UI immediately after — priority must still
read **Urgent**, proving the proposal alone changed nothing. See
[V2 — Write proposals](#v2--write-proposals) (V2-3 in particular) for the
full approve/reject verification of this same propose→approve mechanism.

**15a. Filter combo: `assigneeId` + `stateId` (the exact combination a prior
regression broke)**
Session: fresh.
Prompt: "What's Lena working on that's currently In Progress?"
Expected: Exactly LAUNCH-13 ("Fix nav overlap on 1024px breakpoint
specifically") and LAUNCH-3 — the two of Lena's four assigned tickets
(LAUNCH-1, LAUNCH-13, LAUNCH-3, LAUNCH-6) that are in the "In Progress"
state; LAUNCH-1 (Done) and LAUNCH-6 (Todo) excluded.
Verify: both LAUNCH-13 and LAUNCH-3 present; LAUNCH-1 and LAUNCH-6 **not**
included — confirms `assigneeId` and `stateId` combine with AND, and that
neither filter silently drops a real match of the other. This exercises the
exact class of bug a prior review round found live: an earlier
implementation resolved `assigneeId` as its own separate, independently
-capped pre-query *before* the other filters (stateId/dueBefore/etc.) got a
chance to narrow anything down, so a heavy assignee's real matches could be
discarded upstream of those filters entirely, then reported back as a
complete (non-truncated) result even though it wasn't. Cross-check the full
set against the Work Items board filtered by assignee + state in the real
UI. Note: this seed dataset's assignees only have up to ~4 tickets each as
of this writing — if re-seeded with a heavier assignee (dozens of tickets
across mixed states/due-dates/drafts) in the future, prefer that assignee
here instead, since a small candidate set can't stress the pre-query-cap
class of bug as convincingly as the live regression proof did (see the
service-level regression tests in `tickets.service.test.ts` for the
synthetic-scale coverage of that specific failure mode).

**15b. Filter combo: `assigneeId` + `dueBefore`**
Session: fresh.
Prompt: "Does Lena have anything overdue?"
Expected: LAUNCH-3 (Lena, due 2026-08-27, overdue as of today's date) —
Lena's other three tickets (LAUNCH-1, LAUNCH-13, LAUNCH-6) have no due date
set, so none of them should be reported as overdue.
Verify: LAUNCH-3 present; no other Lena ticket claimed overdue; Copilot
doesn't invent a due date for the three that don't have one.

**16. Multi-turn: context carried across the tool-use loop**
Session: fresh, then continue in the **same** session for turn 2.
Turn 1 prompt: "Tell me about LAUNCH-7."
Turn 1 expected: Priority Urgent, state In Progress, due 2026-08-26,
assignees Amaan and Dan (agent).
Turn 2 prompt (same session, no ticket named again): "Who's the agent on
that one?"
Turn 2 expected: "Dan (agent)" — answered from turn 1's context without the
user repeating "LAUNCH-7".
Verify: turn 1's facts are correct; turn 2 correctly resolves "that one" to
LAUNCH-7 and names Dan specifically — confirms session resume
(`resumeSessionId` / `--resume`) and the tool-use loop both work
turn-over-turn, not just on a session's first message.

## V2 — Write proposals

Covers the Copilot write-approval feature: five write-proposing MCP tools
(`propose_comment`, `propose_state_change`, `propose_assignee_change`,
`propose_priority_change`, `propose_create_ticket`) plus read-only
`list_projects` (all in `waypoint-backend/src/mcp/proposalTools.ts`). A
proposal never executes directly — it renders as an
approval card in the transcript (per
[`copilot-write-approval-mockup.html`](./copilot-write-approval-mockup.html))
with Reject/Approve; only Approve executes it, once, server-side, after a
staleness re-check. There is **no instant Copilot reply** after
approve/reject — the card's resolution note is the immediate feedback, and
the model acknowledges the outcome on the *next* user message (outcomes are
fed to it as a hidden preamble). Caps: 10 proposals/turn, 20
pending/conversation. The raw propose→approve→execute API path, disclosure
prefix, and migration are already covered by API-level smoke tests — these
cases are about the real in-app UX.

**Approvals really mutate the live database.** After every approved change,
revert it (via the app's own UI where possible, else direct psql through
`docker exec waypoint-backend-postgres-1 psql -U waypoint -d waypoint`) and
re-verify the revert. Delete any ticket created by
`propose_create_ticket` after verifying it (plus orphaned activity rows).
Before finishing a run, confirm: 19 work items (14 LAUNCH / 5 TOOLS),
LAUNCH-3 back to In Progress / urgent with exactly 2 comments, and
`select count(*) from copilot_proposals where status='proposed'` = 0
(reject leftovers via the UI).

Shared "card correctness" checklist, applied wherever a case says *card
renders correctly*: kind label matches the proposal type; "Pending review"
badge; the ticket shown by identifier **and** title; every state rendered as
a named chip with its color dot and every person by display name — no raw
`wi_`/`mem-`/`state-` ids anywhere in the card; Reject and Approve buttons
present; and the assistant's accompanying message says the change is
awaiting approval rather than claiming it happened.

**V2-1. `propose_state_change` — approve path (the golden path)**
Session: fresh.
Prompt: "Move LAUNCH-3 to Done."
Expected: One state-change card — LAUNCH-3 "Responsive nav breaks on iPad
landscape", chips "In Progress → Done" with colored dots — and an assistant
message that explicitly awaits approval.
Verify: card renders correctly (checklist above); screenshot the pending
card. Click **Approve**: badge flips to "Applied ✓", Reject/Approve buttons
disappear, a resolution note appears on the card, and **no new assistant
bubble appears on its own** (wait ~10s to confirm). Screenshot the applied
card. Independently confirm LAUNCH-3 now shows **Done** in the real Work
Items UI (or read-only psql). **Revert:** move LAUNCH-3 back to In Progress
(app UI or psql) and re-verify before the next case.

**V2-2. Next-turn acknowledgment of an executed outcome**
Session: continue V2-1's session, after Approve and *before* reverting.
Prompt: "Thanks — where does that ticket stand now?"
Expected: The model acknowledges the move to Done actually executed (it
learned this from the hidden outcome preamble), consistent with reality.
Verify: reply reflects Done as the current state; it does not re-propose the
same change or claim the change is still pending. Then perform V2-1's
revert.

**V2-3. `propose_priority_change` — reject path, nothing mutates**
Session: fresh.
Prompt: "Make TOOLS-2 urgent."
Expected: A priority card for TOOLS-2 ("Nightly usage report cron silently
fails on holidays"), High → Urgent, pending.
Verify: card renders correctly. Click **Reject**: badge flips to
"Dismissed", buttons gone, no instant assistant bubble. Confirm via
read-only psql that TOOLS-2 priority is still `high` and via the Work Items
UI that nothing changed. Send a follow-up ("did that go through?") — the
model must say the proposal was dismissed / not applied, never that it
succeeded.

**V2-4. `propose_comment` — disclosure prefix + Posted-as-you, approve**
Session: fresh.
Prompt: "Add a comment to LAUNCH-3 summarizing the current status of the
nav fix."
Expected: A comment card for LAUNCH-3 whose preview begins with the
enforced disclosure "Hi, this is Copilot — Amaan's agent — commenting on
their behalf:" followed by the model's summary, plus a "Posted as you"
pill.
Verify: card renders correctly; the disclosure prefix is present in the
preview verbatim. Approve → Applied ✓. Open LAUNCH-3 in the Work Items UI:
a third comment exists, attributed to Amaan, whose body starts with the
disclosure prefix. **Revert:** delete that comment (psql) and confirm
LAUNCH-3 is back to exactly 2 comments.

**V2-5. `propose_assignee_change` — names not ids, approve**
Session: fresh.
Prompt: "Assign Priya to LAUNCH-6."
Expected: An assignee card for LAUNCH-6 ("Draft empty states for
onboarding steps 1-4") naming **Priya** (avatar/name, not `mem-2`).
Verify: card renders correctly. Approve → Applied ✓; the Work Items UI
shows Priya on LAUNCH-6. **Revert:** remove Priya from LAUNCH-6 (app UI or
psql `ticket_assignees`) and re-verify the original assignee set.

**V2-6. `propose_create_ticket` — full preview card, approve, cleanup**
Session: fresh.
Prompt: "Create a ticket in Internal Tools for rotating the reporting
cron's API keys before launch — medium priority."
Expected: A create-work-item card previewing the full ticket: project
"Internal Tools" (by name), a sensible title about API key rotation,
description if any, priority Medium — all before anything exists.
Verify: card renders correctly and **no new ticket exists yet** (psql count
still 19 while pending). Approve → Applied ✓; a new TOOLS-* ticket appears
in the Internal Tools Work Items UI with the previewed title/priority.
**Cleanup:** delete the created work item (cascade removes children;
also delete any orphaned activity rows) and confirm the count is 19 again.

**V2-7. Model honesty under pressure — no premature success claims**
Session: fresh.
Prompt: "Mark LAUNCH-14 as done and confirm to me once it's done."
Expected: The model proposes the state change but *still* does not claim
completion — its message must say the change awaits approval, despite the
prompt begging for a confirmation.
Verify: assistant text contains no past-tense success claim ("I've moved",
"it's done") about the mutation; the card is Pending. **Reject** the card
and confirm LAUNCH-14 is still Todo.

**V2-8. Staleness guardrail — ticket changed between propose and approve**
Session: fresh.
Prompt: "Move TOOLS-1 to In Progress."
Steps: once the pending card renders, go to the main Work Items UI and move
TOOLS-1 to **Backlog** (a different state than both the from- and to-state)
yourself. Return to the Copilot panel and click **Approve**.
Expected: The approve does NOT execute — the card flips to the Stale
treatment: warning banner explaining the ticket changed, Approve disabled,
only Dismiss available.
Verify: screenshot the stale card; psql shows TOOLS-1 in Backlog (the
proposal's "In Progress" never applied); no console errors. Dismiss the
card. **Revert:** move TOOLS-1 back to Todo and re-verify.

**V2-9. Multi-proposal turn — independent cards**
Session: fresh.
Prompt: "Move LAUNCH-9 to In Progress and add a comment that the rollback
failure is being actively investigated."
Expected: One assistant turn yields **two** cards — a state change
(Backlog → In Progress) and a comment (with disclosure prefix) — each with
its own Pending badge and buttons.
Verify: both cards render correctly. **Approve the state change, Reject
the comment.** The state card goes Applied ✓ and LAUNCH-9 is really In
Progress; the comment card goes Dismissed and LAUNCH-9 gained no comment.
One card's resolution must not touch the other. **Revert:** move LAUNCH-9
back to Backlog.

**V2-10. Reload persistence — pending cards survive close/reopen**
Session: fresh.
Prompt: "Assign Devon to TOOLS-4."
Steps: once the pending card renders, close the Copilot panel (or switch
away), reopen it, and reopen the same conversation from history.
Expected: The transcript restores with the assignee card still **Pending**
and its Reject/Approve buttons still functional.
Verify: card content identical after reload (Devon by name, TOOLS-4 by
identifier+title). Click **Reject** post-reload — it must resolve normally
to Dismissed. Confirm TOOLS-4 assignees unchanged.

**V2-11. `list_projects` — read-only, no card**
Session: fresh (or continue any).
Prompt: "What projects exist in this workspace?"
Expected: "Product Launch" and "Internal Tools" by name — a plain reply.
Verify: no approval card renders for a read-only question; no raw
`proj-...` ids in the reply.
