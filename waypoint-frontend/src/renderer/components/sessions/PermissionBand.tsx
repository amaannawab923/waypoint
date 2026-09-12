import { useEffect, useRef, useState } from 'react';
import type { AcpPermissionRequest } from '@emdash/chat-ui';
import { IconChevron, IconShield } from '@/components/icons';

/**
 * The composer-docked permission band (W3, ROAD-63; v1 decision 3): when
 * the agent asks "may I run this tool?", the daemon parks the request in
 * the session state and the run shows `blocked` — this band, docked above
 * the composer and never a bubble in the transcript, is where the person
 * answers. It shows the first pending request's tool call and a split
 * button: the main action is the first option the agent marked
 * `allow_once`, the menu lists every option the agent offered by the
 * agent's own name for it — the band never invents an option. "1 of N"
 * says how many are queued behind it.
 */
export function PermissionBand({
  requests,
  onAnswer,
  answering,
}: {
  requests: readonly AcpPermissionRequest[];
  onAnswer: (requestId: string, optionId: string) => void;
  /** The request id whose answer is in flight, if any. */
  answering: string | null;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const request = requests[0];

  useEffect(() => {
    if (!menuOpen) return undefined;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node))
        setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen]);
  useEffect(() => {
    setMenuOpen(false);
  }, [request?.requestId]);

  if (!request) return null;
  const primary =
    request.options.find((o) => o.kind === 'allow_once') ?? request.options[0];
  const busy = answering === request.requestId;
  const { toolCall } = request;
  const what =
    toolCall.kind === 'execute-tool-call' && toolCall.command
      ? toolCall.command
      : toolCall.title;

  return (
    <div
      data-permission-band
      role="region"
      aria-label="Permission request"
      className="mx-4 flex shrink-0 items-center gap-2 rounded-t-[var(--radius-sm)] border border-b-0 border-warning bg-warning-bg px-2.5 py-[7px] text-[11px] text-warning"
    >
      <IconShield size={13} className="shrink-0" />
      <span className="min-w-0 truncate">
        <b className="font-bold">Allow</b>{' '}
        <span className="font-mono">{what}</span>
      </span>
      {requests.length > 1 && (
        <span className="shrink-0 font-mono text-[10px] opacity-80">
          1 of {requests.length}
        </span>
      )}
      <span className="flex-1" />
      <div ref={menuRef} className="relative flex shrink-0 items-stretch">
        <div className="flex overflow-hidden rounded-[5px] border border-border-strong bg-surface">
          <button
            type="button"
            disabled={busy || !primary}
            onClick={() =>
              primary && onAnswer(request.requestId, primary.optionId)
            }
            className="flex h-[22px] items-center px-2.5 text-[10.5px] font-semibold text-text hover:bg-surface-2 disabled:opacity-60"
          >
            {busy ? 'Answering…' : (primary?.name ?? 'No options')}
          </button>
          {request.options.length > 1 && (
            <button
              type="button"
              aria-label="More options"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              disabled={busy}
              onClick={() => setMenuOpen((v) => !v)}
              className="flex items-center border-l border-border-strong px-1.5 text-text-muted hover:bg-surface-2 hover:text-text"
            >
              <IconChevron size={9} />
            </button>
          )}
        </div>
        {menuOpen && (
          <div
            role="menu"
            className="absolute right-0 bottom-full z-30 mb-1 min-w-[180px] rounded-[var(--radius-sm)] border border-border bg-surface p-1 shadow-lg"
          >
            {request.options.map((option) => (
              <button
                key={option.optionId}
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onAnswer(request.requestId, option.optionId);
                }}
                className="flex w-full items-center justify-between gap-3 rounded-[var(--radius-sm)] px-2 py-1.5 text-left text-xs text-text hover:bg-surface-2"
              >
                <span>{option.name}</span>
                <span className="font-mono text-[10px] text-text-muted">
                  {option.kind}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
