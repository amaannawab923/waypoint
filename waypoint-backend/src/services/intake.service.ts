import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { intakeRequests } from '../db/schema/index.js';
import { NotFoundError, ConflictError } from '../middleware/errors.js';
import { newId } from '../lib/ids.js';
import { createWorkItem } from './workItems.service.js';

export async function listIntake(projectId: string) {
  return db.select().from(intakeRequests).where(eq(intakeRequests.projectId, projectId));
}

export interface CreateIntakeRequestInput {
  projectId: string;
  title: string;
  description?: string;
  priority?: (typeof intakeRequests.$inferInsert)['priority'];
  sourceName: string;
  sourceEmail: string;
}

export async function createIntakeRequest(input: CreateIntakeRequestInput) {
  const [row] = await db
    .insert(intakeRequests)
    .values({
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

export async function updateIntakeStatus(id: string, status: (typeof intakeRequests.$inferInsert)['status']) {
  const [row] = await db.update(intakeRequests).set({ status }).where(eq(intakeRequests.id, id)).returning();
  if (!row) throw new NotFoundError('intake request');
  return row;
}

export async function convertIntakeToWorkItem(
  id: string,
  stateId: string,
  overrides?: { title?: string; description?: string; priority?: (typeof intakeRequests.$inferInsert)['priority'] },
) {
  const [request] = await db.select().from(intakeRequests).where(eq(intakeRequests.id, id));
  if (!request) throw new NotFoundError('intake request');
  if (request.linkedWorkItemId) {
    throw new ConflictError(`intake request already converted to ${request.linkedWorkItemId}`);
  }

  const item = await createWorkItem({
    projectId: request.projectId,
    title: overrides?.title?.trim() || request.title,
    description: overrides?.description ?? request.description,
    stateId,
    priority: overrides?.priority ?? request.priority ?? undefined,
  });

  await db
    .update(intakeRequests)
    .set({ status: 'accepted', linkedWorkItemId: item.id })
    .where(eq(intakeRequests.id, id));

  return item;
}
