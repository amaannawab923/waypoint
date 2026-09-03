# Codebase-link configuration UX: implementation design

Status: design proposal, not yet built. Branch: `feat/codebase-link-ux`, cut from
`main` (which already includes PR #25, the V3 grounding feature this improves).

This document specifies exactly what changes, file by file, to close gaps G1–G8
from `docs/design/codebase-link-ux-gaps.md` (the PM spec — read that first) in
the shape shown by `docs/design/codebase-link-ux-mockup.html` (the visual/
interaction spec — read that second). It does not re-open any decision already
made in `docs/design/copilot-v3-codebase-grounding.md`: one repo per project,
single repo, no override, the existing three-message `validateRepoPath` rule,
`Read`/`Glob`/`Grep` unconfined to the linked directory. Everything below is
configuration ergonomics on top of that shipped feature.

Every claim in the gaps doc was checked against the actual merged code on this
branch (not assumed from the doc's own prose) before this design was written:
`Codebase.tsx`, `repoLink.ts`, `CopilotPanel.tsx`'s `CopilotRepoLinkCard`/
`needsRepoLink`/`repoLinkPrompt`, `useCurrentRouteProject.ts`, `projects.
service.ts`'s `validateRepoPath`, `projects.schema.ts`, and `copilotRunner.
ts`'s `resolveRepoRoot` all match the gaps doc's citations exactly. Two things
worth flagging up front because they change what "no new backend capability"
can honestly mean here:

- **The gaps doc's claim that suggestions (G2) come from data "the app
  already has" is only half true.** `GET /projects` is an existing endpoint
  and other pages (`Topbar.tsx`) already call it — but this app has no
  cross-component data cache (`useAsync`, `src/renderer/lib/useAsync.ts`, is a
  per-component-instance hook with no shared store). `Codebase.tsx` and
  `CopilotRepoLinkCard` do not currently have the projects list in scope, so
  giving them suggestions means a **new fetch call site** for an **existing
  endpoint** — no new REST surface, but not literally "free" either. See §1.
- **G4's fix needs one small, real backend change** — a `code` (and `path`)
  field added to `ValidationError`'s JSON body — that the gaps doc's own
  framing ("every item is presentation or main-process only") doesn't quite
  cover. It's not a new endpoint and it's a two-line, additive, backward-
  compatible change, but it is a backend change, and I'm not going to call it
  "presentation only" to make the framing hold. See §4.

## 0. Shared infrastructure this increment introduces

Four of the eight gaps lean on the same few new pieces. Building them once,
here, keeps G3/G5/G6/G7 from each inventing their own version.

### 0.1 One place that decides "is this path still a usable repo directory"

`copilotRunner.ts`'s `resolveRepoRoot` already answers this question once per
message send:

```ts
// copilotRunner.ts, today
if (repoPath && REPO_PATH_PATTERN.test(repoPath)) {
  try {
    if (fs.statSync(repoPath).isDirectory()) {
      return { cwd: repoPath, linked: true };
    }
  } catch { /* falls through */ }
}
return { cwd: os.tmpdir(), linked: false };
```

G5 (header badge) and G6 (stale-link honesty) both need this exact same
answer, on the renderer side, well before any message is sent. Rather than
re-implementing "does this directory still exist" a second time in the
renderer's IPC layer, extract it once:

**New file `waypoint-frontend/src/main/repoPathStatus.ts`:**

```ts
import * as fs from 'fs';

/**
 * The one definition of "usable as a repo cwd" shared by copilotRunner.ts's
 * resolveRepoRoot (the actual send-time decision) and repoLink.ts's new
 * repo:check-path channel (the UI's stale-badge decision, §0.2). Two
 * implementations of this one fact were the exact bug G6 describes: the
 * card's gate and the runner's fallback already disagreed once (repoPath
 * non-null vs. cwd silently downgraded to os.tmpdir()). One function, two
 * callers, cannot drift again.
 *
 * Deliberately just existence + directory-ness — not a .git re-check. A
 * repo whose .git was renamed/removed since linking is still a fine cwd for
 * Read/Glob/Grep; re-verifying git-repo-ness on every check is the same
 * "redundant I/O with no real safety gain" call the V3 design already made
 * for resolveRepoRoot's cwd check (see its comment there).
 */
export function isUsableRepoDirectory(repoPath: string): boolean {
  try {
    return fs.statSync(repoPath).isDirectory();
  } catch {
    return false;
  }
}
```

`copilotRunner.ts`'s `resolveRepoRoot` imports and calls this instead of its
inline `try { fs.statSync(...).isDirectory() } catch`, unchanged behavior.

### 0.2 IPC: `repo:check-path`

**`waypoint-frontend/src/main/repoLink.ts`** — extend the existing
`registerRepoLinkIpc` (do not add a second `main.ts` registration call; this
is the same "local repo introspection" concern the file's own header comment
already claims):

```ts
import { isUsableRepoDirectory } from './repoPathStatus';

export function registerRepoLinkIpc(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('repo:choose-folder', /* ... extended in §1 ... */);

  // G5/G6: a single fs.stat, nothing more — the renderer calls this on
  // project load and on window focus (§5), never on a timer. Read-only,
  // side-effect-free, safe to call as often as the UI wants.
  ipcMain.handle('repo:check-path', async (_event, repoPath: string) => {
    return { exists: isUsableRepoDirectory(repoPath) };
  });
}
```

**Preload** (`waypoint-frontend/src/main/preload.ts`), alongside the existing
`repo.chooseFolder`:

```ts
repo: {
  chooseFolder(opts?: ChooseFolderOptions): Promise<ChooseFolderResult> { /* §1 */ },
  checkPath(repoPath: string): Promise<{ exists: boolean }> {
    return ipcRenderer.invoke('repo:check-path', repoPath);
  },
  describe(repoPath: string): Promise<RepoDescribeResult> { /* §3 */ },
},
```

### 0.3 Shared React pieces

New folder `waypoint-frontend/src/renderer/components/domain/repo-link/`
(peer of `CopilotProposalCard.tsx` etc. — domain UI, not a generic
`components/ui/` primitive), holding the components both entry points render
(full detail in §7, since that's the gap this structure directly answers):

- `RepoLinkPicker.tsx` — suggestions strip + Browse row + inline error
  (unlinked state).
- `RepoLinkedCard.tsx` — name/path/branch/commit + scope note + actions
  (linked state, with a `compact` prop).
- `RepoLinkBadge.tsx` — the header/nav indicator (G5/G6).

And two hooks under `waypoint-frontend/src/renderer/lib/`:

- `useRepoSuggestions.ts` (§2) — recents-derived suggestion list.
- `useRepoLinkStatus.ts` (§5) — linked / stale / unlinked, shared by the
  badge and by `useCurrentRouteProject`'s staleness field.

## 1. G1 — the folder dialog is context-free

**File:** `waypoint-frontend/src/main/repoLink.ts`.

Widen the existing zero-argument channel in place — no new channel, matching
the gaps doc's own framing for this one gap exactly:

```ts
export interface ChooseFolderOptions {
  defaultPath?: string;
  title?: string;
  message?: string; // macOS-only (dialog.showOpenDialog ignores it elsewhere) — passed through unconditionally, harmless no-op on other platforms
}
export type ChooseFolderResult =
  | { canceled: true }
  | { canceled: false; path: string; looksLikeGitRepo: boolean }; // looksLikeGitRepo: G4 item 3, see §4

ipcMain.handle(
  'repo:choose-folder',
  async (_event, opts: ChooseFolderOptions = {}) => {
    const win = getWindow();
    const dialogOpts = {
      properties: ['openDirectory'] as const,
      defaultPath: opts.defaultPath,
      title: opts.title,
      message: opts.message,
    };
    const result = win
      ? await dialog.showOpenDialog(win, dialogOpts)
      : await dialog.showOpenDialog(dialogOpts);
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true as const };
    }
    const path = result.filePaths[0];
    return {
      canceled: false as const,
      path,
      looksLikeGitRepo: isUsableRepoDirectory(path) && fs.existsSync(join(path, '.git')),
    };
  },
);
```

**Preload:** `chooseFolder(opts?: ChooseFolderOptions): Promise<ChooseFolderResult>` —
same shape change, `opts` forwarded verbatim to `ipcRenderer.invoke`.

**Callers** (both now pass context; both live inside `RepoLinkPicker`, §7, so
this is one call site, not two):

```ts
// RepoLinkPicker.tsx
const picked = await window.electron.repo.chooseFolder({
  defaultPath: currentRepoPath ?? undefined, // "Change folder…" starts at the current link; a fresh link starts at the OS default
  title: `Link ${projectName} to its local checkout`,
});
```

`currentRepoPath` is `null` on a first link (the dialog opens wherever the OS
last left it, same as today — there is no per-app "last used directory"
memory to seed it with, and inventing one is exactly the fs-capability
question G2 already resolves not to take on, see §2) and the project's
existing `repoPath` on "Change folder…" — closing the gaps doc's own
called-out inconsistency ("even 'Change folder…' … does not even start at
the folder currently linked").

No backend change. No new channel. Confirmed sufficient.

## 2. G2 — no suggestions, every link is a cold browse

**The sibling-directory question — my call: recents only, no new fs
capability, in this PR.**

The gaps doc frames this as open ("if even reading sibling directories is
considered new capability, ship the recents strip alone"). I'm taking the
fallback, not the stretch version, for three concrete reasons tied to this
codebase specifically, not a general risk-aversion default:

1. **No `fs.readdir`-exposing IPC channel exists anywhere in this app today.**
   `repoLink.ts`'s own header comment is explicit that it "does NO filesystem
   validation" beyond returning whatever the OS dialog handed back — the one
   existing precedent for this file's scope is deliberately narrow. A
   sibling-scan channel would be new surface with real questions attached
   (symlink loops, permission-denied entries, how many levels to walk, which
   parent directories are even reasonable to enumerate) that nothing in this
   PR's scope needs to answer to fix G1–G8.
2. **Recents alone already produces the exact suggestion list the mockup
   shows**, once "name matches project" is read correctly: it does not
   require walking a filesystem, only fuzzy-matching the *project's own
   name/identifier* against the *basenames of paths already known* (other
   projects' `repoPath`). The mockup's two "name matches" rows and its one
   "linked to Atlas" row are the same data source (recents) with two
   different badge reasons — not two different data sources. See the
   matching logic below; it needs zero new capability.
3. **The real cost of recents-only is honest and narrow**: the very first
   repo ever linked on a machine has no recents to show, so the suggestions
   strip is empty and `Browse…` is the only door — exactly today's
   behavior, not a regression. Every link after the first gets suggestions.
   This is a one-time cliff, not an ongoing gap.

**Flag for the founder:** if in practice most users' first-ever link (no
recents yet) turns out to be the common case worth optimizing — not just the
first project on a fresh machine, but literally the first repo anyone links
before any other project has one — sibling-directory scanning is a real,
separable fast-follow. It would be a new `repo:list-siblings` channel:
`fs.readdir(path.dirname(knownPath))`, filtered to directories, each checked
with the same `isUsableRepoDirectory` + `.git` existence test as
`looksLikeGitRepo` above, capped at some small count (10?), non-recursive,
called only against parents of paths the app already trusts (never an
arbitrary user-supplied directory). Spec'd here so it's a small, well-scoped
addition later, not a new design pass — but not built in this PR.

**New hook `waypoint-frontend/src/renderer/lib/useRepoSuggestions.ts`:**

```ts
import { useAsync } from './useAsync';
import { listProjects } from '@/mock/api';
import type { Project } from '@/types/entities';

