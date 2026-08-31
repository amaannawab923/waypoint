# Copilot MCP tools — manual test plan

This is a manual (agent- or human-executable) test plan for the Copilot
panel's new read-only MCP ticket-lookup capability (issue #9,
`waypoint-backend/src/mcp/workItemTools.ts`) plus the GFM table support it
motivated in the shared markdown renderer
(`waypoint-frontend/src/renderer/lib/markdown.ts`). Both are uncommitted on
`feat/copilot-mcp-tools` as of this writing.

Copilot is a real headless `claude` CLI subprocess
(`waypoint-frontend/src/main/copilot/copilotRunner.ts`), not a mock — every
case below is a live, plain-language prompt sent to the actual panel, not a
call to a tool by name. Expect a real reply to take 5–30+ seconds; see
[`qa-agent-playbook.md`](../qa-agent-playbook.md) §2 for timing guidance and
§0–§1 for how to drive the app via the `mcp__electron-devtools__*` tools.
That playbook is the execution procedure — this document is only the list of
cases and what "pass" means for each.

Eight tools exist, all read-only, all served by
`waypoint-backend/src/mcp/workItemTools.ts`: `list_work_items` (filterable by
`assigneeId`, `stateId`, `priority`, `dueBefore`), `get_work_item`,
`get_work_item_by_identifier`, `search_work_items` (title keyword only),
`list_comments`, `list_activity`, `list_states`, `list_members`. There is no
write tool yet — asking Copilot to change a ticket should produce a decline,
per its system prompt ("You still cannot make changes on the user's behalf
yet").

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

**1. `list_work_items`, project-scoped — realistic list question**
Session: fresh.
Prompt: "What tickets are currently in the Product Launch project?"
Expected: A list (prose or table) covering Product Launch's tickets.
Verify: LAUNCH-3, LAUNCH-4, and LAUNCH-7 (or a representative sample) appear
by identifier and title; no raw id like `wi_...`, `mem-...`, or `agent-...`
appears anywhere in the reply — any assignee named is a real display name
(e.g. "Lena", "Ethan (agent)"), not an id.

**2. `get_work_item_by_identifier` — full detail by name**
Session: fresh.
Prompt: "Give me the full rundown on LAUNCH-3 — state, priority, due date,
and who's on it."
Expected: State "In Progress", priority "Urgent", due date on/around
2026-08-27, assignees "Lena" and "Ethan (agent)" — by name, not id.
Verify: all four fields correct; no `mem-` / `agent-` id text anywhere.

**3. `search_work_items` — keyword search, not by name**
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

**8. `get_work_item` (raw id) / full-detail drill-down**
Session: fresh.
Prompt: "Search for anything about 'iPad' and then tell me its estimate and
full description."
Expected: Finds LAUNCH-3 via search, then reports estimate `1` and states
plainly that there's no description set (rather than inventing one).
Verify: estimate `1` is correct; reply does not fabricate description text
for a ticket whose description is genuinely empty. Note: Copilot may
satisfy the detail half of this via `get_work_item` (raw internal id, from
the search result) or `get_work_item_by_identifier` (identifier, also in
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
Expected: Copilot says it can't find that ticket (the tool returns a "work
item not found" error result for an unknown identifier).
Verify: reply clearly states LAUNCH-999 wasn't found; it does **not**
invent a state/priority/assignee for a ticket that doesn't exist.

**14. Negative: write attempt (no write capability yet)**
Session: fresh.
Prompt: "Please change LAUNCH-3's priority to low."
Expected: Copilot declines and says this isn't something it can do yet
(per its system prompt), rather than claiming success.
Verify: reply does not claim the change was made; re-check LAUNCH-3 in the
real Work Items UI afterward — priority must still read **Urgent**, proving
nothing was actually mutated.

**15. Multi-turn: context carried across the tool-use loop**
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
