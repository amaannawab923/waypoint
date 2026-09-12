# PM review — the async ticket → session model

Status: opinionated assessment, written 2026-09-12 against the W3/W4/W4b
build plans, the product strategy, the revamp architecture, and the ROAD-44
epic (ROAD-70/72/73/76/86/90/107). Read-only; nothing else was changed.

Short answer: the *spine* of the vision (dispatch → isolated async run →
click in → result gated by Review) is right and is the thing nobody else
ships on a user's own laptop. Most of the *accretions* (parallel sessions
per ticket, tabs, cross-ticket sessions, "event back to Copilot") add
surface without adding a job, and some fight what W3 already built.

---

## 1. Who the users are

Waypoint's sessions need three things on the machine: a git checkout, a
Claude subscription, and the ability to read a diff. That filters the
audience harder than "PM tool" suggests.

**A. The tech lead who owns the board.** Runs a 4–8 person team's Jira
project; still commits weekly. Morning: board, standup prep, 3–5 support
bugs with no RCA. Afternoon: code review, a ticket of their own. Their
scarce resource is *investigation time* — the 20 minutes per bug it takes
to say "retry path, real, medium." They want first-pass RCAs before
standup and small, well-specified fixes turned into PRs without opening an
editor. They will read a diff; they will not merge one unread. This is the
primary user and the one W3/W4 already serve.

**B. The solo founder-engineer** (the founder; the Roadmap project linked
to its own checkout). The tracker is their to-do list; sessions are "Claude
Code desktop, but inside Waypoint" (w4b-sessions-anywhere.md §0). They
dispatch several tickets an hour and want the ticket closed when the PR
exists. Highest frequency, lowest review burden.

**C. The technical PM / support-engineer triager.** Reads code, does not
ship it. Their job is "is this a bug, where, how bad, who." They want an
RCA and a comment, never a branch. Copilot already does most of this
read-only (qa-evidence/02: an RCA comment proposed and approved). A session
adds value only when the investigation must *run* something — reproduce,
test, grep a huge monorepo.

**Not a user: the non-technical PM.** No checkout, cannot review a diff,
and a PM dispatching `bypassPermissions` agents at code is the governance
scenario ROAD-2/3/4 exist for. Copy and defaults should not pretend
otherwise.

## 2. Jobs the model serves — and does not

Served:

- *"First-pass RCA on this bug while I do standup."* The most valuable
  job, shared by all three archetypes, ending in a comment — the artifact
  Review already handles.
- *"Turn this small, well-specified ticket into a PR while I'm elsewhere."*
  A and B. Ends in branch + PR + state change.
- *"Which of my runs need me?"* W3's Waiting on you → Active → Done
  grouping (w3-sessions-rail.md §1.4) is the correct async primitive.
- *"Jira stays the truth; nothing lands there without me."* The
  propose→approve spine (strategy §2) — the differentiator, not the
  session.

Not served, and should be said out loud:

- *Runs while the laptop is closed.* The daemon survives a Waypoint
  restart (ROAD-44), not sleep; "overnight" copy is false here
  (revamp-architecture §5.5).
- *A teammate picks up my run.* Runs are `ownerMemberId = CURRENT_USER_ID`
  on one machine (w3 §3). No team visibility, no handoff.
- *Iterate on the PR.* W6 opens it; nothing loops review comments back
  into the session, which is Copilot coding agent's whole model.
- *Big or ambiguous tickets.* Agents fail on these everywhere; the PM-side
  job is decomposition — something Copilot could propose and the vision
  never mentions.

## 3. Competitive reality check