export interface RepoSuggestion {
  path: string;
  name: string;          // basename(path)
  reason: 'name-match' | 'other-project';
  otherProjectName?: string; // present when reason === 'other-project'
}

// Simple, deliberately non-fuzzy-library matching: normalize both sides
// (lowercase, strip non-alphanumerics) and test substring containment
// either direction. "Waypoint" project ↔ "waypoint" or "waypoint-electron-v3"
// folder both match; "Atlas" does not match "atlas-api" under a STRICT
// equality but does under this looser test — which is exactly the mockup's
// third suggestion. No dependency added: this is a five-line pure function,
// not something that justifies pulling in a fuzzy-match library.
function looksNamedFor(projectName: string, projectIdentifier: string, basename: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const b = norm(basename);
  return b.includes(norm(projectName)) || b.includes(norm(projectIdentifier)) || norm(projectName).includes(b);
}

export function useRepoSuggestions(
  currentProjectId: string,
  currentProjectName: string,
  currentProjectIdentifier: string,
): { suggestions: RepoSuggestion[]; loading: boolean } {
  // New fetch call site, existing endpoint (GET /projects) — see §0's note.
  // Every project's repoPath is already present on the Project entity this
  // returns (repoLink shipped in PR #25), so no field additions needed here.
  const { data: projects, loading } = useAsync(() => listProjects(), []);

  const suggestions = (projects ?? [])
    .filter((p): p is Project & { repoPath: string } => p.id !== currentProjectId && !!p.repoPath)
    // De-dup by path: two other projects can legitimately point at the same
    // checkout (a monorepo split across projects) — only offer it once.
    .filter((p, i, arr) => arr.findIndex((q) => q.repoPath === p.repoPath) === i)
    .map((p) => {
      const name = p.repoPath!.split(/[\\/]/).pop() ?? p.repoPath!;
      return looksNamedFor(currentProjectName, currentProjectIdentifier, name)
        ? { path: p.repoPath!, name, reason: 'name-match' as const }
        : { path: p.repoPath!, name, reason: 'other-project' as const, otherProjectName: p.name };
    })
    // Name matches first (highest-confidence pick), rest in whatever order
    // listProjects returned — good enough; this list tops out at "however
    // many other projects exist," never large enough to need real ranking.
    .sort((a, b) => (a.reason === 'name-match' ? -1 : 0) - (b.reason === 'name-match' ? -1 : 0));

  return { suggestions, loading };
}
```

Used by `RepoLinkPicker` (§7), which renders each `RepoSuggestion` as a
one-click row: `onClick` → `updateProject(projectId, { repoPath: s.path })`
directly, no dialog, no `repo:describe` round-trip needed before the click
(that happens after linking, to populate the confirmation card, §3).

No backend change. `GET /projects` already returns `repoPath` per project
(shipped in PR #25's schema). Confirmed sufficient, with the one caveat
flagged in §0.

## 3. G3 — post-link confirmation is a bare path string

**The git-data-source question — my call: shell out to the `git` binary from
the main process via `child_process.execFile`, not a new dependency.**

Checked `waypoint-frontend/package.json`: no `simple-git`, `isomorphic-git`,
`nodegit`, or `dugite` anywhere in `dependencies` or `devDependencies`. The
main process already treats `child_process.spawn` as an established,
reviewed pattern — `src/main/copilot/claudeSdkClient.ts` spawns the `claude`
CLI directly and is the file this app's own tests already model subprocess
mocking on (`copilotRunner.test.ts`'s comment: "the role `jest.mock
('child_process')` played for the old spawn-based runner"). Two tiny,
read-only git plumbing calls (`rev-parse --abbrev-ref HEAD`,
`log -1 --format=%cI`) don't earn a new dependency when the codebase's
existing subprocess convention already covers exactly this shape of need —
this is the same "prefer existing tools" instruction the repo's own AGENTS.md
states for dependency changes.

**New IPC channel `repo:describe`** (not an extension of `repo:choose-
folder`'s response): describing a path needs to be callable independently of
picking one — the settings page re-describes the *already-linked* path on
mount (to show branch/commit for a link made in a previous session), and the
suggestions strip's one-click links (§2) never go through the dialog at all,
so there's no "choose-folder response" to piggyback on for those. One
channel, two call sites (fresh pick, and re-describe on mount), simpler than
threading describe-data through two different response shapes.

**`waypoint-frontend/src/main/repoLink.ts`** (same file, same registration
function — one more `ipcMain.handle` call):

```ts
import { execFile } from 'child_process';
import { promisify } from 'util';
const execFileAsync = promisify(execFile);

