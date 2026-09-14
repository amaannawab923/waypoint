# 002 — Pricing and the free tier

**Status:** launch defaults chosen 2026-09-14. Every number is a starting
point to be revisited with real data at ~90 days post-launch. None of them
block engineering — only AT6 (billing) reads them, as config.

## 1. The three lines

1. **Free-forever lives in self-hosting.** Unlimited people, no caps,
   costs us nothing. That is the free tier for anyone willing to run it.
2. **Cloud free tier is a funnel, not a home.** The invite click is free —
   no card, no price on that screen — but the free workspace is bounded:
   **free up to 10 people, 30 days of Review/run history**, whichever hits
   first. Past either, Team Pro.
3. **Prices:** Team Pro **$8/seat/mo** (unlimited history, audit export,
   roles). Team Commercial **$24/seat/mo** (SSO, SCIM, compliance, self-host
   support). Solo Sync add-on **$5/mo**.

## 2. The one rule that must survive any change

**Never charge at the first invite.** That is precisely what killed Vibe
Kanban — $30/seat the moment a second person could see the board. The
seat cap sits at 10, not 2: the team has already formed and the product is
already spreading before anyone sees a price.

## 3. Why the cloud free tier is bounded (supersedes monetization-design.md Decision 2)

The earlier decision was "unlimited members free on cloud; only history
depth triggers paid." That over-read the research. The finding was "don't
gate the invite," not "never cap seats." Two things changed it:

- **Self-hosting already provides free-forever teams.** Giving the same
  thing away on our cloud is redundant — and unlimited hosted seats is the
  *one* line item in the plan that costs us real money per user, while
  the self-hosted version gives it away at zero cost to us. Backwards.
- **History depth alone is a weak paywall for large casual teams.** A
  15-person team that never cares about old history would sit free
  forever. A seat cap makes revenue predictable; the history cap catches
  small-but-heavy teams. Both together is the honest design.

## 4. Why 10, and why $8 — the Jira precedent

Our users are Jira users. Jira Cloud's free plan is **up to 10 users**;
Standard is roughly **$8/user/mo**; Premium ~$17 (as of writing — Atlassian
adjusts these; verify before quoting anywhere public). Mirroring "free to
10" feels native to this audience; 5 would look stingy next to the tool we
sit on top of.

$8/seat means a 10-person team on Jira Standard (~$80/mo) would double its
tracker spend for a companion. Not automatically wrong — Linear charges
$8 — but an open founder question (005 §2): parity with Jira, or
deliberately a fraction of it ($4–5) as "the cheap layer on top"?

Other precedents, stated accurately: GitLab.com free is 5 users. Linear
free caps *issues* (250), not members. Slack free caps *history* (90 days),
not members. Notion is per-seat from the first team plan. The pattern is
"bounded free, then per seat," with the bound varying.

## 5. What is never capped

**Jira sync in the free tier.** It is the reason the persona shows up.
Capping the hook loses them before the seat cap ever matters.

**Anything local.** No cap on local runtime, local tickets, local sessions.
A runtime-hours cap was proposed once and struck (Warp/Insomnia backlash
pattern). Sync is *new capacity* for $5, never a limit on what already
works.

## 6. What to measure at 90 days

- Seats at which free teams actually convert (is 10 right?).
- Days of history active teams reference (is 30 right?).
- Conversion rate at $8 vs. the Jira-parity question.
- Dismiss-vs-click on the Sync card; Settings vs. post-session placement.

## 7. Changes this requires on record

- `onboarding-final.html` steps 6, 8, 9, 11: "unlimited members" → "free
  for up to 10 people"; step 12 banner: history *or* 11th seat.
- `monetization-design.md` Decision 2: mark superseded, point here.
- ROAD-140 (AT6): seat counting + cap enforcement added to scope.
