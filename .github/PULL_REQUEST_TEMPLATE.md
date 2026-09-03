**Honesty check.** For every surface this PR adds or changes: does it assert
anything — a status, a count, a success, a trend, a version — that it did not
read from a source in this same change? If yes, either read it, render
`<NotWired>` from `capabilities.ts`, or delete the surface. Third option is
usually right.
