import { useNavigate } from 'react-router-dom';
import { Bot, Plus, Trash2 } from 'lucide-react';
import { useAsync } from '@/lib/useAsync';
import { deleteAgent, detectLocalClaudeCode, listAgents } from '@/mock/api';
import { Badge } from '@/components/ui/Badge';
import { Button, IconButton } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { SkeletonListRows } from '@/components/ui/Skeleton';
import { Avatar } from '@/components/ui/Avatar';
import { StatusBadge } from '@/components/ui/StatusBadge';

export default function Agents() {
  const { data: agents, loading, reload } = useAsync(() => listAgents(), []);
  const { data: detection } = useAsync(() => detectLocalClaudeCode(), []);
  const navigate = useNavigate();

  async function handleDelete(id: string, name: string) {
    if (!window.confirm(`Delete "${name}"? This can't be undone.`)) return;
    await deleteAgent(id);
    reload();
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h2 className="font-display text-lg font-medium text-text">Agents</h2>
          <p className="text-sm text-text-secondary">
            Agents you've defined — each with its own instructions file, project scope, and the
            local subscription it runs on.
          </p>
        </div>
        <Button variant="primary" onClick={() => navigate('/settings/agents/new')}>
          <Plus size={15} />
          Create agent
        </Button>
      </div>

      {loading && !agents && <SkeletonListRows rows={4} />}

      {agents && agents.length === 0 && (
        <EmptyState
          icon={<Bot size={28} />}
          title="No agents yet"
          description="Create one to give it its own instructions, scope, and execution method."
          action={
            <Button variant="primary" onClick={() => navigate('/settings/agents/new')}>
              <Plus size={15} />
              Create agent
            </Button>
          }
        />
      )}

      {agents && agents.length > 0 && (
        <div className="flex flex-col gap-3">
          {agents.map((agent) => {
            const claudeCliAbsent =
              agent.executionMethod === 'local-claude-subscription' && detection?.state === 'absent';
            return (
              <button
                key={agent.id}
                type="button"
                onClick={() => navigate(`/settings/agents/${agent.id}`)}
                className="flex w-full items-center gap-3 rounded-[var(--radius-lg)] border border-border bg-surface p-3 text-left hover:border-border-strong"
              >
                <Avatar name={agent.name} color={agent.avatarColor} shape="square" size={32} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium text-text">{agent.name}</span>
                    <Badge tone="info">{agent.model}</Badge>
                    {claudeCliAbsent && detection && (
                      <StatusBadge probe={detection} />
                    )}
                  </div>
                  <p className="mt-0.5 truncate text-xs text-text-muted">
                    {agent.instructionsFile.filename} ·{' '}
                    {agent.scopeAllProjects ? 'All projects' : `${agent.scopeProjectIds.length} project(s)`}
                  </p>
                </div>
                <IconButton
                  label={`Delete ${agent.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDelete(agent.id, agent.name);
                  }}
                >
                  <Trash2 size={14} />
                </IconButton>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
