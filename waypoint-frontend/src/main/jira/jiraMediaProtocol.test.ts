jest.mock('electron', () => ({ protocol: { handle: jest.fn() } }));
jest.mock('./jiraClient', () => ({
  downloadAttachment: jest.fn(),
  getAttachmentMeta: jest.fn(),
}));

import {
  attachmentIdFromUrl,
  clearJiraMediaCache,
  jiraMediaUrl,
  parseRange,
  serveJiraMedia,
} from './jiraMediaProtocol';

const PNG = Buffer.from('a'.repeat(1000));

type Deps = Parameters<typeof serveJiraMedia>[1];

function deps(overrides: Partial<Deps> = {}): Deps {
  const base: Deps = {
    download: jest.fn(async () => ({
      ok: true as const,
      value: { bytes: PNG },
    })),
    meta: jest.fn(async () => ({
      ok: true as const,
      value: { mimeType: 'image/png' },
    })),
    site: jest.fn((): string | null => 'acme.atlassian.net'),
  };
  return Object.assign(base, overrides);
}

const req = (id: string, range?: string) => ({ url: jiraMediaUrl(id), range });
const text = (body: Uint8Array) => new TextDecoder().decode(body);

beforeEach(() => {
  clearJiraMediaCache();
  jest.clearAllMocks();
});

describe('attachmentIdFromUrl', () => {
  it('accepts a single id segment and nothing else', () => {
    expect(attachmentIdFromUrl(jiraMediaUrl('10037'))).toBe('10037');
    expect(
      attachmentIdFromUrl('waypoint-jira-attachment://attachment/'),
    ).toBeNull();
    expect(
      attachmentIdFromUrl('waypoint-jira-attachment://attachment/1/2'),
    ).toBeNull();
    // `..` resolves before this sees it, and that is harmless: nothing
    // here touches a filesystem, so what comes out is just another id
    // Jira will not know.
    expect(
      attachmentIdFromUrl(
        'waypoint-jira-attachment://attachment/10037/../secrets',
      ),
    ).toBe('secrets');
  });

  it('refuses ids outside the shape jiraIpc allows, and other schemes', () => {
    expect(attachmentIdFromUrl(jiraMediaUrl('../../etc/passwd'))).toBeNull();
    expect(attachmentIdFromUrl(jiraMediaUrl('a b'))).toBeNull();
    expect(attachmentIdFromUrl('https://evil.example/attachment/1')).toBeNull();
    expect(attachmentIdFromUrl('not a url at all')).toBeNull();
  });
});

describe('parseRange', () => {
  it('reads a closed range, an open one, and a suffix', () => {
    expect(parseRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=500-', 1000)).toEqual({ start: 500, end: 999 });
    expect(parseRange('bytes=-200', 1000)).toEqual({ start: 800, end: 999 });
  });

  it('clamps past the end and refuses nonsense', () => {
    expect(parseRange('bytes=900-99999', 1000)).toEqual({
      start: 900,
      end: 999,
    });
    expect(parseRange('bytes=2000-3000', 1000)).toBeNull();
    expect(parseRange('bytes=-', 1000)).toBeNull();
    expect(parseRange('items=0-1', 1000)).toBeNull();
    expect(parseRange(null, 1000)).toBeNull();
  });
});

describe('serveJiraMedia', () => {
  it('serves the bytes with the type Jira reported, and says ranges are available', async () => {
    const d = deps();
    const res = await serveJiraMedia(req('10037'), d);
    expect(res.status).toBe(200);
    expect(res.headers['Content-Type']).toBe('image/png');
    expect(res.headers['Accept-Ranges']).toBe('bytes');
    // nosniff matters here specifically: these bytes come from outside.
    expect(res.headers['X-Content-Type-Options']).toBe('nosniff');
    expect(Buffer.from(res.body)).toEqual(PNG);
  });

  it('answers a range request with 206 and only that slice — what <video> needs to seek', async () => {
    const res = await serveJiraMedia(req('10037', 'bytes=10-19'), deps());
    expect(res.status).toBe(206);
    expect(res.headers['Content-Range']).toBe('bytes 10-19/1000');
    expect(res.headers['Content-Length']).toBe('10');
    expect(res.body.byteLength).toBe(10);
  });

  it('fetches once and serves the rest from memory', async () => {
    const d = deps();
    await serveJiraMedia(req('10037'), d);
    await serveJiraMedia(req('10037', 'bytes=0-9'), d);
    await serveJiraMedia(req('10037'), d);
    expect(d.download).toHaveBeenCalledTimes(1);
    expect(d.meta).toHaveBeenCalledTimes(1);
  });

  it('refuses an id it would not have built itself, without asking Jira', async () => {
    const d = deps();
    const res = await serveJiraMedia(
      { url: 'waypoint-jira-attachment://attachment/a%20b' },
      d,
    );
    expect(res.status).toBe(404);
    expect(d.download).not.toHaveBeenCalled();
  });

  it('never puts a Jira failure reason in the response body', async () => {
    const d = deps({
      download: jest.fn(async () => ({ ok: false as const })),
    });
    const res = await serveJiraMedia(req('10037'), d);
    expect(res.status).toBe(502);
    expect(text(res.body)).toBe('Unavailable');
    expect(text(res.body)).not.toMatch(/atlassian|token|http/i);
  });

  it('still serves the bytes when the type lookup fails — it downloads, it just will not preview', async () => {
    const d = deps({ meta: jest.fn(async () => ({ ok: false as const })) });
    const res = await serveJiraMedia(req('10037'), d);
    expect(res.status).toBe(200);
    expect(res.headers['Content-Type']).toBe('application/octet-stream');
  });

  it('never serves one site\u2019s bytes for another site\u2019s identical id', async () => {
    // Jira Cloud attachment ids are small per-site integers, so 10001 on
    // two sites is two different files. Keyed by id alone this returned
    // the first account's bytes to the second, with no credential check.
    const first = Buffer.from('SITE-A-SECRET');
    const second = Buffer.from('site-b-bytes');
    let current = first;
    const d = deps({
      download: jest.fn(async () => ({
        ok: true as const,
        value: { bytes: current },
      })),
      site: jest.fn(() => 'a.atlassian.net' as string | null),
    });
    const a = await serveJiraMedia(req('10001'), d);
    expect(Buffer.from(a.body)).toEqual(first);

    // Same id, different account.
    current = second;
    (d.site as jest.Mock).mockReturnValue('b.atlassian.net');
    const b = await serveJiraMedia(req('10001'), d);
    expect(Buffer.from(b.body)).toEqual(second);
    expect(d.download).toHaveBeenCalledTimes(2);
  });

  it('refuses when no account is connected rather than reading an unkeyed cache', async () => {
    const d = deps({ site: jest.fn(() => null) });
    const res = await serveJiraMedia(req('10001'), d);
    expect(res.status).toBe(502);
    expect(d.download).not.toHaveBeenCalled();
  });

  it('gives an error response the same header discipline as a success', async () => {
    const res = await serveJiraMedia(
      { url: 'waypoint-jira-attachment://attachment/a%20b' },
      deps(),
    );
    expect(res.status).toBe(404);
    expect(res.headers['X-Content-Type-Options']).toBe('nosniff');
    expect(res.headers['Cache-Control']).toBe('no-store');
  });

  it('clearing the cache makes the next request fetch again', async () => {
    const d = deps();
    await serveJiraMedia(req('10037'), d);
    clearJiraMediaCache();
    await serveJiraMedia(req('10037'), d);
    expect(d.download).toHaveBeenCalledTimes(2);
  });
});
