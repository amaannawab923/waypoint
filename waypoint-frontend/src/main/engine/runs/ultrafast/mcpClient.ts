import { spawn } from 'child_process';
import * as readline from 'readline';

/**
 * A tiny, one-shot client for the exact stdio JSON-RPC surface
 * ultrafast-mcp.js speaks (initialize, then one `tools/call`) — used by
 * `ultrafast:test`'s IPC handler to exercise the real MCP server end to
 * end (chromium launch, the text-model shim, the runner, image content)
 * the same way a real Claude session would call it, rather than
 * duplicating that orchestration a second time in TypeScript. Not a
 * general MCP client: it knows exactly one call shape, because that is
 * exactly what the Test button needs.
 */

export interface McpToolContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface McpToolResult {
  isError?: boolean;
  content: McpToolContentBlock[];
}

export interface CallBrowserTaskArgs {
  /** The MCP server's entry script (scriptPaths.ts's mcpServerEntry). */
  entry: string;
  /** `process.execPath`; spawned with `ELECTRON_RUN_AS_NODE=1` (added here). */
  execPath: string;
  /** The exact env the real registration would give it — see registration.ts's buildServerEnv. */
  env: Record<string, string>;
  url: string;
  goal: string;
  maxSteps?: number;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 200_000;

export function callBrowserTask(
  args: CallBrowserTaskArgs,
): Promise<McpToolResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(args.execPath, [args.entry], {
      env: { ...args.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let settled = false;
    let stderrTail = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4000);
    });

    const timer = setTimeout(() => {
      finish(() =>
        reject(
          new Error(
            `Timed out after ${args.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms.`,
          ),
        ),
      );
    }, args.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    const finish = (act: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // SIGTERM, not SIGKILL: gives the server's own `process.on('SIGTERM')`
      // handler a chance to kill any Chromium it still has open (see that
      // handler's own comment on `activeChromiumChildren`) — a SIGKILL here
      // cannot be caught by the receiving process at all, so on a call that
      // finishes while the server is still mid-task (the timeout path
      // below, most notably) that Chromium and its temp profile would
      // otherwise be silently orphaned. A short grace window, then SIGKILL
      // as the real fallback for a server that is wedged even on SIGTERM.
      try {
        child.kill('SIGTERM');
        const forceKill = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // Already gone.
          }
        }, 2_000);
        forceKill.unref?.();
        child.once('exit', () => clearTimeout(forceKill));
      } catch {
        // Already gone.
      }
      act();
    };

    let nextId = 1;
    const waiters = new Map<
      number,
      (message: { result?: unknown; error?: { message: string } }) => void
    >();
    function call(method: string, params?: unknown) {
      const id = nextId;
      nextId += 1;
      const response = new Promise<{
        result?: unknown;
        error?: { message: string };
      }>((_resolve) => {
        waiters.set(id, _resolve);
      });
      child.stdin?.write(
        `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`,
      );
      return response;
    }

    const rl = readline.createInterface({
      input: child.stdout,
      terminal: false,
    });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let message: {
        id?: number;
        result?: unknown;
        error?: { message: string };
      };
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (
        message &&
        typeof message.id === 'number' &&
        waiters.has(message.id)
      ) {
        const resolveWaiter = waiters.get(message.id);
        waiters.delete(message.id);
        resolveWaiter?.(message);
      }
    });

    child.once('error', (error) => finish(() => reject(error)));
    child.once('close', (code) => {
      if (!settled) {
        finish(() =>
          reject(
            new Error(
              `The ultrafast MCP server exited (code ${code}) before answering.${stderrTail ? ` stderr: ${stderrTail.trim()}` : ''}`,
            ),
          ),
        );
      }
    });

    (async () => {
      await call('initialize', { protocolVersion: '2024-11-05' });
      const response = await call('tools/call', {
        name: 'browser_task',
        arguments: { url: args.url, goal: args.goal, maxSteps: args.maxSteps },
      });
      if (response.error) {
        finish(() =>
          reject(new Error(response.error?.message ?? 'Unknown MCP error.')),
        );
        return;
      }
      finish(() => resolve(response.result as McpToolResult));
    })().catch((error) => finish(() => reject(error)));
  });
}

/** Pulls the leading `status: X · N step(s) · Mms · …` summary line
 *  `buildToolResult` (ultrafast-mcp.js) always writes as the first line of
 *  its text content, so the settings page can show a structured status/
 *  step count rather than parsing the whole transcript. Owned by this app
 *  on both ends, so the format is stable to depend on here. */
export function parseSummaryLine(result: McpToolResult): {
  status: string | null;
  steps: number | null;
} {
  const text = result.content.find((c) => c.type === 'text')?.text ?? '';
  const match = /^status:\s*(\S+)\s*·\s*(\d+)\s*step/.exec(text);
  if (!match) return { status: null, steps: null };
  return { status: match[1], steps: Number(match[2]) };
}

/** The full text block, for a message the person can actually read. */
export function summaryText(result: McpToolResult): string {
  return result.content.find((c) => c.type === 'text')?.text ?? '(no summary)';
}

/** The last image block (the final page, per buildToolResult's ordering), as a data: URL. */
export function lastScreenshotDataUrl(result: McpToolResult): string | null {
  const images = result.content.filter((c) => c.type === 'image' && c.data);
  const last = images[images.length - 1];
  if (!last || !last.data) return null;
  return `data:${last.mimeType ?? 'image/jpeg'};base64,${last.data}`;
}
