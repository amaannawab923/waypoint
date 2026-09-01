// Builds the HTML body for a Copilot-authored comment at EXECUTE time (see
// proposals.service.ts's approveProposal) — never at propose time, and never
// from model-supplied markup. The model's propose_comment schema accepts a
// plain-text `body` only; the self-disclosure prefix is added here, from the
// real current user's display name, so the model can neither omit it nor
// spoof a different name. Plain text in, fully entity-escaped out — no
// markdown rendering, matching the decision that a Copilot comment is prose,
// not rich content.

// Waypoint's existing self-disclosure convention for agent-made changes —
// same wording the system prompt tells the model Waypoint will add for it.
export const COPILOT_DISCLOSURE = (displayName: string) =>
  `Hi, this is Copilot — ${displayName}’s agent — commenting on their behalf: `;

// Mirrors waypoint-frontend/src/renderer/lib/markdown.ts's escapeHtml (same
// five characters, same order) — comment bodies render as stored HTML in the
// work-item drawer, so both the model-authored body AND the display name
// (which a user can set to something containing < or ') must be escaped
// before being wrapped in tags here.
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Matches the seed data's own <p>-per-paragraph convention (see db/seed.ts's
// bodyHtml values): the disclosure runs inline (italic) into the body's
// first paragraph; each blank-line-separated chunk after that becomes its
// own <p>.
export function buildCopilotCommentHtml(displayName: string, body: string): string {
  const disclosure = escapeHtml(COPILOT_DISCLOSURE(displayName));
  const paragraphs = body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => escapeHtml(p));
  const [first = '', ...rest] = paragraphs;
  return [`<p><em>${disclosure}</em>${first}</p>`, ...rest.map((p) => `<p>${p}</p>`)].join('');
}
