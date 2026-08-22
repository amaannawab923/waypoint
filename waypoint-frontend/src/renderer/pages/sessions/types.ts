import type { AgentRunStatus } from '@/types/entities';

/**
 * What the dispatcher asked the agent to do — the four presets plus a
 * free-text fallback, from the dispatch-intent design (proposal v2+).
 * `full-coding` is the only intent that results in a PR; the others are
 * lighter-weight and never touch a local checkout.
 */
export type SessionIntent = 'rca' | 'comment' | 'follow-up' | 'full-coding' | 'custom';

export const SESSION_INTENT_LABEL: Record<SessionIntent, string> = {
  rca: 'Research & give RCA',
  comment: 'Comment on the ticket',
  'follow-up': 'Follow up on the ticket',
  'full-coding': 'Start working on this bug',
  custom: 'Custom instruction',
};

/** Only these two intents ever need a local checkout — see the directory-picker note in the proposal. */
export const INTENT_NEEDS_DIRECTORY: Record<SessionIntent, boolean> = {
  rca: true,
  comment: false,
  'follow-up': false,
  'full-coding': true,
  custom: false,
};

export interface SessionMessage {
  id: string;
  role: 'user' | 'agent';
  text: string;
  createdAt: string;
}

/** Statuses a session can still take further action in — used to detect an
 * existing active session on a ticket before silently spawning a duplicate. */
export const ACTIVE_STATUSES: AgentRunStatus[] = ['queued', 'running', 'needs-review', 'blocked'];

/**
 * A single dispatch of a personal agent against one ticket. This is a mock
 * frontend type, deliberately not merged into the real `AgentAssignment`
 * entity yet — nothing here is backed by waypoint-server. See
 * lib/featureFlags.ts.
 */
export interface AgentSession {
  id: string;
  workItemId: string;
  workItemIdentifier: string;
  workItemTitle: string;
  projectId: string;
  projectName: string;
  agentId: string;
  agentName: string;
  agentAvatarColor: string;
  intent: SessionIntent;
  customInstruction?: string;
  status: AgentRunStatus;
  createdAt: string;
  updatedAt: string;
  messages: SessionMessage[];
  /** Unset (or true) until the user opens it — drives the rail's unread treatment. */
  unread: boolean;
}
