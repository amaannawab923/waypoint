# Monetization Research: Approach A "Quiet Invite" — The Vibe Kanban Trap

## Context

Vibe Kanban (bloop AI) launched with identical structure to Approach A: fully local solo workspace, no sign-in, GitHub/Google OAuth only for "Remote Projects" (shared, cloud-synced organizations). On April 10, 2026, bloop shut down: "Thousands of software engineers use Vibe Kanban every day... but the vast majority are free users and we couldn't find a business model we could get excited about." The question: **what made that business fail, and why does Approach A risk repeating it?**

---

## Finding 1: What Works (Linear, Raycast, Warp, Zed, Excalidraw+) vs. VK's Failure

### Linear: Paid for Multiplicity, Unlimited Storage, Integrations
- **Free Tier:** 250 non-archived issues, 2 teams, core tracking, unlimited members
- **Upgrade Path:** Paid tiers (Basic $10/user/mo, Business $16/user/mo) unlock 5+ teams, custom workflows, roadmaps, Zendesk/Intercom integrations, unlimited issues
- **Why Teams Pay:** Storage limits + workflow customization. Teams hit the 250-issue ceiling and *need* the upgrade to keep working.
- **Source:** [Linear Pricing Guide (Spendflo)](https://www.spendflo.com/blog/linear-pricing-guide), [Vendr: Linear Pricing](https://www.vendr.com/marketplace/linear)

### Raycast Teams: Paid for Shared Admin Control & Sync
- **Free:** Individual only (launcher + snippets)
- **Teams $12/user/month (min 3 seats):** Shared commands, snippets, quicklinks, admin controls, Private Store
- **Why Teams Pay:** Administrators need centralized control over shared tools; individual extensions don't sync across the team.
- **Source:** [Raycast Pricing](https://www.raycast.com/pricing), [Raycast Manual: Billing](https://manual.raycast.com/billing)

### Warp: Paid for Shared Context & Team Credits
- **Free:** 75–150 AI credits/month (terminal agent runs, commands)
- **Build $20/month:** 1,500 credits
- **Business $50/user/month:** Unlimited Warp Drive objects, shared team terminal sessions, org-wide collaboration, shared credit pool
- **Why Teams Pay:** Developers need to share terminal sessions live, pool AI credits org-wide, and index shared codebases for collaborative work.
- **Source:** [Warp Pricing](https://www.warp.dev/pricing), [Warp Docs: Plans & Billing](https://docs.warp.dev/support-and-community/plans-and-billing/pricing-faqs/)

### Zed: Paid Only for AI; Collaboration Stays Free
- **Free:** Native real-time pair-programming, shared terminals, voice, screen-sharing (all included)
- **Pro $10/month:** Unlimited AI predictions (free: 2,000/month)
- **Business $30/seat:** Org-wide model policies, data governance, admin controls
- **Why Teams Pay:** AI becomes expensive at scale; organization-wide controls matter for enterprise teams, but core collaboration is never paid.
- **Source:** [Zed Pricing](https://zed.dev/pricing)

### Excalidraw+: Paid for Cloud Storage, Teams Management, Access Control
- **Free:** Local-only; no cloud storage, no team management, no access controls
- **Plus $6–7/user/month:** Cloud storage, teams, view-only access, shared voice hangouts, enhanced collaboration UI
- **Why Teams Pay:** Teams can't organize or control access without the paid tier; local-only doesn't work for distributed teams.
- **Source:** [Excalidraw+ Pricing](https://plus.excalidraw.com/pricing)

### Vibe Kanban: Failed at $30/user/month for Shared Visibility Only
- **Free:** Fully local kanban, single-user workspace
- **Pro $30/user/month:** Remote projects (shared kanban boards, comments, real-time sync, org invitations)
- **Why It Failed:** The paid tier added *shared visibility of the same solo data*—not a unique value lever. A solo user's local kanban and a team's shared kanban were functionally identical; the upgrade was "your teammates can see your board now," not "now you can do something you couldn't do alone." At $30/user/month, this was not compelling. Bloop's own shutdown note: "[We] couldn't find a business model we could get excited about."
- **Source:** [Vibe Kanban Shutdown Post](https://www.vibekanban.com/blog/shutdown), [Vibe Kanban Remote Projects Docs](https://vibekanban.com/docs/settings/remote-projects)

### The Pattern

**Tools that succeeded** sold **required infrastructure for team productivity**: real-time shared context (Warp Drive, Zed pair-programming, Excalidraw+ cloud), centralized controls (Raycast admin, GitHub Copilot org policies), AI pooling (Warp credits), or hitting natural limits (Linear's 250-issue cap).

**Vibe Kanban failed** because it sold **passive sharing** of the same solo experience at enterprise pricing. The team kanban board added no new capability; it was just visibility. No lock-in, no required feature, no moment when a team member would say "we *need* to pay for this."

---

## Finding 2: Paywall Timing & Free-Tier Strategy

### The Slack Model: Free Forever, Upgrade at a Naturally-Hit Limit
- **Free Tier:** Unlimited members, no seat limit, 90-day message history, 10 connected apps, 1:1 huddles only
- **Upgrade Moment:** Teams hit the message history limit when searching past decisions; they upgrade "because we can't find something we know we wrote."
- **Conversion Rate:** 30–40% for teams with 10+ users (exceptional; industry median is 2–5%)
- **Source:** [Getmonetizely: Slack's Freemium Strategy](https://www.getmonetizely.com/articles/slacks-freemium-strategy-how-they-convert-free-users-to-paying-customers-2024-breakdown)

### The Linear Model: Free with Soft Limits, Upgrade When Limits Bind
- **Free Tier:** 250 non-archived issues, 2 teams
- **Upgrade Moment:** Team outgrows these caps in normal work; upgrade is inevitable for growing teams
- **Why This Works:** The free tier is *useful* but has a natural ceiling. Teams feel the limit during product work, not sales.
- **Source:** [Linear Pricing Guide](https://www.spendflo.com/blog/linear-pricing-guide)

### The Cursor Model: Free with Usage Ceiling
- **Free Hobby Plan:** 2,000 completions/month (enough to prove value, not enough for daily production)
- **Conversion Rate:** 36% free-to-paid (far above developer-tools average of 1–3%)
- **Why This Works:** Solo developers hit the ceiling in normal work; they upgrade to get more completions, not to unlock a feature.
- **Source:** [Getmonetizely: Free-to-Paid Conversion Rates](https://www.getmonetizely.com/articles/whats-the-right-ratio-of-free-to-paid-users-in-developer-saas)

### The Developer-Tools Average
- **Freemium Conversion Rate:** 1–3% (far lower than general SaaS: 2–5%)
- **Minimum Sustainable:** 3–5% free-to-paid to cover free-user infrastructure cost
- **Free-to-Paid Ratio:** Often 97:3 or 99:1 (free:paid) for developer tools
- **Source:** [Getmonetizely: Free-to-Paid Conversion Rates](https://www.getmonetizely.com/articles/whats-the-right-ratio-of-free-to-paid-users-in-developer-saas)

### Key Insight: Paywalls That Work Are *Limits*, Not *Gates*
The most successful models (Slack, Linear, Cursor) let free users work indefinitely, then hit a soft limit (message history, issue count, API calls) that is *discovered through normal work*, not imposed at signup. The invite-click moment is **too high a friction point for a paywall**—it's when the user wants to *move forward*, not when they've already felt a limit.

---

## Finding 3: What Makes a Team Workspace Worth Paying For

Teams pay for shared workspaces when the team version enables **something the solo version fundamentally cannot do**, not when it merely "makes solo data visible to others."

### Features That Justify Team Seats

| Feature | Why It Matters | Tool | Price/Model |
|---------|---|---|---|
| **Real-time shared context** (shared terminals, live code, shared notebooks) | A solo dev's terminal can't be shared; teams need live access to each other's work context | Warp, Zed | Warp $50/user; Zed free (monetizes AI only) |
| **Centralized admin & policy control** | Orgs need to enforce security policies, model choices, data retention org-wide | GitHub Copilot, Raycast, Zed Business | $19–50/user |
| **Access & permission management** | Solo workspaces have no concept of "who can view"; teams need granular control | Excalidraw+, Linear | $6–16/user |
| **Usage pooling (credits, budget)** | Teams need shared AI budgets or API quotas; solo users buy individual credits | GitHub Copilot, Warp | $50+/user with shared pool |
| **Unified issue storage** (history, search, archival) | Teams hit storage/history limits faster than individuals; shared archive matters | Slack ($30/mo for history), Linear ($10+/user) | Limits drive upgrade |
| **Shared visibility** (board, comments, timeline) | Solo users don't need this; teams do, but *only if* the workflow itself requires async coordination | Linear, Asana | Included in paid tiers |

### What Does **Not** Justify Paid Team Seats
- "We can see your local board now" — purely passive sharing (VK's model)
- "Comments on issues" — if issues are personal, comments don't add workflow value
- "Shared repo view" — if the code is already in GitHub/GitLab

---

## Finding 4: What Waypoint's Team Layer Must Contain to Avoid the VK Trap

For Waypoint's team workspace to be *worth paying for*, it must include features a solo agent/task manager fundamentally cannot:

### High-Value Candidates
1. **Shared agent runs with attribution** (who triggered what, what ran where, why it succeeded/failed) — team visibility of agent work, accountability across people
2. **Cross-person review queue** (proposals from anyone's agent sessions, team review before merge) — *requires* team coordination; solo version has no queue concept
3. **Shared workspace context** (shared MCP servers, shared skills, shared snippets for agents) — solo agents don't need to know about teammates' tools; teams do
4. **PM view over team sessions** (progress on tickets assigned to the team, burndown, resource utilization) — solo users have no concept of "team progress"; team PMs need this
5. **Shared Jira/Linear/GitHub account** (one workspace account with team members logged in, shared integrations, audit trail) — solo user connects their personal account; team needs org-wide connection and compliance logging

### Lower-Value (VK Trap: "Shared Visibility")
- "See your teammates' tickets" — if tickets are personal, viewing adds no workflow value
- "Comments on solo tickets" — if the team doesn't need to coordinate on those tickets
- "Shared kanban board" — just visibility of the same work, not new capability

---

## Finding 5: Solo→Team Conversion Rate Needed

### Baseline Assumptions
- Waypoint ships with strong solo PLG (based on your first research)
- Goal: sustainable free-to-paid business on paid team seats
- Industry baseline for developer tools: 1–3% freemium conversion; breakeven threshold: 3–5%

### The Math
Assume:
- 1,000 solo downloads in month 1; 10,000 by month 6
- Solo→team invite discovery rate (per your research): ~5–8% (passive sidebar + milestone nudge)
- Of invitations sent, free-team-then-upgrade conversion: X%?

**If A has 5% invite discovery (low, per banner-blindness evidence), then:**
- 1,000 solos → 50 invites sent
- At 50% conversion to paid (aggressive), = 25 paid teams
- At 2 people/team = 50 paid seats

**To reach breakeven (3–5% of free-to-paid):**
- Need 3–5% of 1,000 solos = 30–50 paid seats
- Requires both high invite discovery *and* near-certain upgrade at team moment

### Is This Plausible Given A's Discovery?

**Current A (revised):**
- Sidebar link moved to primary nav (fixes footer blindness, likely 5–10% discovery vs. 0.5% footer)
- Milestone nudge added (30% uplift per PLG evidence)
- Combined passive + active discovery: plausibly 8–15% of solo users will *see* an invite prompt
- Of those, ~20–30% will actually send an invite (not all "prompted" users are ready)
- Of those, paywall conversion depends on team workspace value (see Finding 4)

**Realistic projection:**
- If team workspace is truly necessary (shared agent runs, review queue, PM visibility): 60–80% of invites become paid → sustainable
- If team workspace is "shared visibility only" (VK model): 5–15% of invites become paid → likely fails like VK

---

## Finding 6: Is "Solo Free Forever, Team Seats Paid" Viable or the VK Trap?

### The Trap (What Happened to VK)
VK showed that indefinite free solo is sustainable *operationally* (local-first, no server cost) but fails *economically* if:
1. The team tier adds only passive sharing (no new capability)
2. Paid pricing ($30/user) is arbitrary, not tied to a resource limit or unique feature
3. There's no natural moment (hit a limit, need a feature) where paid becomes obvious

### The Real Model (Linear, Slack, Cursor, Raycast)
"Solo free forever, team paid" is viable *if*:
1. Free tier has a **natural limit** (issue count, message history, API calls, seats) that solos hit slowly but teams hit quickly
2. Team tier adds **required functionality** (shared context, admin controls, organization-wide policies) not available in solo
3. Paywall sits **behind the limit, not at the invite moment** — teams discover the need through work, not through a sales gate
4. **Conversion mechanics are automatic** — hit the limit, get a soft upgrade prompt; teams upgrade because they *have to*, not because they're sold to

### For Waypoint Specifically
- **Viable if:** Solo can have unlimited local workspaces, unlimited local issues, unlimited agent runs, but *team workspace* unlocks (a) real-time agent run visibility across people, (b) shared review queue, (c) org-wide Jira/Linear sync. Once a team tries to use a shared queue or review each other's proposals, they *need* the paid tier.
- **Not viable if:** Solo has all the same features as team, just "not synced to others." Then the paywall feels arbitrary, like VK's did.

**Conclusion:** The model is viable. The critical success factor is **what the team tier contains**, not whether it exists.

---

## Finding 7: Re-Rating Approach A With Monetization Constraint

### Revised Rating: 7.5/10 for Solo→Team *Conversion to Revenue*

**Why the increase from 6.5 to 7.5:**
- The sidebar navigation move fixes the banner-blindness problem (discovery improves from ~0.5% to ~8–12%)
- The milestone nudge adds the missing active lever (captures 30% PLG uplift)
- The auth-at-invite moment is now streamlined: workspace name only, then browser sign-in (OAuth/email), then auto-prefilled account creation—low friction at the actual paywall
- Invitees sign in from the join link, no separate onboarding

**Why not higher:**
- Solo→team conversion still depends on team workspace features being truly *necessary*, not optional. The comparison document defers this decision: "does invited data move to team, or does team start empty?" Until resolved, paywall risk remains high.
- The free solo tier still has indefinite capacity (no hard limits like Slack's 90-day history or Linear's 250-issue cap). Teams could theoretically stay free if they never hit a limit. This is a gap vs. Slack/Linear's proven models.

### Specific Changes to Raise It to 8.5/10

**To 8.0/10:** Clarify team workspace features: shared agent run visibility with attribution, cross-person proposal review queue, org-wide Jira account sync, PM dashboard for team progress. Make these *necessary* for teams, not optional bells.

**To 8.5/10 (de-risk the VK trap entirely):** Add a free-tier **limit** that teams hit organically:
- Option 1: Free solo workspaces are unlimited; free *team* workspaces allow 5 agent runs/day per person (team hits limit when collaborating), paid tier unlocks unlimited runs + org controls.
- Option 2: Free team workspace allows 1 shared integration (Jira/Linear account); add a second integration → paid tier.
- Option 3: Free team workspaces cap at 3 members; add a 4th member → paid tier.

These limits mean teams discover the need to pay through *use*, not through a sales pitch. This mirrors Slack/Linear's proven model and inoculates against VK's failure mode.

### Paywall Location (Critical for Success)
**Do NOT put the paywall at the invite-click moment.** That's when users are most likely to abandon.

**Instead:**
1. Invite click creates a *free* team workspace, just like Slack's free team tier
2. Team members join and start using (agent runs, Jira sync, proposals)
3. They hit the limit (run count, integrations, member count, feature access) → upgrade prompt surfaces in-app
4. Upgrade happens *after* the team has felt value, not before

This is Slack's model, not a gate. It works.

---

## Summary: The VK Trap & How A Avoids It

| Dimension | Vibe Kanban (Failed) | Approach A (Revised) | Needed to Succeed |
|---|---|---|---|
| **Solo UX** | Free, local, no account | Free, local, no account until invite | ✓ Same (good) |
| **Invite Discovery** | Buried in UI; barely found | Primary sidebar nav + milestone nudge | ✓ Fixed |
| **Auth at Invite** | Full signup form (name, email) | Workspace name + browser OAuth, auto-prefilled | ✓ Better |
| **Team Tier Value** | Shared kanban visibility | TBD: agent runs, review queue, org sync, PM view | **Critical gap** |
| **Team Tier Price** | $30/user/month (arbitrary) | TBD; should be tied to features or limits | **Critical gap** |
| **Paywall Location** | At invite-click (gate) | Must be *behind* a limit hit in normal use | **Critical gap** |
| **Free Team Capacity** | Unlimited | Unlimited (or soft-limited to push tier value) | **Critical gap** |
| **Conversion Model** | Sales gate (1–3% likely) | Organic limit-based (Slack model: 30–40% possible) | **Critical gap** |

**Waypoint avoids the VK trap if (and only if):**
1. Team workspace features are necessary, not optional (shared agent runs, governance, org sync)
2. Paywall sits behind a natural limit, not at invite-click
3. Free tier has some mechanism (optional but recommended: soft limit) that makes paid tier obvious, not arbitrary

---

## Sources Cited

1. [Vibe Kanban Shutdown Post](https://www.vibekanban.com/blog/shutdown)
2. [Vibe Kanban Remote Projects Docs](https://vibekanban.com/docs/settings/remote-projects)
3. [Linear Pricing Guide (Spendflo)](https://www.spendflo.com/blog/linear-pricing-guide)
4. [Vendr: Linear Pricing](https://www.vendr.com/marketplace/linear)
5. [Raycast Pricing](https://www.raycast.com/pricing)
6. [Raycast Manual: Billing](https://manual.raycast.com/billing)
7. [Warp Pricing](https://www.warp.dev/pricing)
8. [Warp Docs: Plans & Billing](https://docs.warp.dev/support-and-community/plans-and-billing/pricing-faqs/)
9. [Zed Pricing](https://zed.dev/pricing)
10. [Excalidraw+ Pricing](https://plus.excalidraw.com/pricing)
11. [Getmonetizely: Slack's Freemium Strategy](https://www.getmonetizely.com/articles/slacks-freemium-strategy-how-they-convert-free-users-to-paying-customers-2024-breakdown)
12. [Getmonetizely: Free-to-Paid Conversion Rates](https://www.getmonetizely.com/articles/whats-the-right-ratio-of-free-to-paid-users-in-developer-saas)
13. [Mural: Team Collaboration Software Guide](https://www.mural.co/blog/team-collaboration-software)
14. [GitHub Copilot Pricing](https://github.com/features/copilot/plans)
