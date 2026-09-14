# Approach A · Quiet Invite — the evidence, and what it changed

Status: research record, 2026-09-14. Three independent researchers were
each shown the Approach A onboarding mockup
(`onboarding/onboarding-option-a.html`, the comparison in
`onboarding/options-comparison.md`) and asked to rate it 1–10 for one
lens, using web research with real sources. Their full reports are in
`research/approach-a/` (lens-1, lens-2, lens-3) — this file is the
consolidation and the record of what was changed in the mockup because
of it. Companions: `pm-research-accounts-onboarding.md` (the four
approaches that produced A), `../design/waypoint-accounts-and-teams.md`,
`../design/waypoint-product-strategy.md`.

## 0. The ratings

| Lens | Rating | One line |
|---|---|---|
| 1 · Solo-developer first launch | **8 / 10** | Nails the moment that matters most on launch day; sidesteps exactly what Warp had to reverse |
| 2 · Solo → team growth (PLG) | **6.5 / 10** | Passive discovery is the real weakness — footer links get 0.05–0.46 % CTR; a solo user who never assigns work to someone else has no path to Team mode |
| 3 · Local-first / privacy trust | **7 / 10** hosted-only · **8.5 / 10** with self-hosting | The "hosted only at the invite click, explicit local/hosted split" pattern is trusted (Obsidian Sync, Standard Notes, Atuin); self-hosting is a 1.5-point swing on its own |

Composite ≈ 7.2, ≈ 7.7 if self-hosting is at least roadmapped. The spread
is the useful signal: A is strongest exactly where launch-day risk lives
and weakest where post-launch growth lives — which is what picking the
least-risk option was supposed to buy.

**Evidence quality, stated up front.** The case studies are solid and
specific (Warp shipped mandatory login, took sustained backlash, removed
it in November 2024; Obsidian/Zed/Excalidraw ship sign-in as optional;
Obsidian Sync earned acceptance on public Cure53 and Trail of Bits
audits). The percentages (drop-off rates, "30 % PLG uplift", banner CTRs)
come mostly from vendor growth blogs and should be read as directional,
not measured on this audience.

## 1. Lens 1 — solo-developer first launch (8/10)

**What the evidence says**

