import type { ReactNode } from 'react';
import { Modal } from '@/components/ui/Modal';

/** A single key cap, e.g. <Key>⌘</Key><Key>K</Key> — same visual role as
 * the mockup's `.kbd` span (docs/design/waypoint-revamp-mockup.html), just
 * built from this app's own tokens rather than the mockup's own CSS. */
function Key({ children }: { children: ReactNode }) {
  return (
    <span className="flex h-5 min-w-5 items-center justify-center rounded-[var(--radius-sm)] border border-border-strong bg-surface-2 px-1 font-mono text-[10.5px] text-text-secondary">
      {children}
    </span>
  );
}

function Row({ label, keys }: { label: string; keys: ReactNode[] }) {
  return (
    <div className="flex items-center gap-2 py-0.5 text-[12.5px] text-text-secondary">
      <span>{label}</span>
      <span className="ml-auto flex gap-1">
        {keys.map((k, i) => (
          <Key key={i}>{k}</Key>
        ))}
      </span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mb-3.5 last:mb-0">
      <p className="mb-1 text-[10.5px] font-bold tracking-wider text-text-muted uppercase">
        {title}
      </p>
      {children}
    </div>
  );
}

/**
 * `?` (or the topbar's keyboard icon) — the real, current keybinding set
 * this app implements (useGlobalKeyboardShortcuts.ts, plus TicketList.tsx's
 * and ReviewPage.tsx's own local `j`/`k`/`x`/`e`/`r`), not the mockup's
 * fictional ones where they don't apply. Two differences from the mockup's
 * own cheatsheet (docs/design/waypoint-revamp-mockup.html's `ksBackdrop`):
 * "This machine" (`g` `l`) is omitted — this app has no equivalent screen
 * yet — and "Docs"/"Sprints" are added, since this app's `g`-nav supports
 * them even though the mockup's own visual cheatsheet never listed them
 * (its underlying JS map did).
 */
export function KeyboardShortcutsModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Modal open={open} onClose={onClose} title="Keyboard shortcuts" width={560}>
      <div className="grid grid-cols-2 gap-x-7">
        <div>
          <Section title="Go to">
            <Row label="Home" keys={['g', 'h']} />
            <Row label="Review" keys={['g', 'r']} />
            <Row label="Tickets" keys={['g', 't']} />
            <Row label="My work" keys={['g', 'm']} />
            <Row label="All tickets" keys={['g', 'a']} />
            <Row label="Docs" keys={['g', 'd']} />
            <Row label="Sprints" keys={['g', 's']} />
          </Section>
          <p className="text-[11px] leading-snug text-text-muted">
            Docs and Sprints only navigate while a project is open.
          </p>
        </div>
        <div>
          <Section title="Lists">
            <Row label="Move down / up" keys={['j', 'k']} />
            <Row label="Open" keys={['↵']} />
            <Row label="Select" keys={['x']} />
            <Row label="Select all visible" keys={['⌘', 'A']} />
          </Section>
          <Section title="Review queue">
            <Row label="Approve selected" keys={['e']} />
            <Row label="Reject selected" keys={['r']} />
          </Section>
          <Section title="Global">
            <Row label="Search" keys={['⌘', 'K']} />
            <Row label="Copilot" keys={['⌘', 'J']} />
            <Row label="This help" keys={['?']} />
            <Row label="Close / clear" keys={['esc']} />
          </Section>
        </div>
      </div>
    </Modal>
  );
}
