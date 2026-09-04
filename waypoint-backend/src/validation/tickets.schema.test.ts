import { describe, it, expect } from 'vitest';
import { addCommentSchema, addTicketLinkSchema } from './tickets.schema.js';

describe('addCommentSchema bodyHtml', () => {
  it('passes an ordinary plain-text comment through unchanged', () => {
    const result = addCommentSchema.parse({ bodyHtml: 'Looks good to me.' });
    expect(result.bodyHtml).toBe('Looks good to me.');
  });

  // Human comments render as a plain React text node (TicketDetailPage.tsx),
  // which already escapes on render — validation must NOT also escape, or
  // the value gets entity-escaped twice and a comment containing `don't`
  // would come back as `don&amp;#39;t` instead of `don't`. This asserts the
  // create round-trip (what the schema hands to the service/DB/API) is the
  // untouched, single-escaped-on-render value.
  it('round-trips punctuation and markup characters unescaped', () => {
    const result = addCommentSchema.parse({
      bodyHtml: `don't <script>alert(1)</script> & "quoted"`,
    });
    expect(result.bodyHtml).toBe(`don't <script>alert(1)</script> & "quoted"`);
  });

  it('still rejects an empty body', () => {
    expect(addCommentSchema.safeParse({ bodyHtml: '' }).success).toBe(false);
  });
});

describe('addTicketLinkSchema url', () => {
  it('accepts http and https URLs', () => {
    expect(
      addTicketLinkSchema.safeParse({ url: 'https://example.com/doc', label: 'Doc' }).success,
    ).toBe(true);
    expect(
      addTicketLinkSchema.safeParse({ url: 'http://example.com/doc', label: 'Doc' }).success,
    ).toBe(true);
  });

  it('accepts a mailto link', () => {
    expect(
      addTicketLinkSchema.safeParse({ url: 'mailto:someone@example.com', label: 'Email' })
        .success,
    ).toBe(true);
  });

  it('rejects a javascript: URL', () => {
    expect(
      addTicketLinkSchema.safeParse({ url: 'javascript:alert(1)', label: 'Link' }).success,
    ).toBe(false);
  });

  it('rejects a file: URL', () => {
    expect(
      addTicketLinkSchema.safeParse({ url: 'file:///etc/passwd', label: 'Link' }).success,
    ).toBe(false);
  });

  it('rejects a malformed, unparseable URL', () => {
    expect(addTicketLinkSchema.safeParse({ url: 'not a url', label: 'Link' }).success).toBe(
      false,
    );
  });
});
