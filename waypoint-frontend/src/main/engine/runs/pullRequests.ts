import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentRun, LedgerClient } from './ledgerClient';
import { isRefSafeComponent } from './worktrees';

/**
 * Publishing a writing run's branch — W6, ROAD-76, pulled forward into
 * W5a on the founder's call (2026-09-13: automatic, ready for review).
 *
 * The session never pushes: the env scrub (agentEnv.ts) is what makes an
 * auto-approved Fix safe, and it leaves the agent with no credential at
 * all. So the host does it, after the turn ends, from the run's worktree,
 * as the person: `git push -u origin <branch>` with their own git (the
 * keychain helper, their ssh — the ordinary environment, not execGit's
 * minimal one), then `gh pr create` as their logged-in `gh`. Both are
 * argv arrays, never a shell; the branch and base are ref-safe names
 * the ledger wrote; the title and body ride as arguments and a file.
 *
 * Idempotent: a run that already has a `prUrl` is not published twice
 * (Open PR in the header re-runs this after a failure); a branch with
 * nothing on it past its base is not pushed. A remote that is not
 * GitHub gets the push and no PR, and says so. Every failure is a
 * sentence the run carries — the run still reaches needs-review; the PR
 * is the host's step, not the agent's outcome.
 */

export interface PublishInput {
  run: AgentRun;
  /** The session's report — the PR body's second half. */
  closingMessage: string;
  /** "ROAD-103: Flaky: …" — the ticket's key and title, when known; the title's fallback. */
  title: string;
  /** W5b: a Jira issue's URL, linked from the body's first line; null for a native ticket. */
  ticketUrl?: string | null;
}

/** What the branch holds, read by the host — the PR's first half, never the agent's guess. */
export interface BranchFacts {
  /** `git log --oneline base..HEAD`, oldest first. */
  commits: string[];
  /** `git diff --name-status base..HEAD` lines. */
  files: string[];
}

export type PublishOutcome =
  | { kind: 'opened'; url: string; pushed: true }
  /** Never-lock: a follow-up pushed new commits to the PR that was already open. */
  | { kind: 'updated'; url: string; pushed: true }
  | { kind: 'pushed-only'; reason: string }
  | { kind: 'skipped'; reason: string }
  | { kind: 'failed'; stage: 'push' | 'pr'; message: string };

/** `gh pr view --json state` as this module reads it. */
export type PrState = 'OPEN' | 'MERGED' | 'CLOSED';

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

/** A command in the person's own environment (`git`, `gh`) — argv, never a shell. */
export type HostCommandRunner = (
  file: string,
  args: string[],
  options: { cwd: string; timeoutMs: number },
) => Promise<CommandResult>;

export interface PullRequestsDeps {
  ledger: Pick<LedgerClient, 'updateRun' | 'appendEvent'>;
  /** Defaults to the real `execFile` with the process env. */
  run?: HostCommandRunner;
  logger: {
    info: (m: string, meta?: Record<string, unknown>) => void;
    warn: (m: string, meta?: Record<string, unknown>) => void;
  };
}

export const PUSH_TIMEOUT_MS = 2 * 60_000;
export const PR_TIMEOUT_MS = 60_000;
/** The most of the closing message the PR body carries. */
export const MAX_PR_BODY_CHARS = 60_000;
export const MAX_PR_TITLE_CHARS = 200;

// The safety overrides execGit applies to a worktree the agent wrote to
// (runsIpc.ts GIT_SAFE_CONFIG): repo-local config must not turn a push
// into a code path. `core.sshCommand` is not cleared here — a push over
// ssh needs the person's own.
const PUSH_SAFE_CONFIG = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.pager=cat',
];

export const execHostCommand: HostCommandRunner = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        cwd: options.cwd,
        timeout: options.timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        env: {
          ...process.env,
          // A push that would prompt fails instead of hanging main.
          GIT_TERMINAL_PROMPT: '0',
          GH_PROMPT_DISABLED: '1',
          GH_NO_UPDATE_NOTIFIER: '1',
        },
      },
      (error, stdout, stderr) => {
        const e = error as
          (NodeJS.ErrnoException & { code?: number | string }) | null;
        if (e && typeof e.code === 'string') {
          // ENOENT and friends: the tool is not there at all.
          reject(
            new Error(
              `${file}: ${e.code === 'ENOENT' ? 'not installed' : e.message}`,
            ),
          );
          return;
        }
        resolve({
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          code: e ? (typeof e.code === 'number' ? e.code : null) : 0,
        });
      },
    );
  });

