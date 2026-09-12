import { detectLocalClaudeCode } from '@/data/api';
import type { SupportedProviderId } from '@/types/agentRuns';

/**
 * Which coding-agent provider a new session runs on — W4, the rule the
 * founder chose on 2026-09-12: emdash's own. A workspace-wide default
 * (`workspaces.default_agent_provider`, Settings → Agents), which every
 * way of starting a session preselects; a per-session override in the
 * New session dialog; and never a change on a session that exists — an
 * ACP session belongs to one agent process, so "switch" means "start
 * another in the same worktree", which is a later feature.
 *
 * `resolveProviderSelection` is emdash's `resolveConversationProviderSelection`
 * (apps/emdash-desktop/src/core/features/conversations/browser/provider-selection.ts
 * at 9b102a5f3, Apache-2.0), with Waypoint's names: the override wins;
 * else the default, unless availability is known and the default is not
 * installed, in which case the first installed provider in catalogue
 * order; with nothing installed there is no provider and Start is
 * disabled. Availability is per machine — the same probe MachinePage
 * shows as "Claude ready" — and is never assumed before the probe answers.
 */

export interface SessionProvider {
  id: SupportedProviderId;
  name: string;
  /** Is the provider usable on this machine? Resolves, never throws. */
  probe: () => Promise<boolean>;
}

/**
 * The providers the dialog offers — main's SUPPORTED_PROVIDERS, spelled as
 * a complete record so adding one there fails to compile until it is
 * described here (the renderer never imports main at runtime). Order is
 * the fallback order.
 */
export const SESSION_PROVIDERS: Record<SupportedProviderId, SessionProvider> = {
  claude: {
    id: 'claude',
    name: 'Claude Code',
    probe: () =>
      detectLocalClaudeCode().then(
        (p) => p.state === 'present',
        () => false,
      ),
  },
};

export const SESSION_PROVIDER_IDS = Object.keys(
  SESSION_PROVIDERS,
) as SupportedProviderId[];

/** Waypoint's own default, for a workspace that has not chosen one. */
export const BUILT_IN_DEFAULT_PROVIDER: SupportedProviderId = 'claude';

export function isSupportedProviderId(id: unknown): id is SupportedProviderId {
  return (
    typeof id === 'string' && (SESSION_PROVIDER_IDS as string[]).includes(id)
  );
}

export interface ProviderSelectionInput {
  /** Catalogue order — the fallback order. */
  orderedProviderIds: readonly SupportedProviderId[];
  /** The workspace's default, already checked to be a supported id (else null). */
  defaultProviderId: SupportedProviderId | null;
  /** What the person picked in this dialog, if anything. */
  providerOverride: SupportedProviderId | null;
  installedProviderIds: readonly SupportedProviderId[];
  /** False until every probe has answered — nothing is assumed before that. */
  availabilityKnown: boolean;
}

export interface ProviderSelection {
  providerId: SupportedProviderId | null;
  /** No provider, or the chosen one is known not to be installed. */
  createDisabled: boolean;
}

export function resolveProviderSelection({
  orderedProviderIds,
  defaultProviderId,
  providerOverride,
  installedProviderIds,
  availabilityKnown,
}: ProviderSelectionInput): ProviderSelection {
  const installed = new Set(installedProviderIds);
  const fallbackProviderId =
    availabilityKnown &&
    (!defaultProviderId || !installed.has(defaultProviderId))
      ? orderedProviderIds.find((id) => installed.has(id))
      : undefined;

  const noneInstalled = availabilityKnown && installed.size === 0;
  const effectiveDefault = noneInstalled
    ? null
    : (fallbackProviderId ?? defaultProviderId);
  const providerId = providerOverride ?? effectiveDefault;
  const providerInstalled = providerId ? installed.has(providerId) : false;

  return {
    providerId,
    createDisabled:
      providerId === null || (availabilityKnown && !providerInstalled),
  };
}

/** The workspace's stored preference as a provider id the dialog can use. */
export function workspaceDefaultProvider(
  stored: string | null | undefined,
): SupportedProviderId {
  return isSupportedProviderId(stored) ? stored : BUILT_IN_DEFAULT_PROVIDER;
}
