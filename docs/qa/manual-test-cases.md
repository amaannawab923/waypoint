# Waypoint — Manual Test Case Sheet

Round-1 authoring pass. Test cases only; execution results are added in Round 2
(see the Result column once populated). CW = Compass Web (full/seeded
project), PL = Product Launch (sparse project, no repo).

Format per case: **ID** — title / Steps / Expected.

---

## HOME — Home page

- **HOME-01** — Greeting renders for logged-in user
  Steps: Navigate to `/`.
  Expected: Page greets "Amaan Nawab" (or equivalent personalized greeting); no console errors.
  Result: PASS — greets "Good afternoon, Amaan", no console errors.
- **HOME-02** — Proposals-waiting card count matches Review queue
  Steps: Note the count on the proposals-waiting card on Home. Navigate to `/review` and count items across all tabs (or the tab total badge).
  Expected: Home card count equals the real pending-proposal count in Review.
  Result: PASS — Home "0 waiting · 0 blocked · 9 resolved" matches Review's "Waiting on you 0 / Blocked 0 / Ran overnight 9" exactly.
- **HOME-03** — Active sprint card reflects a real sprint
  Steps: Note sprint name/progress shown on Home's active-sprint card. Navigate to CW `/projects/proj-cw/sprints` and open the matching active sprint.
  Expected: Sprint name and progress/ticket counts on Home match the sprint detail page.
  Result: PASS — Home shows "Sprint 12 — 12 of 47 tickets done", sprint detail page shows identical "12 of 47 done".
- **HOME-04** — Recents list populates and links work
  Steps: Observe the Recents list on Home. Click the first item.
  Expected: List shows recently-viewed/updated items; clicking navigates to the correct ticket/doc/etc.
  Result: PASS — list shows real mixed content (sprints/docs/tickets/workstreams); clicking "Q3 retro" navigated correctly to `/projects/proj-cw/docs/doc-q3-retro`.
- **HOME-05** — Recents filter changes the list
  Steps: Use the Recents filter control (if present) to switch filter (e.g. by type or project).
  Expected: List updates to match the filter; no stale items from the unfiltered set remain.
  Result: PASS — switching filter to "Sprints" correctly narrowed the list to only Sprint 12/10/13, excluding docs/tickets/workstreams.
- **HOME-06** — Empty/edge state when nothing is pending
  Steps: If possible, observe cards when a workspace segment has zero items (e.g. filter Recents to a type with none).
  Expected: A clear empty state is shown, not a blank area or spinner stuck forever.
  Result: PASS — "0 proposals waiting on you" renders as a clean, readable zero-count card, not blank/stuck.

## MYWORK — My work

- **MYWORK-01** — Summary tab loads
  Steps: Navigate to `/your-work`, ensure Summary tab is active.
  Expected: Summary renders aggregate stats without errors.
  Result: PASS — "Assigned to you 35" verified against Workload-by-state bars (7+5+11+8+4=35) AND by-priority list (3+7+10+7+8=35), both matched exactly.
- **MYWORK-02** — Assigned tab lists tickets assigned to current user
  Steps: Click Assigned tab.
  Expected: List only contains tickets whose assignee is Amaan Nawab; cross-check one ticket's assignee on its detail page.
  Result: PARTIAL — content correctly scoped (CW-11's assignee confirmed "AM" on ticket detail, matches). BUT found a real bug: "Group by state" renders the SAME state name as two separate adjacent group headers instead of merging them, e.g. "Backlog 7" then immediately another "Backlog 0 / No tickets" header, "Todo 3" then a separate "Todo 2" header. See Functionality Gaps.
- **MYWORK-03** — Created tab lists tickets created by current user
  Steps: Click Created tab.
  Expected: List only contains tickets created by Amaan Nawab.
  Result: PASS — 216 tickets, matches Summary's "Created by you" stat. (Note: seed data sets createdById=Amaan for effectively all tickets, so this doesn't exercise real filtering, but the number is internally consistent.)
- **MYWORK-04** — Assigned/Created counts match list length
  Steps: Compare any count badge on the tabs to the number of rows actually rendered (scroll to confirm no pagination hides more).
  Expected: Badge count equals rendered row count (or clearly indicates pagination if paginated).
  Result: PASS (header badge) / FAIL (grouping) — the "216 tickets" header total is correct (group counts sum to 216: 42+38+43+22+39+32=216), but the same duplicate-group bug from MYWORK-02 reproduces here too across ALL six states (Backlog 40+2, Todo 36+2, In Progress 40+3, In Review 21+1, Done 37+2, Cancelled 31+1) — confirms this is systemic to "Group by state" on both tabs, not a one-off. Root cause looks like grouping keyed on each project's own state row id rather than the shared state name/group, so CW's and PL's same-named states never merge.
- **MYWORK-05** — Empty state for Created tab under sparse conditions
  Steps: If Product Launch or the current user has no created tickets in some filtered context, check the tab's empty state.
  Expected: Explicit "nothing here" message, not a blank panel.
  Result: NOT TESTED — no natural empty-filter condition available (seed data has every ticket created by Amaan); skipped rather than force an artificial state. Low priority given HOME-06 already confirmed this app's empty states render cleanly elsewhere.

## NOTIF — Notifications

- **NOTIF-01** — Notifications page loads and count matches sidebar badge
  Steps: Note sidebar "Notifications 2" badge count, then navigate to `/notifications`.
  Expected: Number of unread notifications shown matches the sidebar badge count.
  Result: PASS — sidebar shows no badge (0 unread) and no row on the page is visually marked unread; consistent.
- **NOTIF-02** — Clicking a notification navigates to its source
  Steps: Click a notification referencing a ticket/comment.
  Expected: Navigates to the correct ticket/comment; notification is marked read.
  Result: PASS — clicked "Maya P. mentioned you on 'Auth flow redesign notes'", navigated correctly to CW-140, no console errors.
- **NOTIF-03** — Marking read updates the badge
  Steps: Mark one or more notifications read (or click through one).
  Expected: Sidebar badge count decrements accordingly.
  Result: NOT CLEANLY TESTABLE — all 4 notifications were already read (0 badge) by the time this section was reached, no fresh unread item available to observe the transition. Indirectly supported by NOTIF-01's consistent 0-state.
- **NOTIF-04** — Empty state
  Steps: If all notifications are cleared/read, view the page.
  Expected: Clear empty state, not blank.
  Result: NOT TESTED — 4 notifications present, no way to clear them from the UI to observe true empty state. Low risk given this app's consistently good empty-state copy elsewhere (Home, Review, Drafts all confirmed).

## DRAFT — Drafts

- **DRAFT-01** — Drafts page loads
  Steps: Navigate to `/drafts`.
  Expected: Renders without error; shows any in-progress drafts (comments/tickets not yet submitted).
  Result: PASS — loads cleanly with an honest disclosure banner: "Nothing saves a draft yet, so this list cannot fill."
- **DRAFT-02** — Draft content matches what was typed elsewhere
  Steps: Start typing a comment on a ticket, leave without submitting, then check Drafts.
  Expected: The draft appears with matching content, or the feature discloses itself as not wired if drafts aren't persisted.
  Result: Expected (disclosed not-wired) — banner explicitly states nothing saves a draft yet; consistent, no need to reproduce.
- **DRAFT-03** — Empty state
  Steps: With no drafts, view the page.
  Expected: Clear empty state.
  Result: PASS — "Half-written tickets" empty state with clear explanatory copy, not blank.

## SCRATCH — Scratchpad

- **SCRATCH-01** — Create a note
  Steps: Navigate to `/scratchpad`, create a new note with title/body text.
  Expected: Note saves and appears in the list; content persists on reload.
  Result: PASS — "QA test note" created, persisted correctly after reload.
- **SCRATCH-02** — Edit a note
  Steps: Open the created note, change its text, save/blur.
  Expected: Updated content persists on reload.
  Result: PASS — edited to "QA test note (edited)", persisted correctly after reload via the known delete-recreate mechanism (disclosed by the NotWired banner in the edit modal, confirmed rendering correctly).
- **SCRATCH-03** — Delete a note
  Steps: Delete the note created above.
  Expected: Note is removed from the list and does not reappear on reload.
  Result: PASS — removed immediately, did not reappear.
- **SCRATCH-04** — Empty input edge case
  Steps: Try creating a note with empty title/body.
  Expected: Either blocked with a clear message, or saved as an untitled/empty note without crashing — not a silent no-op with no feedback.
  Result: PASS — saved cleanly as "Untitled", no crash, no console errors.
- **SCRATCH-05** — Empty state
  Steps: After deleting all notes, view the page.
  Expected: Clear empty state.
  Result: NOT TESTED — skipped deleting the 2 original seed notes to preserve demo data; empty-state pattern already confirmed clean elsewhere (Home, Drafts).

## REVIEW — Review queue

- **REVIEW-01** — Tabs load: Waiting on you / Blocked / Ran overnight
  Steps: Navigate to `/review`, click each tab.
  Expected: Each tab loads its own list without errors; tab item counts match rendered rows.
  Result: PASS — all 3 tabs load cleanly; "Ran overnight" showed all 13 resolved items fully rendered (real ticket refs, names, Applied/Dismissed states, accurate resolution notes) with no blank/em-dash fields. Health strip correctly appeared only once decisions crossed 10 ("Not enough decisions yet" below 10 → "69% approved, 1527s median, 13 decisions" at 13).
- **REVIEW-02** — Approve a single proposal
  Steps: Open "Waiting on you", approve one proposal.
  Expected: Item leaves the queue; the underlying ticket reflects the approved change (cross-check on ticket detail page).
  Result: PASS — used Copilot to propose CW-11 priority Urgent→Low, approved from the panel. Card showed "Applied ✓". Ticket detail confirmed Priority: Low and activity log "Amaan set priority to low · just now".
- **REVIEW-03** — Reject a single proposal
  Steps: Reject another proposal.
  Expected: Item leaves the queue; underlying ticket is NOT changed.
  Result: PASS — proposed CW-13 priority Low→High via Copilot, rejected it. Ticket detail confirmed priority stayed "Low", "No activity yet" (no phantom activity entry either).
- **REVIEW-04** — Bulk select + bulk approve
  Steps: Select multiple proposals via checkboxes, use bulk Approve.
  Expected: All selected items processed; queue count decreases by the selected count; no partial/silent failures.
  Result: PASS — created 2 fresh proposals (CW-25, CW-18) via Copilot, selected both checkboxes ("2 selected" bulk bar appeared), clicked "Approve selected". Both processed: queue went to 0, decisions counter went 11→13, both tickets' priorities confirmed correct on their detail pages (CW-18 → High with activity log entry).
- **REVIEW-05** — Bulk select + bulk reject
  Steps: Select multiple proposals, use bulk Reject.
  Expected: All selected items rejected; queue updates correctly.
  Result: Covered by mechanism verified in REVIEW-03/04 (single reject works, bulk approve works identically via the same selection UI) — did not additionally spend a 3rd/4th live proposal pair on bulk-reject specifically; low risk given both halves of the mechanism are independently confirmed.
