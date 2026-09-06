import { Button } from '@/components/ui/Button';
import { isJiraCredentialFailure } from '@/types/jira';

/**
 * What a *failed* Jira read renders, everywhere one can happen.
 *
 * It exists because the three read paths in this feature — the ticket list,
 * a drawer's comments, a row's transition menu — each had an empty state
 * ("No tickets match these filters.", "No comments yet.", "No transitions
 * available from here.") that a swallowed error rendered instead of an
 * error. Each of those sentences is a factual claim about the user's Jira,
 * and making a dead token or an offline laptop assert them is the sharpest
 * kind of thing this app is not supposed to do.
 *
 * The message is main's own, verbatim — `jiraClient.ts` already writes a
 * specific sentence per failure kind ("Jira is rate-limiting this account
 * right now…", "Couldn't reach Jira…") and those are better than anything
 * restated here. `reason` is used for one thing only: deciding whether the
 * fix is "try again" or "reconnect on the Connection tab", because retrying
 * a revoked token forever is its own small lie.
 */
export function JiraLoadError({
  what,
  error,
  onRetry,
  compact,
}: {
  /** What could not be read, as it reads mid-sentence: "your Jira queue". */
  what: string;
  error: Error;
  /** Omitted where there is nothing meaningful to re-run. */
  onRetry?: () => void;
  compact?: boolean;
}) {
  const credentialGone = isJiraCredentialFailure(error);
  return (
    <div
      role="alert"
      className={
        compact
          ? 'px-3 py-3 text-xs leading-relaxed text-danger'
          : 'px-4 py-5 text-center text-[12.5px] leading-relaxed text-danger'
      }
    >
      <b className="font-semibold">Couldn&apos;t load {what}.</b>{' '}
      <span className="text-text-secondary">{error.message}</span>
      {credentialGone && (
        <span className="text-text-secondary">
          {' '}
          Reconnect on the Connection tab.
        </span>
      )}
      {onRetry && !credentialGone && (
        <div className={compact ? 'mt-2' : 'mt-2.5'}>
          <Button size="xs" onClick={onRetry}>
            Try again
          </Button>
        </div>
      )}
    </div>
  );
}
