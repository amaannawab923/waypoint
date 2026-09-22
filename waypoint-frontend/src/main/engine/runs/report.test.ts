import {
  defaultVerdict,
  isClosingVerdict,
  parseReport,
  parseVerdictWord,
  parseVerificationTiming,
  verdictLabel,
} from './report';

describe('parseReport', () => {
  it('reads the shape the brief asks for: verdict, Summary, Details', () => {
    const r = parseReport(
      'Verdict: not-a-bug\n## Summary\nThe ticket describes seed data, not a defect.\nClose it.\n## Details\nEvidence: a.ts:12\n- more',
    );
    expect(r.verdict).toBe('not-a-bug');
    expect(r.summary).toBe(
      'The ticket describes seed data, not a defect.\nClose it.',
    );
    expect(r.details).toBe('## Details\nEvidence: a.ts:12\n- more');
    expect(r.hasSummaryHeading).toBe(true);
  });

  it('a quoted verdict line is a quotation, not this turn’s report (feedback round 1: a reply citing the old report was filed)', () => {
    const reply =
      'I\'m not sure what "line one" refers to. If you mean the first line of the filed report — it was:\n> Verdict: not-a-bug\n\nPoint me at it and I\'ll pull it up.';
    const r = parseReport(reply);
    expect(r.verdict).toBeNull();
    expect(r.hasSummaryHeading).toBe(false);
    // A real verdict line is still read when a quote sits above it.
    expect(
      parseReport(
        '> earlier: Verdict: fixed\nVerdict: partial\n## Summary\nhalf',
      ).verdict,
    ).toBe('partial');
  });

  it('lifts a Verification section out, leaving Summary and Details as they were', () => {
    const r = parseReport(
      'Verdict: fixed\n## Summary\nThe button works.\n## Verification\nStarted the app on :5173.\n01-before.png: the old label.\n02-after.png: the new one.\n## Details\nsrc/x.ts:4',
    );
    expect(r.verdict).toBe('fixed');
    expect(r.summary).toBe('The button works.');
    expect(r.verification).toBe(
      'Started the app on :5173.\n01-before.png: the old label.\n02-after.png: the new one.',
    );
    expect(r.details).toBe('## Details\nsrc/x.ts:4');
    // "Verified" too; "How I verified it" stays a Details cue (the
    // fallback split below relies on it) — the brief asks for the exact
    // heading, so a session that was asked to verify writes it.
    expect(
      parseReport(
        'Verdict: fixed\n## Summary\ns\n### Verified\nclicked\n## Details\nd',
      ).verification,
    ).toBe('clicked');
    expect(
      parseReport(
        'Verdict: fixed\n## Summary\ns\n### How I verified it\nclicked',
      ).verification,
    ).toBeNull();
    expect(
      parseReport('Verdict: fixed\n## Summary\ns\n## Details\nd').verification,
    ).toBeNull();
    // An empty section is null, not an empty string.
    expect(
      parseReport(
        'Verdict: fixed\n## Summary\ns\n## Verification\n## Details\nd',
      ).verification,
    ).toBeNull();
  });

  it('tolerates a bold verdict, a title above it, and synonyms', () => {
    const r = parseReport(
      '# ROAD-43 — report\n**Verdict:** Root cause\n\n## Summary\nfound it\n\n## Evidence\nx',
    );
    expect(r.verdict).toBe('root-cause');
    expect(r.summary).toBe('found it');
    expect(r.details).toBe('# ROAD-43 — report\n\n## Evidence\nx');
    expect(parseReport("Verdict: won't fix\n## Summary\nno").verdict).toBe(
      'wont-fix',
    );
    expect(
      parseReport('verdict — cannot reproduce\n## Summary\nno').verdict,
    ).toBe('needs-info');
    expect(
      parseReport('Verdict: partially fixed\n## Summary\nno').verdict,
    ).toBe('partial');
  });

  it('without a Summary heading, takes what precedes a Details-like heading or a rule', () => {
    const r = parseReport(
      'Guarded the write.\nTwo lines.\n\n---\n\nlong evidence',
    );
    expect(r.verdict).toBeNull();
    expect(r.summary).toBe('Guarded the write.\nTwo lines.');
    expect(r.details).toBe('---\n\nlong evidence');
    const h = parseReport('Fixed it.\n### How I verified it\nran tests');
    expect(h.summary).toBe('Fixed it.');
    expect(h.details).toBe('### How I verified it\nran tests');
  });

  it('with no structure at all, the first lines bounded, the whole text kept as details', () => {
    const long = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join(
      '\n',
    );
    const r = parseReport(long);
    expect(r.summary.split('\n')).toHaveLength(14);
    expect(r.details).toBe(long);
    const short = parseReport('one line');
    expect(short.summary).toBe('one line');
    expect(short.details).toBeNull();
  });

  it('an unknown verdict word is null, an empty message is empty', () => {
    expect(parseReport('Verdict: maybe\n## Summary\nx').verdict).toBeNull();
    expect(parseReport('   ')).toEqual({
      verdict: null,
      hasSummaryHeading: false,
      summary: '',
      verification: null,
      details: null,
    });
    expect(parseVerdictWord('fixed')).toBe('fixed');
    expect(parseVerdictWord('shrug')).toBeNull();
  });
});

