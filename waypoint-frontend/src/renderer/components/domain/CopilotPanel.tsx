import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { clsx } from 'clsx';
import { ArrowLeft, Plus, Send, Sparkles, X } from 'lucide-react';
import {
  postCopilotUserMessage,
  postCopilotAssistantMessage,
} from '@/mock/api';
import { useCopilotConversations } from '@/lib/useCopilotConversations';
import { useCopilotProposals } from '@/lib/useCopilotProposals';
import { interleaveProposals } from '@/lib/copilotTranscript';
import type { CopilotSessionMessageRole } from '@/lib/copilotSessions';
import { renderMarkdown } from '@/lib/markdown';
import { IconButton, Button } from '@/components/ui/Button';
import { CopilotSessionList } from './CopilotSessionList';
import { CopilotProposalCard } from './CopilotProposalCard';
import { CopilotConnectModal } from './CopilotConnectModal';

// Not crypto.randomUUID(): this project's jsdom test environment doesn't
// reliably provide it (see main/preload.test.ts's identical note) and the
// `uuid` dependency ships ESM-only, which ts-jest's default CJS transform
// can't consume without reconfiguring shared Jest settings. These ids are
// local-optimistic only — replaced by nothing (kept as-is, see handleSend's
// comment) once the real POST resolves, and removed outright if it fails —
// so non-cryptographic collision resistance is more than sufficient.
function generateLocalId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// Rendered via lib/markdown.ts's small hand-rolled renderer (same one
// AgentDetailPage.tsx uses for agent-brief previews) rather than a new
// dependency — real Claude Code replies lean on bold/lists/code/links
// heavily enough that plain text was genuinely hard to read (literal `**`
// and `- ` markers, no distinction between prose and code). inline() there
// escapes HTML before adding any tags, so this is safe against a reply (or
// a pasted user message) containing raw HTML/script content.
function MessageBubble({
  message,
}: {
  message: { role: CopilotSessionMessageRole; content: string };
}) {
  return (
    <div
      className={clsx(
        'flex flex-col gap-1',
        message.role === 'user' ? 'items-end' : 'items-start',
      )}
    >
      <div
        className={clsx(
          'copilot-md max-w-[85%] rounded-[var(--radius)] px-3.5 py-2.5 text-sm leading-relaxed break-words',
          message.role === 'user'
            ? 'bg-accent text-on-accent'
            : 'border border-border bg-surface-2 text-text',
        )}
        dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }}
      />
    </div>
  );
}

// Shown in place of an assistant MessageBubble while a run is in flight but
// hasn't produced any tokens yet — replaces a static "…" character, which
// looked inert/stuck rather than visibly in-progress. Three bouncing dots,
// same bubble chrome as a real assistant reply so it doesn't jump position
// once real text starts arriving. prefers-reduced-motion swaps the bounce
// for a plain static dim, matching this app's existing @media
// (prefers-reduced-motion: reduce) convention (see index.css).
function TypingIndicator() {
  return (
    <div className="flex flex-col items-start gap-1">
      <div className="copilot-typing max-w-[85%] rounded-[var(--radius)] border border-border bg-surface-2 px-3.5 py-3">
        <span className="copilot-typing-dot" />
        <span className="copilot-typing-dot" />
        <span className="copilot-typing-dot" />
      </div>
    </div>
  );
}

function Composer({
  disabled,
  onSend,
}: {
  disabled: boolean;
  onSend: (content: string) => Promise<void>;
}) {
  const [value, setValue] = useState('');
  const [sending, setSending] = useState(false);

  async function submit() {
    const content = value.trim();
    if (!content || disabled || sending) return;
    setSending(true);
    try {
      await onSend(content);
      setValue('');
    } catch {
      // A rejected send (network error, validation) already surfaces via
      // httpClient.ts's toast — the important thing here is what NOT to
      // do: don't clear the draft. It previously cleared unconditionally
      // before knowing whether the send even succeeded, silently
      // discarding what the user typed on any failure.
    } finally {
      setSending(false);
    }
  }

  const composerDisabled = disabled || sending;

  return (
    <div className="flex items-end gap-2 border-t border-border px-4 py-3">
      <textarea
        value={value}
        disabled={composerDisabled}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        rows={1}
        placeholder="Ask Copilot…"
        className="thin-scroll max-h-28 min-h-9 flex-1 resize-none rounded-[var(--radius-sm)] border border-border-strong bg-bg px-3 py-2 text-sm outline-none focus:border-accent disabled:opacity-50"
      />
      <IconButton
        label="Send"
        onClick={submit}
        disabled={composerDisabled || !value.trim()}
        className="mb-0.5 disabled:opacity-40"
      >
        <Send size={16} />
      </IconButton>
    </div>
  );
}

