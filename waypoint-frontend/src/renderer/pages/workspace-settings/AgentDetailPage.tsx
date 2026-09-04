import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { clsx } from 'clsx';
import { ArrowLeft, Trash2 } from 'lucide-react';
import { IconCheck } from '@/components/icons';
import { useAsync } from '@/lib/useAsync';
import { createAgent, deleteAgent, detectLocalClaudeCode, getAgent, listProjects, updateAgent } from '@/data/api';
import type { Agent, AgentAutonomy, AgentTrigger } from '@/types/entities';
import { Button, IconButton } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Avatar } from '@/components/ui/Avatar';
import { renderMarkdown } from '@/lib/markdown';
import { ClaudeCodeStatus } from '@/components/domain/ClaudeCodeStatus';
import {
  AGENT_TEMPLATES,
  CLAUDE_MODELS,
  EXECUTION_METHODS,
  slugifyFilename,
  type AgentTemplate,
} from '@/components/domain/agentTemplates';

type SaveStatus = 'idle' | 'saving' | 'saved';

const AUTONOMY_OPTIONS: { value: AgentAutonomy; label: string; hint: string }[] = [
  { value: 'plan-only', label: 'Plan only', hint: 'Writes a plan, never touches code.' },
  { value: 'ask-before-write', label: 'Ask before write', hint: 'Pauses before making any file change.' },
  { value: 'ask-before-pr', label: 'Ask before PR', hint: 'Writes freely, pauses before opening a PR.' },
  { value: 'full-auto', label: 'Full auto', hint: 'Commits, opens PRs, and merges without asking.' },
];

const TRIGGER_OPTIONS: { value: AgentTrigger; label: string }[] = [
  { value: 'on-assign', label: 'When assigned to a ticket' },
  { value: 'on-comment-mention', label: 'When @mentioned in a comment' },
  { value: 'on-label', label: 'When a specific label is added' },
];

const AVATAR_COLORS = ['#4f5cdb', '#3a3a3a', '#e0a233', '#7a5cd6', '#2f7a4f', '#c2542a', '#2f6fa8'];

const INPUT_CLASS =
  'h-9 w-full rounded-[var(--radius-sm)] border border-border-strong bg-bg px-3 text-sm text-text outline-none focus:border-accent';

const labelClass = 'mb-1.5 block text-sm font-medium text-text';

