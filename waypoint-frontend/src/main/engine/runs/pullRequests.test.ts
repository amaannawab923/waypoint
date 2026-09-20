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
    reopenCount: 0,
    lastReopenedAt: null,
    finalizeCount: 0,
    finalizedHeadSha: null,
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

/** A runner scripted by the command's verb: log, diff, remote, push, gh (create), ghView (never-lock's `gh pr view`). */
type Verb = 'log' | 'diff' | 'remote' | 'push' | 'gh' | 'ghView';
function scripted(answers: Partial<Record<Verb, CommandResult | Error>>) {
  const calls: Array<{ file: string; args: string[]; cwd: string }> = [];
  const runner: HostCommandRunner = async (file, args, options) => {
    calls.push({ file, args, cwd: options.cwd });
    let ghVerb: Verb = 'gh';
    if (file === 'gh' && args[1] === 'view') ghVerb = 'ghView';
    const verb: Verb =
      file === 'gh'
        ? ghVerb
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

// Never-lock (design §4.5): a continued run's later report. The PR the run
// tracks is looked up under origin's repository: open → push to it
// (`updated`); merged, closed or not ours → clear it and open a new one;
// auth/other failure → failed, no push; gh missing → push, pushed-only.
describe('publishFollowUp', () => {
  const remote = ok('git@github.com:acme/widgets.git\n');
  const tracked = () =>
    run({ prUrl: 'https://github.com/acme/widgets/pull/7' });

  it('with no PR yet it is plain publish', async () => {
    const { publisher, calls } = harness({
      remote,
      log: ok('abc1 one\n'),
      gh: ok('https://github.com/acme/widgets/pull/9\n'),
    });
    const outcome = await publisher.publishFollowUp(
      input(run({ prUrl: null })),
    );
    expect(outcome).toEqual({
      kind: 'opened',
      url: 'https://github.com/acme/widgets/pull/9',
      pushed: true,
    });
    expect(calls.some((c) => c.args[1] === 'view')).toBe(false);
  });

  it('an OPEN PR gets the new commits pushed to it: `updated`, a pushed{followUp} event, the pr_opened{updated} record, never a create', async () => {
    const { publisher, calls, ledger } = harness({
      remote,
      ghView: ok(
        JSON.stringify({
          state: 'OPEN',
          url: 'https://github.com/acme/widgets/pull/7',
        }),
      ),
    });
    const outcome = await publisher.publishFollowUp(input(tracked()));
    expect(outcome).toEqual({
      kind: 'updated',
      url: 'https://github.com/acme/widgets/pull/7',
      pushed: true,
    });
    const view = calls.find((c) => c.args[1] === 'view')!;
    expect(view.args).toEqual([
      'pr',
      'view',
      'https://github.com/acme/widgets/pull/7',
      '--repo',
      'acme/widgets',
      '--json',
      'state,url',
    ]);
    const push = calls.find((c) => c.args.includes('push'))!;
    expect(push.args.slice(-3)).toEqual(['push', 'origin', 'agent/ROAD-103']);
    expect(push.args).not.toContain('-u');
    expect(calls.some((c) => c.args[1] === 'create')).toBe(false);
    expect(ledger.appendEvent).toHaveBeenCalledWith(
      'run-abc1234',
      'pushed',
      expect.objectContaining({ followUp: true }),
    );
    expect(ledger.appendEvent).toHaveBeenCalledWith(
      'run-abc1234',
      'pr_opened',
      expect.objectContaining({ updated: true }),
    );
    expect(ledger.updateRun).not.toHaveBeenCalled();
  });

  it.each(['MERGED', 'CLOSED'])(
    'a %s PR is over: prUrl cleared, a pr-superseded note, and a new PR opened',
    async (state) => {
      const { publisher, calls, ledger } = harness({
        remote,
        log: ok('abc1 one\n'),
        ghView: ok(
          JSON.stringify({
            state,
            url: 'https://github.com/acme/widgets/pull/7',
          }),
        ),
        gh: ok('https://github.com/acme/widgets/pull/12\n'),
      });
      const outcome = await publisher.publishFollowUp(input(tracked()));
      expect(outcome).toEqual({
        kind: 'opened',
        url: 'https://github.com/acme/widgets/pull/12',
        pushed: true,
      });
      expect(ledger.updateRun).toHaveBeenCalledWith('run-abc1234', {
        prUrl: null,
      });
      expect(ledger.appendEvent).toHaveBeenCalledWith(
        'run-abc1234',
        'note',
        expect.objectContaining({
          publish: 'pr-superseded',
          previousUrl: 'https://github.com/acme/widgets/pull/7',
          state,
        }),
      );
      expect(calls.some((c) => c.args[1] === 'create')).toBe(true);
      expect(ledger.updateRun).toHaveBeenCalledWith('run-abc1234', {
        prUrl: 'https://github.com/acme/widgets/pull/12',
      });
    },
  );

  it('a PR gh cannot find under origin’s repository (a fork, another remote) is treated as over: a new PR against origin', async () => {
    const { publisher, ledger } = harness({
      remote,
      log: ok('abc1 one\n'),
      ghView: bad(
        'GraphQL: Could not resolve to a PullRequest with the number of 7.',
      ),
      gh: ok('https://github.com/acme/widgets/pull/13\n'),
    });
    const outcome = await publisher.publishFollowUp(input(tracked()));
    expect(outcome).toMatchObject({
      kind: 'opened',
      url: 'https://github.com/acme/widgets/pull/13',
    });
    expect(ledger.appendEvent).toHaveBeenCalledWith(
      'run-abc1234',
      'note',
      expect.objectContaining({ publish: 'pr-superseded', state: 'not-found' }),
    );
  });

  // Found in review, round 3: the old regex was a bare "could not
  // resolve", which a DNS failure phrased as "could not resolve host
  // github.com" would ALSO match — misclassifying a network blip as "the
  // PR is gone" and needlessly clearing a still-valid prUrl (as the test
  // above does correctly for gh's own "Could not resolve to a
  // PullRequest..." GraphQL phrasing). Narrowed to require "resolve to
  // a", which a plain host-resolution failure never says.
  it('a DNS/network "could not resolve host" failure is a plain pr failure, not treated as the PR being gone', async () => {
    const dns = harness({
      remote,
      ghView: bad('curl: (6) Could not resolve host: github.com'),
    });
    expect(await dns.publisher.publishFollowUp(input(tracked()))).toEqual({
      kind: 'failed',
      stage: 'pr',
      message: 'curl: (6) Could not resolve host: github.com',
    });
    expect(dns.ledger.updateRun).not.toHaveBeenCalledWith('run-abc1234', {
      prUrl: null,
    });
    expect(dns.calls.some((c) => c.args.includes('push'))).toBe(false);
  });

  it('an auth failure from gh is a pr failure with no push; a timeout or other failure likewise', async () => {
    const auth = harness({
      remote,
      ghView: bad('error: gh auth login required'),
    });
    expect(await auth.publisher.publishFollowUp(input(tracked()))).toEqual({
      kind: 'failed',
      stage: 'pr',
      message: 'error: gh auth login required',
    });
    expect(auth.calls.some((c) => c.args.includes('push'))).toBe(false);
    const other = harness({ remote, ghView: bad('timed out after 60000ms') });
    expect(
      await other.publisher.publishFollowUp(input(tracked())),
    ).toMatchObject({ kind: 'failed', stage: 'pr' });
    expect(other.calls.some((c) => c.args.includes('push'))).toBe(false);
  });

  it('gh missing, or origin not GitHub: push to the branch and say the PR was left as it is', async () => {
    const noGh = harness({ remote, ghView: new Error('spawn gh ENOENT') });
    expect(
      await noGh.publisher.publishFollowUp(input(tracked())),
    ).toMatchObject({ kind: 'pushed-only' });
    expect(noGh.calls.some((c) => c.args.includes('push'))).toBe(true);
    const notGithub = harness({
      remote: ok('https://gitlab.com/acme/widgets.git\n'),
    });
    expect(
      await notGithub.publisher.publishFollowUp(input(tracked())),
    ).toMatchObject({ kind: 'pushed-only' });
  });

  it('a push to an open PR that fails is a push failure with git’s sentence', async () => {
    const { publisher } = harness({
      remote,
      ghView: ok(
        JSON.stringify({
          state: 'OPEN',
          url: 'https://github.com/acme/widgets/pull/7',
        }),
      ),
      push: bad(
        '! [rejected] agent/ROAD-103 -> agent/ROAD-103 (non-fast-forward)',
      ),
    });
    expect(await publisher.publishFollowUp(input(tracked()))).toEqual({
      kind: 'failed',
      stage: 'push',
      message:
        '! [rejected] agent/ROAD-103 -> agent/ROAD-103 (non-fast-forward)',
    });
  });

  it('never throws — a runner that throws on view is a failed outcome', async () => {
    const { publisher } = harness({ remote, ghView: new Error('boom') });
    await expect(
      publisher.publishFollowUp(input(tracked())),
    ).resolves.toMatchObject({ kind: 'failed' });
  });
});
