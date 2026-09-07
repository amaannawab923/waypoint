import { archiveConfirmMessage } from './projectArchiveCopy';

// Found in review: ProjectsList.tsx's card button and
// project-settings/General.tsx's settings-page button each had their own
// independently hand-written confirm() string, and had drifted into three
// different phrasings of the same underlying fact across two files. This
// pins the one shared source of truth both now import, so a future edit to
// either call site can't silently reintroduce that drift.
describe('archiveConfirmMessage', () => {
  it('names the project and every surface it disappears from, and the one place it can be found again', () => {
    const message = archiveConfirmMessage('Compass Web');

    expect(message).toContain('Compass Web');
    expect(message).toMatch(/sidebar/i);
    expect(message).toMatch(/All Projects/);
    expect(message).toMatch(/search/i);
    expect(message).toMatch(/Archive page/);
    // Reversibility stated plainly, not just implied by "restore" — the
    // original incident this whole feature traces back to was a project
    // archived by mistake, so "this is not permanent" is worth saying
    // outright, not just showing a Restore button somewhere else later.
    expect(message).toMatch(/isn't deleted/i);
  });
});