describe('verdict helpers', () => {
  it('defaults by verb, labels, and knows which verdicts close a ticket', () => {
    expect(defaultVerdict('investigate')).toBe('root-cause');
    expect(defaultVerdict('fix')).toBe('fixed');
    expect(defaultVerdict('custom')).toBeNull();
    expect(verdictLabel('not-a-bug')).toBe('not a bug');
    expect(isClosingVerdict('wont-fix')).toBe(true);
    expect(isClosingVerdict('fixed')).toBe(false);
    expect(isClosingVerdict(null)).toBe(false);
    // Feedback round 1: what the ticket asks for already shipped — closes
    // the ticket as done, not cancelled; nothing to publish.
    expect(parseVerdictWord('delivered')).toBe('delivered');
    expect(parseVerdictWord('already built')).toBe('delivered');
    expect(parseVerdictWord('shipped')).toBe('delivered');
    expect(verdictLabel('delivered')).toBe('already delivered');
    expect(isClosingVerdict('delivered')).toBe(true);
  });
});

// Founder (2026-09-22): the QA-cycle time the brief asks for at the end
// of the Verification section, read leniently.
describe('parseVerificationTiming', () => {
  it('reads seconds via browser_task, tool calls via waypoint-browser, and tolerates extra figures', () => {
    expect(
      parseVerificationTiming(
        'Drove the form.\nVerification: 6.8 s via browser_task (Jev 3 decisions 1.0 s, Claude 1 call 2.4 s)',
      ),
    ).toEqual({ seconds: 6.8, toolCalls: null, via: 'browser_task' });
    expect(
      parseVerificationTiming(
        'Verification: 14 tool calls via waypoint-browser',
      ),
    ).toEqual({ seconds: null, toolCalls: 14, via: 'waypoint-browser' });
    expect(parseVerificationTiming('**Verification:** 12 seconds')).toEqual({
      seconds: 12,
      toolCalls: null,
      via: null,
    });
  });

  it('is null without the line, or without a section', () => {
    expect(parseVerificationTiming('Drove the form; it works.')).toBeNull();
    expect(parseVerificationTiming(null)).toBeNull();
  });

  // F14 (tech-lead review, 2026-09-22): "steps" and "screenshots" both
  // start with "s", the same letter the bare-seconds branch matched with
  // no word boundary — "Verification: 5 steps via browser_task" used to
  // parse as `{seconds: 5}`. These are the brief's own two most common
  // nouns right after a Verification line's count, so a step or
  // screenshot count must never be misread as a duration.
  it('does not read a step or screenshot count as a duration', () => {
    expect(parseVerificationTiming('Verification: 5 steps')).toBeNull();
    expect(
      parseVerificationTiming('Verification: 5 steps via browser_task'),
    ).toBeNull();
    expect(
      parseVerificationTiming('Verification: 3 screenshots taken'),
    ).toBeNull();
    expect(
      parseVerificationTiming('Verification: 2 screenshots attached'),
    ).toBeNull();
    expect(
      parseVerificationTiming(
        'I ran the verification: 4 steps in the browser.',
      ),
    ).toBeNull();
  });
});
