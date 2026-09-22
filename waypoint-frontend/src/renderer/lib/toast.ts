// Minimal global pub-sub for transient toasts. The one thing that matters
// here: httpClient.ts's request() calls showErrorToast() on every failed API
// call, so every one of the ~65 functions in data/api.ts gets user-visible
// error feedback automatically — no per-call-site try/catch required. A
// page that wants its own specific handling can still catch the thrown
// error on top of this; the toast just means an uncaught one is never
// silent.
//
// Customer feedback round 1 (Fix 5) added the second kind: a quiet
// confirmation of a write that just happened, carrying the one action that
// makes a mis-click cheap — "Moved ENG-77 to In Review. [Undo]".

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface Toast {
  tone: 'error' | 'info';
  message: string;
  /** One optional button, shown after the message. Dismisses the toast. */
  action?: ToastAction;
  /** How long the toast stays; the host's default when omitted. */
  durationMs?: number;
}

type ToastListener = (toast: Toast) => void;

const listeners = new Set<ToastListener>();

function emit(toast: Toast): void {
  for (const listener of listeners) listener(toast);
}

export function showErrorToast(message: string): void {
  emit({ tone: 'error', message });
}

export function showInfoToast(
  message: string,
  options: { action?: ToastAction; durationMs?: number } = {},
): void {
  emit({
    tone: 'info',
    message,
    action: options.action,
    durationMs: options.durationMs,
  });
}

export function subscribeToasts(listener: ToastListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
