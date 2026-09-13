/**
 * The daemon's live-topic id encoding, in one place — `@emdash/wire`'s
 * `encodeTopic` (`packages/wire/src/api/topics.ts`): `<state id>` for a
 * keyless model, `<state id>|<stableStringify(key)>` otherwise, where
 * stableStringify is JSON with object keys sorted recursively
 * (`packages/shared/src/util/stable-stringify.ts`). Neither is exported
 * or documented by emdash; both are pinned by the same commit as the
 * daemon (ENGINE_PIN.sourceCommit) and verified live in W2's probes.
 *
 * Everything in Waypoint that builds or judges a topic string goes
 * through here — the daemon facade to build, the renderer allowlist to
 * judge — so the two cannot drift from each other even if emdash's
 * encoding one day drifts from both (review round 2).
 */

export function stableStringify(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

export function liveTopic(stateId: string, key?: unknown): string {
  return key === undefined ? stateId : `${stateId}|${stableStringify(key)}`;
}

/** Splits a topic back into its state id and (parsed) key; null when it is not one. */
export function splitTopic(
  topic: string,
): { stateId: string; key: unknown } | null {
  const bar = topic.indexOf('|');
  if (bar === -1) return { stateId: topic, key: undefined };
  try {
    return {
      stateId: topic.slice(0, bar),
      key: JSON.parse(topic.slice(bar + 1)),
    };
  } catch {
    return null;
  }
}