export interface RepoDescribeResult {
  name: string;
  displayPath: string;         // home-dir-collapsed, computed here since main has os.homedir()
  branch: string | null;
  lastCommitAt: string | null; // ISO 8601 (git's %cI), renderer formats "2 hours ago" via date-fns (already a dependency)
  trackedFileCount: number | null;
}

// Each of the three git calls fails independently and degrades to null
// rather than failing the whole describe — a repo with zero commits (no
// HEAD yet) or a detached HEAD are both real states a freshly-`git init`'d
// or freshly-cloned-at-a-tag checkout can be in, and none of that should
// block showing the confirmation card at all (G3's whole point is showing
// SOMETHING recognizable, not gating on git succeeding).
async function tryGit(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, timeout: 2000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

function collapseHome(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

ipcMain.handle('repo:describe', async (_event, repoPath: string): Promise<RepoDescribeResult> => {
  const [branch, lastCommitAt, fileCountRaw] = await Promise.all([
    tryGit(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']),
    tryGit(repoPath, ['log', '-1', '--format=%cI']),
    // trackedFileCount is the least essential of the three (the mockup's
    // "tracked files" chip is embellishment beyond what G3's actual text
    // asks for — "current branch and last-commit date"). Included for full
    // mockup parity since it's the same shape of cheap call as the other
    // two, but genuinely optional — cut this one field first if the PR
    // needs to shrink.
    tryGit(repoPath, ['ls-files']),
  ]);
  return {
    name: path.basename(repoPath),
    displayPath: collapseHome(repoPath),
    branch,
    lastCommitAt,
    trackedFileCount: fileCountRaw ? fileCountRaw.split('\n').filter(Boolean).length : null,
  };
});
```

`execFile`, not `spawn` with `shell: true`: no shell interpolation of
`repoPath` at all (it's passed as `cwd`, an option, never concatenated into a
command string), which is the same posture this codebase already takes
toward shell injection elsewhere (AGENTS.md: "do not weaken shell quoting").

**Renderer side** (`RepoLinkedCard.tsx`, §7): calls
`window.electron.repo.describe(repoPath)` on mount and whenever `repoPath`
changes, formats `lastCommitAt` with `date-fns`'s `formatDistanceToNowStrict`
(already a dependency — no new import), renders `branch`/`lastCommitAt`/
`trackedFileCount` as chips when non-null, omits the chip entirely when a
field is null rather than showing "unknown" — a repo with no commits yet
just doesn't get a "last commit" chip, which is accurate, not broken.

For a freshly-picked folder (not yet an already-linked project), `describe`
is called in parallel with the `updateProject` PATCH the moment a folder is
chosen — it never blocks or gates the save; if `updateProject` fails, the
`describe` result is simply discarded and the error state (§4) renders
instead.

No backend change. Confirmed: this is entirely main-process + renderer.

## 4. G4 — errors are raw strings, doubled, and slow

Three sub-fixes, in the gaps doc's own order.

### 4a. Human copy, driven by a code — not string-matched prose

**The error-code question — my call: add a structured `code` (and `path`)
field to the backend's `ValidationError`, not string-matching.** The brief's
own framing ("robust to the backend message wording... a small backend
change... document why") is the right call here: string-matching
`does not exist`/`is not a directory`/`is not a git repository` against a
message whose entire purpose is being human-readable is exactly the kind of
coupling that silently breaks the next time someone rewords that message for
an unrelated reason. The fix is small, additive, and backward compatible —
confirmed against the one existing test that constructs a bare
`ValidationError` with no code (`errorHandler.test.ts:22`, still passes
unchanged below).

**`waypoint-backend/src/middleware/errors.ts`:**

```ts
export class ValidationError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly path?: string,
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}
```

**`waypoint-backend/src/middleware/errorHandler.ts`:**

```ts
if (err instanceof ValidationError) {
  res.status(400).json({
    error: err.message,
    ...(err.code ? { code: err.code } : {}),
    ...(err.path ? { path: err.path } : {}),
  });
  return;
}
```

`errorHandler.test.ts:22`'s existing assertion
(`json).toHaveBeenCalledWith({ error: '...' })`) still passes unmodified: a
bare `new ValidationError(message)` has `code`/`path` both `undefined`, so
both spreads contribute nothing and the body is byte-identical to today's.

**`waypoint-backend/src/services/projects.service.ts`** — three call sites,
each gains a code and the bare path (not re-derived from the message string
on the frontend — the backend already has `repoPath` in scope right there):

```ts
export function validateRepoPath(repoPath: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(repoPath);
  } catch {
    throw new ValidationError(`repoPath does not exist: ${repoPath}`, 'repo_path_not_found', repoPath);
  }
  if (!stat.isDirectory()) {
    throw new ValidationError(`repoPath is not a directory: ${repoPath}`, 'repo_path_not_directory', repoPath);
  }
  if (!fs.existsSync(path.join(repoPath, '.git'))) {
    throw new ValidationError(`repoPath is not a git repository: ${repoPath}`, 'repo_path_not_git_repo', repoPath);
  }
}
```

**Frontend — `waypoint-backend`'s `ApiError`, replacing the plain `Error`
`httpClient.ts` throws today:**

```ts
// waypoint-frontend/src/renderer/mock/httpClient.ts
export class ApiError extends Error {
  constructor(message: string, public readonly code?: string, public readonly path?: string) {
    super(message);
    this.name = 'ApiError';
  }
}

