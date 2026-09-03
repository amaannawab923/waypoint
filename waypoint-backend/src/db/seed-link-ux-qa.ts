// One-off script for manual QA of the codebase-link UX increment. Creates a
// project named "Atlas" (unlinked, to exercise the settings picker and the
// name-matching suggestion against the "atlas" fixture repo) and links
// proj-launch to the storefront fixture (so Atlas's suggestions strip shows
// a "linked to other projects" recent). Not part of the normal seed path.
import { db } from './client.js';
import * as schema from './schema/index.js';
import { eq } from 'drizzle-orm';

const SP =
  '/private/tmp/claude-501/-Users-amaannawab-emdash/06c1bf14-01bd-4418-ab69-3b05504f3708/scratchpad';

async function main() {
  await db.insert(schema.projects).values({
    id: 'proj-atlas',
    workspaceId: 'ws-1',
    name: 'Atlas',
    identifier: 'ATLAS',
    description: 'QA fixture project for the codebase-link UX pass — starts unlinked.',
    icon: '🗺️',
    coverGradientStart: '#4a2f7a',
    coverGradientEnd: '#1c1130',
    network: 'private',
    leadId: 'mem-1',
    defaultAssigneeId: 'mem-1',
    timezone: 'UTC',
    features: { cycles: false, modules: false, views: false, pages: false, intake: false },
    estimate: null,
    automations: {
      autoArchiveEnabled: false,
      autoArchiveAfterDays: 30,
      autoCloseEnabled: false,
      autoCloseAfterDays: 30,
    },
    createdAt: new Date(),
    archivedAt: null,
    guestAccessEnabled: false,
  });
  await db.insert(schema.projectMembers).values([{ projectId: 'proj-atlas', memberId: 'mem-1' }]);

  const states = [
    { id: 'st-a-backlog', name: 'Backlog', group: 'backlog' as const, color: '#9c9280', isDefault: true, sortOrder: 0 },
    { id: 'st-a-todo', name: 'Todo', group: 'unstarted' as const, color: '#7d8a9c', isDefault: true, sortOrder: 1 },
    { id: 'st-a-progress', name: 'In Progress', group: 'started' as const, color: '#c99a2e', isDefault: true, sortOrder: 2 },
    { id: 'st-a-review', name: 'In Review', group: 'started' as const, color: '#a86fe0', isDefault: false, sortOrder: 3 },
    { id: 'st-a-done', name: 'Done', group: 'completed' as const, color: '#2f7a4f', isDefault: true, sortOrder: 4 },
    { id: 'st-a-cancelled', name: 'Cancelled', group: 'cancelled' as const, color: '#b7332a', isDefault: true, sortOrder: 5 },
    { id: 'st-a-triage', name: 'Triage', group: 'triage' as const, color: '#6b6050', isDefault: true, sortOrder: -1 },
  ].map((s) => ({ ...s, projectId: 'proj-atlas' }));
  await db.insert(schema.workItemStates).values(states);

  await db.insert(schema.workItems).values({
    id: 'wi-atlas-1',
    projectId: 'proj-atlas',
    identifier: 'ATLAS-1',
    sequenceId: 1,
    title: 'Ask Copilot something about this project once linked',
    description: 'QA ticket to exercise the in-chat link card end to end.',
    stateId: 'st-a-todo',
    priority: 'medium',
    moduleId: null,
    cycleId: null,
    parentId: null,
    estimatePoints: null,
    estimateValue: null,
    dueDate: null,
    createdById: 'mem-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    isDraft: false,
    sortOrder: '0',
  });

  // proj-launch already exists from the base seed — link it so its repoPath
  // shows up as a "recent" suggestion when linking Atlas.
  await db
    .update(schema.projects)
    .set({ repoPath: `${SP}/grounding-test/storefront` })
    .where(eq(schema.projects.id, 'proj-launch'));

  console.log('Seeded proj-atlas (unlinked) and linked proj-launch to the storefront fixture.');
  console.log('Fixture repos available at:', `${SP}/qa-link-fixtures/{atlas,not-a-repo,main-repo,worktree-repo}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
