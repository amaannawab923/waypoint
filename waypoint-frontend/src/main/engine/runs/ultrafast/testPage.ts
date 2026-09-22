import * as http from 'http';

/**
 * The tiny page `ultrafast:test` drives — a heading, a text field labelled
 * "Your name", a button "Continue", and a greeting that appears only after
 * the button is pressed, so a passing test actually proves jev drove the
 * page (clicked into the field, typed Claude's text, clicked the button)
 * rather than just having loaded it. A real loopback HTTP server, not a
 * `data:` URL: browser-harness observes the page over CDP, and a `data:`
 * document has no stable URL for `BU_CDP_URL`'s navigation to target twice
 * in the way a fresh Chromium's first navigation needs.
 *
 * F20 (tech-lead review, 2026-09-22): the greeting's own click handler now
 * POSTs its rendered text back to this same server (`/report`) the instant
 * it sets it — a same-origin `fetch`, nothing jev or the text-model shim
 * ever sees or could influence. `TestPageHandle.greeting()` reads that
 * report. Without this, `ultrafast:test` had no way to check WHAT the page
 * actually ended up saying — only jev's own `status: done` claim, which a
 * run that clicked Continue without ever typing a name (the field defaults
 * to "there") satisfies just as happily as a real pass.
 */
const PAGE_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Ultrafast test</title></head>
<body>
  <h1>Say hello</h1>
  <label for="name">Your name</label>
  <input id="name" name="name" type="text" />
  <button id="continue" type="button">Continue</button>
  <p id="greeting" hidden></p>
  <script>
    document.getElementById('continue').addEventListener('click', function () {
      var name = document.getElementById('name').value || 'there';
      var greeting = document.getElementById('greeting');
      greeting.textContent = 'Hello, ' + name + '!';
      greeting.hidden = false;
      fetch('/report', { method: 'POST', body: greeting.textContent }).catch(function () {});
    });
  </script>
</body>
</html>`;

export interface TestPageHandle {
  url: string;
  close: () => Promise<void>;
  /** The greeting the page actually rendered, reported the instant its own
   *  click handler set it (see PAGE_HTML's own comment above) — null if
   *  Continue was never actually pressed with a value that reached the
   *  page, whatever jev's own status claims. */
  greeting: () => string | null;
}

export function startTestPage(): Promise<TestPageHandle> {
  return new Promise((resolve, reject) => {
    let reportedGreeting: string | null = null;
    const server = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/report') {
        let body = '';
        req.on('data', (chunk: Buffer) => {
          body += chunk.toString('utf8');
        });
        req.on('end', () => {
          reportedGreeting = body;
          res.writeHead(204).end();
        });
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE_HTML);
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        greeting: () => reportedGreeting,
        close: () =>
          new Promise<void>((_resolve) => {
            server.close(() => _resolve());
          }),
      });
    });
  });
}