// inside request(), replacing the current `throw new Error(message)`:
let code: string | undefined;
let path: string | undefined;
try {
  const body = await res.json();
  if (body?.error) message = typeof body.error === 'string' ? body.error : JSON.stringify(body.error);
  code = typeof body?.code === 'string' ? body.code : undefined;
  path = typeof body?.path === 'string' ? body.path : undefined;
} catch { /* no JSON body — keep the generic message, code/path stay undefined */ }
if (!opts?.silent) showErrorToast(message); // 4b, below
throw new ApiError(message, code, path);
```

**New file `waypoint-frontend/src/renderer/lib/repoLinkErrors.ts`:**

```ts
import { ApiError } from '@/mock/httpClient';

const REPO_ERROR_COPY: Record<string, { title: string; body: (path: string) => string }> = {
  repo_path_not_found: {
    title: "That folder doesn't exist",
    body: (p) => `${p} isn't there — it may have been moved or deleted. Pick a different folder.`,
  },
  repo_path_not_directory: {
    title: "That's a file, not a folder",
    body: (p) => `${p} is a file, not a folder. Pick the folder that contains it.`,
  },
  repo_path_not_git_repo: {
    title: "That folder isn't a git repository",
    body: (p) =>
      `${p} has no .git in it. Pick the folder that contains .git — usually the top level of your checkout, one or two levels up from here.`,
  },
};

export interface RepoLinkErrorCopy { title: string; body: string; raw: string }

// code drives WHICH copy; path only interpolates it — no regex, no parsing
// of the human message at all. A backend that omits code (or a network
// error that never reaches a code at all) falls back to the raw message
// verbatim under a generic title, same as today's behavior, never a blank
// or broken-looking error.
export function describeRepoLinkError(err: unknown): RepoLinkErrorCopy {
  const raw = err instanceof Error ? err.message : String(err);
  if (err instanceof ApiError && err.code && REPO_ERROR_COPY[err.code]) {
    const copy = REPO_ERROR_COPY[err.code];
    return { title: copy.title, body: copy.body(err.path ?? 'That folder'), raw };
  }
  return { title: 'Something went wrong', body: raw, raw };
}
```

`RepoLinkPicker.tsx` (§7) renders `describeRepoLinkError(err)`'s `title` +
`body` as the lead copy, with the original `raw` string behind a
`<details>`/`<summary>Technical details</summary>` disclosure — exactly the
mockup's `err` block. Matches `Codebase.test.tsx`'s existing convention of
asserting on the raw backend string too (that test's assertion moves to
checking the `<details>` content, not the lead copy — see §8).

### 4b. Stop the double error

`request()`'s `showErrorToast(message)` call becomes conditional on a new
`opts.silent` flag (shown inlined above). Threaded through:

```ts
// httpClient.ts
patch: <T>(path: string, body?: unknown, opts?: { silent?: boolean }) =>
  request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }, opts),
```

```ts
// mock/api.ts
export async function updateProject(
  id: string,
  patch: Partial<Project>,
  opts?: { silent?: boolean },
): Promise<Project> {
  return http.patch<Project>(`/projects/${id}`, patch, opts);
}
```

`RepoLinkPicker.tsx`'s `updateProject` call passes `{ silent: true }`; every
other existing caller of `updateProject` (project lead, timezone, features,
etc.) is unaffected — default `opts` is `undefined`, `!opts?.silent` is
`true`, toast fires exactly as it does today. This is additive to a shared
function with many callers, not a behavior change to any of them.

### 4c. Local pre-flight `.git` check

Already specified in §1's `looksLikeGitRepo` field on `repo:choose-folder`'s
response — repeated here because G4 is where it's motivated. Precisely what
it checks and doesn't:

- **Checks:** `fs.existsSync(join(pickedPath, '.git'))`, nothing else.
- **Does not re-check** existence or directory-ness of `pickedPath` itself —
  the OS `openDirectory` dialog already guarantees the user picked a real,
  existing directory; the only fact worth surfacing locally is the one thing
  the dialog can't already guarantee.
- **Never blocks or substitutes for the backend call.** `RepoLinkPicker`
  still calls `updateProject` regardless of `looksLikeGitRepo`'s value. When
  `false`, it renders a soft, dismissible, non-blocking inline note
  ("This folder doesn't look like a git repo — checking anyway…") **while**
  the real PATCH is in flight, so the user gets a hint in milliseconds
  without the flow ever depending on a check the backend doesn't also
  perform. If the backend then approves it anyway (edge case: a `.git`
  *file* the local check didn't specifically special-case, though it does
  use plain `existsSync` so worktree pointer files pass this check too, same
  as the backend's own logic) the soft note simply disappears along with the
  rest of the unlinked state. If the backend rejects it, the real error
  (§4a) replaces the soft note. The backend remains the only thing that can
  ever produce a final answer — this is speed, not a second implementation
  of the rule.

No backend change beyond §4a's additive fields. Confirmed sufficient.

## 5. G5 + G6 — no signal anywhere, and stale links fail silently

These share one hook and one component, per the brief's own prompt.

### 5.1 `useRepoLinkStatus` — the one staleness computation

**New file `waypoint-frontend/src/renderer/lib/useRepoLinkStatus.ts`:**

```ts
export type RepoLinkStatus =
  | { kind: 'unlinked' }
  | { kind: 'checking' }       // repoPath is set, IPC check not yet resolved
  | { kind: 'linked' }
  | { kind: 'stale' };         // repoPath is set, but repo:check-path said it doesn't exist