| Product | "Hand it a ticket, come back later" | What it gets that Waypoint lacks | What Waypoint has that it lacks |
|---|---|---|---|
| **OpenAI Codex cloud tasks** | Task per cloud sandbox with the repo preloaded; **Ask** (read-only) vs **Code** intents; parallel tasks; follow-up prompts on a task; diff → PR | Laptop closed, nothing to install, parallelism unbounded by a MacBook | Runs on *your* checkout with local tooling; no upload; Jira write gated by a review queue |
| **Cursor background agents** | Remote VM per agent, branch per agent, launch from editor/web/Slack, "open in Cursor" to take over, list in sidebar | Take-over into a real editor; Slack dispatch | Ticket context and the PM side; no per-seat cloud |
| **GitHub Copilot coding agent** | Assign the issue (GitHub, Jira or Linear) → Actions runner → draft PR → iterates on PR review comments | The PR-comment iteration loop; team-visible; zero local setup | Local execution; a human gate *before* anything hits the tracker; RCA-as-comment intent |
| **Devin** | Sessions list; dispatch from Slack/Linear/Jira; chat with a running session; PRs; named sessions | Cloud, team-shared sessions, mobile | Own subscription, no vendor holding the code |
| **Linear agents** | Assign/mention → an *agent session on the issue* with an activity feed and states (pending / active / awaiting input / complete / error); several agents per issue | The session-in-the-issue model as a tracker primitive, and distribution | Nothing — Waypoint is not a tracker; but Linear's model is the one to copy for the drawer's Runs section |
| **Jira Rovo (agents in Jira GA May 2026, per strategy §1)** | Agent as assignee; progress as comments; PR via Bitbucket/GitHub | Native to Jira; sales channel | Local-first; honest, checkable "what leaves this machine" |
| **emdash** | Task = one worktree; **many conversations per task**; parallel tasks; permission prompts; diff; PR; issue integrations create a task from a ticket | Terminal runtime, multi-provider, dev servers, a maturing task model | The PM half entirely: tickets, Review, Jira write gating |

**Table stakes** (every row): an isolated run per task, a status list, a
"waiting on you" state, follow-up chat on a live run, a branch/PR, a
notification when done, and an *ask-vs-code* intent split. The vision has
all of these; none differentiates.

