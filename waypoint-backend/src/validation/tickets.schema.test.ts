import { describe, it, expect } from 'vitest';
import { addCommentSchema, addTicketLinkSchema } from './tickets.schema.js';

describe('addCommentSchema bodyHtml', () => {
  it('passes an ordinary plain-text comment through unchanged', () => {
    const result = addCommentSchema.parse({ bodyHtml: 'Looks good to me.' });
    expect(result.bodyHtml).toBe('Looks good to me.');
  });

  it('entity-escapes a <script> tag so it can never reach stored/rendered HTML', () => {
    const result = addCommentSchema.parse({
      bodyHtml: '<script>alert(document.cookie)</script>',
    });
    expect(result.bodyHtml).toBe('&lt;script&gt;alert(document.cookie)&lt;/script&gt;');
    expect(result.bodyHtml).not.toContain('<script>');
  });

  it('neutralizes a javascript: or file: href by escaping the surrounding tag', () => {
    const js = addCommentSchema.parse({
      bodyHtml: '<a href="javascript:alert(1)">click me</a>',
    });
    expect(js.bodyHtml).not.toContain('<a ');
    expect(js.bodyHtml).toContain('&lt;a href=&quot;javascript:alert(1)&quot;&gt;');

    const file = addCommentSchema.parse({
      bodyHtml: '<a href="file:///etc/passwd">click me</a>',
    });
    expect(file.bodyHtml).not.toContain('<a ');
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
