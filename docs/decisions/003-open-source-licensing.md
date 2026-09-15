# 003 — Open-source licensing: AGPL-3.0

**Status:** recommendation. This is a plain-language explanation of how the
license works, not legal advice. **Get a real IP lawyer to review before
the repo is published under any license** — the choice has enforceable
consequences for the business and is hard to walk back.

## 1. Recommendation

License the public repo under **AGPL-3.0**, and keep the copyright
ownership clean so **dual licensing** stays available to us (§4).

## 2. What AGPL does — and the misconception to kill

**It does not stop anyone from building a commercial product on our code.**
Anyone may take it, modify it, host it, charge for it. The license grants
no exclusivity to us.

**What it forces is that they stay open too.** If someone runs a modified
version as a service for other people over a network, they must give
those users the modified source. It is "you can't compete *quietly*," not
"you can't compete."

**"Strict copyleft"** means the sharing obligation spreads to the whole
combined product — a proprietary feature bolted onto our core, shipped as
one product, must be shared too. Weaker licenses (LGPL, MPL) only cover
our specific files. AGPL adds the network trigger on top of that. It is
the strictest mainstream open-source license.

**Internal use does not trigger it.** A company running Waypoint purely
for its own employees is not "offering it to users over a network" in the
sense that triggers source-sharing. So yes: a team can self-host, remove
any limit they like, and never owe us anything. This is legal and normal.

## 3. What it does to competition, honestly

Lowers the odds of:
- **A large company free-riding** — hosting our code as a competing paid
  service. They'd have to publish every improvement, which removes their
  edge. This is literally what AGPL was written to prevent.
- **Casual copycats** — "grab it, add a paywall, resell" collapses when
  the paywall has to be open-sourced too.
- Cutting corners — AGPL has been enforced in court; there is real risk.

Does nothing about:
- A well-funded competitor who complies properly and builds something
  better. It slows them, it doesn't stop them.
- Someone hosting our *unmodified* code and undercutting us on price. Fully
  legal. That risk is handled by brand, being the official source, support
  and product quality — not by licensing.

## 4. The lever that actually gives exclusivity: dual licensing

Because we own the copyright, we — and only we — can sell a separate
private commercial license to companies that want out of AGPL's
share-back obligation (embedding into closed products, enterprises that
won't comply). Nobody else can offer that deal.

**Precondition:** we must own or hold rights to every line. Outside
contributors keep copyright on their contributions by default, which
would (a) fragment enforcement and (b) block dual licensing. **Require a
Contributor License Agreement (CLA)** from the first external PR onward.

## 5. Self-hosting and paid features — don't booby-trap the code

Do **not** hide license checks in the open-source code to stop
self-hosters from getting the full team product. Anyone can delete the
check in five minutes; it protects nothing and reads as fake open source
(the Elastic/HashiCorp backlash pattern). Be genuinely generous on
self-hosting and let "we run the servers for you" do the convincing.

What *can* stay paid even self-hosted, the Plane way: governance —
SSO, SCIM, audit export, compliance certifications — unlocked by a license
key in a clearly separate, non-core module. Self-hosters get the full
collaborative core; the enterprise-compliance layer is ours to sell,
hosted or not.

Some companies decided AGPL wasn't tight enough and wrote custom
"source-available" licenses (MongoDB's SSPL, BSL variants). That is a
heavier move, generally no longer called open source, and not recommended
unless AGPL fails to solve a problem we actually hit.

## 6. If we catch a violation

- It is **copyright infringement**, not a contract dispute — the only
  permission to use the code came from the license, and it is void when
  the terms are broken. Stronger legal footing than most business disputes.
- **AGPL-3.0 has a built-in cure period.** On first notice the violator
  gets **30 days** to comply; if they do, their rights are automatically
  restored. The license is designed to give people a chance to fix it,
  not as a gotcha.
- **In practice** nearly every case ends there: a quiet letter, they
  publish source or take it down. Court is the rare last resort.
- If it escalates: injunction (stop until compliant), damages (our loss or
  their profits, whichever is larger), and — **only if the copyright was
  registered with the U.S. Copyright Office beforehand** — statutory
  damages and possible attorney's fees. **Register copyright on key
  releases.** It is cheap and it is the difference between real teeth
  and having to prove financial harm.
- Precedent exists (BusyBox maintainers vs. multiple device makers;
  SFC vs. Cisco/Linksys). Not theoretical.
- The first notice should be sent by a lawyer, not by us; its wording
  matters for keeping the position clean.

## 7. What the public repo must and must not contain

- **Must:** the desktop app, the team backend, docker-compose for
  self-hosting. Fully real, not a watered-down "community" cut.
- **Separate:** billing (Stripe, seat counting, plan enforcement) and the
  governance unlock, so a self-hoster is never accidentally charged and
  the hosted paywall isn't a three-line delete.
- **Never:** hosted secrets, the accounts-broker deployment config, signing
  keys. Same rule as today's env-scrub discipline.