/**
 * G5's badge and G6's stale detection are the SAME question — "is this
 * project's repoPath currently a usable directory" — asked from two
 * different places (a persistent header, and CopilotPanel's send gate).
 * One hook, two callers, backed by the one shared main-process check
 * (repoPathStatus.ts, §0.1) that copilotRunner.ts's actual send-time
 * decision also uses — so the badge, the chat card's gate, and what
 * actually happens when a message is sent can never disagree about what
 * "stale" means, only about how fresh their own last check is.
 */
export function useRepoLinkStatus(repoPath: string | null): {
  status: RepoLinkStatus;
  recheck: () => void;
} {
  const [exists, setExists] = useState<boolean | null>(null);
  const check = useCallback(() => {
    if (!repoPath) return;
    setExists(null);
    window.electron.repo.checkPath(repoPath).then(
      (r) => setExists(r.exists),
      () => setExists(null), // an IPC failure is not "stale" — stay in checking rather than falsely accuse a real link
    );
  }, [repoPath]);

  useEffect(() => { check(); }, [check]);

  // Re-checked on window focus, not on a timer — see §5.3 for the tradeoff.
  useEffect(() => {
    const onFocus = () => check();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [check]);

  const status: RepoLinkStatus = !repoPath
    ? { kind: 'unlinked' }
    : exists === null
      ? { kind: 'checking' }
      : exists
        ? { kind: 'linked' }
        : { kind: 'stale' };

  return { status, recheck: check };
}
```

### 5.2 `RepoLinkBadge` and where it renders

**Confirmed by reading the actual layout tree, not assumed:** this app has no
existing per-project header component. `Topbar.tsx` is global (mounted once
by `AppShell`, no `:projectId` awareness beyond a `firstProjectId` for the
quick-create button). `ProjectLayout.tsx` today is exactly:

```tsx
return <Outlet context={{ project, reloadProject: reload } satisfies ProjectOutletContext} />;
```

— nothing else. Every project-scoped page (`WorkItemsLayout`, `CyclesPage`,
`ModulesPage`, `ProjectViewsPage`, `PagesPage`, `IntakePage`,
`ProjectSettingsLayout`) builds its own header locally, with no shared row
above them. **This is the gap** — there is nowhere for a "grounded / not
grounded" signal to live that's visible before a user opens Copilot or drills
into Settings, which is exactly G5's complaint. Fixing it means adding one.

**`ProjectLayout.tsx` gains a thin header row, wrapping `Outlet` instead of
being replaced by it:**

```tsx
export function ProjectLayout() {
  const { projectId = '' } = useParams();
  const { data: project, loading, reload } = useAsync(() => getProject(projectId), [projectId]);
  // ...loading/not-found branches unchanged...

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4">
        <span className="text-base leading-none">{project.icon}</span>
        <span className="font-display text-sm font-medium text-text">{project.name}</span>
        <div className="flex-1" />
        <RepoLinkBadge project={project} onChanged={reload} />
      </div>
      <div className="min-h-0 flex-1">
        <Outlet context={{ project, reloadProject: reload } satisfies ProjectOutletContext} />
      </div>
    </div>
  );
}
```

**Footprint called out explicitly, since the brief asked for honesty about
tradeoffs:** this wraps every one of the eight project-scoped routes listed
above, including `ProjectSettingsLayout`, whose own sidenav already shows the
project icon/name a second time (matching the mockup's own layout exactly —
the mockup draws both the `projhead` bar and the settings sidenav's icon/name
row together, so this duplication is the intended design, not an oversight).
A regression in this one new block is visible on every project page, so it
gets its own isolated component test (`RepoLinkBadge.test.tsx`, §8) plus one
assertion that `ProjectLayout`'s existing tests still render `Outlet`
content unchanged beneath the new header.

**`RepoLinkBadge.tsx`:**

```tsx
export function RepoLinkBadge({ project, onChanged }: { project: Project; onChanged: () => void }) {
  const navigate = useNavigate();
  const { status } = useRepoLinkStatus(project.repoPath);
  const goToSettings = () => navigate(`/projects/${project.id}/settings/codebase`);

  if (status.kind === 'unlinked' || status.kind === 'checking') {
    return (
      <button type="button" onClick={goToSettings} className="/* dashed, muted — mockup's .badge.unlinked */">
        Code not linked
      </button>
    );
  }
  if (status.kind === 'stale') {
    return (
      <button type="button" onClick={goToSettings} className="/* warning-colored — mockup's .badge.stale */">
        Repo folder missing
      </button>
    );
  }
  // linked: name + hover popover with path/branch/change-link, per mockup.
  return <LinkedRepoBadgePopover project={project} onChanged={onChanged} />;
}
```

`LinkedRepoBadgePopover` calls `window.electron.repo.describe(project.
repoPath)` (§3) lazily, on hover/focus rather than on every mount — the
badge itself only needs `status`, not full git detail, until a user actually
opens the popover.

**Mirrored nav dot** — `ProjectSettingsLayout.tsx`'s existing `NAV_GROUPS`
Codebase item gains a small colored dot, driven by the same
`useRepoLinkStatus(project.repoPath).status`:

```tsx
{ to: 'codebase', label: 'Codebase' } // + a <span className={dotColorFor(status)} /> rendered alongside it
```

### 5.3 Cadence — my recommendation, stated plainly

**Mount + window focus, not polling.** `useRepoLinkStatus` checks once when
`repoPath` becomes available (project load / navigation into a new project)
and again every time the app window regains OS focus. It does **not** run on
an interval.

**The tradeoff, stated honestly:** a user who deletes the linked folder in
another application while never switching away from an already-focused
Waypoint window (rare — deleting a folder from Finder/Explorer requires
switching to it, which is itself a focus change into Waypoint on the way
back) can see a stale badge lag behind reality until the next navigation or
focus event. Polling every N seconds would close that narrow remaining gap,
at the cost of a `fs.stat` IPC round trip per open project view per tick, for
a condition (a checkout being deleted mid-session) that is rare in absolute
terms. I'm recommending focus+mount because it catches the realistic version
of this problem (the user switched away, did the thing, switched back) at
effectively zero ongoing cost, and because **the badge is UX, not a safety
boundary** — `copilotRunner.ts`'s own `resolveRepoRoot` re-checks at the
actual moment a message is sent (§0.1), so a stale UI badge can never cause
Copilot to silently use a dead path; the worst case of under-polling here is
a few extra minutes of a badge saying "linked" for a folder that's actually
gone, not an incorrect grounding decision.

### 5.4 Loosening the in-chat card's gate

`useCurrentRouteProject.ts`'s `CurrentRouteProject` gains a `stale` field,
computed the same way:

```ts
export interface CurrentRouteProject {
  projectId: string;
  repoPath: string | null;
  stale: boolean; // NEW
}
```

`reload()` additionally calls `window.electron.repo.checkPath(repoPath)`
when `repoPath` is non-null (folded into the existing fetch, not a second
independent effect — this hook already re-fetches on `projectId` change and
on explicit `reload()` calls from `CopilotPanel.tsx`, which is the right
cadence here too, not per-message).

**`CopilotPanel.tsx`'s two gates change from "no path" to "no *usable*
path":**

```ts
// was: ...(groundingProject?.repoPath ? { repoPath: groundingProject.repoPath } : {})
...(groundingProject?.repoPath && !groundingProject.stale ? { repoPath: groundingProject.repoPath } : {})

