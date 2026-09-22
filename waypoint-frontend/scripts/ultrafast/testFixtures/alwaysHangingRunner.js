#!/usr/bin/env node

// F10 (tech-lead review, 2026-09-22) test fixture: unlike hangingRunner.js
// (which also never answers, but turns out to exit on its own within tens
// of milliseconds once the parent's `child.stdin.end()` closes its stdin —
// fine for mcpClient.test.ts's timeout test, which only needs the parent
// to time out before this exits, but useless for F10's own test, which
// needs a runner that is DEMONSTRABLY STILL RUNNING right up until this
// process's own forceful-kill cleanup reaches it), this one holds the
// event loop open with a repeating timer that nothing but an external
// signal (SIGKILL, via the cleanup this test exists to prove) can stop.
//
// Writes its own pid into a `runner.pid` file inside BH_RUNTIME_DIR —
// one of the few env vars buildRunnerEnv() actually gives the runner (see
// that function's own comment: a fixed, minimal env, never
// process.env) — so the test can find the real OS pid to assert against,
// and reads which /tmp/wpuf-* directory belongs to this task.

const fs = require('fs');
const path = require('path');
const readline = require('readline');

if (process.env.BH_RUNTIME_DIR) {
  fs.writeFileSync(
    path.join(process.env.BH_RUNTIME_DIR, 'runner.pid'),
    String(process.pid),
  );
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.once('line', () => {
  // Deliberately emit nothing further.
});

// Keeps the event loop — and so this process — alive indefinitely. Never
// cleared: this fixture is meant to run until something outside it (the
// SIGKILL this test's own assertions are about) ends it.
setInterval(() => {}, 60_000);
