import { buildRunComment, describeWork } from './runComment';
import { parseReport } from './report';

const REPORT = `Verdict: fixed
## Summary
The retry re-sent the charge because the idempotency key was minted per attempt.
Keyed it on the order id; the second attempt now returns the first result.
## Details
src/checkout/retry.ts:41 minted the key inside the loop.
Verified with the checkout integration tests (3 new cases).`;

const FOOTER = (runLabel: string) =>
  `*Full report — the evidence, files and how it was verified — is on the run in Waypoint (${runLabel}).*`;

// Customer-feedback round 1, Fix 4: the ticket's readers asked for a
// comment a PM can read — the Summary, the PR, where the rest lives.
// No verdict tag, no branch or commit counts, no file paths, no "not
// pushed" — never the Details.
describe('buildRunComment', () => {
  it('a Fix: the Summary, the PR, and the footer — nothing engineer-shaped', () => {
    const body = buildRunComment({
      report: parseReport(REPORT),
      runLabel: 'ENG-77 · Fix',
      published: {
        kind: 'opened',
        url: 'https://github.com/o/r/pull/9',
        pushed: true,
      },
      verdict: 'fixed',
      plan: 'review',
    });
    expect(body).toBe(
      [
        'The retry re-sent the charge because the idempotency key was minted per attempt.\nKeyed it on the order id; the second attempt now returns the first result.',
        'Pull request: https://github.com/o/r/pull/9',
        FOOTER('ENG-77 · Fix'),
      ].join('\n\n'),
    );
    expect(body).not.toContain('retry.ts:41');
    expect(body).not.toContain('## Summary');
    expect(body).not.toContain('Verdict');
    expect(body).not.toContain('Branch');
  });

  it('an Investigate: the Summary and the footer alone', () => {
    const body = buildRunComment({
      report: parseReport(
        'Verdict: not-a-bug\n## Summary\nThe 500 is the upstream timeout, by design.\n## Details\nx',
      ),
      runLabel: 'ENG-77 · Investigate',
      published: null,
      verdict: 'not-a-bug',
      plan: 'close',
    });
    expect(body).toBe(
      [
        'The 500 is the upstream timeout, by design.',
        FOOTER('ENG-77 · Investigate'),
      ].join('\n\n'),
    );
  });

  // S4 (PR #88 review): before this, a failed push read exactly like a
  // successful one to the ticket — no line at all — so a Fix that could
  // not push filed a comment that looked like finished work, paired with
  // a state change to review. The REASON is still the run's business,
  // not the ticket's (Fix 4's own deviation): the message it carries
  // ("could not read Username") must never appear on the ticket, only
  // the honest fact that there is no PR yet.
  it("a failed publish gets one honest line — no PR yet — but never the reason, which stays the run's business", () => {
    const body = buildRunComment({
      report: parseReport('Fixed it.'),
      runLabel: 'ROAD-1 · Fix',
      published: {
        kind: 'failed',
        stage: 'push',
        message: 'could not read Username',
      },
      verdict: 'fixed',
      plan: 'review',
    });
    expect(body).toBe(
      [
        'Fixed it.',
        'No pull request yet — the branch was not published; the details are on the run in Waypoint.',
        FOOTER('ROAD-1 · Fix'),
      ].join('\n\n'),
    );
    expect(body).not.toContain('Username');
    expect(body).not.toContain('push');
  });

  it('pushed-only (the branch went up, gh pr create did not) gets the same honest line, without its own reason', () => {
    const body = buildRunComment({
      report: parseReport('Verdict: fixed\n## Summary\nDone.'),
      runLabel: 'r',
      published: { kind: 'pushed-only', reason: 'no gh on PATH' },
      verdict: 'fixed',
      plan: 'review',
    });
    expect(body).toBe(
      [
        'Done.',
        'No pull request yet — the branch was not published; the details are on the run in Waypoint.',
        FOOTER('r'),
      ].join('\n\n'),
    );
    expect(body).not.toContain('no gh on PATH');
  });

  it('skipped (a closing verdict, or nothing to publish) has no PR line at all — not a broken push', () => {
    const body = buildRunComment({
      report: parseReport('Verdict: fixed\n## Summary\nDone.'),
      runLabel: 'r',
      published: { kind: 'skipped', reason: 'nothing to publish' },
      verdict: 'fixed',
      plan: 'review',
    });
    expect(body).toBe(['Done.', FOOTER('r')].join('\n\n'));
  });

  // Found in review, round 3: publishLine's switch had no case for
  // 'updated' — a follow-up that pushed new commits to an already-open
  // PR — so the filed comment (what a person reviews on the board)
  // silently said nothing about the PR at all.
  it('a follow-up that updates an already-open PR says so in the comment', () => {
    const body = buildRunComment({
      report: parseReport('Verdict: fixed\n## Summary\nAlso handled DST.'),
      runLabel: 'ROAD-1 · Fix',
      published: {
        kind: 'updated',
        url: 'https://github.com/o/r/pull/9',
        pushed: true,
      },
      verdict: 'fixed',
      plan: 'review',
    });
    expect(body).toContain(
      'Pull request updated: https://github.com/o/r/pull/9',
    );
  });

  it('a Verification section rides on the comment after the summary, bounded', () => {
    const body = buildRunComment({
      report: parseReport(
        'Verdict: fixed\n## Summary\nDone.\n## Verification\nDrove the form; 01-after.png shows the fix.\n## Details\nx',
      ),
      runLabel: 'r',
      published: null,
      verdict: 'fixed',
      plan: 'review',
    });
    expect(body).toContain(
      'Done.\n\n**Verification**\nDrove the form; 01-after.png shows the fix.',
    );
    const long = buildRunComment({
      report: {
        verdict: 'fixed',
        hasSummaryHeading: true,
        summary: 's',
        verification: 'v'.repeat(5000),
        details: null,
      },
      runLabel: 'r',
      published: null,
      verdict: 'fixed',
      plan: 'review',
    });
    expect(long).toContain(`${'v'.repeat(1999)}…`);
    expect(long).not.toContain('v'.repeat(2001));
  });

  it('no summary: the footer alone', () => {
    const body = buildRunComment({
      report: {
        verdict: null,
        hasSummaryHeading: false,
        summary: '',
        verification: null,
        details: null,
      },
      runLabel: 'r',
      published: null,
      verdict: null,
      plan: null,
    });
    expect(body).toBe(FOOTER('r'));
  });

  // S5 (PR #88 review): statePlanFor returns null for root-cause and
  // needs-info on every intent, and for a custom-intent run's verdict
  // regardless — "the paired state change says it" (this module's own
  // header comment) was never true for those. Before this, the ticket
  // got the summary and nothing else: no sign the session only found a
  // cause, or is stuck wanting a decision.
  it('root-cause and needs-info (no state change to carry them) get the verdict tag back — plan null is the only trigger', () => {
    const rootCause = buildRunComment({
      report: parseReport(
        'Verdict: root-cause\n## Summary\nThe cache key omits the tenant id.',
      ),
      runLabel: 'ENG-9 · Investigate',
      published: null,
      verdict: 'root-cause',
      plan: null,
    });
    expect(rootCause).toBe(
      [
        '**Verdict:** root cause found',
        'The cache key omits the tenant id.',
        FOOTER('ENG-9 · Investigate'),
      ].join('\n\n'),
    );

    const needsInfo = buildRunComment({
      report: parseReport(
        'Verdict: needs-info\n## Summary\nTwo readings of the spec; a person must pick one.',
      ),
      runLabel: 'ENG-9 · Fix',
      published: null,
      verdict: 'needs-info',
      plan: null,
    });
    expect(needsInfo).toBe(
      [
        '**Verdict:** needs a decision',
        'Two readings of the spec; a person must pick one.',
        FOOTER('ENG-9 · Fix'),
      ].join('\n\n'),
    );

    // The exact same verdict word, but WITH a plan (a Fix's fixed/partial
    // proposes review) — the paired state change says it, so no tag.
    const withPlan = buildRunComment({
      report: parseReport('Verdict: fixed\n## Summary\nDone.'),
      runLabel: 'r',
      published: null,
      verdict: 'fixed',
      plan: 'review',
    });
    expect(withPlan).not.toContain('Verdict');
  });

  // A defaulted verdict (the agent's closing message named none —
  // finalize.ts's defaultVerdict) still needs the tag when its plan is
  // null: `report.verdict` alone is null here, but the caller's
  // `verdict` (what actually lands on the row) is not.
  it('a defaulted verdict with no plan still gets the tag, even though report.verdict itself is null', () => {
    const body = buildRunComment({
      report: parseReport('Looked into it; the cache key omits the tenant id.'),
      runLabel: 'ENG-9 · Investigate',
      published: null,
      verdict: 'root-cause',
      plan: null,
    });
    expect(body).toContain('**Verdict:** root cause found');
  });
});

describe('describeWork', () => {
  it('counts, singular and plural', () => {
    expect(
      describeWork({
        branch: 'b',
        baseRef: 'main',
        commits: 1,
        files: 0,
        uncommitted: 1,
      }),
    ).toBe('Branch `b` from `main` · 1 commit · 1 uncommitted change');
  });
});
