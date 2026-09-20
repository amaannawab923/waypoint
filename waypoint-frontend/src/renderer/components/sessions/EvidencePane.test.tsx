import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import {
  listRunEvidence,
  onRunChanged,
  readRunEvidence,
} from '@/data/engineApi';
import type { AgentRun } from '@/types/agentRuns';
import { EvidencePane } from './EvidencePane';

jest.mock('@/data/engineApi', () => ({
  listRunEvidence: jest.fn(),
  readRunEvidence: jest.fn(),
  onRunChanged: jest.fn(() => () => {}),
}));

const run = (over: Partial<AgentRun> = {}): AgentRun =>
  ({
    id: 'run-abc1234',
    status: 'done',
    worktreePath: '/tmp/wt/run-abc1234',
    ...over,
  }) as AgentRun;

const flush = () =>
  act(
    () =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      }),
  );

const listMock = listRunEvidence as jest.Mock;
const readMock = readRunEvidence as jest.Mock;
const changedMock = onRunChanged as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  changedMock.mockImplementation(() => () => {});
});

describe('EvidencePane', () => {
  it('lists the kept screenshots, reads each on demand, and reports the count', async () => {
    listMock.mockResolvedValue([
      {
        name: '01-before.png',
        bytes: 2048,
        modifiedAt: '2026-09-20T10:00:00Z',
      },
      {
        name: '02-after.png',
        bytes: 3 * 1024 * 1024,
        modifiedAt: '2026-09-20T10:01:00Z',
      },
    ]);
    readMock.mockImplementation(async (_id: string, name: string) => ({
      name,
      dataUrl: `data:image/png;base64,${name}`,
    }));
    const onCount = jest.fn();
    render(<EvidencePane run={run()} onCount={onCount} />);
    await flush();

    expect(onCount).toHaveBeenCalledWith(2);
    expect(screen.getByText('2 screenshots')).toBeInTheDocument();
    expect(screen.getByText('2 KB')).toBeInTheDocument();
    expect(screen.getByText('3.0 MB')).toBeInTheDocument();
    const imgs = screen.getAllByRole('img') as HTMLImageElement[];
    expect(imgs.map((i) => i.getAttribute('alt'))).toEqual([
      '01-before.png',
      '02-after.png',
    ]);
    expect(imgs[0].src).toBe('data:image/png;base64,01-before.png');
    expect(readMock).toHaveBeenCalledTimes(2);
  });

  it('says so when there is nothing, in the live and the finished tense', async () => {
    listMock.mockResolvedValue([]);
    const { unmount } = render(
      <EvidencePane run={run({ status: 'running' })} onCount={jest.fn()} />,
    );
    await flush();
    expect(screen.getByText(/No screenshots yet/)).toBeInTheDocument();
    unmount();
    render(<EvidencePane run={run({ status: 'done' })} onCount={jest.fn()} />);
    await flush();
    expect(
      screen.getByText(/This run saved no screenshots/),
    ).toBeInTheDocument();
  });

  it('re-reads on Refresh and when main reports the run changed; shows a read failure', async () => {
    let onChanged: ((c: { runId: string }) => void) | null = null;
    changedMock.mockImplementation((cb: (c: { runId: string }) => void) => {
      onChanged = cb;
      return () => {};
    });
    listMock.mockResolvedValue([]);
    render(<EvidencePane run={run()} onCount={jest.fn()} />);
    await flush();
    expect(listMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByLabelText('Refresh evidence'));
    await flush();
    expect(listMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      onChanged?.({ runId: 'run-other' });
      onChanged?.({ runId: 'run-abc1234' });
    });
    await flush();
    expect(listMock).toHaveBeenCalledTimes(3);

    listMock.mockRejectedValueOnce(
      new Error('No run run-abc1234 in the ledger.'),
    );
    fireEvent.click(screen.getByLabelText('Refresh evidence'));
    await flush();
    expect(
      screen.getByText('No run run-abc1234 in the ledger.'),
    ).toHaveAttribute('data-evidence-error');
  });
});
