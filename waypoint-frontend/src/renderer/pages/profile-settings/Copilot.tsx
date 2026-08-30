import { useEffect, useState } from 'react';
import { CheckCircle2, KeySquare } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';

const inputClass =
  'h-9 w-full rounded-[var(--radius-sm)] border border-border-strong bg-bg px-3 font-mono text-sm text-text outline-none focus:border-accent';

type Status = { connected: boolean; last4: string | null };

/**
 * Lets a user connect their own Claude subscription to Copilot without ever
 * opening a terminal for the app's own sake — the gap this exists to close:
 * before this, an expired/missing Claude Code login surfaced only as a
 * dead-end inline error in the chat panel ("run `claude login`"), with no
 * way to recover short of leaving the app.
 *
 * This still isn't the app performing OAuth or touching Claude.ai
 * credentials — that's against Anthropic's terms for third-party apps, and
 * is why Copilot shells out to the real `claude` CLI in the first place
 * instead of calling Anthropic's API directly. What's pasted here is a
 * token the user generates themselves, once, via Anthropic's own
 * `claude setup-token` command — a real, documented CLI command scoped to
 * inference only, tied to the user's own subscription. One terminal command
 * up front buys never needing one again after that: the token is long-lived
 * and gets picked up automatically on every future Copilot run.
 */
export default function Copilot() {
  const [status, setStatus] = useState<Status | null>(null);
  const [token, setToken] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justConnected, setJustConnected] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function loadStatus() {
      const s = await window.electron.copilot.auth.status();
      if (!cancelled) setStatus(s);
    }
    loadStatus();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleConnect() {
    if (!token.trim() || saving) return;
    setSaving(true);
    setError(null);
    const result = await window.electron.copilot.auth.save(token.trim());
    setSaving(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setToken('');
    setStatus({ connected: true, last4: result.last4 });
    setJustConnected(true);
    setTimeout(() => setJustConnected(false), 2500);
  }

  async function handleDisconnect() {
    await window.electron.copilot.auth.clear();
    setStatus({ connected: false, last4: null });
  }

  return (
    <div className="max-w-lg">
      <h2 className="mb-1 font-display text-lg font-medium text-text">
        Copilot
      </h2>
      <p className="mb-6 text-sm text-text-secondary">
        Connect your own Claude subscription so Copilot keeps working without
        needing a terminal every time your login lapses.
      </p>

      {status?.connected && (
        <div className="mb-6 flex items-center justify-between gap-3 rounded-[var(--radius-lg)] border border-border bg-surface p-3.5">
          <div className="flex items-center gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-surface-2 text-text-secondary">
              <KeySquare size={16} />
            </span>
            <div>
              <p className="text-sm text-text">Claude subscription connected</p>
              <p className="font-mono text-xs text-text-muted">
                •••• {status.last4}
              </p>
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={handleDisconnect}>
            Disconnect
          </Button>
        </div>
      )}

      {justConnected && (
        <div className="mb-6 flex items-center gap-2 text-sm text-success">
          <CheckCircle2 size={15} />
          Connected — Copilot will use this from now on.
        </div>
      )}

      {status && !status.connected && (
        <div className="mb-8">
          <h3 className="mb-1 font-display text-sm font-medium text-text">
            Connect a subscription token
          </h3>
          <ol className="mb-4 list-inside list-decimal text-sm text-text-secondary">
            <li>
              Run{' '}
              <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-text">
                claude setup-token
              </code>{' '}
              in a terminal — this opens your browser to sign in and prints a
              token.
            </li>
            <li>Copy that token and paste it below.</li>
          </ol>
          <div className="flex flex-col gap-3">
            <div>
              <label
                className="mb-1.5 block text-sm font-medium text-text"
                htmlFor="claude-token"
              >
                Subscription token
              </label>
              <input
                id="claude-token"
                type="password"
                className={inputClass}
                value={token}
                onChange={(e) => {
                  setToken(e.target.value);
                  setError(null);
                }}
                placeholder="sk-ant-oat..."
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            {error && (
              <Badge tone="danger" outline>
                {error}
              </Badge>
            )}
            <div>
              <Button
                variant="primary"
                disabled={!token.trim() || saving}
                onClick={handleConnect}
              >
                {saving ? 'Validating…' : 'Connect'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
