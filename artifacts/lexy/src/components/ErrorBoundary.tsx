/**
 * ErrorBoundary.tsx — Top-level React error boundary.
 *
 * ── What this file does ───────────────────────────────────────────────────────
 * Catches synchronous render errors anywhere in the component tree below it and
 * replaces the broken subtree with a friendly full-page error state.  The error
 * message is shown in a collapsible "Technical details" section so developers can
 * diagnose issues without alarming regular users.  A "Refresh page" button calls
 * window.location.reload() to give the user a recovery path.
 *
 * ── Usage ─────────────────────────────────────────────────────────────────────
 *  Wrap the root <App> component (or any subtree that should recover gracefully):
 *    <ErrorBoundary><App /></ErrorBoundary>
 *
 * ── Used by ───────────────────────────────────────────────────────────────────
 *  main.tsx / App.tsx    Application root — wraps the entire React tree
 */

import { Component, type ReactNode, type ErrorInfo } from "react";

interface Props { children: ReactNode; }
interface State { error: Error | null; componentStack: string | null; }

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, componentStack: null };

  static getDerivedStateFromError(error: Error): State {
    return { error, componentStack: null };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary] caught:", error, info.componentStack);
    this.setState({ componentStack: info.componentStack ?? null });
  }

  override render() {
    if (this.state.error) {
      return (
        <div className="min-h-screen text-foreground flex flex-col items-center justify-center px-4 text-center gap-6">
          <div className="w-14 h-14 rounded-full bg-destructive/10 flex items-center justify-center">
            <svg viewBox="0 0 24 24" fill="none" className="w-7 h-7 text-destructive" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          </div>
          <div className="space-y-2 max-w-sm">
            <h1 className="text-xl font-bold">Something went wrong</h1>
            <p className="text-sm text-muted-foreground">
              We hit an unexpected error loading this page. Try refreshing — if the problem persists, contact support.
            </p>
          </div>
          <button
            onClick={() => window.location.reload()}
            className="px-5 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors"
          >
            Refresh page
          </button>
          <details className="text-left max-w-lg w-full">
            <summary className="text-xs text-muted-foreground/60 cursor-pointer hover:text-muted-foreground">Technical details</summary>
            <pre className="mt-2 text-[10px] text-muted-foreground/80 bg-muted/30 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap break-all">
              {this.state.error.message}
              {this.state.error.stack && `\n\n--- Stack ---\n${this.state.error.stack}`}
              {this.state.componentStack && `\n\n--- Component stack ---${this.state.componentStack}`}
            </pre>
          </details>
        </div>
      );
    }
    return this.props.children;
  }
}
