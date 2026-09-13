import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/**
 * Which folder a Jira project's code lives in — W5b, ROAD-126
 * (docs/design/w5b-jira-dispatch.md §2.2).
 *
 * A native ticket's project has a linked repository; a Jira issue belongs
 * to a Jira project, which Waypoint knows nothing about. The person says
 * once, in the brief preview, where `ENG`'s code is, and this remembers
 * it: `<userData>/engine/jira-project-repos.json`, keyed by the connected
 * site's hostname and the issue key's project part, holding an absolute
 * path. The recents file's rules apply — main's file, paths never leave
 * main (the renderer sees folder handles), an entry whose path is gone
 * from this machine is dropped on read — and *Change* in the preview
 * replaces an entry.
 *
 * Deliberately not `projects.jira_project_key` on the backend: that is the
 * better long-term shape for a PM companion that mirrors trackers, and
 * needs a settings surface, a column, and a story for a Jira user with no
 * Waypoint project at all (ROAD-129). This file is what the person meets
 * either way.
 */

export interface JiraRepoEntry {
  site: string;
  projectKey: string;
  path: string;
  setAt: string;
}

/** `ENG-4` → `ENG`; null for anything that is not an issue key. */
export function projectKeyOf(issueKey: string): string | null {
  const match = /^([A-Za-z][A-Za-z0-9_]*)-\d+$/.exec(issueKey.trim());
  return match ? match[1].toUpperCase() : null;
}

function entryKey(site: string, projectKey: string): string {
  return `${site.toLowerCase()}/${projectKey.toUpperCase()}`;
}

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await fs.stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

/** Every remembered mapping whose folder still exists, as stored. */
export async function readJiraRepos(file: string): Promise<JiraRepoEntry[]> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: JiraRepoEntry[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const e = item as Partial<JiraRepoEntry>;
    if (
      typeof e.site !== 'string' ||
      typeof e.projectKey !== 'string' ||
      typeof e.path !== 'string' ||
      !path.isAbsolute(e.path)
    ) {
      continue;
    }
    // eslint-disable-next-line no-await-in-loop -- a handful of projects
    if (!(await isDirectory(e.path))) continue;
    out.push({
      site: e.site,
      projectKey: e.projectKey,
      path: e.path,
      setAt: typeof e.setAt === 'string' ? e.setAt : new Date(0).toISOString(),
    });
  }
  return out;
}

async function writeJiraRepos(
  file: string,
  entries: JiraRepoEntry[],
): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(entries, null, 2)}\n`);
}

/** The folder remembered for a Jira project on a site, or null. */
export async function lookupJiraRepo(
  file: string,
  site: string,
  projectKey: string,
): Promise<string | null> {
  const wanted = entryKey(site, projectKey);
  const hit = (await readJiraRepos(file)).find(
    (e) => entryKey(e.site, e.projectKey) === wanted,
  );
  return hit?.path ?? null;
}

/** Records (or replaces) the folder for a Jira project on a site. */
export async function rememberJiraRepo(
  file: string,
  site: string,
  projectKey: string,
  canonicalPath: string,
  now = new Date(),
): Promise<void> {
  const wanted = entryKey(site, projectKey);
  const rest = (await readJiraRepos(file)).filter(
    (e) => entryKey(e.site, e.projectKey) !== wanted,
  );
  await writeJiraRepos(file, [
    {
      site: site.toLowerCase(),
      projectKey: projectKey.toUpperCase(),
      path: canonicalPath,
      setAt: now.toISOString(),
    },
    ...rest,
  ]);
}
