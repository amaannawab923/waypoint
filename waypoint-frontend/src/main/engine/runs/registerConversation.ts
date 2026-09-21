import type { DaemonRunsApi } from './daemonApi';

/**
 * Registers a run in the daemon's conversation index right before its
 * session is started — the one helper every `daemon.startSession` call site
 * (cold start, resume, warm, the message-triggered start) goes through, so
 * they cannot drift on the payload or on what a failure means.
 *
 * Best-effort by design: the index is where the ACP runtime's lifecycle
 * reports land and what emdash's own UI lists; Waypoint's view of the
 * session does not depend on it (see CreateConversationRequest). So a
 * failure is logged and the caller starts the session regardless. A record
 * that already exists is success; one that exists with a different
 * immutable field (cwd, createdAt, …) is logged, since the report path
 * still works but the index now describes a different run than the ledger.
 */
export async function registerConversation(
  daemon: Pick<DaemonRunsApi, 'createConversation'>,
  logger: { warn: (m: string, meta?: Record<string, unknown>) => void },
  run: {
    id: string;
    providerId: string;
    title: string | null;
    createdAt: string;
  },
  cwd: string,
): Promise<void> {
  const parsed = Date.parse(run.createdAt);
  try {
    const { mismatch } = await daemon.createConversation({
      conversationId: run.id,
      providerId: run.providerId,
      cwd,
      createdAt: Number.isFinite(parsed) ? parsed : Date.now(),
      title: run.title,
    });
    if (mismatch.length) {
      logger.warn(
        'engine: conversation already registered with different immutable fields',
        { runId: run.id, fields: mismatch },
      );
    }
  } catch (error) {
    logger.warn('engine: conversation registration failed', {
      runId: run.id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
