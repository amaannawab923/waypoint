import type { AgentRun } from './ledgerClient';
import {
  buildPrBody,
  buildPrTitle,
  createPullRequestPublisher,
  describePublish,
  githubRepoOf,
  prUrlOf,
  type CommandResult,
  type HostCommandRunner,
} from './pullRequests';

// W6: the host publishes a writing run's branch — push, then gh —
// against a scripted command runner. Every outcome the design names.

function run(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: 'run-abc1234',
    projectId: 'proj-1',
    ticketId: 'wi-1',
    ownerMemberId: 'mem-1',
    agentId: null,
    entry: 'dispatched',
    providerId: 'claude',
    title: 'ROAD-103 · Fix',
    isolation: 'worktree',
    cwd: '/wt/run-abc1234',
    autoApprove: true,
    modeId: 'bypassPermissions',
    intent: 'fix',
    copilotConversationId: null,
    daemonWorkspaceId: null,
    daemonSessionId: null,
    providerSessionId: null,
    worktreePath: '/wt/run-abc1234',
    branch: 'agent/ROAD-103',
    baseRef: 'main',
    prUrl: null,
    status: 'finishing',
    blockedReason: null,
    errorKind: null,
    errorMessage: null,
    summary: null,
    verdict: null,
    turnCount: 1,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: null,
    retryOfRunId: null,
    createdAt: '2026-09-12T00:00:00.000Z',
    startedAt: null,
    endedAt: null,
    updatedAt: '2026-09-12T00:00:00.000Z',
    ...overrides,
  };
}

const ok = (stdout = ''): CommandResult => ({ stdout, stderr: '', code: 0 });
const bad = (stderr: string, code = 1): CommandResult => ({
  stdout: '',
  stderr,
  code,
});

/** A runner scripted by the command's verb: log, diff, remote, push, gh. */
type Verb = 'log' | 'diff' | 'remote' | 'push' | 'gh';
function scripted(answers: Partial<Record<Verb, CommandResult | Error>>) {
  const calls: Array<{ file: string; args: string[]; cwd: string }> = [];
  const runner: HostCommandRunner = async (file, args, options) => {
    calls.push({ file, args, cwd: options.cwd });
    const verb: Verb =
      file === 'gh'
        ? 'gh'
        : (args.find((a) =>
            ['log', 'diff', 'remote', 'push'].includes(a),
          ) as Verb);
    const answer = answers[verb];
    if (answer instanceof Error) throw answer;
    return answer ?? ok();
  };
  return { runner, calls };
}

function harness(answers: Parameters<typeof scripted>[0]) {
  const { runner, calls } = scripted(answers);
  const ledger = {
    updateRun: jest.fn(async (id: string, patch: Record<string, unknown>) => ({
      id,
      ...patch,
    })),
    appendEvent: jest.fn(async () => ({})),
  };
  const logger = { info: jest.fn(), warn: jest.fn() };
  const publisher = createPullRequestPublisher({
    ledger: ledger as never,
    run: runner,
    logger,
  });
  return { publisher, calls, ledger, logger };
}

const input = (r = run()) => ({
  run: r,
  closingMessage: 'Guarded the write.',
  title: 'ROAD-103: Flaky test',
});

describe('githubRepoOf / prUrlOf', () => {
  it.each([
    ['https://github.com/amaannawab923/waypoint.git', 'amaannawab923/waypoint'],
    ['https://github.com/o/r', 'o/r'],
    ['git@github.com:o/r.git', 'o/r'],
    ['ssh://git@github.com/o/r', 'o/r'],
    ['https://gitlab.com/o/r.git', null],
    ['/tmp/wp-qa/origin.git', null],
  ])('%s → %s', (url, repo) => {
    expect(githubRepoOf(url)).toBe(repo);
  });
  it('reads the URL off gh’s last line', () => {
    expect(
      prUrlOf('Creating pull request…\nhttps://github.com/o/r/pull/61\n'),
    ).toBe('https://github.com/o/r/pull/61');
    expect(prUrlOf('nothing here')).toBeNull();
  });
});