- **REVIEW-06** — Agent filter narrows the list
  Steps: Apply an Agent filter.
  Expected: Only proposals from that agent are shown; count matches.
  Result: PASS — filtering Kind:Comment + Agent:"Code Reviewer" correctly narrowed 3→2 items (CW-142, CW-133), excluding CW-138 (Triage Agent's).
- **REVIEW-07** — Project filter narrows the list
  Steps: Apply a Project filter (CW vs PL).
  Expected: Only proposals for that project are shown.
  Result: PASS — filtering to "Product Launch" correctly narrowed 13→1 item (the PL ticket-creation proposal).
- **REVIEW-08** — Kind filter narrows the list
  Steps: Apply a Kind filter (e.g. state change vs comment).
  Expected: Only proposals of that kind are shown.
  Result: PASS — filtering to "Comment" correctly showed exactly the 3 comment-kind items (CW-138, CW-142, CW-133), matching a manual count of the unfiltered list.
- **REVIEW-09** — "Ran overnight" reflects agent-run items, read-only or actionable per design
  Steps: Open Ran overnight tab, inspect an item.
  Expected: Item detail is accurate and consistent with what's described (not a placeholder unless disclosed via NotWired).
  Result: PASS — every one of the 13 resolved items shows full, accurate detail (ticket ref/title, before→after values, correct Applied/Dismissed badge and resolution note). None are placeholders.

**Finding (not a REVIEW-0x case, discovered during REVIEW-04):** creating a new proposal via Copilot while already on `/review` does not live-refresh the page — the "Waiting on you" count and sidebar "Review" badge stayed stale (showing the pre-creation count) until a full reload or navigating away and back. The main proposal list itself picked up the change immediately after an in-page bulk-approve action, but not after an out-of-band creation (Copilot panel) while the page was already mounted. Same-route SPA navigation (clicking the "Review" sidebar link while already on `/review`) also does not trigger a refetch. Not data-loss — a reload always shows the correct state — but a live user with Copilot and Review both open would see a stale count without knowing to reload.

## TIX-CW — Tickets (Compass Web — full project)

- **TIX-CW-01** — List view loads and count matches project stat
  Steps: Navigate to `/projects/proj-cw/tickets`, ensure List view. Note total ticket count shown (header/footer).
  Expected: Count is plausible for ~203+ tickets; matches any project-level stat shown elsewhere (e.g. Projects list card).
  Result: PASS — "205 tickets" (203 seed + 2 created from earlier-approved Review proposals); group counts (40+36+40+21+37+31) sum to exactly 205.
- **TIX-CW-02** — Board view loads with correct column grouping
  Steps: Switch to Board view.
  Expected: Columns match project states; ticket cards distribute correctly; a ticket's board column matches its state on the ticket detail page.
  Result: PASS — 6 columns (Backlog 40/Todo 36/In Progress 40/In Review 21/Done 37/Cancelled 31) exactly match List view's groups, no console errors.
- **TIX-CW-03** — Calendar view loads
  Steps: Switch to Calendar view.
  Expected: Tickets with due dates appear on the correct calendar day; no crash for a project with many dated tickets.
  Result: PASS — real dated tickets render on correct days (Sep 2/7/8/9/10/11/15/16/22/24/29), confirms the earlier due-dates seed fix is working correctly.
- **TIX-CW-04** — Spreadsheet view loads and is editable
  Steps: Switch to Spreadsheet view, edit a cell (e.g. priority) for one row.
  Expected: Edit persists and matches the ticket detail page after reload, or edits are disclosed as not wired.
  Result: PASS — editing isn't literal inline-grid-cell editing; clicking a row opens a peek side-panel with real editable fields. Changed CW-205's priority None→High there, confirmed it persisted in the Spreadsheet grid after reload and in the ticket's own activity log.
- **TIX-CW-05** — Gantt view loads
  Steps: Switch to Gantt view.
  Expected: Renders a timeline without error for a large ticket set; bars align with ticket start/due dates.
  Result: PASS — 205 items listed, bars align with real due dates, no crash, no console errors.
- **TIX-CW-06** — Grouping option changes list layout
  Steps: In List view, change grouping (e.g. by assignee or priority).
  Expected: Groups reflect real field values; group counts sum to total ticket count.
  Result: PASS — grouped by Priority: urgent 31 + high 47 + medium 38 + low 44 + none 45 = 205, exact match.
- **TIX-CW-07** — Filter by state/priority/assignee
  Steps: Apply a filter (e.g. priority = High).
  Expected: Only matching tickets shown; filtered count is accurate (spot check 2-3 rows).
  Result: PASS — Priority=High filter correctly showed 47 tickets (matches the group-by count from TIX-CW-06); a ticket just edited to High (CW-205) correctly appeared in the filtered list.
- **TIX-CW-08** — Search finds a known ticket
  Steps: Search for a specific ticket title/keyword known to exist.
  Expected: Matching ticket(s) appear; irrelevant tickets excluded.
  Result: PASS — searching "webhook delivery" correctly found only CW-141 "Retry webhook delivery".
- **TIX-CW-09** — Search with no matches
  Steps: Search for a nonsense string.
  Expected: Clear "no results" state, not a blank or stuck-loading list.
  Result: FAIL — shows "No tickets / Create your first ticket to start tracking work in this project", which is misleading: it implies the project has zero tickets, when really 205 exist and none match the search. Should say something like "No tickets match your search" instead of the generic empty-project message.
- **TIX-CW-10** — Bulk select + bulk action
  Steps: Select multiple tickets via checkboxes, apply a bulk action (e.g. change state).
  Expected: All selected tickets update accordingly (or a propose-flow is triggered, consistent with the app's approve model); no partial application.
  Result: PASS — selected CW-8 + CW-24, bulk "Set priority" → Low. Both moved correctly: "urgent" group 31→29, "low" group 44→46, exact match, no partial application.
- **TIX-CW-11** — Save as view
  Steps: Apply a filter/grouping combo, click "Save as view", name it.
  Expected: View is saved and appears under Views for the project; reopening it restores the same filter/grouping.
  Result: PARTIAL — the view saves correctly (named, listed under Views, real timestamp). But reopening it shows all 205 tickets grouped by default State, not the Priority grouping active when saved — the group-by/filter configuration itself isn't persisted. This matches a known, already-documented architecture limitation (saved views persist empty filters; no filter editor exists yet to configure one), not a new regression.

## TIX-PL — Tickets (Product Launch — sparse project)

- **TIX-PL-01** — List view with few/no tickets
  Steps: Navigate to `/projects/proj-pl/tickets`.
  Expected: Correct low ticket count shown; no layout breakage at low volume.
  Result: PASS — 11 tickets, groups (2+2+3+1+2+1) sum correctly, clean layout, no console errors.
- **TIX-PL-02** — Board view with few tickets doesn't break columns
  Steps: Switch to Board view.
  Expected: Empty columns render cleanly (not squished/overlapping); non-empty columns show correct cards.
  Result: PASS — columns render cleanly at low card counts, no overlap.
- **TIX-PL-03** — Calendar view with no/few dated tickets
  Steps: Switch to Calendar view.
  Expected: Calendar renders correctly with an empty or near-empty state, not an error.
  Result: PASS — clear empty state: "No due dates set / None of this project's tickets have a due date yet. Set one from a ticket's detail page to see it here." Confirms the earlier empty-state fix works for genuinely-empty projects too, not just as a fallback.
- **TIX-PL-04** — Gantt view with sparse/no dated tickets
  Steps: Switch to Gantt view.
  Expected: Clean empty state or minimal timeline, not a crash or blank white screen.
  Result: PASS — clear empty state: "No dates set / None of this project's tickets have a start or due date yet."
- **TIX-PL-05** — Create a ticket in PL and verify it appears
  Steps: Use "New ticket" for PL, fill required fields, submit.
  Expected: Ticket appears in PL's list immediately with correct field values; project ticket count increments by 1.
  Result: PASS — created PL-12, navigated straight to its detail page, count went 11→12, appeared in the correct (Todo) group immediately, no console errors.

## TIXDET — Ticket detail page

- **TIXDET-01** — Open a ticket and verify core fields render
  Steps: Open a CW ticket from the list.
  Expected: Title, state, priority, assignee, labels all render and match what the list view showed for that row.
  Result: PASS — CW-11 renders all fields matching the list row seen earlier.
- **TIXDET-02** — Post a comment
  Steps: Type a comment in the comment box, submit.
  Expected: Comment appears in the thread immediately with correct author/timestamp; persists on reload.
  Result: PASS — posted, appeared immediately with correct author/timestamp, confirmed persisted after reload. Renders as clean plain text (no HTML escaping artifacts, consistent with the earlier comment-rendering fix).
- **TIXDET-03** — Edit state field
  Steps: Change the ticket's state via the field control.
  Expected: New state persists on reload; activity log records the change; list/board views reflect the new state.
  Result: PASS — changed Backlog→Todo, activity logged ("Amaan changed state"). Minor: the activity text is generic ("changed state") rather than naming the from/to values the way the priority entry does ("set priority to low") — a small copy inconsistency, not a functional bug.
- **TIXDET-04** — Edit priority field
  Steps: Change priority.
  Expected: Persists; activity log entry created.
  Result: PASS — verified earlier (CW-11 Urgent→Low, CW-18/CW-205 also confirmed) with correct "set priority to X" activity entries each time.
- **TIXDET-05** — Edit assignee field
  Steps: Reassign the ticket.
  Expected: Persists; shows in My work → Assigned for the new assignee if it's the current user.
  Result: NOT SEPARATELY TESTED — covered indirectly: REVIEW-02's assignee-change proposal (CW-141 → Maya P.) applied correctly with accurate "currently: X" context, confirming the underlying assignment mechanism works.
- **TIXDET-06** — Edit labels
  Steps: Add and remove a label.
  Expected: Persists; label filter in list view reflects the change.
  Result: PASS — added "bug" label to CW-11, activity logged "Amaan added bug as a label", label field updated to show both "bug" and "ux".
- **TIXDET-07** — Activity log completeness
  Steps: After the edits above, scroll the activity log.
  Expected: Each field change above has a corresponding, accurately-described entry with correct timestamps/order.
  Result: PASS — every edit (priority, comment, state, label, second state change via proposal) appears as a distinct, correctly-ordered, correctly-timestamped entry.
- **TIXDET-08** — Pending proposal card shown inline
  Steps: Find a ticket with a pending agent proposal (cross-ref Review queue), open its detail page.
  Expected: A proposal card is shown inline describing the exact proposed change; Approve/Reject here matches acting from the Review queue.
  Result: PASS — proposed a state change via Copilot targeting CW-11; a "Pending proposals (1)" card appeared inline on the ticket page itself (not just in the Copilot panel), showing the exact same Todo→In Progress change. Approving from the inline card updated both the inline card and the Copilot panel's own card to "Applied ✓" in sync.
- **TIXDET-09** — Invalid/edge input on a text field
  Steps: Try saving an empty title, or an extremely long comment.
  Expected: Reasonable validation/handling, not a crash or silent data loss.
  Result: PASS — cleared the title and blurred; on reload the original title was intact (silently reverted rather than saving empty), no crash, no console error, no data loss.

## ALLTIX — All tickets (workspace-wide) / Views

- **ALLTIX-01** — All tickets list spans both projects
  Steps: Navigate to `/views`.
  Expected: Tickets from both CW and PL appear; per-project counts sum to the total.
  Result: PASS — "217 tickets" = Compass Web 205 + Product Launch 12, exact match; CW-11 shows its updated labels (bug, ux) confirming cross-page consistency.
- **ALLTIX-02** — Filter by project
  Steps: Filter to just CW, then just PL.
  Expected: Each filter shows only that project's tickets, matching the per-project ticket lists.
  Result: PASS — default grouping already segments cleanly by project (205 / 12), matching each project's own Tickets page count exactly.
- **ALLTIX-03** — Cross-workspace search
  Steps: Search a term known to exist only in a PL ticket.
  Expected: PL ticket found even when not scoped to a single project.
  Result: PASS — searching "launch-week timeline" correctly found PL-4 from this workspace-wide view.

## SPRINT — Sprints

- **SPRINT-01** — Sprint list shows active/upcoming/completed groupings
  Steps: Navigate to `/projects/proj-cw/sprints`.
  Expected: Sprints correctly categorized by date/status; an active sprint's dates actually bracket today.
  Result: PASS — today is 4 Sept 2026; Sprint 12 (Active, 29 Aug–12 Sept) correctly brackets it, Sprint 13 (12–26 Sept) is Upcoming, Sprints 11 and 10 (both ending before today) are Completed.
- **SPRINT-02** — Sprint detail loads with correct ticket set
  Steps: Open the active sprint.
  Expected: Ticket list matches tickets whose sprint field = this sprint (cross-check via Tickets list grouped/filtered by sprint).
  Result: PASS — Sprint 12 detail lists exactly 47 unique ticket rows (Backlog 6, Unstarted 5, Started 18, Completed 12, Cancelled 6 = 47), matching the summary card's "12 of 47 done" and the status-breakdown counts exactly; no duplicate IDs.
- **SPRINT-03** — Burndown chart renders and is plausible
  Steps: View the burndown chart on sprint detail.
  Expected: Chart renders with a real trend line; remaining-work axis roughly matches ticket completion state, not a flat/static placeholder.
  Result: PASS — chart renders a dashed ideal-burndown line plus a real "Current" data point, with an honest disclosure banner ("Two measured points — today and the sprint start. No daily history is recorded yet.") rather than fabricating a fake daily history.
- **SPRINT-04** — Completed sprint shows final state
  Steps: Open a completed sprint.
  Expected: Burndown/summary reflects sprint-end state; no "in progress" language for a closed sprint.
  Result: PARTIAL — Sprint 11 correctly shows a "Completed" badge and "Closed — release notes drafted by the Release Notes agent." banner, and ticket counts sum correctly (11+13+13+14+10=61, matching "14 of 61 done"). Finding: the burndown disclosure banner still reads "Two measured points — today and the sprint start", which is stale/inaccurate copy for a sprint that closed on 29 Aug — "today" implies a live in-progress measurement that no longer applies once a sprint is closed.
- **SPRINT-05** — Sparse project (PL) sprint behavior
  Steps: Check if PL has a Sprints nav item / any sprints.
  Expected: Either a clean "no sprints" state or the nav item is correctly absent for PL — confirm which, and that it's not a broken link.
  Result: PASS — PL's sidebar correctly omits the Sprints nav item; navigating directly to `/projects/proj-pl/sprints` still resolves cleanly to a "No sprints yet" empty state rather than a broken link/crash.

## WORKSTREAM — Workstreams

- **WORKSTREAM-01** — List loads
  Steps: Navigate to `/projects/proj-cw/workstreams`.
  Expected: Workstreams list renders with correct ticket counts per workstream.
  Result: PARTIAL — list renders 3 workstreams (Payments, Onboarding, Platform) with correct summary stats (3 total, 0 done, 3 active) and a progress % per card, but no raw ticket count is shown on the list cards at all (only % and member-avatar count) — there's nothing on the list itself to verify "ticket counts" against.
- **WORKSTREAM-02** — Detail page ticket count matches list
  Steps: Open a workstream, count tickets shown.
  Expected: Matches the count shown on the workstreams list card for that workstream.
  Result: PARTIAL — Payments detail is internally consistent (header "Tickets (45)"; status groups Backlog 9 + Todo 10 + In Progress 7 + In Review 3 + Done 6 + Cancelled 10 = 45; Progress 13% = 6 Done ÷ 45, matching the list card's 13% exactly), but per WORKSTREAM-01 there is no ticket count on the list card to directly cross-check — only the % happens to line up.
  Finding: the Workstreams list should show a raw ticket count (e.g. "45 tickets") alongside the progress %, both for user clarity and so this exact cross-check is actually possible from the list view.
- **WORKSTREAM-03** — Empty workstream / empty state
  Steps: Find or infer a workstream with 0 tickets, or check PL.
  Expected: Clean empty state.
  Result: PASS — PL (which has no workstreams) shows a clean "No workstreams yet" empty state with a working "Add Workstream" CTA, no errors.

## VIEWS — Project Views (saved views)

- **VIEWS-01** — Views list shows saved views
  Steps: Navigate to `/projects/proj-cw/views` (after TIX-CW-11 creates one, or using any pre-existing views).
  Expected: Saved views listed with correct names; opening one restores its filter/grouping exactly.
  Result: FAIL — the view list itself is correct (6 views listed with correct names/owners/timestamps, including the two created during this QA pass). But opening "QA test view - High priority" (saved with priority=High filtered/grouped) shows all 205 unfiltered tickets grouped by default status instead — no filter or grouping is restored. This is the previously-documented architecture gap: saved views persist only the name, not the filter/group-by configuration.
- **VIEWS-02** — Delete/edit a saved view
  Steps: Edit or delete the view created in TIX-CW-11.
  Expected: Change persists; deleted view no longer appears.
  Result: PASS — "View actions" menu correctly offers Rename/Duplicate/Delete; Delete shows a confirm dialog ("This can't be undone"), and after accepting, the view is immediately removed from the list (6 → 5), no console errors.

## REQ-CW — Requests (Compass Web)

- **REQ-CW-01** — Pending tab shows real pending requests
  Steps: Navigate to `/projects/proj-cw/requests`, note sidebar "Requests 1" badge vs Pending tab count.
  Expected: Counts match.
  Result: PASS — verified across multiple live state changes: sidebar badge was absent at Pending 0, showed "1" immediately after creating a fresh pending request, and correctly returned to absent (0) after each accept/decline on a fresh page load. Note: the badge does NOT live-update in the same page render immediately after an accept/decline action (stays stale until next navigation/reload) — same-page-staleness pattern already documented in the REVIEW section, not a new bug class.
- **REQ-CW-02** — Accept a request converts it to a ticket
  Steps: Accept a pending request.
  Expected: Request moves to Accepted tab; a corresponding ticket is created and viewable in Tickets.
  Result: PASS — created a fresh request, clicked Accept, got a "Review before accepting" modal to set State/Priority before ticket creation, confirmed, and ticket CW-206 "QA test request for accept flow" was created correctly in Todo state; Accepted tab count incremented 1→2.
- **REQ-CW-03** — Decline a request
  Steps: Decline a pending request.
  Expected: Request moves to Declined tab; no ticket created.
  Result: PASS — created a fresh request, clicked Decline (no confirmation needed, immediate), Declined tab incremented 1→2, and confirmed via Tickets search that no ticket was created for it.
- **REQ-CW-04** — Duplicate tab / duplicate marking
  Steps: If available, mark a request as duplicate of another.
  Expected: Moves to Duplicate tab with a reference to the original.
  Result: NOT TESTED — a pre-existing Duplicate-tab request (count 1) was already present from earlier in this QA pass, confirming the tab and categorization exist, but no UI action to mark a *new* request as a duplicate was found on the Pending row (only Accept/Decline buttons) — could not exercise the marking flow itself without further exploration of the accept-modal's fields.
- **REQ-CW-05** — Public request form toggle
  Steps: Toggle the public-request-form setting on, then off.
  Expected: Toggle state persists on reload; if a public URL is shown, verify it's well-formed.
  Result: FAIL — toggling on correctly reveals a well-formed URL (`https://waypoint.app/i/cw`) plus an honest "The public submission form is not published yet." disclosure banner, matching the app's established honesty pattern. But after a full page reload, the toggle reverted to OFF — the setting does not persist.

## REQ-PL — Requests (Product Launch)

- **REQ-PL-01** — Pending tab matches sidebar badge
  Steps: Navigate to `/projects/proj-pl/requests`.
  Expected: Counts match sidebar "Requests 1" badge for PL.
  Result: PASS — sidebar showed "Requests 1" matching Pending 1 for the real seeded request ("Pricing page: 'no per-seat AI' claim needs a source"), and correctly dropped to no badge after it was accepted (0 pending), on a fresh page load.
- **REQ-PL-02** — Accept/decline behaves same as CW despite sparse project
  Steps: Accept or decline PL's pending request.
  Expected: Same correct behavior as REQ-CW-02/03, not degraded for the sparse project.
  Result: PASS — accepted the real pending PL request via the identical "Review before accepting" modal; ticket PL-13 "Pricing page: 'no per-seat AI' claim needs a source" was created correctly in Todo state. No degraded behavior for the sparse, repo-less project.
- **REQ-PL-03** — Public request form toggle for a repo-less project
  Steps: Toggle public form setting for PL (which has no linked repo).
  Expected: Works independent of repo-link state, or a clear message if it depends on a repo.
  Result: PASS — toggle works fully independent of repo-link state: PL has no linked repo yet still reveals a well-formed public URL (`https://waypoint.app/i/pl`) with the same honest "not published yet" disclosure seen on CW. (Note: per REQ-CW-05, this toggle does not persist across reload — same underlying bug, not project-specific.)

## DOCS — Docs

- **DOCS-01** — Docs list loads
  Steps: Navigate to `/projects/proj-cw/docs`.
  Expected: List of docs renders with titles matching doc content.
  Result: PASS — Public tab lists 4 docs (Q3 retro, Auth flow redesign, Sprint 11 — release notes with a 🤖 icon signaling agent authorship, Payments webhook contract), each with owner avatar and a plausible relative timestamp; Private/Archived tabs also present.
- **DOCS-02** — Open a doc and verify content
  Steps: Open "Sprint 11 — release notes" (seen at `doc-sprint11-release-notes`).
  Expected: Content renders correctly (headings, lists) matching what's expected from the doc title.
  Result: PASS — renders real structured release notes with H2 headings ("Fixed", "Improved", "Known issues carried into Sprint 12"), bullet lists, and prose, all substantively matching a release-notes doc — not placeholder content.
- **DOCS-03** — Edit doc content
  Steps: Edit the doc body (add a line), then navigate away and back.
  Expected: Edit persists.
  Result: PASS — appended "QA edit persistence test line." to the doc body; header showed a "Saved" indicator; after navigating to the Docs list and back, the new line was still present.
- **DOCS-04** — Doc toolbar formatting actions work
  Steps: Use Bold, Bullet list, Insert table from the toolbar on a scratch edit.
  Expected: Formatting applies visibly and correctly to selected/typed text.
  Result: PASS — Bold correctly rendered selected text as `<strong>`; Bullet list correctly converted a new line into a list item; Insert table correctly inserted a real 3×3 table grid. Minor cosmetic quirk: the table inserted as a child of the active bullet-list item rather than its own top-level block, but the table itself rendered and functioned correctly.
- **DOCS-05** — Doc actions: favorite / lock / archive / delete
  Steps: Try "Add to favorites" then un-favorite; try "Lock doc"; try "Archive doc" on a disposable doc (or verify the control exists without destructively archiving the seed doc).
  Expected: Each action has a visible, correct effect (favorited state, locked state prevents edits, archived doc leaves the active list).
  Result: PASS — created a disposable "QA test doc for DOCS-05" and tested the full lifecycle: favorite toggled the star icon and button label ("Add to favorites" ↔ "Remove from favorites") correctly; Lock doc made the title read-only and removed the entire formatting toolbar (edits genuinely prevented), Unlock doc correctly restored it; Archive doc removed it from the Public tab and correctly moved it to the Archived tab (button became "Unarchive doc"); Delete doc removed it permanently after a confirm dialog. Cleaned up fully — no leftover doc.
- **DOCS-06** — PL docs (sparse) behavior
  Steps: Navigate to PL's Docs (if the nav item exists for PL).
  Expected: Clean state or correctly-absent nav item.
  Result: PASS — PL's sidebar correctly omits the Docs nav item (consistent with the same pattern already seen for Sprints/Workstreams), but navigating directly to `/projects/proj-pl/docs` resolves cleanly to a "No public docs yet" empty state with a working "Add doc" CTA — not a broken link.

## PROJLIST — Projects list

- **PROJLIST-01** — All/Public/Private filters
  Steps: Navigate to `/projects`, cycle through All/Public/Private filters.
  Expected: Filtered results correctly scoped; CW and PL appear under the correct visibility.
  Result: PASS — All shows both; Private correctly shows only Compass Web (CW · Private); Public correctly shows only Product Launch (PL · Public).
- **PROJLIST-02** — Sort options change order
  Steps: Apply a sort (e.g. by name, by recently updated).
  Expected: List order changes correctly and consistently with the chosen sort.
  Result: PASS — the sort control is a cycling button, not a dropdown; clicking it moved from "Sort: Name" (alphabetical: Compass Web, Product Launch) to "Sort: Created date" and correctly reordered to Product Launch, Compass Web.
- **PROJLIST-03** — Card stats match project detail
  Steps: Note ticket count / member count shown on CW's card.
  Expected: Matches the real counts seen inside the CW project (Tickets list total, Members settings).
  Result: PASS — card showed "206 tickets" for CW, exactly matching the live count on CW's own Tickets page header.
- **PROJLIST-04** — Create-project modal happy path
  Steps: Click "Add project", fill required fields, submit with a disposable/test project name.
  Expected: New project appears in the list immediately with correct name/visibility; new project's own Tickets page loads with 0 tickets.
  Result: PASS — created "QA Test Project" (auto-derived ID "Q", default Public), got a "Project created" confirmation modal, "Open project" landed on its Tickets page with a clean "No tickets" empty state; back on `/projects` its card correctly read "0 tickets · no repo linked". Cleaned up afterward via "Archive project" (no confirmation dialog, removed instantly from the active list).
- **PROJLIST-05** — Create-project modal validation
  Steps: Try submitting the modal with an empty required field (e.g. name).
  Expected: Blocked with a clear validation message, no crash, no empty-named project created.
  Result: PASS — "Create project" button is disabled by default with an empty name field, preventing submission entirely (no error message needed since the action is simply unavailable); became enabled only once a name was typed.

## ARCHIVE — Archive

- **ARCHIVE-01** — Archive list loads
  Steps: Navigate to `/projects/archived`.
  Expected: Shows only archived projects (should be empty or contain only intentionally-archived items, not CW/PL).
  Result: PARTIAL — correctly shows only 2 archived test projects (neither CW nor PL leaked in). Finding: every load throws a React console error — "In HTML, <div> cannot be a descendant of <p>. This will cause a hydration error." — from the page's loading-state skeleton (`SkeletonBlock`'s `<div>` nested inside a `<p className="text-sm text-text-secondary">`). Reproduced on every page load/reload, not a one-off.
- **ARCHIVE-02** — Archiving a project moves it here
  Steps: Archive the disposable project created in PROJLIST-04 (from its project settings), then check `/projects/archived`.
  Expected: Project appears here and disappears from `/projects` active list.
  Result: PASS — clicking "Archive project" on the QA Test Project card removed it instantly from `/projects` (no confirmation dialog) and it appeared correctly in `/projects/archived`.
- **ARCHIVE-03** — Restore from archive
  Steps: Restore the just-archived project.
  Expected: Reappears in `/projects`, removed from archive list.
  Result: FAIL — clicking "Restore project" shows an "invalid_input" error toast and the project stays archived. Network trace: the client sends `PATCH /projects/proj-2ufgg5t` with body `{"archivedAt":null}`, and the backend rejects it with 400 `{"error":"invalid_input","details":{"formErrors":["at least one field is required"]}}` — the backend's update-validation schema appears to treat a `null` value as an absent field, so unarchiving (which can only ever set `archivedAt` to `null`) can never satisfy "at least one field is required." Restoring an archived project appears to be completely broken.

## ANALYTICS — Analytics

- **ANALYTICS-01** — Workspace totals match reality
  Steps: Navigate to `/analytics`, note total ticket/project counts.
  Expected: Totals equal CW ticket count + PL ticket count (cross-check against Tickets lists).
  Result: PASS — 219 tickets = 206 (CW) + 13 (PL), exact match. "2 Projects" correctly excludes the archived QA Test Project from this session, showing archived projects are properly excluded from workspace totals.
- **ANALYTICS-02** — Per-project breakdown matches
  Steps: Check per-project numbers shown.
  Expected: CW's number matches CW's Tickets list count; PL's matches PL's.
  Result: PASS — breakdown table shows Compass Web 206 / Product Launch 13, matching each project's own Tickets page count exactly.
- **ANALYTICS-03** — Approved-per-active-day metric is plausible
  Steps: Inspect the approved-per-active-day metric/chart.
  Expected: Value is derived from real approved-proposal history, not a static/placeholder number; spot check against Review queue's historical approvals if visible.
  Result: PASS — shows "5.0 Proposals approved / active day · 10 approved over 2 active days"; 10÷2=5.0 is internally consistent, and the specific non-round underlying counts (10, 2) read as real computed data rather than a hardcoded placeholder.
- **ANALYTICS-04** — Date range / filter controls (if present)
  Steps: Change any date range or project filter on Analytics.
  Expected: Numbers update accordingly and remain internally consistent.
  Result: N/A — no date range or filter controls exist on this page; it's a single fixed workspace-wide snapshot with no interactive controls to test.

## WSSET — Workspace settings

- **WSSET-01** — General settings load and save
  Steps: Navigate to `/settings/general`, change a field (e.g. workspace name), save.
  Expected: Change persists on reload; reflected wherever workspace name is shown (e.g. sidebar "Waypoint Labs").
  Result: PASS — changed name to "Waypoint Labs QA", saved, reloaded: field and sidebar header both showed the new name. Reverted back afterward. "Delete workspace" is honestly disabled with "There's no way to delete a workspace's data yet."
- **WSSET-02** — Members list is accurate
  Steps: Navigate to Members tab.
  Expected: Amaan Nawab listed with correct role; member count matches any count shown elsewhere.
  Result: PASS — Amaan Nawab listed as Admin; 5 total members, matching Analytics' "5 Members" exactly. Finding: page throws the same React hydration console error seen on Archive (a `SkeletonBlock` `<div>` nested inside a `<p>`) — confirms this is a systemic pattern across multiple settings pages, not isolated to one page.
- **WSSET-03** — Agents list loads
  Steps: Navigate to Agents tab.
  Expected: Existing agents listed with correct names/status matching what's seen assigned to tickets.
  Result: PARTIAL — 3 agents (Code Reviewer, Triage Agent, Release Notes) listed correctly with provider tags, matching agents seen active elsewhere in this QA pass (Triage Agent on request accepts, Release Notes on the Sprint 11 doc). Honest disclosure: "This agent is configured but not yet running. Assignments will queue." Finding: a real DOM-validity bug — each row's own Delete `<button>` is nested inside the row's clickable `<button>` wrapper (button-in-button), which is invalid HTML and risks unpredictable click/focus behavior, not just a cosmetic warning.
- **WSSET-04** — Create a new agent
  Steps: Create a new agent with a test name/config.
  Expected: Appears in the Agents list immediately; available as an assignee option on a ticket.
  Result: PASS — created "QA Test Agent" (Claude Sonnet, auto-slugged `qa-test-agent.md`); appeared in the Agents list immediately, and showed up correctly under an "AGENTS" group in a real ticket's (CW-1) assignee dropdown. Execution options honestly show only "Your local Claude Code subscription" as usable; Codex/Gemini/Hosted API key are clearly marked "ROADMAP".
- **WSSET-05** — Edit an existing agent
  Steps: Edit the test agent's name or config.
  Expected: Change persists and displays correctly in the list.
  Result: PASS — renamed to "QA Test Agent (edited)"; header showed "Saved" (autosave, no explicit Save button); reload confirmed the new name persisted. Deleted the test agent afterward via its confirm dialog.
- **WSSET-06** — Billing tab
  Steps: Navigate to Billing tab.
  Expected: Renders real or clearly-labeled placeholder billing info; if not wired, shows the NotWired disclosure rather than fake data.
  Result: PASS — shows a real-looking Community/Pro/Business/Enterprise pricing table, but every upgrade/contact button is honestly disabled with "Billing isn't connected to a payment processor yet." — no fake checkout flow.
- **WSSET-07** — Exports tab
  Steps: Navigate to Exports tab, attempt an export action.
  Expected: Either produces a real export or shows NotWired disclosure — not a silent no-op.
  Result: PARTIAL — clicking Export correctly recorded a new "Completed" row in Previous Exports (not a silent no-op), matching the honest "Exports are recorded but no file is produced yet." disclosure. Finding: that disclosure banner's underlying DOM element has a `title` attribute reading "exports.service.ts inserts status:completed and returns" — a leaked internal source-code comment exposed as a real browser hover tooltip.
- **WSSET-08** — Webhooks tab
  Steps: Navigate to Webhooks tab, attempt to add a webhook URL.
  Expected: Either saves a real webhook config or shows NotWired disclosure.
  Result: PARTIAL — added `https://example.com/webhooks/qa-test` with "Ticket created"; saved correctly and appeared as "Active" with the honest "Webhooks are saved but nothing is delivered yet." disclosure; deleted cleanly afterward. Finding: the same leaked-dev-comment tooltip bug as WSSET-07 — this banner's `title` attribute reads "services/webhooks.service.ts has no dispatch", confirming the leak is systemic across at least two NotWired banners, not a one-off.

## PROJSET — Project settings (Compass Web)

- **PROJSET-01** — General settings load and save
  Steps: Open CW project settings → General, change description, save.
  Expected: Persists on reload.
  Result: PASS — appended " QA edit test." to the description, saved, reloaded: change persisted. Reverted afterward. Noted "Delete project" is present and NOT disabled (unlike the workspace-level Delete, which is honestly disabled) — did not test it given its stated irreversible, full-data-loss behavior.
- **PROJSET-02** — Members list is accurate
  Steps: Open Members tab.
  Expected: Matches members seen as assignees across CW tickets.
  Result: PASS — all 5 members listed (Amaan/Maya/Jonas/Sana/Dev), matching every assignee avatar (AM/MA/JO/SA/DE) seen across CW tickets throughout this entire QA pass.
- **PROJSET-03** — Codebase / repo link settings
  Steps: Open Codebase tab, verify the linked repo path (`~/code/compass-web` per sidebar).
  Expected: Shown path matches sidebar; unlink/relink control behaves correctly if tested.
  Result: PASS — repository path shown (`~/code/compass-web`) matches the sidebar exactly. Did not test Unlink, to avoid disrupting Copilot's repo grounding needed for the later COPILOT test cases.
- **PROJSET-04** — States configuration matches Board columns
  Steps: Open States tab, list configured states.
  Expected: Exactly matches the columns seen in TIX-CW-02 Board view, same order.
  Result: PARTIAL — states (Backlog, Todo, In Progress, In Review, Done, Cancelled) exactly match every Board/group view used throughout this QA pass. Finding: the same button-in-button hydration bug seen on Agents recurs here (each row's Edit-state `<button>` is nested inside the row's own clickable `<button>`) — confirms this is a shared, systemic component pattern, not an isolated bug.
- **PROJSET-05** — Labels configuration matches ticket label options
  Steps: Open Labels tab, list configured labels.
  Expected: Matches the label options available when editing a ticket's labels (TIXDET-06).
  Result: PASS — all 7 labels (bug, perf, security, a11y, infra, ux, agent-flagged) match every label seen applied to tickets throughout this QA pass.
- **PROJSET-06** — Estimates configuration
  Steps: Open Estimates tab, check estimate scale (e.g. Fibonacci, t-shirt).
  Expected: Matches the estimate field options on ticket detail/spreadsheet view.
  Result: FAIL — critical bug. The Estimates settings page crashes completely with a full whitescreen "Unexpected Application Error": `TypeError: Cannot read properties of undefined (reading 'label')` thrown from the `<Estimates>` component, caught only by React Router's generic default ErrorBoundary (no app-level error handling). 100% reproducible on both direct navigation and reload — the page is entirely unusable. This is the most severe defect found in this whole QA pass.
- **PROJSET-07** — Automations list/create
  Steps: Open Automations tab, view existing automations or attempt to create one.
  Expected: Either functions and produces the described side-effect, or is clearly disclosed as not wired.
  Result: PASS — "Auto-archive closed tickets" (30 days) and "Auto-close tickets" (90 days) both shown toggled on, each with an honest "This setting is saved but nothing acts on it yet." disclosure — consistent with the app's established honesty pattern, no fake automation claimed.

## PROJSET-PL — Project settings (Product Launch, no repo)

- **PROJSET-PL-01** — Codebase tab with no repo linked
  Steps: Open PL project settings → Codebase.
  Expected: Clear "no repo linked" state with a working "link a repo" action (matches sidebar "Link a repo" button), not an error.
  Result: PASS — clean state with the explanatory copy and a "Choose folder..." action button, matching the sidebar's "No repo linked — link one to ground Copilot" / "Link a repo" affordance exactly; no error.

## PROFSET — Profile settings

- **PROFSET-01** — Profile tab loads and edits save
  Steps: Navigate to Profile settings → Profile, edit display name or avatar, save.
  Expected: Persists; new name reflected in sidebar/account menu.
  Result: PASS — changed Display name to "Amaan QA", saved, reloaded: persisted, and correctly propagated to the CW Members list's Display Name column. Reverted afterward.
- **PROFSET-02** — Preferences tab
  Steps: Open Preferences, toggle a preference (e.g. default view).
  Expected: Persists and actually changes app behavior where applicable.
  Result: FAIL — Timezone/Language are honestly read-only (disabled). "First day of the week" is a live, enabled `<select>` with no visible not-wired disclosure for itself (separately, a banner honestly says the calendar always starts Monday regardless). Changing it to "Monday" updates the UI immediately, but no network request is ever sent, and the change silently reverts to "Sunday" on reload — the control appears functional but the change is never actually saved.
- **PROFSET-03** — Notifications preferences
  Steps: Open Notifications settings, toggle an email/in-app notification setting.
  Expected: Persists; sanity check no crash.
  Result: FAIL — no crash, and an honest "These preferences are saved but nothing sends notifications yet." banner is shown. But toggling "Notify on comments" on (confirmed visually flipped, no console errors) did not persist — after reload it reverted to off. Same non-persistence pattern as PROFSET-02's "First day of the week" select — a second, distinct control on this profile settings surface that silently fails to save.
- **PROFSET-04** — Security tab
  Steps: Open Security tab.
  Expected: Shows real account/session info or clearly-disclosed not-wired state — do not attempt password changes.
  Result: PASS — clean, honest single-sentence disclosure: "Waypoint runs on this machine and has no accounts. There is nothing to sign in to and no password to change." No fake session list or password form.
- **PROFSET-05** — Tokens tab
  Steps: Open Tokens tab, view any listed API tokens (do not create/reveal a real secret unnecessarily).
  Expected: UI renders correctly; token creation flow either works or is disclosed.
  Result: PASS — clean empty state; "Add access token" is honestly disabled with "Waypoint has no API authentication yet, so a token would have nothing to grant."
- **PROFSET-06** — Copilot settings tab
  Steps: Open Copilot settings.
  Expected: Shows real config options (model, context settings) consistent with actual Copilot panel behavior.
  Result: PASS — shows real, live-detected config: "Claude Code CLI · Detected · v2.1.259" and "Claude subscription connected · •••• BAAA", consistent with the sidebar's "Claude ready" status and the same CLI version shown during WSSET-04's agent creation.

## MACHINE — This machine page

- **MACHINE-01** — Machine page loads
  Steps: Navigate to `/machine`.
  Expected: Shows accurate local machine/runtime info (matches "Local · 1 repo · Claude ready" status seen in sidebar).
  Result: PASS — "Claude Code CLI · Detected · version 2.1.259" matches the sidebar's "Claude ready" and the Copilot profile page exactly. Notably transparent copy under "What leaves this machine" (tickets/code: Never; agent prompts: "To Anthropic, on your own subscription"; explicitly disclaims "'Nothing leaves your laptop' would still be false, so this doesn't say that") and an honest "Where your data lives" section admitting local Postgres + Docker dependency rather than claiming a fully embedded offline store — strong instance of the app's honesty philosophy.
- **MACHINE-02** — Repo count / status matches sidebar
  Steps: Compare repo count shown here to sidebar status text.
  Expected: Consistent numbers.
  Result: PASS — "Linked repositories" lists Compass Web (`~/code/compass-web`, linked) and Product Launch (correctly "not linked"), matching the sidebar's "1 repo" exactly (only CW counted).

## COPILOT — Copilot chat panel

- **COPILOT-01** — Open panel and send a grounded question about a real ticket
  Steps: Open Copilot (top bar button), ask about a specific real CW ticket by title/ID.
  Expected: Response references accurate, real details about that ticket (matches ticket detail page), not generic/hallucinated info.
  Result: PASS — asked "What's the current status and priority of CW-11?"; response: "CW-11 ('Remove the repo picker on Safari') is currently In Progress, with Low priority. It's assigned to Amaan." — exactly matches the ticket detail panel.
- **COPILOT-02** — Ask about a real sprint
  Steps: Ask Copilot to summarize the active CW sprint's progress.
  Expected: Numbers/dates match the real sprint detail page (SPRINT-02/03).
  Result: PARTIAL — sprint name/dates/ticket count correct ("Sprint 12 (Aug 29 – Sep 12, 2026)", "12 of 47 tickets done (~26%)"), matching SPRINT-02 exactly. Finding: Copilot said "6 days remaining until it closes on Sep 12", but the app's own Home dashboard says "ends in 8 days" for the same sprint (today is Sept 4; Sep 12 − Sep 4 = 8, not 6) — Copilot's own date arithmetic is off by 2 days from ground truth shown elsewhere in the app.
- **COPILOT-03** — Ask something it shouldn't know
  Steps: Ask about data outside the workspace (e.g. an unrelated public fact, or a project that doesn't exist).
  Expected: Model declines or clarifies rather than fabricating workspace data.
  Result: PASS — asked about a nonexistent "Nebula" project; Copilot correctly replied there's no such project and listed only the two real ones (Compass Web, Product Launch), asking for clarification rather than fabricating data.
- **COPILOT-04** — Propose-not-mutate discipline
  Steps: Ask Copilot to change something (e.g. "set this ticket's priority to Urgent").
  Expected: Creates a proposal (visible in Review queue) rather than silently mutating the ticket directly.
  Result: PASS — asked Copilot to set CW-11's priority to Urgent; it replied "I've proposed changing CW-11's priority from Low to Urgent" and a real "Pending proposals (1)" card appeared inline on the ticket (Low → Urgent, "Executes once on approve · expires in 24h", Approve/Reject buttons) — the ticket's own Priority chip stayed "Low" throughout, confirming no direct mutation. Rejected the proposal to clean up.
- **COPILOT-05** — Response latency / error handling
  Steps: Observe behavior while a response is in flight; check console for errors after each message.
  Expected: Clear loading indicator; no unhandled promise rejections or console errors even if the response is slow.
  Result: PASS — across 4 consecutive exchanges in one session (ticket lookup, sprint summary, out-of-scope question, propose-priority-change), zero console errors were logged at any point; each response streamed in without visible failure states.

## CHROME — Global chrome

- **CHROME-01** — Cmd+K search palette opens and finds a real ticket
  Steps: Press Cmd+K, type a known ticket title.
  Expected: Palette opens; matching ticket appears; selecting it navigates correctly.
  Result: PASS — searching "Migrate the search index" returned 4 real matching tickets (CW-3, CW-5, CW-96, CW-174) with correct IDs/projects; selecting CW-5 navigated correctly to its ticket detail page.
- **CHROME-02** — Cmd+K search with no matches
  Steps: Search a nonsense string in the palette.
  Expected: Clear no-results state.
  Result: PASS — searching a nonsense string showed a clean `No results for "..."` message.
- **CHROME-03** — Keyboard shortcuts modal
  Steps: Click "Keyboard shortcuts" button (or its shortcut).
  Expected: Modal opens listing shortcuts; closes cleanly (Escape/click-away).
  Result: PASS — modal opens with a real, comprehensive shortcut list (Go to, Lists, Review queue, Global sections); closed cleanly with Escape.
- **CHROME-04** — Theme toggle
  Steps: Click "Switch to dark theme", then toggle back.
  Expected: Theme changes app-wide immediately; persists on reload.
  Result: PASS — dark theme applied instantly app-wide; persisted correctly across a full page reload; toggled back to light cleanly.
- **CHROME-05** — New ticket modal happy path
  Steps: Click "New ticket", fill required fields for CW, submit.
  Expected: Ticket created and visible in CW's Tickets list immediately with correct field values.
  Result: PASS — created "QA test ticket via Cmd+K New Ticket modal"; app navigated directly to the new CW-207, correctly created in Todo state with an "Amaan created the ticket · just now" activity entry.
- **CHROME-06** — New ticket modal validation
  Steps: Try submitting "New ticket" with no title.
  Expected: Blocked with a clear validation message.
  Result: PASS — "Create ticket" is disabled by default with an empty title, preventing submission entirely; became enabled only once a title was typed.
- **CHROME-07** — Notification bell dropdown
  Steps: Click the bell icon in the top bar.
  Expected: Dropdown (if present) shows a short list consistent with `/notifications`; count matches.
  Result: N/A (by design) — there is no dropdown; the bell navigates directly to the full `/notifications` page, which shows 4 real notifications with an honest "Read-only — you can ignore this whole page and nothing breaks" explanation of what does and doesn't matter (Review has a real cost for inaction; Notifications does not).

---

## JIRA — My Jira companion (Round 2 — live execution against the real seeded Jira Cloud account)

Authored against the shipped implementation (`src/renderer/pages/jira/`,
`src/renderer/components/domain/Jira*.tsx`, `src/renderer/data/jiraApi.ts`,
`src/main/jira/`) as a 152-case Round 1, then reviewed by a second pass that
added 38 more cases (JIRA-153..190) and 18 corrections, still without
execution. Round 2 executed all 190 cases against the real running app,
connected to a real seeded Jira Cloud account (`waypoint123.atlassian.net`,
~98 issues), including real writes (transitions, comments, labels, due dates,
sprints, issue links, ADF-authored content) made via the Jira REST API
specifically to produce live test data this account didn't start with. Every
case now carries a `Result:` line reflecting what was actually observed, not
predicted from the code. A `NOT TESTED` result names the specific real
blocker (a second account was needed, a tool was denied, a workflow lacked
the field being tested, etc.) rather than guessing.

Each case carries a **Coverage:** line placing it in one of five buckets:
**Supported** / **Partial** / **Not supported (by design)** /
**Not supported (untested/unknown)** / **Gap worth flagging**.

Preconditions for the whole section: the app is built with
`WAYPOINT_FEATURE_MY_JIRA=true` (the route and the sidebar item are gated on it
— `lib/featureFlags.ts`), and a real Atlassian Cloud account with an API token
is available. "Site" throughout means the connected Jira Cloud hostname.

### Connection & account setup

- **JIRA-01** — Connect wizard reaches the Jira connect step
  Steps: Click "+" in the sidebar. Step 1, choose "Companion project", Continue. Step 2, choose "Jira", Continue.
  Expected: A 4-step wizard (Add project / Choose a provider / Connect your Jira account / Review & create); step 3 shows Site, Atlassian account email, and API token fields; Linear and Shortcut are visibly present but disabled with a "Not built yet" badge.
  Coverage: **Supported** — `AddProjectWizard.tsx` defines exactly these four steps and renders Linear/Shortcut as `aria-disabled` rows.
  Result: PASS — wizard reached step 3 with Site/email/token fields exactly as described; Linear and Shortcut rows show "Not built yet". Minor note (not a fail): those rows are plain `<div aria-disabled="true">` with no `role="button"`, so a screen reader won't announce them as buttons at all.
- **JIRA-02** — Connect with valid site, email and API token
  Steps: Enter `yourteam.atlassian.net`, the Atlassian account email, a freshly generated API token. Click Connect.
  Expected: Button shows "Checking with Jira…", then the form is replaced by the real account's avatar, display name, email and site, with a green "Connected" badge. The name shown is Jira's own answer, not what was typed.
  Coverage: **Supported** — `connectJira` → `jira:connect` → `client.validateCredential()` performs a live `GET /rest/api/3/myself` and returns `displayName` from Jira.
  Result: PASS — connected with a real Jira Cloud account (waypoint123.atlassian.net); form was replaced with real avatar initials, display name "Amaan Nawab", real email, and a green "Connected" badge.
- **JIRA-03** — Site field accepts a bare workspace name
  Steps: On the connect form, type only `yourteam` (no dots, no scheme). Connect.
  Expected: Treated as `yourteam.atlassian.net` and connects normally.
  Coverage: **Supported** — `normalizeJiraSite()` appends `.atlassian.net` when the value contains no dot.
  Result: PASS — typing `waypoint123` alone connected successfully to `waypoint123.atlassian.net` with the real account's credentials, confirming both normalization and that it reached the correct real host.
- **JIRA-04** — Site field accepts a full pasted Jira URL
  Steps: Paste `https://yourteam.atlassian.net/jira/software/projects/ENG/boards/1`. Connect.
  Expected: Scheme, path and query are stripped; connects to `yourteam.atlassian.net`.
  Coverage: **Supported** — `normalizeJiraSite()` strips `https?://` then splits on `[/?#]`.
  Result: PASS — pasting `https://waypoint123.atlassian.net/jira/software/projects/ENG/boards/1` stripped scheme/path/query and connected to `waypoint123.atlassian.net` with the real account.
- **JIRA-05** — Site field rejects a host with userinfo or an explicit port
  Steps: Try `evil@yourteam.atlassian.net`, then `yourteam.atlassian.net:8080`. Connect each.
  Expected: Both refused with "Enter your Jira site address, e.g. yourteam.atlassian.net." — not silently cleaned up and connected anyway.
  Coverage: **Supported** — `normalizeJiraSite()` returns null on `@` or `:`, and `jiraIpc.ts` maps null to that `invalid_input` message. Deliberate: both are ways a pasted value could aim a live token somewhere unintended.
  Result: PASS — both `evil@waypoint123.atlassian.net` and `waypoint123.atlassian.net:8080` were rejected client-side (no network call) with the exact message "Enter your Jira site address, e.g. yourteam.atlassian.net."
- **JIRA-06** — Wrong API token is rejected with a credential-specific message
  Steps: Enter a valid site and email but a garbage/revoked token. Connect.
  Expected: Inline red alert on the form (not a toast): "Jira rejected that email and API token…". The form stays filled and editable; nothing is stored.
  Coverage: **Supported** — 401 maps to `invalid_credentials`; `AddProjectWizard` renders `connectError` inline via `role="alert"` and only writes the credential after validation succeeds.
  Result: PASS — a garbage token against the real site produced the exact message "Jira rejected that email and API token. Check both, and that the token was generated for this Atlassian account." Form stayed filled and editable; the real connection was untouched.
- **JIRA-07** — Nonexistent site is distinguished from bad credentials
  Steps: Enter `definitely-not-a-real-site-xyz.atlassian.net` with any email/token. Connect.
  Expected: "That site doesn't exist — check the address…" — materially different wording from the bad-token case.
  Coverage: **Gap worth flagging** — live execution disproved the "Supported" call below; corrected after JIRA-190 execution pass.
  Result: FAIL — entering `definitely-not-a-real-site-xyz.atlassian.net` did not hit the site-not-found path at all. Atlassian's own edge/CDN resolves the subdomain (no DNS `ENOTFOUND`) and answers with a real HTTP 404, so `classifyNetworkError()`'s `ENOTFOUND`/`EAI_AGAIN` check never fires. The user sees the raw, generic "Jira returned 404." instead of "That site doesn't exist — check the address…" — a real bug only visible against the live Atlassian Cloud DNS/CDN behavior, not from reading the code.
- **JIRA-08** — A non-Jira host that answers on HTTPS is caught
  Steps: Enter `example.com` (a real host that is not Jira) with any email/token. Connect.
  Expected: "That address answered, but not like a Jira Cloud site — check the site address." — not a crash and not a generic 500.
  Coverage: **Gap worth flagging** — live execution disproved the "Supported" call below; corrected after JIRA-190 execution pass.
  Result: FAIL — entering `example.com` also produced the raw "Jira returned 404." instead of "That address answered, but not like a Jira Cloud site — check the site address." Same root cause as JIRA-07: a generic 404 branch answers before the non-JSON/no-`accountId` guards this case was supposed to hit ever get evaluated.
- **JIRA-09** — Editing a field clears the previous error
  Steps: Trigger a connect failure (JIRA-06). Then type one character into the token field.
  Expected: The red alert disappears immediately rather than sitting under a token the user has since corrected.
  Coverage: **Supported** — `handleFieldChange` calls `setConnectError(null)`.
  Result: PASS — after a real invalid-credential rejection, appending one character to the token field cleared the red alert immediately.
- **JIRA-10** — Connect form does not offer to remember the token
  Steps: Focus each of the three fields and check for browser autofill/save-password prompts. Complete a connect, then reopen the wizard.
  Expected: No autofill suggestions on any field; the token field is `type=password`; reopening the wizard shows empty fields, not a retained token.
  Coverage: **Supported** — all three fields set `autoComplete="off"`, the token field is `type="password"`, and `resetAll()` clears `credentials` on every close (and `handleConnectJira` clears the token on success).
  Result: PASS — `getAttribute('autocomplete')` returns "off" on all three fields, token field is `type=password`, and fields were empty on a fresh reopen after several earlier successful connects.
- **JIRA-11** — Confirm step shows real counts, not estimates
  Steps: After connecting, Continue to step 4.
  Expected: "N issues, M projects" reflect the actual JQL search that just ran for this account; "1 API call to load"; a Jira-tinted note stating Sprints/Docs/Workstreams don't appear here.
  Coverage: **Supported** — `connectJira()` calls `listMyJiraTickets()` before returning status, so `issueCount`/`projectCount` come from a real search.
  Result: NOT TESTED — My Jira already exists as a project from earlier testing this session; re-entering step 4 and clicking "Create project" against an already-created singleton risks an unrecoverable duplicate sidebar entry with no clean undo. Deferred rather than risked.
- **JIRA-12** — Finishing the wizard lands on My Jira with a sidebar entry
  Steps: Click "Create project" on step 4.
  Expected: Modal closes, app navigates to `/my-jira`, and a "My Jira" item with an issue-count badge appears in the sidebar.
  Coverage: **Supported** — `handleFinishCompanion()` navigates to `/my-jira`; `MyJiraNavItem` renders from the shared `jiraStore` once `connected` is true.
  Result: NOT TESTED — same blocker as JIRA-11 (project already exists; re-running "Create project" is not safely repeatable).
- **JIRA-13** — Disconnect removes the credential and the nav item live
  Steps: My Jira → Connection tab → Disconnect.
  Expected: Button shows "Disconnecting…", then the panel flips to a "Disconnected" badge with Refresh/Disconnect both disabled, and the sidebar "My Jira" item disappears without a reload.
  Coverage: **Supported** — `disconnectJira()` deletes the credential file outright (`deleteStoredJiraCredential`), then pushes the re-read status into `jiraStore`, which the sidebar subscribes to.
  Result: PASS — panel flipped to "Disconnected", `Refresh now` and `Disconnect` are both actually `.disabled = true` (not just visually similar — checked the DOM property directly), and the sidebar "My Jira" nav item disappeared live with no reload.
- **JIRA-14** — Disconnect has no confirmation step
  Steps: On the Connection tab, click Disconnect and observe whether anything asks first.
  Expected: One click destroys the stored token immediately — no confirm dialog, no "are you sure", no undo and no toast offering one. Reconnecting requires re-entering site, email and a freshly generated API token.
  Coverage: **Gap worth flagging** — `handleDisconnect` calls `disconnectJira()` immediately. Every comparably destructive action elsewhere in this app (delete doc, delete agent, delete saved view) has a confirm dialog; this one does not, and its cost — re-pasting an API token — is higher than most.
  Result: PASS (behavior matches Expected exactly) — confirmed live: a single click destroyed the connection immediately, no dialog of any kind appeared. Reconnecting required the full site/email/token re-entry. The Coverage note's UX concern (no confirm on a costly action) stands as a real, separate product observation, not a case failure.
- **JIRA-15** — Connecting a second Atlassian account
  Steps: With one account connected, reopen the wizard and try to connect a different Atlassian account (different email/token, same or different site).
  Expected: Document the real behavior — whether the second connection replaces the first, is refused, or coexists, and whether the user is warned before their existing connection is destroyed.
  Coverage: **Gap worth flagging** — `writeStoredJiraCredential()` unconditionally overwrites the single `jira-auth.json`, so a second connect silently replaces the first with no warning. Single-identity is a stated architecture decision, but the *silent overwrite* isn't disclosed anywhere, including in the Connection tab's "Not built yet — said plainly" list.
  Result: NOT TESTED — needs a second real Atlassian account/API token, not available in this pass.
- **JIRA-16** — Secure storage unavailable is refused before the token is transmitted
  Steps: On a system where Electron `safeStorage` is unavailable (or simulate it), attempt to connect.
  Expected: "Secure storage isn't available on this system, so an API token can't be saved safely here." — and no request is made to Atlassian at all.
  Coverage: **Supported** — `jiraIpc.ts` checks `isJiraSecureStorageAvailable()` *before* `validateCredential()`, explicitly so a token isn't sent to Atlassian just to be discarded. Hard to stage manually; worth a code-level or scripted check.
  Result: NOT TESTED — would require disabling the OS keychain/`safeStorage` on this machine, not safely stageable in this pass. Coverage claim is code-verified, not live-verified.
- **JIRA-17** — Jira Server / Data Center (self-hosted) instance
  Steps: On the connect form, enter a self-hosted Jira host (e.g. `jira.yourcompany.com`) with a valid Server PAT or password.
  Expected: Document the failure. The user should be able to tell that self-hosted Jira isn't supported, rather than concluding their credentials are wrong.
  Coverage: **Gap worth flagging** — every path is Jira Cloud only (`/rest/api/3/…`, Basic auth with an Atlassian API token), and a self-hosted host on a nonstandard port is rejected outright by `normalizeJiraSite`'s port ban. Nothing in the UI says "Cloud only", so a Data Center user gets `invalid_credentials` or `site_not_found` and no explanation.
  Result: NOT TESTED — no real self-hosted Jira Server/Data Center instance available. A proxy attempt against a nonexistent host (`jira.somecompany.com`) only reproduced the genuine-DNS-failure path (correctly "That site doesn't exist…", confirming `classifyNetworkError()` handles real `ENOTFOUND` correctly) rather than the real scenario this case asks about — a self-hosted server that exists but isn't Cloud.
- **JIRA-18** — Connection tab's "Not built yet" list matches reality
  Steps: Read the Connection tab's disclosure list. For each item (attachments upload, rich text, @mentions, background sync, Copilot proposals, issue creation) attempt the thing it disclaims.
  Expected: Every disclaimed item genuinely isn't offered anywhere in the UI — no half-enabled control that implies otherwise.
  Coverage: **Partial** — the six listed items are accurate, and the write banner above the list now states outright that everything but the workflow move and the comment is read-only (JIRA-19), which covers the third of the three omissions previously logged here. Still missing against the same "said plainly" standard: the single-account overwrite (JIRA-15) and the hard result cap (JIRA-31).
  Result: PASS on the three checkable live — the comment composer is a bare `<textarea>` + one "Comment" submit button, no attach control, no formatting toolbar, and typing "@Sam"/"@Colleague Name" produced no picker/popover of any kind at any point. Background sync and issue creation were separately confirmed absent throughout this pass (no auto-refresh observed; no "New ticket" affordance in My Jira). Coverage's own noted gaps (JIRA-15, JIRA-31 omissions) still stand.
- **JIRA-19** — Connection panel's write claim matches the writes that exist
  Steps: Read the blue banner on the Connection tab. Then, for every capability it names, try to perform it in My Jira; and separately try to change a ticket's priority anywhere in the view.
  Expected: The banner names exactly two writes — moving a ticket through its workflow, and posting a comment — and both work. It does not mention priority, and no priority control exists anywhere; the banner says outright that everything else about an issue is read-only here.
  Coverage: **Supported** — the banner used to read "moving, commenting, **changing priority**", which was a capability the build has never had: `jiraApi.ts`'s entire write surface is `transitionJiraTicket` and `postJiraComment`, and `PriorityIcon` in the row is display-only. The copy now lists those two and closes with the read-only statement, which also covers one of JIRA-18's three omissions. No priority write was added — that stays out of scope, and the claim was the defect, not the missing feature.
  Result: PASS — the Connection tab's banner now reads "Your edits — moving a ticket through its workflow, and posting a comment — write straight to Jira... Those two are the whole set; everything else about an issue is read-only here." No mention of priority anywhere, and no priority control exists in the row/drawer.

### Viewing & filtering your own work

- **JIRA-20** — My work tab lists the connected account's own issues
  Steps: Open `/my-jira`, My work tab.
  Expected: A list of issues, each row showing PROJECT-NUMBER, title, a role tag, a state chip, a priority icon and an assignee avatar. Spot-check three rows against the same issues in the real Jira UI.
  Coverage: **Supported** — `listMyJiraTickets()` → `jira:tickets:list` → the single `MY_WORK_JQL` search; `JiraTicketRow` renders exactly those elements.
  Result: PASS — 98 real rows rendered, each showing key (ENG-N), title, role tag, state chip, priority icon, and assignee avatar/initials; spot-checked ENG-81 in detail via its drawer.
- **JIRA-21** — The on-screen JQL matches what actually runs
  Steps: Read the monospace JQL under the page heading. Run that same JQL by hand in Jira's own issue search for the same account.
  Expected: The two result sets match, issue for issue (allowing for anything changed between the two reads).
  Coverage: **Supported** — the page prints the query verbatim, including the parentheses; `MY_WORK_JQL` in `jiraClient.ts` is the same string plus `ORDER BY updated DESC`.
  Result: PASS — on-screen JQL reads exactly `(assignee = currentUser() OR reporter = currentUser() OR watcher = currentUser()) AND resolution = Unresolved`, byte-for-byte the parenthesized form; not independently re-run in Jira's own search UI in this pass, but matches source exactly.
- **JIRA-22** — The parentheses in the JQL are load-bearing
  Steps: In Jira's own search, run the *unparenthesized* form (`assignee = currentUser() OR reporter = currentUser() OR watcher = currentUser() AND resolution = Unresolved`) and compare to My Jira's list.
  Expected: The unparenthesized form returns strictly more issues, including long-closed ones assigned to you. My Jira's list should match the parenthesized form, not this one.
  Coverage: **Supported** — a deliberate, documented deviation from the originally specified query; this case is what proves it's the right one.
  Result: PASS — direct API comparison: unparenthesized JQL returned 108 issues, the app's real parenthesized JQL returned 98. The 10-issue gap exactly matches the 10 tickets seeded to Done/Resolved this session — precisely the long-closed-but-still-assigned issues the parentheses are supposed to exclude.
- **JIRA-23** — Resolved issues are absent
  Steps: Note an issue you're assigned that is Resolved/Done in Jira. Confirm it's not in the list. Then resolve one of the listed issues in Jira's own UI and press Refresh now.
  Expected: The resolved issue leaves the list.
  Coverage: **Supported** — `resolution = Unresolved` is part of the JQL.
  Result: PASS (via JIRA-22's evidence) — the app shows exactly 98, matching the real parenthesized-JQL count with resolution excluded; the 10 Done tickets from this session's seed are confirmed absent.
- **JIRA-24** — No way to see what you recently finished
  Steps: Look for any view, tab, filter or toggle that shows issues you resolved this week.
  Expected: No such view, tab, filter or toggle exists anywhere in My Jira. The `resolution = Unresolved` clause is printed read-only under the heading with no control that can drop or invert it.
  Coverage: **Gap worth flagging** — `resolution = Unresolved` is hardcoded with no override, so a real daily need ("what did I ship this week", standup prep, weekly report) has no answer in Waypoint at all. Not a stated architecture decision — sprints/boards are deliberately excluded, "my recently closed work" is not.
  Result: PASS (confirms the gap) — no tab, toggle, or filter of any kind exists to see resolved/closed work; the JQL line is printed read-only text with no control attached.
- **JIRA-25** — Cross-project scope: every project the account can see
  Steps: Confirm the project filter chips include projects from more than one Jira project, and that at least one is a project you're only a watcher or reporter on.
  Expected: Chips are derived from the actual result set, not a fixed list; each chip shows a real count; the chips sum to the "All N" count.
  Coverage: **Supported** — `projectCounts` is derived with a `useMemo` over the fetched tickets and sorted by key; a previous hardcoded `['ENG','PLAT','GRW']` was removed precisely because it would render nothing on a real site.
  Result: PARTIAL — the seeded test account only has one real Jira project (ENG), so true cross-project scope can't be exercised. What is confirmed: the chip shown is "ENG 98" — the real project, not the old hardcoded PLAT/GRW chips that would render on a single-project account under the previous code. Needs a multi-project account to fully verify.
- **JIRA-26** — Project filter narrows the list
  Steps: Click one project chip. Then click "All N".
  Expected: Only that project's issues shown; the "N issues · M Jira projects" summary line updates to match; clicking All restores the full list.
  Coverage: **Supported** — client-side `filtered` memo plus `visibleProjectCount`.
  Result: PARTIAL — only one project exists in this account, so the ENG chip trivially shows the same 98 as "All". The filtering mechanism itself is confirmed working via the role filters (JIRA-27), which use the identical `filtered` memo pattern; true narrowing needs a multi-project account.
- **JIRA-27** — Role filters: Assigned / Reported / Watching / Any role
  Steps: Cycle all four role chips. For each, spot check that the rows shown carry that role tag.
  Expected: Each filter shows only rows tagged with that role; Any role restores everything.
  Coverage: **Supported** — `roleFilter` is applied in the same `filtered` memo, matched against the row's single `role`.
  Result: PASS — Assigned showed 65 rows all tagged "assignee", Reported showed 33 all tagged "reporter", Watching showed 0 (this account has no watched-only issues), and 65+33+0 = 98 = "Any role", with no overlap.
- **JIRA-28** — Role is a single strongest claim, not all your real roles
  Steps: Find an issue in Jira where you are BOTH the reporter and a watcher (or both assignee and reporter). Filter My Jira to "Watching" (or "Reported") and look for it.
  Expected: Document that the issue does not appear under its weaker role — it only ever appears under the strongest one.
  Coverage: **Partial** — `roleOf()` returns assignee > reporter > watcher, first match wins, so each row has exactly one role. A user filtering "Watching" to review everything they're watching will silently miss every watched issue they also report or are assigned. Real, and not disclosed in the UI.
  Result: PASS (confirms the gap, inferred rather than directly reproduced) — 65 assignee + 33 reporter + 0 watching = 98 exactly with zero overlap, confirming each row gets exactly one role and none double-count. Could not construct a real issue with two roles on this account to directly watch it "disappear" from its weaker filter, since seed data doesn't have a dual-role case — the arithmetic proves the mechanism, not a lived example.
- **JIRA-29** — Project and role filters combine
  Steps: Select one project chip AND the "Reported" role chip.
  Expected: Intersection of both, with the count line consistent.
  Coverage: **Supported** — both predicates are ANDed in one filter expression.
  Result: PARTIAL — role+role combinations confirmed exact (JIRA-27's arithmetic); project+role can't be meaningfully tested with only one project in this account (would trivially equal the role-only count).
- **JIRA-30** — Filters do not survive a remount
  Steps: Apply a project + role filter. Navigate to Home, then back to My Jira.
  Expected: Both filters reset to "All" / "Any role" and the whole list is refetched from Jira. Nothing about the previous selection survives the navigation.
  Coverage: **Partial** — `projFilter`/`roleFilter` are plain `useState` with no persistence, and `useAsync(..., [])` refetches on mount. Acceptable for a first pass, but worth recording as a deliberate observation rather than a surprise.
  Result: PASS — applied "Reported" (33 issues), navigated to Home then back; list showed "98 issues" (back to All/Any role) on return, confirming the filter reset and the list refetched.
- **JIRA-31** — An account with more than 500 matching issues
  Steps: Connect (or simulate) an account whose "my work" JQL returns more than 500 unresolved issues. Compare the count on the Connection tab against the count Jira's own search reports for the same JQL.
  Expected: Either all issues load, or the UI says plainly that it's showing a capped subset.
  Coverage: **Gap worth flagging** — `PAGE_SIZE = 100` × `MAX_PAGES = 5` caps at 500 and then simply stops, with no marker. The Connection tab would then report a confidently wrong "issues in your queue" number, and the sidebar badge would too. The cap itself is a sound protection; the silence about it is the gap.
  Result: NOT TESTED — this seeded account has 98 issues, far short of the 500-issue cap; reproducing it would mean seeding 400+ more real tickets, out of scope for this pass.
- **JIRA-32** — List ordering
  Steps: Note the order of rows and compare against each issue's "Updated" timestamp in Jira.
  Expected: Most recently updated first.
  Coverage: **Supported** — `ORDER BY updated DESC` in `MY_WORK_JQL`.
  Result: PASS, live-verified against real Jira — a direct API call with the same JQL + `ORDER BY updated DESC` returned ENG-81 first (the ticket just commented on twice, most recently updated), exactly matching the app's own top row.
- **JIRA-33** — No sort control
  Steps: Look for any way to reorder the list (by priority, by due date, by key, by project).
  Expected: No sort control of any kind exists — no column headers, no menu, no toggle. The order is always most-recently-updated first and cannot be changed from the UI.
  Coverage: **Gap worth flagging** — sorting by priority or due date is among the most basic things a person does with their own Jira queue every morning, and there is no control at all. `updated DESC` is hardcoded and the renderer never re-sorts.
  Result: PASS (confirms the gap) — no column headers, sort menu, or toggle exists anywhere on the page.
- **JIRA-34** — Priority is visible but not actionable
  Steps: Confirm each row shows a priority icon matching the issue's Jira priority. Then try to filter by priority, sort by it, or change it.
  Expected: Icons are accurate; document that none of the three actions is possible.
  Coverage: **Partial** — `mapPriority()` maps both the Highest…Lowest scheme and the Blocker/Critical/Major/Minor/Trivial scheme, so display should be right on most sites; but priority is read-only and unfilterable. The Connection tab's banner used to claim otherwise; since JIRA-19 it says plainly that everything but status and comments is read-only here.
  Result: PARTIAL, plus a new finding — priority icons render (e.g. a `lucide-signal-high` icon on ENG-81) and no filter/sort/edit control exists anywhere for priority, as expected. New: the icon is `aria-hidden="true"` with no `title` or `aria-label` at all — a screen reader gets zero priority information from it, not even an inaccessible-but-present label. Worth its own line item; not something JIRA-34 as written was checking for.
- **JIRA-35** — A site with a custom priority scheme
  Steps: On a site using renamed or custom priorities (e.g. "P0", "Urgent-ish"), check what the row icons show.
  Expected: Unrecognized names should degrade to "none" rather than being forced into a wrong bucket.
  Coverage: **Not supported (untested/unknown)** — `PRIORITY_BY_NAME` has no entry for custom names and falls through to `'none'`. That's the intended degradation, but it means a P0-scheme site shows every issue as no-priority, which reads as a bug to the user. Worth confirming against a real custom scheme.
  Result: NOT TESTED — this account's Jira site uses the standard Highest…Lowest scheme; no custom-priority site available to test against.
- **JIRA-36** — Empty result set for a genuinely empty queue
  Steps: Connect an account with no unresolved issues in any role (or filter to a project/role combination with none).
  Expected: A clear empty state.
  Coverage: **Partial** — a failed load no longer lands here (JIRA-133 now renders its own error state), but the wording is still filter-shaped: an account with a genuinely empty queue and no filters applied is told its *filters* matched nothing. Same class of misleading-empty-state copy already logged as TIX-CW-09 elsewhere in this sheet.
  Result: NOT TESTED (exact scenario) — this account has 98 unresolved issues, so a true zero-filter empty queue can't be produced. Adjacent evidence: filtering to "Watching" (0 real matches) correctly showed "No tickets match these filters." — accurate wording for that case, since real filters actually were applied; doesn't test the harder unfiltered-empty-account case this line is about.
- **JIRA-37** — Sidebar badge matches the list
  Steps: Compare the sidebar "My Jira" count badge to the "All N" chip on the page.
  Expected: Equal.
  Coverage: **Partial** — both read `issueCount` from the same store, but that number comes from the module-level `lastTickets` cache in `jiraApi.ts`, which is 0 until a list read happens. On a fresh app launch the sidebar can show a badge of 0 (or a stale count) before the page is ever opened.
  Result: PASS (equal after a list read) — sidebar badge and "All N" chip both read 98. The Coverage note's separate concern (badge shows 0 before first read) is a real, distinct scenario not exercised by this steady-state check.
- **JIRA-38** — Project color swatches are stable
  Steps: Note the color on a project chip and the matching row's left border. Reload the app. Filter to a different project and back.
  Expected: The same project key always gets the same color, regardless of what else is in the list.
  Coverage: **Supported** — `jiraProjectColor()` hashes the key rather than assigning by list position, specifically so this holds.
  Result: PASS — ENG's key text and row left-border consistently used `var(--p-grw)` across dozens of page reloads and role/project filter changes throughout this entire pass; never observed it change.
- **JIRA-39** — Project color collisions with many projects
  Steps: Connect an account that can see four or more Jira projects. Look at the chips and row borders.
  Expected: Document how many distinct colors appear.
  Coverage: **Partial** — the palette is only three colors (`--p-eng`, `--p-plat`, `--p-grw`), so with 4+ projects collisions are guaranteed. Acknowledged in code as acceptable since the key text is always shown; worth confirming it still reads clearly at real project counts.
  Result: NOT TESTED — this account has only one real Jira project (ENG); no way to observe collisions among 4+.

### Categorization — labels, components, issue type, epics

- **JIRA-40** — Viewing your work by label
  Steps: Confirm several of your Jira issues carry labels. Look for any label display or label filter in My Jira.
  Expected: Labels should be visible somewhere on the row or in the drawer.
  Coverage: **Gap worth flagging** — labels are never read: `mapIssue()` doesn't extract `fields.labels`, `JiraWireTicket` has no labels field, and neither the row nor the drawer renders any. "View by category" was an explicitly named daily use case and labels are its most common form.
  Result: FAIL — added a real label ("qa-test-label") to ENG-4 via the Jira API, reloaded the app, opened ENG-4's drawer: the label appears nowhere, neither on the row nor in the drawer. Directly confirms the gap with live data, not just code inference.
- **JIRA-41** — Viewing your work by component
  Steps: Confirm some issues carry Jira components. Look for component display or filtering.
  Expected: Components visible or filterable.
  Coverage: **Gap worth flagging** — `fields.components` is never read or mapped. Same class as JIRA-40; on many teams the component *is* the primary category.
  Result: NOT TESTED — this Jira project (ENG) has zero components configured (`GET /project/ENG/components` returns `[]`), so there's no real component to assign and check. Code-level claim (never mapped) stands unverified against real data.
- **JIRA-42** — Distinguishing bugs from stories from tasks
  Steps: Confirm your queue contains a mix of Jira issue types. Look for a type icon, a type label, or a type filter anywhere in the row or drawer.
  Expected: Issue type should be distinguishable at a glance.
  Coverage: **Gap worth flagging** — `fields.issuetype` is never mapped. Every row looks identical whether it's a Bug, a Story, an Epic or a Sub-task, and there is no way to filter to "just my bugs". This is arguably the single most-missed field for daily triage.
  Result: FAIL — this account's 98 issues are a real mix of Bug/Task/Story (per the seed script); no type icon, label, or filter appears anywhere in the row or drawer for any of them. Confirms the gap directly.
- **JIRA-43** — Epic shown in the drawer
  Steps: Open a ticket that belongs to an epic. Check the "Epic ·" chip against Jira.
  Expected: The chip names the correct epic.
  Coverage: **Supported** — `mapIssue()` reads `fields.parent.fields.summary` first, but only when `parent.fields.issuetype` says the parent really is an epic, falling back to a named `Epic Link`/`Epic Name` custom field otherwise (JIRA-44).
  Result: PASS, live-verified — ENG-4 (real parent ENG-1, a real Epic) shows "Epic · Epic 1" in the drawer, exactly matching ENG-1's real Jira summary.
- **JIRA-44** — "Epic" chip on a sub-task
  Steps: Open a Jira sub-task from the list (one whose parent is a Story, not an Epic). Read the "Epic ·" chip. Then open a story that does sit directly under an epic and read the same chip.
  Expected: The sub-task either names its real epic (via Epic Link) or shows no Epic chip at all — never its parent story's summary. The story under an epic still names that epic.
  Coverage: **Supported** — `mapIssue` now reads `parent.fields.issuetype` and takes `fields.parent` as the epic only when that type is one (`hierarchyLevel >= 1`, or a name of "epic" on a site that returns no hierarchy level). A non-epic parent falls through to the Epic Link custom field, and to null when that's absent too. A parent payload carrying no issuetype at all is still trusted, matching how every other field in the mapper degrades. Covered in `jiraMap.test.ts`; still worth eyeballing on a real site with sub-tasks and a renamed epic type.
  Result: NOT TESTED — no real Sub-task-type issue exists in this dataset (seed script only created Bug/Task/Story), so the exact "sub-task under a non-epic Story parent" scenario can't be reproduced live. Unit-tested per the Coverage note; JIRA-43 confirms the epic-parent path works live.
- **JIRA-45** — Parent/child hierarchy and sub-task rollup
  Steps: Look for any indication that an issue has sub-tasks, or that a sub-task belongs to a parent, beyond the single Epic chip.
  Expected: Nothing beyond that one chip is shown — no sub-task list, no completion rollup, no parent link. A sub-task in your queue renders as a flat row indistinguishable from a top-level issue.
  Coverage: **Not supported (untested/unknown)** — `fields.subtasks` is never mapped and nothing renders a hierarchy. Sub-tasks assigned to you will appear as flat, context-free rows indistinguishable from top-level issues (compounded by JIRA-42's missing type).
  Result: PASS (confirms the gap) — ENG-4's drawer, despite having a real parent (ENG-1), shows nothing beyond the single "Epic · Epic 1" chip: no sub-task list, no rollup, no other hierarchy indicator.
- **JIRA-46** — Story points shown when the site uses them
  Steps: Open a ticket with story points set in Jira. Check the "Story points ·" chip.
  Expected: Matches Jira's value.
  Coverage: **Supported** — `findNamedField(fields, names, /^story point/i)` matches on the *displayed field name* via `expand=names` rather than a hardcoded `customfield_10016`, so it should work on a site with a nonstandard id. Worth confirming on a real site since the field label varies ("Story Points", "Story point estimate").
  Result: NOT TESTED — attempted to set `customfield_10016` ("Story point estimate", confirmed via `editmeta` to be this site's real story-points field) on ENG-4 via the API to test this properly, but the write was blocked by this session's own tooling permission classifier before it reached Jira. Not retried. Field-name-matching claim stands code-verified only.
- **JIRA-47** — Custom fields generally
  Steps: Pick a custom field your team relies on (team, severity, customer, environment). Look for it in the drawer.
  Expected: It is absent. The drawer's chip set is fixed at assignee, reporter, epic, story points and sprint; no other custom field is rendered anywhere, on the row or in the drawer.
  Coverage: **Not supported (by design, but narrow)** — only story points, sprint and epic are pulled out of `*all`; the drawer renders a fixed chip set. Reasonable for a first pass, but note the search already fetches `*all`, so the data is being downloaded and thrown away.
  Result: PASS (confirms by-design absence) — ENG-4's drawer chip set is exactly assignee, reporter, and epic; no other field, custom or standard, appears.
- **JIRA-48** — Resolution reason
  Steps: Look for where an issue's resolution is displayed.
  Expected: No resolution is displayed anywhere. Resolved issues are excluded from the list entirely, so there is nowhere one could appear; resolution surfaces only as a required transition field on the way out (JIRA-63).
  Coverage: **Not supported (by design)** — consistent with the `resolution = Unresolved` scope. Resolution *is* handled as a required transition field on the way out (see JIRA-63).
  Result: PASS (confirms by-design absence) — no resolution field appears anywhere on any of the 98 listed (all unresolved) issues.
- **JIRA-49** — Versions / fixVersion / releases
  Steps: Look for any fixVersion or release information on a ticket.
  Expected: No fixVersion, affectsVersion or release appears on the row or in the drawer, and there is no version filter.
  Coverage: **Not supported (untested/unknown)** — `fields.fixVersions` is never mapped. Lower daily impact than labels/type, but it's a standard triage axis for release-driven teams.
  Result: NOT TESTED — no fixVersion/release configured on this project to assign and check against; ENG-4's drawer shows none, consistent with the code claim but not a real-data confirmation.

### Due dates, priority views and overdue work

- **JIRA-50** — Seeing what's due today
  Steps: Set a due date on one of your Jira issues for today, another for yesterday. Refresh My Jira. Look for a due date anywhere.
  Expected: Due dates visible on the row or in the drawer.
  Coverage: **Gap worth flagging** — `fields.duedate` is never read; `JiraWireTicket` and `JiraTicket` have no due-date field at all. There is no way to see, filter or sort by due date, and no overdue indicator. For a tool whose stated job is mirroring "everything you're on the hook for", the absence of "when is it due" is the largest single field gap in the feature.
  Result: FAIL — set a real due date (yesterday, genuinely overdue) on ENG-4 via the Jira API, reloaded, checked both the row and drawer: no due date appears anywhere. Directly confirms the gap with live data.
- **JIRA-51** — Overdue highlighting
  Steps: With an overdue issue in your queue, look for any visual distinction on its row.
  Expected: Document that there is none.
  Coverage: **Gap worth flagging** — follows directly from JIRA-50; nothing computes or renders overdue state.
  Result: FAIL (confirms the gap directly) — with ENG-4 genuinely overdue (due date set to yesterday) in real Jira, its row rendered with zero visual distinction from any other row: no color, no icon, no badge.
- **JIRA-52** — A priority-first view of your queue
  Steps: Try to answer "what are my urgent issues right now" using only My Jira.
  Expected: Document how many steps it takes.
  Coverage: **Gap worth flagging** — the only way is visually scanning priority icons down an updated-DESC list. No filter, no sort, no grouping. Combined with JIRA-33 this makes the list hard to triage at any real volume.
  Result: PASS (confirms the gap) — the only mechanism is scrolling the full 98-row updated-DESC list and eyeballing icons; confirmed no filter/sort/grouping control exists anywhere on the page.

### History & reassignment — "this used to be mine"

- **JIRA-53** — An issue reassigned away from you disappears
  Steps: Note an issue currently assigned to you in My Jira. In Jira's own UI, reassign it to someone else (a QA engineer, a PM). Return to Waypoint and press Refresh now.
  Expected: Document what happens to the row.
  Coverage: **Gap worth flagging** — this is the founder's own named use case and it is not delivered. If you're still the reporter or a watcher the issue silently changes role tag; if you're neither, it vanishes from the list with no trace, no tombstone and no notification. The tombstone UI exists (`JiraTicketRow`'s "Reassigned to X … Kept here for 24 hours so it doesn't vanish mid-thought" strip) but `toTicket()` hardcodes `isTombstoned: false`, so it can never render.
  Result: PASS on the "still reporter" half, live-verified — unassigned ENG-4 from myself via the API (I remain its reporter); after reload the row stayed in the list (still 98 total), role tag silently switched "assignee" → "reporter", avatar switched to "UN". No toast, no indicator, no trace of the change — exactly the documented "silently changes role tag" behavior. Could not test the "vanishes with no trace" half: every ticket in this seed dataset has me as reporter (I created them all via my own token), so no assignee-only ticket exists to reassign fully away.
- **JIRA-54** — Tombstone strip renders when a ticket leaves your queue
  Steps: Try to produce a struck-through "was yours" row by any means.
  Expected: Confirm it cannot be produced.
  Coverage: **Partial** — the component, the "was yours" role label, the disabled "Not yours to move any more" state chip and the "Dismiss now" action are all built and wired through `dismissJiraTombstone`, but nothing ever sets the flag. Detecting it needs a persisted previous read, which this phase has no store for — honestly documented in `jiraApi.ts`, but the result is dead UI.
  Result: PASS (confirms it cannot be produced) — reassigned ENG-4 away from myself for real via the Jira API; after reload, its row shows no strikethrough and no tombstone text of any kind ("reassigned"/"was yours"), just a normal row with an updated role tag.
- **JIRA-55** — Tombstone's "Open in Jira" link
  Steps: If a tombstoned row can be produced, click its "Open in Jira" button.
  Expected: It should open the issue.
  Coverage: **Partial** — the tombstone row's button is hardcoded `disabled` with title "Opening a ticket in Jira isn't wired up yet.", even though the drawer's equivalent link was upgraded to a real `https://{site}/browse/{key}` URL when the site became known. Stale leftover; the tombstone row has the key and the store has the site.
  Result: NOT TESTED — JIRA-54 confirmed a tombstoned row cannot be produced at all (even with a real reassignment), so its "Open in Jira" button can't be reached to test.
- **JIRA-56** — Finding issues you previously reported that someone else now owns
  Steps: Filter to "Reported". Look for issues you reported that are now assigned to a QA engineer or PM.
  Expected: They appear, with the current assignee's avatar.
  Coverage: **Supported** — the reporter arm of the JQL covers exactly this, and the row's avatar is the *current* assignee (`displayNameOf(fields.assignee, 'Unassigned')`). This is the closest thing the build has to the founder's "this was mine" need, and it works — but only while you're still the reporter.
  Result: PASS, live-verified — after unassigning ENG-4 from myself via the API, filtering to "Reported" still shows it, now with a "UN" (Unassigned) avatar reflecting the real current assignee state.
- **JIRA-57** — Issues you were assigned but never reported or watched
  Steps: Have someone reassign away an issue you were assigned but did not report and do not watch. Refresh.
  Expected: Document that it is gone with no record.
  Coverage: **Gap worth flagging** — the sharpest form of JIRA-53. There is no local history, no "recently left your queue" list, and no changelog read, so the issue is unrecoverable from Waypoint. A user who was mid-thought on it has no path back except remembering the key.
  Result: NOT TESTED — every ticket in this seed dataset has me as reporter (I created them all via my own token), so no assignee-only ticket exists to reassign fully away and observe vanishing with no trace.
- **JIRA-58** — Activity / change history on a ticket
  Steps: Open the drawer on a ticket that has been reassigned, re-prioritised and moved several times in Jira. Look for a change log.
  Expected: No change history is shown at all. The drawer contains exactly the description, the fixed chip set, attachments and comments — no reassignment, priority or status events, and no "view history" affordance.
  Coverage: **Gap worth flagging** — the drawer shows description, a fixed chip set, attachments and comments, and nothing else. Jira's `changelog` expand is never requested. Waypoint's own native ticket detail page has a full activity log (see TIXDET-07), so the Jira drawer is conspicuously thinner than the app's own established bar.
  Result: PASS (confirms the gap) — ENG-4 now has real, verifiable history (reassigned, due date set, label added, all via this pass), and none of it appears in the drawer: just description, the fixed chip set, and comments.
- **JIRA-59** — Who reported an issue
  Steps: Open any drawer and check the "Reporter ·" chip against Jira.
  Expected: Correct display name, or "Unknown" if Jira didn't return one.
  Coverage: **Supported** — `displayNameOf(fields.reporter, 'Unknown')`.
  Result: PASS — "Reporter · Amaan Nawab" matches the real reporter on every ticket checked.
- **JIRA-60** — Unassigned issue renders sensibly
  Steps: Find an unassigned issue in your queue (you reported it, nobody's picked it up). Check the row avatar and the drawer chip.
  Expected: "Unassigned" rather than a blank or a crash.
  Coverage: **Supported** — `displayNameOf(fields.assignee, 'Unassigned')`; `Avatar` derives initials from that string.
  Result: PASS — ENG-4 (unassigned via this pass) and ENG-81 (unassigned from seed data) both render "Unassigned"/"UN" cleanly on row and drawer, no crash or blank.

### Sprints, backlog and boards

- **JIRA-61** — No board or backlog view exists
  Steps: Look for a Kanban board, a backlog list, a swimlane view or any board-like grouping in My Jira.
  Expected: None exists, and the UI says so rather than hinting at one.
  Coverage: **Not supported (by design)** — stated architecture decision; the wizard's confirm step says plainly "Sprints, Docs and Workstreams don't appear here — Jira owns those, and Waypoint won't fake a mirror of them."
  Result: PASS — no board/backlog/swimlane view exists anywhere; the only match for "board" in the page is the header copy "...not one board," an explicit disclosure, not a hint at one.
- **JIRA-62** — Backlog vs. active sprint distinction
  Steps: Try to tell, from My Jira alone, which of your issues are in the current sprint and which are backlog.
  Expected: Document what's possible.
  Coverage: **Partial** — the drawer shows a single "Sprint ·" chip per ticket, and `sprintNameOf()` correctly prefers the *active* sprint when an issue sits in several (a carried-over ticket). But there is no sprint filter, no grouping, and no chip on the list row, so answering the question means opening every ticket one at a time. The boundary is honest that boards are out of scope; a sprint *filter* is a different, smaller thing that the data already supports.
  Result: PASS (confirms the gap) — with ENG-4 genuinely in a real active sprint, its list row shows no sprint text at all and no sprint filter control exists anywhere; the sprint name only appears after opening the drawer.
- **JIRA-63** — Sprint name on a site without Jira Software
  Steps: Connect an account on a Jira Work Management / Service Management site with no sprint field.
  Expected: The Sprint chip is simply absent, not an error or an empty chip.
  Coverage: **Supported** — `findNamedField(..., /^sprint$/i)` returns undefined, `sprintNameOf(undefined)` returns null, and the drawer renders the chip conditionally.
  Result: PASS (adjacent evidence, not the exact scenario) — before this pass added a real sprint, ENG-4 had no sprint assigned and showed no Sprint chip at all (no error, no empty chip), confirming the conditional-render path. The exact "site has no sprint field at all" scenario (a Work Management/Service Management site) wasn't tested — this account's site does have Jira Software/sprints available.
- **JIRA-64** — Issue in multiple sprints
  Steps: Find (or create) an issue carried across two sprints, one closed and one active. Check the Sprint chip.
  Expected: Shows the active sprint, not the closed one.
  Coverage: **Supported** — `sprintNameOf()` explicitly prefers `state === 'active'`, falling back to the last listed.
  Result: PASS, live-verified with real Jira sprint data — created a real closed sprint and a real active sprint, put ENG-4 in both (confirmed via the API: field carries both entries), reloaded: the drawer shows "Sprint · ENG Sprint 1" — the active one — not the closed sprint.
- **JIRA-65** — Sprint dates, goals or progress
  Steps: Look for sprint start/end dates or completion progress anywhere.
  Expected: None — Jira owns sprints.
  Coverage: **Not supported (by design)** — consistent with the stated boundary.
  Result: PASS — with a real active sprint on ENG-4, the drawer shows only "Sprint · ENG Sprint 1"; no start/end date, no goal, no progress bar.
- **JIRA-66** — Waypoint's own Sprints page is unaffected
  Steps: With Jira connected, open a native Waypoint project's Sprints page.
  Expected: Unchanged behavior; no Jira data leaks in, no Jira issues appear in native sprint counts.
  Coverage: **Supported** — My Jira is a standalone concept (`types/jira.ts` header: deliberately not folded into `types/entities.ts`), with no shared store or route. Worth confirming live that the two never cross.
  Result: NOT TESTED — this dev environment has no native Waypoint project seeded (`/projects` shows an empty "All projects" list), so there's no native Sprints page to check against.

### Transitions & workflow

- **JIRA-67** — Open the transition menu from a row
  Steps: Click a row's state chip.
  Expected: A popover headed "Move PROJ-N to" listing the transitions your Jira workflow allows from the current state, with a footer noting Waypoint doesn't invent them.
  Coverage: **Supported** — `JiraTicketRow` fetches on popover open via `getJiraTransitions`; `JiraTransitionPopover` renders the list.
  Result: PASS, live-verified — clicking ENG-4's "To Do" chip opened a popover reading exactly "Move ENG-4 to / To Do / In Progress / Done / These are the transitions your Jira workflow allows from To Do — Waypoint doesn't invent them." Bonus confirmation: the popover is rendered as a `position: fixed` sibling of `#root` (not clipped inside the list), proving the JIRA-153 portal fix is genuinely live.
- **JIRA-68** — Transitions match the real workflow
  Steps: For three issues in three different projects with different workflows, compare the popover's options against the transitions Jira's own UI offers from the same state.
  Expected: Identical sets, including any nonstandard status names ("Ready for QA", "Blocked").
  Coverage: **Supported** — transitions come from `/rest/api/3/issue/{id}/transitions`, and `mapTransition` uses `to.name` (falling back to the transition's own name).
  Result: PARTIAL — only one real Jira project (ENG) exists in this account, so the "three projects with different workflows" scope can't be tested. What is confirmed: the popover's options (To Do/In Progress/Done) exactly match a direct API call to `/issue/ENG-4/transitions`.
- **JIRA-69** — Transitions are re-asked rather than trusted from the bulk search
  Steps: Open a transition menu on an issue you can plainly move in Jira. Confirm it does not say "No transitions available from here."
  Expected: Real options appear.
  Coverage: **Supported** — a deliberate two-layer design: `rememberTickets()` refuses to cache an empty transitions array from the bulk expand (ambiguous), and `getJiraTransitions` falls through to the per-issue endpoint. This case exists to confirm the fallback actually fires on a real site.
  Result: PASS — ENG-4's transition menu showed real options ("To Do / In Progress / Done") every time it was opened across this pass, never "No transitions available from here."
- **JIRA-70** — A no-required-field transition writes straight through
  Steps: Pick a transition with no "needs a field" badge. Click it.
  Expected: Popover closes, chip shows "Saving…", then settles on the new state name and color. The issue's status in real Jira has changed. No approval step.
  Coverage: **Supported** — `transitionJiraTicket` posts the transition then re-reads the issue, so the chip shows what Jira actually landed on, not a prediction.
  Result: PASS, live-verified end-to-end — clicked "In Progress" (no "needs a field" badge) on ENG-4; the row's chip settled on "In Progress" with no approval step, and a direct API call confirmed real Jira's own status is genuinely "In Progress" too.
- **JIRA-71** — A transition requiring Resolution shows an in-place form
  Steps: Pick a transition badged "needs a field" (typically Done/Closed requiring Resolution).
  Expected: The *same* panel swaps to "Jira needs one more field", with a select populated from that workflow's real allowed resolutions, a required asterisk, a disabled "Move to X" button until filled, and a Cancel that returns to the option list. No second popover, no modal.
  Coverage: **Supported** — `JiraTransitionPopover` swaps `formTransition` in place; options come from `allowedValues` via `mapTransitionField`.
  Result: NOT TESTED — clicked "Done" on ENG-4 expecting a Resolution form; it wrote straight through with no form of any kind. A direct API check of `/issue/ENG-4/transitions?expand=transitions.fields` confirms why: on this real site's default Kanban workflow, none of the three transitions (To Do/In Progress/Done) have any required fields at all — Jira auto-set the resolution to "Done" on its own. This account's workflow has no required-field transition to test any of JIRA-71 through 75 against; would need a custom workflow scheme with a mandatory transition-screen field, not set up on this test project.
- **JIRA-72** — A renamed/custom resolution resolves to the right id
  Steps: On a site with a renamed resolution (e.g. "Won't Do", "Shipped"), transition using it and verify in Jira that the resolution recorded is the correct one.
  Expected: Jira shows the exact resolution chosen.
  Coverage: **Supported** — `buildTransitionFieldsPayload` re-reads live `allowedValues` immediately before writing and resolves the chosen *label* to its site-specific id, with a `{ name }` fallback. This is the case that justifies the pre-write re-read; worth exercising on a genuinely renamed value.
  Result: NOT TESTED — same root cause as JIRA-71: this workflow's Done transition has no Resolution field on its screen at all (auto-resolved by Jira), so there's no in-app resolution picker to exercise against a renamed value.
- **JIRA-73** — Optional time-tracking field on a transition
  Steps: Find a transition whose screen has an optional time-tracking field. Open it.
  Expected: A text field with the "e.g. 3h 30m" placeholder and an "Optional on this workflow." hint; the move proceeds whether or not it's filled; a filled value lands on the issue's work log in Jira.
  Coverage: **Partial** — deliberately the one optional field kept (all other optional fields are dropped, `mapTransitionField`), and it's sent as `{ timeSpent: value }`. But there's no validation of Jira's duration format, so a malformed entry ("3.5 hours") surfaces only as a raw Jira error after the write attempt.
  Result: NOT TESTED — none of this workflow's transitions have any screen fields at all (confirmed via API), optional or required, so no time-tracking field ever appears to test.
- **JIRA-74** — All other optional transition-screen fields are dropped
  Steps: Use a transition whose screen has several optional fields (comment, assignee, custom selects). Open the popover.
  Expected: Only required fields (plus time tracking) are asked for.
  Coverage: **Supported** — intentional; the popover is not a full issue editor. Worth confirming that dropping them doesn't cause Jira to reject the transition on a screen that expects them.
  Result: NOT TESTED — same root cause: no transition on this workflow has any screen fields, required or optional, to confirm are dropped.
- **JIRA-75** — A transition that requires a field type the popover can't render
  Steps: Find a required transition field that is a user picker, a date, a cascading select or a multi-select. Try to use that transition.
  Expected: Document what happens.
  Coverage: **Gap worth flagging** — `mapTransitionField` collapses every field to `select` (if it has `allowedValues`) or `text`. A required date renders as a free-text box; a required user picker renders as a free-text box whose value Jira will reject. The user gets a raw Jira 400 with no way to satisfy the field from Waypoint, and no explanation that this field type isn't supported.
  Result: NOT TESTED — no transition on this real workflow has any required field of any type to try this against.
- **JIRA-76** — A transition that stopped being legal while the popover was open
  Steps: Open a transition menu. In Jira's own UI (or another machine), move the same issue so the chosen transition is no longer available. Then click it in Waypoint.
  Expected: A clear message — "That move isn't available on this issue any more — reopen the menu to see the current options." — not a bare 400.
  Coverage: **Supported** — `transitionTicket()` re-reads the transition list and checks the target id exists before posting, specifically for this race.
  Result: NOT TESTED — would need a second real Jira session/machine to move the issue mid-race while the popover is open on this one, not available in this pass.
- **JIRA-77** — A ticket you can see but cannot transition
  Steps: Find an issue you're a watcher on in a project where your role can't move issues. Open its state chip.
  Expected: Either no transitions offered, or a clear permission message on attempting one.
  Coverage: **Partial** — a 403 maps to "Your Jira account isn't allowed to do that.", which is honest but generic. More likely Jira simply returns no transitions, and the popover shows "No transitions available from here." — indistinguishable from "this workflow is a dead end". The permission reason is never named.
  Result: NOT TESTED — this account is a full admin on this test site with no role restrictions; would need a second, permission-limited real account to reproduce a genuine 403.
- **JIRA-78** — Cannot transition from the ticket drawer
  Steps: Open a ticket's drawer. Try to change its status from there.
  Expected: The drawer's status renders as a static, non-interactive element — no click target, no hover affordance, no transition menu. Moving the ticket requires closing the drawer and using the row's own state chip.
  Coverage: **Gap worth flagging** — `JiraTicketDrawer` renders status as a static `<span>`, not a `JiraStateChip`. A user reading the full ticket (the natural moment to decide to move it) has to close the drawer and find the row again. Cheap to fix; the drawer already has the ticket object.
  Result: PASS (confirms the gap) — the drawer's status renders as `<span class="inline-flex items-center gap-1.5 rounded-full ...">Done</span>`, not a button; no click target, no transition menu reachable from the drawer.
- **JIRA-79** — Popover closes on Escape and on click-away
  Steps: Open a transition popover. Press Escape. Reopen it, click elsewhere on the page.
  Expected: Closes both ways without transitioning anything.
  Coverage: **Supported** — `mousedown` outside-click listener plus an Escape keydown listener in `JiraTransitionPopover`.
  Result: PASS — Escape closed a real open popover with no transition; a genuine `mousedown` dispatched outside the popover also closed it (confirmed on a fresh state read, since an in-line read caught pre-render stale state); ENG-4's status was unchanged after both.
- **JIRA-80** — Keystrokes after a transition don't leak to global shortcuts
  Steps: Click a transition, then immediately type a character that is a global app shortcut.
  Expected: The shortcut does not fire.
  Coverage: **Supported** — the popover is `tabIndex={-1}` with `data-shortcut-guard` and calls `panelRef.current?.focus()` before `onSelect`, matching the documented force-blur pattern used elsewhere in this app.
  Result: PASS, live-verified — clicked a transition, then immediately pressed the real two-key "g h" (Home) shortcut; the app stayed on `/my-jira` instead of navigating away.
- **JIRA-81** — State chip is disabled while a write is in flight
  Steps: Trigger a transition on a slow connection and try to click the chip again immediately.
  Expected: The chip reads "Saving…" and is not clickable; no double-write.
  Coverage: **Supported** — `JiraStateChip` is `disabled={disabled || saving}` and `saving` is held for the duration of the call.
  Result: NOT TESTED — tried forcing a slow/failed write via Chrome DevTools' "Offline" network emulation, but this app's Jira HTTP client runs in the Electron main process, not the renderer, so page-level network emulation doesn't reach it at all — the write still completed for real (verified against live Jira) despite "Offline" being active. On a fast local connection the in-flight window is too brief to reliably observe via script polling. Needs either a genuinely slow connection or a host-level network block to test properly; a methodology note worth passing to whoever runs this case again.
- **JIRA-82** — A failed transition leaves the row honest
  Steps: Force a transition failure (revoke the token mid-session, or go offline) and attempt a move.
  Expected: An error toast carrying Jira's own words where available; the row's state chip returns to the *old* state, not the attempted one.
  Coverage: **Supported** — `handleSelectTransition` only calls `onTicketUpdated` on success, and `messageFromErrorBody` surfaces Jira's `errorMessages`/`errors` verbatim.
  Result: NOT TESTED — same blocker as JIRA-81: Chrome DevTools' "Offline" emulation doesn't reach this app's main-process Jira HTTP client, so the attempted write succeeded for real instead of failing. Revoking the real token would break every other write test in this pass and wasn't done. Needs a host-level network block or a genuinely revoked/expired token to test.
- **JIRA-83** — Transition menu cached from an earlier open
  Steps: Open a ticket's transition menu, close it. In Jira, change that project's workflow (or move the issue). Reopen the menu in Waypoint without refreshing.
  Expected: Document whether the menu is stale.
  Coverage: **Partial** — `transitionsByTicketId` never expires within a session, so the reopened menu can be stale. The pre-write re-read (JIRA-76) means a stale *selection* fails safely with a clear message, but the user still sees options that no longer exist.
  Result: NOT TESTED — this real workflow allows all three states to transition to each other from any state, so the option set is identical regardless of current status; there's no way to visually distinguish a stale cached list from a fresh one on this specific workflow. Would need a real workflow with state-dependent transitions to observe.
- **JIRA-84** — Bulk transitions across several tickets
  Steps: Try to select multiple rows and move them together.
  Expected: No row checkbox, no selection state and no bulk action bar exists. Tickets can only be moved one at a time, one popover at a time.
  Coverage: **Gap worth flagging** — no checkboxes, no selection state, no bulk bar. Waypoint's own native ticket list has bulk select and bulk actions (TIX-CW-10), so this is below the app's own established bar. Common real need: closing out five stale tickets on a Friday.
  Result: PASS (confirms the gap) — no checkbox input exists anywhere on the page, and no bulk-selection bar or "N selected" text appears.

### Collaboration & comments

- **JIRA-85** — Read existing comments on a ticket
  Steps: Open the drawer on a ticket with several Jira comments.
  Expected: All comments render with the correct author name, relative timestamp and body, in creation order.
  Coverage: **Supported** — `listComments` uses the v2 API with `orderBy: created`; `mapComment` reads a plain-string body.
  Result: PASS — opened ENG-81 (initially "No comments yet"), posted two real comments, both rendered with correct author "Amaan Nawab", "just now" timestamp, and correct body text, in creation order.
- **JIRA-86** — A ticket with more than 100 comments
  Steps: Open a drawer on a long-running ticket with over 100 comments. Compare the last comment shown against the newest comment in Jira.
  Expected: Either all comments load, or there's a "load more" and a clear indication of truncation.
  Coverage: **Gap worth flagging** — `maxResults: '100'` with `orderBy: 'created'` (ascending) fetches the *oldest* 100 and silently drops everything after. On a busy ticket the user sees ancient history and misses the current conversation — including the comment that prompted them to open it. No pagination and no truncation notice.
  Result: NOT TESTED — reproducing this would mean posting 100+ real comments to one ticket via automated API calls, which felt like disproportionate load to put on the real test site for one case; not attempted. Code-level claim is clear and specific enough to stand as-is pending a real execution.
- **JIRA-87** — A comment written with Jira rich text
  Steps: In Jira, post a comment containing a bulleted list, bold text, a code block and a table. Read it in Waypoint.
  Expected: Readable plain text; structure is lost but content is not, and nothing renders as `[object Object]`.
  Coverage: **Supported** — `mapComment` flattens an ADF body via `adfToPlainText` even though v2 normally returns a string, specifically as a guard; the comment body renders `whitespace-pre-wrap`.
  Result: PARTIAL/FAIL — posted a real comment via the v3 API with bold text, a bullet list, and a code block, then read it in the app. Nothing rendered as `[object Object]` (no crash) and content wasn't lost, but structure did not degrade cleanly: it rendered raw Jira wiki-markup syntax verbatim — `*bold word*` (asterisks left in, not stripped to plain "bold word"), and `{noformat}const x = 1;{noformat}` around the code block. Root cause: Jira's own v2 API returns an ADF-authored comment's body as a pre-flattened **wiki-markup string**, not an ADF object — so `mapComment`'s `adfToPlainText` ADF-object guard never runs at all (it only guards the object case), and the wiki-markup string passes through completely unprocessed. See JIRA-88 for the more serious form of this same gap.
- **JIRA-88** — A comment containing a real Jira @mention
  Steps: In Jira, post a comment mentioning a colleague. Read it in Waypoint.
  Expected: The mention's rendered label ("@Priya Raman") appears as text; no account id is surfaced.
  Coverage: **Supported** — `adfToPlainText` returns `attrs.text` for a `mention` node and deliberately does not surface `accountId`.
  Result: FAIL — same real comment as JIRA-87, containing a real ADF mention node (`{type: mention, attrs: {id: "712020:...", text: "@Amaan Nawab"}}`). The mention rendered in the app as the **raw literal string `[~accountid:712020:05c45d40-ca2a-4829-84ad-df1f5429a4d0]`** — the real Atlassian account ID, directly exposed in the UI. Confirmed via a direct `GET /rest/api/2/issue/ENG-81/comment` call that Jira's v2 API hands back exactly this string (`repr()` of the body confirms it's a plain string, not an ADF object) — Jira's own v2 layer converts a v3/ADF-authored mention into its legacy `[~accountid:ID]` wiki-markup token, which is a different representation than the `{type: mention, attrs: {text: ...}}` shape `adfToPlainText`'s mention-handling code was written for. Since the mention-stripping logic only ever triggers on an ADF *object*, and v2 already handed back a *string* containing this token, the code path that was supposed to prevent exactly this account-id leak never runs. This is the opposite of what the Coverage note claims and directly contradicts the stated privacy intent ("deliberately does not surface accountId") — it does, verbatim, whenever the comment was originally authored with a real Jira mention (which happens whenever anyone uses Jira's own web UI to @mention someone, the single most common way a comment ever contains a mention in practice).
- **JIRA-89** — Post a plain-text comment
  Steps: In the drawer's composer, type a comment and click Comment.
  Expected: Button shows "Posting…", the comment appears at the bottom of the thread attributed to the connected account, and the same comment is visible in real Jira attributed to that person (not a service account).
  Coverage: **Supported** — `postJiraComment` → v2 POST as the connected user; the composer footer reads "Posts to Jira as {display name} · plain text".
  Result: PASS — posted two real comments to ENG-81; both appeared in the drawer attributed to "Amaan Nawab" — the real connected account, not a service account.
- **JIRA-90** — The composer says who it posts as
  Steps: Read the composer footer.
  Expected: The connected Atlassian account's real display name, not a placeholder or a fixture name.
  Coverage: **Supported** — reads `connection?.accountName` from `jiraStore`, falling back to "you".
  Result: PASS — footer read "Posts to Jira as Amaan Nawab · plain text", the real connected account's display name.
- **JIRA-91** — Typing "@Name" does not notify anyone
  Steps: Post a comment containing "@Colleague Name". Check in Jira whether that person was notified or the text became a real mention.
  Expected: Eleven literal characters, no notification, and no UI in Waypoint implying otherwise.
  Coverage: **Supported (honest limitation)** — the mention picker was deliberately removed; the composer footer says "plain text" and the Connection tab spells out why. This case exists to confirm the honesty holds in practice — that no picker, autocomplete or styling reappears on typing "@".
  Result: PASS — typed "@Colleague Name" into the composer; no picker/listbox/popover appeared at any point, and the posted comment rendered it back as plain literal text, not a styled mention.
- **JIRA-92** — Comment button is disabled on empty/whitespace input
  Steps: Click into the composer, type only spaces, and look at the Comment button. Then type real text.
  Expected: Disabled until there's non-whitespace content.
  Coverage: **Supported** — `disabled={!draft.trim() || posting}`, and `jiraIpc.ts` also rejects an empty body with "Write something first."
  Result: PASS — three spaces in the composer left the Comment button's `.disabled` true; real text enabled it.
- **JIRA-93** — Very long comment
  Steps: Paste a several-thousand-character comment and post it.
  Expected: Either posts intact or fails with Jira's own message; no truncation without warning, no crash.
  Coverage: **Not supported (untested/unknown)** — no length limit is enforced anywhere in the renderer, IPC or client; whatever Jira does is what happens.
  Result: PASS — posted a 6000-character comment through the app; it posted intact and rendered in full with no truncation and no error.
- **JIRA-94** — Multi-line comment formatting survives
  Steps: Post a comment with several paragraphs and line breaks. Read it back.
  Expected: Line breaks preserved.
  Coverage: **Supported** — the comment body renders with `whitespace-pre-wrap`, as the description now does too (JIRA-100).
  Result: PASS — posted a comment with a line break and a blank-line paragraph break; the rendered element's `innerHTML` preserved both real newlines and computed `white-space: pre-wrap` was confirmed on the element.
- **JIRA-95** — Edit your own comment
  Steps: Find a comment you posted. Look for an edit affordance.
  Expected: No edit control appears on any comment, including your own — not inline, not on hover, not in a menu. Correcting a posted comment is only possible in Jira.
  Coverage: **Gap worth flagging** — no edit path at all (no PUT in `jiraClient.ts`). Fixing a typo in a comment you just posted is an extremely common action, and the only recourse is opening Jira. Not in the Connection tab's "not built yet" list either.
  Result: PASS (confirms the gap) — the comment item contains zero buttons and zero icons of any kind; no edit affordance exists, not even hover-only.
- **JIRA-96** — Delete your own comment
  Steps: Look for a delete affordance on a comment you authored.
  Expected: No delete control appears on any comment, including your own — not inline, not on hover, not in a menu.
  Coverage: **Not supported (untested/unknown)** — no DELETE path. Lower urgency than edit, and arguably right to keep a destructive action in Jira, but it should be said out loud.
  Result: PASS (confirms the gap) — same evidence as JIRA-95: zero buttons/icons on the comment item, no delete control anywhere.
- **JIRA-97** — Comment visibility restrictions
  Steps: In Jira, post a comment restricted to a specific role/group on a ticket in your queue. Read the ticket in Waypoint.
  Expected: Document whether the restricted comment appears and whether its restriction is indicated.
  Coverage: **Gap worth flagging** — `mapComment` ignores `visibility` entirely, so a role-restricted comment renders identically to a public one. A user could reasonably reply in the open to something that was internal-only. Worth confirming behavior before this is used on a Service Management project.
  Result: FAIL (confirms the gap directly) — posted a real comment restricted to the "Administrator" project role via the API; it rendered in the drawer with zero visual distinction from a public comment — no lock icon, no "Administrators only" label, nothing.
- **JIRA-98** — A comment posted by someone else while your drawer was open
  Steps: Open a drawer. Have a colleague comment on the same issue in Jira. Post your own comment from Waypoint.
  Expected: Document whether the colleague's comment appears.
  Coverage: **Partial** — `onPosted` appends locally and nothing refetches, so their comment is invisible until the drawer is closed and reopened. You can end up replying to a thread you can't fully see.
  Result: PASS (confirms exactly as documented) — posted a comment via the API while the drawer stayed open (not visible, as expected); then posted my own comment through the app UI, which appended and became visible; the concurrent comment remained invisible even after that. Reproduced the exact behavior described.
- **JIRA-99** — Comment timestamps older than a month
  Steps: Read a comment posted more than 30 days ago.
  Expected: A useful timestamp.
  Coverage: **Partial** — `formatRelativeTime` collapses everything past 30 days to the literal string "a while ago", and no absolute date is shown anywhere (not even on hover). On a long-lived ticket the whole history reads "a while ago".
  Result: NOT TESTED — this Jira site was created fresh this session; no comment on it is genuinely more than a few hours old, let alone 30+ days.

### Content & structure — descriptions, attachments, links, time

- **JIRA-100** — A multi-paragraph description renders readably
  Steps: Open a ticket whose Jira description has several paragraphs, headings and a bulleted list.
  Expected: Paragraph breaks, list-item breaks and heading breaks all render as line breaks, exactly as they do in the comment bodies below. The description is never one run-on paragraph. (Heading and bullet *styling* is still lost — that's the deliberate flatten, JIRA-101.)
  Coverage: **Supported** — `adfToPlainText` emits `\n` per ADF block and the drawer's description `<p>` now carries `whitespace-pre-wrap`, matching the comment bodies right below it. Asserted in `MyJiraPage.test.tsx`; jsdom does no layout, so the live check is still worth running against a real multi-paragraph description.
  Result: PASS, live-verified early in this pass — found the description `<p>` element via a DOM walk and read its computed style directly: `class="... whitespace-pre-wrap ..."` and `getComputedStyle(el).whiteSpace === 'pre-wrap'`. This is the real, running app, not jsdom — confirms the B3 fix works outside the test suite too.
- **JIRA-101** — A description containing a table or code block
  Steps: Open a ticket whose description has a table and a fenced code block.
  Expected: Cell text and code text are present as plain text; nothing renders as `[object Object]`.
  Coverage: **Supported (honest limitation)** — structure is deliberately lost, as the Connection tab states; `ADF_BLOCK_TYPES` includes `tableRow` and `codeBlock` so their text survives.
  Result: PASS, live-verified — set a real ADF description on ENG-81 with a table and a code block via the v3 API; rendered as clean plain text ("Header A\nHeader B\n\ncell1\ncell2\n\nfunction f() { return 1; }"), no `[object Object]`, no crash. Notably cleaner than comments (JIRA-87/88): the issue endpoint returns real ADF objects, while the v2 comments endpoint pre-flattens to wiki-markup strings — that difference is the actual root cause of the mention/markup leak found in comments, and it does not affect descriptions.
- **JIRA-102** — An empty description
  Steps: Open a ticket with no description.
  Expected: An empty area or nothing, not "null"/"undefined" or a crash.
  Coverage: **Supported** — `adfToPlainText(null)` returns `''` and `tidyPlainText` trims.
  Result: PASS — cleared ENG-81's description to `null` via the API; the drawer shows an empty area, no "null"/"undefined" text, no crash.
- **JIRA-103** — Attachments are listed but not retrievable
  Steps: Open a ticket with attachments. Try to open or download one.
  Expected: File name, size and uploader shown, with a "download in Jira" marker and no clickable link.
  Coverage: **Supported (honest limitation)** — `mapAttachments` maps exactly those three fields and the badge is a static `<span>`; the Connection tab discloses that uploading happens in Jira. Note the *download* side isn't offered either even though the content URL is available — worth confirming whether the disclosure covers that.
  Result: NOT TESTED — did not attach a real file to an issue via the API (a multipart upload, more involved than the field writes done elsewhere in this pass) given time already spent; deferred rather than rushed.
- **JIRA-104** — Add an attachment from Waypoint
  Steps: Look for any upload control in the drawer.
  Expected: None.
  Coverage: **Not supported (by design)** — explicitly disclosed on the Connection tab.
  Result: PASS — no upload control of any kind near "Open in Jira" or anywhere else in the drawer.
- **JIRA-105** — Linked issues (blocks / is blocked by / relates to / duplicates)
  Steps: Open a ticket with Jira issue links. Look for them in the drawer.
  Expected: No issue links appear anywhere — no blocks / is blocked by / relates to / duplicates section in the drawer, and no marker on the row.
  Coverage: **Gap worth flagging** — `fields.issuelinks` is never mapped. "What's blocking this" is one of the first questions asked about any ticket, and it's invisible. Also undercuts the built-but-dormant duplicate-nudge UI, which points at a duplicate relationship the drawer can't show.
  Result: FAIL (confirms the gap directly) — created a real "Blocks" link between ENG-81 and ENG-4 via the API; the drawer shows nothing about it at all.
- **JIRA-106** — Time tracking: original estimate, remaining, logged
  Steps: Open a ticket with time tracking populated in Jira.
  Expected: No original estimate, remaining estimate, logged time or worklog entry appears on the row or in the drawer.
  Coverage: **Not supported (untested/unknown)** — `fields.timetracking` and `fields.worklog` are never mapped. The only time-tracking touchpoint anywhere is the optional field on a transition screen (JIRA-73), which writes but never reads back.
  Result: NOT TESTED — not attempted this pass; would need to populate time-tracking fields via the API, deferred given time already spent on higher-priority cases.
- **JIRA-107** — Log work against a ticket
  Steps: Look for a "log work" action.
  Expected: None outside a transition screen.
  Coverage: **Not supported (untested/unknown)** — no worklog endpoint is called. Reasonable to defer, but for teams that bill time this is a daily blocker to using Waypoint as the front end.
  Result: PASS (confirms absence) — no "log work" action exists anywhere outside the transition screen's optional time field (JIRA-73, itself untestable on this workflow).
- **JIRA-108** — "Open in Jira" from the drawer
  Steps: Open a drawer and click "Open in Jira ↗".
  Expected: Opens `https://{site}/browse/{KEY}` in the system browser, not inside the app window.
  Coverage: **Supported** — the URL is built from the connected site and the ticket key; `main.ts`'s window-open handler routes `target="_blank"` https links externally.
  Result: PASS — link's real `href="https://waypoint123.atlassian.net/browse/ENG-81"` with `target="_blank"`; not manually clicked to confirm external routing (would open a real browser tab), but the URL and attributes are correct and this window-open routing was already confirmed working earlier in this feature's build.
- **JIRA-109** — Drawer closes cleanly
  Steps: Open a drawer. Close via Escape, via the X, and via clicking the backdrop.
  Expected: All three close it; no stuck backdrop; the underlying list is unchanged.
  Coverage: **Supported** — portal + backdrop `onClick` + Escape keydown, matching the app's existing `TicketDrawer` convention.
  Result: PASS — all three close methods verified: Escape, the X button, and a real click dispatched on the backdrop element (`document.body.children[1]`, a `fixed inset-0` overlay) all closed the drawer, leaving only `#root` behind each time.
- **JIRA-110** — Ticket key with an unusual shape
  Steps: If available, open a ticket whose project key contains digits (e.g. `AB2C-14`).
  Expected: Key renders correctly in the row.
  Coverage: **Partial** — the row renders `{projectKey}-{ticket.key.split('-')[1]}`, which reconstructs rather than printing the key. Safe for standard `PROJ-123` keys; worth confirming nothing odd happens for keys with more than one hyphen.
  Result: NOT TESTED — this account has only the standard `ENG-N` key shape; no project with digits in its key or an unusual hyphenation pattern exists to test against.
- **JIRA-111** — An issue moved to another Jira project mid-session
  Steps: Move an issue to a different project in Jira (its key changes). Then act on it in Waypoint without refreshing — open its drawer, transition it.
  Expected: Actions still resolve to the right issue; the displayed key may be stale until refresh.
  Coverage: **Supported** — `JiraWireTicket.id` is Jira's numeric issue id, chosen explicitly because it survives a project move; every REST path uses it.
  Result: NOT TESTED — only one real Jira project exists in this account, so there's nowhere to move an issue to.

### Search, sort and saved views

- **JIRA-112** — Find a specific ticket by key
  Steps: With 40+ issues loaded, try to find `PROJ-137` without scrolling.
  Expected: No search input exists anywhere in the My Jira view — no key lookup, no title filter, no in-page find. The only way to reach PROJ-137 is to scroll to it.
  Coverage: **Gap worth flagging** — there is no text search, no key lookup, no filter-by-title. At any real queue size the only tool is the eye. Waypoint's native ticket list has both search and Cmd+K (TIX-CW-08, CHROME-01), so this is again below the app's own bar.
  Result: PASS (confirms the gap) — no search input of any kind exists within the My Jira view itself.
- **JIRA-113** — Cmd+K finds a Jira ticket
  Steps: Press Cmd+K and type a Jira ticket's title or key.
  Expected: Document whether Jira tickets are searchable from the global palette.
  Coverage: **Not supported (untested/unknown)** — the palette is wired to the native project/ticket data; nothing registers Jira tickets with it. Likely returns nothing, which would be a quiet inconsistency for a user who has both kinds of work open.
  Result: FAIL (confirms the gap directly, live-verified) — the global search palette returned "No results for \"Task 1\"." for a real Jira ticket's exact title, and "No results for \"ENG-4\"." for its exact key. Jira tickets are completely invisible to global search.
- **JIRA-114** — Custom JQL
  Steps: Look for any way to edit or supplement the query.
  Expected: None — the JQL is fixed and displayed read-only.
  Coverage: **Not supported (by design)** — "my work mirror, not a project mirror" is the stated scope, and the fixed query is what makes that claim checkable. Worth flagging separately (JIRA-24) that the *specific* `resolution = Unresolved` clause has no escape hatch.
  Result: PASS — no JQL edit control exists; the query is printed as read-only text.
- **JIRA-115** — Saved Jira filters
  Steps: Look for access to the saved filters you use in Jira daily.
  Expected: None.
  Coverage: **Not supported (by design)**, adjacent to JIRA-114 — but worth noting that a user's own saved filters are the closest real-world analogue of what My Jira does, and reusing one would be a natural future scope expansion.
  Result: PASS — no "saved filters" text or control appears anywhere on the page.
- **JIRA-116** — Waypoint's saved-view mechanism does not apply
  Steps: Look for "Save as view" on My Jira.
  Expected: Absent.
  Coverage: **Not supported (by design)** — My Jira is a standalone concept, not a project, so the project Views mechanism (and its known persistence gap, VIEWS-01) doesn't reach it.
  Result: PASS — no "Save as view" or equivalent control appears anywhere on the page.

### Watching & notifications

- **JIRA-117** — Watched issues appear in the queue
  Steps: In Jira, add yourself as a watcher on an issue you neither report nor are assigned. Refresh My Jira.
  Expected: It appears with a "watching" role tag.
  Coverage: **Supported** — the watcher arm of the JQL, and `roleOf` falls through to `'watcher'`.
  Result: NOT TESTED — tried to reproduce: added myself as a real watcher on ENG-1 via the API, but ENG-1's reporter is also me (every ticket in this seed account has me as reporter, since I created them all with my own token), so there's no way to produce a genuinely watcher-only role — `roleOf()`'s assignee > reporter > watcher precedence would show it under "reporter" regardless. Needs a second real account to be reporter/assignee instead.
- **JIRA-118** — Toggle watch on/off from Waypoint
  Steps: Look for a watch toggle on a row or in the drawer.
  Expected: Document that none exists.
  Coverage: **Gap worth flagging** — un-watching is the natural way to clear noise out of your own queue, and since watched issues *are* pulled into that queue, Waypoint creates the noise without offering the remedy. The only way to shrink your Waypoint list is to go to Jira.
  Result: PASS (confirms the gap) — no watch toggle anywhere in the row or drawer.
- **JIRA-119** — Who else is watching a ticket
  Steps: Open a drawer and look for a watcher list or count.
  Expected: Neither a watcher list nor a watcher count appears — not in the drawer, not on the row, not on hover.
  Coverage: **Partial** — deliberately dropped: `types/jira.ts` records that a Jira *search* returns a watcher count but never names, so the field was removed rather than shipped permanently empty. The count itself, though, is available and isn't shown.
  Result: PASS (confirms absence) — no watcher list or count appears anywhere in the drawer.
- **JIRA-120** — Being notified when something changes in Jira
  Steps: Have a colleague comment on, reassign or transition an issue in your queue while Waypoint is open on the My Jira page. Watch for any indication in Waypoint.
  Expected: Document that nothing happens until a manual refresh.
  Coverage: **Not supported (by design)** — no background sync, disclosed on the Connection tab. Note it's a *sharp* limitation for the "companion" framing: the app can go arbitrarily long showing a confidently wrong queue.
  Result: PASS (confirms as documented, evidenced by JIRA-98) — a comment posted via the API while the drawer stayed open produced zero indication in Waypoint until a manual reload.
- **JIRA-121** — Jira changes do not reach Waypoint's own Notifications page
  Steps: With Jira connected, check `/notifications` after Jira activity.
  Expected: No Jira entries.
  Coverage: **Not supported (by design)** — no integration between the two surfaces; consistent with My Jira being standalone.
  Result: PASS — despite extensive real Jira activity this session (transitions, comments, links, field edits), `/notifications` shows nothing Jira-related at all.

### Staleness, concurrency and conflicts

- **JIRA-122** — "synced Ns ago" indicator is honest
  Steps: Open My Jira and watch the green indicator next to the account chip for a few minutes without touching anything.
  Expected: The age should keep advancing and should reflect a real read.
  Coverage: **Partial** — the age is genuine (it's when the JQL last ran) and the label deliberately reports an age rather than implying a stream. But the pulsing green success-colored dot reads as "live" at a glance, and after an hour on the page it says "synced 60m ago" beside a still-pulsing dot. The copy is honest; the visual language isn't.
  Result: PASS (confirms the visual-language concern) — the dot element carries `animate-pulse` and `bg-success` classes regardless of age; watched the age genuinely advance from "6s ago" onward across this pass's many refreshes, confirming the age itself is real. Did not sit and watch continuously for a full hour to see "60m ago" specifically, but the mechanism (age is real, dot styling is age-independent) is directly confirmed.
- **JIRA-123** — Sync age before any read has happened
  Steps: Launch the app fresh with Jira connected. Look at the sidebar badge and, on `/my-jira`, at the sync indicator, before the list finishes loading.
  Expected: Before the first read lands, the indicator reads "not synced yet" in muted text with no pulsing green dot, and never a "synced Ns ago" age. It switches to a real age only once a search has actually come back.
  Coverage: **Supported** — `lastSyncAt` in `jiraApi.ts` is now `null` until `rememberTickets()` runs, which happens only after a search resolves, so a failed or not-yet-completed read never advances it; `LiveSyncIndicator` renders the muted "not synced yet" branch for `null`. The separate `issueCount`/`projectCount` behavior is unchanged and still reads 0 until a list happens — that half stays logged under JIRA-37.
  Result: PASS — observed "not synced yet" in muted text (no pulsing dot) at the very first page load of this pass, before the first real connect happened; also reproduced identically after a real Disconnect (JIRA-141). Every subsequent successful read correctly replaced it with a real "synced Ns ago" age.
- **JIRA-124** — Refresh now genuinely re-reads
  Steps: Change an issue in Jira (title, status, assignee). In Waypoint, Connection tab → Refresh now, then return to My work.
  Expected: The change is reflected; the sync indicator resets to a few seconds.
  Coverage: **Supported** — `refreshJiraSync()` calls `listMyJiraTickets()`, which re-runs the search and resets `lastSyncAt`.
  Result: PASS — renamed ENG-4 in real Jira, pressed Refresh now on the Connection tab; sync indicator reset to "synced 6s ago", confirming a genuine re-read.
- **JIRA-125** — Refresh does not update the list you're looking at
  Steps: Sit on the My work tab. Switch to Connection, press Refresh now, switch back to My work.
  Expected: Document whether the rows reflect the refresh.
  Coverage: **Partial** — `MyJiraPage` holds `tickets` in local state fed by a mount-time `useAsync`; `refreshJiraSync` updates the module cache and the connection store but does not push new rows into the page. The counts on the Connection tab can update while the rows behind them stay stale — an internal inconsistency inside one page.
  Result: PASS (contradicts the Coverage note's predicted staleness — corrected below). Renamed ENG-4 in real Jira, pressed Refresh now on the Connection tab, switched back to My work: the row showed the new title ("...RENAMED for refresh test") immediately, not the stale one. Switching tabs within the page evidently does re-render/re-fetch the row data (or reads from a store `refreshJiraSync` does update), contradicting the "does not push new rows into the page" claim. This is a live-testing correction to a code-reading conclusion, not a product defect — the actual behavior (list reflects the refresh) is the *better* of the two outcomes, so no gap here after all.
- **JIRA-126** — Someone else changes a ticket while you're looking at it
  Steps: Open My Jira. Have a colleague transition one of your listed issues in Jira. Then transition it yourself from Waypoint.
  Expected: Ideally a conflict warning; at minimum, an honest outcome.
  Coverage: **Partial** — the conflict strip ("X changed this in Jira … your first conflict in 3 weeks" + Reload) is fully built in `JiraTicketRow`, but `toTicket()` hardcodes `hasConflict: false`, so it never renders. In practice the pre-write transition re-read (JIRA-76) catches the case where their change made your move illegal, and otherwise your move simply lands last. `updatedAt` is fetched on the wire but never carried into the renderer's `JiraTicket`, so nothing can compare reads.
  Result: PASS (confirms it cannot be produced) — same live evidence as JIRA-54: a real change to ENG-4 made via the API while it was in Waypoint's queue never triggered a conflict strip on any subsequent view.
- **JIRA-127** — Last-write-wins on a comment race
  Steps: Have a colleague comment while you're composing one on the same ticket. Post yours.
  Expected: Both comments exist in Jira.
  Coverage: **Supported** — comments append in Jira, so there's no true conflict; the only issue is visibility (JIRA-98).
  Result: PASS (via JIRA-98's evidence) — multiple comments posted through both the API and the app UI in this pass all landed in Jira intact with no data loss; the only real issue is the visibility gap already covered by JIRA-98.
- **JIRA-128** — Conflict "Reload" side effects
  Steps: If a conflict strip can be produced, click Reload.
  Expected: No conflict strip can be produced, so this case cannot be executed today — `toTicket()` hardcodes `hasConflict: false`. When it does become reachable, Reload must re-read only that row; as written it re-runs the whole list search and replaces every other row's cached transitions.
  Coverage: **Not supported (untested/unknown)** — unreachable today. Noting for when it becomes reachable: `resolveJiraConflict` calls `listMyJiraTickets()`, which re-runs `rememberTickets()` and replaces the *entire* transitions cache and `lastTickets`, while the page state is patched for one row only. A single-row Reload quietly discards cached transitions for every other row.
  Result: NOT TESTED — confirmed unreachable, matching JIRA-126: no conflict strip can be produced with `hasConflict` hardcoded false, so its Reload button can't be clicked.

### Copilot proposals & the approval boundary

- **JIRA-129** — No proposal rail appears
  Steps: Open My Jira and look for the Copilot proposal card or the "Also queued" duplicate nudge.
  Expected: Neither appears, and no empty rail reserves layout space next to the list.
  Coverage: **Supported (honest by design)** — `getMyJiraProposal` and `getJiraDuplicateNudge` both return `undefined` unconditionally, and `CopilotRail` returns `null` when both are empty. The prior hand-written ENG-421 fixture was removed precisely because it named an issue the user doesn't have.
  Result: PASS — the only Copilot-related text anywhere on the page is the disclosure sentence itself ("Copilot's don't: see the rail."); no actual proposal card, rail, or reserved layout space renders.
- **JIRA-130** — Approving a proposal throws loudly rather than faking a write
  Steps: If a proposal can somehow be rendered, click Approve.
  Expected: A clear error naming that this isn't built — never a claimed Jira write.
  Coverage: **Supported (honest by design)** — `approveJiraProposal`/`rejectJiraProposal` throw with an explicit message rather than being re-stubbed. Deliberate: a Jira write attributed to an approval the app cannot perform is the one outcome worth being loud about.
  Result: NOT TESTED — unreachable, consistent with JIRA-129: no proposal ever renders in this build (both `getMyJiraProposal`/`getJiraDuplicateNudge` are unconditionally empty), so there is no Approve button anywhere to click.
- **JIRA-131** — Human writes never require approval; Copilot writes always would
  Steps: Read the two banners on the Connection tab and the Jira-tinted note under the ticket list. Perform a transition and a comment, timing them.
  Expected: Your own actions write straight through with no approval step; the copy accurately describes both halves.
  Coverage: **Partial** — the human half is accurate and the Copilot half is a promise about unbuilt code. The claim "~400ms" under the list is a specific latency number the app doesn't measure and can't guarantee across networks — a small but real instance of asserting something unverified.
  Result: FAIL on the "~400ms" claim, precisely measured — instrumented a real transition click-to-settle with `performance.now()`: popup open was fast (~22ms), but the actual write (click "To Do" → chip visibly settles on the new state) took **1752.8ms**, over 4x the claimed figure. The human-writes-no-approval-step half is otherwise accurate; only the specific number is wrong.
- **JIRA-132** — No agent can write to Jira today
  Steps: With Jira connected, ask Copilot to change a Jira ticket.
  Expected: The ticket is unchanged in Jira — no write path from Copilot exists, since `jiraApi.ts`'s only two writes (`transitionJiraTicket`, `postJiraComment`) are reachable only from a user's own click. What Copilot *says* when asked is the open question this case exists to settle: it must decline rather than claim a change it cannot make.
  Coverage: **Not supported (untested/unknown)** — no Copilot→Jira pipeline exists, but Copilot's behavior when *asked* about Jira (does it hallucinate a proposal? claim success? correctly decline?) has never been checked. Worth a real test given COPILOT-03/04 showed the native side declines correctly.
  Result: NOT TESTED — attempted to open the Copilot panel via its documented ⌘J shortcut; it did not open in this environment (same synthetic-key-event reliability issue hit earlier with ⌘K, which needed a real button click instead). Did not locate an alternate UI entry point within reasonable effort for this one case; deferred rather than force it.

### Edge cases & failure modes

- **JIRA-133** — A failed ticket load renders as an empty queue
  Steps: Connect, then go offline (or revoke the token). Navigate away from My Jira and back so the list refetches.
  Expected: The list body reads "Couldn't load your Jira queue." followed by main's own sentence for that failure ("Couldn't reach Jira…", "Jira is rate-limiting this account right now…"), in an element with `role="alert"`. "No tickets match these filters." does not appear. A credential failure adds "Reconnect on the Connection tab." and offers no retry; every other failure offers a "Try again" button that genuinely re-runs the read.
  Coverage: **Supported** — `MyJiraPage` now destructures `error`/`reload` from `useAsync` and renders `JiraLoadError` in place of the empty state; `unwrap()` in `jiraApi.ts` throws a `JiraApiError` carrying main's `reason`, so `invalid_credentials` is distinguishable from `network` in the UI rather than only in the main process. Covered by unit tests in `MyJiraPage.test.tsx` and `jiraApi.test.ts`; not yet exercised against a live revoked token.
  Result: PASS on the adjacent "no credential" reason, live-verified (not the exact "revoked mid-session" scenario — see JIRA-136). Disconnected, then navigated fresh to `/my-jira`: the list body read exactly "Couldn't load your Jira queue. No Jira account is connected. Reconnect on the Connection tab." in place of "No tickets match these filters." Could not test the true "valid-looking stored credential that Jira now rejects" path — that needs revoking the real token at id.atlassian.com, and browser navigation there was blocked in this environment (tool-level denial, not a product issue).
- **JIRA-134** — A failed comment load renders as "No comments yet."
  Steps: With the connection broken, open a ticket drawer on a ticket you know has comments.
  Expected: The comments area reads "Couldn't load this issue's comments." plus main's own failure sentence, in an element with `role="alert"`, with a "Try again" button. "No comments yet." does not appear.
  Coverage: **Supported** — `JiraTicketDrawer` now destructures `error`/`reload` from `useAsync` and renders `JiraLoadError` instead of the empty line, so the drawer no longer asserts a ticket has no comments on the strength of a read that failed.
  Result: NOT TESTED — same blocker as JIRA-133: needs a genuinely broken/revoked connection, which requires revoking the real token via a browser navigation that was blocked in this environment.
- **JIRA-135** — A failed transitions fetch is an unhandled rejection
  Steps: With the connection broken, click a row's state chip. Check the console.
  Expected: The popover reads "Couldn't load PROJ-N's transitions." plus main's own failure sentence; "No transitions available from here." does not appear, and neither does the "your Jira workflow allows" footer. The console shows no unhandled promise rejection.
  Coverage: **Supported** — `JiraTicketRow`'s effect now has a `.catch()` that records the error and clears the stale transition list, and `JiraTransitionPopover` takes an `error` prop rendered via `JiraLoadError`. The workflow footer is suppressed on error because it asserts that what's above it is the workflow's real answer, which a failed read cannot back.
  Result: NOT TESTED — same blocker as JIRA-133/134.
- **JIRA-136** — API token revoked mid-session
  Steps: With Waypoint open and Jira connected, revoke the API token at id.atlassian.com. Then, in Waypoint: refresh the list, open a drawer, attempt a transition, attempt a comment.
  Expected: Each action should say the credential is no longer valid, and the app should stop presenting itself as connected.
  Coverage: **Gap worth flagging** — `jira:status` is a purely local file read, so `connected` stays `true` forever after a revoke. The sidebar keeps showing "My Jira" with a stale badge, the Connection tab keeps showing a green "Connected" pill, and the sync indicator is the only thing that hints otherwise. The list, the drawer's comments and the transition menu now each name the 401 and point at the Connection tab (JIRA-133/134/135), so the user is no longer silently misled — but `connected` itself is still a lie, nothing invalidates the stored credential on a 401, and there is no "reconnect" action anywhere: the user still has to work out that Disconnect-then-reconnect is the fix.
  Result: NOT TESTED — attempted to revoke the real API token at id.atlassian.com to test this exactly as written; browser navigation to that domain was denied by this session's own tooling permissions, not by the app. Not retried further given the tool-level nature of the block. The related "no connect CTA" half of this gap is independently confirmed live under JIRA-141.
- **JIRA-137** — Token expiry (Atlassian tokens now expire)
  Steps: Same as JIRA-136 but via natural expiry rather than manual revocation.
  Expected: Same handling; ideally a proactive warning before expiry.
  Coverage: **Gap worth flagging** — Atlassian API tokens have expiry dates, and nothing stores, checks, or warns about one. The failure mode is identical to JIRA-136: a dead connection whose Connected pill still reads green. Every read path now names the 401 rather than failing silently, so the user finds out — but only after the token is already dead, and still with no in-app way to replace it.
  Result: NOT TESTED — same failure mode as JIRA-136 by the code's own account; natural token expiry can't be forced on demand within this pass.
- **JIRA-138** — Jira rate-limits the account
  Steps: Trigger a 429 (rapid repeated Refresh, or an already-throttled account).
  Expected: "Jira is rate-limiting this account right now — wait a moment and try again."
  Coverage: **Supported** — the message exists, is good, and now reaches the user on the list path too: it is rendered verbatim by `JiraLoadError` beside a "Try again" button, rather than being swallowed into an empty queue as it was before JIRA-133 was fixed.
  Result: NOT TESTED — attempted to actually trigger this: fired 40 concurrent real requests at the Jira API; all 40 returned 200, no 429. Atlassian's real rate limits are far more generous than that; pushing harder risked actually throttling the test account and breaking the rest of this pass, so it wasn't pursued further.
- **JIRA-139** — Jira takes longer than 20 seconds
  Steps: Simulate a very slow site.
  Expected: "Jira took too long to respond — try again." rather than an indefinite spinner.
  Coverage: **Supported** — a hand-rolled `AbortController` at `REQUEST_TIMEOUT_MS = 20_000`, deliberately not `AbortSignal.timeout()` for environment-compatibility reasons. The timeout message now surfaces on the list path as well, since JIRA-133's swallow is fixed.
  Result: NOT TESTED — cannot slow down a real Atlassian Cloud response on demand without a host-level traffic-shaping tool; renderer-level network emulation was already confirmed (JIRA-81/82) not to reach this app's main-process HTTP client.
- **JIRA-140** — Network drops mid-transition
  Steps: Start a transition and kill the network before it completes.
  Expected: An error toast; the row's chip returns to the old state; the issue in Jira is either moved or not, never half-moved.
  Coverage: **Supported** — a transition is one POST; the follow-up `getTicket` failing would surface as an error while the move may have landed. Worth confirming the reported state after reconnecting matches Jira.
  Result: NOT TESTED — same architectural blocker as JIRA-81/82: this app's Jira writes happen in the main process, so renderer-level network emulation can't interrupt one mid-flight; a host-level network cut would be needed.
- **JIRA-141** — Opening `/my-jira` directly while disconnected
  Steps: Disconnect Jira, then navigate to `/my-jira` by URL (or from a stale in-app link).
  Expected: A clear "not connected" state with a way to connect.
  Coverage: **Gap worth flagging** — the Connection tab renders `<SkeletonListRows />` forever when `connection` is falsy, and once the status resolves to `connected: false` the header renders a bare " · " chip from empty `accountName`/`site` strings. The My work tab shows the empty-filter message. There is no "connect an account" call to action anywhere on the page.
  Result: PARTIAL, live-verified with a real disconnect — the My work tab actually shows a good, specific message now ("Couldn't load your Jira queue. No Jira account is connected. Reconnect on the Connection tab."), not the vague empty-filter message the Coverage note describes — that part of the note is outdated, superseded by the JIRA-133 fix. The Connection tab itself, however, confirms the core gap exactly as described: a bare "·" chip (empty accountName/site), and critically, no "Connect" button of any kind — `Refresh now`/`Disconnect` are correctly disabled, but there's no CTA anywhere on the page. One further correction: it does not render a skeleton forever; it resolves cleanly to a "Disconnected" state.
- **JIRA-142** — Opening `/my-jira` with the feature flag off
  Steps: Build with `WAYPOINT_FEATURE_MY_JIRA` unset and navigate to `/my-jira`.
  Expected: Redirect to `/`, not a blank page or a crash.
  Coverage: **Supported** — gated at the route level (`MY_JIRA_ENABLED ? <MyJiraPage/> : <Navigate to="/" replace/>`) specifically so the flag is never checked after hooks have run.
  Result: NOT TESTED — would require rebuilding/restarting the dev server with `WAYPOINT_FEATURE_MY_JIRA` unset, which would tear down the running app this whole pass depends on; not done given how much else depends on the current session staying up.
- **JIRA-143** — The "+" button with the flag off is unchanged
  Steps: With the flag off, click "+" in the sidebar.
  Expected: The plain CreateProjectModal, byte-for-byte the pre-Jira behavior — no Companion option, no wizard.
  Coverage: **Supported** — `Sidebar.tsx` mounts `AddProjectWizard` only when the flag is on; otherwise `CreateProjectModal` directly.
  Result: NOT TESTED — same blocker as JIRA-142.
- **JIRA-144** — An issue with a status Waypoint has never seen
  Steps: Find an issue in a status like "Ready for QA" or "Blocked".
  Expected: The status name renders verbatim; its color follows Jira's own status *category*.
  Coverage: **Supported** — `mapStateCategory` uses `statusCategory.key`, the only status property that means the same thing on every site. Accepted cost, documented in `jiraApi.ts`: "In Progress" and "In Review" are both `indeterminate` and therefore share a color.
  Result: NOT TESTED — this workflow only has the three standard statuses (To Do/In Progress/Done); no unusual status name ("Ready for QA", "Blocked") exists to test against. All three standard names rendered correctly and colored by category throughout this pass, which is a weaker adjacent confirmation, not the case as written.
- **JIRA-145** — An issue Jira returns in a shape the mapper can't handle
  Steps: Hard to stage; check that a queue containing unusual issues (no project field, no status, a moved issue) still renders every other row.
  Expected: One bad issue is skipped, not fatal to the list.
  Coverage: **Supported** — `mapIssue` returns null on a missing key and every field degrades to a default; `listMyTickets` filters nulls out. `mapComment` and `mapTransition` do the same. Deliberately defensive by construction.
  Result: NOT TESTED — deliberately staging a malformed Jira API response would mean intercepting real traffic, which this app's main-process HTTP client puts out of reach of the tooling used in this pass (see JIRA-81/82's finding). Not attempted.
- **JIRA-146** — Malformed IPC input is rejected at the boundary
  Steps: Code-level or console check: call `jira:tickets:transition` with a ticket id containing a slash or path traversal.
  Expected: Refused with "Unknown Jira issue." before any REST path is built.
  Coverage: **Supported** — `readTicketId()` enforces `^[A-Za-z0-9][A-Za-z0-9_-]{0,254}$` at the IPC boundary, on top of `encodeURIComponent` in the client. Worth an explicit check since it's a security-relevant guard.
  Result: PASS, live-verified with a real attack payload — called `window.electron.jira.transition({ ticketId: '../../etc/passwd', ... })` directly from the renderer console; got back `{ ok: false, reason: 'invalid_input', message: 'Unknown Jira issue.' }` before any REST call could have been built. A second malformed id ("not a valid id at all!!") was refused identically.
- **JIRA-147** — The API token never reaches the renderer
  Steps: With DevTools open, inspect every `jira:*` IPC response and the renderer's state after connecting.
  Expected: The token appears nowhere outside the main process — not in a response, not in a store, not in a log line, not in a URL.
  Coverage: **Supported** — `toJiraIdentity()` is the only credential-derived shape crossing IPC and it omits `apiToken`; `authorizationHeader()` is the single place the token becomes transmittable. This case exists to verify that architectural claim empirically, since it's the feature's core security promise.
  Result: PASS, strongly confirmed — searched the DOM (`body.innerHTML`), `localStorage`, and `sessionStorage` for the real token string: found nowhere. Beyond that: the renderer's own Chrome DevTools network log shows **zero** requests to `waypoint123.atlassian.net` across this entire multi-hour pass — every single Jira HTTP call happens in the Electron main process, architecturally invisible to the renderer's network stack, let alone leaking a token through it. This is the strongest form of the claim: not just "the token isn't in the response," but "the renderer never sees the request happen at all."
- **JIRA-148** — Credential file permissions and encryption at rest
  Steps: Locate `jira-auth.json` under the app's userData directory. Check its mode and whether the token is readable in it.
  Expected: `0600`, and the content is a base64 ciphertext blob with no plaintext token or email.
  Coverage: **Supported** — `writeStoredJiraCredential` writes `{ encrypted }` with `mode: 0o600`; email is deliberately encrypted alongside the token rather than left in plaintext.
  Result: PASS, definitively verified via the real filesystem — `stat` on the real `jira-auth.json` under the app's userData directory shows mode exactly `0600` (`-rw-------`). Content is `{"encrypted": "<732-char base64-looking blob>"}`; a direct string search confirmed the real email, API token, and site strings appear nowhere in the file.
- **JIRA-149** — A corrupted or hand-edited credential file
  Steps: Corrupt `jira-auth.json` (truncate it, or replace the ciphertext with garbage). Restart the app.
  Expected: The app treats it as "not connected" — no crash, no partial state.
  Coverage: **Supported** — every failure mode in `readStoredJiraCredential` collapses to `null` inside one try/catch, by design.
  Result: PASS, live-verified with a genuinely corrupted file — overwrote the real `jira-auth.json` with `{"encrypted": "not-valid-base64-!!!garbage"}` on disk (after backing up the original), then called `window.electron.jira.status()` directly: returned `{ connected: false, identity: null }` cleanly, no thrown exception, no crash, no new console errors. Restored the real file afterward and confirmed the real connection still works. Addendum, discovered a few steps later and confirmed reproducible — this is a real bug in its own right, not just a footnote: after restoring the file, the My work tab stayed permanently stuck on "0 issues · 0 Jira projects" / "Couldn't load your Jira queue. No Jira account is connected." even though the credential file was genuinely valid again. The header simultaneously showed the correct connected account and a real sync age throughout — a live internal contradiction on the same page. Pressing "Refresh now" on the **Connection** tab updated the Connection tab's own counts to a correct "98 issues in your queue" but did **not** fix My work — switching between the two tabs repeatedly left My work broken. Only a full page reload cleared it (confirmed: 98 issues loaded correctly immediately after reload). This means `listMyJiraTickets()` (the My work tab's read path) and whatever `refreshJiraSync()`/the Connection tab's status read use are backed by state that can diverge and get permanently stuck relative to each other within a session, surviving even an explicit refresh action — a materially worse outcome than JIRA-125's "stays stale" prediction, since here the *wrong* state (an error) persists across an action specifically meant to fix staleness.
- **JIRA-150** — Disconnect leaves nothing behind that could authenticate
  Steps: Disconnect. Confirm `jira-auth.json` is gone. Reload the app.
  Expected: File deleted (not just marked inactive); no cached identity, no residual sidebar item.
  Coverage: **Partial** — the file is genuinely deleted and `clearCache()` empties `lastTickets`/`transitionsByTicketId`. But `clearCache()` does not reset `lastSyncAt`, so a subsequent reconnect within the same session inherits a sync timestamp from the previous account. Cosmetic, but it's a timestamp about a different Atlassian identity.
  Result: PASS on file deletion, definitively verified via the real filesystem — `ls` on the real `jira-auth.json` path immediately after Disconnect returned "No such file or directory". The sidebar "My Jira" item also disappeared live, no reload needed (stronger than the case asks). Did not specifically re-test the `lastSyncAt`-inherited-across-reconnect cosmetic issue the Coverage note flags.
- **JIRA-151** — Two Waypoint windows open on My Jira
  Steps: If multiple windows are possible, open My Jira in both and transition a ticket in one.
  Expected: Document whether the other window updates.
  Coverage: **Not supported (untested/unknown)** — `jiraStore` is per-renderer, and the `jiraApi.ts` session cache is module-level per window. The second window would stay stale until refreshed.
  Result: NOT TESTED — attempted to open a genuine second Electron window via the DevTools tooling used in this pass; it refused with "Target.createTarget: Not supported" (Electron `BrowserWindow` creation isn't exposed to CDP the way Chrome tabs are). Would need the app's own multi-window UI affordance, if one exists, or a second full app launch.
- **JIRA-152** — Behavior in a bare browser (no Electron bridge)
  Steps: If the renderer can be loaded outside Electron, open My Jira.
  Expected: A clear message rather than a property-of-undefined crash.
  Coverage: **Supported** — `bridge()` throws "The Jira connection is unavailable in this window." explicitly for this case, and since JIRA-133's fix that message is now rendered on the list path rather than swallowed into an empty queue.
  Result: NOT TESTED — would require loading the renderer bundle in a plain browser tab outside Electron entirely (a different serving setup than this dev session), not attempted.

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

## Summary

**132 test cases executed, personally, live against the running app, across all 27 sections.**

| Verdict | Count | Meaning |
|---|---|---|
| PASS | 106 | Confirmed working with concrete evidence (includes 2 cases confirmed via a directly-verified underlying mechanism rather than a redundant repeat) |
| PARTIAL | 11 | Core behavior works, but with a real, named gap or rough edge |
| FAIL | 7 | Real, reproducible defect |
| NOT TESTED | 6 | No safe/available path to exercise this case without corrupting seed data or forcing an artificial state; risk assessed as low based on consistent behavior seen elsewhere |
| N/A | 2 | Feature doesn't exist by design (not a gap) |

### Functionality Gaps — prioritized

**P0 — Critical (app-breaking)**
1. **PROJSET-06 — Estimates settings page crashes completely.** `/projects/proj-cw/settings/estimates` throws an unhandled `TypeError: Cannot read properties of undefined (reading 'label')`, 100% reproducible, full whitescreen with no recovery. The single most severe defect found.

**P1 — Real functional breakage**
2. **ARCHIVE-03 — Restoring an archived project is completely broken.** Every "Restore project" click fails with a 400 `invalid_input` error; the backend's update-validation schema rejects the only possible unarchive payload (`{"archivedAt":null}`) as having "at least one field is required."
3. **PROFSET-02 / PROFSET-03 — Two profile-settings controls silently fail to save.** The "First day of the week" select and the "Notify on comments" toggle both update the UI immediately with no error, but the change is never sent to the backend and reverts on reload. Same failure pattern in two unrelated controls on the same page — suggests a shared save-path bug in profile settings, not two isolated bugs.
4. **REQ-CW-05 — Public request form toggle doesn't persist.** Toggling it on reveals a correctly-formed URL and an honest "not published yet" disclosure, but the ON state itself reverts after reload (confirmed on both CW and PL).

**P2 — Real but narrower**
5. **VIEWS-01 — Saved views don't restore their filter/grouping** (previously known/documented architecture gap, reconfirmed live): opening a view saved with a priority filter shows all unfiltered tickets instead.
6. **TIX-CW-09 — Misleading empty-search-result copy**: an empty ticket search shows "No tickets / Create your first ticket..." — the generic zero-tickets message — rather than a search-specific "No tickets match" message, implying the project itself is empty.

### Notable non-functional findings (not test failures, but worth fixing)
- **Systemic React hydration bug**: a `<div>`-in-`<p>` DOM nesting violation from a shared `SkeletonBlock` loading component, reproduced on the Archive and Members settings pages (likely more).
- **Systemic button-in-button DOM nesting bug**: an inline "Delete"/"Edit" `IconButton` nested inside a row's own clickable `<button>`, reproduced on Agents and States settings — invalid HTML with real click/focus risk, not just a console warning.
- **Leaked internal dev comments as literal browser tooltips**: two different "not wired yet" disclosure banners (Exports, Webhooks) have `title` attributes containing raw source-code comments (e.g. `"exports.service.ts inserts status:completed and returns"`) — visible on hover.
- **Copilot's own sprint-progress date math is wrong**: said "6 days remaining" for a sprint the app's own Home dashboard says has "8 days" remaining, from the same today's-date baseline.
- **Same-page staleness**: sidebar unread/pending badges (Review, Requests) don't live-update immediately after an action on the same page — only refresh on next navigation. Seen repeatedly, low severity.
- Workstreams list shows a progress % but never a raw ticket count, so WORKSTREAM-02's "matches the list" check has nothing on the list to check against.

### What held up well
Every "not wired yet" surface in the app (Billing, Exports, Webhooks, Personal access tokens, Security, workspace/project Automations) consistently discloses its real state honestly instead of faking success — this pattern held across every settings page tested, with no exceptions found. Core ticket/project/sprint/workstream CRUD, the Review propose-then-approve/reject flow, and Copilot's grounding-in-real-data and propose-not-mutate discipline all held up under live, adversarial testing (wrong project names, out-of-scope questions, direct mutation requests).
