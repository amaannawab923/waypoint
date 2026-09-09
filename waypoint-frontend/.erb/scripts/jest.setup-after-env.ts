import { configure } from '@testing-library/dom';

// CI has caught real, reproducible flakes from this default being too tight
// on this suite's shared/slower runners — not a logic bug in whatever
// component happened to be the victim. Two separate PR #36 CI runs each
// failed exactly one findByText/waitFor-style assertion in a DIFFERENT,
// otherwise-unrelated file (TicketDetailPage.test.tsx, then
// CopilotPanel.test.tsx), neither reproducible in any number of local runs
// (isolated or full-suite) — the signature of a marginal default timeout
// under CI load, not a per-file problem worth chasing file by file as a new
// one flakes each run. Testing Library's own default asyncUtilTimeout is
// 1000ms; raised once, suite-wide, rather than as a per-file patch.
configure({ asyncUtilTimeout: 5000 });