export default function AgentDetailPage() {
  const { agentId } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const returnTo = searchParams.get('returnTo');

  const { data: existing, loading: existingLoading } = useAsync(
    () => (agentId ? getAgent(agentId) : Promise.resolve(undefined)),
    [agentId],
  );
  const { data: projects } = useAsync(() => listProjects(), []);
  const { data: detection } = useAsync(() => detectLocalClaudeCode(), []);

  const [persistedId, setPersistedId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [avatarColor, setAvatarColor] = useState(AVATAR_COLORS[0]);
  const [filename, setFilename] = useState('agent.md');
  const [filenameTouched, setFilenameTouched] = useState(false);
  const [contentMarkdown, setContentMarkdown] = useState('');
  const [mdTab, setMdTab] = useState<'raw' | 'preview'>('raw');
  const [scopeAllProjects, setScopeAllProjects] = useState(true);
  const [scopeProjectIds, setScopeProjectIds] = useState<string[]>([]);
  const [model, setModel] = useState(CLAUDE_MODELS[1]);
  const [autonomy, setAutonomy] = useState<AgentAutonomy>('ask-before-pr');
  const [triggers, setTriggers] = useState<AgentTrigger[]>(['on-assign']);
  const [templateId, setTemplateId] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState<SaveStatus>('idle');
  const [submitting, setSubmitting] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPatchRef = useRef<Partial<Agent>>({});
  const loadedRef = useRef<string | null>(null);
  const preselectedScopeRef = useRef(false);

  useEffect(() => {
    if (!existing) return;
    if (loadedRef.current === existing.id) return;
    loadedRef.current = existing.id;
    setPersistedId(existing.id);
    setName(existing.name);
    setAvatarColor(existing.avatarColor);
    setFilename(existing.instructionsFile.filename);
    setFilenameTouched(true);
    setContentMarkdown(existing.instructionsFile.contentMarkdown);
    setScopeAllProjects(existing.scopeAllProjects);
    setScopeProjectIds(existing.scopeProjectIds);
    setModel(existing.model);
    setAutonomy(existing.autonomy);
    setTriggers(existing.triggers);
    setTemplateId(existing.templateId);
    setStatus('idle');
  }, [existing]);

  // Pre-select a single project when this page was launched from inside a
  // ticket's project context (the "+ Create new agent" entry point in the
  // Assignees dropdown) — never defaults to "all," matching the scope step
  // always being an explicit choice.
  useEffect(() => {
    if (agentId || preselectedScopeRef.current || !projects) return;
    const fromProject = searchParams.get('projectId');
    if (fromProject && projects.some((p) => p.id === fromProject)) {
      preselectedScopeRef.current = true;
      setScopeAllProjects(false);
      setScopeProjectIds([fromProject]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, agentId]);

  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  function scheduleSave(patch: Partial<Agent>) {
    if (!persistedId) return; // nothing to autosave into until the first Create
    Object.assign(pendingPatchRef.current, patch);
    setStatus('saving');
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      const toSave = pendingPatchRef.current;
      pendingPatchRef.current = {};
      await updateAgent(persistedId, toSave);
      setStatus('saved');
    }, 800);
  }

  // Deliberately doesn't prefill `name` from the template — a template is
  // scaffolding for the job (instructions, autonomy, model), not an
  // identity. Naming the agent is the user's own choice, same as naming a
  // new teammate — the placeholder below nudges toward a human name rather
  // than a job title.
  function applyTemplate(template: AgentTemplate) {
    setTemplateId(template.id);
    if (!filenameTouched) setFilename(slugifyFilename(template.filenameHint));
    setContentMarkdown(template.contentMarkdown);
    setAutonomy(template.autonomy);
    setModel(template.model);
  }

  function handleNameChange(next: string) {
    setName(next);
    if (!filenameTouched) setFilename(slugifyFilename(next));
    scheduleSave({ name: next });
  }

  function handleFilenameChange(raw: string) {
    setFilenameTouched(true);
    setFilename(raw);
  }

  function handleFilenameBlur() {
    const normalized = filename.trim().endsWith('.md') ? filename.trim() : slugifyFilename(filename);
    setFilename(normalized);
    scheduleSave({ instructionsFile: { filename: normalized, contentMarkdown } });
  }

  function handleContentChange(next: string) {
    setContentMarkdown(next);
    scheduleSave({ instructionsFile: { filename, contentMarkdown: next } });
  }

  function toggleScopeProject(id: string) {
    const next = scopeProjectIds.includes(id) ? scopeProjectIds.filter((x) => x !== id) : [...scopeProjectIds, id];
    setScopeProjectIds(next);
    scheduleSave({ scopeProjectIds: next });
  }

  function handleScopeAllChange(next: boolean) {
    setScopeAllProjects(next);
    scheduleSave({ scopeAllProjects: next });
  }

  function handleModelChange(next: string) {
    setModel(next);
    scheduleSave({ model: next });
  }

  function handleAutonomyChange(next: AgentAutonomy) {
    setAutonomy(next);
    scheduleSave({ autonomy: next });
  }

  function toggleTrigger(value: AgentTrigger) {
    const next = triggers.includes(value) ? triggers.filter((t) => t !== value) : [...triggers, value];
    setTriggers(next);
    scheduleSave({ triggers: next });
  }

  const minimallyValid =
    name.trim().length > 0 && filename.trim().length > 0 && (scopeAllProjects || scopeProjectIds.length > 0);

  async function handleCreate() {
    if (!minimallyValid || submitting) return;
    setSubmitting(true);
    try {
      const agent = await createAgent({
        name: name.trim(),
        avatarColor,
        instructionsFile: { filename: filename.trim(), contentMarkdown },
        scopeAllProjects,
        scopeProjectIds: scopeAllProjects ? [] : scopeProjectIds,
        executionMethod: 'local-claude-subscription',
        model,
        autonomy,
        triggers,
        templateId,
      });
      setPersistedId(agent.id);
      setStatus('saved');
      if (returnTo) {
        navigate(`${returnTo}${returnTo.includes('?') ? '&' : '?'}newAgentId=${agent.id}`);
      } else {
        navigate(`/settings/agents/${agent.id}`, { replace: true });
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete() {
    if (!persistedId) return;
    if (!window.confirm(`Delete "${name}"? This can't be undone.`)) return;
    setDeleting(true);
    try {
      await deleteAgent(persistedId);
      navigate('/settings/agents');
    } finally {
      setDeleting(false);
    }
  }

  const notFound = !!agentId && !existingLoading && !existing;

  if (notFound) {
    return (
      <EmptyState
        title="Agent not found"
        description="It may have been deleted."
        action={
          <Button variant="secondary" onClick={() => navigate('/settings/agents')}>
            Back to Agents
          </Button>
        }
      />
    );
  }

  return (
    <div className="mx-auto flex h-full max-w-2xl flex-col">
      <div className="flex items-center gap-3 border-b border-border px-1 py-3">
        <IconButton
          label="Back"
          onClick={() => navigate(returnTo && persistedId ? returnTo : '/settings/agents')}
        >
          <ArrowLeft size={16} />
        </IconButton>
        <span className="font-display text-sm font-medium text-text">
          {persistedId ? name || 'Agent' : 'New agent'}
        </span>
        <span className="text-xs text-text-muted">
          {persistedId ? (status === 'saving' ? 'Saving…' : status === 'saved' ? 'Saved' : ' ') : ' '}
        </span>
        {persistedId && (
          <IconButton
            label="Delete agent"
            onClick={handleDelete}
            disabled={deleting}
            className="ml-auto hover:text-danger disabled:opacity-50"
          >
            <Trash2 size={15} />
          </IconButton>
        )}
      </div>

      <div className="thin-scroll flex-1 overflow-y-auto px-1 py-6">
        {!persistedId && (
          <div className="mb-6">
            <span className={labelClass}>Start from a template</span>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => applyTemplate(AGENT_TEMPLATES[0])}
                className={clsx(
                  'rounded-[var(--radius-sm)] border px-3 py-1.5 text-xs font-medium',
                  !templateId || templateId === 'blank'
                    ? 'border-accent bg-accent-soft-bg text-accent-soft-text'
                    : 'border-border-strong text-text-secondary hover:bg-surface-2',
                )}
              >
                Blank
              </button>
              {AGENT_TEMPLATES.slice(1).map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => applyTemplate(t)}
                  className={clsx(
                    'rounded-[var(--radius-sm)] border px-3 py-1.5 text-xs font-medium',
                    templateId === t.id
                      ? 'border-accent bg-accent-soft-bg text-accent-soft-text'
                      : 'border-border-strong text-text-secondary hover:bg-surface-2',
                  )}
                >
                  {t.name}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="mb-6 flex items-start gap-3">
          <Avatar name={name || 'A'} color={avatarColor} shape="square" size={40} />
          <div className="flex-1">
            <label className={labelClass} htmlFor="agent-name">
              Name
            </label>
            <input
              id="agent-name"
              autoFocus={!persistedId}
              value={name}
              onChange={(e) => handleNameChange(e.target.value)}
              placeholder="Alice"
              className={INPUT_CLASS}
            />
          </div>
        </div>

        <div className="mb-6">
          <span className={labelClass}>Avatar color</span>
          <div className="flex gap-2">
            {AVATAR_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => {
                  setAvatarColor(c);
                  scheduleSave({ avatarColor: c });
                }}
                aria-label={`Color ${c}`}
                className={clsx(
                  'size-7 cursor-pointer rounded-[6px]',
                  avatarColor === c && 'ring-2 ring-[var(--accent)] ring-offset-2 ring-offset-[var(--surface)]',
                )}
                style={{ background: c }}
              />
            ))}
          </div>
        </div>

        <div className="mb-6">
          <span className={labelClass}>Instructions</span>
          <p className="mb-2 -mt-1 text-xs text-text-muted">
            This file is given to the model as its operating brief on every ticket it works.
          </p>
          <input
            value={filename}
            onChange={(e) => handleFilenameChange(e.target.value)}
            onBlur={handleFilenameBlur}
            placeholder="agent.md"
            className={clsx(INPUT_CLASS, 'mb-2 font-mono text-xs')}
          />
          <div className="overflow-hidden rounded-[var(--radius-sm)] border border-border-strong">
            <div className="flex border-b border-border bg-surface-2">
              {(['raw', 'preview'] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setMdTab(tab)}
                  className={clsx(
                    '-mb-px border-b-2 px-3.5 py-1.5 text-xs font-semibold capitalize',
                    mdTab === tab
                      ? 'border-accent bg-surface text-text'
                      : 'border-transparent text-text-secondary hover:text-text',
                  )}
                >
                  {tab}
                </button>
              ))}
            </div>
            {mdTab === 'raw' ? (
              <textarea
                value={contentMarkdown}
                onChange={(e) => handleContentChange(e.target.value)}
                rows={12}
                placeholder={'# Release Notes Bot\n\nSummarize merged PRs into a changelog entry...'}
                className="w-full resize-y bg-bg px-3 py-2.5 font-mono text-xs leading-relaxed text-text outline-none"
              />
            ) : (
              <div
                className="agent-md-preview min-h-[220px] bg-surface px-3 py-2.5 text-sm text-text"
                dangerouslySetInnerHTML={{
                  __html: contentMarkdown.trim()
                    ? renderMarkdown(contentMarkdown)
                    : '<p style="color:var(--text-muted)">Nothing to preview yet.</p>',
                }}
              />
            )}
          </div>
        </div>

        <div className="mb-6">
          <span className={labelClass}>Which projects can this agent be assigned to?</span>
          <div className="mb-2 flex gap-2">
            {(
              [
                { value: true, label: 'All current projects' },
                { value: false, label: 'Specific projects' },
              ] as const
            ).map((opt) => (
              <button
                key={String(opt.value)}
                type="button"
                onClick={() => handleScopeAllChange(opt.value)}
                className={clsx(
                  'rounded-[var(--radius-sm)] border px-3 py-1.5 text-xs font-medium',
                  scopeAllProjects === opt.value
                    ? 'border-accent bg-accent-soft-bg text-accent-soft-text'
                    : 'border-border-strong text-text-secondary hover:bg-surface-2',
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
          {!scopeAllProjects && (
            <div className="flex flex-col gap-0.5 rounded-[var(--radius-sm)] border border-border p-1">
              {(projects ?? []).length === 0 && (
                <p className="px-2 py-1.5 text-xs text-text-muted">No projects yet.</p>
              )}
              {(projects ?? []).map((p) => (
                <label
                  key={p.id}
                  className="flex cursor-pointer items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-sm hover:bg-surface-2"
                >
                  <input
                    type="checkbox"
                    className="accent-[var(--accent)]"
                    checked={scopeProjectIds.includes(p.id)}
                    onChange={() => toggleScopeProject(p.id)}
                  />
                  {p.icon} {p.name}
                </label>
              ))}
            </div>
          )}
        </div>

        <div className="mb-6">
          <span className={labelClass}>Execution — how it actually runs</span>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {EXECUTION_METHODS.map((method) => {
              if (method.roadmap) {
                return (
                  <div
                    key={method.id}
                    className="flex flex-col gap-1 rounded-[var(--radius)] border border-border-strong bg-surface-2 p-3 opacity-60"
                  >
                    <div className="flex items-center gap-2 text-sm font-medium text-text">
                      {method.label}
                      <span className="ml-auto rounded-full border border-border-strong bg-surface px-1.5 py-0.5 font-mono text-[9.5px] tracking-wide text-text-muted uppercase">
                        Roadmap
                      </span>
                    </div>
                    <p className="text-xs text-text-muted">{method.roadmapNote}</p>
                  </div>
                );
              }
              return (
                <div
                  key={method.id}
                  className="flex flex-col gap-1 rounded-[var(--radius)] border-[1.5px] border-success bg-success-bg p-3"
                >
                  <div className="flex items-center gap-1.5 text-sm font-medium text-text">
                    <IconCheck size={14} className="text-success" />
                    {method.label}
                  </div>
                  <ClaudeCodeStatus
                    probe={detection ?? { state: 'checking' }}
                    className="mt-0.5"
                  />
                </div>
              );
            })}
          </div>
          {detection?.state === 'absent' && (
            <p className="mt-2 text-xs text-text-muted">
              You can still save this agent, but it won't run until Claude Code is detected.
            </p>
          )}
        </div>

        <div className="mb-6">
          <label className={labelClass} htmlFor="agent-model">
            Model
          </label>
          <select
            id="agent-model"
            value={model}
            onChange={(e) => handleModelChange(e.target.value)}
            className={clsx(INPUT_CLASS, 'max-w-56')}
          >
            {CLAUDE_MODELS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-text-muted">Options are scoped to the execution method above.</p>
        </div>

        <div className="mb-6">
          <span className={labelClass}>Autonomy</span>
          <div className="flex flex-col gap-0.5 rounded-[var(--radius-sm)] border border-border p-1">
            {AUTONOMY_OPTIONS.map((opt) => (
              <label
                key={opt.value}
                className="flex cursor-pointer items-start gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-sm hover:bg-surface-2"
              >
                <input
                  type="radio"
                  name="autonomy"
                  className="mt-0.5 accent-[var(--accent)]"
                  checked={autonomy === opt.value}
                  onChange={() => handleAutonomyChange(opt.value)}
                />
                <span>
                  <span className="block font-medium text-text">{opt.label}</span>
                  <span className="block text-xs text-text-muted">{opt.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </div>

        <div className="mb-8">
          <span className={labelClass}>Triggers</span>
          <div className="flex flex-col gap-0.5 rounded-[var(--radius-sm)] border border-border p-1">
            {TRIGGER_OPTIONS.map((opt) => (
              <label
                key={opt.value}
                className="flex cursor-pointer items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-sm hover:bg-surface-2"
              >
                <input
                  type="checkbox"
                  className="accent-[var(--accent)]"
                  checked={triggers.includes(opt.value)}
                  onChange={() => toggleTrigger(opt.value)}
                />
                {opt.label}
              </label>
            ))}
          </div>
        </div>
      </div>

      {!persistedId && (
        <div className="flex justify-end gap-2 border-t border-border px-1 py-3">
          <Button variant="ghost" onClick={() => navigate(returnTo ?? '/settings/agents')}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!minimallyValid || submitting} onClick={handleCreate}>
            {submitting ? 'Creating…' : 'Create agent'}
          </Button>
        </div>
      )}

      <style>{`
        .agent-md-preview h2 { margin: 1em 0 0.4em; font-family: var(--font-display); font-size: 1.05rem; font-weight: 600; }
        .agent-md-preview h3 { margin: 0.9em 0 0.3em; font-family: var(--font-display); font-size: 0.95rem; font-weight: 600; }
        .agent-md-preview p { margin: 0.5em 0; line-height: 1.6; }
        .agent-md-preview ul { margin: 0.5em 0; padding-left: 1.4em; list-style: disc; }
        .agent-md-preview li { margin: 0.2em 0; }
        .agent-md-preview code { padding: 0.1em 0.35em; border-radius: 4px; background: var(--surface-2); font-family: var(--font-mono); font-size: 0.85em; }
        .agent-md-preview pre { margin: 1em 0; padding: 0.75em 1em; border-radius: var(--radius-sm); background: var(--surface-2); font-family: var(--font-mono); font-size: 0.85em; overflow-x: auto; }
        .agent-md-preview pre code { padding: 0; background: none; }
        .agent-md-preview a { color: var(--accent); text-decoration: underline; }
      `}</style>
    </div>
  );
}
