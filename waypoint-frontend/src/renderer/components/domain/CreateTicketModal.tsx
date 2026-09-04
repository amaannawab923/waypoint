import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Tag, UserPlus } from 'lucide-react';
import { IconCheck, IconChevron } from '@/components/icons';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Avatar, AvatarStack } from '@/components/ui/Avatar';
import { Dot } from '@/components/ui/Badge';
import { PRIORITY_LABEL, PRIORITY_ORDER, PriorityIcon } from '@/components/domain/PriorityIcon';
import { StateIcon } from '@/components/domain/StateIcon';
import { createTicket, ensureAgentAssignments, listAgents, listLabels, listMembers, listStates } from '@/data/api';
import { useAsync } from '@/lib/useAsync';
import { agentLabel } from '@/lib/agentLabel';
import type { Priority, Ticket } from '@/types/entities';

const CHIP_CLASS =
  'flex h-8 items-center gap-1.5 rounded-[var(--radius-sm)] border border-border-strong bg-bg px-2.5 text-sm text-text outline-none hover:bg-surface-2';
const PANEL_CLASS =
  'thin-scroll max-h-64 w-56 overflow-y-auto rounded-[var(--radius-sm)] border border-border bg-surface p-1 shadow-lg';
const OPTION_CLASS =
  'flex w-full items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-left text-sm text-text hover:bg-surface-2';

/** Small self-contained popover, mirrors the pattern in TicketDetailPage/WorkstreamDetailPage — there's
 * no shared Dropdown/Menu primitive in src/components/ui/ yet. */
function Dropdown({
  trigger,
  children,
}: {
  trigger: (toggle: () => void) => ReactNode;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      // Capture phase + stopPropagation so this fires and consumes Escape
      // before the parent Modal's bubble-phase listener sees it — otherwise
      // Escape closes the whole modal (losing in-progress title/description)
      // instead of just this dropdown.
      e.stopPropagation();
      setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      {trigger(() => setOpen((o) => !o))}
      {open && <div className="absolute left-0 z-30 mt-1">{children(() => setOpen(false))}</div>}
    </div>
  );
}

