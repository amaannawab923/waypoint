# PM review — the W5b walkthrough (Copilot ↔ sessions on a Jira issue)

Status: assessment of `.qa-screenshots/w5b-jira-cycle/` (00–30), the QA
record JIRA-SESS-1…14, the W5b design's §9, and PR #64 on GitHub. Written
2026-09-13 as the follow-up to `pm-review-w5a-walkthrough.md` (7/10) and
`pm-review-async-ticket-sessions.md`. Read-only; nothing approved, nothing
written to Jira, no other file touched.

## 1. Rating: 7 / 10

The Jira half is built the way I asked and, where trust is concerned,
better than the native half was a day ago. A Jira issue has the three
verbs; the brief comes from the live issue and names its URL; the folder is
asked for once per `ENG` and remembered; the preview shows Issue, Folder,
Worktree, Mode and Auto-approve *above* the brief; finalize files the report
and a transition through the exact path Copilot's Jira writes already take,
with a banner that says who posts, where, and who gets notified; an
ambiguous key is refused rather than guessed; run-filed proposals keep 30
days and expiry settles the run; the Review page says what is true. PR #64
is titled from its commit and links the issue on line one. Four of my six
"one point up" items from W5a landed.

It stays at 7, not 8, for three reasons a Jira lead hits first. Nothing was
written: both Jira writes stopped at the Approve button, so what the board
would show is rated from cards, not from Jira. The issue is a fixture — the
agent's own bottom line is "This repository has no search indexer. The
ticket is seeded fixture data" — so the walkthrough proves the plumbing, not
the job. And Copilot, the PM, does not know the ticket's session history:
with an RCA on ENG-77 pending review it offered a fresh Investigate twice
(18, 19) and never said "there is already one waiting for you."

By stage: ask 7 (slash and plain language both land; "above" for a card
that renders below); offer 6 (no verb highlighted for "look at"; no history;
the card vanishes once used); brief 8 (facts row, folder step, issue link;
minus the branch name and no issue type); run 7 (PR ↗ on the Sessions row;
"Dispatched" on every list row regardless of state); review 7 (the banner is
the best sentence in the product; two cards, no edit); post 5 (unexecuted,
ADF rendering unverified, 600 words of Waypoint file paths bound for Jira);
fix 7 (seeding unverifiable because the RCA was never approved; the preview
does not say one is pending); PR 7 (host preamble first; "Not pushed" and the
Node 18 note still in the body); close 5 (To Do → In Progress on a ticket the
agent said to close, unexplained; session killed; three approvals).

## 2. What moves it up

One point:

1. Approve the two writes on a real issue and look at Jira. Until the ADF
   comment and the transition are seen on the board, "your tracker" is a
   card.
2. Make the PM know the ticket. `dispatch_session` and the preview should
   say "Investigate ran 22m ago · RCA pending review" and, for Fix, "the RCA
   recommends Won't Do — fix anyway?" The information is in the ledger; the
   Sessions row on the same screen shows it.
3. Edit before a notified write. A Jira comment notifies watchers; a lead
   will want to cut 500 words of `tickets.service.ts:322-330` to the bottom
   line before it goes. The card has Reject and Approve and nothing between.
4. Say why the transition is what it is: "ENG's workflow has no review
   status; In Progress is the nearest." Without it, To Do → In Progress on a
   finished fix reads as the agent misjudging.
5. One card per run, and the PR body's report must not say "Not pushed"
   under a preamble that says it was.

Two points:

1. An outcome for "not a bug." The Investigate's most useful verdict —
   close as Won't Do — has no proposal type; `pickReviewTransition` only
   knows review and in-progress. Archetype C's whole job ends in that
   transition, and today they do it in Jira by hand.
2. A Jira project is not one folder. `ENG` maps to one path; real `ENG`
   projects span services. ROAD-129 (project → codebase) is the shape; until
   then the picker needs a per-issue override that does not overwrite the
   memory.
