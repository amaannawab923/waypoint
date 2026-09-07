/**
 * The one place the "you're about to archive a project" message is
 * authored, shared by both places a project can be archived — the card's
 * icon button on All Projects (ProjectsList.tsx) and the settings page's
 * own button (project-settings/General.tsx).
 *
 * Found in review: before this, each site had its own independently
 * hand-written confirm() string, and they'd drifted into three different
 * phrasings of the same fact across two files (one omitted All Projects
 * from what disappears, one omitted search, and the two named the
 * destination differently — "Archive in the sidebar" vs "the Archive
 * page"). One function, reused at both call sites, is what makes that kind
 * of drift impossible to reintroduce one edit at a time.
 */
export function archiveConfirmMessage(projectName: string): string {
  return (
    `Archive "${projectName}"? It'll disappear from your sidebar, All ` +
    `Projects, and search — but it isn't deleted, and you can restore it ` +
    `any time from the Archive page.`
  );
}
