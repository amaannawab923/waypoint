import { app } from 'electron';
import * as path from 'path';

// Same app.getPath('userData')-relative convention copilotAuth.ts's own
// tokenFilePath() uses for app-owned data — a subdirectory here rather than
// userData's root so a future unrelated CLAUDE_CONFIG_DIR-shaped file never
// collides with anything else this app stores there.
//
// Pulled out into its own module (rather than living in copilotRunner.ts,
// where it originated) so copilotAuth.ts's token-validation probe
// (buildProbeEnv) can share the exact same path without importing from
// copilotRunner.ts — copilotRunner.ts already imports
// getStoredSubscriptionToken from copilotAuth.ts, so the other direction
// would be a circular import.
export function copilotClaudeConfigDir(): string {
  return path.join(app.getPath('userData'), 'copilot-claude-config');
}
