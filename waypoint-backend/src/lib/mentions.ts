// ROAD-162. Pure, and kept apart from notifications.service.ts so it can be
// unit tested without importing the database client.

/**
 * Which members a comment body names with "@DisplayName".
 *
 * Matched against the workspace's real display names rather than parsed
 * from a pattern, because display names contain spaces ("Amaan Nawab") and
 * no regex for "a name" can know where one ends. Rules, each for a reason:
 *
 *  - The "@" must start the text or follow whitespace or an opening
 *    bracket. "bob@Priya" is an email-shaped string, not a mention; the
 *    composer's picker applies the same boundary when it decides whether
 *    to open.
 *  - The name must end at a non-word character or the end of the text, so
 *    "@Priyanka" does not notify "Priya".
 *  - Longest names are tried first, and a matched span is blanked before
 *    shorter names are tried. With members "Amaan" and "Amaan Nawab",
 *    "@Amaan Nawab" notifies only the latter.
 *  - Case-insensitive: the picker inserts the exact name, but a person
 *    typing "@priya" by hand means the same member.
 *
 * Pure, so it is tested directly rather than through a database.
 */
export function findMentionedMemberIds(
  body: string,
  candidates: ReadonlyArray<{ id: string; displayName: string }>,
): string[] {
  let text = body;
  const found: string[] = [];
  const byLength = [...candidates]
    .filter((m) => m.displayName.trim() !== '')
    .sort((a, b) => b.displayName.length - a.displayName.length);
  for (const member of byLength) {
    const escaped = member.displayName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(^|[\\s(\\[])@${escaped}(?![\\w])`, 'gi');
    let matched = false;
    text = text.replace(pattern, (whole, lead: string) => {
      matched = true;
      return lead + ' '.repeat(whole.length - lead.length);
    });
    if (matched) found.push(member.id);
  }
  return found;
}
