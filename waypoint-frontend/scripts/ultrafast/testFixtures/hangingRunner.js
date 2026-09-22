#!/usr/bin/env node

// A runner fixture that never answers — for exercising the timeout/kill
// path in mcpClient.test.ts (and, if ever needed, ultrafast-mcp.test.js)
// without waiting out a real 180s task timeout. Reads the request line
// (so it behaves like a real spawn up to that point) and then just sits,
// until the parent kills it.

const readline = require('readline');

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.once('line', () => {
  // Deliberately emit nothing further.
});
process.stdin.resume();
