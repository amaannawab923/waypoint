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
  it('names TypeSafe, the condition it leaves under, and what actually reaches the Claude subscription per field', async () => {
    render(<MachinePage />);
    expect(
      await screen.findByText('Browser tasks in a session'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /To TypeSafe: the page's text and controls, only while a session runs a browser task/,
      ),
    ).toBeInTheDocument();
    // F22 (tech-lead review, 2026-09-22): the old copy ("the typed values
    // still come from your own Claude subscription, like every other
    // prompt") undersold this leg — it reads as "just the value", when
    // jev_ultrafast/model.py's field_context sends the goal, the field,
    // the page's title, up to 6,000 characters of its text, and the last
    // six actions to that subscription for every field filled.
    expect(
      screen.getByText(
        /the goal, the field, the page's title and up to 6,000 characters of its text, and the session's last six actions/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/not just the value it types back/),
    ).toBeInTheDocument();
  });
});
