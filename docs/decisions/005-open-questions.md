# 005 — Open questions, each with a default

**Status:** living list. Say "fine" to a default and it becomes a decision
(move it to the relevant numbered file). Everything not listed here is
either decided or explicitly a post-launch tuning item.

## Decide before building AT2

1. **Does first launch require sign-in?** (001 §3)
   Default: **No** — bundled local database, sign-in only at invite.
   This is the one that changes what gets built.

## Decide before AT6 (billing) — but not before

2. **Team Pro price: parity with Jira Standard ($8) or a fraction ($4–5)?**
   Default: $8, revisit at 90 days. (002 §4)
3. **Free seat cap: 10?** Default: 10, Jira precedent. (002 §1)
4. **History window: 30 days?** Default: 30, confirmed by founder. (002 §1)
5. **Sync add-on: $5/mo, in Settings?** Default: yes, confirmed. Placement
   (Settings vs. post-session prompt) to be A/B'd after launch.

## Decide before publishing the repo

6. **License: AGPL-3.0 + CLA + copyright registration?** Default: yes,
   pending legal review. (003)

## Product decisions carried from the architecture doc §9

7. **Does a Personal workspace's data become the Team's on invite, or
   does the Team always start empty?** Default: **always empty** — matches
   the mockup's "stays local / goes hosted" copy exactly and needs no
   migration tooling. (Architecture §9.1)
8. **Milestone-nudge trigger metric** (tickets closed? sessions? days?).
   Default: pick from launch data; mechanism ships now, metric later.
9. **Self-hosting copy at launch:** "available for Personal today; Team
   self-hosting follows AT2–AT4." Default: that scoped claim. (004 §4)

## Explicitly not decisions — tuning items after launch

- Exact seat/price/history numbers (002 §6).
- Sync card placement.
- Whether Personal optionally lives on the hosted backend as a
  single-member workspace (cost/ops call; default no).
