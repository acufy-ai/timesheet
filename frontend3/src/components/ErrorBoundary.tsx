import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** Bump this (e.g. the route pathname) to auto-clear the error on navigation. */
  resetKey?: string;
}

interface State {
  error: Error | null;
}

// App-wide error boundary. A render-time throw anywhere below this (e.g. a
// component handed a non-string where a string was expected) is caught here
// and shown as a recoverable panel instead of unmounting the whole tree to a
// blank screen. resetKey lets the shell clear the error when the route changes
// so navigating away recovers without a full reload.
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Surface to the console for diagnosis; a real telemetry sink can hook here.
    console.error('Unhandled UI error:', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="grid min-h-[60vh] place-items-center px-6">
        <div className="w-full max-w-md rounded-2xl border border-border bg-card p-6 text-center">
          <h1 className="text-lg font-semibold text-foreground">Something went wrong</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            This page hit an unexpected error. Your data is safe. Try again, or reload if it persists.
          </p>
          <div className="mt-5 flex justify-center gap-3">
            <button
              type="button"
              onClick={() => this.setState({ error: null })}
              className="inline-flex h-9 items-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90"
            >
              Try again
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="inline-flex h-9 items-center rounded-lg border border-border px-4 text-sm font-medium text-foreground hover:bg-muted"
            >
              Reload page
            </button>
          </div>
        </div>
      </div>
    );
  }
}
