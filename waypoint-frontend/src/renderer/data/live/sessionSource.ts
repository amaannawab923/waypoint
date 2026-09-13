// The vendored @emdash/core declarations are ESM (.d.mts); under this
// package's CommonJS resolution a type-only import of them needs to say
// so (TS1541). Types only — nothing from that module exists at runtime.
import type {
  HistoryPage,
  PlanState,
  SessionState,
  TranscriptTurn,
} from '@emdash/core/runtimes/acp/api/client' with {
  'resolution-mode': 'import',
};
import type { ConnectSessionSource } from '@emdash/chat-ui';
import {
  createLiveFollower,
  type LiveFollower,
  type TopicBridge,
} from './liveFollower';

/**
 * One run's live session, as chat-ui wants to consume it — ROAD-60.
 *
 * Three followers (the daemon's `acp.session.activeTurn`, `.plan` and
 * `.state` live models for the run's conversation) plus the history
 * procedure, bundled so a panel asks for a session once and gets back
 * exactly what `connectSession` takes (`connectSource`) and what the
 * transcript is seeded from (`loadHistory`). The conversation id IS the
 * run id (ROAD-55), which is also the only shape the main-process
 * allowlist lets through.
 *
 * `reconnect` re-subscribes every closed follower — the sessions store
 * calls it when the engine reports running again, so one engine restart
 * is one call, not three retry loops.
 */

export interface SessionBridge extends TopicBridge {
  call(procedure: string, input: unknown): Promise<unknown>;
}

export interface SessionSource {
  readonly conversationId: string;
  readonly activeTurn: LiveFollower<TranscriptTurn | null>;
  readonly plan: LiveFollower<PlanState | null>;
  readonly sessionState: LiveFollower<SessionState>;
  /** What chat-ui's connectSession takes. */
  readonly connectSource: ConnectSessionSource;
  loadHistory(options?: {
    before?: number;
    limit?: number;
  }): Promise<HistoryPage>;
  reconnect(): void;
  dispose(): void;
}

export const SESSION_STATES = ['state', 'plan', 'activeTurn'] as const;
export type SessionStateName = (typeof SESSION_STATES)[number];

/** Every per-session state the allowlist admits (main/engine/types.ts ALLOWED_SESSION_STATES); the source follows three, the panel's usage strip a fourth. */
export type SessionTopicState =
  | SessionStateName
  | 'config'
  | 'usage'
  | 'agents'
  | 'draft'
  | 'terminals'
  | 'mcpServers';

/** `acp.session.<state>|{"conversationId":"…"}` — the daemon's topic key, one field, so no key sorting to get wrong. */
export function sessionTopic(
  state: SessionTopicState,
  conversationId: string,
): string {
  return `acp.session.${state}|${JSON.stringify({ conversationId })}`;
}

const DEFAULT_HISTORY_PAGE = 50;

export function createSessionSource(
  conversationId: string,
  bridge: SessionBridge,
): SessionSource {
  const activeTurn = createLiveFollower<TranscriptTurn | null>(
    sessionTopic('activeTurn', conversationId),
    bridge,
  );
  const plan = createLiveFollower<PlanState | null>(
    sessionTopic('plan', conversationId),
    bridge,
  );
  const sessionState = createLiveFollower<SessionState>(
    sessionTopic('state', conversationId),
    bridge,
  );

  const connectSource: ConnectSessionSource = {
    // `null`, never `undefined`, before the first snapshot: connectSession
    // reads it once to remember whether a turn was active, and `undefined
    // !== null` counted as one — its first sync then reported a turn
    // committed and the pane read history twice (found in review).
    activeTurn: {
      getSnapshot: () => activeTurn.getSnapshot() ?? null,
      subscribe: (listener) => activeTurn.subscribe(listener),
    },
    plan,
    sessionState: {
      // connectSession reads only pendingPermissions; hand it a view that
      // is empty until the first snapshot lands rather than undefined,
      // which it would treat as "no permissions" anyway — but explicitly.
      getSnapshot: () => {
        const state = sessionState.getSnapshot();
        return { pendingPermissions: state?.pendingPermissions ?? [] };
      },
      subscribe: (listener) => sessionState.subscribe(listener),
    },
  };

  return {
    conversationId,
    activeTurn,
    plan,
    sessionState,
    connectSource,
    loadHistory(options = {}) {
      return bridge.call('acp.getHistory', {
        conversationId,
        limit: options.limit ?? DEFAULT_HISTORY_PAGE,
        ...(options.before !== undefined ? { before: options.before } : {}),
      }) as Promise<HistoryPage>;
    },
    reconnect() {
      activeTurn.reconnect();
      plan.reconnect();
      sessionState.reconnect();
    },
    dispose() {
      activeTurn.dispose();
      plan.dispose();
      sessionState.dispose();
    },
  };
}
