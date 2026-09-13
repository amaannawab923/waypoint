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
  RunVerdict,
} from '../../main/engine/runs/ledgerClient';

// W5c: what dispatch_session hands the renderer with the offer.
export type { SessionOfferHistory } from '../../main/copilot/sessionTools';

export type {
  BriefPreview,
  BriefPreviewInput,
  DispatchRunInput,
  FolderChoice,
  JiraTicketRef,
  OpenPrResult,
  ResolvedTicket,
  ResumeRunOutcome,
  ResumeRunResult,
  RunBranches,
  RunIsolation,
  SessionFolder,
  RunChanged,
  RunDiff,
  RunDiffFile,
  RunDiffFileStatus,
  RunFocus,
  RunIntent,
  StartRunInput,
  StopRunOutcome,
  StopRunResult,
  SupportedProviderId,
  TicketSystem,
} from '../../main/engine/types';