// was: if (needsRepoLink && groundingProject && !groundingProject.repoPath)
if (needsRepoLink && groundingProject && (!groundingProject.repoPath || groundingProject.stale))

// was: !routeProject.project.repoPath (repoLinkPromptHere gate)
(!routeProject.project.repoPath || routeProject.project.stale)
```

The first change is the one with real behavioral weight: today a stale
`repoPath` is still sent to `copilotRunner.ts`, which silently degrades to
`os.tmpdir()` — the run *looks* grounded from the renderer's perspective (a
`repoPath` was sent) while actually running unlinked. Omitting `repoPath`
entirely once the renderer itself knows it's stale means the system prompt
(§6 of the V3 design, unchanged here) correctly tells the model it has no
repo access, so `[[NEEDS_REPO]]` can fire honestly instead of the model
believing it already has access it doesn't.

**No new backend endpoint.** One new IPC channel (`repo:check-path`, §0.2),
consumed from two renderer call sites that already exist (`ProjectLayout`
indirectly via `RepoLinkBadge`, and `useCurrentRouteProject`).

## 6. G6's other half — the settings page and the stale state

`Codebase.tsx` (soon a thin wrapper, §7) renders a third state alongside
"unlinked" and "linked": `RepoLinkStaleCard.tsx`, matching the mockup's
`state-stale` block — "The linked folder no longer exists," with `Relocate…`
(opens the chooser pre-seeded with `defaultPath: path.dirname(project.
repoPath)`, i.e. the *parent* of the dead path, since the exact folder is
known not to exist) and `Unlink` (goes straight to G8's confirm flow, no
extra step for a link that's already known-broken).

```tsx
// Codebase.tsx's top-level branch, replacing the current `project.repoPath ? ... : ...`
const { status } = useRepoLinkStatus(project.repoPath);
if (status.kind === 'stale') return <RepoLinkStaleCard project={project} onChanged={reloadProject} />;
if (project.repoPath) return <RepoLinkedCard .../* §7 */ />;
return <RepoLinkPicker .../* §7 */ />;
```

## 7. G7 — the two entry points are two features

**Component structure — the literal answer to "what do both render":**

```
components/domain/repo-link/
  RepoLinkPicker.tsx      — suggestions (§2) + Browse (§1) + inline error (§4)
  RepoLinkedCard.tsx      — name/path/branch/commit/scope-note + actions, `compact` prop
  RepoLinkStaleCard.tsx   — §6
  RepoLinkBadge.tsx       — §5
```

`Codebase.tsx` becomes:

```tsx
export default function Codebase() {
  const { project, reloadProject } = useProject();
  const { status } = useRepoLinkStatus(project.repoPath);
  if (status.kind === 'stale') return <RepoLinkStaleCard project={project} onChanged={reloadProject} />;
  return project.repoPath ? (
    <RepoLinkedCard project={project} repoPath={project.repoPath} onChanged={reloadProject} showUnlink />
  ) : (
    <RepoLinkPicker projectId={project.id} projectName={project.name} projectIdentifier={project.identifier}
      onLinked={reloadProject} />
  );
}
```

`CopilotRepoLinkCard` (still in `CopilotPanel.tsx` — it's small and
transcript-anchored, doesn't need its own file) becomes:

```tsx
function CopilotRepoLinkCard({ projectId, projectName, prompt, onLinked, onAskAgain }: {
  projectId: string; projectName: string; prompt: string;
  onLinked: () => void; onAskAgain: () => void;
}) {
  const [linkedPath, setLinkedPath] = useState<string | null>(null);
  if (linkedPath) {
    return (
      <div className="card-chrome">
        <CardHead k="Codebase linked" project={projectName} tone="success" />
        <RepoLinkedCard projectId={projectId} repoPath={linkedPath} compact onChanged={() => {}} />
        <CardFoot>
          <Button variant="primary" size="xs" onClick={onAskAgain}>Ask again with code access</Button>
          <ManageInSettingsLink projectId={projectId} />
        </CardFoot>
      </div>
    );
  }
  return (
    <div className="card-chrome">
      <CardHead k="Codebase not linked" project={projectName} />
      <RepoLinkPicker projectId={projectId} projectName={projectName} compact
        onLinked={(path) => { setLinkedPath(path); onLinked(); }} />
      <ManageInSettingsLink projectId={projectId} />
    </div>
  );
}
```

Both are now callers of the same three components — "the card is a compact
version of the same component" is true of the render tree, not just true in
spirit, satisfying exactly what the brief asked for. `compact` on
`RepoLinkPicker` renders the mockup's `mini-sugg` row styling instead of the
full `sugg` row and omits the section label; `compact` on `RepoLinkedCard`
omits the scope-note block and the Unlink action (the chat card never offers
Unlink, matching the mockup) and uses the tighter chip-only path line instead
of the full linked-card chrome.

`projectName` is now threaded to the card (`CardHead`'s `proj` slot in the
mockup) — closing the sharpest specific complaint in the gaps doc's §6 table
("the card never displays the project name"). It comes from
`useCurrentRouteProject`'s already-fetched project (add `name` to
`CurrentRouteProject`, one field, same fetch).

**"Ask again with code access" — the retry pattern reused, precisely.**

`CopilotPanel.tsx` already has a re-send pattern: `retryRun()` re-invokes
`runAndPersist` with `lastFailedPrompt` after a *failed* run, including
cleanup of stale proposals from the dead turn (§`retryRun`, lines ~733–793).
The turn that triggers the repo-link card is **not a failure** — it's a
normal, successfully persisted reply that happened to end with
`[[NEEDS_REPO]]` — so `lastFailedPrompt`/`runError` are never populated for
it, and reusing `retryRun()` directly would mean artificially stuffing state
meant for a different case. Rather than bend that function's contract, add
one small sibling that mirrors its *simple* branch (no stale-proposal
cleanup needed — the original turn completed and persisted cleanly, there's
nothing to reject):

```ts
// repoLinkPrompt gains one field, set where it's already constructed
// (runAndPersist's onDone, which already has `content` — the triggering
// user message — in scope):
const [repoLinkPrompt, setRepoLinkPrompt] = useState<{
  sessionId: string; projectId: string; afterMessageId: string; prompt: string; // NEW
} | null>(null);
// ...
if (needsRepoLink && groundingProject && (!groundingProject.repoPath || groundingProject.stale)) {
  setRepoLinkPrompt({ sessionId, projectId: groundingProject.projectId, afterMessageId: persisted.id, prompt: content });
}