3. Keep the session alive through needs-review, and a second Fix on the
   prior branch (ROAD-123) — unchanged from W5a and still the gap between
   this and Copilot coding agent.

## 3. Friction in the screenshots

**02 / 03.** "Sessions" is title-case, indented and larger than
ATTACHMENTS / SUBTASKS / LINKED WORK ITEMS / COMMENTS around it — it reads
as pasted in.

**04 / 05.** "Not set yet — choose the folder ENG's code lives in below. It
is remembered for the next ENG session." is good copy. The picker lists
`/private/tmp/wp-qa/main-repo` beside the real repo with nothing to tell a
fixture from a codebase. "Worktree agent/ENG-77" in every preview; the Fix
ran on `agent/ENG-77-bgvpwai` (21). "started now ago" (06).

**07 / 30.** Every row says "Dispatched" with a spinner glyph — done, running
and needs-review alike; the dot colour carries the state. `ENG-77` groups
look identical to `ROAD-43` groups: no Jira mark, no site.

**11 / 12.** The card: "This is a Waypoint session — Amaan's agent —
reporting on their behalf:" (the "Hi," is gone), then "Bottom line" as body
text where the report meant a heading — a hint about how headings will
land in ADF. "Executes once on approve · expires in 30 days" and the banner
"Approving writes to the real Jira issue ENG-77 on
waypoint123.atlassian.net as Amaan Nawab — the issue's watchers and
assignee will be notified, per your Jira notification scheme" are exactly
right. "Ran overnight 8" is still a tab.

**13.** The ENG-77 note landed in a conversation titled "I need a root
cause for ROAD-43…" — the owner's latest, not one about this issue — under
the ROAD-43 "Applied ✓" card that still trails every reply. Words break
mid-word ("deci ded", "propos al").

**15 / 20 / 22.** The Fix preview is silent about the pending RCA and about
the Investigate's "Close as Won't Do." The section's Fix has no note field,
so the QA engineer had to go through `/fix`. When a second Fix is refused,
Start greys out and the sentence explaining why is below the fold.

**18 / 19.** "I've put up the session options … above. Pick one:" — below.
No verb highlighted for "look at". Both replies describe an investigation
that already exists.

**24.** "LedgerRequestError: "ENG-1" is ambiguous…" — a class name in the
user's face, and only after a Tab workaround (JIRA-SESS-12's FAIL: the
sentence is suppressed while the slash menu matches the native key).

**26.** Investigate on "Epic 1 — (no description)", Start enabled. No issue
type in the brief, so an epic and a bug get the same instructions.

**27.** State card: To Do → In Progress, no reason. Comment card leads with
"Pull request: https://…/pull/64" as plain text, then "Branch … from main,
in the run's worktree." — in a Jira comment "the run's worktree" means
nothing to a teammate.

## 4. What the walkthrough hides

**The board.** Nothing shows ENG-77 after approval. The markdown-lite → ADF
pass is unit-tested; nobody has looked at a heading, a list, or a code mark
on the issue. JIRA-SESS-7 hands that to the founder.

**A real issue.** ENG-77 describes a service that does not exist in the
mapped repo. The RCA is "not a bug, seed data"; the Fix is a regression test
for behaviour that already works. The W5a walkthrough had a real flaky test.
This one demonstrates that the loop closes, not that it helps.

**The board after both approvals.** Comment 1: "not a code defect — close
as Won't Do." Comment 2: "PR adds a regression test." Status: In Progress.
A teammate reading cold cannot tell what the team decided. The product let
the Fix run without reconciling it against the RCA it ignored.

**Jira disconnected mid-run, another site, staleness.** JIRA-SESS-6 and
13 not run; "someone moved it in Jira meanwhile → stale" designed and
untested live. All unit-tested, none seen.

**Multi-repo projects.** One path per `ENG`, replaced silently on the next
Start after a Change.

**The Copilot note's home.** A run started from the drawer has no
conversation, so its note lands wherever the person last talked — here, a
thread about a different ticket.

