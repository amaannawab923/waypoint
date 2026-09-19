import { PLAN_MODE_ID, AUTO_APPROVE_MODE_ID } from '../types';
import {
  agentEnvFor,
  CREDENTIAL_FILE_OVERRIDES,
  GIT_OVERRIDES,
  isDispatchedWriter,
  KEPT_ANTHROPIC_ENV_KEYS,
  scrubbedAgentEnv,
  SCRUBBED_ENV_KEYS,
} from './agentEnv';

// ROAD-131: the credential scrub for a dispatched writing session must
// close real escape hatches (other services' credentials, on-disk and
// env-var alike) without also taking away the credential the dispatched
// agent's own inference needs — the bug that made every Fix session fail
// outright for a plain-API-key-authenticated user (docs: PR #59 review,
// ROAD-131 §2 "agentEnv.ts").

describe('scrubbedAgentEnv', () => {
  it('never touches ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN — the agent needs one of them to run at all', () => {
    const env = scrubbedAgentEnv();
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN');
    for (const key of KEPT_ANTHROPIC_ENV_KEYS) {
      expect(SCRUBBED_ENV_KEYS).not.toContain(key);
      expect(env).not.toHaveProperty(key);
    }
  });

  it('a plain API key survives untouched through the scrub overrides', () => {
    // scrubbedAgentEnv() only returns the OVERRIDES that acp.start merges
    // over the process's inherited env (plugin-host.ts buildAcpSpawn:
    // `{...agentEnv, ...ctx.env}`); the regression is that the override
    // object itself used to carry `ANTHROPIC_API_KEY: ''`, blanking
    // whatever the inherited env had. Asserting the key is entirely
    // absent from the overrides is exactly what stops that.
    const env = scrubbedAgentEnv();
    expect(Object.keys(env)).not.toContain('ANTHROPIC_API_KEY');
  });

  it('still scrubs every other-service credential the design boundary is actually for', () => {
    const env = scrubbedAgentEnv();
    for (const key of [
      'GH_TOKEN',
      'GITHUB_TOKEN',
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'OPENAI_API_KEY',
      'GOOGLE_API_KEY',
      'AZURE_CLIENT_SECRET',
    ]) {
      expect(SCRUBBED_ENV_KEYS).toContain(key);
      expect(env[key]).toBe('');
    }
  });

  it('closes the missing other-provider credentials named in the review (ROAD-131)', () => {
    const env = scrubbedAgentEnv();
    for (const key of [
      'GEMINI_API_KEY',
      'AZURE_OPENAI_API_KEY',
      'CURSOR_API_KEY',
      'COPILOT_CLI_TOKEN',
      'DASHSCOPE_API_KEY',
      'FACTORY_API_KEY',
      'CODEBUFF_API_KEY',
      'AMP_API_KEY',
      'GROK_CODE_XAI_API_KEY',
    ]) {
      expect(SCRUBBED_ENV_KEYS).toContain(key);
      expect(env[key]).toBe('');
    }
  });

  it('relocates the on-disk credential stores an emptied env var cannot reach', () => {
    const env = scrubbedAgentEnv();
    for (const key of [
      'AWS_SHARED_CREDENTIALS_FILE',
      'AWS_CONFIG_FILE',
      'CLOUDSDK_CONFIG',
      'NPM_CONFIG_USERCONFIG',
      'NETRC',
    ]) {
      expect(CREDENTIAL_FILE_OVERRIDES).toHaveProperty(key);
      expect(env[key]).toBe(CREDENTIAL_FILE_OVERRIDES[key]);
      expect(env[key]).not.toBe('');
    }
  });

  it("redirects other coding-agent CLIs' config dirs the same way GH_CONFIG_DIR is, but leaves CLAUDE_CONFIG_DIR alone", () => {
    const env = scrubbedAgentEnv();
    expect(env.CODEX_HOME).toBe('/dev/null/codex');
    expect(env.COPILOT_HOME).toBe('/dev/null/copilot');
    expect(env.GH_CONFIG_DIR).toBe(GIT_OVERRIDES.GH_CONFIG_DIR);
    expect(env).not.toHaveProperty('CLAUDE_CONFIG_DIR');
  });
});

describe('isDispatchedWriter / agentEnvFor', () => {
  it('scrubs a dispatched Fix (bypassPermissions) but not a dispatched Investigate (plan mode)', () => {
    expect(
      isDispatchedWriter({ entry: 'dispatched', modeId: AUTO_APPROVE_MODE_ID }),
    ).toBe(true);
    expect(
      isDispatchedWriter({ entry: 'dispatched', modeId: PLAN_MODE_ID }),
    ).toBe(false);
    expect(isDispatchedWriter({ entry: 'independent', modeId: null })).toBe(
      false,
    );
    expect(
      agentEnvFor({ entry: 'dispatched', modeId: PLAN_MODE_ID }),
    ).toBeUndefined();
    expect(
      agentEnvFor({ entry: 'dispatched', modeId: AUTO_APPROVE_MODE_ID })
        ?.GH_TOKEN,
    ).toBe('');
  });
});
