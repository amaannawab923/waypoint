import { escapeHtml } from './redirect.js';
import type { AuthMethod } from '../lib/authMethods.js';

// AT9 (ROAD-144). The backend's own sign-in page — what the desktop opens
// in the system browser (mockup step 7). Server-rendered, no framework,
// no script: three buttons and a form, and the copy the mockup fixed:
// "Only for the team workspace. Your personal Waypoint stays on your
// machine and never needs an account." Every interpolation is escaped;
// redirect_uri and state are already validated before this renders.

type PageArgs = {
  instanceName: string;
  purpose: string | null;
  methods: AuthMethod[];
  redirectUri: string;
  clientState: string;
};

const CSS = `
  :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f4f4f6; color: #0a0a0c; }
  @media (prefers-color-scheme: dark) { body { background: #0a0a0c; color: #f2f2f4; } .card { background: #131316; border-color: #29292f; } .btn { background: #1c1c20; color: #f2f2f4; border-color: #3a3a42; } .btn.primary { background: #f2f2f4; color: #0a0a0c; } input { background: #0a0a0c; color: #f2f2f4; border-color: #3a3a42; } .fine { color: #a8a8b3; } .hint { color: #a8a8b3; } }
  .card { width: 380px; max-width: 92vw; background: #fff; border: 1px solid #e4e4e8; border-radius: 16px; padding: 24px; box-shadow: 0 24px 48px -24px rgba(0,0,0,.35); }
  .mark { width: 34px; height: 34px; border-radius: 9px; background: #18181b; color: #fff; display: grid; place-items: center; font-weight: 700; margin-bottom: 12px; }
  h1 { font-size: 18px; margin: 0 0 6px; }
  .hint { margin: 0 0 16px; font-size: 13px; color: #53535c; line-height: 1.5; }
  .btn { display: block; width: 100%; box-sizing: border-box; padding: 10px 12px; margin-bottom: 8px; border-radius: 8px; border: 1px solid #d3d3d9; background: #fff; color: #0a0a0c; font: 600 14px inherit; text-align: left; text-decoration: none; cursor: pointer; }
  .btn.primary { background: #18181b; color: #fff; border-color: #18181b; }
  form { display: flex; gap: 8px; margin-top: 4px; }
  input { flex: 1; padding: 9px 10px; border-radius: 8px; border: 1px solid #d3d3d9; font: 14px inherit; }
  .fine { font-size: 12px; color: #9a9aa3; margin-top: 12px; line-height: 1.5; }
  .err { border-left: 3px solid #c8241a; padding-left: 10px; }
`;

function shell(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${CSS}</style></head><body><main class="card"><div class="mark">W</div>${body}</main></body></html>`;
}

export function renderSignInPage(a: PageArgs): string {
  const q = new URLSearchParams({ redirect_uri: a.redirectUri, state: a.clientState });
  if (a.purpose) q.set('for', a.purpose);
  const qs = q.toString();
  const what = a.purpose === 'sync' ? 'turn on Sync' : a.purpose ? `join ${escapeHtml(a.purpose)}` : 'continue';
  const buttons = [
    a.methods.includes('github') && `<a class="btn primary" href="/auth/github/start?${qs}">Continue with GitHub</a>`,
    a.methods.includes('google') && `<a class="btn" href="/auth/google/start?${qs}">Continue with Google</a>`,
    a.methods.includes('email') &&
      `<form method="post" action="/auth/email/start"><input type="hidden" name="redirect_uri" value="${escapeHtml(a.redirectUri)}"><input type="hidden" name="state" value="${escapeHtml(a.clientState)}">${a.purpose ? `<input type="hidden" name="for" value="${escapeHtml(a.purpose)}">` : ''}<input type="email" name="email" required placeholder="you@example.com" autocomplete="email"><button class="btn" type="submit" style="width:auto;margin:0">Email me a link</button></form>`,
  ]
    .filter(Boolean)
    .join('');
  return shell(
    `Sign in to ${a.instanceName}`,
    `<h1>Sign in to ${escapeHtml(a.instanceName)} to ${what}</h1><p class="hint">Only for the team workspace. Your personal Waypoint stays on your machine and never needs an account.</p>${buttons}<p class="fine">No password, ever. You'll be sent straight back to Waypoint.</p>`,
  );
}

export function renderSentPage(instanceName: string, email: string): string {
  return shell(
    `Check your email`,
    `<h1>Check your email</h1><p class="hint">We sent a sign-in link to <b>${escapeHtml(email)}</b>. It works once and expires in 15 minutes. You can close this tab once you've opened it.</p><p class="fine">Signing in to ${escapeHtml(instanceName)}.</p>`,
  );
}

export function renderErrorPage(message: string): string {
  return shell(
    `Sign-in didn't complete`,
    `<h1>Sign-in didn't complete</h1><p class="hint err">${escapeHtml(message)}</p><p class="fine">Go back to Waypoint and try again. Nothing was created.</p>`,
  );
}

export function renderDonePage(): string {
  return shell(
    `Signed in`,
    `<h1>You're signed in</h1><p class="hint">Waypoint should have picked this up. You can close this tab.</p>`,
  );
}
