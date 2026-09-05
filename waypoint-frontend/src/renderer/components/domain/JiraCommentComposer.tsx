import { useRef, useState } from 'react';
import { listJiraMentionCandidates, postJiraComment } from '@/data/jiraApi';
import { showErrorToast } from '@/lib/toast';
import { useAsync } from '@/lib/useAsync';
import { Button } from '@/components/ui/Button';
import type { JiraComment } from '@/types/jira';

// Plain `<textarea>`, not a contentEditable div — a deliberate deviation
// from the mockup's contentEditable + styled `<span class="mention">` chips.
// This app's one existing real comment composer (TicketDetailPage.tsx) is a
// plain textarea collecting plain text, and matching that simpler, already-
// proven pattern beats introducing this app's first contentEditable/innerHTML
// surface just to get inline-styled mention chips while typing — the
// trade-off being "@Name" shows as plain text in the draft instead of a
// pill until it posts, which is a modest visual downgrade for a real
// security/complexity win (no HTML parsing of user input anywhere in this
// component). Posted comments and the composer's own "type @ to mention"
// footer note keep the same interaction and copy as the mockup otherwise.
const MENTION_TRIGGER_RE = /@([A-Za-z]*)$/;

export function JiraCommentComposer({
  ticketId,
  onPosted,
}: {
  ticketId: string;
  onPosted: (comment: JiraComment) => void;
}) {
  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Stable focus target for handlePost below — same focus-guard pattern as
  // TicketDetailPage.tsx's commentFormRef: the Comment button goes
  // `disabled={posting}` below, which force-blurs a focused control the
  // instant `disabled` is applied. Landing focus here first keeps the next
  // keystroke from leaking to a global shortcut.
  const formRef = useRef<HTMLDivElement>(null);

  const { data: candidates } = useAsync(() => listJiraMentionCandidates(), []);

  function handleChange(value: string) {
    setDraft(value);
    const match = MENTION_TRIGGER_RE.exec(value);
    setMentionQuery(match ? match[1] : null);
  }

  function insertMention(name: string) {
    setDraft((prev) => prev.replace(MENTION_TRIGGER_RE, `@${name} `));
    setMentionQuery(null);
    textareaRef.current?.focus();
  }

  async function handlePost() {
    const trimmed = draft.trim();
    if (!trimmed || posting) return;
    formRef.current?.focus();
    setPosting(true);
    try {
      const comment = await postJiraComment(ticketId, trimmed);
      onPosted(comment);
      setDraft('');
      setMentionQuery(null);
    } catch (err) {
      showErrorToast(
        err instanceof Error
          ? err.message
          : 'Could not post this comment to Jira.',
      );
    } finally {
      setPosting(false);
    }
  }

  const filteredCandidates = (candidates ?? []).filter((c) =>
    mentionQuery
      ? c.name.toLowerCase().startsWith(mentionQuery.toLowerCase())
      : true,
  );

  return (
    <div
      ref={formRef}
      tabIndex={-1}
      data-shortcut-guard
      className="relative outline-none"
    >
      {mentionQuery !== null && filteredCandidates.length > 0 && (
        <div className="absolute bottom-full left-0 z-10 mb-1 w-[210px] overflow-hidden rounded-[var(--radius-sm)] border border-border-strong bg-surface shadow-2xl">
          <div className="px-2.5 pt-1.5 pb-1 text-[10px] font-bold tracking-wide text-text-muted uppercase">
            Mention
          </div>
          {filteredCandidates.map((c) => (
            <button
              key={c.name}
              type="button"
              onClick={() => insertMention(c.name)}
              className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12.5px] text-text hover:bg-surface-2"
            >
              {c.name}
              <span className="ml-auto text-[11px] text-text-muted">
                {c.role}
              </span>
            </button>
          ))}
        </div>
      )}
      <div className="rounded-[var(--radius-sm)] border border-border-strong bg-surface">
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(e) => handleChange(e.target.value)}
          placeholder="Comment… type @ to mention a teammate"
          rows={3}
          className="w-full resize-none rounded-t-[var(--radius-sm)] bg-transparent px-2.5 py-2 text-[12.5px] leading-relaxed text-text outline-none"
        />
        <div className="flex items-center gap-2 border-t border-border px-2 py-1.5">
          <span className="flex-1 text-[10.5px] text-text-muted">
            Posts to Jira as Max Chen · plain text + mentions
          </span>
          <Button
            size="xs"
            variant="primary"
            disabled={!draft.trim() || posting}
            onClick={handlePost}
          >
            {posting ? 'Posting…' : 'Comment'}
          </Button>
        </div>
      </div>
    </div>
  );
}
