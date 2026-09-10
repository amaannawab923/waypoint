/**
 * Renders a Jira description/comment body.
 *
 * ROAD-41 contract stub. The signature is final so call sites can adopt it
 * now; the real ADF walk lands separately and every caller gains fidelity
 * without touching its own code.
 *
 * `adf` is the raw Atlassian Document Format node (see
 * `JiraWireTicket.descriptionAdf`), `fallback` the already-flattened plain
 * text the app has always had. Falling back to the plain text rather than
 * rendering nothing is deliberate: a body whose ADF is missing, or whose node
 * types this renderer does not yet cover, must still show its content. Losing
 * formatting is a degradation; losing the text is a bug.
 */
export function JiraRichText({
  adf,
  fallback,
  className,
}: {
  adf: unknown | null;
  fallback: string;
  className?: string;
}) {
  // Until the ADF walk exists, `adf` is deliberately unread — the plain text
  // is the whole render. Named in the signature anyway so no call site has to
  // change when it starts being used.
  void adf;
  return <div className={className}>{fallback}</div>;
}
