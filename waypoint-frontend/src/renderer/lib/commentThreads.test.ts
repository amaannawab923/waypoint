import { groupCommentsIntoThreads } from './commentThreads';

// ROAD-162. This is the shared, generic algorithm extracted from
// JiraTicketDetail.tsx's own groupCommentsIntoThreads (that file's own test,
// JiraTicketDetail.test.tsx, still exercises the full set of cases —
// single/nested/multi-reply/flattened-chain/orphan/self-cycle/multi-cycle/
// order-preservation/empty — through the Jira-typed wrapper, unchanged).
// This file's job is narrower and different: prove the same function works
// against a completely different, non-Jira shape — this app's own native
// ticket `Comment` — so "shared, not duplicated" is demonstrated rather than
// just asserted in a comment. Only the cases that matter for THAT claim are
// repeated here (a normal thread, and the malformed-parent/orphan case the
// ticket's Definition of Done calls out by name); the exhaustive edge-case
// matrix stays owned by JiraTicketDetail.test.tsx so it isn't duplicated
// twice over.

interface NativeCommentStub {
  id: string;
  parentId: string | null;
  bodyHtml: string;
}

function nativeComment(
  overrides: Partial<NativeCommentStub> = {},
): NativeCommentStub {
  return { id: 'cm-1', parentId: null, bodyHtml: 'hi', ...overrides };
}

describe('groupCommentsIntoThreads (generic, native-ticket shape)', () => {
  it('threads a reply under its root for a native Comment-shaped list', () => {
    const root = nativeComment({ id: 'cm-root', bodyHtml: 'root comment' });
    const reply = nativeComment({
      id: 'cm-reply',
      parentId: 'cm-root',
      bodyHtml: 'a reply',
    });

    expect(groupCommentsIntoThreads([root, reply])).toEqual([
      { root, replies: [reply] },
    ]);
  });

  it('groups multiple replies to the same root, in original order', () => {
    const root = nativeComment({ id: 'cm-root' });
    const reply1 = nativeComment({ id: 'cm-r1', parentId: 'cm-root' });
    const reply2 = nativeComment({ id: 'cm-r2', parentId: 'cm-root' });

    expect(groupCommentsIntoThreads([root, reply1, reply2])).toEqual([
      { root, replies: [reply1, reply2] },
    ]);
  });

  // The ticket's own Definition of Done names this case: a reply whose
  // parentId doesn't resolve to any comment on hand (schema/tickets.ts's
  // comments.parentId, onDelete: 'set null' — the reply's own row simply
  // sets parentId to null when its parent is deleted; but a stale client
  // holding an already-fetched list could still hand this function a
  // parentId it can't resolve) renders as its own root instead of being
  // silently dropped.
  it('renders a comment with an unresolvable parentId as its own root, not dropped', () => {
    const orphan = nativeComment({
      id: 'cm-orphan',
      parentId: 'cm-does-not-exist',
    });

    expect(groupCommentsIntoThreads([orphan])).toEqual([
      { root: orphan, replies: [] },
    ]);
  });

  it('flattens a reply-to-a-reply to one level under the original root', () => {
    const root = nativeComment({ id: 'cm-root' });
    const reply = nativeComment({ id: 'cm-reply', parentId: 'cm-root' });
    const replyToReply = nativeComment({
      id: 'cm-reply-2',
      parentId: 'cm-reply',
    });

    expect(groupCommentsIntoThreads([root, reply, replyToReply])).toEqual([
      { root, replies: [reply, replyToReply] },
    ]);
  });

  it('returns an empty array for an empty list', () => {
    expect(groupCommentsIntoThreads([])).toEqual([]);
  });
});
