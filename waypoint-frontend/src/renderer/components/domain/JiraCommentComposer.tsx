import { useRef, useState } from 'react';
import { postJiraComment } from '@/data/jiraApi';
import { showErrorToast } from '@/lib/toast';
import { useJiraConnection } from '@/lib/jiraStore';
import { Button } from '@/components/ui/Button';
import type { JiraComment } from '@/types/jira';

// Plain `<textarea>`, not a contentEditable div — a deliberate deviation
// from the mockup's contentEditable + styled `<span class="mention">` chips.
// This app's one existing real comment composer (TicketDetailPage.tsx) is a
// plain textarea collecting plain text, and matching that simpler, already-
// proven pattern beats introducing this app's first contentEditable/innerHTML
// surface just to get inline-styled mention chips while typing.
//
// The @-mention picker that used to sit above this box is gone, and its
// removal is the point rather than a simplification. This composer now posts
// to a real Jira issue, as plain text. A real Jira mention is a structured
// ADF `mention` node carrying an accountId — typing "@Sam Lee" into a
// plain-text body produces eleven literal characters that notify nobody. A
// picker that inserted them would be this app telling the user it had
// mentioned a colleague when it had not. Writing genuine mentions means
// writing ADF, which is a later phase; until then the footer says plainly
// what this does post.

export function JiraCommentComposer({
  ticketId,
  onPosted,
}: {
  ticketId: string;
  onPosted: (comment: JiraComment) => void;
}) {
  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);
  const connection = useJiraConnection();
  // Stable focus target for handlePost below — same focus-guard pattern as
  // TicketDetailPage.tsx's commentFormRef: the Comment button goes
  // `disabled={posting}` below, which force-blurs a focused control the
  // instant `disabled` is applied. Landing focus here first keeps the next
  // keystroke from leaking to a global shortcut.
  const formRef = useRef<HTMLDivElement>(null);

  async function handlePost() {
    const trimmed = draft.trim();
    if (!trimmed || posting) return;
    formRef.current?.focus();
    setPosting(true);
    try {
      const comment = await postJiraComment(ticketId, trimmed);
      onPosted(comment);
      setDraft('');
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

  return (
    <div
      ref={formRef}
      tabIndex={-1}
      data-shortcut-guard
      className="relative outline-none"
    >
      <div className="rounded-[var(--radius-sm)] border border-border-strong bg-surface">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Comment…"
          rows={3}
          className="w-full resize-none rounded-t-[var(--radius-sm)] bg-transparent px-2.5 py-2 text-[12.5px] leading-relaxed text-text outline-none"
        />
        <div className="flex items-center gap-2 border-t border-border px-2 py-1.5">
          {/* The name is the connected Atlassian account's own display name,
              read from the shared connection store — this comment really is
              posted as that person, and the label has to be able to say who
              that is rather than the fixture name it used to hardcode. */}
          <span className="flex-1 text-[10.5px] text-text-muted">
            Posts to Jira as {connection?.accountName || 'you'} · plain text
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
