import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  lookupJiraRepo,
  projectKeyOf,
  readJiraRepos,
  rememberJiraRepo,
} from './jiraRepos';

// The folder a Jira project's code lives in (W5b,
// docs/design/w5b-jira-dispatch.md §2.2): remembered once, replaced on
// Change, dropped when the folder is gone, keyed by site and project.

let dir: string;
let repoA: string;
let repoB: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-jira-repos-'));
  repoA = path.join(dir, 'a');
  repoB = path.join(dir, 'b');
  fs.mkdirSync(repoA);
  fs.mkdirSync(repoB);
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('projectKeyOf', () => {
  it.each([
    ['ENG-4', 'ENG'],
    ['eng-4', 'ENG'],
    [' ROAD_2-116 ', 'ROAD_2'],
    ['ENG', null],
    ['4-ENG', null],
    ['', null],
  ])('%j → %j', (key, expected) => {
    expect(projectKeyOf(key)).toBe(expected);
  });
});

describe('the mapping file', () => {
  it('is empty when missing or malformed', async () => {
    expect(await readJiraRepos(path.join(dir, 'missing.json'))).toEqual([]);
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(bad, '{not json');
    expect(await readJiraRepos(bad)).toEqual([]);
    fs.writeFileSync(bad, JSON.stringify({ site: 'x' }));
    expect(await readJiraRepos(bad)).toEqual([]);
  });

  it('remembers a folder per site and project, case-insensitively, and replaces it on a second remember', async () => {
    const file = path.join(dir, 'repos.json');
    await rememberJiraRepo(file, 'YourTeam.atlassian.net', 'eng', repoA);
    expect(await lookupJiraRepo(file, 'yourteam.atlassian.net', 'ENG')).toBe(
      repoA,
    );
    expect(
      await lookupJiraRepo(file, 'yourteam.atlassian.net', 'OPS'),
    ).toBeNull();
    expect(await lookupJiraRepo(file, 'other.atlassian.net', 'ENG')).toBeNull();

    await rememberJiraRepo(file, 'yourteam.atlassian.net', 'OPS', repoB);
    await rememberJiraRepo(file, 'yourteam.atlassian.net', 'ENG', repoB);
    const entries = await readJiraRepos(file);
    expect(entries.map((e) => [e.projectKey, e.path])).toEqual([
      ['ENG', repoB],
      ['OPS', repoB],
    ]);
    expect(entries[0].site).toBe('yourteam.atlassian.net');
  });

  it('drops an entry whose folder is gone, and one whose path is not absolute', async () => {
    const file = path.join(dir, 'pruned.json');
    const gone = path.join(dir, 'gone');
    fs.mkdirSync(gone);
    await rememberJiraRepo(file, 'yourteam.atlassian.net', 'ENG', gone);
    await rememberJiraRepo(file, 'yourteam.atlassian.net', 'OPS', repoA);
    fs.rmSync(gone, { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify([
        ...JSON.parse(fs.readFileSync(file, 'utf8')),
        {
          site: 'yourteam.atlassian.net',
          projectKey: 'REL',
          path: 'relative/x',
        },
      ]),
    );
    expect((await readJiraRepos(file)).map((e) => e.projectKey)).toEqual([
      'OPS',
    ]);
    expect(
      await lookupJiraRepo(file, 'yourteam.atlassian.net', 'ENG'),
    ).toBeNull();
  });
});