## 5. Earlier concerns: answered and not

**From the W5a review — answered.** Jira-backed dispatch (the first
two-point item) exists and uses Copilot's write path, not a new one. Mode
and auto-approve above the brief (05, 15). The Review page sentence now
says a finished writing run's branch is pushed and its PR opened "by
Waypoint, as you — the ticket hears about it here." Run-filed proposals
keep 30 days and the expiry sweep settles the run. PR title from the
commit, issue link first, host preamble first. "Proposed by a Waypoint
session" instead of "Proposed by Agent." The disclosure lost its "Hi,". The
Sessions row carries PR ↗.

**Partly.** The PR body: the host's truth is on top, but the session's
"Not pushed." and the Node 18 environment note are still inside it.

**Not answered.** One approval per run (two cards, three for a ticket with
both runs). The session alive through needs-review — still "This session
has ended (needs review)". Trailing Applied cards. Teammate visibility. A
second Fix on the prior branch. "Dispatched" as the status word.

**From the first review.** "Copilot has the PM context to write the brief"
— true for the brief, false at offer time: it does not read the ticket's
runs. "PM-shaped, never the transcript" — the Fix comment now has a
PM-shaped head over an engineer-shaped body; the RCA comment is still the
closing message. "Blocked → panel, finished → Review, never both" — still
both, plus the note. An Epic with no description gets Investigate with
Start enabled. Archetype C's "not a bug" outcome has no proposal type.

## 6. Positioning verdict

"Your tracker" now has evidence where it had none: the verbs on a Jira
issue, a brief from Jira, a comment and a transition that reach Jira only
through the path a person already approves, a banner that names the site,
the account and the notification consequence, and a PR whose first line is
the issue. The machinery is the right machinery, and it is honest about
itself in a way Rovo and Copilot coding agent are not.

What the walkthrough does not yet earn is the word "your." The two writes
are pending; the issue is fictional; the comment that would land is a
Waypoint engineer's audit of Waypoint's own code, six hundred words long,
un-trimmable, recommending the ticket be closed — followed by a transition
that moves it forward. A Jira project lead wants the first paragraph of
that comment and a Won't Do button. Until one real issue on one real board
has been through Approve and someone has read the result in Jira, the
pitch is three-quarters earned: your subscription, your machine, your
tracker's *door* — and the same panel later.

## 7. After the writes

The founder approved all three cards. Read back through the app's Jira
path (screen 31; JIRA-SESS-7/10): comment 10325 is the Investigate report
under the disclosure, 10324 the Fix report leading with the PR link, and
transition 21 moved ENG-77 to In Progress. Both runs went Done. The gate
is proven on a live site, as the person, disclosed — the reason I withheld
an 8 for "nothing was written" is gone.

**The rating stays 7 / 10.** What replaced that reason is what I said I
would judge: is this what a Jira project lead wants on their board? Not
yet. In the only rendering we have, the Fix comment is a wall — "Files
touched", "How I verified it" as plain lines, list items split by blank
lines, no code marks — and it carries, on a real tracker, "Commit: 66b60e9
… on agent/ENG-77-bgvpwai. Not pushed." under a line saying the PR is
open, plus "Installed deps with npm ci under Node 22.23.2 …
release/app/dist/{main,renderer}". Jira's own rendering was not inspected;
the headings may survive there, the sentences will not. The
order is inverted — 10324 (the PR) above 10325 (the verdict) — so the
issue reads "PR open" → "not a bug, close as Won't Do" → In Progress. A
teammate opening ENG-77 cold sees a fix for a bug the same agent says does
not exist.

The writes earned the word "tracker": door, gate, disclosure and banner
did what they said. They exposed that the report is still the engineer's,
posted verbatim where the PM's summary belongs, with no trim and no
outcome for the verdict the agent reached. A
board-shaped comment, host facts the session's text cannot contradict, and
a Won't Do proposal make this same walkthrough an 8.
