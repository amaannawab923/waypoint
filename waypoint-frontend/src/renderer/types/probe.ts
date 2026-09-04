/**
 * A claim about state outside this process — Claude Code installed, the
 * backend reachable, a repo linked, a branch name — carrying the evidence
 * for that claim instead of just a boolean.
 *
 * `via` is the load-bearing field on the three settled branches: the literal
 * thing that was executed to produce the claim (`'claude --version'`,
 * `'GET /health'`). You cannot construct a `present`, `absent`, or `error`
 * without naming what you ran, which is what makes the fabricated-status bug
 * (a status rendered as connected/found without ever reading anything)
 * unrepresentable in the type.
 *
 * See docs/design/waypoint-revamp-architecture.md §7.2.
 */
export type Probe<T> =
  | { state: 'unknown' }
  | { state: 'checking' }
  | { state: 'present'; value: T; observedAt: string; via: string }
  | { state: 'absent'; reason: string; observedAt: string; via: string }
  | { state: 'error'; reason: string; observedAt: string; via: string };
