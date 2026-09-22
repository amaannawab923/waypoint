import { useEffect, useState } from 'react';
import {
  clearUltrafastKey,
  getUltrafastStatus,
  saveUltrafastKey,
  testUltrafast,
} from '@/data/ultrafastApi';
import type { UltrafastStatus, UltrafastTestResult } from '@/types/ultrafast';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';

/**
 * Settings → Agents: Ultrafast browser tasks (docs/design/
 * ultrafast-browser-tasks.md). A session's verify-in-browser step can hand
 * a multi-step walk to a fast decision model (TypeSafe/jev) instead of
 * driving the page one tool call at a time — this section is where the
 * founder pastes the TypeSafe key, sees whether this machine can actually
 * run it, and tries it once before trusting a session with it.
 *
 * Same "one field, saved on change" posture as DefaultProviderSetting
 * above it, plus the Save/Clear/Test buttons a secret and a real host
 * dependency (uv) both need before this can honestly say "ready".
 */
export function UltrafastBrowserTasksSetting() {
  const [status, setStatus] = useState<UltrafastStatus | null>(null);
  const [keyInput, setKeyInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);

  const load = () => {
    getUltrafastStatus()
      .then(setStatus)
      .catch(() => setStatus(null));
  };

  useEffect(() => {
    load();
  }, []);

  async function handleSave() {
    if (!keyInput.trim() || saving) return;
    setSaving(true);
    setSaveMessage(null);
    try {
      const result = await saveUltrafastKey(keyInput.trim());
      if (result.ok) {
        setKeyInput('');
        load();
      } else {
        setSaveMessage(result.message);
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleClear() {
    await clearUltrafastKey();
    setSaveMessage(null);
    load();
  }

  async function handleTest() {
    setTesting(true);
    setTestError(null);
    try {
      const result = await testUltrafast();
      setStatus((prev) => (prev ? { ...prev, lastTest: result } : prev));
      if (!result.ok) setTestError(result.message);
    } catch (error) {
      setTestError(error instanceof Error ? error.message : 'The test failed.');
    } finally {
      setTesting(false);
    }
  }

  const line = status ? statusLine(status, testing) : null;

  return (
    <section
      data-ultrafast-settings
      className="rounded-[var(--radius-lg)] border border-border bg-surface p-4"
    >
      <div className="mb-3">
        <h3 className="text-sm font-semibold text-text">
          Ultrafast browser tasks
        </h3>
        <p className="mt-1 text-xs text-text-secondary">
          Lets a session hand a multi-step browser walk (sign in, fill a form,
          reach a page) to a fast decision model instead of driving it one step
          at a time. While a session runs a browser task, the page&apos;s text
          and controls go to TypeSafe; the values typed into fields still come
          from your own Claude subscription, the same as every other prompt.
          Nothing runs until you save a key below.
        </p>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          type="password"
          aria-label="TypeSafe API key"
          placeholder={
            status?.key.configured
              ? `Configured (${status.key.tail})`
              : 'Paste your TypeSafe API key'
          }
          value={keyInput}
          onChange={(e) => setKeyInput(e.target.value)}
          className="h-8 min-w-0 flex-1 rounded-[var(--radius-sm)] border border-border-strong bg-bg px-2.5 text-sm text-text outline-none focus:border-accent"
        />
        <Button
          size="xs"
          variant="primary"
          disabled={!keyInput.trim() || saving}
          onClick={() => {
            handleSave().catch(() => {});
          }}
        >
          {saving ? 'Saving…' : 'Save'}
        </Button>
        {status?.key.configured && status.key.source === 'settings' && (
          <Button
            size="xs"
            variant="secondary"
            onClick={() => {
              handleClear().catch(() => {});
            }}
          >
            Clear
          </Button>
        )}
      </div>
      {status?.key.source === 'env' && (
        <p className="mb-3 text-xs text-text-muted" data-key-source="env">
          Using <span className="font-mono">TYPESAFE_API_KEY</span> from{' '}
          <span className="font-mono">.env</span> ({status.key.tail}). A key
          saved here takes precedence.
        </p>
      )}
      {saveMessage && <p className="mb-3 text-xs text-danger">{saveMessage}</p>}

      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-text-secondary">
        {line && <Badge tone={line.tone}>{line.text}</Badge>}
        <Button
          size="xs"
          disabled={!status?.key.configured || testing}
          onClick={() => {
            handleTest().catch(() => {});
          }}
        >
          {testing ? 'Testing…' : 'Test'}
        </Button>
      </div>

      {testError && <p className="mb-3 text-xs text-danger">{testError}</p>}

      {status?.lastTest && <LastTestSummary result={status.lastTest} />}
    </section>
  );
}

type StatusTone = 'neutral' | 'warning' | 'success' | 'danger';

// F19 (tech-lead review, 2026-09-22): "Ready" used to mean only
// uv + key + provisioned — it never looked at scriptsInstalled (a
// missing-scripts install, a bad build, could satisfy every one of those
// and still never explain why the tool never shows up in a session) or
// registered (whether the daemon actually has browser_task registered
// right now, F15's own isUltrafastRegistered() — the gap that let "Ready"
// show green in the exact window between a key save and the daemon
// actually picking it up). "Ready" now means what it says: a session
// started right now would see the tool.
function statusLine(
  status: UltrafastStatus,
  testing: boolean,
): { text: string; tone: StatusTone } {
  if (testing) return { text: 'Testing…', tone: 'neutral' };
  if (!status.uvAvailable) {
    return {
      text: 'uv missing — install it from docs.astral.sh/uv',
      tone: 'warning',
    };
  }
  if (!status.scriptsInstalled) {
    return {
      text: "This install is missing Ultrafast's own scripts",
      tone: 'danger',
    };
  }
  if (!status.key.configured) {
    return { text: 'Not configured', tone: 'neutral' };
  }
  if (!status.provisioned) {
    return {
      text: 'Not provisioned yet — Test will set it up',
      tone: 'neutral',
    };
  }
  if (!status.registered) {
    return {
      text: 'Configured, but not registered with a session yet',
      tone: 'neutral',
    };
  }
  return { text: 'Ready', tone: 'success' };
}

function LastTestSummary({ result }: { result: UltrafastTestResult }) {
  return (
    <div className="mt-2 border-t border-border pt-3">
      <p className="text-xs text-text-secondary">
        {result.ok
          ? `Last test: ${result.steps ?? '?'} step(s) in ${result.elapsedMs ?? '?'}ms · status: ${result.status ?? 'unknown'}`
          : `Last test failed: ${result.message}`}
      </p>
      {result.screenshotDataUrl && (
        <img
          src={result.screenshotDataUrl}
          alt="Ultrafast test — final page"
          className="mt-2 max-w-xs rounded-[var(--radius-sm)] border border-border"
        />
      )}
    </div>
  );
}
