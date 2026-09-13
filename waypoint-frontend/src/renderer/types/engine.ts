// Renderer-facing mirror of the main-process engine contract
// (main/engine/types.ts, ROAD-48/51). A type-only reach into src/main, the
// same crossing data/jiraApi.ts already makes for the Jira wire shapes (see
// that file's own header) — nothing at runtime imports from main.
//
// Unlike a Jira ticket, EngineStatus and EngineHealth need no translation
// before they reach a component: there is no credential to strip and no
// display-only field (a color, a label) to derive, so this file re-exports
// the exact shapes ROAD-48's supervisor and engineIpc.ts already speak
// rather than hand-maintaining a second copy that could drift from them.
// This is the renderer's stable `@/types/engine` import path for those
// shapes, matching the sibling `@/types/jira` and `@/types/entities`.
export type {
  EngineStatus,
  EngineHealth,
  EngineTransportMode,
  EngineInitializeOk,
  EngineInitializeError,
  LiveSnapshot,
  LiveUpdate,
  TopicClosedReason,
} from '../../main/engine/types';

// A value export, unlike everything above — deliberately, and for the same
// reason preload.ts imports ENGINE_IPC as a value (see that file's own
// comment): ENGINE_PIN is a plain, portable constant (types.ts's own header
// says the file imports neither Electron nor Node runtime modules), and
// MachinePage's "Agent engine" row needs to show the real pinned
// name/version/commit rather than a second, hand-copied literal that could
// drift from the one main and the supervisor actually check installs
// against.
export { ENGINE_PIN } from '../../main/engine/types';
