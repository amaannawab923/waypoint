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
    });
  </script>
</body>
</html>`;

export interface TestPageHandle {
  url: string;
  close: () => Promise<void>;
}

export function startTestPage(): Promise<TestPageHandle> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE_HTML);
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}
