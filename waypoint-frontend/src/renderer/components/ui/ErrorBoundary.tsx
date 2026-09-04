import { Component, type ErrorInfo, type ReactNode } from 'react';
import { IconAlert } from '@/components/icons';
import { Button } from '@/components/ui/Button';

/**
 * Last-resort catch-all for any render error below it (router.tsx wraps the
 * whole route outlet in one of these). Without this, ANY unguarded throw
 * during render — e.g. a page that assumes route/outlet context it doesn't
 * actually have on every path that can reach it — unmounts the entire React
 * tree to a blank white screen, taking the whole app down over one page's
 * bug. This turns that into a recoverable, in-place fallback instead.
 *
 * Deliberately honest, matching this app's existing honesty-lint convention
 * (see TicketDetailPage.tsx's "Pending proposals" comment, ProjectLayout.tsx's
 * fabricated-status comment): says plainly that something broke rather than
 * hiding it behind a vague spinner or a fake-success message, and always
 * offers a real way back (Home) instead of just swallowing the error.
 *
 * A class component on purpose — `getDerivedStateFromError`/
 * `componentDidCatch` have no hook equivalent; React does not offer a
 * function-component API for catching render errors from descendants.
 */
interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error('Unhandled render error', error, info.componentStack);
  }

  private handleReset = () => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 px-6 py-16 text-center">
          <div className="text-danger">
            <IconAlert size={28} />
          </div>
          <div className="space-y-1">
            <p className="font-display text-sm font-medium text-text">Something went wrong</p>
            <p className="max-w-sm text-sm text-text-secondary">
              This page hit an unexpected error and couldn't render. Nothing was silently
              skipped — the error was {this.state.error.message || 'an unknown error'}.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={this.handleReset}>
              Try again
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                this.handleReset();
                window.location.assign('/');
              }}
            >
              Go home
            </Button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