export function CreateTicketModal({
  open,
  onClose,
  projectId,
  defaultStateId,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  defaultStateId?: string;
  onCreated: (item: Ticket) => void;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [stateId, setStateId] = useState<string | undefined>(undefined);
  const [priority, setPriority] = useState<Priority>('none');
  const [assigneeIds, setAssigneeIds] = useState<string[]>([]);
  const [labelIds, setLabelIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const { data: states } = useAsync(() => listStates(projectId), [projectId]);
  const { data: members } = useAsync(() => listMembers(), []);
  const { data: agents } = useAsync(() => listAgents(), []);
  const { data: labels } = useAsync(() => listLabels(projectId), [projectId]);
  const scopedAgents = (agents ?? []).filter(
    (a) => a.isActive && (a.scopeProjectIds.length === 0 || a.scopeProjectIds.includes(projectId)),
  );

  // `stateId` is undefined until the user picks one explicitly, so the default keeps tracking
  // `defaultStateId` (which can change between opens, e.g. a per-board-column "+" button) and
  // falls back to the project's first unstarted state once it loads.
  const resolvedStateId = stateId ?? defaultStateId ?? states?.find((s) => s.group === 'unstarted')?.id ?? states?.[0]?.id;
  const currentState = states?.find((s) => s.id === resolvedStateId);
  const selectedActors = [
    ...(members ?? [])
      .filter((m) => assigneeIds.includes(m.id))
      .map((m) => ({ name: m.displayName, color: m.avatarColor, shape: 'circle' as const })),
    ...scopedAgents
      .filter((a) => assigneeIds.includes(a.id))
      .map((a) => ({ name: a.name, color: a.avatarColor, shape: 'square' as const })),
  ];
  const selectedLabels = (labels ?? []).filter((l) => labelIds.includes(l.id));

  function reset() {
    setTitle('');
    setDescription('');
    setStateId(undefined);
    setPriority('none');
    setAssigneeIds([]);
    setLabelIds([]);
  }

  function toggleAssignee(memberId: string) {
    setAssigneeIds((prev) => (prev.includes(memberId) ? prev.filter((id) => id !== memberId) : [...prev, memberId]));
  }

  function toggleLabel(labelId: string) {
    setLabelIds((prev) => (prev.includes(labelId) ? prev.filter((id) => id !== labelId) : [...prev, labelId]));
  }

  async function handleSubmit() {
    if (!title.trim() || !resolvedStateId || submitting) return;
    setSubmitting(true);
    try {
      const item = await createTicket({
        projectId,
        title: title.trim(),
        description: description.trim(),
        stateId: resolvedStateId,
        priority,
        assigneeIds,
        labelIds,
      });
      const agentIds = assigneeIds.filter((id) => scopedAgents.some((a) => a.id === id));
      if (agentIds.length > 0) await ensureAgentAssignments(item.id, agentIds);
      reset();
      onClose();
      onCreated(item);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title="New ticket"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!title.trim() || submitting} onClick={handleSubmit}>
            {submitting ? 'Creating…' : 'Create ticket'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <input
          autoFocus
          placeholder="Ticket title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) handleSubmit();
          }}
          className="h-9 rounded-[var(--radius-sm)] border border-border-strong bg-bg px-3 text-sm outline-none focus:border-accent"
        />
        <textarea
          placeholder="Description (optional)"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={4}
          className="resize-none rounded-[var(--radius-sm)] border border-border-strong bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
        />

        <div className="flex flex-wrap items-center gap-2">
          <Dropdown
            trigger={(toggle) => (
              <button type="button" onClick={toggle} className={CHIP_CLASS}>
                {currentState && <StateIcon state={currentState} />}
                <span className="truncate">{currentState?.name ?? 'State'}</span>
                <IconChevron size={13} className="shrink-0 text-text-muted" />
              </button>
            )}
          >
            {(close) => (
              <div className={PANEL_CLASS}>
                {(states ?? []).length === 0 && <p className="px-2 py-1.5 text-xs text-text-muted">No states.</p>}
                {(states ?? []).map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => {
                      setStateId(s.id);
                      close();
                    }}
                    className={OPTION_CLASS}
                  >
                    <StateIcon state={s} />
                    <span className="truncate">{s.name}</span>
                    {s.id === resolvedStateId && <IconCheck size={14} className="ml-auto shrink-0 text-accent" />}
                  </button>
                ))}
              </div>
            )}
          </Dropdown>

          <Dropdown
            trigger={(toggle) => (
              <button type="button" onClick={toggle} className={CHIP_CLASS}>
                <PriorityIcon priority={priority} />
                <span className="truncate">{PRIORITY_LABEL[priority]}</span>
                <IconChevron size={13} className="shrink-0 text-text-muted" />
              </button>
            )}
          >
            {(close) => (
              <div className={PANEL_CLASS}>
                {PRIORITY_ORDER.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => {
                      setPriority(p);
                      close();
                    }}
                    className={OPTION_CLASS}
                  >
                    <PriorityIcon priority={p} />
                    <span className="truncate">{PRIORITY_LABEL[p]}</span>
                    {p === priority && <IconCheck size={14} className="ml-auto shrink-0 text-accent" />}
                  </button>
                ))}
              </div>
            )}
          </Dropdown>

          <Dropdown
            trigger={(toggle) => (
              <button type="button" onClick={toggle} className={CHIP_CLASS}>
                {selectedActors.length > 0 ? (
                  <AvatarStack people={selectedActors} size={18} />
                ) : (
                  <span className="flex items-center gap-1.5 text-text-muted">
                    <UserPlus size={14} /> Assignees
                  </span>
                )}
                <IconChevron size={13} className="shrink-0 text-text-muted" />
              </button>
            )}
          >
            {() => (
              <div className={PANEL_CLASS}>
                {(members ?? []).length === 0 && <p className="px-2 py-1.5 text-xs text-text-muted">No members.</p>}
                {(members ?? []).map((m) => {
                  const checked = assigneeIds.includes(m.id);
                  return (
                    <button key={m.id} type="button" onClick={() => toggleAssignee(m.id)} className={OPTION_CLASS}>
                      <Avatar name={m.displayName} color={m.avatarColor} size={20} />
                      <span className="truncate">{m.displayName}</span>
                      {checked && <IconCheck size={14} className="ml-auto shrink-0 text-accent" />}
                    </button>
                  );
                })}
                {scopedAgents.length > 0 && (
                  <>
                    <div className="my-1 h-px bg-border" />
                    <p className="px-2 py-1 font-mono text-[10px] tracking-wide text-text-muted uppercase">Agents</p>
                    {scopedAgents.map((a) => {
                      const checked = assigneeIds.includes(a.id);
                      return (
                        <button key={a.id} type="button" onClick={() => toggleAssignee(a.id)} className={OPTION_CLASS}>
                          <Avatar name={a.name} color={a.avatarColor} shape="square" size={20} />
                          <span className="truncate">
                            {agentLabel(a.name)} <span className="text-text-muted">— {a.model}</span>
                          </span>
                          {checked && <IconCheck size={14} className="ml-auto shrink-0 text-accent" />}
                        </button>
                      );
                    })}
                  </>
                )}
              </div>
            )}
          </Dropdown>

          <Dropdown
            trigger={(toggle) => (
              <button type="button" onClick={toggle} className={CHIP_CLASS}>
                {selectedLabels.length > 0 ? (
                  <span className="flex items-center gap-1.5">
                    {selectedLabels.slice(0, 3).map((l) => (
                      <Dot key={l.id} color={l.color} />
                    ))}
                    <span className="truncate">
                      {selectedLabels.length === 1 ? selectedLabels[0].name : `${selectedLabels.length} labels`}
                    </span>
                  </span>
                ) : (
                  <span className="flex items-center gap-1.5 text-text-muted">
                    <Tag size={14} /> Labels
                  </span>
                )}
                <IconChevron size={13} className="shrink-0 text-text-muted" />
              </button>
            )}
          >
            {() => (
              <div className={PANEL_CLASS}>
                {(labels ?? []).length === 0 && (
                  <p className="px-2 py-1.5 text-xs text-text-muted">No labels in this project.</p>
                )}
                {(labels ?? []).map((l) => {
                  const checked = labelIds.includes(l.id);
                  return (
                    <button key={l.id} type="button" onClick={() => toggleLabel(l.id)} className={OPTION_CLASS}>
                      <Dot color={l.color} />
                      <span className="truncate">{l.name}</span>
                      {checked && <IconCheck size={14} className="ml-auto shrink-0 text-accent" />}
                    </button>
                  );
                })}
              </div>
            )}
          </Dropdown>
        </div>
      </div>
    </Modal>
  );
}
