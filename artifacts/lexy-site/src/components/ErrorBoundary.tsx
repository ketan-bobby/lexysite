/*
 * ErrorBoundary.tsx — Top-level React error boundary for the public site.
 *
 * Adapted from the lexy app's ErrorBoundary (same mechanism/fallback shape).
 * Catches synchronous render errors below it and swaps the broken subtree for
 * a friendly full-page error state, so a marketing page can never render as a
 * blank screen. Public-context tweaks: softer copy (no "contact support") and
 * a "Back to home" escape hatch alongside refresh.
 *
 * Mounted twice in App.tsx (outer around all providers, inner around the
 * router) — mirroring the lexy app's pattern.
 */
import { Component, type ReactNode, type ErrorInfo } from "react";

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
  componentStack: string | null;
}

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
      const homeHref = import.meta.env.BASE_URL || "/";
      return (
        <div className="min-h-screen text-foreground flex flex-col items-center justify-center px-4 text-center gap-6">
          <div className="w-14 h-14 rounded-full bg-destructive/10 flex items-center justify-center">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              className="w-7 h-7 text-destructive"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          </div>
          <div className="space-y-2 max-w-sm">
            <h1 className="text-xl font-semibold">Something went wrong</h1>
            <p className="text-sm text-muted-foreground">
              We hit an unexpected error loading this page. Try refreshing, or head back to the
              homepage.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => window.location.reload()}
              className="px-5 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors"
            >
              Refresh page
            </button>
            <a
              href={homeHref}
              className="px-5 py-2.5 rounded-xl border border-border text-sm font-semibold text-foreground hover:bg-muted/50 transition-colors"
            >
              Back to home
            </a>
          </div>
          <details className="text-left max-w-lg w-full">
            <summary className="text-xs text-muted-foreground/60 cursor-pointer hover:text-muted-foreground">
              Technical details
            </summary>
            <pre className="mt-2 text-[10px] text-muted-foreground/80 bg-muted/30 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap break-all">
              {this.state.error.message}
              {this.state.error.stack && `\n\n--- Stack ---\n${this.state.error.stack}`}
              {this.state.componentStack &&
                `\n\n--- Component stack ---${this.state.componentStack}`}
            </pre>
          </details>
        </div>
      );
    }
    return this.props.children;
  }
}
