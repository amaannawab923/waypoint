import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, X } from 'lucide-react';
import { subscribeToasts } from '@/lib/toast';

interface ToastEntry {
  id: number;
  message: string;
}

const AUTO_DISMISS_MS = 6000;

// Mounted once at the app root (see App.tsx). Purely a rendering target for
// lib/toast.ts's pub-sub — has no idea what triggered a toast.
export function ToastHost() {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);

  useEffect(() => {
    return subscribeToasts((message) => {
      const id = Date.now() + Math.random();
      setToasts((t) => [...t, { id, message }]);
      setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), AUTO_DISMISS_MS);
    });
  }, []);

  if (toasts.length === 0) return null;

  return createPortal(
    <div className="fixed bottom-4 right-4 z-[200] flex w-full max-w-sm flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          role="alert"
          className="flex items-start gap-2.5 rounded-[var(--radius-sm)] border border-danger/30 bg-danger-bg px-4 py-3 text-sm text-danger shadow-2xl"
        >
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <span className="min-w-0 flex-1 break-words">{t.message}</span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setToasts((cur) => cur.filter((x) => x.id !== t.id))}
            className="shrink-0 text-danger/70 hover:text-danger"
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}
