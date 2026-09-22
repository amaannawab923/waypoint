#!/usr/bin/env node
'use strict';

// Stands in for the isolated Chromium binary in ultrafast-mcp.test.js:
// ultrafast-mcp.js spawns "chromium" with `--remote-debugging-port=N`
// among its args; this fixture reads that port out of argv and answers
// `GET /json/version` with 200, exactly what launchChromium()'s own
// waitForCdp() polls for, without needing a real browser installed.

const http = require('http');

const portArg = process.argv.find((a) => a.startsWith('--remote-debugging-port='));
const port = portArg ? Number(portArg.split('=')[1]) : 0;

const server = http.createServer((req, res) => {
  if (req.url === '/json/version') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ Browser: 'fake-chromium/1.0' }));
    return;
  }
  res.writeHead(404).end();
});
server.listen(port, '127.0.0.1');

// Stay alive until killed, same as a real browser process would.
process.stdin.resume();
