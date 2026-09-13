import type { ChatContext } from '@emdash/chat-ui';
import { getChatUiRuntime } from '@/components/chat/chatUiRuntime';

/**
 * The one chat-ui `ChatContext` for the app — the shared highlighter,
 * theme and parse caches every transcript (`ChatState`) hangs off. Created
 * on first use and kept for the process, the way emdash's own
 * shared-chat-context.ts does; a per-run context would re-warm the
 * highlighter for every session opened.
 */
let shared: ChatContext | null = null;

export function getSharedChatContext(): ChatContext {
  if (!shared) shared = getChatUiRuntime().createChatContext({});
  return shared;
}

/** Test-only. */
export function resetSharedChatContextForTests(): void {
  shared = null;
}
