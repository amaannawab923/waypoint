import type { AgentAutonomy, ExecutionMethod } from '@/types/entities';

// Templates replace the old "built-in Claude Code / Codex / Gemini" personas.
// They're optional scaffolding for a new agent's instructions file and
// defaults — never a persona you assign directly, and never seeded into
// mock/db.ts, since there's nothing to list or delete about a template
// outside the moment of creating an agent.
export interface AgentTemplate {
  id: string;
  name: string;
  filenameHint: string;
  contentMarkdown: string;
  autonomy: AgentAutonomy;
  model: string;
}

export const AGENT_TEMPLATES: AgentTemplate[] = [
  {
    id: 'blank',
    name: '',
    filenameHint: 'agent',
    contentMarkdown: '',
    autonomy: 'ask-before-pr',
    model: 'Claude Sonnet',
  },
  {
    id: 'code-reviewer',
    name: 'Code Reviewer',
    filenameHint: 'code-reviewer',
    contentMarkdown: `# Code Reviewer

Review every pull request opened in the assigned project for correctness,
readability, and test coverage. Leave inline comments on specific lines
where possible; summarize the overall risk level in your final comment.

Never approve or merge — always leave the decision to a human reviewer.`,
    autonomy: 'plan-only',
    model: 'Claude Sonnet',
  },
  {
    id: 'release-notes-writer',
    name: 'Release Notes Writer',
    filenameHint: 'release-notes-writer',
    contentMarkdown: `# Release Notes Writer

Summarize merged PRs into a changelog entry whenever the "release" label
is added to a ticket. Keep entries to one line, written for users — not
a raw commit-message dump.`,
    autonomy: 'ask-before-write',
    model: 'Claude Sonnet',
  },
  {
    id: 'bug-triage',
    name: 'Bug Triage',
    filenameHint: 'bug-triage',
    contentMarkdown: `# Bug Triage

When assigned to a new bug report, try to reproduce it first. If you can,
describe the exact repro steps and the root cause before proposing a fix.
If you can't reproduce it, say so explicitly and ask for more detail
instead of guessing.`,
    autonomy: 'plan-only',
    model: 'Claude Haiku',
  },
];

export interface ExecutionMethodMeta {
  id: ExecutionMethod;
  label: string;
  roadmap: boolean;
  roadmapNote?: string;
}

// v1 offers exactly one selectable execution method. The rest are shown as
// visibly disabled cards with a "Roadmap" badge — present so the shape of
// what's coming is legible, never as if they work today.
export const EXECUTION_METHODS: ExecutionMethodMeta[] = [
  {
    id: 'local-claude-subscription',
    label: 'Your local Claude Code subscription',
    roadmap: false,
  },
  {
    id: 'local-codex-subscription',
    label: 'Local Codex subscription',
    roadmap: true,
    roadmapNote: 'Coming later — v1 supports your local Claude Code subscription only.',
  },
  {
    id: 'local-gemini-subscription',
    label: 'Local Gemini subscription',
    roadmap: true,
    roadmapNote: 'Coming later — v1 supports your local Claude Code subscription only.',
  },
  {
    id: 'hosted-api-key',
    label: 'Hosted API key',
    roadmap: true,
    roadmapNote: 'A different execution model entirely — runs in the cloud, not on your machine.',
  },
];

export const CLAUDE_MODELS = ['Claude Opus', 'Claude Sonnet', 'Claude Haiku'];

export function slugifyFilename(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
  return `${base || 'agent'}.md`;
}
