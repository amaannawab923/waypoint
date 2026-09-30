/**
 * A comment the backend built for an approved Copilot or session
 * proposal (waypoint-backend/src/lib/commentHtml.ts): posted as the
 * person, so its author is a member, but its body is the builder's
 * escaped HTML behind a fixed disclosure opening. A typed comment cannot
 * match — the REST path entity-escapes what a person types, so a literal
 * `<p>` arrives as `&lt;p&gt;`.
 */
export function isDisclosedAgentHtml(bodyHtml: string): boolean {
  return /^<p><em>(Hi, this is Copilot|This is a Waypoint session) — /.test(
    bodyHtml,
  );
}

/**
 * An agent comment's words without its disclosure opening, for one-line
 * previews. DOMParser builds an inert document (no scripts run, nothing
 * loads), so this only reads text.
 */
export function agentCommentText(bodyHtml: string): string {
  const doc = new DOMParser().parseFromString(bodyHtml, 'text/html');
  doc.body.querySelector('p > em')?.remove();
  // Block by block, so paragraphs don't run into each other.
  const blocks = Array.from(doc.body.children, (el) => el.textContent ?? '');
  const text = blocks.length ? blocks.join(' ') : (doc.body.textContent ?? '');
  return text.replace(/\s+/g, ' ').trim();
}
