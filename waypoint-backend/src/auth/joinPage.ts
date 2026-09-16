import { escapeHtml } from './redirect.js';
import type { AuthMethod } from '../lib/authMethods.js';

// AT12 (ROAD-147). The invitee's own browser page — spec §7 step 10,
// mockup "Join Fairweather Labs on Waypoint". Server-rendered, no
// framework, same shape as signInPage.ts's own sign-in card, kept as a
// separate small file rather than reusing that one directly: a join-flow
// row has no redirect_uri/client_state to echo into its links at all
// (auth/flows.ts's resolveFlowTarget), so the querystring these buttons
// build is genuinely different, not a variant of the same page.

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

export function renderJoinPreviewPage(a: {
  workspaceName: string;
  inviterName: string | null;
  token: string;
  methods: AuthMethod[];
}): string {
  const qs = new URLSearchParams({ invite_token: a.token }).toString();
  const invitedBy = a.inviterName ? `<b>${escapeHtml(a.inviterName)}</b> invited you. ` : '';
  const buttons = [
    a.methods.includes('github') && `<a class="btn primary" href="/auth/github/start?${qs}">Continue with GitHub</a>`,
    a.methods.includes('google') && `<a class="btn" href="/auth/google/start?${qs}">Continue with Google</a>`,
    a.methods.includes('email') &&
      `<form method="post" action="/auth/email/start"><input type="hidden" name="invite_token" value="${escapeHtml(a.token)}"><input type="email" name="email" required placeholder="you@example.com" autocomplete="email"><button class="btn" type="submit" style="width:auto;margin:0">Email me a link</button></form>`,
  ]
    .filter(Boolean)
    .join('');
  return shell(
    `Join ${a.workspaceName} on Waypoint`,
    `<h1>Join ${escapeHtml(a.workspaceName)} on Waypoint</h1><p class="hint">${invitedBy}You'll see this workspace's shared board — nothing from anyone's personal Waypoint.</p>${buttons}<p class="fine">No password, ever.</p>`,
  );
}

export function renderJoinCompletePage(workspaceName: string): string {
  return shell(
    `You're in`,
    `<h1>You're in</h1><p class="hint">You've joined <b>${escapeHtml(workspaceName)}</b>. Open Waypoint on your own machine and switch to it from the workspace switcher — you can close this tab.</p>`,
  );
}
