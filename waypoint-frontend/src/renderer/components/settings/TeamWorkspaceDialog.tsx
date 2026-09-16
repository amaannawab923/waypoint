import { useState } from 'react';
import { Copy } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import {
  createTeamWorkspace,
  createWorkspaceInvite,
  setActiveWorkspace,
  HostedApiError,
} from '@/data/hostedWorkspace';

/** AT12 (ROAD-147). The "Invite your team" quickstart card's actual flow —
 * functional, not the mockup's multi-screen visual treatment (that's a
 * named follow-up). Home for a hosted Team workspace: sign in if needed
 * (main's account:signIn primitive, AT10), create the workspace, make it
 * the active one, and hand back a copyable invite link. The invitee's own
 * side of this is entirely server-rendered (join.routes.ts) — nothing
 * here reaches them directly. */

type Step = 'form' | 'signing-in' | 'invite';

function readableSignInError(reason: string, message: string): string {
  if (reason === 'cancelled') return 'Sign-in was cancelled.';
  return message || 'Sign-in failed. Try again.';
}

export function TeamWorkspaceDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [step, setStep] = useState<Step>('form');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inviteLink, setInviteLink] = useState('');
  const [linkCopied, setLinkCopied] = useState(false);

  function reset() {
    setStep('form');
    setName('');
    setBusy(false);
    setError(null);
    setInviteLink('');
    setLinkCopied(false);
  }

  function handleClose() {
    reset();
    onClose();
  }

  async function handleCreate() {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setError(null);
    setBusy(true);
    try {
      const status = await window.electron.account.status();
      if (!status.connected) {
        setStep('signing-in');
        const signInResult = await window.electron.account.signIn({
          purpose: 'create-workspace',
        });
        if (!signInResult.ok) {
          setStep('form');
          setBusy(false);
          setError(
            readableSignInError(signInResult.reason, signInResult.message),
          );
          return;
        }
        setStep('form');
      }

      const workspace = await createTeamWorkspace(trimmed);
      await setActiveWorkspace(workspace.id);
      const invite = await createWorkspaceInvite(workspace.id);
      setInviteLink(invite.joinUrl);
      setStep('invite');
    } catch (err) {
      setStep('form');
      setError(
        err instanceof HostedApiError
          ? err.message
          : 'Something went wrong. Try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleCancelSignIn() {
    await window.electron.account.cancelSignIn();
    setStep('form');
    setBusy(false);
  }

  async function handleCopyLink() {
    try {
      await navigator.clipboard.writeText(inviteLink);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 1500);
    } catch {
      // Clipboard access can fail — the link is still shown for manual copy.
    }
  }

  if (step === 'signing-in') {
    return (
      <Modal
        open={open}
        onClose={handleCancelSignIn}
        title="Create a team workspace"
        footer={
          <Button variant="secondary" size="sm" onClick={handleCancelSignIn}>
            Cancel
          </Button>
        }
      >
        <p className="text-sm text-text-secondary">
          Finish signing in in the browser window that just opened. This dialog
          will continue once you're done.
        </p>
      </Modal>
    );
  }

  if (step === 'invite') {
    return (
      <Modal
        open={open}
        onClose={handleClose}
        title="Invite your team"
        footer={
          <Button variant="primary" size="sm" onClick={handleClose}>
            Done
          </Button>
        }
      >
        <div className="flex flex-col gap-3">
          <p className="text-sm text-text-secondary">
            Your workspace is ready. Share this link with teammates to bring
            them in.
          </p>
          <div className="flex items-center gap-2">
            <input
              readOnly
              value={inviteLink}
              onFocus={(e) => e.currentTarget.select()}
              className="h-8 flex-1 rounded-[var(--radius-sm)] border border-border-strong bg-bg px-3 font-mono text-xs text-text-secondary outline-none"
            />
            <Button variant="secondary" size="sm" onClick={handleCopyLink}>
              <Copy size={13} />
              {linkCopied ? 'Copied' : 'Copy link'}
            </Button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Create a team workspace"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={handleClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={handleCreate}
            disabled={!name.trim() || busy}
          >
            {busy ? 'Creating…' : 'Create workspace'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-sm text-text-secondary">
          Bring teammates in so work can be assigned and reviewed together.
          You'll get a link to invite them after this.
        </p>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleCreate();
          }}
          placeholder="Workspace name"
          disabled={busy}
          className="h-9 w-full rounded-[var(--radius-sm)] border border-border-strong bg-bg px-3 text-sm text-text outline-none focus:border-accent disabled:opacity-50"
        />
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
