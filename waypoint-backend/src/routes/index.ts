import { Router } from 'express';
import { workspaceRouter } from './workspace.routes.js';
import { membersRouter } from './members.routes.js';
import { projectsRouter } from './projects.routes.js';
import { statesRouter } from './states.routes.js';
import { labelsRouter } from './labels.routes.js';
import { workstreamsRouter } from './workstreams.routes.js';
import { sprintsRouter } from './sprints.routes.js';
import { ticketsRouter } from './tickets.routes.js';
import { ticketRefsRouter } from './ticketRefs.routes.js';
import { docsRouter } from './docs.routes.js';
import { viewsRouter } from './views.routes.js';
import { requestsRouter } from './requests.routes.js';
import { scratchNotesRouter } from './scratchNotes.routes.js';
import { notificationsRouter } from './notifications.routes.js';
import { exportsRouter } from './exports.routes.js';
import { webhooksRouter } from './webhooks.routes.js';
import { agentsRouter } from './agents.routes.js';
import { agentRunsRouter } from './agentRuns.routes.js';
import { copilotRouter } from './copilot.routes.js';
import { proposalsRouter } from './proposals.routes.js';
import { reviewQueueRouter } from './reviewQueue.routes.js';
import { mcpRouter } from './mcp.routes.js';
import { devRouter } from './dev.routes.js';
import { instanceRouter } from './instance.routes.js';
import { adminRouter } from './admin.routes.js';
import { authRouter } from './auth.routes.js';
import { joinRouter } from './join.routes.js';
import { workspacesRouter } from './workspaces.routes.js';
import { workspaceInvitesRouter } from './workspaceInvites.routes.js';

export const apiRouter = Router();

apiRouter.use(workspaceRouter);
// AT12: needs req.member/currentWorkspaceId() from resolveMember — see
// workspaceInvites.routes.ts's own comment on why this can't join
// workspacesRouter in identityOnlyRouter below.
apiRouter.use(workspaceInvitesRouter);
apiRouter.use(membersRouter);
apiRouter.use(projectsRouter);
apiRouter.use(statesRouter);
apiRouter.use(labelsRouter);
apiRouter.use(workstreamsRouter);
apiRouter.use(sprintsRouter);
apiRouter.use(ticketsRouter);
// W5b: /tickets/resolve/:identifier and /ticket-refs — registered after
// the tickets router; its /tickets/:id is one segment, these are two.
apiRouter.use(ticketRefsRouter);
apiRouter.use(docsRouter);
apiRouter.use(viewsRouter);
apiRouter.use(requestsRouter);
apiRouter.use(scratchNotesRouter);
apiRouter.use(notificationsRouter);
apiRouter.use(exportsRouter);
apiRouter.use(webhooksRouter);
apiRouter.use(agentsRouter);
apiRouter.use(agentRunsRouter);
apiRouter.use(copilotRouter);
apiRouter.use(proposalsRouter);
apiRouter.use(reviewQueueRouter);
apiRouter.use(mcpRouter);
if (process.env.NODE_ENV !== 'production') {
  apiRouter.use(devRouter);
}

// AT12 (ROAD-147). Every route here either needs no identity at all
// (instance setup-status, the sign-in/join browser pages, provider
// callbacks) or needs only req.user via requireUser (workspace creation/
// listing, instance admin) — never req.member/currentWorkspaceId(). None
// of them can sit behind apiRouter: app.ts mounts resolveMember's global
// middleware before apiRouter, and resolveMember hard-refuses (400) any
// request that carries a bearer token but no X-Waypoint-Workspace-Id
// header, regardless of what the route beneath it actually needs. That
// silently broke /auth/signout (a real bearer token, no workspace
// header — see accountSignIn.ts's revokeAccountSession) well before
// this ticket; AT12 found it while wiring workspace creation into the
// same gate. app.ts mounts this router before resolveMember instead.
//
// Every route here still sits behind app.ts's CORS origin check, same as
// before — a real self-hosted sign-in's POST /auth/email/start 403ing
// for every real browser (found live, QA E2E pass, ROAD-141 epic
// closeout — a plain GET to /sign-in or /join/:token was never actually
// broken: a top-level GET navigation carries no Origin header at all,
// only the same-origin form POST that follows it does) was fixed by
// adding this backend's own origin to that check's allowlist, in
// app.ts, not by exempting any of these routes from it. An earlier
// version of this fix tried exempting authRouter/joinRouter wholesale
// instead (mounted before the CORS middleware): round 2 of that fix's
// own review found it also exempted POST /auth/email/start —
// side-effectful, and until this fix only ever reachable via curl
// (which never sends an Origin header at all) — from CORS, with no rate
// limiting anywhere in this backend to fall back on.
export const identityOnlyRouter = Router();
identityOnlyRouter.use(instanceRouter);
identityOnlyRouter.use(adminRouter);
identityOnlyRouter.use(authRouter);
identityOnlyRouter.use(joinRouter);
identityOnlyRouter.use(workspacesRouter);
