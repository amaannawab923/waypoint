// Build-time feature flags, inlined via webpack.EnvironmentPlugin (see
// .erb/configs/webpack.config.renderer.{dev,prod}.ts) — same mechanism as
// WAYPOINT_API_BASE_URL. Off by default; override per-run, e.g.:
//   WAYPOINT_FEATURE_AGENT_SESSIONS=true npm start

/**
 * The agent-sessions UI (dispatch, the full-viewport Sessions screen, the
 * Copilot drag-and-drop surface) — a mock frontend against fake data, no
 * real backend runtime behind it yet. Gated so it can be built and reviewed
 * incrementally without changing anything for the current app.
 */
export const AGENT_SESSIONS_ENABLED = process.env.WAYPOINT_FEATURE_AGENT_SESSIONS === 'true';

/**
 * The Copilot chat panel — a persistent personal assistant panel, backed by
 * real conversation/message tables in waypoint-server (see issue #5), with a
 * canned static reply for now (real LLM integration is a later phase, issue
 * #7). Gated independently of AGENT_SESSIONS_ENABLED — the two ship and are
 * verified separately, even though they're both part of the same epic.
 */
export const COPILOT_ENABLED = process.env.WAYPOINT_FEATURE_COPILOT === 'true';
