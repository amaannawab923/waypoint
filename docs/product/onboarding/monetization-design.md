# Waypoint monetization design — proposed defaults, mapped to the flow

One page, written to sit next to `onboarding-option-a.html` (the primary revised mockup),
`onboarding-option-b.html`, `onboarding-option-c.html`, and `onboarding-options.md`. Source
material: `docs/product/research-approach-a-quiet-invite.md` §6 (the Vibe Kanban re-rating) and
the six reports under `docs/product/research/approach-a/` in the waypoint-electron repo.

The founder's constraint: no onboarding flow may fail the app's monetization future. The
precedent that made it concrete: Vibe Kanban ran essentially Waypoint's flow — local-first, no
account, GitHub/Google sign-in only for a paid "Remote Projects" tier, self-hosting available —
and shut down in April 2026 because "the vast majority are free users and we couldn't find a
business model that we could get excited about." All three independent researchers agreed the
onboarding *shape* wasn't the problem (Zed, VS Code, Raycast, Warp, Obsidian run the same shape
and are alive); VK died on what its $30/seat paid tier *contained* — shared visibility of the
same solo data, nothing a team structurally needed, no limit that forced the upgrade.

Three decisions were explicitly left to the founder. This page proposes a default for each,
states the reasoning, and shows exactly where each one surfaces in the mockup.

---

## Decision 1 — Is solo free-forever-with-one-add-on, or free-forever full stop?

**Proposed default: free-forever, plus one paid add-on that requires real hosting or compute.**

**Reasoning.** A product where solo usage, at any depth, never has a revenue lever is Vibe
Kanban's core persona restated — "the vast majority are free users" wasn't a failure of that
persona's satisfaction, it was a business built with no way to monetize the persona it served
best. Every survivor in the precedent set (Obsidian, Zed, Raycast, Warp, Excalidraw) pairs a
fully free local core with exactly one paid thing that costs the vendor real infrastructure or
compute — never a cap on what already worked.

**What the add-on is:** cross-device session & ticket sync. A solo developer's local tickets and
agent-session transcripts, end-to-end encrypted, synced across their own machines. This
genuinely requires hosting (unlike, say, a feature flag), matches the precedent most directly
(Obsidian Sync, $4–5/mo), and is additive — nothing local changes, nothing is removed, if it's
skipped.

**What was rejected as a default:** a cap on free local agent-runtime hours. It appeared in one
researcher's draft list and was struck in the consolidation — it is the exact mistake Warp
(mandatory login, reversed Nov 2024 after backlash) and Insomnia made in different forms:
degrading something that used to work unconditionally. The founder's own frictionless-solo
requirement rules it out as a default; it's noted here only so it isn't silently reconsidered
later without this context.

**Where it surfaces in the flow:** `onboarding-option-a.html`, step 13, labelled **Proposal — not
onboarding, not necessarily launch scope**. A dismissible card on Home, shown only after real
usage, never during first launch or the invite flow. Caption: *"Working from another machine
too? Waypoint Sync backs up and syncs your local tickets & agent sessions, end-to-end encrypted.
$5/mo (placeholder). Nothing local changes if you skip this."*

**Placeholder to replace with data:** $5/mo (modeled on Obsidian Sync, not researched for
Waypoint specifically); whether Home is the right surface at all versus a session-detail prompt
(the research flagged both as candidates, with a slight lean toward post-session UI over a Home
banner — untested for this product).

---

## Decision 2 — What's in the free team workspace, and which limit triggers paid?

> **Superseded 2026-09-14 by [`docs/decisions/002-pricing-and-free-tier.md`](../../decisions/002-pricing-and-free-tier.md).**
> The cloud free tier is now *bounded* — free up to 10 people **and** 30 days
> of history, whichever first — not unlimited in members. Free-forever
> teams live in self-hosting, which already provides that at zero cost to
> us. The rule that survives unchanged: never charge at the first invite.
> The reasoning below is kept for the record.

**Proposed default: everything that makes Team mode worth choosing is free and unlimited in
members; the paid trigger is depth of Review/run history, not headcount.**

**Reasoning.** VK's tier failed a specific test: it charged for *visibility* of data a solo user
already had, not for anything a team structurally couldn't do alone. Waypoint's team workspace
clears that bar on its own — a shared Review queue of agent proposals, runs attributable across
people, a PM view over everyone's sessions, and Jira sync for the whole team are all things solo
mode has no concept of. Those stay free and unlimited, so the invite click never has to weigh a
price against the value it's creating.

A member-count cap (e.g., "free up to 3 members, pay for a 4th") was seriously considered — it's
a common, easy-to-explain freemium pattern — and rejected as the default. The reason is specific
to VK's failure mode, not a general dislike of caps: charging exactly when the invite a user just
sent starts paying off (a fourth teammate joining) repeats gate-at-invite in a new shape. A
history-depth limit instead follows the pattern that demonstrably converts in the cited vendor
data — Slack's 90-day message history, Linear's 250 free issues — both hit only through *sustained
use*, well after a team has already decided the product is worth the invite.

**The mechanism, concretely:** Review-queue and agent-run history stays searchable for a rolling
30 days on the free plan (placeholder). Older runs still happened — nothing is deleted or hidden
from where they occurred — they simply drop out of the searchable Review history and audit-trail
export until the workspace upgrades.