**Differentiated**: (1) the run edits the user's own checkout under their
own subscription (strategy §1's honest privacy claim); (2) the result
reaches Jira only as a *proposal* — the one human gate no cloud agent puts
in front of the tracker; (3) Copilot has the PM context (sprint, comments,
related tickets) to write the brief that Codex and Cursor make you type.

**Lacking**: laptop-closed execution, team visibility, PR-comment
iteration, a tracker-native activity feed. The first two are structural to
local-first; disclose them.

## 4. The vision, element by element

### (a) Copilot as the dispatcher offering RCA vs resolve — **keep the intents, change the dispatcher**

The two intents are exactly Codex's Ask/Code and exactly the `rca` /
`full-coding` pair strategy §8 harvested. Keep them. Two changes:

- Copilot "offering" is a chat affordance; the reliable one is a verb on
  the ticket: **Investigate** and **Fix** in the drawer and the list's bulk
  bar (strategy §8's "Ask Copilot to…" menu). Copilot's chat can invoke the
  same two verbs; it must not be the only door, or the feature is
  discoverable only by people who already talk to Copilot.
- Map the intents onto machinery that exists. W4b verified the Claude
  adapter offers `default / acceptEdits / plan / dontAsk / bypassPermissions`.
  **Investigate = a worktree session in `plan` mode** (reads, runs nothing
  destructive, cannot edit). **Fix = a worktree session with the autonomy
  policy.** The intent *is* the mode; nothing new to build.
- Investigate should first be tried inside Copilot itself (Read/Glob/Grep,
  already shipping, synchronous, cheap). Escalate to a session when the
  ticket needs reproduction, tests, or logs. The `[[NEEDS_REPO]]` sentinel
  pattern (copilot-v3-codebase-grounding.md) is the shape of the signal.

### (b) The session panel as the async surface, click in, chat with it — **keep, with one split**

W3 built the right thing and every competitor confirms the shape. The
queued-prompt behaviour in W4 §1.4 (`placement: auto` queues while a turn
is active) is literally "without disturbing the RCA."

The split: **"what was the problem?" and "do X differently" are different
jobs.** The second is steering and belongs in the session's composer. The
first is a *question about* the run, and sending it into the run costs
tokens, lands in the agent's context, and can redirect it. Route it to
Copilot: give the MCP server a read tool (`get_run` → brief, events,
summary, last N transcript turns) and let Copilot answer from the ledger.
That is the founder's "chat with Copilot about a session," and it is the
mechanism that never disturbs the run. Label the session composer as
steering, not Q&A.

### (c) Multiple sessions per ticket (RCA, comment, resolve) — **change**

The ledger already allows many runs per ticket (`agent_runs.ticketId`,
drawer Runs section). Keep that as *history*. Do not design three
*parallel* sessions per ticket:

- "Comment" is not a session. It is a proposal, and Copilot makes it today.
- RCA then Fix is a **sequence with a handoff**, not two cold starts: the
  Fix brief is seeded with the *approved* RCA comment. Otherwise the second
  session re-explores the repo — double tokens, and the RCA the human
  approved is not what the fix acts on.
- Parallel writing sessions on one ticket diverge into two branches nobody
  asked for. W4b allows two live sessions in one folder with a warning;
  fine for independent runs, wrong as a dispatched default.

The model to copy is emdash's own: **one worktree per ticket, many
conversations on it.** A plan-mode Investigate can share the worktree; at
most one writing session at a time. Linear's "agent sessions on an issue"
is the tracker-side rendering of the same idea.

### (d) Renaming and tabbing — **rename: keep. Tabs: drop**

Rename is cheap (`agent_runs.title` exists; W4 derives it from the first
prompt) and Devin/Cursor both have it. Ship it as an inline edit in the
header.

Tabs across sessions fight the W3 list. The list is grouped by *what needs
you*, system-sorted, never user-sorted (w3 §1.4) — that rule is the async
model. A tab strip is a browser metaphor for "things I'm looking at right
now," which is the synchronous model. Every competitor's run surface is a
status-sorted list, not tabs; emdash's tabs live *inside* a task
(chat/terminal/diff), which W3 already has as Transcript | Diff. If the
need is "see this ticket's sessions together," that is a group-by-ticket
toggle on the list plus the drawer's Runs section — both nearly free.

### (e) One session spanning multiple tickets — **drop for dispatched runs; allow for independent ones**

The real need is "don't make me re-explain the codebase per ticket." The
proposed fix breaks the thing the loop depends on: a dispatched run must
be 1:1 with a ticket for the resolution proposal, the state transition,
the audit trail (ROAD-80), and staleness. A branch touching three tickets
is a PR reviewers reject, and a long-lived multi-ticket context degrades.
"Multiple tickets" is *N runs* — that is the entire premise of emdash's
parallel worktrees — and the brief builder (ROAD-72) plus a repo
`CLAUDE.md` is how context stops being re-explained. An *independent*
session (W4) that the user points at several tickets by hand is fine and
needs no product concept beyond a many-to-many "related tickets" link if
ever.

### (f) Resolution → proposal in Review, and an event back to Copilot — **keep the proposal; redefine the event**

Host-side finalize as proposals (ROAD-76/79) is correct and is the only
thing on this list that no competitor has. Three refinements:

- The resolution comment must be PM-shaped — what was wrong, what changed,
  how to verify, PR link — with the disclosure prefix; never the transcript.
- **One place to act, several places to see.** A finished run should appear
  as a proposal in Review and as *needs-review* in the panel, but approval
  happens once. Do not let the panel grow its own approve button.
- "Event back to Copilot" should be a system note in the dispatching
  conversation built the way revamp-architecture §5.6 builds outcome
  preambles — from ledger fields, **never model-authored text** — so a run
  cannot smuggle instructions into Copilot. Its useful payoff is chaining:
  Copilot says "fix landed as PR #61; approve the state change? dispatch
  ROAD-34 next?" — still one human click per write.

Note ROAD-107 is open (keep the ACP session alive through needs-review?).
Answer it "yes, until the proposal is resolved," because a reviewer's
"also handle the null case" is the single most common follow-up, and a
fresh session for it is the re-exploration cost again.

### (g) Auto-approve in a worktree as the default — **keep, conditionally**

The rule (on in a worktree, off in a folder, remembered per folder, marked
"auto" on the row) is emdash's and Claude Code's norm, and a dispatched run
that *asks* defeats the async premise — the user is gone by definition.

The condition: a worktree is *filesystem* isolation, not credential or
network isolation. `bypassPermissions` will happily `git push`, `curl`, or
`npm publish` with whatever is in the environment. ROAD-88 (env scrub) and
ROAD-87 (per-worktree deny list) are the real safeguards and they are W8
backlog. Until they ship, "auto" on by default is a claim the panel cannot
verify — the exact class strategy §7's rule forbids. Ship the scrub before
the default, or default off with the sentence saying why.

## 5. The real risks

**Review burden changes kind.** Review today approves one-line cards. A
Fix run produces a diff, a PR, a comment, and a state change. Reviewing
code is not a card; it is GitHub. Be explicit that Waypoint's approval
means *publish* (push, open PR, post comment), not *accept the code* — or
the queue will either hide diffs behind cards or become a code-review tool.

**Attention fragmentation — the fourth inbox.** Strategy §2 already had to
adjudicate Notifications vs Requests vs Review. The panel's Waiting on you
is a fourth. Rule: *blocked on a permission* → panel badge; *finished* →
Review. Never both.

**No notifications exist.** Strategy §7 Tier 1: nothing in the codebase
creates one. Async without an OS notification means a run blocks on a
permission at 10:04 and the user finds it at 11:30. Add OS notifications
for `blocked` and `needs-review` before any copy says "asynchronous," and
ship ROAD-90's permission-wait timeout so a blocked run cancels cleanly
rather than sitting forever.

**Cost and rate limits.** Every session is a full Claude Code run on the
user's plan. RCA + Fix as two cold sessions is roughly 2× tokens;
parallel sessions eat a Max plan's five-hour window; a rate-limit mid-run
is a *stall*, not an error, and needs its own `errorKind` and sentence.
`MAX_CONCURRENT_RUNS = 2` (revamp §5.5) is honest and should be visible.

**Who is in charge.** The clean story: *Copilot is the PM — reads, briefs,
reports, proposes; never edits code. The session is the engineer — works
in a worktree; never touches Jira.* The vision blurs it with "the session
posts the resolution"; ROAD-76 already says the host does. Keep the line
and say it in the UI.

**Failure modes.** Stalls (ROAD-90's stall timer); half-done branches (an
explicit *Abandon* plus worktree GC, ROAD-97); the ticket edited in Jira
mid-run (proposals have staleness, runs don't — snapshot the brief, diff at
finalize); duplicate dispatch on one ticket (warn like W4b's busy folder);
restart-but-not-sleep survival (ROAD-93/94 before the milestone demo).

**Org context.** Sessions belong to an engineer's machine. The safe
product statement is "your engineers' agents, gated by your PMs' review,"
not "PMs dispatch coding agents." That also answers the governance tickets
(ROAD-2/3/4) with the existing audit trail instead of new admin UI.

## 6. Recommendations

**Minimum slice to build first — Investigate → comment.** On a Roadmap
ticket: a drawer button (drag-and-drop, ROAD-71, is a demo, not the
minimum) → brief preview (ROAD-72) → a `plan`-mode worktree session → on
finish, the host files a *comment proposal* with the RCA → Review → Jira.
No push, no PR, no bypass, no W6, no W8 dependency. It exercises dispatch,
the panel, finalize, and the spine end to end; its output is the artifact
archetype C wants and A and B want first. Then **Fix**, seeded from the
approved RCA, reusing the worktree; then W6.

**What to measure** (instrument before the slice, per strategy §10):

1. Dispatched runs per active day per user — is the door used.
2. **Detach rate**: fraction of runs where the user leaves the detail pane
   before the run ends. If people watch every run, the async thesis is
   wrong and this is Claude Code desktop with a Jira sidebar.
3. Time from `blocked`/`needs-review` to first human action — are they
   actually coming back, and how fast.
4. Completion mix: needs-review vs failed / cancelled / stalled per intent.
5. Proposals-from-runs approved rate, split from Copilot's own; and how
   often the RCA comment is *edited* before approval (quality proxy).
6. Fix runs whose PR merged within 7 days — the only outcome metric.

**Five sharp changes to the vision:**

1. Intents are verbs on the ticket (Investigate / Fix); Copilot is one
   invoker, not the gate. Intent = ACP mode.
2. One worktree per ticket, sessions on it; RCA seeds Fix; never parallel
   writers on one ticket.
3. No cross-ticket dispatched sessions. Many tickets = many runs.
4. "Chat about a run" goes to Copilot via a `get_run` read tool; the
   session composer is steering. Drop tabs; keep rename.
5. Blocked → panel, finished → Review, one approval; OS notifications and
   the env scrub ship before the words "asynchronous" and "auto-approve."

## 7. Verdict

The founder's core insight is correct and, importantly, already proven by
Codex, Cursor, and Devin: people want to hand a ticket to an agent, leave,
and come back to a "waiting on you" row. What makes Waypoint's version
worth building is not the panel — that is table stakes and W3 has it — but
the combination no one else offers: the run happens on the engineer's own
checkout under their own subscription, and the only thing that reaches Jira
is a proposal a human approved. The vision's additions mostly dilute that:
parallel sessions per ticket, tabs, and cross-ticket sessions re-import the
synchronous, editor-shaped model the panel was built to escape, and "the
session posts the resolution" undoes the one gate that is the product.
Build Investigate → comment first, watch whether users actually detach
from the run, and let that number — not the feature list — decide whether
Fix, PR, and autonomy follow.
