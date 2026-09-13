import { buildRunComment, describeWork } from './runComment';
import { parseReport } from './report';

const REPORT = `Verdict: fixed
## Summary
The retry re-sent the charge because the idempotency key was minted per attempt.
Keyed it on the order id; the second attempt now returns the first result.
## Details
src/checkout/retry.ts:41 minted the key inside the loop.
Verified with the checkout integration tests (3 new cases).`;

describe('buildRunComment', () => {
  it('a Fix: verdict, the Summary, the branch facts, the PR, and the footer — never the Details', () => {
    const body = buildRunComment({
      report: parseReport(REPORT),
      verdict: 'fixed',
      runLabel: 'ENG-77 · Fix',
      work: {
        branch: 'agent/ENG-77',
        baseRef: 'main',
        commits: 2,
        files: 3,
        uncommitted: 0,
      },
      published: {
        kind: 'opened',
        url: 'https://github.com/o/r/pull/9',
        pushed: true,
      },
    });
    expect(body).toBe(
      [
        '**Verdict:** fixed',
        'The retry re-sent the charge because the idempotency key was minted per attempt.\nKeyed it on the order id; the second attempt now returns the first result.',
        'Branch `agent/ENG-77` from `main` · 2 commits · 3 files changed\nPull request: https://github.com/o/r/pull/9',
        '*Full report — the evidence, files and how it was verified — is on the run in Waypoint (ENG-77 · Fix).*',
      ].join('\n\n'),
    );
    expect(body).not.toContain('retry.ts:41');
    expect(body).not.toContain('## Summary');
  });

  it('an Investigate: no branch line, no publish line', () => {
    const body = buildRunComment({
      report: parseReport(
        'Verdict: not-a-bug\n## Summary\nThe 500 is the upstream timeout, by design.\n## Details\nx',
      ),
      verdict: 'not-a-bug',
      runLabel: 'ENG-77 · Investigate',
      work: null,
      published: null,
    });
    expect(body).toBe(
      [
        '**Verdict:** not a bug',
        'The 500 is the upstream timeout, by design.',
        '*Full report — the evidence, files and how it was verified — is on the run in Waypoint (ENG-77 · Investigate).*',
      ].join('\n\n'),
    );
  });

  it("a failed publish and uncommitted work are the host's words, not the session's", () => {
    const body = buildRunComment({
      report: parseReport('Fixed it.\n\nNot pushed.'),
      verdict: 'fixed',
      runLabel: 'ROAD-1 · Fix',
      work: {
        branch: 'agent/ROAD-1',
        baseRef: null,
        commits: 1,
        files: 1,
        uncommitted: 2,
      },
      published: {
        kind: 'failed',
        stage: 'push',
        message: 'could not read Username',
      },
    });
    expect(body).toContain(
      'Branch `agent/ROAD-1` · 1 commit · 1 file changed · 2 uncommitted changes',
    );
    expect(body).toContain(
      'Not published — the push failed: could not read Username',
    );
  });

  it('a closing verdict the host chose not to publish says so', () => {
    const body = buildRunComment({
      report: parseReport(
        "Verdict: won't fix\n## Summary\nThe ask conflicts with the pricing rule.",
      ),
      verdict: 'wont-fix',
      runLabel: 'ROAD-1 · Fix',
      work: {
        branch: 'agent/ROAD-1',
        baseRef: 'main',
        commits: 0,
        files: 0,
        uncommitted: 0,
      },
      published: null,
      notPublishedBecause: "the session's verdict was won't fix",
    });
    expect(body).toContain("**Verdict:** won't fix");
    expect(body).toContain(
      "Branch `agent/ROAD-1` from `main` · 0 commits\nNot published: the session's verdict was won't fix",
    );
  });

  it('no verdict, no summary: the facts and the footer alone', () => {
    const body = buildRunComment({
      report: { verdict: null, summary: '', details: null },
      verdict: null,
      runLabel: 'r',
      work: null,
      published: null,
    });
    expect(body).toBe(
      '*Full report — the evidence, files and how it was verified — is on the run in Waypoint (r).*',
    );
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
