import { Router, urlencoded } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { configuredAuthMethods } from '../lib/authMethods.js';
import { getSetupStatus } from '../services/instance.service.js';
import * as flows from '../auth/flows.js';
import { createSmtpMailer, smtpConfigured, type Mailer } from '../auth/mailer.js';
import { renderErrorPage, renderSentPage, renderSignInPage } from '../auth/signInPage.js';
import { ProviderExchangeError } from '../auth/providers/types.js';

// AT9 (ROAD-144). The browser-facing half of sign-in. These routes render
// HTML, not JSON: a person in a browser is on the other end, and the
// desktop only ever sees the final redirect to its loopback callback.
// Every failure renders a page and never the desktop redirect, so a
// token can only reach the callback on a completed sign-in.

let cachedMailer: Mailer | null | undefined;
function mailerFor(env: NodeJS.ProcessEnv): Mailer | null {
  if (cachedMailer !== undefined) return cachedMailer;
  cachedMailer = smtpConfigured(env) ? createSmtpMailer(env) : null;
  return cachedMailer;
}

export type AuthRouterDeps = Partial<flows.FlowDeps>;

export function createAuthRouter(overrides: AuthRouterDeps = {}) {
  const router = Router();
  const deps = (): flows.FlowDeps => {
    const env = overrides.env ?? process.env;
    return {
      env,
      fetch: overrides.fetch ?? ((input, init) => globalThis.fetch(input, init)),
      mailer: overrides.mailer !== undefined ? overrides.mailer : mailerFor(env),
      now: overrides.now ?? (() => new Date()),
      publicBaseUrl: overrides.publicBaseUrl ?? flows.publicBaseUrl(env),
    };
  };

  const html = (res: import('express').Response, status: number, body: string) => {
    res.status(status).type('html').send(body);
  };

  // Browser errors become pages; the status code still tells the truth.
  const page = (fn: (req: import('express').Request, res: import('express').Response) => Promise<void>) =>
    asyncHandler(async (req, res) => {
      try {
        await fn(req, res);
      } catch (err) {
        const status =
          err instanceof ProviderExchangeError ? 502 : (err as { name?: string }).name === 'NotFoundError' ? 404 : (err as { name?: string }).name === 'ConflictError' ? 403 : 400;
        html(res, status, renderErrorPage(err instanceof Error ? err.message : 'Unknown error'));
      }
    });

  router.get(
    '/sign-in',
    page(async (req, res) => {
      const d = deps();
      const redirectUri = flows.validateRedirectUri(str(req.query.redirect_uri));
      const clientState = flows.validateClientState(str(req.query.state));
      const status = await getSetupStatus(d.env);
      if (status.setupRequired) {
        html(res, 503, renderErrorPage('This instance has not completed first-run setup yet.'));
        return;
      }
      html(
        res,
        200,
        renderSignInPage({
          instanceName: status.instanceName ?? 'Waypoint',
          purpose: str(req.query.for) ?? null,
          methods: configuredAuthMethods(d.env),
          redirectUri,
          clientState,
        }),
      );
    }),
  );

  for (const provider of ['github', 'google'] as const) {
    router.get(
      `/auth/${provider}/start`,
      page(async (req, res) => {
        const url = await flows.startOAuth(
          provider,
          { redirectUri: str(req.query.redirect_uri), clientState: str(req.query.state), purpose: str(req.query.for) },
          deps(),
        );
        res.redirect(302, url);
      }),
    );
    router.get(
      `/auth/${provider}/callback`,
      page(async (req, res) => {
        const to = await flows.completeOAuth(
          provider,
          { code: str(req.query.code), state: str(req.query.state), error: str(req.query.error) },
          deps(),
        );
        res.redirect(302, to);
      }),
    );
  }

  router.post(
    '/auth/email/start',
    urlencoded({ extended: false }),
    page(async (req, res) => {
      const d = deps();
      const body = (req.body ?? {}) as Record<string, unknown>;
      const { sentTo } = await flows.startEmailLink(
        { email: str(body.email), redirectUri: str(body.redirect_uri), clientState: str(body.state), purpose: str(body.for) },
        d,
      );
      const status = await getSetupStatus(d.env);
      html(res, 200, renderSentPage(status.instanceName ?? 'Waypoint', sentTo));
    }),
  );

  router.get(
    '/auth/email/verify',
    page(async (req, res) => {
      const to = await flows.completeEmailLink({ token: str(req.query.token) }, deps());
      res.redirect(302, to);
    }),
  );

  return router;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

export const authRouter = createAuthRouter();
