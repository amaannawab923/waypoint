import '@testing-library/jest-dom';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import {
  getApprovedPerActiveDayStats,
  listAllTickets,
  listDocs,
  listMembers,
  listProjects,
  listSprints,
  listStates,
  listWorkstreams,
} from '@/data/api';
import AnalyticsPage from './AnalyticsPage';

// W4.5 (architecture §4.2/§4.4, waypoint-product-strategy.md decision 10) —
// the "proposals approved per active day" tile is the whole point of this
// unit (it cannot be instrumented retroactively), so these tests exercise
// both its real-data rendering and its honest "not enough data yet" floor —
// same pattern as TicketDetailPage.test.tsx: a fully mocked '@/data/api'.
jest.mock('@/data/api', () => ({
  listProjects: jest.fn(),
  listAllTickets: jest.fn(),
  listWorkstreams: jest.fn(),
  listSprints: jest.fn(),
  listDocs: jest.fn(),
  listMembers: jest.fn(),
  listStates: jest.fn(),
  getApprovedPerActiveDayStats: jest.fn(),
}));

beforeEach(() => {
  jest.resetAllMocks();
  jest.mocked(listProjects).mockResolvedValue([]);
  jest.mocked(listAllTickets).mockResolvedValue([]);
  jest.mocked(listWorkstreams).mockResolvedValue([]);
  jest.mocked(listSprints).mockResolvedValue([]);
  jest.mocked(listDocs).mockResolvedValue([]);
  jest.mocked(listMembers).mockResolvedValue([]);
  jest.mocked(listStates).mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
});

function renderPage() {
  return render(
    <MemoryRouter>
      <AnalyticsPage />
    </MemoryRouter>,
  );
}

describe('AnalyticsPage — proposals approved per active day tile', () => {
  it('renders the average, rounded to one decimal, with the approved/active-day breakdown', async () => {
    jest.mocked(getApprovedPerActiveDayStats).mockResolvedValue({
      approvedCount: 17,
      activeDays: 5,
      averagePerActiveDay: 3.4,
    });

    renderPage();

    expect(await screen.findByText('3.4')).toBeInTheDocument();
    expect(
      screen.getByText(
        (_, el) => el?.textContent === 'Proposals approved / active day · 17 approved over 5 active days',
      ),
    ).toBeInTheDocument();
  });

  it('shows the honest "not enough data yet" floor instead of 0 when there are no active days', async () => {
    jest.mocked(getApprovedPerActiveDayStats).mockResolvedValue({
      approvedCount: 0,
      activeDays: 0,
      averagePerActiveDay: null,
    });

    renderPage();

    expect(await screen.findByText('Not enough data yet')).toBeInTheDocument();
    expect(screen.queryByText(/approved over/)).not.toBeInTheDocument();
  });

  it('uses singular "day" for exactly one active day', async () => {
    jest.mocked(getApprovedPerActiveDayStats).mockResolvedValue({
      approvedCount: 2,
      activeDays: 1,
      averagePerActiveDay: 2,
    });

    renderPage();

    expect(
      await screen.findByText(
        (_, el) => el?.textContent === 'Proposals approved / active day · 2 approved over 1 active day',
      ),
    ).toBeInTheDocument();
  });
});
