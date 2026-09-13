# PM review — the W5a walkthrough (Copilot ↔ sessions on ROAD-43)

Status: assessment of the live walkthrough in `.qa-screenshots/w5a-cycle/`
(01–17), the QA record (SESS-32…42), the design's §9 build log, and PR #62 as
it sits on GitHub. Written 2026-09-13 as the follow-up to
`pm-review-async-ticket-sessions.md`. Read-only; nothing else was changed.

## 1. Rating: 7 / 10

The loop is real. One Copilot message became an editable brief, a plan-mode
run, an RCA a person approved onto the ticket, a Fix seeded from that RCA, and
a 44/31-line PR with three green checks; Copilot then answered "is the fix
done?" from the ledger and refused to open a second PR. Against Codex
cloud, Devin, or Copilot coding agent, a six-person team's lead gets what none
of them offer: nothing reaches the tracker without their click, nothing leaves
their machine, and the footer shows the cost ($1.95 + $2.59, on a plan they
already pay for). Against plain Claude Code, Waypoint wrote the brief from the
ticket, kept the run on the ticket as history, and opened the PR without the
agent holding a credential. That is a 7.

It is not an 8 because the edges are where week two lives: the PR body opens
with "Not pushed" and names the wrong branch; the ticket comment is the
agent's engineering log verbatim; the Review page says "approving is the only
thing that mutates anything" while a PR was opened before anyone approved;
and a run's proposals silently expire in 24 hours. It is not a 6 because each
of those is a copy or ordering fix, not an architecture fix, and the spine
held on a genuinely flaky test with a fix CI accepted first time.

By stage: ask 8 (natural language, correct tool call, nothing started); offer
7 (right verbs, but the card vanishes once used and nothing records that a
run began); brief 6 (editable and honest, but mode and auto-approve sit below
the fold and the branch shown is not the branch used); run 7 (PLAN/AUTO
chips, cost, steering composer, transcript survives the kill); review 6
(three surfaces, two badges, trailing cards, a 24h TTL); post 7 (rendered,
disclosed, but long and engineer-shaped); fix 8 (seeding works, one writer
per ticket, env scrub proven inside the session); PR 6 (good code,
bug-shaped title, self-contradicting body); close 5 (In Progress for finished
work, no session marker in Activity, a dead session the moment a reviewer
wants one more change).

## 2. What moves it up

One point, in order:

1. Treat the PR as the deliverable. Title from the intent, not the ticket
   ("Fix ROAD-43: …"); a body that leads with what changed and how it was
   verified; never a line the host knows is false ("Not pushed",
   `agent/ROAD-43` for a branch named `agent/ROAD-43-0uftaro`). The session's
   environment notes (Node 22, `--ignore-scripts`) belong in the transcript,
   not in front of a reviewer.
2. One approval per run. A Fix files a comment and a state change as two
   cards with two Approve buttons. Make it one — "Post the report and move to
   In review" — and put the PR link on the ticket's Sessions row.
3. Keep the session alive through needs-review. "This session has ended
   (needs review)" appears at the exact moment a reviewer wants to type "also
   handle the null case."
4. Fix the Review page sentence, or gate the push behind the same card. Right
   now the copy and the behaviour disagree.
5. Show mode and auto-approve above the brief in the preview. The person is
   deciding whether an agent may edit code; that should not need a scroll
   inside a dialog.
6. Run-filed proposals must not expire while the run is waiting. A weekend
   away should not leave a run that never closes.

Two points needs the audience the product is for:

1. Dispatch a Jira-backed ticket. The walkthrough ran on a native ticket; the
   tech lead who owns a Jira board — my primary user — cannot use any of this
   yet. "Your tracker" is the first word of the pitch and the one thing the
   demo cannot show.
2. A second Fix continues the branch (ROAD-123), and a PR review comment can
   be handed back to the run. Without that loop the product stops where
   Copilot coding agent starts.
3. A teammate can see the run — even read-only, the ticket's Sessions section
   and its report — so "Amaan's agent" becomes a team artifact.

## 3. Friction in the screenshots

**02 / 09.** The label wraps as "The brief — what the session is told /
first", with the ticket title greyed beside it like a second label. Focus
lands on the close button. The facts row says "Worktree agent/ROAD-43 from
main"; the run in 10 is on `agent/ROAD-43-0uftaro`. The Fix brief is raw
markdown in a small textarea; the mode row and auto-approve switch are below
the visible edge. No "⌘⏎" hint on Start.

**03.** The Copilot panel overlays the run header, cutting the chip to
"Investigate PLA". Every command opens with `$ cd "/Users/amaannawab/Library/
Application Support/waypoint-frontend/worktrees/…"`. The offer card is gone
from the conversation and nothing replaces it.

**04.** "This session has ended (needs review)." The reader has just read a
"Not settled" section and has nowhere to say "settle it."

**05.** The note — "Run ROAD-43 · Investigate finished (1 turn) · 1 proposal
filed, waiting for your review." — is right, but the card's Approve/Reject
sit a screen and a half below its heading, "Reject all pending" is the most
prominent verb in the panel header, and two badges light for one item.

