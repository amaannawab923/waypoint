import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useAllProjects } from '@/lib/projectsStore';
import { usePendingProposalCount } from '@/lib/proposalStore';
import { useWaitingSessionsCount } from '@/lib/sessionsStore';
import { PEEK_DELAY_MS, SidebarRail } from './SidebarRail';

jest.mock('@/lib/projectsStore', () => ({ useAllProjects: jest.fn() }));
jest.mock('@/lib/proposalStore', () => ({
  usePendingProposalCount: jest.fn(),
}));
jest.mock('@/lib/sessionsStore', () => ({
  useWaitingSessionsCount: jest.fn(),
}));

const project = (id: string, name: string) =>
  ({ id, name, icon: '📁' }) as never;

function renderRail() {
  const props = {
    onPeek: jest.fn(),
    onPeekEnd: jest.fn(),
    onPin: jest.fn(),
    localSummary: 'Local · 3 repos · Claude ready',
  };
  render(
    <MemoryRouter initialEntries={['/sessions']}>
      <SidebarRail
        onPeek={props.onPeek}
        onPeekEnd={props.onPeekEnd}
        onPin={props.onPin}
        localSummary={props.localSummary}
      />
    </MemoryRouter>,
  );
  return props;
}

beforeEach(() => {
  jest.clearAllMocks();
  (useAllProjects as jest.Mock).mockReturnValue([]);
  (usePendingProposalCount as jest.Mock).mockReturnValue(0);
  (useWaitingSessionsCount as jest.Mock).mockReturnValue(0);
});

describe('SidebarRail', () => {
  it('carries exactly the six destinations plus the local dot, labelled for a screen reader', () => {
    renderRail();
    for (const label of [
      'Home',
      'My work',
      'My sessions',
      'Review',
      'Projects',
      'Workspace settings',
      'Local · 3 repos · Claude ready',
    ]) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
    expect(screen.queryByLabelText('Notifications')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Drafts')).not.toBeInTheDocument();
    expect(screen.getByLabelText('My sessions')).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('badges My sessions with the waiting count and Review with pending proposals, and says so on hover', () => {
    (useWaitingSessionsCount as jest.Mock).mockReturnValue(2);
    (usePendingProposalCount as jest.Mock).mockReturnValue(5);
    renderRail();
    const sessions = screen.getByLabelText('My sessions · 2 waiting on you');
    expect(sessions).toHaveTextContent('2');
    expect(screen.getByLabelText('Review')).toHaveTextContent('5');
  });

  it('folds the projects into one icon whose flyout lists at most six, then "All projects & tickets"', () => {
    (useAllProjects as jest.Mock).mockReturnValue(
      ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((id) =>
        project(id, `Project ${id}`),
      ),
    );
    renderRail();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    fireEvent.mouseEnter(screen.getByLabelText('Projects').parentElement!);
    const menu = screen.getByRole('menu', { name: 'Projects' });
    const items = screen.getAllByRole('menuitem');
    expect(items).toHaveLength(7);
    expect(items[0]).toHaveTextContent('Project a');
    expect(items[5]).toHaveTextContent('Project f');
    expect(items[6]).toHaveTextContent('All projects & tickets (+2)');
    expect(menu).toBeInTheDocument();
  });

  it('peeks only after the pointer rests on the expand affordance; a click pins', () => {
    jest.useFakeTimers();
    try {
      const props = renderRail();
      const affordance = screen.getByLabelText('Expand sidebar');
      fireEvent.mouseEnter(affordance);
      act(() => {
        jest.advanceTimersByTime(PEEK_DELAY_MS - 1);
      });
      expect(props.onPeek).not.toHaveBeenCalled();
      act(() => {
        jest.advanceTimersByTime(2);
      });
      expect(props.onPeek).toHaveBeenCalledTimes(1);
      fireEvent.mouseLeave(affordance);
      expect(props.onPeekEnd).toHaveBeenCalledTimes(1);

      // A pass-through never peeks.
      fireEvent.mouseEnter(affordance);
      fireEvent.mouseLeave(affordance);
      act(() => {
        jest.advanceTimersByTime(PEEK_DELAY_MS + 10);
      });
      expect(props.onPeek).toHaveBeenCalledTimes(1);

      fireEvent.click(affordance);
      expect(props.onPin).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });
});
