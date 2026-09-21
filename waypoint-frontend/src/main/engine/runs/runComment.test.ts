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
    });
    expect(body).toBe(
      [
        'The 500 is the upstream timeout, by design.',
        FOOTER('ENG-77 · Investigate'),
      ].join('\n\n'),
    );
  });

  it("a failed publish is the run's business, not the ticket's: no PR line, no reason", () => {
    const body = buildRunComment({
      report: parseReport('Fixed it.'),
      runLabel: 'ROAD-1 · Fix',
      published: {
        kind: 'failed',
        stage: 'push',
        message: 'could not read Username',
      },
    });
    expect(body).toBe(['Fixed it.', FOOTER('ROAD-1 · Fix')].join('\n\n'));
    expect(body).not.toContain('Username');
    expect(body).not.toContain('Not published');
  });

  it.each([
    [
      'pushed-only',
      { kind: 'pushed-only' as const, reason: 'no origin remote' },
    ],
    ['skipped', { kind: 'skipped' as const, reason: 'nothing to publish' }],
  ])(
    'a %s publish has no PR, so no PR line and none of the reason',
    (_kind, published) => {
      const body = buildRunComment({
        report: parseReport('Verdict: fixed\n## Summary\nDone.'),
        runLabel: 'r',
        published,
      });
      expect(body).toBe(['Done.', FOOTER('r')].join('\n\n'));
    },
  );

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
    });
    expect(body).toBe(FOOTER('r'));
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
