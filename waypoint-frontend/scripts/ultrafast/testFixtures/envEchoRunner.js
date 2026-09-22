#!/usr/bin/env node

// F2 (tech-lead review, 2026-09-22): stands in for runner.py just long
// enough to report the env buildRunnerEnv() actually gave it — the
// browser-harness telemetry opt-outs in particular. The runner's own
// stderr is captured internally by ultrafast-mcp.js (into `stderrTail`,
// used only for a failure message) and never forwarded to the MCP
// server's own stderr, so a stderr line here would be invisible to a
// test driving the server over stdio. The result line's `error` field is
// the one channel that DOES reach the caller regardless of `status`
// (buildToolResult always appends an "error: …" line when it's set, and
// `isError` is driven by `status`, not by whether `error` is set) — so
// the snapshot rides there, JSON-encoded, on an otherwise-`done` result.
// Used only by ultrafast-mcp.test.js's telemetry backstop test.

const readline = require('readline');

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.once('line', () => {
  const snapshot = JSON.stringify({
    BH_TELEMETRY: process.env.BH_TELEMETRY ?? null,
    BH_HOME: process.env.BH_HOME ?? null,
    BH_UPDATE_CHECK: process.env.BH_UPDATE_CHECK ?? null,
  });
  process.stdout.write(
    `${JSON.stringify({
      type: 'result',
      status: 'done',
      steps: 0,
      elapsedMs: 0,
      jevDecisions: 0,
      textCalls: 0,
      jevMsTotal: 0,
      textMsTotal: 0,
      history: [],
      screenshots: [],
      error: `ENV_SNAPSHOT ${snapshot}`,
    })}\n`,
  );
});
