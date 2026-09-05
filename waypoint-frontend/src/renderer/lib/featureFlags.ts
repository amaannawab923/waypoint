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
 * the sidebar's "My Jira" nav slot, the /my-jira route, and the Add Project
 * wizard's Companion option.
 *
 * The data layer is real: the wizard collects an Atlassian API token, the
 * main process validates and stores it encrypted, and every read and write
 * goes to the user's own Jira Cloud site (see main/jira/ and data/jiraApi.ts).
 * The flag stays on this feature because the surface is still incomplete —
 * no background sync, no issue creation, no Copilot proposals — not because
 * the data is fake.
 */
export const MY_JIRA_ENABLED = process.env.WAYPOINT_FEATURE_MY_JIRA === 'true';
