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
      value: { bytes: PNG, site: 'acme.atlassian.net' },
    })),
    meta: jest.fn(async () => ({
      ok: true as const,
      value: {
        mimeType: 'image/png',
        size: PNG.byteLength,
        site: 'acme.atlassian.net',
      },
    })),
    downloadRange: jest.fn(
      async (_id: string, range: { start: number; end: number }) => ({
        ok: true as const,
        value: {
          bytes: PNG.subarray(range.start, range.end + 1),
          site: 'acme.atlassian.net',
          partial: true,
          totalSize: PNG.byteLength,
        },
      }),
    ),
    thumbnail: jest.fn(async () => ({
      ok: true as const,
      value: {
        bytes: Buffer.from('POSTER'),
        site: 'acme.atlassian.net',
        mimeType: 'image/jpeg',
      },
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
    let currentSite = 'a.atlassian.net';
    const d = deps({
      download: jest.fn(async () => ({
        ok: true as const,
        value: { bytes: current, site: currentSite },
      })),
      site: jest.fn(() => currentSite as string | null),
    });
    const a = await serveJiraMedia(req('10001'), d);
    expect(Buffer.from(a.body)).toEqual(first);

    // Same id, different account.
    current = second;
    currentSite = 'b.atlassian.net';
    const b = await serveJiraMedia(req('10001'), d);
    expect(Buffer.from(b.body)).toEqual(second);
    expect(d.download).toHaveBeenCalledTimes(2);
  });

  it('an account switch mid-download cannot poison the old site\u2019s cache entry', async () => {
    // The await in download is a real network call and connect/disconnect
    // are IPC handlers on the same loop, so the credential can change
    // underneath. Keyed off the site read BEFORE the await, site B's bytes
    // would be filed under site A's key — and served on a later reconnect
    // to A.
    const bBytes = Buffer.from('site-b-bytes');
    const d = deps({
      site: jest.fn(() => 'a.atlassian.net' as string | null),
      // Answers as B even though the request began while A was connected.
      download: jest.fn(async () => ({
        ok: true as const,
        value: { bytes: bBytes, site: 'b.atlassian.net' },
      })),
    });
    const res = await serveJiraMedia(req('10001'), d);
    // The request itself is refused: these are not the account's bytes.
    expect(res.status).toBe(502);

    // And nothing was filed under A. Reconnecting to A and asking again
    // must go back to Jira rather than hit a poisoned entry.
    const aBytes = Buffer.from('site-a-bytes');
    const after = deps({
      site: jest.fn(() => 'a.atlassian.net' as string | null),
      download: jest.fn(async () => ({
        ok: true as const,
        value: { bytes: aBytes, site: 'a.atlassian.net' },
      })),
    });
    const good = await serveJiraMedia(req('10001'), after);
    expect(Buffer.from(good.body)).toEqual(aBytes);
    expect(after.download).toHaveBeenCalledTimes(1);
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

describe('serveJiraMedia, large attachments', () => {
  const BIG = 80 * 1024 * 1024; // a 60s 1080p screen recording
  const CHUNK = 2 * 1024 * 1024;

  /** Deps for a file too big to hold whole. */
  function bigDeps(over: Partial<Deps> = {}): Deps {
    return deps({
      meta: jest.fn(async () => ({
        ok: true as const,
        value: {
          mimeType: 'video/mp4',
          size: BIG,
          site: 'acme.atlassian.net',
        },
      })),
      downloadRange: jest.fn(
        async (_id: string, range: { start: number; end: number }) => ({
          ok: true as const,
          value: {
            bytes: Buffer.alloc(range.end - range.start + 1),
            site: 'acme.atlassian.net',
            partial: true,
            totalSize: BIG,
          },
        }),
      ),
      ...over,
    });
  }

  it('never downloads a large attachment whole — this is the 12-second first frame', async () => {
    const d = bigDeps();
    await serveJiraMedia(req('10167', 'bytes=0-'), d);
    // The full-download path must not be touched at all.
    expect(d.download).not.toHaveBeenCalled();
    expect(d.downloadRange).toHaveBeenCalledTimes(1);
  });

  it('caps an open-ended range so playback starts on the first chunk', async () => {
    const d = bigDeps();
    // `bytes=0-` means "the rest of the file". Answering it literally is
    // the full download again.
    const res = await serveJiraMedia(req('10167', 'bytes=0-'), d);
    expect(res.status).toBe(206);
    expect(res.body.byteLength).toBe(CHUNK);
    expect(res.headers['Content-Range']).toBe(`bytes 0-${CHUNK - 1}/${BIG}`);
    const [, asked] = (d.downloadRange as jest.Mock).mock.calls[0];
    expect(asked).toEqual({ start: 0, end: CHUNK - 1 });
  });

  it('a seek fetches only around the seek point, not from the start', async () => {
    const d = bigDeps();
    const at = 41_000_000;
    await serveJiraMedia(req('10167', `bytes=${at}-`), d);
    const [, asked] = (d.downloadRange as jest.Mock).mock.calls[0];
    expect(asked.start).toBe(at);
    expect(asked.end).toBe(at + CHUNK - 1);
  });

  it('honours a short closed range verbatim rather than padding it to a chunk', async () => {
    const d = bigDeps();
    const res = await serveJiraMedia(req('10167', 'bytes=100-199'), d);
    expect(res.body.byteLength).toBe(100);
    expect(res.headers['Content-Range']).toBe(`bytes 100-199/${BIG}`);
  });

  it('a large attachment is never cached — one of these outsizes the whole budget', async () => {
    const d = bigDeps();
    await serveJiraMedia(req('10167', 'bytes=0-'), d);
    await serveJiraMedia(req('10167', 'bytes=0-'), d);
    expect(d.downloadRange).toHaveBeenCalledTimes(2);
  });

  it('reports 200, not 206, when the server ignored the Range and sent everything', async () => {
    const whole = Buffer.alloc(1024);
    const d = bigDeps({
      downloadRange: jest.fn(async () => ({
        ok: true as const,
        value: {
          bytes: whole,
          site: 'acme.atlassian.net',
          partial: false,
          totalSize: null,
        },
      })),
    });
    const res = await serveJiraMedia(req('10167', 'bytes=0-'), d);
    // Saying 206 over a full body would misdescribe it.
    expect(res.status).toBe(200);
    expect(res.headers['Content-Range']).toBeUndefined();
    expect(res.headers['Content-Length']).toBe('1024');
  });

  it('refuses a ranged response that came back from a different account', async () => {
    const d = bigDeps({
      downloadRange: jest.fn(async () => ({
        ok: true as const,
        value: {
          bytes: Buffer.alloc(10),
          site: 'someone-else.atlassian.net',
          partial: true,
          totalSize: BIG,
        },
      })),
    });
    const res = await serveJiraMedia(req('10167', 'bytes=0-'), d);
    expect(res.status).toBe(502);
  });

  it('still says ranges are available, so the player knows it can seek', async () => {
    const res = await serveJiraMedia(req('10167', 'bytes=0-'), bigDeps());
    expect(res.headers['Accept-Ranges']).toBe('bytes');
    expect(res.headers['Content-Type']).toBe('video/mp4');
  });
});

describe('serveJiraMedia, posters', () => {
  const thumbReq = (id: string) => ({
    url: `waypoint-jira-attachment://thumbnail/${id}`,
  });

  it("serves Jira's own poster, which is the only still a video has", async () => {
    const d = deps();
    const res = await serveJiraMedia(thumbReq('10167'), d);
    expect(res.status).toBe(200);
    expect(res.headers['Content-Type']).toBe('image/jpeg');
    expect(text(res.body)).toBe('POSTER');
    // Never the full attachment: that is the whole point of a poster.
    expect(d.download).not.toHaveBeenCalled();
    expect(d.downloadRange).not.toHaveBeenCalled();
  });

  it('caches the poster separately from the attachment itself', async () => {
    const d = deps();
    await serveJiraMedia(thumbReq('10167'), d);
    await serveJiraMedia(thumbReq('10167'), d);
    expect(d.thumbnail).toHaveBeenCalledTimes(1);

    // The same id as a full attachment must not be answered from the
    // poster's entry.
    const full = await serveJiraMedia(req('10167'), d);
    expect(text(full.body)).not.toBe('POSTER');
    expect(d.download).toHaveBeenCalledTimes(1);
  });

  it('refuses a variant it does not serve rather than treating it as a download', async () => {
    const d = deps();
    const res = await serveJiraMedia(
      { url: 'waypoint-jira-attachment://anything/10167' },
      d,
    );
    expect(res.status).toBe(404);
    expect(d.download).not.toHaveBeenCalled();
    expect(d.thumbnail).not.toHaveBeenCalled();
  });

  it('refuses a poster that came back from a different account', async () => {
    const d = deps({
      thumbnail: jest.fn(async () => ({
        ok: true as const,
        value: {
          bytes: Buffer.from('X'),
          site: 'someone-else.atlassian.net',
          mimeType: 'image/jpeg',
        },
      })),
    });
    expect((await serveJiraMedia(thumbReq('10167'), d)).status).toBe(502);
  });
});

describe('serveJiraMedia, metadata attribution', () => {
  it("files an attachment's type and size under the site the READ authenticated as", async () => {
    // The same race the bytes were fixed for: an account switch during
    // the metadata fetch would otherwise file B's answer under A's key,
    // and A's bytes would later be described as B's.
    const d = deps({
      site: jest.fn(() => 'a.atlassian.net' as string | null),
      meta: jest.fn(async () => ({
        ok: true as const,
        value: {
          mimeType: 'video/mp4',
          size: 999,
          site: 'b.atlassian.net',
        },
      })),
    });
    const res = await serveJiraMedia(req('10001'), d);
    // Nothing of B's describes a request made for A.
    expect(res.headers['Content-Type']).not.toBe('video/mp4');

    // And asking again re-reads rather than trusting a mis-filed entry.
    await serveJiraMedia(req('10001'), d);
    expect(d.meta).toHaveBeenCalledTimes(2);
  });

  it('reuses the description on a later request for the same site', async () => {
    const d = deps();
    await serveJiraMedia(req('10001'), d);
    await serveJiraMedia(req('10001'), d);
    expect(d.meta).toHaveBeenCalledTimes(1);
  });
});
