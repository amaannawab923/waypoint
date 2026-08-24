import { eq, asc } from 'drizzle-orm';
import { db } from '../db/client.js';
import { copilotConversations, copilotMessages } from '../db/schema/index.js';
import { newId } from '../lib/ids.js';

// Placeholder for the real LLM integration landing in issue #7 — lets the
// persistence layer (this file), the route, and the frontend chat loop all
// get built and verified end-to-end without an LLM dependency yet.
const CANNED_REPLIES = [
  "Got it — I'll look into that.",
  "Thanks for the context, noted.",
  "I can help with that once I'm wired up to look at real ticket data.",
];

function nextCannedReply(): string {
  return CANNED_REPLIES[Math.floor(Math.random() * CANNED_REPLIES.length)];
}

export async function getOrCreateConversation(memberId: string) {
  const [existing] = await db
    .select()
    .from(copilotConversations)
    .where(eq(copilotConversations.memberId, memberId))
    .limit(1);
  if (existing) return existing;

  const [created] = await db
    .insert(copilotConversations)
    .values({ id: newId('conv'), memberId })
    .returning();
  return created;
}

export async function listMessages(conversationId: string) {
  return db
    .select()
    .from(copilotMessages)
    .where(eq(copilotMessages.conversationId, conversationId))
    .orderBy(asc(copilotMessages.createdAt));
}

export async function postMessage(conversationId: string, content: string) {
  return db.transaction(async (tx) => {
    await tx.insert(copilotMessages).values({
      id: newId('msg'),
      conversationId,
      role: 'user',
      content,
    });
    const [reply] = await tx
      .insert(copilotMessages)
      .values({
        id: newId('msg'),
        conversationId,
        role: 'assistant',
        content: nextCannedReply(),
      })
      .returning();
    await tx
      .update(copilotConversations)
      .set({ updatedAt: new Date() })
      .where(eq(copilotConversations.id, conversationId));
    return reply;
  });
}