describe('createPullRequestPublisher', () => {
  it('pushes with the safety overrides, opens the PR as the person, records prUrl and the events', async () => {
    const { publisher, calls, ledger } = harness({
      log: ok('abc1234 test: guard the write\n'),
      remote: ok('https://github.com/amaannawab923/waypoint.git\n'),
      push: ok(),
      gh: ok('https://github.com/amaannawab923/waypoint/pull/61\n'),
    });
    const outcome = await publisher.publish(input());
    expect(outcome).toEqual({
      kind: 'opened',
      url: 'https://github.com/amaannawab923/waypoint/pull/61',
      pushed: true,
    });
    const push = calls.find((c) => c.args.includes('push'));
    expect(push?.args).toEqual(
      expect.arrayContaining([
        '-c',
        'core.hooksPath=/dev/null',
        'push',
        '-u',
        'origin',
        'agent/ROAD-103',
      ]),
    );
    expect(push?.cwd).toBe('/wt/run-abc1234');
    const gh = calls.find((c) => c.file === 'gh');
    expect(gh?.args.slice(0, 2)).toEqual(['pr', 'create']);
    expect(gh?.args).toEqual(
      expect.arrayContaining([
        '--repo',
        'amaannawab923/waypoint',
        '--head',
        'agent/ROAD-103',
        '--base',
        'main',
        '--title',
        'test: guard the write',
      ]),
    );
    expect(gh?.args).toContain('--body-file');
    expect(gh?.args).not.toContain('--draft');
    expect(ledger.updateRun).toHaveBeenCalledWith('run-abc1234', {
      prUrl: 'https://github.com/amaannawab923/waypoint/pull/61',
    });
    expect(ledger.appendEvent).toHaveBeenCalledWith('run-abc1234', 'pushed', {
      branch: 'agent/ROAD-103',
      remote: 'origin',
    });
    expect(ledger.appendEvent).toHaveBeenCalledWith(
      'run-abc1234',
      'pr_opened',
      expect.objectContaining({
        url: 'https://github.com/amaannawab923/waypoint/pull/61',
      }),
    );
  });

  it('a push that fails is a failed outcome with git’s sentence, an error event, and no gh call', async () => {
    const { publisher, calls, ledger } = harness({
      log: ok('abc1234 one\nabc1235 two\n'),
      remote: ok('https://github.com/o/r.git'),
      push: bad(
        "fatal: could not read Username for 'https://github.com': terminal prompts disabled\n",
        128,
      ),
    });
    const outcome = await publisher.publish(input());
    expect(outcome).toEqual({
      kind: 'failed',
      stage: 'push',
      message:
        "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    });
    expect(calls.some((c) => c.file === 'gh')).toBe(false);
    expect(ledger.updateRun).not.toHaveBeenCalled();
    expect(ledger.appendEvent).toHaveBeenCalledWith(
      'run-abc1234',
      'error',
      expect.objectContaining({ stage: 'publish:push' }),
    );
  });

  it('a remote that is not GitHub gets the push and no PR; gh missing is a PR failure after the push', async () => {
    const other = harness({
      log: ok('abc1234 test: guard the write'),
      remote: ok('/tmp/wp-qa/origin.git'),
      push: ok(),
    });
    expect(await other.publisher.publish(input())).toMatchObject({
      kind: 'pushed-only',
    });
    expect(other.calls.some((c) => c.file === 'gh')).toBe(false);

    const noGh = harness({
      log: ok('abc1234 test: guard the write'),
      remote: ok('git@github.com:o/r.git'),
      push: ok(),
      gh: new Error('gh: not installed'),
    });
    expect(await noGh.publisher.publish(input())).toEqual({
      kind: 'failed',
      stage: 'pr',
      message: 'gh: not installed',
    });
    expect(noGh.ledger.appendEvent).toHaveBeenCalledWith(
      'run-abc1234',
      'pushed',
      expect.anything(),
    );
  });

  it('a PR gh says already exists is taken as opened', async () => {
    const { publisher } = harness({
      log: ok('abc1234 test: guard the write'),
      remote: ok('https://github.com/o/r'),
      push: ok(),
      gh: bad(
        'a pull request for branch "agent/ROAD-103" into branch "main" already exists:\nhttps://github.com/o/r/pull/7\n',
      ),
    });
    expect(await publisher.publish(input())).toMatchObject({
      kind: 'opened',
      url: 'https://github.com/o/r/pull/7',
    });
  });

  it('skips a run with a PR, a run with no branch, and a branch with nothing past its base', async () => {
    const { publisher, calls } = harness({ log: ok('') });
    expect(
      await publisher.publish(
        input(run({ prUrl: 'https://github.com/o/r/pull/1' })),
      ),
    ).toMatchObject({ kind: 'skipped' });
    expect(await publisher.publish(input(run({ branch: null })))).toMatchObject(
      { kind: 'skipped', reason: 'The run has no branch to push.' },
    );
    expect(await publisher.publish(input())).toMatchObject({
      kind: 'skipped',
      reason: expect.stringContaining('No commits'),
    });
    expect(calls.some((c) => c.args.includes('push'))).toBe(false);
  });

  it('refuses a branch name that is not ref-safe before touching git', async () => {
    const { publisher, calls } = harness({});
    expect(
      await publisher.publish(input(run({ branch: '--upload-pack=x' }))),
    ).toMatchObject({ kind: 'skipped' });
    expect(calls).toHaveLength(0);
  });
});

describe('buildPrBody / describePublish', () => {
  it('the body leads with what the host read off the branch, then the session’s report', () => {
    const facts = {
      commits: ['abc1234 test: guard the write'],
      files: ['M\tsrc/a.ts'],
    };
    const body = buildPrBody(input(), facts);
    expect(body.startsWith('**ROAD-103: Flaky test**')).toBe(true);
    expect(body).toContain(
      'Branch `agent/ROAD-103` from `main`, pushed and opened by Waypoint',
    );
    expect(body).toContain('### Commits\n- abc1234 test: guard the write');
    expect(body).toContain('### Files\n- `M src/a.ts`');
    expect(body.indexOf("### The session's report")).toBeGreaterThan(
      body.indexOf('### Files'),
    );
    expect(body.trim().endsWith('Guarded the write.')).toBe(true);
  });

  // W5b: a Jira issue has a URL a reviewer can open; the heading links it.
  it('a ticket URL turns the heading into a link; none leaves it plain', () => {
    const facts = { commits: [], files: [] };
    expect(
      buildPrBody(
        {
          ...input(),
          ticketUrl: 'https://yourteam.atlassian.net/browse/ENG-4',
        },
        facts,
      ).startsWith(
        '**[ROAD-103: Flaky test](https://yourteam.atlassian.net/browse/ENG-4)**',
      ),
    ).toBe(true);
    expect(
      buildPrBody({ ...input(), ticketUrl: null }, facts).startsWith(
        '**ROAD-103: Flaky test**',
      ),
    ).toBe(true);
  });

  it('the title is the one commit’s subject, else Fix KEY: title for a Fix', () => {
    expect(
      buildPrTitle(input(), {
        commits: ['abc1234 test: guard the write'],
        files: [],
      }),
    ).toBe('test: guard the write');
    expect(
      buildPrTitle(input(), { commits: ['a one', 'b two'], files: [] }),
    ).toBe('Fix ROAD-103: Flaky test');
    expect(buildPrTitle(input(run({ intent: 'custom' })), null)).toBe(
      'ROAD-103: Flaky test',
    );
  });
  it('the comment’s lead line per outcome', () => {
    expect(
      describePublish({
        kind: 'opened',
        url: 'https://github.com/o/r/pull/61',
        pushed: true,
      }),
    ).toBe('Pull request: https://github.com/o/r/pull/61');
    expect(
      describePublish({ kind: 'failed', stage: 'push', message: 'denied' }),
    ).toContain('push failed: denied');
    expect(
      describePublish({ kind: 'failed', stage: 'push', message: 'denied' }),
    ).toContain('Open PR');
  });
});
