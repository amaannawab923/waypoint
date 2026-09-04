import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { requests } from '../db/schema/index.js';
import { NotFoundError, ConflictError } from '../middleware/errors.js';
import { newId } from '../lib/ids.js';
import { createTicket } from './tickets.service.js';

export async function listRequests(projectId: string) {
  return db.select().from(requests).where(eq(requests.projectId, projectId));
}

export interface CreateRequestInput {
  projectId: string;
  title: string;
  description?: string;
  priority?: (typeof requests.$inferInsert)['priority'];
  sourceName: string;
  sourceEmail: string;
}

export async function createRequest(input: CreateRequestInput) {
  const [row] = await db
    .insert(requests)
    .values({
      // Opaque row-id prefix, deliberately unchanged — same call C2 made
      // when it left newId('wi') in place for tickets.
      id: newId('in'),
      projectId: input.projectId,
      title: input.title,
      description: input.description ?? '',
      status: 'pending',
      priority: input.priority,
      sourceName: input.sourceName,
      sourceEmail: input.sourceEmail,
    })
    .returning();
  return row;
}

export async function updateRequestStatus(id: string, status: (typeof requests.$inferInsert)['status']) {
  const [row] = await db.update(requests).set({ status }).where(eq(requests.id, id)).returning();
  if (!row) throw new NotFoundError('request');
  return row;
}

export async function convertRequestToTicket(
  id: string,
  stateId: string,
  overrides?: { title?: string; description?: string; priority?: (typeof requests.$inferInsert)['priority'] },
) {
  const [request] = await db.select().from(requests).where(eq(requests.id, id));
  if (!request) throw new NotFoundError('request');
  if (request.linkedTicketId) {
    throw new ConflictError(`request already converted to ${request.linkedTicketId}`);
  }

  const item = await createTicket({
    projectId: request.projectId,
    title: overrides?.title?.trim() || request.title,
    description: overrides?.description ?? request.description,
    stateId,
    priority: overrides?.priority ?? request.priority ?? undefined,
    // Provenance, recorded on the ticket itself. This is what the dropped
    // 'triage' state group used to stand in for (§3.3).
    source: 'request',
  });

  await db
    .update(requests)
    .set({ status: 'accepted', linkedTicketId: item.id })
    .where(eq(requests.id, id));

  return item;
}
