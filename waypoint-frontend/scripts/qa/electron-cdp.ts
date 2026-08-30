#!/usr/bin/env node
/* eslint-disable no-console -- console output IS this CLI's interface,
   matching main.ts's own no-console: off for the same reason. */
/**
 * A minimal CDP driver for scripted/agent QA against a locally running
 * Waypoint dev instance (see docs/qa-electron.md). Talks directly to the
 * renderer's CDP WebSocket target rather than through Chrome's own DevTools
 * frontend — the frontend conflicts with electron-debug's already-attached
 * native inspector on the same target (main.ts skips that auto-open
 * whenever QA debugging is on, but a raw client is also just the right
 * tool here regardless: Playwright and Puppeteer do the same thing
 * internally).
 *
 * Requires the app to be running via `npm run start:qa` (sets
 * ELECTRON_QA_DEBUG_PORT so main.ts actually opens the CDP port — passing
 * --remote-debugging-port as a bare extra CLI arg does not work through
 * electronmon's argv forwarding, see main.ts's own comment on this).
 *
 * Usage (via `npm run qa:electron --`):
 *   qa:electron targets
 *   qa:electron text
 *   qa:electron eval "document.title"
 *   qa:electron click ".my-button"
 *   qa:electron type "#email" "hello@example.com"
 *   qa:electron screenshot [out.png]
 */
import * as fs from 'fs';
import * as http from 'http';
import WebSocket from 'ws';

const DEBUG_PORT = process.env.ELECTRON_QA_DEBUG_PORT || '9222';
// The dev renderer's <title> — see src/renderer/index.ejs. Overridable in
// case a differently-titled window (or the packaged app) needs targeting.
const WINDOW_TITLE = process.env.ELECTRON_QA_WINDOW_TITLE || 'Waypoint';

type CDPTarget = {
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
};

function listTargets(): Promise<CDPTarget[]> {
  return new Promise((resolve, reject) => {
    // 127.0.0.1, not localhost: Node's default DNS resolution order can
    // try ::1 first, which the CDP server doesn't listen on, producing a
    // flat ECONNREFUSED with no useful clue why (hit this live).
    http
      .get(`http://127.0.0.1:${DEBUG_PORT}/json/list`, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(err);
          }
        });
      })
      .on('error', reject);
  });
}

class CDPClient {
  private ws: WebSocket;

  private nextId = 1;

  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (err: Error) => void }
  >();

  private ready: Promise<void>;

  constructor(wsUrl: string) {
    this.ws = new WebSocket(wsUrl);
    this.ready = new Promise((resolve, reject) => {
      this.ws.on('open', () => resolve());
      this.ws.on('error', reject);
    });
    this.ws.on('message', (raw: Buffer) => {
      const msg = JSON.parse(raw.toString());
      const waiter = this.pending.get(msg.id);
      if (!waiter) return;
      this.pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(JSON.stringify(msg.error)));
      else waiter.resolve(msg.result);
    });
  }

  async send(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<any> {
    await this.ready;
    return new Promise((resolve, reject) => {
      const id = this.nextId;
      this.nextId += 1;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void {
    this.ws.close();
  }
}

async function connect(): Promise<CDPClient> {
  const targets = await listTargets();
  const target = targets.find(
    (t) => t.type === 'page' && t.title === WINDOW_TITLE,
  );
  if (!target) {
    const seen =
      targets.map((t) => `${t.type}:${t.title || t.url}`).join(', ') ||
      '(none)';
    throw new Error(
      `No renderer target titled "${WINDOW_TITLE}" found on port ${DEBUG_PORT}. ` +
        `Is the app running via \`npm run start:qa\`? Targets seen: ${seen}`,
    );
  }
  const client = new CDPClient(
    target.webSocketDebuggerUrl.replace('localhost', '127.0.0.1'),
  );
  await client.send('Runtime.enable');
  return client;
}

async function evaluate(
  client: CDPClient,
  expression: string,
): Promise<unknown> {
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    const desc =
      result.exceptionDetails.exception?.description ??
      JSON.stringify(result.exceptionDetails);
    throw new Error(desc);
  }
  return result.result?.value;
}

// Uses the native setter, not `el.value = text`: React tracks input state
// through its own synthetic wrapper around the native value setter, so a
// plain assignment doesn't trigger React's onChange the way a real
// keystroke would — this is the standard workaround for driving a
// React-controlled input from outside React.
const TYPE_SCRIPT = (selector: string, text: string) => `
(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) throw new Error('No element matches ' + ${JSON.stringify(selector)});
  const proto = el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  setter.call(el, ${JSON.stringify(text)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()
`;

const CLICK_SCRIPT = (selector: string) => `
(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) throw new Error('No element matches ' + ${JSON.stringify(selector)});
  el.click();
  return true;
})()
`;

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command) {
    console.error(
      'Usage: qa:electron <targets|text|eval|click|type|screenshot> [args...]',
    );
    process.exitCode = 1;
    return;
  }

  const client = await connect();
  try {
    switch (command) {
      case 'targets': {
        const targets = await listTargets();
        console.log(
          JSON.stringify(
            targets.map((t) => ({ type: t.type, title: t.title, url: t.url })),
            null,
            2,
          ),
        );
        break;
      }
      case 'text': {
        console.log(await evaluate(client, 'document.body.innerText'));
        break;
      }
      case 'eval': {
        const value = await evaluate(client, args[0]);
        console.log(JSON.stringify(value, null, 2));
        break;
      }
      case 'click': {
        await evaluate(client, CLICK_SCRIPT(args[0]));
        console.log(`clicked ${args[0]}`);
        break;
      }
      case 'type': {
        const [selector, text] = args;
        await evaluate(client, TYPE_SCRIPT(selector, text));
        console.log(`typed into ${selector}`);
        break;
      }
      case 'screenshot': {
        const outPath = args[0] || 'screenshot.png';
        await client.send('Page.enable');
        const { data } = await client.send('Page.captureScreenshot', {
          format: 'png',
        });
        fs.writeFileSync(outPath, Buffer.from(data, 'base64'));
        console.log(`saved ${outPath}`);
        break;
      }
      default:
        console.error(
          `Unknown command "${command}". Try: targets, text, eval, click, type, screenshot.`,
        );
        process.exitCode = 1;
    }
  } finally {
    client.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
