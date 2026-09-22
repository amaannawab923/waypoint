import * as http from 'http';
import { startTestPage } from './testPage';

// F20 (tech-lead review, 2026-09-22): the real regression test for
// testPage.ts's own reporting mechanism — the page's click handler POSTs
// its rendered greeting to /report, and TestPageHandle.greeting() reads
// it back. ipc.test.ts covers runUltrafastTest()'s use of this (mocked);
// this covers the server itself, for real, against a real HTTP request —
// no browser, no CDP, just the same POST a page's fetch() would make.

function postReport(url: string, body: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(`${url}/report`, { method: 'POST' }, (res) => {
      res.resume();
      res.once('end', () => resolve(res.statusCode ?? 0));
    });
    req.once('error', reject);
    req.end(body);
  });
}

function getPage(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => {
          body += chunk.toString('utf8');
        });
        res.on('end', () => resolve(body));
      })
      .once('error', reject);
  });
}

describe('startTestPage', () => {
  it('greeting() is null before any report arrives', async () => {
    const page = await startTestPage();
    try {
      expect(page.greeting()).toBeNull();
    } finally {
      await page.close();
    }
  });

  it('serves a page whose click handler reports to /report', async () => {
    const page = await startTestPage();
    try {
      const html = await getPage(page.url);
      expect(html).toContain('id="name"');
      expect(html).toContain('id="continue"');
      // The mechanism F20 relies on: without this fetch call, jev's own
      // status is the only signal ultrafast:test would have to go on.
      expect(html).toContain("fetch('/report'");
    } finally {
      await page.close();
    }
  });

  it('greeting() reflects the most recently reported value', async () => {
    const page = await startTestPage();
    try {
      const status = await postReport(page.url, 'Hello, Ada!');
      expect(status).toBe(204);
      expect(page.greeting()).toBe('Hello, Ada!');

      // A second report (a re-run, or jev clicking Continue twice)
      // overwrites rather than accumulates.
      await postReport(page.url, 'Hello, there!');
      expect(page.greeting()).toBe('Hello, there!');
    } finally {
      await page.close();
    }
  });
});
