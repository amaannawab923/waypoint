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
// (instance setup-status, workspace creation/listing via requireUser,
// instance admin) or needs only req.user — never
// req.member/currentWorkspaceId(). None of them can sit behind apiRouter:
// app.ts mounts resolveMember's global middleware before apiRouter, and
// resolveMember hard-refuses (400) any request that carries a bearer
// token but no X-Waypoint-Workspace-Id header, regardless of what the
// route beneath it actually needs. That silently broke /auth/signout (a
// real bearer token, no workspace header — see accountSignIn.ts's
// revokeAccountSession) well before this ticket; AT12 found it while
// wiring workspace creation into the same gate. app.ts mounts this
// router before resolveMember instead.
export const identityOnlyRouter = Router();
identityOnlyRouter.use(instanceRouter);
identityOnlyRouter.use(adminRouter);
identityOnlyRouter.use(workspacesRouter);

// The sign-in/join pages and every /auth/* route a real browser
// navigates or form-submits to directly (not the desktop app's own
// fetch): GET /sign-in, GET /join/:token, POST /auth/email/start, the
// OAuth provider start/callback routes, GET /auth/email/verify. These
// are genuinely public — no bearer token, no workspace context, nothing
// req.member-shaped — and unlike the rest of identityOnlyRouter above,
// app.ts mounts this one *before* the CORS origin check too, not just
// before resolveMember. Found live (QA E2E pass, ROAD-141 epic
// closeout): app.ts's cors() allowlist only ever contemplated the
// desktop app's own origins (the webpack dev server, app://waypoint) —
// correct for the JSON API it protects (stops an arbitrary open tab's
// background fetch() from hitting the unauthenticated Personal
// fallback), but these pages are the opposite case: real browsers,
// reached directly, submitting a same-origin form back to this same
// backend. A real browser's POST carries an Origin header (unlike
// curl's, which never sent one — masking this in every curl-based check
// this epic ran until now), and that origin was never going to be in an
// allowlist built for the desktop app, so real self-hosted sign-in was
// silently 403ing for every actual browser tab that reached it. These
// pages carry no ambient credential a malicious background fetch could
// ride along on (no cookies; the desktop's own Bearer token never
// touches a browser tab), so CORS was never protecting them — it was
// only ever breaking them.
export const publicPageRouter = Router();
publicPageRouter.use(authRouter);
publicPageRouter.use(joinRouter);
