// Build-time feature flags, inlined via webpack.EnvironmentPlugin (see
// .erb/configs/webpack.config.renderer.{dev,prod}.ts) — same mechanism as
// WAYPOINT_API_BASE_URL. Off by default; override per-run, e.g.:
//   WAYPOINT_FEATURE_COPILOT=true npm start

/**
 * The Copilot chat panel — a persistent personal assistant panel, backed by
 * real conversation/message tables in waypoint-server (see issue #5), with a
 * canned static reply for now (real LLM integration is a later phase, issue
 * #7).
 */
export const COPILOT_ENABLED = process.env.WAYPOINT_FEATURE_COPILOT === 'true';

/**
 * The "My Jira" companion project — a project type that mirrors a user's own
 * Jira work (everything assigned to, reported by, or watched by them, across
 * every Jira project they can see) inside Waypoint, writable from here. Gates
 * the sidebar's "My Jira" nav slot, the /my-jira route, and (a later phase)
 * the Add Project wizard's Companion option. No backend exists yet — the
 * data layer is an in-memory mock (see data/jiraApi.ts).
 */
export const MY_JIRA_ENABLED = process.env.WAYPOINT_FEATURE_MY_JIRA === 'true';
