import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { getRunDiff } from '@/data/engineApi';
import type { AgentRun, RunDiff } from '@/types/agentRuns';
import { DiffPane, numberLines, splitPatch } from './DiffPane';

jest.mock('@/data/engineApi', () => ({ getRunDiff: jest.fn() }));

const PATCH = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -12,3 +12,4 @@ export function a() {
   const x = 1;
-  const width = 320;
+  const [width, setWidth] = useState(240);
+  const clamped = clamp(width, 200, 420);
   return x;
diff --git a/new.txt b/new.txt
new file mode 100644
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+one
+two
`;

const run = (over: Partial<AgentRun> = {}): AgentRun =>
  ({
    id: 'run-abc1234',
    status: 'running',
    worktreePath: '/tmp/wt/run-abc1234',
    baseRef: 'main',
    ...over,
  }) as AgentRun;

const flush = () =>
  act(
    () =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      }),
  );

describe('splitPatch / numberLines', () => {
  it('splits a unified patch per new path and numbers lines from the hunk headers', () => {
    const files = splitPatch(PATCH);
    expect([...files.keys()]).toEqual(['src/a.ts', 'new.txt']);
    const lines = numberLines(files.get('src/a.ts')!);
    const numbered = lines
      .filter((l) => l.kind === 'add' || l.kind === 'del' || l.kind === 'ctx')
      .map((l) => [l.kind, l.no]);
    expect(numbered).toEqual([
      ['ctx', 12],
      ['del', 13],
      ['add', 13],
      ['add', 14],
      ['ctx', 15],
    ]);
  });
});

describe('DiffPane', () => {
  beforeEach(() => jest.clearAllMocks());

  it('reads the diff for the run, lists files with glyph and counts, shows the selected file, and tells the parent the count', async () => {
    const diff: RunDiff = {
      comparedTo: 'abc123',
      truncated: false,
      files: [
        { path: 'new.txt', status: 'untracked', additions: 2, deletions: 0 },
        { path: 'src/a.ts', status: 'modified', additions: 2, deletions: 1 },
      ],
      patch: PATCH,
    };
    (getRunDiff as jest.Mock).mockResolvedValue(diff);
    const onFileCount = jest.fn();
    render(<DiffPane run={run()} onFileCount={onFileCount} />);
    await flush();

    expect(getRunDiff).toHaveBeenCalledWith('run-abc1234');
    expect(onFileCount).toHaveBeenCalledWith(2);
    expect(screen.getByText('2 files · vs main')).toBeInTheDocument();
    expect(screen.getByTitle('src/a.ts')).toHaveTextContent('+2');
    expect(screen.getByTitle('src/a.ts')).toHaveTextContent('−1');
    // The first file is selected and its lines are numbered.
    expect(screen.getByText('+one')).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('src/a.ts'));
    expect(
      screen.getByText((_, el) => el?.textContent === '-  const width = 320;'),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Refresh diff'));
    await flush();
    expect(getRunDiff).toHaveBeenCalledTimes(2);
  });

  it('says so when there is no worktree yet, and shows main’s sentence when the read fails', async () => {
    const onFileCount = jest.fn();
    const { rerender } = render(
      <DiffPane
        run={run({ worktreePath: null, status: 'queued' })}
        onFileCount={onFileCount}
      />,
    );
    expect(screen.getByText(/No worktree yet/)).toBeInTheDocument();
    expect(getRunDiff).not.toHaveBeenCalled();
    expect(onFileCount).toHaveBeenCalledWith(null);

    (getRunDiff as jest.Mock).mockRejectedValue(
      new Error("git diff failed in the run's worktree: fatal: bad revision"),
    );
    rerender(<DiffPane run={run()} onFileCount={onFileCount} />);
    await flush();
    expect(screen.getByText(/fatal: bad revision/)).toBeInTheDocument();
  });
});
