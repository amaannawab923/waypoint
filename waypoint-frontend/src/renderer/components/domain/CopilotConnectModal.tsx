import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/headless';
import { AlertTriangle, CheckCircle2, KeySquare, Loader2 } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';

type FlowState = 'prompt' | 'connecting' | 'success' | 'error';

// Anthropic's own token shape (code.claude.com/docs/en/authentication):
// "sk-ant-oat" prefixed. 20+ trailing chars is generous on purpose — this
// only needs to not under-match, since whatever it captures still goes
// through the real save/probe flow (copilot.auth.save) before ever being
// trusted or stored.
const TOKEN_PATTERN = /sk-ant-oat[\w-]{20,}/;
const AUTHORIZE_URL_PATTERN =
  /https:\/\/claude\.com\/cai\/oauth\/authorize\?[^\s"'<>]+/;

// Neither pattern is end-anchored (a token/URL has no fixed length), so a
// match found the instant new data lands can just be a still-growing
// prefix — the real thing this bit us on once already (see the module doc
// below). Debounce commits until output has gone quiet for this long,
// re-matching against the latest buffer each time; a still-pending timer is
// resolved immediately on process exit instead, since nothing else is ever
// coming after that.
const SETTLE_DEBOUNCE_MS = 150;

/**
 * Runs `claude setup-token` (issue: connecting a Claude subscription
 * shouldn't require a terminal) entirely inside the app: a real pseudo-
 * terminal process (main process, node-pty) whose output streams here and
 * gets fed into a real @xterm/headless terminal instance — no DOM/canvas
 * involved at all, used purely to correctly resolve the CLI's ANSI/cursor-
 * positioned output into an actual screen buffer. That resolved text is
 * scanned for the OAuth URL (auto-opened via shell.openExternal) and the
 * final printed token, which is handed to the same copilot.auth.save flow
 * the manual-paste path already uses — this component's only job is
 * getting a candidate token string without a terminal, not re-implementing
 * validation or storage.
 *
 * A hand-written regex parser over the raw byte stream was tried first and
 * got a real, live-captured token wrong — a line-wrapped continuation and a
 * literal inserted space are indistinguishable without actually emulating
 * terminal state. @xterm/headless is the same core buffer/state engine that
 * powers @xterm/xterm (and VS Code's own integrated terminal), packaged
 * without the DOM renderer; reading its resolved buffer sidesteps that
 * failure mode entirely instead of trying to out-clever it.
 */
export function CopilotConnectModal({
  open,
  onClose,
  onConnected,
}: {
  open: boolean;
  onClose: () => void;
  onConnected: (last4: string) => void;
}) {
  const [state, setState] = useState<FlowState>('prompt');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [showFallback, setShowFallback] = useState(false);
  const [manualToken, setManualToken] = useState('');
  const [manualSaving, setManualSaving] = useState(false);
  const [manualError, setManualError] = useState<string | null>(null);

  const cleanupRef = useRef<(() => void) | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const urlOpenedRef = useRef(false);
  const settledRef = useRef(false);
  const settleTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function clearSettleTimer() {
    if (settleTimeoutRef.current) {
      clearTimeout(settleTimeoutRef.current);
      settleTimeoutRef.current = null;
    }
  }

  function teardown() {
    clearSettleTimer();
    cleanupRef.current?.();
    cleanupRef.current = null;
    termRef.current?.dispose();
    termRef.current = null;
  }

  // Resets to the initial prompt every time the modal opens fresh — this is
  // a one-shot connect flow, not something that should resume mid-state
  // from a previous, possibly-abandoned attempt.
  useEffect(() => {
    if (!open) {
      teardown();
      setState('prompt');
      setErrorMessage(null);
      setShowFallback(false);
      setManualToken('');
      setManualError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Unmount: stop listening, but — matching CopilotPanel.tsx's own
  // established reasoning for its streaming run — don't kill a still-live
  // process. If sign-in genuinely completes after the modal is gone, the
  // renderer has already stopped listening for it either way; killing it
  // would only turn a possibly-still-successful flow into a guaranteed
  // failure for no benefit.
  useEffect(() => {
    return () => teardown();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Joined with no separator, not '\n': a real, live-captured line-wrap
  // (the CLI emits its own `\r` + cursor-down to redraw a wrapped line, so
  // xterm's `isWrapped` flag — set only for its own automatic soft-wraps —
  // stays false on that row, making "genuine newline" and "simulated wrap"
  // indistinguishable from buffer state alone) would otherwise insert a
  // literal break in the middle of a token or URL that only reads as
  // contiguous once flattened. Safe for what this is actually used for:
  // TOKEN_PATTERN and AUTHORIZE_URL_PATTERN are both self-terminating on
  // whitespace/punctuation outside their own character classes, so
  // flattening a genuine line break elsewhere just can't produce a false
  // match.
  function bufferText(term: Terminal): string {
    const buf = term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buf.length; i += 1) {
      const line = buf.getLine(i);
      if (line) lines.push(line.translateToString(true));
    }
    return lines.join('');
  }

  async function finishWithToken(token: string) {
    const result = await window.electron.copilot.auth.save(token);
    if (result.ok) {
      setState('success');
      setTimeout(() => {
        onConnected(result.last4);
        onClose();
      }, 1400);
    } else {
      setState('error');
      setErrorMessage(result.message);
    }
  }

  function startConnect() {
    setState('connecting');
    setErrorMessage(null);
    setShowFallback(false);
    urlOpenedRef.current = false;
    settledRef.current = false;

    const requestId = `connect-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const term = new Terminal({ cols: 120, rows: 40, allowProposedApi: true });
    termRef.current = term;

    // Fires after any settle-quiet period (or immediately on exit) — always
    // re-reads the buffer fresh rather than trusting a match captured
    // earlier, since more data may have landed while the timer was pending.
    function checkSettled() {
      if (!termRef.current || settledRef.current) return;
      const text = bufferText(termRef.current);

      if (!urlOpenedRef.current) {
        const urlMatch = text.match(AUTHORIZE_URL_PATTERN);
        if (urlMatch) {
          urlOpenedRef.current = true;
          window.electron.copilot.auth.openExternal(urlMatch[0]);
        }
      }

      const tokenMatch = text.match(TOKEN_PATTERN);
      if (tokenMatch) {
        settledRef.current = true;
        teardown();
        finishWithToken(tokenMatch[0]);
      }
    }

    const unsubscribe = window.electron.copilot.auth.connect(requestId, {
      // term.write() queues data for async processing rather than applying
      // it inline (xterm's own documented reason to offer this completion
      // callback) — scanning the buffer before it fires risks reading stale
      // text. Even once applied, don't act on a match immediately: neither
      // pattern is end-anchored, so a match can be a prefix that's still
      // growing in the next chunk — checkSettled() only actually runs once
      // output has gone quiet for SETTLE_DEBOUNCE_MS.
      onData: (chunk) => {
        term.write(chunk, () => {
          if (settledRef.current) return;
          clearSettleTimer();
          settleTimeoutRef.current = setTimeout(() => {
            settleTimeoutRef.current = null;
            checkSettled();
          }, SETTLE_DEBOUNCE_MS);
        });
      },
      onExit: ({ code, spawnError }) => {
        if (settledRef.current) return;
        // Nothing else is ever coming — resolve any pending match now
        // rather than waiting out the settle debounce.
        clearSettleTimer();
        checkSettled();
        if (settledRef.current) return;
        settledRef.current = true;
        setState('error');
        setErrorMessage(
          spawnError ??
            (code === 0
              ? "Didn't get a token back — try again."
              : `Sign-in exited unexpectedly (code ${code ?? 'unknown'}).`),
        );
      },
    });
    cleanupRef.current = unsubscribe;
  }

  function cancelConnect() {
    teardown();
    onClose();
  }

  async function saveManualToken() {
    if (!manualToken.trim() || manualSaving) return;
    setManualSaving(true);
    setManualError(null);
    const result = await window.electron.copilot.auth.save(manualToken.trim());
    setManualSaving(false);
    if (!result.ok) {
      setManualError(result.message);
      return;
    }
    setManualToken('');
    onConnected(result.last4);
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={state === 'connecting' ? cancelConnect : onClose}
      title="Connect Claude"
      width={380}
    >
      <div className="flex flex-col items-center gap-3 py-2 text-center">
        {state === 'prompt' && (
          <>
            <span className="flex size-13 items-center justify-center rounded-full bg-accent-soft-bg text-text">
              <KeySquare size={24} />
            </span>
            <p className="max-w-[30ch] text-sm text-text-secondary">
              We&apos;ll open your browser to sign in with Anthropic. Nothing to
              copy or paste.
            </p>
            <Button
              variant="primary"
              onClick={startConnect}
              className="mt-2 w-full"
            >
              Continue in browser
            </Button>
          </>
        )}

        {state === 'connecting' && (
          <>
            <span className="flex size-13 items-center justify-center rounded-full bg-accent-soft-bg text-text">
              <Loader2 size={24} className="animate-spin" />
            </span>
            <p className="text-sm font-medium text-text">
              Waiting for sign-in…
            </p>
            <p className="max-w-[30ch] text-sm text-text-secondary">
              A browser window opened to sign in with Anthropic. Come back here
              once you&apos;re done.
            </p>
            <Button
              variant="ghost"
              onClick={cancelConnect}
              className="mt-1 w-full"
            >
              Cancel
            </Button>
          </>
        )}

        {state === 'success' && (
          <>
            <span className="flex size-13 items-center justify-center rounded-full bg-success-bg text-success">
              <CheckCircle2 size={24} />
            </span>
            <p className="text-sm font-medium text-text">Connected</p>
            <p className="text-sm text-text-secondary">
              Copilot will use your subscription from now on.
            </p>
          </>
        )}

        {state === 'error' && (
          <>
            <span className="flex size-13 items-center justify-center rounded-full bg-danger-bg text-danger">
              <AlertTriangle size={24} />
            </span>
            <p className="text-sm font-medium text-text">
              Couldn&apos;t connect
            </p>
            {errorMessage && (
              <p className="max-w-[32ch] text-sm text-text-secondary">
                {errorMessage}
              </p>
            )}
            <Button
              variant="primary"
              onClick={startConnect}
              className="mt-1 w-full"
            >
              Try again
            </Button>
            <button
              type="button"
              onClick={() => setShowFallback((v) => !v)}
              className="mt-1 cursor-pointer text-xs text-text-muted underline underline-offset-2"
            >
              Having trouble? Paste a token manually
            </button>
            {showFallback && (
              <div className="mt-2 flex w-full flex-col gap-2 rounded-[var(--radius)] border border-dashed border-border-strong bg-surface-2 p-3 text-left">
                <p className="text-xs text-text-muted">
                  Run{' '}
                  <code className="rounded bg-surface px-1 py-0.5 font-mono text-[11px] text-text">
                    claude setup-token
                  </code>{' '}
                  in a terminal and paste the result here.
                </p>
                <input
                  type="password"
                  value={manualToken}
                  onChange={(e) => {
                    setManualToken(e.target.value);
                    setManualError(null);
                  }}
                  placeholder="sk-ant-oat..."
                  className="h-8 rounded-[var(--radius-sm)] border border-border-strong bg-bg px-2 font-mono text-xs text-text outline-none focus:border-accent"
                  autoComplete="off"
                  spellCheck={false}
                  aria-label="Subscription token"
                />
                {manualError && (
                  <p className="text-xs text-danger">{manualError}</p>
                )}
                <Button
                  variant="primary"
                  size="sm"
                  disabled={!manualToken.trim() || manualSaving}
                  onClick={saveManualToken}
                >
                  {manualSaving ? 'Validating…' : 'Save token'}
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
