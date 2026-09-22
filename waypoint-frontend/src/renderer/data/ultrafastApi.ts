// The one integration point between the "Ultrafast browser tasks" settings
// section and its data — same contract as data/engineApi.ts (see its own
// header). UI code never reaches past these functions to
// window.electron.ultrafast directly.

import type {
  UltrafastSaveKeyResult,
  UltrafastStatus,
  UltrafastTestResult,
} from '@/types/ultrafast';

function bridge() {
  const api = window.electron?.ultrafast;
  if (!api) {
    throw new Error('Ultrafast browser tasks are unavailable in this window.');
  }
  return api;
}

export function getUltrafastStatus(): Promise<UltrafastStatus> {
  return bridge().status();
}

export function saveUltrafastKey(key: string): Promise<UltrafastSaveKeyResult> {
  return bridge().saveKey(key);
}

export function clearUltrafastKey(): Promise<{ ok: true }> {
  return bridge().clearKey();
}

/** Provisions if needed, self-tests the venv, then runs a real short task
 *  against a local test page — can take up to a couple of minutes on a
 *  machine that has never provisioned before. */
export function testUltrafast(): Promise<UltrafastTestResult> {
  return bridge().test();
}