**06.** The user typed "Post the RCA as a comment on ROAD-43" *after* the
card was on screen: "1 proposal filed" did not read as "the comment is
drafted, approve it." Copilot recovers ("I can't approve it for you, and I
won't duplicate it") and then re-summarises the whole RCA, pushing Approve
further off-screen.

**07 / 13.** The comment is authored "Amaan · 2m ago" and opens "Hi, this is
a Waypoint session — Amaan's agent — reporting on their behalf:". "Hi," is a
chat greeting on a ticket. The Activity feed then reads "Amaan changed state"
and "Amaan left a comment" with no session marker — the audit trail I asked
for does not show it was an agent.

**08 / 12.** After every later reply the RCA card ("Applied ✓") reappears
under the newest message. Run-filed proposals have no conversation anchor and
render as a tail, so an old Applied card trails the conversation forever —
in 12 directly under "approve the two pending cards in the panel", where the
reader sees an Applied card and no pending ones.

**10 / 11.** The note's PR URL is cut off at the panel edge; the run header
shows the branch but not the PR. In 11 bullets render as literal "-Fake
timers on (" and the PR URL is bold text, not a visible link.

**14 / 15.** The fold is right, but the grey box ("Open 'View brief' above the
transcript to read it.") stays after the brief is open — now wrong.

**17.** "Proposed by Agent" is generic where the card knows "from run
ROAD-103 · Fix". The state card proposes Todo → In Progress for a run whose
PR is open. "Executes once on approve · expires in 24h" is on a card the
person may not see until Monday. And the subtitle — "approving is the only
thing that mutates anything" — is no longer true.

## 4. What the walkthrough hides

**A second Fix.** ROAD-123 gives it a fresh worktree with "the prior branch
named in its brief" — two branches and two PRs on one ticket, the
parallel-writer problem in a different coat.

**A failure.** No run that ended with no text, no failed push, no logged-out
`gh`, no stall. §9 says a failed push is "a sentence on the comment" — the
comment still gets filed, and I want to see that ticket.

**Monday morning.** `PROPOSAL_TTL_MS` is 24h, and the expiry sweep does not
settle the run. Leave Friday, return Monday: the comment and state change are
"expired", the run sits at "Needs review" with nothing approvable, and the PR
is open on GitHub with no comment on the ticket. Nothing here exercises a gap
longer than 31 minutes.

**A Jira ticket.** Not dispatchable; and a native ticket has no URL for the
PR body to link back to.

**Forty tickets a week.** At ten a day the queue is twenty walls of RCA
under a "Reject all pending" button; the concurrency cap is shown nowhere.

**A teammate.** Runs belong to one member on one machine. A colleague opening
ROAD-43 sees "Amaan left a comment" and two Sessions rows they cannot open.

**The laptop lid.** The Review tab is labelled "Ran overnight". The daemon
survives a restart, not sleep.

**Did anyone detach?** §7 asks for the detach rate before the slice. The
walkthrough is one person watching one run to the end — the one case that
does not test the async thesis.

## 5. Earlier concerns: answered and not

**Answered.** Verbs on the ticket, not only in chat (13, 16, 01). Intent is
the mode. Fix seeded from the *approved* RCA (09). One writer per ticket
(SESS-39). No tabs; rename in the header. Host-side finalize as proposals
labelled "from run … ↗" (17). The note back is ledger text, never model text.
"Chat about a run" goes through a read tool, not into the session (11, 12).
The env scrub shipped before auto-approve defaulted on, and went further than
I asked because the keychain helper would have let a push through (SESS-36).
Copilot never starts a run.

**Partly.** "Blocked → panel, finished → Review, never both": a finished run
lights My sessions, Review, and a Copilot card. Notifications exist in code;
QA says logged, not observed. "Approval means publish, not accept the code":
half-true now — comment and state are gated, push and PR are not, and the
Review copy has not caught up.

**Not answered.** ROAD-107 — keep the session alive until the proposal is
resolved; it is killed at finalize. The PM-shaped resolution comment (what was
wrong, what changed, how to verify, PR link — never the transcript): the
comment and PR body are the closing message verbatim, reviewer notes about
the worktree's Node version included. The rate-limit sentence — honestly
scoped out, but a Max user's most likely stall still looks like a hang. The
"overnight" copy survived. Abandon plus worktree GC, mid-run ticket edits, a
visible concurrency cap — not in evidence. The metrics — nothing shows a
detach rate or decision latency being written.

## 6. Positioning verdict

"Your tracker, your subscription, your machine — the same panel in Waypoint
Cloud later." The middle two are made credible in a way no slide could: the
cost is on the footer, the push was refused inside the session and made by
the person's own `gh` outside it, and the PR footer says so in a sentence a
security reviewer can check. "The same panel later" is plausible but
unproven — nothing in seventeen screenshots touches the transport, and the
24h TTL and the session kill are exactly what breaks first when runs live on
a host you never close.

"Your tracker" is the claim the walkthrough cannot yet support. It ran on a
Waypoint-native ticket, Jira tickets cannot be dispatched, and the comment
that landed — a greeting plus an engineering log under the human's name — is
not what a Jira project lead wants posted on their behalf. The pitch is
two-thirds earned. The missing third is its first word, and the reason the
primary user would buy.