**Paid tiers, both placeholders:**
- **Team Pro, $8/seat/mo** — unlimited Review & run history, audit-trail export, roles beyond
  admin/member.
- **Team Commercial, $24/seat/mo** — SSO, SCIM, compliance certifications, self-hosted deployment
  support.

**Where it surfaces in the flow:** `onboarding-option-a.html`, step 6 and step 8 (the invite-click
and account-creation modals) state the free tier's contents explicitly, with no price anywhere
near them — deliberately, since naming a price at the invite click is the single clearest
repeat of VK's mistake available in this flow. The upgrade itself surfaces in step 12, labelled
**Monetization bet**, showing a Review queue weeks into real team use with a locked-history
banner and the two-tier pricing card, inline in the product rather than a blocking modal.

**Placeholders to replace with data:** the 30-day window, and both seat prices. None of the three
researchers had Waypoint-specific usage data to size these from — they're modeled on the cited
precedents' shape (Slack/Linear for the limit type; Plane's $6–10 and $13–30 seat bands for the
two tiers), not measured for this product.

---

## Decision 3 — Is governance the paid line with self-hosting free, or is hosting the product?

**Proposed default: governance is the paid line (Plane's model); self-hosting is free and stated
as available today.**

**Reasoning.** All three researchers independently named this the single highest-leverage change
available — one researcher's standalone trust-lens rating moved 1.5 points on this alone. Two
things drove it. First, Waypoint's own docker-compose self-hosting path already exists in the
codebase; describing it as "on the roadmap" when the infrastructure is already there tested badly
in the research — "roadmap" reads to this audience as "a free alternative is coming, so defer
paying," which actively discourages the *hosted* revenue this proposal depends on. Second, the
buyers of governance (audit trail, roles beyond admin/member, SSO, compliance certifications) are
teams with real compliance requirements; they pay for governance regardless of where the data
physically sits, which is exactly Plane's proven model (self-hosted Community edition free,
Pro/Commercial priced on SSO/audit/compliance) and exactly the opposite of treating hosting itself
as the product, which is closer to what made VK's paid tier feel arbitrary.

**Where it surfaces in the flow:** `onboarding-option-a.html`, step 6's note box: *"Self-hosting is
available today for compliance and data-residency needs, same Docker Compose"* (previously "on
the roadmap" in the prior revision). The same reframe is applied identically in the lighter
touch-ups to `onboarding-option-b.html` and `onboarding-option-c.html`'s invite-click modals.

**Placeholder to replace with data:** none directly in the mockup — this is a positioning
decision, not a numeric one — but it does depend on a real product commitment: self-hosting
being genuinely usable at launch (the compose file exists; whether it's polished enough to point
a Product Hunt visitor at is a separate, non-monetization engineering question worth confirming
before this copy ships as written).

---

## What to instrument at launch, to replace every placeholder above with data

1. **Review/run-history usage curve per team workspace** — how many days of history active teams
   actually reference, to size the free-tier window correctly instead of guessing 30.
2. **Seat-price sensitivity** — no proxy for this exists pre-launch; the fastest real signal is
   showing the step-12 pricing card to early free teams that hit the limit and watching the
   conversion rate at the placeholder prices before adjusting them.
3. **Solo add-on interest** — dismiss-vs-click rate on the step-13 Sync card, and whether it
   should live on Home at all versus the alternative the research flagged (a post-session prompt)
   — this can be tested with either placement live and compared directly.
4. **Self-hosting adoption** — how many workspaces actually use the compose path once it's
   described as available rather than roadmapped; this validates (or corrects) Decision 3's
   premise that the audience segment choosing self-hosting is real and worth the "available
   today" claim being literally true.
5. **The milestone-nudge trigger** (carried over from the pre-monetization research, still open) —
   ticket count, session count, or days active — chosen from real usage data, not guessed; this
   is a discovery-mechanism decision, not a monetization one, but it shares the same "don't guess
   before you have data" discipline as everything above.

---

## How this differs from what Vibe Kanban did

| | Vibe Kanban | Waypoint (proposed) |
|---|---|---|
| **What triggered a price** | The invite/sign-in click itself — $30/seat the moment a second person could see the board. | Nothing at the invite click. The click creates a free workspace; price appears only after weeks of real use, at a history-depth limit. |
| **What the paid tier contained** | Visibility of the same solo kanban data to other people — no capability a team needed that solo lacked. | A shared Review queue, cross-person run attribution, team-wide Jira sync, and PM oversight — all free; the *paid* line is unlimited history depth plus governance (audit, roles, SSO), none of which solo has any use for either. |
| **Solo monetization** | None — "the vast majority are free users," with no paid path for them at all. | One explicit optional add-on (cross-device sync) that costs real hosting, proposed as a fast-follow, never a cap on local usage. |
| **Self-hosting framing** | Available, but the paid cloud tier's value proposition (shared visibility) was fully replicable by the free self-hosted path, so self-hosting undercut the paid tier directly. | Self-hosting is free and stated as available — but the paid line (governance: audit trail, roles, SSO, compliance) is not something self-hosting alone replicates, so the two don't compete for the same buyer. |
