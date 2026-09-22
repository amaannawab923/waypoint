#!/usr/bin/env node

// Stands in for the real Python runner.py in ultrafast-mcp.test.js: reads
// the one JSON request line ultrafast-mcp.js writes to its stdin, emits a
// couple of "step" lines and one "result" line in the exact shape
// runner.py's own `emit()` calls produce, and writes two tiny real JPEG
// files into the requested recordDir so buildToolResult's
// fs.readFileSync(...).toString('base64') has something real to read —
// the same reason the fixture exists at all: proving the MCP server's own
// stdio framing, timeout handling and image-content assembly without
// needing jev-ultrafast, browser-harness, or a real Chromium installed.

const fs = require('fs');
const path = require('path');
const readline = require('readline');

// A 1x1 pixel JPEG — real bytes, not a placeholder string, so
// Buffer.toString('base64') round-trips through something an image
// decoder would actually accept.
const TINY_JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=';

async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    terminal: false,
  });
  const line = await new Promise((resolve) => {
    rl.once('line', resolve);
  });
  const request = JSON.parse(line);
  const recordDir = request.recordDir || '.';
  fs.mkdirSync(recordDir, { recursive: true });

  const emit = (payload) => {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  };

  emit({
    type: 'step',
    elapsedMs: 120,
    status: 'ready',
    operation: 'click',
    target: 'Your name',
    action: 'Click the name field',
    text: null,
    confidence: 0.97,
    jevMs: 340,
  });

  const firstFrame = path.join(recordDir, '000000.jpg');
  fs.writeFileSync(firstFrame, Buffer.from(TINY_JPEG_BASE64, 'base64'));

  emit({
    type: 'step',
    elapsedMs: 480,
    status: 'ready',
    operation: 'fill',
    target: 'Your name',
    action: 'Type into the name field',
    text: 'Ada',
    confidence: 0.94,
    jevMs: 355,
  });

  const finalFrame = path.join(recordDir, '999999-final.jpg');
  fs.writeFileSync(finalFrame, Buffer.from(TINY_JPEG_BASE64, 'base64'));

  emit({
    type: 'result',
    status: 'done',
    steps: 2,
    elapsedMs: 640,
    jevDecisions: 2,
    textCalls: 1,
    // F23 (tech-lead review, 2026-09-22): the two step lines above already
    // carry real jevMs figures (340, 355) — runner.py's own result line
    // sums exactly these into jevMsTotal/textMsTotal (runner.py:141-146).
    // This fixture used to omit both fields entirely, so timingLine()'s
    // `secs(result.jevMsTotal)`/`secs(result.textMsTotal)` always read
    // undefined -> 0 -> "0.0 s", and ultrafast-mcp.test.js's own Timing
    // assertion could not have failed on a wrong number even if timingLine
    // computed one, because every run produced the same "0.0 s" either
    // way. Real, distinct figures here (695 = 340+355; 220 for the one
    // text call) let that test assert the actual seconds string rather
    // than just the line's shape.
    jevMsTotal: 695,
    textMsTotal: 220,
    history: [
      {
        step: 1,
        action: 'Click the name field',
        kind: 'click',
        operation: 'click',
        target: 'Your name',
        text: null,
        confidence: 0.97,
        jevMs: 340,
        pageChanged: false,
      },
      {
        step: 2,
        action: 'Type into the name field',
        kind: 'fill',
        operation: 'fill',
        target: 'Your name',
        text: 'Ada',
        confidence: 0.94,
        jevMs: 355,
        pageChanged: true,
      },
    ],
    screenshots: [firstFrame, finalFrame],
    error: null,
  });
}

main();