/**
 * Persistent right-hand chat panel — conditionally mounted by AppShell.tsx
 * (only while `copilotOpen`), with NO backdrop, unlike Modal.tsx/
 * WorkItemDrawer.tsx's portal convention this otherwise mirrors — the rest
 * of the app stays interactive while this is open. Positioned below the
 * topbar (not inset-y-0, which would run under it) so the topbar —
 * including the toggle that opened this panel — stays visible and
 * clickable, not hidden behind the panel's own z-index.
 *
 * Holds two views in one panel (issue #11): a session list and a chat, both
 * ~400px wide, swapped in place rather than via a separate sidebar or route
 * — see CopilotSessionList.tsx for the list. Sessions/messages/titles are
 * backend-persisted via useCopilotConversations.ts (issue #11's migration
 * off the earlier local-only pass) — pin state and manual list ordering
 * stay local-only (see copilotSessionMeta.ts), since neither is part of
 * what the backend tracks. The real `window.electron.copilot.runPrompt`
 * streaming flow (issue #7) is unchanged — only where its result gets
 * persisted has moved.
 *
 * An `auth_failed` run error (issue #7's chat panel hitting "not logged
 * in") gets its own distinct recovery action — "Connect your Claude
 * subscription" (issue: connecting a subscription token shouldn't require
 * a terminal, see CopilotConnectModal.tsx) — instead of a dead-end generic
 * "Try again". The exact prompt that hit the error auto-retries, in the
 * *same session it failed in*, the moment a working connection exists, so
 * nothing has to be re-typed or re-sent.
 */
