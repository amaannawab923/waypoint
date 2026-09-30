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
 *  - Case-sensitive. Matching "@dev" to a member named "Dev" turned an
 *    ordinary phrase ("ping the @dev team") into a notification, so only
 *    the exact name counts. The composer's picker always inserts the exact
 *    name, which is the way almost every mention is written.
 *  - Nothing inside code counts. A fenced block or an inline `code` span
 *    is quoting text (a log line, a config snippet) that happens to contain
 *    an "@", not addressing a person.
 *
 * Pure, so it is tested directly rather than through a database.
 */
export function findMentionedMemberIds(
  body: string,
  candidates: ReadonlyArray<{ id: string; displayName: string }>,
): string[] {
  // Code is blanked out (same length, so nothing else shifts) before any
  // name is looked for; see the rule above.
  let text = body
    .replace(/```[\s\S]*?(```|$)/g, (m) => ' '.repeat(m.length))
    .replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length));
  const found: string[] = [];
  const byLength = [...candidates]
    .filter((m) => m.displayName.trim() !== '')
    .sort((a, b) => b.displayName.length - a.displayName.length);
  for (const member of byLength) {
    const escaped = member.displayName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(^|[\\s(\\[])@${escaped}(?![\\w])`, 'g');
    let matched = false;
    text = text.replace(pattern, (whole, lead: string) => {
      matched = true;
      return lead + ' '.repeat(whole.length - lead.length);
    });
    if (matched) found.push(member.id);
  }
  return found;
}
