import { useMemo, useState } from 'react';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { Button, IconButton } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Modal } from '@/components/ui/Modal';
import { SkeletonTableRows } from '@/components/ui/Skeleton';
import { useAsync } from '@/lib/useAsync';
import { useProject } from '@/layouts/ProjectLayout';
import { addProjectMember, listMembers, removeProjectMember, updateProject } from '@/mock/api';
import { Plus, Search, Trash2, Users } from 'lucide-react';
import type { Member, MemberRole } from '@/types/entities';

const ROLE_LABEL: Record<MemberRole, string> = {
  admin: 'Admin',
  member: 'Member',
  guest: 'Guest',
};

const ROLES: MemberRole[] = ['admin', 'member', 'guest'];

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={
        'relative h-5 w-9 shrink-0 rounded-full transition-colors ' +
        (checked ? 'bg-accent' : 'bg-surface-2 border border-border-strong')
      }
    >
      <span
        className={
          'absolute top-0.5 size-4 rounded-full shadow transition-transform ' +
          (checked ? 'translate-x-[18px] bg-on-accent' : 'translate-x-0.5 bg-text-muted')
        }
      />
    </button>
  );
}

function AddMemberModal({
  open,
  onClose,
  projectId,
  candidates,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  candidates: Member[];
  onAdded: () => void;
}) {
  const [memberId, setMemberId] = useState('');
  const [role, setRole] = useState<MemberRole>('member');
  const [submitting, setSubmitting] = useState(false);

  const selected = memberId || candidates[0]?.id || '';

  async function handleAdd() {
    if (!selected || submitting) return;
    setSubmitting(true);
    try {
      await addProjectMember(projectId, selected, role);
      setMemberId('');
      setRole('member');
      onAdded();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add member"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" disabled={!selected || candidates.length === 0 || submitting} onClick={handleAdd}>
            {submitting ? 'Adding…' : 'Add member'}
          </Button>
        </>
      }
    >
      {candidates.length === 0 ? (
        <p className="text-sm text-text-secondary">Every workspace member is already on this project.</p>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-text">Member</label>
            <select
              autoFocus
              value={selected}
              onChange={(e) => setMemberId(e.target.value)}
              className="h-9 w-full rounded-[var(--radius-sm)] border border-border-strong bg-bg px-3 text-sm outline-none focus:border-accent"
            >
              {candidates.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.fullName} ({m.email})
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-text">Role</label>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as MemberRole)}
              className="h-9 w-full rounded-[var(--radius-sm)] border border-border-strong bg-bg px-3 text-sm capitalize outline-none focus:border-accent"
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}
    </Modal>
  );
}

function MemberPicker({
  label,
  members,
  value,
  onChange,
  allowUnset,
  unsetLabel,
}: {
  label: string;
  members: Member[];
  value: string | null;
  onChange: (id: string | null) => void;
  allowUnset?: boolean;
  unsetLabel?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-sm font-medium text-text">{label}</label>
      <select
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
        className="h-9 w-full rounded-[var(--radius-sm)] border border-border-strong bg-bg px-3 text-sm outline-none focus:border-accent"
      >
        {allowUnset && <option value="">{unsetLabel ?? 'None'}</option>}
        {members.map((m) => (
          <option key={m.id} value={m.id}>
            {m.fullName}
          </option>
        ))}
      </select>
    </div>
  );
}

export default function Members() {
  const { project, reloadProject } = useProject();
  const { data: members, loading, reload } = useAsync(() => listMembers(), []);
  const [search, setSearch] = useState('');
  const [savingLead, setSavingLead] = useState(false);
  const [savingAssignee, setSavingAssignee] = useState(false);
  const [savingGuestAccess, setSavingGuestAccess] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const projectMembers = (members ?? []).filter((m) => project.memberIds.includes(m.id));
  const availableMembers = (members ?? []).filter((m) => !project.memberIds.includes(m.id));

  const filteredMembers = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return projectMembers;
    return projectMembers.filter(
      (m) => m.fullName.toLowerCase().includes(q) || m.email.toLowerCase().includes(q) || m.displayName.toLowerCase().includes(q),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, members, project.memberIds]);

  async function handleLeadChange(id: string | null) {
    if (savingLead) return;
    setSavingLead(true);
    try {
      await updateProject(project.id, { leadId: id });
      reloadProject();
    } finally {
      setSavingLead(false);
    }
  }

  async function handleAssigneeChange(id: string | null) {
    if (savingAssignee) return;
    setSavingAssignee(true);
    try {
      await updateProject(project.id, { defaultAssigneeId: id });
      reloadProject();
    } finally {
      setSavingAssignee(false);
    }
  }

  async function handleGuestAccessChange(next: boolean) {
    if (savingGuestAccess) return;
    setSavingGuestAccess(true);
    try {
      await updateProject(project.id, { guestAccessEnabled: next });
      reloadProject();
    } finally {
      setSavingGuestAccess(false);
    }
  }

  async function handleRemove(id: string) {
    if (removingId) return;
    setRemovingId(id);
    try {
      await removeProjectMember(project.id, id);
      reloadProject();
      reload();
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-8 py-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-lg font-medium text-text">Members</h1>
          <p className="mt-1 text-sm text-text-secondary">
            {project.memberIds.length} member{project.memberIds.length === 1 ? '' : 's'} in this project.
          </p>
        </div>
        <Button variant="primary" size="sm" onClick={() => setAddOpen(true)}>
          <Plus size={14} />
          Add member
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <MemberPicker
          label="Project Lead"
          members={projectMembers}
          value={project.leadId}
          onChange={handleLeadChange}
          allowUnset
          unsetLabel="No lead"
        />
        <MemberPicker
          label="Default Assignee"
          members={projectMembers}
          value={project.defaultAssigneeId}
          onChange={handleAssigneeChange}
          allowUnset
          unsetLabel="Unassigned"
        />
      </div>

      <div className="flex items-center justify-between rounded-[var(--radius)] border border-border-strong px-4 py-3">
        <div>
          <p className="text-sm font-medium text-text">Guest access</p>
          <p className="mt-0.5 text-sm text-text-secondary">Allow guests to view and interact with this project.</p>
        </div>
        <Toggle checked={project.guestAccessEnabled ?? false} onChange={handleGuestAccessChange} />
      </div>

      <AddMemberModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        projectId={project.id}
        candidates={availableMembers}
        onAdded={() => {
          setAddOpen(false);
          reloadProject();
          reload();
        }}
      />

      <div className="relative">
        <Search size={14} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-text-muted" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name or email"
          className="h-9 w-full rounded-[var(--radius-sm)] border border-border-strong bg-bg pr-3 pl-8 text-sm outline-none focus:border-accent"
        />
      </div>

      {loading && !members ? (
        <div className="overflow-hidden rounded-[var(--radius)] border border-border">
          <SkeletonTableRows columns={6} rows={4} />
        </div>
      ) : projectMembers.length === 0 ? (
        <EmptyState icon={<Users size={28} />} title="No members" description="This project has no members yet." />
      ) : filteredMembers.length === 0 ? (
        <EmptyState icon={<Search size={28} />} title="No matches" description="No members match your search." />
      ) : (
        <div className="overflow-hidden rounded-[var(--radius)] border border-border">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-2 text-xs text-text-muted uppercase">
                <th className="px-4 py-2 font-medium">Name</th>
                <th className="px-4 py-2 font-medium">Display name</th>
                <th className="px-4 py-2 font-medium">Email</th>
                <th className="px-4 py-2 font-medium">Role</th>
                <th className="px-4 py-2 font-medium">Joined</th>
                <th className="px-4 py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {filteredMembers.map((member) => (
                <tr key={member.id} className="group border-b border-border last:border-b-0">
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <Avatar name={member.fullName} color={member.avatarColor} size={24} />
                      <span className="text-text">{member.fullName}</span>
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-text-secondary">{member.displayName}</td>
                  <td className="px-4 py-2.5 text-text-secondary">{member.email}</td>
                  <td className="px-4 py-2.5">
                    <Badge tone={member.role === 'admin' ? 'accent' : 'neutral'}>{ROLE_LABEL[member.role]}</Badge>
                  </td>
                  <td className="px-4 py-2.5 text-text-secondary">{formatDate(member.joinedAt)}</td>
                  <td className="px-4 py-2.5 text-right">
                    <IconButton
                      label="Remove member"
                      className="opacity-0 group-hover:opacity-100"
                      disabled={removingId === member.id}
                      onClick={() => handleRemove(member.id)}
                    >
                      <Trash2 size={13} />
                    </IconButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
