import { PLAN_MODE_ID } from '../types';
import type { AgentRun } from './ledgerClient';

/**
 * The environment a dispatched writing session's agent process gets —
 * W5a, ROAD-120 (docs/design/w5a-investigate-fix.md §2.5).
 *
 * A worktree isolates files, not credentials: the daemon's agent process
 * inherits an allowlisted slice of the shell env, and that allowlist
 * (emdash `packages/core/src/primitives/agent-env`) deliberately passes
 * `GH_TOKEN`, `GITHUB_TOKEN`, the `AWS_*` keys and `SSH_AUTH_SOCK`
 * through. A session that may edit files without asking must not also be
 * able to push, open a PR, or reach a cloud with the person's keys — so
 * these are set to the empty string on `acp.start`, which the daemon
 * merges last (plugin-host.ts `buildAcpSpawn`: `{...agentEnv, ...ctx.env}`),
 * and git is told never to prompt. The live pass proves it: an
 * auto-approved Fix asked to `git push` must fail (SESS-36).
 *
 * Applied to every dispatched writing session, auto-approved or not: the
 * brief tells the agent not to push either way, and W6 (ROAD-76) is where
 * Waypoint itself pushes and opens the PR, with its own credential.
 */
export const SCRUBBED_ENV_KEYS: readonly string[] = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'SSH_AUTH_SOCK',
  'GIT_ASKPASS',
  'SSH_ASKPASS',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_PROFILE',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_API_KEY',
  'AZURE_CLIENT_SECRET',
  'AZURE_CLIENT_ID',
  'AZURE_TENANT_ID',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'NPM_TOKEN',
  'NODE_AUTH_TOKEN',
  'VERCEL_TOKEN',
];

/**
 * What the env alone cannot empty, and the overrides that close it (found
 * preparing SESS-36 on this machine: `GH_TOKEN` is not even set here, and
 * an https push would still succeed):
 *
 *  - git's credential helper — `osxkeychain` from the system gitconfig,
 *    or `gh auth git-credential` from a global one — answers an https push
 *    from the keychain with no env involved. `credential.helper=` (empty)
 *    injected through `GIT_CONFIG_COUNT` clears every configured helper,
 *    and it applies last, over system, global and repo config.
 *  - ssh reads `~/.ssh/id_*` without an agent. The ssh command is pinned
 *    to batch mode with no agent and no identity file.
 *  - `gh` keeps its token in the keychain, found through its config dir;
 *    a config dir that cannot exist leaves it logged out.
 *
 * user.name / user.email are untouched, so the agent's commits still
 * carry the person's identity.
 */
export const GIT_OVERRIDES: Readonly<Record<string, string>> = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'credential.helper',
  GIT_CONFIG_VALUE_0: '',
  GIT_SSH_COMMAND:
    'ssh -o BatchMode=yes -o IdentitiesOnly=yes -o IdentityFile=/dev/null -o IdentityAgent=none',
  GH_CONFIG_DIR: '/dev/null/gh',
};

/** The overrides for `acp.start`'s `env`: every scrubbed key empty, and git unable to push. */
export function scrubbedAgentEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of SCRUBBED_ENV_KEYS) env[key] = '';
  return { ...env, ...GIT_OVERRIDES };
}

/** True for a dispatched run whose session may write: a Fix, or *Something else…* with the switch on. */
export function isDispatchedWriter(
  run: Pick<AgentRun, 'entry' | 'modeId'>,
): boolean {
  return run.entry === 'dispatched' && run.modeId !== PLAN_MODE_ID;
}

/** The env overrides a run's session starts (or resumes) with; undefined when none apply. */
export function agentEnvFor(
  run: Pick<AgentRun, 'entry' | 'modeId'>,
): Record<string, string> | undefined {
  return isDispatchedWriter(run) ? scrubbedAgentEnv() : undefined;
}
