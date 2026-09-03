import { useMemo, useState } from 'react';
import { Check, ChevronDown, ListFilter, Plus, Search, Users } from 'lucide-react';
import { useAsync } from '@/lib/useAsync';
import { listMembers, inviteMember } from '@/data/api';
import type { Member } from '@/types/entities';
import { Button } from '@/components/ui/Button';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Avatar } from '@/components/ui/Avatar';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton, SkeletonTableRows } from '@/components/ui/Skeleton';
import { Popover } from '@/pages/work-items/Popover';

const ROLE_TONE: Record<Member['role'], BadgeTone> = {
  admin: 'accent',
  member: 'neutral',
  guest: 'neutral',
};

const ROLES: Member['role'][] = ['admin', 'member', 'guest'];

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function toggleInArray<T>(arr: T[], value: T): T[] {
  return arr.includes(value) ? arr.filter((v) => v !== value) : [...arr, value];
}

export default function Members() {
  const { data: members, loading, reload } = useAsync(() => listMembers(), []);
  const [inviting, setInviting] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Member['role']>('member');
  const [submitting, setSubmitting] = useState(false);
  const [query, setQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState<Member['role'][]>([]);

  async function handleInvite() {
    if (!email.trim() || submitting) return;
    setSubmitting(true);
    try {
      await inviteMember({ email: email.trim(), role });
      setEmail('');
      setRole('member');
      setInviting(false);
      reload();
    } finally {
      setSubmitting(false);
    }
  }

  const visibleMembers = useMemo(() => {
    if (!members) return [];
    const q = query.trim().toLowerCase();
    return members.filter((m) => {
      const matchesQuery =
        !q || m.fullName.toLowerCase().includes(q) || m.displayName.toLowerCase().includes(q) || m.email.toLowerCase().includes(q);
      const matchesRole = roleFilter.length === 0 || roleFilter.includes(m.role);
      return matchesQuery && matchesRole;
    });
  }, [members, query, roleFilter]);

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h2 className="font-display text-lg font-medium text-text">Members</h2>
          <p className="text-sm text-text-secondary">
            {members ? (
              `${members.length} member${members.length === 1 ? '' : 's'}`
            ) : (
              <Skeleton.Block height="1rem" width="4rem" />
            )}
          </p>
        </div>
        <Button variant="primary" onClick={() => setInviting((v) => !v)}>
          <Plus size={15} />
          Invite member
        </Button>
      </div>

      {inviting && (
        <div className="mb-5 flex flex-wrap items-end gap-2 rounded-[var(--radius-lg)] border border-border bg-surface-2 p-4">
          <div className="min-w-[220px] flex-1">
            <label className="mb-1.5 block text-sm font-medium text-text" htmlFor="invite-email">
              Email address
            </label>
            <input
              id="invite-email"
              autoFocus
              type="email"
              placeholder="teammate@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="h-9 w-full rounded-[var(--radius-sm)] border border-border-strong bg-bg px-3 text-sm outline-none focus:border-accent"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-text" htmlFor="invite-role">
              Role
            </label>
            <select
              id="invite-role"
              value={role}
              onChange={(e) => setRole(e.target.value as Member['role'])}
              className="h-9 w-32 rounded-[var(--radius-sm)] border border-border-strong bg-bg px-3 text-sm capitalize outline-none focus:border-accent"
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setInviting(false)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={!email.trim() || submitting} onClick={handleInvite}>
              {submitting ? 'Sending…' : 'Send invite'}
            </Button>
          </div>
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1 sm:max-w-xs">
          <Search size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-text-muted" />
          <input
            type="text"
            placeholder="Search members…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-8 w-full rounded-[var(--radius-sm)] border border-border-strong bg-surface pl-8 pr-3 text-sm outline-none focus:border-accent"
          />
        </div>

        <Popover
          align="start"
          trigger={({ open, toggle }) => (
            <Button variant={open ? 'secondary' : 'ghost'} size="sm" onClick={toggle}>
              <ListFilter size={14} />
              Filters
              {roleFilter.length > 0 && <Badge tone="accent">{roleFilter.length}</Badge>}
              <ChevronDown size={13} />
            </Button>
          )}
        >
          <div className="flex w-48 flex-col">
            <p className="mb-1 px-2 pt-1 text-xs font-medium tracking-wide text-text-muted uppercase">Role</p>
            {ROLES.map((r) => (
              <label
                key={r}
                className="flex cursor-pointer items-center justify-between gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-sm capitalize hover:bg-surface-2"
              >
                <span className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    className="accent-[var(--accent)]"
                    checked={roleFilter.includes(r)}
                    onChange={() => setRoleFilter((f) => toggleInArray(f, r))}
                  />
                  {r}
                </span>
                {roleFilter.includes(r) && <Check size={13} className="text-accent" />}
              </label>
            ))}
            {roleFilter.length > 0 && (
              <button
                type="button"
                onClick={() => setRoleFilter([])}
                className="mt-1 cursor-pointer self-start px-2 text-xs text-accent hover:underline"
              >
                Clear filters
              </button>
            )}
          </div>
        </Popover>
      </div>

      {loading && !members && (
        <div className="overflow-hidden rounded-[var(--radius-lg)] border border-border">
          <SkeletonTableRows columns={6} rows={4} />
        </div>
      )}

      {members && visibleMembers.length === 0 && (
        <EmptyState
          icon={<Users size={28} />}
          title="No members match"
          description="Try a different search term or clear the role filter."
        />
      )}

      {visibleMembers.length > 0 && (
        <div className="overflow-hidden rounded-[var(--radius-lg)] border border-border">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-2 text-left text-xs text-text-muted">
                <th className="px-4 py-2.5 font-medium">Name</th>
                <th className="px-4 py-2.5 font-medium">Display name</th>
                <th className="px-4 py-2.5 font-medium">Email</th>
                <th className="px-4 py-2.5 font-medium">Role</th>
                <th className="px-4 py-2.5 font-medium">Auth</th>
                <th className="px-4 py-2.5 font-medium">Joined</th>
              </tr>
            </thead>
            <tbody>
              {visibleMembers.map((m) => (
                <tr key={m.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2.5">
                      <Avatar name={m.fullName} color={m.avatarColor} size={22} />
                      <span className="text-text">{m.fullName}</span>
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-text-secondary">{m.displayName}</td>
                  <td className="px-4 py-2.5 text-text-secondary">{m.email}</td>
                  <td className="px-4 py-2.5">
                    <Badge tone={ROLE_TONE[m.role]} className="capitalize">
                      {m.role}
                    </Badge>
                  </td>
                  <td className="px-4 py-2.5 text-text-secondary capitalize">{m.authMethod}</td>
                  <td className="px-4 py-2.5 text-text-secondary">{formatDate(m.joinedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