- **Warp's reversal is the closest precedent.** Warp required login to use
  a terminal, took hundreds of complaints across GitHub and HN, and lifted
  the requirement in Nov 2024 — core features now work without an account.
  A is on the right side of this. ([Warp: lifting the login requirement](https://www.warp.dev/blog/lifting-login-requirement), [HN](https://news.ycombinator.com/item?id=42247583))
- **Sign-in walls are expensive.** Vendor data: SaaS signup drop-off
  60–80 %; ~23 % won't complete if forced to create an account; every
  extra field costs 8–10 %. Directional, but consistent across sources.
  ([Userpilot](https://userpilot.com/blog/drop-off-rate/), [Eleken](https://www.eleken.co/blog-posts/saas-conversion-rates))
- **The exact pattern has precedent.** Excalidraw: no login to draw, a
  share link for live collaboration, an optional paid tier. Obsidian:
  core free and local, Sync optional and paid. Zed: core editing unsigned,
  GitHub OAuth only for collab/AI. Cursor is the counter-example — account
  on first launch, and setup guides call it out as friction.
  ([Excalidraw](https://dev.to/nologintools/excalidraw-free-online-whiteboard-no-login-required-25j4), [Zed auth docs](https://zed.dev/docs/authentication), [Cursor setup](https://www.bannerbear.com/blog/how-to-get-started-with-cursor-ide/))
- **Product Hunt's window is the first minute.** Top-3 products see
  5–15k visitors and 3–8 % conversion; traffic collapses by day three.
  Anything before value in the first 60 seconds costs conversion.
  ([PH traffic data 2026](https://hub.causo.ai/guides/product-hunt-traffic-data-2026))
- **Progressive disclosure wins.** Ask-later beats ask-upfront; a
  skip with equal visual weight beats a grey afterthought.
  ([Userpilot drop-off analysis](https://userpilot.medium.com/drop-off-analysis-how-to-find-friction-points-13b9f0bf520a))

**Risks it surfaced**

1. Discovery is passive-only (screens 3–4).
2. The "You" placeholder may never be renamed; an invite that goes out
   from "You" reads unfinished. No data either way on rename-later
   patterns — an evidence gap, not a finding.
3. The Assignee-field entry only fires for users who assign work to
   someone else at all.
4. No live A/B data on A vs. B for this audience — only precedent.

**What would raise it:** a one-time milestone nudge (B's active
mechanism) without touching first launch; signal the placeholder is
editable at the invite click; measure sidebar-link CTR after launch and
add an ambient hint if it's under ~2 %.

## 2. Lens 2 — solo → team growth (6.5/10)

**What the evidence says**

- **Footer blindness is real.** Display placements in sidebars, headers
  and footers get 0.05–0.46 % CTR; eye-tracking shows "near-total
  avoidance" of those regions during goal-directed use; footer rectangles
  become "perceptually inert". A's link sat in exactly that region.
  ([PubPower](https://pubpower.io/blog/overcome-banner-blindness/), [Neil Patel](https://neilpatel.com/blog/banner-blindness/), [UserGuiding](https://userguiding.com/blog/banner-blindness))
- **Contextual prompts at peak intent convert.** 60 %+ higher conversion
  when the prompt lands on a decision point — naming a teammate is one.
  A's Assignee entry is correctly timed; it just isn't universal.
  ([ContextSDK](https://contextsdk.com/blogposts/contextual-triggers-when-and-how-to-introduce-subscription-options-for-maximum-conversion), [RevenueCat](https://www.revenuecat.com/blog/growth/contextual-paywall-targeting/))
- **Behaviour-triggered beats passive.** "30 % higher conversion and 4.5×
  engagement" for behaviour-triggered onboarding over time-based; accounts
  whose primary user invited 3+ teammates in week one show 60 %+ 90-day
  retention. A has no milestone trigger.
  ([FounderOS](https://blog.founder-os.ai/behavior-triggers-in-app-onboarding), [Saber](https://www.saber.app/glossary/activation-milestone))
- **Each field costs.** 8–50 % per added field; HubSpot's four→three
  fields ≈ +50 %. A's invite modal asks two fields at the highest-intent
  moment.
  ([Omnisend](https://www.omnisend.com/blog/best-signup-forms-conversions/), [CXL](https://cxl.com/blog/14-steps-to-building-sign-up-forms-that-convert))
- **Loops that worked had both.** Slack's growth loop was contextual
  (naming teammates) *and* active (Slackbot nudging). Notion starts solo
  but surfaces team setup as a guided path. Raycast Teams is a top-level
  option, not a footer link.
  ([PLG Alliance](https://www.productledalliance.com/all-about-plg-conversion/), [Candu on Notion](https://www.candu.ai/blog/how-notion-crafts-a-personalized-onboarding-experience-6-lessons-to-guide-new-users), [Raycast Teams](https://www.raycast.com/teams))
- **Developer-tool PLG gates the ask behind milestones.** Best practice:
  at least two activation milestones before an expansion ask —
  "prompting people who've already seen value".
  ([daily.dev](https://business.daily.dev/resources/product-led-growth-marketing-for-developer-tools-free-tier-to-enterprise/), [ProductLed](https://productled.com/blog/10-experiments-that-actually-worked-for-our-plg-conversion-rates))

**Risks it surfaced**

1. *High:* sidebar-footer link won't be discovered by a material share of
   solo users. A user who never scrolls to the footer and never assigns
   to someone else has zero paths.
2. *Moderate-high:* the Assignee path depends on a behaviour not all solo
   users perform.
3. *Moderate:* two fields at the invite click, at peak intent.
4. *Moderate:* no milestone trigger — the "30 %" is an opportunity cost.

**What would raise it:** relocate the link out of the footer into the
primary sidebar or a Home card (→ ~7.5); add a one-time milestone nudge
(→ 7.5–8, i.e. A + B's active element); B wholesale (→ 8); C fully
instrumented across Assignee / @-mention / session-share (→ 8.5, highest
engineering cost, and it collapses back to C's discovery problem if only
partly built).

## 3. Lens 3 — local-first / privacy trust (7 hosted · 8.5 self-hosted)

**What the evidence says**

- **Opt-in hosting at the moment of need is a proven, trusted pattern.**
  Obsidian Sync/Publish (optional, E2E, publicly audited by Cure53 Oct
  2024 and Trail of Bits Dec 2025), Standard Notes (E2E by default,
  optional hosted sync, self-hostable), Atuin (optional sync, mandatory
  client-side encryption, self-hostable), Raycast Teams, Logseq — all
  accepted by this audience without lasting controversy.
  ([Obsidian audits](https://obsidian.md/blog/cure53-tob-sync-audits/), [Standard Notes self-host](https://standardnotes.com/help/47/can-i-self-host-standard-notes), [Atuin](https://atuin.sh/sync-shell-history/))
- **Mandatory friction without explanation is what triggers backlash** —
  Warp again, and the Zedless fork (Aug 2025, 40k+ stars) created over
  Zed's telemetry and AI-server integrations. The problem is never
  optional hosting; it's forced, unexplained hosting.
  ([Zedless on HN](https://news.ycombinator.com/item?id=44964916), [Warp issue #900](https://github.com/warpdotdev/Warp/issues/900))
- **Copy alone isn't proof.** HN consensus: contracts "cannot mechanically
  prevent wrongdoing"; this audience trusts what it can verify — open
  formats, client-side encryption, audits. Obsidian is trusted because
  "the notes are all Markdown files". Logseq's Markdown→SQLite move
  worried people for exactly this reason.
  ([HN local-first thread](https://news.ycombinator.com/item?id=44473135), [Logseq review](https://blog.saner.ai/logseq-review/))
- **Self-hosting is table stakes for a team product aimed here.** Plane
  (36k+ stars, Apache-2.0, ~$10–15/mo VPS for 30 users), Gitea, Coolify,
  Outline, Focalboard, Vikunja all lead with it; regulated industries
  evaluate on it. "Local for solo, lock-in for team" reads as
  bait-and-switch if self-hosting is never mentioned.
  ([Plane on self-hosted PM](https://plane.so/blog/self-hosted-project-management-jira-server-alternative))
- **AI agent data location is a deal-breaker if unstated.** Every major
  coding tool sends code to external servers; none lets consumers delete
  individual transcripts; the strongest demand is simply clarity — where
  does my code go, can I delete it, does it train. A's mockup said
  nothing about where agent transcripts live once a workspace is hosted.
  ([Graphite](https://graphite.com/guides/privacy-security-ai-coding-tools), [Arize](https://arize.com/blog/ai-coding-agent-privacy))
- **"You" is fine solo and weak for a team.** Two members who both typed
  "Amaan" are indistinguishable in an audit trail; Plane, Gitea and Linear
  all require identity in shared contexts because audit is table stakes.
- **A browser join page reads as "passed through the web"** unless the
  copy says it deep-links into the app and nothing is re-entered.

**Risks it surfaced**

*Critical for some segments:* agent-transcript location undisclosed; no
self-hosting mention; "You" identity for a shared workspace.
*Moderate:* browser join page without a deep-link sentence; no technical
proof of "stays local".

**Segment fit:** strong for solo privacy-conscious developers and small
teams willing to trust a hosted workspace; weak for regulated teams and
Jira-escapees who chose self-hosting — until self-hosting lands or is
clearly roadmapped.

**What would raise it:** one sentence on agent transcripts; one sentence
on self-hosting (roadmap or link to the compose file); an *optional*
email at invite "for the team's audit trail, never shown publicly"; a
short "how stays local works" article with file paths; the deep-link
sentence on the join page; the "Local · on this machine" badge on every
Personal screen; a one-line explainer on the invite link itself.

## 4. What changed in the mockup because of this

Applied to `onboarding/onboarding-option-a.html` (published as the
Option A artifact; the file in this directory is the same content).
Every change keeps the first-launch screen untouched — that was the
point of choosing A.

1. **The invite link left the footer** (lens 2, risk 1). It is now a
   primary sidebar item directly under Review — "Invite your team", with
   a one-line explainer under it ("shared workspace · hosted, self-hosting
   on the roadmap", lens 3). The footer keeps only the "Local · on this
   machine" badge, on every Personal screen (lens 3).
2. **A milestone nudge step, labelled as a post-launch fast-follow**
   (lenses 1 and 2). Shown once, tied to real usage, never removes the
   sidebar item. The trigger is deliberately left as "picked from launch
   data" — all three researchers said the same thing: you can't choose a
   good milestone before you have usage.
3. **The invite modal** (lenses 2 and 3):
   - the name field says plainly that the person has been "You" until
     now and that this is what teammates will see (lens 1's placeholder
     risk);
   - a third, *optional* email field "for the team's audit trail — never
     shown publicly" (lens 3), explicitly optional so it costs the
     privacy-first solo user nothing;
   - the note box now carries the agent-transcript line ("sessions on
     Personal tickets stay on this machine; the team workspace's sessions
     live with it"), the self-hosting line ("hosted on waypoint.sh today;
     self-hosting via the same Docker Compose is on the roadmap"), and a
     "How 'stays local' works" link (lens 3).
4. **The invite-ready and join screens** say the link deep-links into the
   installed app and that nothing is re-entered (lens 3).
5. **Captions** now cite the evidence in the mitigation text where it
   changed the design, so the mockup explains itself.

Not changed, deliberately: the number of fields is still two required
(name, team) — lens 2's suggestion to capture the name at launch is B,
not A, and was rejected for launch-day risk; the milestone trigger is
not chosen; hosting stays "waypoint.sh today, self-hosting roadmapped"
rather than committing to either, because that is the founder's call.

## 5. The decisions this leaves open

1. **Self-hosting: roadmap commitment or launch-day availability?** The
   single largest lever in any of the three reports (+1.5 on lens 3), and
   mostly a positioning decision — the compose file exists.
2. **What moves to the hosted workspace on invite?** All three mockups
   promise "stays local: everything already here; goes hosted: only the
   new workspace". The backend has to keep that promise on day one. Still
   open from both source docs.
3. **The milestone trigger** for the fast-follow nudge — ticket count,
   session count, days active — chosen from launch data, not guessed.
4. **Where agent transcripts go for a hosted team workspace, exactly.**
   The mockup now makes a claim ("live with the workspace"); the
   architecture has to be decided so the claim is true.
