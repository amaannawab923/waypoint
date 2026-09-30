import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { getCurrentUser, updateCurrentUser } from '@/data/api';
import NotificationSettings from './Notifications';

jest.mock('@/data/api', () => ({
  getCurrentUser: jest.fn(),
  updateCurrentUser: jest.fn(),
}));

beforeEach(() => jest.clearAllMocks());

describe('Notification settings', () => {
  it('offers replies and assignments, both on by default, and saves one key at a time', async () => {
    jest.mocked(getCurrentUser).mockResolvedValue({ id: 'm1', notificationPrefs: null } as never);
    jest.mocked(updateCurrentUser).mockResolvedValue({} as never);
    render(<NotificationSettings />);
    await act(async () => {});
    for (const label of ['Notify on replies', 'Notify on assignments', 'Notify on comments']) {
      expect(screen.getByRole('switch', { name: label })).toHaveAttribute('aria-checked', 'true');
    }
    await act(async () => {
      fireEvent.click(screen.getByRole('switch', { name: 'Notify on replies' }));
    });
    expect(updateCurrentUser).toHaveBeenCalledWith({ notificationPrefs: { replies: false } });
  });
});
