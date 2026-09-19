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
  'AZURE_OPENAI_API_KEY',
  'OPENAI_API_KEY',
  'NPM_TOKEN',
  'NODE_AUTH_TOKEN',
  'VERCEL_TOKEN',
  // ROAD-131: other coding-agent providers' own credentials — reachable the
  // same way OPENAI_API_KEY is, if a writing session's agent shells out to
  // another provider's CLI. Deliberately not ANTHROPIC_API_KEY /
  // ANTHROPIC_AUTH_TOKEN — see the keep-list note below.
  'GEMINI_API_KEY',
  'CURSOR_API_KEY',
  'COPILOT_CLI_TOKEN',
  'DASHSCOPE_API_KEY',
  'FACTORY_API_KEY',
  'CODEBUFF_API_KEY',
  'AMP_API_KEY',
  'GROK_CODE_XAI_API_KEY',
];

/**
 * ROAD-131: not scrubbed, on purpose. `ANTHROPIC_API_KEY` and its
 * bearer-token sibling `ANTHROPIC_AUTH_TOKEN` are the credential the
 * dispatched agent's OWN inference calls need — not an escape hatch to
 * somewhere else the way `GH_TOKEN` or the `AWS_*` keys are. Blanking
 * `ANTHROPIC_API_KEY` used to sit in `SCRUBBED_ENV_KEYS` as though it were
 * one more "credential-shaped" name to deny; the real effect was that
 * every dispatched writing session (Fix, or *Something else…* with the
 * switch on) failed outright for anyone authenticated with a plain API
 * key, since that key was wiped with nothing to replace it — while
 * Investigate (plan mode, never scrubbed) kept working on the same
 * machine, and a subscription/OAuth login kept working in Fix too, since
 * that credential lives in `~/.claude` on disk, untouched by env
 * overrides. `ANTHROPIC_AUTH_TOKEN`, its equivalent for a subscription
 * login, was never in the deny-list at all — an accidental omission, not
 * a considered one. Keeping both, explicitly, fixes the functional bug
 * for API-key users and makes the AUTH_TOKEN gap a deliberate, documented
 * decision instead of a drift-prone one: the boundary this scrub actually
 * enforces is "must not reach ANOTHER cloud or service with the person's
 * key", and Anthropic is not another service here — it is the platform
 * already running the agent that is being dispatched.
 */
export const KEPT_ANTHROPIC_ENV_KEYS: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
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

/**
 * ROAD-131: the rest of what an emptied env var cannot close — a
 * credential a *file path* points at, not one an env var carries
 * directly, the same gap `GH_CONFIG_DIR` above already closes for `gh`:
 *
 *  - the AWS CLI/SDKs fall back to `~/.aws/credentials` and `~/.aws/config`
 *    once the `AWS_*` env vars above are empty; pointing the two file
 *    variables at a path that cannot exist leaves them with nothing to
 *    read, same as the env scrub intends.
 *  - `gcloud`'s Application Default Credentials live under
 *    `~/.config/gcloud`; `CLOUDSDK_CONFIG` relocates the whole directory.
 *  - npm reads a registry token out of `~/.npmrc` regardless of
 *    `NPM_TOKEN`/`NODE_AUTH_TOKEN`; `NPM_CONFIG_USERCONFIG` relocates it.
 *  - `curl`, git and other tools read stored basic-auth credentials from
 *    `~/.netrc`; `NETRC` relocates it.
 *
 * Other coding-agent CLIs the session could shell out to keep their own
 * login the same way `gh` does — `CODEX_HOME` (Codex) and `COPILOT_HOME`
 * (the Copilot CLI) get the same treatment as `GH_CONFIG_DIR`. Anthropic's
 * own `CLAUDE_CONFIG_DIR` is deliberately NOT here: see the
 * `KEPT_ANTHROPIC_ENV_KEYS` note above — this is the credential path the
 * dispatched agent itself needs, not one of the ones this scrub exists to
 * close.
 */
export const CREDENTIAL_FILE_OVERRIDES: Readonly<Record<string, string>> = {
  AWS_SHARED_CREDENTIALS_FILE: '/dev/null/aws-credentials',
  AWS_CONFIG_FILE: '/dev/null/aws-config',
  CLOUDSDK_CONFIG: '/dev/null/gcloud',
  NPM_CONFIG_USERCONFIG: '/dev/null/npmrc',
  NETRC: '/dev/null/netrc',
  CODEX_HOME: '/dev/null/codex',
  COPILOT_HOME: '/dev/null/copilot',
};

/** The overrides for `acp.start`'s `env`: every scrubbed key empty, and git unable to push. */
export function scrubbedAgentEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of SCRUBBED_ENV_KEYS) env[key] = '';
  return { ...env, ...GIT_OVERRIDES, ...CREDENTIAL_FILE_OVERRIDES };
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
