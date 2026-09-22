import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import MachinePage from './MachinePage';

// Scoped to the "Browser tasks in a session" row (Ultrafast browser tasks)
// in the "What leaves this machine" table — same minimal-stub posture
// MachinePage.engine.test.tsx documents for the rest of the page.
jest.mock('@/data/api', () => ({
  listProjects: jest.fn(async () => []),
  detectLocalClaudeCode: jest.fn(async () => ({
    state: 'absent',
    reason: null,
  })),
}));
jest.mock('@/data/engineApi', () => ({
  installEngine: jest.fn(async () => ({
    kind: 'not-installed',
    installDir: '/x',
  })),
  startEngine: jest.fn(),
  stopEngine: jest.fn(),
  onEngineStatusChanged: jest.fn(() => () => {}),
}));

describe('MachinePage — Browser tasks in a session row', () => {
  it('names TypeSafe, the condition it leaves under, and that typed values still come from the Claude subscription', async () => {
    render(<MachinePage />);
    expect(
      await screen.findByText('Browser tasks in a session'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /To TypeSafe: the page's text and controls, only while a session runs a browser task/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/your own Claude subscription, like every other prompt/),
    ).toBeInTheDocument();
  });
});
