// ROAD-162. Extracted from JiraTicketDetail.tsx's own groupCommentsIntoThreads
// (added for the Jira comment surface, reviewed there) so native-ticket
// comments (TicketDetailPage.tsx) get exactly the same threading decisions
// instead of a second, hand-rolled copy that could quietly drift from them.
// JiraTicketDetail.tsx now re-exports its own `groupCommentsIntoThreads` as
// a thin wrapper around this generic — same name, same behavior, so its own
// existing tests (JiraTicketDetail.test.tsx) need no changes.
//
// Generic over T rather than fixed to one comment shape: JiraComment and
// this app's native Comment (types/entities.ts) don't share a common type
// (different fields entirely — authorAccountId vs authorId, ADF bodies vs
// markdown, …), only the one property this algorithm actually needs.
export interface ThreadableComment {
  id: string;
  parentId: string | null;
}

/** One root comment plus every reply grouped under it, flattened to exactly
 * one level — see `groupCommentsIntoThreads`'s own comment for why this
 * shape has no further nesting inside `replies`. */
export interface CommentThread<T extends ThreadableComment> {
  root: T;
  replies: T[];
}

/**
 * Groups a flat comment list into threads by `parentId`, capped at one
 * visible level of nesting — a root, plus every comment that traces back to
 * it, all rendered as direct replies regardless of how many hops deep the
 * real chain is. That matches what Jira itself shows (the founder's own
 * ENG-84 screenshot has one level of nesting, not an indent per
 * reply-to-a-reply — see JiraTicketDetail.tsx's original comment for the
 * live-verification), and it is what keeps a long or malformed chain from
 * pushing content off the right edge of a panel one indent at a time.
 *
 * Two things this must never do, because real data — a Jira page capped at
 * COMMENT_PAGE_SIZE, or a native comment whose parent was since deleted
 * (schema/tickets.ts's `parentId`, `onDelete: 'set null'` — deleting a
 * parent orphans its replies rather than cascading) — is exactly where both
 * happen:
 *
 *  - Drop a comment whose parent isn't in `comments`. A reply's `parentId`
 *    can name a real comment that simply isn't on this page/list — that
 *    comment renders as its own root instead of vanishing. A dropped
 *    comment is a bug; being placed one level higher than intended is
 *    cosmetic.
 *  - Hang, or drop every comment in it, on a cyclic or self-referencing
 *    `parentId`. The data is never assumed well-formed: `findRootId` below
 *    walks at most `comments.length` hops and gives up the moment it would
 *    revisit a comment already in its own walk, at which point the comment
 *    the walk STARTED from becomes its own root. Every member of an
 *    N-comment cycle ends up a root of its own with no replies — flat, not
 *    nested in an arbitrary or wrong order, and never a hang.
 */
export function groupCommentsIntoThreads<T extends ThreadableComment>(
  comments: T[],
): CommentThread<T>[] {
  const byId = new Map(comments.map((c) => [c.id, c]));

  function findRootId(start: T): string {
    // Every comment visited on THIS walk, so a repeat means a cycle rather
    // than a coincidence — two different comments having replied to the
    // same parent is normal and must not trip this.
    const seen = new Set<string>([start.id]);
    let current = start;
    // A second, independent bound on top of the cycle check above: even a
    // bug in that check cannot turn this into an infinite loop, since a
    // walk this long has already visited every comment there is.
    for (let steps = 0; steps < comments.length; steps += 1) {
      if (!current.parentId) return current.id;
      const parent = byId.get(current.parentId);
      // The named parent isn't in this list — an orphan. `current`, not
      // `start`, is the root: everything already walked between them is
      // still a real, resolvable chain and stays grouped together under
      // this same boundary.
      if (!parent) return current.id;
      // A parent already seen on this walk closes a cycle. There is no
      // well-defined "real" root inside one, so this breaks it at the
      // comment the walk started from rather than guessing which member of
      // the cycle deserves to be treated as the top.
      if (seen.has(parent.id)) return start.id;
      seen.add(parent.id);
      current = parent;
    }
    return start.id;
  }

  const rootOrder: string[] = [];
  const repliesByRoot = new Map<string, T[]>();

  comments.forEach((c) => {
    const rootId = findRootId(c);
    if (rootId === c.id) {
      rootOrder.push(c.id);
    } else {
      const existing = repliesByRoot.get(rootId);
      if (existing) existing.push(c);
      else repliesByRoot.set(rootId, [c]);
    }
  });

  return rootOrder.map((id) => ({
    // Non-null: `id` only ever entered rootOrder as some comment's own id.
    root: byId.get(id) as T,
    replies: repliesByRoot.get(id) ?? [],
  }));
}
