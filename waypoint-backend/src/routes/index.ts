import { Router } from 'express';
import { workspaceRouter } from './workspace.routes.js';
import { membersRouter } from './members.routes.js';
import { projectsRouter } from './projects.routes.js';
import { statesRouter } from './states.routes.js';
import { labelsRouter } from './labels.routes.js';
import { workstreamsRouter } from './workstreams.routes.js';
import { sprintsRouter } from './sprints.routes.js';
import { ticketsRouter } from './tickets.routes.js';
import { docsRouter } from './docs.routes.js';
import { viewsRouter } from './views.routes.js';
import { requestsRouter } from './requests.routes.js';
import { scratchNotesRouter } from './scratchNotes.routes.js';
import { notificationsRouter } from './notifications.routes.js';
import { exportsRouter } from './exports.routes.js';
import { webhooksRouter } from './webhooks.routes.js';
import { agentsRouter } from './agents.routes.js';
import { copilotRouter } from './copilot.routes.js';
import { proposalsRouter } from './proposals.routes.js';
import { reviewQueueRouter } from './reviewQueue.routes.js';
import { mcpRouter } from './mcp.routes.js';
import { devRouter } from './dev.routes.js';

export const apiRouter = Router();

apiRouter.use(workspaceRouter);
apiRouter.use(membersRouter);
apiRouter.use(projectsRouter);
apiRouter.use(statesRouter);
apiRouter.use(labelsRouter);
apiRouter.use(workstreamsRouter);
apiRouter.use(sprintsRouter);
apiRouter.use(ticketsRouter);
apiRouter.use(docsRouter);
apiRouter.use(viewsRouter);
apiRouter.use(requestsRouter);
apiRouter.use(scratchNotesRouter);
apiRouter.use(notificationsRouter);
apiRouter.use(exportsRouter);
apiRouter.use(webhooksRouter);
apiRouter.use(agentsRouter);
apiRouter.use(copilotRouter);
apiRouter.use(proposalsRouter);
apiRouter.use(reviewQueueRouter);
apiRouter.use(mcpRouter);
if (process.env.NODE_ENV !== 'production') {
  apiRouter.use(devRouter);
}
