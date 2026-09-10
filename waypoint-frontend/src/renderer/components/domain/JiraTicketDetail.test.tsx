import type { JiraComment } from '@/types/jira';
import { groupCommentsIntoThreads } from './JiraTicketDetail';

// Pure-function coverage for the nesting rule ROAD-41's threading follow-up
// added: a reply renders under the comment it answers, capped at one visible
// level (Jira's own ENG-84 screenshot never shows more than that), and two
// hard requirements around never losing a comment — see
// groupCommentsIntoThreads's own comment for the full reasoning. Exercised
// directly against the pure function rather than through a rendered
// JiraTicketDrawer: the grouping logic is the thing under test, and a
// component render would only add DOM assertions this file doesn't need to
// make that point.

function comment(overrides: Partial<JiraComment> = {}): JiraComment {
  return {
    id: 'c1',
    ticketId: '10421',
    authorName: 'Sam Lee',
    authorAccountId: 'acct-sam',
    body: 'a comment',
    createdAt: '2026-09-01T09:00:00.000Z',
    parentId: null,
    postedByWaypoint: false,
    disclosureText: null,
    ...overrides,
  };
}

describe('groupCommentsIntoThreads', () => {
  it('renders a comment with no parentId as its own root, with no replies', () => {
    const c = comment({ id: 'c1', parentId: null });

    expect(groupCommentsIntoThreads([c])).toEqual([{ root: c, replies: [] }]);
  });

  it('nests a reply under its parent', () => {
    const root = comment({ id: 'c1', body: 'Hello' });
    const reply = comment({
      id: 'c2',
      body: 'Reply should be like this',
      parentId: 'c1',
    });

    expect(groupCommentsIntoThreads([root, reply])).toEqual([
      { root, replies: [reply] },
    ]);
  });

  it('groups several replies to the same root together, in original order', () => {
    const root = comment({ id: 'c1' });
    const reply1 = comment({ id: 'c2', parentId: 'c1' });
    const reply2 = comment({ id: 'c3', parentId: 'c1' });

    expect(groupCommentsIntoThreads([root, reply1, reply2])).toEqual([
      { root, replies: [reply1, reply2] },
    ]);
  });

  // Jira's own thread view shows one level of nesting, not one indent per
  // hop — so a reply-to-a-reply flattens to a direct reply of the original
  // root rather than growing a second level.
  it('flattens a reply-to-a-reply to one level under the original root', () => {
    const root = comment({ id: 'c1' });
    const reply = comment({ id: 'c2', parentId: 'c1' });
    const replyToReply = comment({ id: 'c3', parentId: 'c2' });

    expect(groupCommentsIntoThreads([root, reply, replyToReply])).toEqual([
      { root, replies: [reply, replyToReply] },
    ]);
  });

  // The thread is capped at the 100 most recent comments (COMMENT_PAGE_SIZE
  // in jiraClient.ts), so a reply whose parent fell outside that page has a
  // parentId this read never loaded. Dropping it would be a bug; rendering
  // it at top level is the honest, non-lossy answer.
  it('renders an orphan — a parentId not among the loaded comments — at top level', () => {
    const orphan = comment({ id: 'c9', parentId: 'c-not-loaded' });

    expect(groupCommentsIntoThreads([orphan])).toEqual([
      { root: orphan, replies: [] },
    ]);
  });

  it('keeps everything nested under an orphan boundary together, rather than dropping the chain', () => {
    // c2's real parent (c1) isn't loaded; c3 replies to c2.
    const orphanBoundary = comment({ id: 'c2', parentId: 'c1-not-loaded' });
    const nestedUnderIt = comment({ id: 'c3', parentId: 'c2' });

    expect(groupCommentsIntoThreads([orphanBoundary, nestedUnderIt])).toEqual([
      { root: orphanBoundary, replies: [nestedUnderIt] },
    ]);
  });

  // Malformed data this function must not assume can't happen: a comment
  // naming itself as its own parent. Must render (not vanish) and must not
  // hang.
  it('renders a self-referencing parentId as its own root rather than hanging or vanishing', () => {
    const selfReferencing = comment({ id: 'c1', parentId: 'c1' });

    const run = () => groupCommentsIntoThreads([selfReferencing]);

    expect(run).not.toThrow();
    expect(run()).toEqual([{ root: selfReferencing, replies: [] }]);
  });

  // A longer cycle — every comment's parentId eventually loops back to
  // itself with no comment ever reaching a real `null` root. Every member
  // must still render (as its own root, since a cycle has no well-defined
  // "real" top) and the walk must terminate.
  it('renders every member of a multi-comment cycle at top level, without hanging or losing any of them', () => {
    const a = comment({ id: 'a', parentId: 'c' });
    const b = comment({ id: 'b', parentId: 'a' });
    const c = comment({ id: 'c', parentId: 'b' });

    const run = () => groupCommentsIntoThreads([a, b, c]);

    expect(run).not.toThrow();
    const threads = run();
    expect(threads.map((t) => t.root.id).sort()).toEqual(['a', 'b', 'c']);
    // No comment lost to the cycle and none double-counted as a reply.
    expect(threads.every((t) => t.replies.length === 0)).toBe(true);
  });

  // A large cycle is the case most likely to hang a naive walk — this pins
  // that the bound is real, not just correct on a 3-comment example.
  it('terminates on a cycle spanning the whole 100-comment page', () => {
    const size = 100;
    const cyclic = Array.from({ length: size }, (_, i) =>
      comment({ id: `c${i}`, parentId: `c${(i + 1) % size}` }),
    );

    const run = () => groupCommentsIntoThreads(cyclic);

    expect(run).not.toThrow();
    expect(run()).toHaveLength(size);
  });

  it('preserves the original, oldest-first order of top-level threads', () => {
    const first = comment({ id: 'c1' });
    const second = comment({ id: 'c2' });
    const third = comment({ id: 'c3' });

    expect(
      groupCommentsIntoThreads([first, second, third]).map((t) => t.root.id),
    ).toEqual(['c1', 'c2', 'c3']);
  });

  it('returns an empty array for an empty thread', () => {
    expect(groupCommentsIntoThreads([])).toEqual([]);
  });
});
