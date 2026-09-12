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
  /** The PR's body: the closing message, then Waypoint's footer. */
  closingMessage: string;
  /** "ROAD-103: Flaky: …" — the ticket's key and title, when known. */
  title: string;
}

export type PublishOutcome =
  | { kind: 'opened'; url: string; pushed: true }
  | { kind: 'pushed-only'; reason: string }
  | { kind: 'skipped'; reason: string }
  | { kind: 'failed'; stage: 'push' | 'pr'; message: string };

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

/** The body `gh` posts: the closing message, then where it came from. */
export function buildPrBody(input: PublishInput): string {
  const { run } = input;
  return [
    clip(input.closingMessage.trim(), MAX_PR_BODY_CHARS),
    '',
    '---',
    `Opened by Waypoint from run \`${run.title ?? run.id}\` (${run.id}) on branch \`${run.branch}\`${run.baseRef ? ` from \`${run.baseRef}\`` : ''}. The session ran in a fresh worktree with no credentials; the branch was pushed and this pull request opened by the run's owner from Waypoint.`,
  ].join('\n');
}

export interface PullRequestPublisher {
  /** Push the run's branch and open the PR; never throws. Records the outcome on the run. */
  publish(input: PublishInput): Promise<PublishOutcome>;
}

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

  return {
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

        // Anything to publish? A Fix that changed nothing has no branch worth a PR.
        if (base) {
          const ahead = await runCommand(
            'git',
            [...PUSH_SAFE_CONFIG, 'rev-list', '--count', `${base}..HEAD`, '--'],
            { cwd, timeoutMs: 20_000 },
          ).catch(() => null);
          if (
            ahead &&
            ahead.code === 0 &&
            Number.parseInt(ahead.stdout.trim(), 10) === 0
          ) {
            return {
              kind: 'skipped',
              reason: `No commits on ${run.branch} past ${base}; nothing to push.`,
            };
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
          await fs.writeFile(bodyFile, buildPrBody(input), 'utf8');
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
              clip(
                firstLine(input.title) || run.title || run.branch,
                MAX_PR_TITLE_CHARS,
              ),
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
  };
}

/** The line a comment and a note lead with. */
export function describePublish(outcome: PublishOutcome): string {
  switch (outcome.kind) {
    case 'opened':
      return `Pull request: ${outcome.url}`;
    case 'pushed-only':
      return outcome.reason;
    case 'skipped':
      return outcome.reason;
    case 'failed':
      return `The branch was not published (${outcome.stage === 'push' ? 'push' : 'pull request'} failed: ${outcome.message}). Open PR from the run's header to retry.`;
  }
}