/** `owner/repo` from a GitHub remote URL (https or ssh), else null. */
export function githubRepoOf(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim();
  const m =
    /^https?:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(
      trimmed,
    ) ??
    /^(?:ssh:\/\/)?git@github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(
      trimmed,
    );
  return m ? `${m[1]}/${m[2]}` : null;
}

/** The PR URL in `gh pr create`'s output (its last line). */
export function prUrlOf(stdout: string): string | null {
  const lines = stdout
    .trim()
    .split('\n')
    .map((l) => l.trim());
  const url = [...lines]
    .reverse()
    .find((l) => /^https:\/\/github\.com\/.+\/pull\/\d+$/.test(l));
  return url ?? null;
}

function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .find((l) => l.trim())
      ?.trim() ?? ''
  );
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The PR's title: the change, not the bug (PM review of W5a). One commit
 * on the branch → its subject, which is the agent's own name for what it
 * did; more than one → "Fix KEY: title" for a Fix, "KEY: title" otherwise.
 */
export function buildPrTitle(
  input: PublishInput,
  facts: BranchFacts | null,
): string {
  const { run } = input;
  if (facts && facts.commits.length === 1) {
    const subject = facts.commits[0].replace(/^[0-9a-f]{7,40}\s+/, '').trim();
    if (subject) return clip(subject, MAX_PR_TITLE_CHARS);
  }
  const ticket = firstLine(input.title) || run.title || run.branch || run.id;
  return clip(
    run.intent === 'fix' ? `Fix ${ticket}` : ticket,
    MAX_PR_TITLE_CHARS,
  );
}

/**
 * The body `gh` posts: what the branch holds, as the host read it (never
 * the agent's guess at its own branch name — found in PR #62: "Branch:
 * agent/ROAD-43 … Not pushed", on a branch named `-0uftaro` that Waypoint
 * had just pushed), then the session's report.
 */
export function buildPrBody(
  input: PublishInput,
  facts: BranchFacts | null,
): string {
  const { run } = input;
  const heading = firstLine(input.title) || run.title || run.id;
  const lines = [
    input.ticketUrl ? `**[${heading}](${input.ticketUrl})**` : `**${heading}**`,
    '',
    `Branch \`${run.branch}\`${run.baseRef ? ` from \`${run.baseRef}\`` : ''}, pushed and opened by Waypoint as the run's owner from run \`${run.title ?? run.id}\` (${run.id}). The session worked in a fresh worktree with no credentials.`,
  ];
  if (facts && facts.commits.length) {
    lines.push('', '### Commits', ...facts.commits.map((c) => `- ${c}`));
  }
  if (facts && facts.files.length) {
    lines.push(
      '',
      '### Files',
      ...facts.files.map((f) => `- \`${f.replace(/\t/g, ' ')}\``),
    );
  }
  lines.push(
    '',
    "### The session's report",
    '',
    clip(input.closingMessage.trim(), MAX_PR_BODY_CHARS),
  );
  return lines.join('\n');
}

export interface PullRequestPublisher {
  /** Push the run's branch and open the PR; never throws. Records the outcome on the run. */
  publish(input: PublishInput): Promise<PublishOutcome>;
  /**
   * Never-lock (design §4.5): a continued run's later report. With no PR
   * yet, `publish`; with one still open, push to it (`updated`); with one
   * merged, closed, or not resolvable under origin's repository, clear
   * `prUrl` and `publish` a new one. Return-value only, like `publish`.
   * The caller (finalize) holds the ticket lock and the backend's publish
   * claim before calling this.
   */
  publishFollowUp(input: PublishInput): Promise<PublishOutcome>;
}

/** What `gh pr view` said about the PR a run tracks. */
export type PrLookup =
  | { kind: 'state'; state: PrState; url: string }
  | { kind: 'not-found' }
  | { kind: 'auth'; message: string }
  | { kind: 'no-gh' }
  | { kind: 'failed'; message: string };