function askAgainWithCodeAccess(sessionId: string, prompt: string) {
  const resumeSessionId = sessions.find((s) => s.id === sessionId)?.claudeSessionId ?? undefined;
  runAndPersist(sessionId, prompt, resumeSessionId, proposalStore.buildOutcomePreamble());
}
```

Wired to the card's `onAskAgain` as
`() => askAgainWithCodeAccess(repoLinkPromptHere.sessionId, repoLinkPromptHere.prompt)`.
This re-runs the exact question that triggered the card, in the same
(resumed) Claude Code session, now with `repoPath` populated — the literal
"closing the loop" behavior G7 and the mockup both describe. It does not
touch `runError`/`lastFailedPrompt` at all, so it can't be confused with a
failure-retry by anything else reading that state.

**No backend change; no new IPC beyond what §0–§6 already introduced.**

## 8. G8 — unlink is the cheapest click on the page

State machine, local to `RepoLinkedCard` (the non-compact/settings variant
only — the chat card never shows Unlink, §7):

```
'idle' → (click Unlink) → 'confirming' → (click "Unlink" in the confirm row)
  → updateProject(id, { repoPath: null }) → 'undoable' (5s) → 'idle'
                                          ↳ (click Undo) → updateProject(id, { repoPath: previousPath }) → 'idle'