export function CopilotPanel({ onClose }: { onClose: () => void }) {
  const [visible, setVisible] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const sessionStore = useCopilotConversations();
  const { sessions, loading: listLoading, error: listError } = sessionStore;

  // null = session-list view. Always starts on the list on open — this
  // panel is conditionally (un)mounted by AppShell, so "closing and
  // reopening" always lands back on the list rather than trying to restore
  // whatever chat happened to be open last time.
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const activeSession = activeSessionId
    ? (sessions.find((s) => s.id === activeSessionId) ?? null)
    : null;
  // Proposal cards for the open conversation (issue #10 / Copilot V2) —
  // fetched on open (the hook refetches whenever activeSessionId changes)
  // and refetched after every completed OR failed run, since a partial turn
  // may still have written proposals before dying.
  const proposalStore = useCopilotProposals(activeSessionId);
  // Set while a just-opened session's messages are still being fetched
  // (useCopilotConversations.ts's openSession) — the list endpoint doesn't
  // include messages, so there's a real gap between "chat view mounted" and
  // "its history is on screen" that wasn't there when everything lived in
  // localStorage.
  const [loadingMessages, setLoadingMessages] = useState(false);
  // Set when a session's lazy message fetch (openSession) fails — distinct
  // from a genuinely empty conversation, so a failed load shows a real error
  // with a retry instead of silently rendering as "Ask Copilot anything",
  // which would look identical to a brand-new session and hide that real
  // history failed to come down.
  const [messagesLoadError, setMessagesLoadError] = useState<{
    sessionId: string;
    message: string;
  } | null>(null);

  // A run's progressive text and any run-level error, each tagged with the
  // session they belong to — not just component-level state — so that
  // navigating back to the list mid-run (and possibly into a *different*
  // chat) can never show one session's in-flight reply under another's
  // header. null `streaming` means no run in progress; '' text means a run
  // just started with no tokens yet.
  const [streaming, setStreaming] = useState<{
    sessionId: string;
    text: string;
  } | null>(null);
  // `kind` drives the run-error UI: 'auth_failed' gets the real "Connect
  // your Claude subscription" action; 'save_failed' means the reply itself
  // streamed fine but persisting it afterward failed (see runAndPersist's
  // onDone) — its retry just re-POSTs the already-generated text instead of
  // spending a second real Claude Code turn; everything else falls back to
  // a plain "Try again" that re-runs the prompt. A synchronous-throw
  // failure (window.electron missing entirely) has no real `kind` to
  // report, so it falls back to 'generic'.
  const [runError, setRunError] = useState<{
    sessionId: string;
    message: string;
    kind: 'binary_not_found' | 'auth_failed' | 'save_failed' | 'generic';
  } | null>(null);
  const [lastFailedPrompt, setLastFailedPrompt] = useState<string | null>(null);
  // Set only on a save_failed error — the already-generated reply text and
  // Claude Code session id, kept around so "Try again" there can re-POST
  // the exact same reply rather than re-running the prompt.
  const [pendingAssistantReply, setPendingAssistantReply] = useState<{
    sessionId: string;
    content: string;
    claudeSessionId: string | null;
  } | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const unsubscribeStreamRef = useRef<(() => void) | null>(null);
  // Bumped, per session, at the start of every runAndPersist call for that
  // session; each call's onChunk/onDone/onError closures capture the value
  // current at their own start and compare against the ref before touching
  // any state. A run's own process can outlive the run logically
  // "finishing" on this side (e.g. an auth_error is reported immediately
  // while the CLI is still mid-retry internally, or the user hits "Try
  // again" on a run that never actually exited) — without this guard, a
  // late chunk from that stale run would land in the same `streaming` state
  // a newer run is now writing to, interleaving two replies into one
  // bubble.
  //
  // Keyed by sessionId, not a single shared counter: multi-session means a
  // user can plausibly start a run in session A, switch away, and start a
  // second run in session B while A's is still in flight — a single global
  // counter would mark A's own, still-legitimate run stale the moment B's
  // starts, silently discarding A's real reply (and the subscription usage
  // spent generating it) with no error, no retry, nothing. Each session
  // tracks its own generation so concurrent runs across different sessions
  // can complete independently, while a superseded run *within the same*
  // session is still correctly ignored.
  const runGenerationRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  // If the active session ever disappears from under the chat view (e.g.
  // it was deleted from the list, or from another instance of this app),
  // fall back to the list instead of rendering a chat header/composer for a
  // session that no longer exists.
  useEffect(() => {
    if (activeSessionId && !sessions.some((s) => s.id === activeSessionId)) {
      setActiveSessionId(null);
    }
  }, [activeSessionId, sessions]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Only close (and only let the focus-restore effect below fire) if
      // focus is actually inside this panel. Without this check, Escape
      // fired regardless of what had focus — keydown bubbles to `document`
      // no matter where the user's actual focus is — so pressing Escape
      // while typing in, say, the global search input closed Copilot AND
      // yanked focus away from that unrelated input to restore it to the
      // topbar toggle instead.
      if (
        panelRef.current &&
        !panelRef.current.contains(document.activeElement)
      )
        return;
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // AppShell conditionally mounts this component only while open, so a
  // plain mount/unmount effect lines up exactly with open/close either way
  // (Escape or the topbar toggle) — no need for Modal.tsx's `[open]`-only
  // variant of this same fix, since that component stays mounted and
  // toggles its own visibility instead. Without this, closing via Escape
  // dropped focus to <body> with nothing to return it to the topbar
  // toggle — the same loss-of-place bug Modal.tsx already fixed once (see
  // its previousFocusRef comment) for keyboard and screen-reader users.
  // Safe to always restore here (no "was focus inside the panel" guard
  // needed on this side) because the Escape listener above already
  // guarantees Escape-triggered closes only happen when focus was inside;
  // the other close paths (the panel's own × button, the topbar toggle)
  // are direct clicks, which already leave focus exactly where restoring
  // would put it anyway.
  const previousFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    return () => {
      previousFocusRef.current?.focus?.();
    };
  }, []);

  // Unsubscribes from any in-flight run's IPC listener on unmount, but does
  // NOT cancel the main-process subprocess itself — the run is left to
  // finish and its result is simply dropped if the panel is gone. Killing
  // it would waste a turn Claude Code already spent tokens on, and would
  // orphan Claude Code's own --resume state for no benefit.
  useEffect(() => {
    return () => {
      unsubscribeStreamRef.current?.();
    };
  }, []);

  async function runAndPersist(
    sessionId: string,
    content: string,
    resumeSessionId: string | undefined,
    // Un-notified proposal outcomes riding along with this run — the text
    // goes to the model via stdin (never persisted as a message), and the
    // ids are marked notified ONLY once the run's reply persists, so a
    // failed run re-delivers the same outcomes next turn (harmless
    // duplication beats a lost outcome).
    outcome: { text: string; ids: string[] } | null = null,
  ) {
    const generation = (runGenerationRef.current.get(sessionId) ?? 0) + 1;
    runGenerationRef.current.set(sessionId, generation);
    const isStale = () =>
      runGenerationRef.current.get(sessionId) !== generation;

    setStreaming({ sessionId, text: '' });
    setRunError(null);
    setLastFailedPrompt(null);
    setPendingAssistantReply(null);

    await new Promise<void>((resolve) => {
      // Guarded explicitly, not left to throw past this function: a throw
      // here (e.g. the preload bridge itself failed to load, so
      // window.electron.copilot is missing) previously left the streaming
      // bubble stuck forever — nothing else in this function would ever
      // clear it, since only onChunk/onDone/onError do, and none of those
      // get a chance to run. Treated the same as a reported run failure.
      try {
        const unsubscribe = window.electron.copilot.runPrompt(
          {
            prompt: content,
            resumeSessionId,
            // The conversation id rides to the backend as an MCP header so
            // propose_* rows land in THIS conversation; the preamble rides
            // stdin only — postCopilotUserMessage above already persisted
            // the user's own text and nothing else.
            conversationId: sessionId,
            ...(outcome ? { outcomePreamble: outcome.text } : {}),
          },
          {
            onChunk: (text) => {
              if (isStale()) return;
              setStreaming((prev) =>
                prev && prev.sessionId === sessionId
                  ? { sessionId, text: prev.text + text }
                  : prev,
              );
            },
            onDone: async ({ fullText, sessionId: claudeSessionId }) => {
              if (isStale()) return;
              setStreaming(null);
              // The turn is over either way — refetch proposal cards even
              // when the reply is empty or fails to save below, since the
              // model may have proposed changes before things went sideways.
              const reloadProposals = () =>
                proposalStore.reload().catch(() => {
                  // Non-fatal: the next open/run refetches, and httpClient
                  // already toasted.
                });
              // An empty (or whitespace-only) reply isn't a real answer to
              // keep — persisting it would leave a session with a blank
              // assistant bubble and nothing to retry but re-running the
              // whole prompt. "Try again" re-runs the prompt from scratch.
              if (!fullText.trim()) {
                await reloadProposals();
                setRunError({
                  sessionId,
                  message: "Copilot didn't return a reply — try again.",
                  kind: 'generic',
                });
                setLastFailedPrompt(content);
                resolve();
                return;
              }
              try {
                const persisted = await postCopilotAssistantMessage(
                  sessionId,
                  fullText,
                  claudeSessionId,
                );
                if (isStale()) {
                  resolve();
                  return;
                }
                sessionStore.appendMessageLocal(sessionId, {
                  id: persisted.id,
                  role: 'assistant',
                  content: persisted.content,
                  createdAt: persisted.createdAt,
                  seq: persisted.seq,
                });
                // Matches the backend's own never-clobber-with-null rule
                // (see copilot.service.ts's postAssistantMessage) — omit
                // claudeSessionId entirely rather than patching in null.
                sessionStore.patchConversationLocal(sessionId, {
                  updatedAt: persisted.createdAt,
                  ...(claudeSessionId !== null ? { claudeSessionId } : {}),
                });
                await reloadProposals();
                // Only now — the run completed AND its reply persisted —
                // are this run's delivered outcomes marked notified. A
                // failure anywhere above leaves modelNotifiedAt null so
                // the same preamble re-delivers next turn.
                if (outcome) {
                  await proposalStore.markNotified(outcome.ids).catch(() => {
                    // Failing to mark is safe: worst case the model hears
                    // the same outcome twice next turn.
                  });
                }
              } catch (err) {
                if (isStale()) {
                  resolve();
                  return;
                }
                // The run itself completed, so its proposals are real even
                // though saving the reply failed — show the cards.
                await reloadProposals();
                // The Claude Code run itself succeeded — don't discard a
                // real reply just because saving it failed. "Try again"
                // for this error kind re-POSTs the same text (see
                // retryRun), not a second real Claude Code turn.
                setRunError({
                  sessionId,
                  message: `Got a reply, but couldn't save it — ${err instanceof Error ? err.message : String(err)}`,
                  kind: 'save_failed',
                });
                setPendingAssistantReply({
                  sessionId,
                  content: fullText,
                  claudeSessionId,
                });
                resolve();
                return;
              }
              resolve();
            },
            onError: (err) => {
              if (isStale()) return;
              setStreaming(null);
              // A failed run can still have proposed before dying —
              // refetch so those cards appear instead of silently waiting
              // for the next successful turn. Fire-and-forget: the error
              // UI shouldn't block on it.
              proposalStore.reload().catch(() => {});
              setRunError({ sessionId, message: err.message, kind: err.kind });
              setLastFailedPrompt(content);
              resolve();
            },
          },
        );
        unsubscribeStreamRef.current = unsubscribe;
      } catch (err) {
        setStreaming(null);
        setRunError({
          sessionId,
          message: `Couldn't reach Copilot's runtime — ${err instanceof Error ? err.message : String(err)}`,
          kind: 'generic',
        });
        setLastFailedPrompt(content);
        resolve();
      }
    });
  }

  async function handleSend(content: string) {
    if (!activeSessionId) return;
    const sessionId = activeSessionId;
    const resumeSessionId = activeSession?.claudeSessionId ?? undefined;
    // The backend auto-titles a conversation from its first user message
    // (see postUserMessage) — the POST response below is just the message
    // row, not the updated title, so a reload is needed to pick it up. Only
    // worth doing on the actual first message; every later message leaves
    // the title alone server-side too.
    const isFirstMessage = (activeSession?.messages.length ?? 0) === 0;

    // Built BEFORE the user message posts, from the current proposal list:
    // the outcome note goes to the model on stdin only, while the POST
    // below persists nothing but the user's own words — the
    // transcript-pollution split this whole flow exists to preserve.
    const outcome = proposalStore.buildOutcomePreamble();

    // Optimistic — instant, same feel as the old local-only version — but
    // now backed by a real POST, so a failure needs a real rollback: unlike
    // a plain local append, this one can fail after already being on
    // screen.
    const localId = generateLocalId('msg');
    sessionStore.appendMessageLocal(sessionId, {
      id: localId,
      role: 'user',
      content,
      createdAt: new Date().toISOString(),
    });
    try {
      await postCopilotUserMessage(sessionId, content);
    } catch (err) {
      sessionStore.removeMessageLocal(sessionId, localId);
      throw err;
    }
    // No id reconciliation with the persisted row — nothing in the UI keys
    // off a message's real id besides React's `key` prop, and the stable
    // local id works fine there too.
    if (isFirstMessage) await sessionStore.reload();
    await runAndPersist(sessionId, content, resumeSessionId, outcome);
  }

  async function handleCreateSession() {
    const created = await sessionStore.createSession();
    setActiveSessionId(created.id);
  }

  async function handleOpenSession(id: string) {
    // Set immediately so the chat view mounts right away; messages arrive
    // once the lazy fetch below resolves (see the "Loading messages…"
    // placeholder further down).
    setActiveSessionId(id);
    setLoadingMessages(true);
    setMessagesLoadError(null);
    try {
      await sessionStore.openSession(id);
    } catch (err) {
      // useCopilotConversations.ts's openSession never wrote to its cache on
      // a failed fetch, so this session's messages stay unset — a later
      // retry (this error's "Try again", or simply reopening the session)
      // will genuinely re-fetch, not return a poisoned empty result.
      setMessagesLoadError({
        sessionId: id,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setLoadingMessages(false);
    }
  }

  function retryOpenSession() {
    if (!messagesLoadError) return;
    handleOpenSession(messagesLoadError.sessionId);
  }

  async function retrySaveReply(
    sessionId: string,
    content: string,
    claudeSessionId: string | null,
  ) {
    try {
      const persisted = await postCopilotAssistantMessage(
        sessionId,
        content,
        claudeSessionId,
      );
      sessionStore.appendMessageLocal(sessionId, {
        id: persisted.id,
        role: 'assistant',
        content: persisted.content,
        createdAt: persisted.createdAt,
      });
      sessionStore.patchConversationLocal(sessionId, {
        updatedAt: persisted.createdAt,
        ...(claudeSessionId !== null ? { claudeSessionId } : {}),
      });
      setPendingAssistantReply(null);
    } catch (err) {
      setRunError({
        sessionId,
        message: `Still couldn't save it — ${err instanceof Error ? err.message : String(err)}`,
        kind: 'save_failed',
      });
    }
  }

  function retryRun() {
    if (!runError) return;
    const { sessionId, kind } = runError;
    if (kind === 'save_failed' && pendingAssistantReply) {
      const { content, claudeSessionId } = pendingAssistantReply;
      setRunError(null);
      retrySaveReply(sessionId, content, claudeSessionId);
      return;
    }
    if (!lastFailedPrompt) return;
    const resumeSessionId =
      sessions.find((s) => s.id === sessionId)?.claudeSessionId ?? undefined;
    // Rebuilt rather than reusing the failed run's preamble — the failed
    // run never marked anything notified, so the same outcomes (plus any
    // resolved since) come back fresh here.
    runAndPersist(
      sessionId,
      lastFailedPrompt,
      resumeSessionId,
      proposalStore.buildOutcomePreamble(),
    );
  }

  const isStreamingHere =
    streaming !== null && streaming.sessionId === activeSessionId;
  const runErrorHere =
    runError && runError.sessionId === activeSessionId ? runError : null;
  const messagesLoadErrorHere =
    messagesLoadError && messagesLoadError.sessionId === activeSessionId
      ? messagesLoadError
      : null;
  const isEmpty =
    !!activeSession &&
    activeSession.messages.length === 0 &&
    !isStreamingHere &&
    !loadingMessages &&
    !messagesLoadErrorHere;

  return createPortal(
    <div
      ref={panelRef}
      className="fixed top-12 right-0 bottom-0 z-40 flex w-full max-w-[400px] flex-col border-l border-border bg-surface shadow-2xl transition-transform duration-200 ease-out"
      style={{ transform: visible ? 'translateX(0)' : 'translateX(100%)' }}
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-3.5">
        <div className="flex min-w-0 items-center gap-1">
          {activeSession && (
            <IconButton
              label="Back to sessions"
              onClick={() => setActiveSessionId(null)}
              className="-ml-1.5 shrink-0"
            >
              <ArrowLeft size={16} />
            </IconButton>
          )}
          <h2 className="truncate font-display text-sm font-medium text-text">
            {activeSession ? activeSession.title : 'Copilot'}
          </h2>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {activeSession &&
            proposalStore.proposals.some((p) => p.status === 'proposed') && (
              <button
                type="button"
                onClick={() => proposalStore.rejectAll().catch(() => {})}
                className="mr-1 text-xs font-medium whitespace-nowrap text-text-secondary hover:text-text hover:underline"
              >
                Reject all pending
              </button>
            )}
          {!activeSession && (
            <IconButton label="New session" onClick={handleCreateSession}>
              <Plus size={16} />
            </IconButton>
          )}
          <IconButton label="Close panel" onClick={onClose}>
            <X size={16} />
          </IconButton>
        </div>
      </div>

      {!activeSession && listError && (
        // Distinct from CopilotSessionList's own "No sessions yet" empty
        // state — that's a legitimate zero-sessions result, this is "the
        // fetch itself failed." Without this, a failed list load rendered
        // as an empty list, which reads as "you have no sessions" to a user
        // who actually has real history the app just couldn't reach.
        <div className="flex flex-1 flex-col items-center justify-center gap-1 px-4 text-center">
          <p className="text-sm text-text-muted">
            Failed to load your Copilot sessions.
          </p>
          <button
            type="button"
            onClick={() => sessionStore.reload()}
            className="text-xs font-medium text-accent-soft-text hover:underline"
          >
            Try again
          </button>
        </div>
      )}

      {!activeSession && !listError && listLoading && sessions.length === 0 && (
        <p className="mt-6 text-center text-sm text-text-muted">
          Loading sessions…
        </p>
      )}

      {!activeSession &&
        !listError &&
        (!listLoading || sessions.length > 0) && (
          <CopilotSessionList
            sessions={sessions}
            onOpen={handleOpenSession}
            onCreate={handleCreateSession}
            onRename={sessionStore.renameSession}
            onTogglePin={sessionStore.togglePinSession}
            onDelete={sessionStore.deleteSession}
            onReorder={sessionStore.reorderSessionsWithinGroup}
          />
        )}

      {activeSession && (
        <>
          <div className="thin-scroll min-h-0 flex-1 overflow-y-auto px-4 py-4">
            {loadingMessages && (
              <p className="mt-6 text-center text-sm text-text-muted">
                Loading messages…
              </p>
            )}
            {messagesLoadErrorHere && (
              <div className="mt-6 flex flex-col items-center gap-1 text-center">
                <p className="text-sm text-text-muted">
                  Failed to load the conversation history —{' '}
                  {messagesLoadErrorHere.message}
                </p>
                <button
                  type="button"
                  onClick={retryOpenSession}
                  className="text-xs font-medium text-accent-soft-text hover:underline"
                >
                  Try again
                </button>
              </div>
            )}
            {isEmpty && (
              <p className="mt-6 text-center text-sm text-text-muted">
                Ask Copilot anything — it can help with your tickets.
              </p>
            )}
            <div className="flex flex-col gap-3">
              {interleaveProposals(
                activeSession.messages,
                proposalStore.proposals,
              ).map((item) =>
                item.type === 'message' ? (
                  <MessageBubble key={item.message.id} message={item.message} />
                ) : (
                  <CopilotProposalCard
                    key={item.proposal.id}
                    proposal={item.proposal}
                    onApprove={proposalStore.approve}
                    onReject={proposalStore.reject}
                  />
                ),
              )}
              {isStreamingHere &&
                (streaming?.text ? (
                  <MessageBubble
                    message={{ role: 'assistant', content: streaming.text }}
                  />
                ) : (
                  // No tokens yet — a real "thinking" indicator rather than
                  // a static "…" character sitting in a message bubble,
                  // which read as inert/stuck rather than in-progress.
                  <TypingIndicator />
                ))}
            </div>
            {runErrorHere && runErrorHere.kind === 'auth_failed' && (
              <div className="mt-3 flex flex-col items-center gap-2 rounded-[var(--radius-lg)] border border-border bg-surface-2 p-4 text-center">
                <p className="text-xs font-medium text-text">
                  Not connected to Claude
                </p>
                <p className="text-xs text-text-muted">
                  Copilot needs your Claude subscription to reply.
                </p>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => setConnectOpen(true)}
                  className="mt-1"
                >
                  <Sparkles size={13} />
                  Connect your Claude subscription
                </Button>
              </div>
            )}
            {runErrorHere && runErrorHere.kind !== 'auth_failed' && (
              <div className="mt-3 flex flex-col items-center gap-1 text-center">
                <p className="text-xs text-text-muted">
                  {runErrorHere.message}
                </p>
                <button
                  type="button"
                  onClick={retryRun}
                  className="text-xs font-medium text-accent-soft-text hover:underline"
                >
                  Try again
                </button>
              </div>
            )}
          </div>

          <Composer disabled={isStreamingHere} onSend={handleSend} />
        </>
      )}

      <CopilotConnectModal
        open={connectOpen}
        onClose={() => setConnectOpen(false)}
        onConnected={() => {
          // Closes the loop this whole flow exists for: the user shouldn't
          // have to re-type or re-send anything they already sent once —
          // the exact prompt that hit the auth error retries automatically,
          // in the same session it failed in, the moment a working
          // connection exists.
          if (runError && lastFailedPrompt) {
            retryRun();
          }
        }}
      />

      {/* Scoped rules for MessageBubble's rendered markdown — same
          inline-<style> convention AgentDetailPage.tsx uses for its own
          markdown preview. code/pre use color-mix against currentColor
          rather than a fixed surface color, so they read correctly on both
          the accent-colored user bubble and the neutral assistant one
          without a role-specific branch.
          user-select: text is explicit rather than left to the inherited
          default — the bubble's own computed style already resolves to
          "auto" without this, but chat-message content specifically should
          never be non-selectable, so this is asserted directly rather than
          left as an inherited side effect that a future ancestor style
          change could quietly break. */}
      <style>{`
        .copilot-md { user-select: text; -webkit-user-select: text; cursor: text; }
        .copilot-md > *:first-child { margin-top: 0; }
        .copilot-md > *:last-child { margin-bottom: 0; }
        .copilot-md h2 { margin: 0.6em 0 0.3em; font-family: var(--font-display); font-size: 1.05em; font-weight: 600; }
        .copilot-md h3 { margin: 0.5em 0 0.25em; font-family: var(--font-display); font-size: 1em; font-weight: 600; }
        .copilot-md p { margin: 0.5em 0; }
        .copilot-md ul, .copilot-md ol { margin: 0.5em 0; padding-left: 1.3em; }
        .copilot-md ul { list-style: disc; }
        .copilot-md ol { list-style: decimal; }
        .copilot-md li { margin: 0.2em 0; }
        .copilot-md code { padding: 0.1em 0.35em; border-radius: 4px; background: color-mix(in srgb, currentColor 12%, transparent); font-family: var(--font-mono); font-size: 0.85em; overflow-wrap: anywhere; }
        .copilot-md pre { margin: 0.6em 0; padding: 0.6em 0.75em; border-radius: var(--radius-sm); background: color-mix(in srgb, currentColor 10%, transparent); font-family: var(--font-mono); font-size: 0.85em; white-space: pre-wrap; overflow-wrap: anywhere; }
        .copilot-md pre code { padding: 0; background: none; overflow-wrap: anywhere; }
        .copilot-md a { text-decoration: underline; }
        .copilot-md table { margin: 0.6em 0; border-collapse: collapse; width: 100%; font-size: 0.9em; display: block; overflow-x: auto; }
        .copilot-md th, .copilot-md td { padding: 0.35em 0.6em; border: 1px solid color-mix(in srgb, currentColor 15%, transparent); text-align: left; }
        .copilot-md th { background: color-mix(in srgb, currentColor 8%, transparent); font-weight: 600; }

        .copilot-typing { display: flex; align-items: center; gap: 4px; }
        .copilot-typing-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; opacity: 0.35; animation: copilot-typing-bounce 1.1s infinite ease-in-out; }
        .copilot-typing-dot:nth-child(2) { animation-delay: 0.15s; }
        .copilot-typing-dot:nth-child(3) { animation-delay: 0.3s; }
        @keyframes copilot-typing-bounce {
          0%, 60%, 100% { transform: translateY(0); opacity: 0.35; }
          30% { transform: translateY(-4px); opacity: 0.9; }
        }
        @media (prefers-reduced-motion: reduce) {
          .copilot-typing-dot { animation: none; opacity: 0.6; }
        }
      `}</style>
    </div>,
    document.body,
  );
}
