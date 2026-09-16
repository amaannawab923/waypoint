import { CURRENT_USER_ID } from './currentUser';
import type { Member } from '@/types/entities';

// AT12 (ROAD-147). The one thing AT11's PR (#73) deferred to this ticket:
// "nothing in the renderer can reach a signed-in Team state until this
// ticket's invite flow exists to produce one." Closes it for the three
// call sites that hardcoded CURRENT_USER_ID as the operator dispatching a
// session — BriefPreviewDialog.tsx, NewSessionDialog.tsx, and
// data/api.ts's listMyAgentRuns.
//
// Resolves to the real signed-in member's own id when a hosted Team
// workspace is active; falls back to the existing Personal constant
// otherwise (no account, no active workspace, or a transient failure
// reaching the backend) — Personal's own dispatch behavior is completely
// unchanged, matching this whole ticket's additive posture everywhere
// else.
export async function getActiveMemberId(): Promise<string> {
  // The whole body, not just the hostedFetch call, is the fallback's
  // scope — window.electron.account.status() itself is an IPC round trip
  // that can reject, and a dispatch action (starting an agent run)
  // shouldn't fail outright over that any more than over a transient
  // hostedFetch failure. Personal's own id is always a safe, working
  // fallback either way.
  try {
    const status = await window.electron.account.status();
    if (!status.connected || !status.identity?.activeWorkspaceId) return CURRENT_USER_ID;
    const res = await window.electron.account.hostedFetch<Member>({ path: '/me' });
    if (!res.ok) return CURRENT_USER_ID;
    return res.body.id;
  } catch {
    return CURRENT_USER_ID;
  }
}