```

**The important semantic call, stated explicitly: unlink is immediate, undo
re-links — this is not a 5-second deferred unlink.** The confirm copy says
"Copilot will stop reading this project's code," which has to become true
the instant the user confirms, not five seconds later — deferring the actual
`repoPath: null` write would mean Copilot could still ground answers in the
repo during the "undo window" while the UI already claims it can't, silently
contradicting its own copy. So the PATCH fires on confirm, and "Undo" is a
genuine second PATCH that re-sets the previous value — trivial, since (per
G8's own fix text) nothing else destroys `repoPath`'s old value.

```tsx
function RepoLinkedCard({ project, repoPath, onChanged, showUnlink, compact }: Props) {
  const [phase, setPhase] = useState<'idle' | 'confirming' | 'undoable'>('idle');
  const [secondsLeft, setSecondsLeft] = useState(5);
  const previousPathRef = useRef(repoPath);

  async function confirmUnlink() {
    previousPathRef.current = repoPath;
    await updateProject(project.id, { repoPath: null }, { silent: true });
    onChanged();
    setPhase('undoable');
    setSecondsLeft(5);
  }
  useEffect(() => {
    if (phase !== 'undoable') return;
    if (secondsLeft === 0) { setPhase('idle'); return; }
    const t = setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [phase, secondsLeft]);
  async function undo() {
    await updateProject(project.id, { repoPath: previousPathRef.current }, { silent: true });
    onChanged();
    setPhase('idle');
  }

  // 'undoable' renders as a small inline strip in place of the (now gone)
  // linked card — "Unlinked. Undo (5s)" — not a global toast: consistent
  // with G4's "keep it where attention already is" and with everything
  // else in this doc being inline-only, not toast-based.
  // 'confirming' renders the mockup's #unlink-confirm block in place of
  // the linked-foot action row.
  // 'idle' + showUnlink renders Unlink at lower visual weight than
  // "Change folder…" (ghost/danger-ghost vs. secondary), per G8's fix text.
}
```

No backend change — the existing `updateProject(id, { repoPath: null })`
call is untouched; only the UI sequencing around it is new.

## 9. Test plan

Following this repo's existing split: backend gets real assertions
(vitest, real temp-dir `fs`, no real Postgres — `projects.service.test.ts`
already works this way); frontend mocks the IPC/HTTP boundary
(`jest.mock('@/mock/api')`, `window.electron` stubbed directly, matching
`Codebase.test.tsx`/`CopilotPanel.test.tsx`'s existing convention exactly).
Nothing here shells out to a real `git` binary or opens a real OS dialog in
an automated test, matching this repo's own established posture toward
`child_process`/native-dialog testing (`copilotRunner.test.ts` mocks
`spawn` fully; there is no existing precedent for a real-subprocess
integration test anywhere in this codebase, so this design doesn't invent
one for `execFile('git', ...)` either).

**Backend — unit, real coverage:**
- `projects.service.test.ts`: extend `validateRepoPath`'s three existing
  "rejects" cases to also assert `.code` (`repo_path_not_found`/
  `repo_path_not_directory`/`repo_path_not_git_repo`) and `.path` (equals
  the input path) on the thrown `ValidationError`, alongside the existing
  message-regex assertions (kept, not removed — the message is still the
  fallback/"Technical details" text on the frontend).
- `errorHandler.test.ts`: extend the existing "maps a ValidationError to 400"
  case with a second case constructing `new ValidationError(msg, 'repo_path_
  not_git_repo', '/tmp/x')` and asserting the JSON body includes `code` and
  `path`; the existing bare-`ValidationError` case is left completely
  unmodified (see §4a — confirmed it still passes as written).

**Frontend — unit, real coverage:**
- `Codebase.test.tsx`: existing cases largely carry over once `Codebase.tsx`
  becomes a thin dispatcher (§7) — update the "shows the linked path" case to
  assert against `RepoLinkedCard`'s rendered output instead of the old
  inline markup, and the "renders a backend validation failure inline" case
  to mock an `ApiError` with `code: 'repo_path_not_git_repo'` and assert the
  human title/body render, with the raw string only inside the collapsed
  `<details>`. New cases: a `RepoSuggestion` click calls `updateProject` with
  that suggestion's path directly, without ever calling `chooseFolder`; a
  stale project (`repoPath` set, `window.electron.repo.checkPath` mocked to
  resolve `{ exists: false }`) renders `RepoLinkStaleCard`, not the linked
  card; Unlink requires confirmation (`updateProject` not called on the
  first click); confirming Unlink then clicking Undo results in a second
  `updateProject` call restoring the original path.
- New `RepoLinkPicker.test.tsx`, `RepoLinkedCard.test.tsx`,
  `RepoLinkBadge.test.tsx`, `useRepoSuggestions.test.ts`,
  `useRepoLinkStatus.test.ts` — each component/hook tested in isolation now
  that they're extracted, same `jest.mock` boundary conventions as above.
- `CopilotPanel.test.tsx`: extend the existing `needsRepoLink` coverage —
  the card now renders the project's name (mock `getProject` to include
  `name`); a suggestion click on the card's `RepoLinkPicker` calls
  `updateProject` and flips the card into its `RepoLinkedCard`-compact +
  "Ask again" state without a second `chooseFolder` call; clicking
  "Ask again with code access" calls `window.electron.copilot.runPrompt`
  again with the same prompt text and the session's `resumeSessionId`,
  distinctly from the existing `retryRun` coverage (assert `runError`/
  `lastFailedPrompt` are untouched by this path); a `stale: true` route
  project re-shows the card even though `repoPath` is non-null.
- `httpClient.test.ts` (extend if present, else create): a non-OK JSON
  response carrying `{ error, code, path }` produces an `ApiError` with all
  three fields populated; `opts.silent` suppresses `showErrorToast` while
  still throwing.
- `repoLinkErrors.test.ts` (new, pure function, no rendering): each known
  `code` maps to its specific title/body with the path interpolated; an
  unknown or missing `code` falls back to the raw message under a generic
  title.
- `preload.test.ts`: extend for `repo.chooseFolder`'s new `opts` argument
  (forwarded verbatim to `ipcRenderer.invoke`), and new cases for
  `repo.checkPath` and `repo.describe`, mirroring the existing
  `copilot.auth.*` invoke/handle coverage.

**Manual QA only** (matches this repo's own convention — no automated test
here shells to real `git` or opens a real dialog):
- The native folder dialog itself, with a real `defaultPath`/`title` set,
  on at least macOS (and Windows/Linux if this app ships them — it does
  package an nsis Windows target per the V3 design doc's own note).
- `repo:describe` against a handful of real local checkouts: a normal repo,
  a git worktree, a repo with zero commits, a repo on a detached HEAD, a
  path where the `git` binary itself is missing from `PATH` — confirm each
  degrades individual fields to `null` rather than failing the whole card.
- The 5-second undo window's actual timing and the "unlink is immediate"
  behavior end to end: unlink, immediately ask Copilot a code question in a
  fresh message before the undo window expires, and confirm it behaves as
  genuinely unlinked (not a delayed unlink) even mid-undo-window.
- Moving/deleting a linked checkout while the app is both focused and
  backgrounded, confirming the badge and Codebase page pick it up on the
  next focus/navigation per §5.3's stated cadence, and that a Copilot send
  during that lag window still resolves correctly via `copilotRunner.ts`'s
  own independent check (never trusting the UI's possibly-stale badge).

## Summary

- **Schema/backend:** no new endpoint or route — every write still goes
  through `PATCH /projects/:id`, confirmed sufficient for G1/G2/G3/G7/G8.
  One additive, backward-compatible backend change beyond that: `Validation
  Error` gains optional `code`/`path` fields, surfaced in the existing 400
  JSON body (§4a) — this is a real backend change the gaps doc's "presentation
  or main-process only" framing doesn't quite cover, called out rather than
  glossed over.
- **New IPC surface:** `repo:choose-folder` widened to accept `{ defaultPath,
  title, message }` and to return a `looksLikeGitRepo` pre-flight hint
  (§1/§4c); two new channels on the same file/registration —
  `repo:check-path` (§0.2/§5, backs both the header badge and the in-chat
  card's staleness gate) and `repo:describe` (§3, git branch/last-commit/
  file-count via `child_process.execFile`, not a new dependency).
- **G2's sibling-directory call:** recents-only, no new fs capability, in
  this PR. No `fs.readdir`-exposing channel exists in this codebase today;
  recents alone reproduces the mockup's suggestion list once "name match" is
  read as string-matching against already-known paths, not directory
  scanning; the one real cost (an empty strip on a machine's very first-ever
  link) is a one-time cliff, not an ongoing gap. Sibling scanning is spec'd
  as a scoped fast-follow if that cliff proves to matter in practice.
- **G3's git-data call:** shell out to the `git` binary via `child_process.
  execFile` from the main process, not a new dependency. Confirmed no
  `simple-git`/`isomorphic-git`/equivalent in `package.json`; the main
  process already treats `child_process.spawn` as an established pattern
  (`claudeSdkClient.ts`); two tiny read-only plumbing calls don't earn a new
  dependency.
- **G4's error-representation call:** backend `code`/`path` fields, not
  frontend string-matching. Small, additive, backward-compatible (confirmed
  against the one existing `errorHandler.test.ts` case that omits both
  fields). Frontend classification is a plain object lookup keyed on `code`;
  `path` interpolates the copy, with zero regex/parsing of the human message
  anywhere.
- **G5/G6's staleness mechanism — my recommendation:** one shared main-
  process fact (`isUsableRepoDirectory`, §0.1) used by both
  `copilotRunner.ts`'s existing send-time check and a new `repo:check-path`
  IPC channel; one renderer hook (`useRepoLinkStatus`) consumed by the new
  header badge (`RepoLinkBadge`, added to `ProjectLayout.tsx` since no
  per-project header component existed before this design — confirmed by
  reading the layout tree, not assumed) and by `useCurrentRouteProject`'s
  new `stale` field. Checked on mount and on window focus, explicitly not
  polled — stated tradeoff: a narrow lag window for a folder deleted while
  the app stays focused throughout, accepted because the badge is UX, not a
  safety boundary; `copilotRunner.ts`'s own independent check at send time
  is what actually protects against a stale path silently degrading a run.
- **G7's shared-component call:** `RepoLinkPicker`/`RepoLinkedCard` (each
  with a `compact` prop) under a new `components/domain/repo-link/` folder,
  rendered by both `Codebase.tsx` and `CopilotRepoLinkCard` — literally the
  same render tree, not just similar markup. "Ask again with code access"
  is a new small function (`askAgainWithCodeAccess`) that mirrors
  `retryRun()`'s simple-path shape but is deliberately not `retryRun()`
  itself, since the triggering turn was a successful reply, not a failure,
  and conflating the two would mean bending `runError`/`lastFailedPrompt`'s
  existing, narrower contract.
- **Biggest judgment call overall, worth the founder's explicit sanity
  check:** `ProjectLayout.tsx` gaining a persistent header row (§5.2) is the
  one change in this design with the widest blast radius — it wraps all
  eight project-scoped routes, including `ProjectSettingsLayout`, which
  already shows the project icon/name once in its own sidenav (intentional
  duplication, matching the mockup, not an oversight, but worth a conscious
  look before merging). Every other change in this document is scoped to
  one page, one card, or one file at a time.
- **Other things worth a second look before implementation starts:** whether
  `trackedFileCount` in `repo:describe` (§3) is worth keeping given it's the
  least-essential of the three git calls and the only one not explicitly
  asked for by G3's own text (it's there for mockup parity, not because the
  gap requires it); whether 5 seconds (§8) is the right undo window length
  versus this app's existing conventions elsewhere, if any exist; and
  whether the `looksNamedFor` matching heuristic in `useRepoSuggestions`
  (§2) needs any tuning once tried against this team's actual
  project-naming conventions, since it was designed against the mockup's
  examples rather than real data.