export function createPullRequestPublisher(
  deps: PullRequestsDeps,
): PullRequestPublisher {
  const runCommand = deps.run ?? execHostCommand;

  const record = async (
    run: AgentRun,
    outcome: PublishOutcome,
  ): Promise<void> => {
    try {
      if (outcome.kind === 'opened') {
        await deps.ledger.updateRun(run.id, { prUrl: outcome.url });
        await deps.ledger.appendEvent(run.id, 'pr_opened', {
          url: outcome.url,
          branch: run.branch,
        });
      } else if (outcome.kind === 'updated') {
        await deps.ledger.appendEvent(run.id, 'pr_opened', {
          url: outcome.url,
          branch: run.branch,
          updated: true,
        });
      } else if (outcome.kind === 'failed') {
        await deps.ledger.appendEvent(run.id, 'error', {
          stage: `publish:${outcome.stage}`,
          message: clip(outcome.message, 4000),
        });
      } else {
        await deps.ledger.appendEvent(run.id, 'note', {
          publish: outcome.kind,
          reason: outcome.reason,
        });
      }
    } catch (error) {
      deps.logger.warn('engine: publish outcome not recorded', {
        runId: run.id,
        message: describe(error),
      });
    }
  };

  /**
   * `gh pr view <url> --repo <origin's repo> --json state,url` — new
   * surface (nothing queried a PR's state before; `publish` only ever
   * read `gh pr create`'s stderr). Read-only, return-value only.
   */
  const lookupPr = async (
    prUrl: string,
    repo: string,
    cwd: string,
  ): Promise<PrLookup> => {
    let result: CommandResult;
    try {
      result = await runCommand(
        'gh',
        ['pr', 'view', prUrl, '--repo', repo, '--json', 'state,url'],
        { cwd, timeoutMs: PR_TIMEOUT_MS },
      );
    } catch (error) {
      const message = describe(error);
      if (/ENOENT|not found|no such file/i.test(message))
        return { kind: 'no-gh' };
      return { kind: 'failed', message };
    }
    if (result.code !== 0) {
      const err = result.stderr;
      if (/gh auth login|authentication|not logged in/i.test(err)) {
        return { kind: 'auth', message: firstLine(err) };
      }
      if (
        /could not resolve|no pull requests found|not found|Could not find/i.test(
          err,
        )
      ) {
        return { kind: 'not-found' };
      }
      return {
        kind: 'failed',
        message: firstLine(err) || `gh pr view exited ${result.code}`,
      };
    }
    try {
      const parsed = JSON.parse(result.stdout) as {
        state?: unknown;
        url?: unknown;
      };
      const { state } = parsed;
      if (state !== 'OPEN' && state !== 'MERGED' && state !== 'CLOSED') {
        return {
          kind: 'failed',
          message: `gh answered an unknown PR state: ${String(state)}`,
        };
      }
      const url =
        typeof parsed.url === 'string' ? (prUrlOf(parsed.url) ?? prUrl) : prUrl;
      return { kind: 'state', state, url };
    } catch (error) {
      return {
        kind: 'failed',
        message: `gh pr view did not answer JSON: ${describe(error)}`,
      };
    }
  };

  const pushExisting = async (
    run: AgentRun,
    cwd: string,
    branch: string,
  ): Promise<PublishOutcome | null> => {
    let push: CommandResult;
    try {
      push = await runCommand(
        'git',
        [...PUSH_SAFE_CONFIG, 'push', 'origin', branch],
        { cwd, timeoutMs: PUSH_TIMEOUT_MS },
      );
    } catch (error) {
      return { kind: 'failed', stage: 'push', message: describe(error) };
    }
    if (push.code !== 0) {
      return {
        kind: 'failed',
        stage: 'push',
        message: firstLine(push.stderr) || `git push exited ${push.code}`,
      };
    }
    await deps.ledger
      .appendEvent(run.id, 'pushed', {
        branch,
        remote: 'origin',
        followUp: true,
      })
      .catch(() => {});
    return null;
  };

  const publisher: PullRequestPublisher = {
    async publish(input) {
      const { run } = input;
      const cwd = run.worktreePath ?? run.cwd;
      const outcome = await (async (): Promise<PublishOutcome> => {
        if (run.prUrl)
          return {
            kind: 'skipped',
            reason: `A pull request is already open: ${run.prUrl}`,
          };
        if (
          !cwd ||
          !run.branch ||
          !run.branch.split('/').every(isRefSafeComponent)
        ) {
          return { kind: 'skipped', reason: 'The run has no branch to push.' };
        }
        const base =
          run.baseRef && run.baseRef.split('/').every(isRefSafeComponent)
            ? run.baseRef
            : null;

        // What the branch holds, read by the host: the PR's facts, and the
        // check that there is anything to publish at all.
        let facts: BranchFacts | null = null;
        if (base) {
          const [log, diff] = await Promise.all([
            runCommand(
              'git',
              [
                ...PUSH_SAFE_CONFIG,
                'log',
                '--oneline',
                '--no-decorate',
                '--reverse',
                `${base}..HEAD`,
                '--',
              ],
              { cwd, timeoutMs: 20_000 },
            ).catch(() => null),
            runCommand(
              'git',
              [
                ...PUSH_SAFE_CONFIG,
                'diff',
                '--name-status',
                `${base}..HEAD`,
                '--',
              ],
              { cwd, timeoutMs: 20_000 },
            ).catch(() => null),
          ]);
          if (log && log.code === 0) {
            facts = {
              commits: log.stdout
                .split('\n')
                .map((l) => l.trim())
                .filter(Boolean)
                .slice(0, 50),
              files:
                diff && diff.code === 0
                  ? diff.stdout
                      .split('\n')
                      .map((l) => l.trim())
                      .filter(Boolean)
                      .slice(0, 100)
                  : [],
            };
            if (facts.commits.length === 0) {
              return {
                kind: 'skipped',
                reason: `No commits on ${run.branch} past ${base}; nothing to push.`,
              };
            }
          }
        }

        const remote = await runCommand(
          'git',
          [...PUSH_SAFE_CONFIG, 'remote', 'get-url', 'origin'],
          { cwd, timeoutMs: 20_000 },
        ).catch((error: unknown) => ({
          stdout: '',
          stderr: describe(error),
          code: null,
        }));
        if (remote.code !== 0) {
          return {
            kind: 'skipped',
            reason: 'The repository has no origin remote to push to.',
          };
        }
        const repo = githubRepoOf(remote.stdout);

        let push: CommandResult;
        try {
          push = await runCommand(
            'git',
            [...PUSH_SAFE_CONFIG, 'push', '-u', 'origin', run.branch],
            { cwd, timeoutMs: PUSH_TIMEOUT_MS },
          );
        } catch (error) {
          return { kind: 'failed', stage: 'push', message: describe(error) };
        }
        if (push.code !== 0) {
          return {
            kind: 'failed',
            stage: 'push',
            message: firstLine(push.stderr) || `git push exited ${push.code}`,
          };
        }
        await deps.ledger
          .appendEvent(run.id, 'pushed', {
            branch: run.branch,
            remote: 'origin',
          })
          .catch(() => {});
        if (!repo) {
          return {
            kind: 'pushed-only',
            reason: `Pushed ${run.branch} to origin; the remote is not GitHub, so no pull request was opened.`,
          };
        }

        let bodyFile: string | null = null;
        try {
          bodyFile = path.join(
            await fs.mkdtemp(path.join(os.tmpdir(), 'wp-pr-')),
            'body.md',
          );
          await fs.writeFile(bodyFile, buildPrBody(input, facts), 'utf8');
          const pr = await runCommand(
            'gh',
            [
              'pr',
              'create',
              '--repo',
              repo,
              '--head',
              run.branch,
              ...(base ? ['--base', base] : []),
              '--title',
              buildPrTitle(input, facts),
              '--body-file',
              bodyFile,
            ],
            { cwd, timeoutMs: PR_TIMEOUT_MS },
          );
          if (pr.code !== 0) {
            // A PR already open for this branch: gh says so and names it.
            const existing = prUrlOf(pr.stderr) ?? prUrlOf(pr.stdout);
            if (existing)
              return { kind: 'opened', url: existing, pushed: true };
            return {
              kind: 'failed',
              stage: 'pr',
              message: firstLine(pr.stderr) || `gh pr create exited ${pr.code}`,
            };
          }
          const url = prUrlOf(pr.stdout);
          if (!url) {
            return {
              kind: 'failed',
              stage: 'pr',
              message: 'gh did not answer with a pull request URL.',
            };
          }
          return { kind: 'opened', url, pushed: true };
        } catch (error) {
          return { kind: 'failed', stage: 'pr', message: describe(error) };
        } finally {
          if (bodyFile)
            await fs
              .rm(path.dirname(bodyFile), { recursive: true, force: true })
              .catch(() => {});
        }
      })();

      deps.logger.info('engine: run published', {
        runId: run.id,
        outcome: outcome.kind,
        ...(outcome.kind === 'opened' ? { url: outcome.url } : {}),
        ...(outcome.kind === 'failed'
          ? { stage: outcome.stage, message: outcome.message }
          : {}),
        ...(outcome.kind === 'skipped' || outcome.kind === 'pushed-only'
          ? { reason: outcome.reason }
          : {}),
      });
      await record(run, outcome);
      return outcome;
    },

    async publishFollowUp(input) {
      const { run } = input;
      const cwd = run.worktreePath ?? run.cwd;
      if (!run.prUrl) return publisher.publish(input);
      const { branch } = run;
      if (!cwd || !branch || !branch.split('/').every(isRefSafeComponent)) {
        const outcome: PublishOutcome = {
          kind: 'skipped',
          reason: 'The run has no branch to push.',
        };
        await record(run, outcome);
        return outcome;
      }
      const remote = await runCommand(
        'git',
        [...PUSH_SAFE_CONFIG, 'remote', 'get-url', 'origin'],
        { cwd, timeoutMs: 20_000 },
      ).catch((error: unknown) => ({
        stdout: '',
        stderr: describe(error),
        code: null,
      }));
      const repo = remote.code === 0 ? githubRepoOf(remote.stdout) : null;

      // Waypoint only ever publishes to origin, so the PR it tracks must
      // be resolvable under origin's repository; anything else — a fork,
      // another remote — is "not ours any more" and gets a new PR.
      const looked: PrLookup = repo
        ? await lookupPr(run.prUrl, repo, cwd)
        : { kind: 'no-gh' };

      if (looked.kind === 'auth' || looked.kind === 'failed') {
        const outcome: PublishOutcome = {
          kind: 'failed',
          stage: 'pr',
          message: looked.message,
        };
        await record(run, outcome);
        return outcome;
      }
      if (looked.kind === 'state' && looked.state === 'OPEN') {
        const failed = await pushExisting(run, cwd, branch);
        const outcome: PublishOutcome = failed ?? {
          kind: 'updated',
          url: looked.url,
          pushed: true,
        };
        await record(run, outcome);
        deps.logger.info('engine: run follow-up published', {
          runId: run.id,
          outcome: outcome.kind,
        });
        return outcome;
      }
      if (looked.kind === 'no-gh') {
        // gh is not here (or origin is not GitHub): push to the branch
        // and say so, as publish does.
        const failed = await pushExisting(run, cwd, branch);
        const outcome: PublishOutcome = failed ?? {
          kind: 'pushed-only',
          reason: `Pushed ${branch} to origin; the pull request's state could not be read, so it was left as it is.`,
        };
        await record(run, outcome);
        return outcome;
      }
      // MERGED / CLOSED / not found under origin: the PR the run tracks
      // is over. Clear it (legal on a finishing row) and open a new one —
      // `publish` records that outcome itself.
      await deps.ledger.updateRun(run.id, { prUrl: null }).catch(() => {});
      await deps.ledger
        .appendEvent(run.id, 'note', {
          stage: 'finalize',
          publish: 'pr-superseded',
          previousUrl: run.prUrl,
          state: looked.kind === 'state' ? looked.state : 'not-found',
        })
        .catch(() => {});
      return publisher.publish({ ...input, run: { ...run, prUrl: null } });
    },
  };
  return publisher;
}

/** The line a comment and a note lead with. */
export function describePublish(outcome: PublishOutcome): string {
  switch (outcome.kind) {
    case 'opened':
      return `Pull request: ${outcome.url}`;
    case 'updated':
      return `Pull request updated: ${outcome.url}`;
    case 'pushed-only':
      return outcome.reason;
    case 'skipped':
      return outcome.reason;
    case 'failed':
      return `The branch was not published (${outcome.stage === 'push' ? 'push' : 'pull request'} failed: ${outcome.message}). Open PR from the run's header to retry.`;
  }
}
