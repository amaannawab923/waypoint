// Renderer-facing mirror of the agent-runs ledger's row and status
// vocabulary — the same type-only reach into src/main that `@/types/engine`
// makes for the engine shapes (see that file's header). The row is defined
// once, beside the main-process client that writes it
// (main/engine/runs/ledgerClient.ts), so the panel cannot drift from what
// the ledger actually serialises. Nothing at runtime imports from main.
export type {
  AgentRun,
  AgentRunEntry,
  AgentRunEvent,
  AgentRunStatus,
} from '../../main/engine/runs/ledgerClient';

export type {
  ResumeRunOutcome,
  ResumeRunResult,
  RunBranches,
  RunChanged,
  RunDiff,
  RunDiffFile,
  RunDiffFileStatus,
  StartRunInput,
  StopRunOutcome,
  StopRunResult,
  SupportedProviderId,
} from '../../main/engine/types';
