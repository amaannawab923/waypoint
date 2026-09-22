import '@testing-library/jest-dom';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { BranchPicker, filterBranches, isMachineBranch } from './BranchPicker';

const BRANCHES = [
  'main',
  'develop',
  'feat/road-61-list',
  'agent/PL-10',
  'agent/PL-10-qtp55qy',
  'session/cpuvkem',
  'release/2.1',
];

describe('filterBranches', () => {
  it('hides the branches Waypoint creates unless asked, and matches a substring', () => {
    expect(filterBranches(BRANCHES, '', false)).toEqual([
      'main',
      'develop',
      'feat/road-61-list',
      'release/2.1',
    ]);
    expect(filterBranches(BRANCHES, '', true)).toEqual(BRANCHES);
    expect(filterBranches(BRANCHES, 'PL-10', true)).toEqual([
      'agent/PL-10',
      'agent/PL-10-qtp55qy',
    ]);
    expect(filterBranches(BRANCHES, 'PL-10', false)).toEqual([]);
    expect(filterBranches(BRANCHES, 'REL', false)).toEqual(['release/2.1']);
  });

  it('names exactly the prefixes worktrees.ts generates', () => {
    expect(isMachineBranch('agent/ENG-4')).toBe(true);
    expect(isMachineBranch('session/x')).toBe(true);
    expect(isMachineBranch('agents/x')).toBe(false);
    expect(isMachineBranch('my-agent/x')).toBe(false);
  });
});

describe('BranchPicker', () => {
  it('opens a searchable list with the litter folded away, and picks on click', () => {
    const onChange = jest.fn();
    render(
      <BranchPicker branches={BRANCHES} value="main" onChange={onChange} />,
    );
    const trigger = screen.getByRole('combobox', { name: 'Base branch' });
    expect(trigger).toHaveTextContent('main');
    fireEvent.click(trigger);

    const list = screen.getByRole('listbox', { name: 'Base branch' });
    expect(
      within(list)
        .getAllByRole('option')
        .map((o) => o.textContent?.replace('current', '').trim()),
    ).toEqual(['main', 'develop', 'feat/road-61-list', 'release/2.1']);
    expect(
      screen.getByLabelText(
        /Show all branches \(includes 3 Waypoint-created branches\)/,
      ),
    ).not.toBeChecked();

    fireEvent.change(screen.getByLabelText('Search branches'), {
      target: { value: 'rel' },
    });
    expect(within(list).getAllByRole('option')).toHaveLength(1);
    fireEvent.click(within(list).getByRole('option', { name: /release/ }));
    expect(onChange).toHaveBeenCalledWith('release/2.1');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('Show all reveals the Waypoint-created branches; Enter picks the highlighted one', () => {
    const onChange = jest.fn();
    render(
      <BranchPicker branches={BRANCHES} value="main" onChange={onChange} />,
    );
    fireEvent.click(screen.getByRole('combobox', { name: 'Base branch' }));
    fireEvent.click(screen.getByLabelText(/Show all branches/));
    const list = screen.getByRole('listbox', { name: 'Base branch' });
    expect(within(list).getAllByRole('option')).toHaveLength(BRANCHES.length);

    const search = screen.getByLabelText('Search branches');
    fireEvent.change(search, { target: { value: 'agent/' } });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('agent/PL-10-qtp55qy');
  });

  it('is a disabled field while the caller says so', () => {
    render(
      <BranchPicker
        branches={BRANCHES}
        value=""
        onChange={jest.fn()}
        disabled
      />,
    );
    const trigger = screen.getByRole('combobox', { name: 'Base branch' });
    expect(trigger).toBeDisabled();
    expect(trigger).toHaveTextContent('—');
  });
});
