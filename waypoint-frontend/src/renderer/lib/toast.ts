// Minimal global pub-sub for transient toasts. The one thing that matters
// here: httpClient.ts's request() calls showErrorToast() on every failed API
// call, so every one of the ~65 functions in data/api.ts gets user-visible
// error feedback automatically — no per-call-site try/catch required. A
// page that wants its own specific handling can still catch the thrown
// error on top of this; the toast just means an uncaught one is never
// silent.
type ToastListener = (message: string) => void;

const listeners = new Set<ToastListener>();

export function showErrorToast(message: string): void {
  for (const listener of listeners) listener(message);
}

export function subscribeToasts(listener: ToastListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
