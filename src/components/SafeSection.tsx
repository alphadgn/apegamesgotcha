import { Component, type ReactNode } from "react";

/**
 * Contains a crash to one section of the page (e.g. the gotcha machine) instead of
 * replacing the whole page with the error screen.
 */
export class SafeSection extends Component<{ label: string; children: ReactNode }, { error: string | null }> {
  override state = { error: null as string | null };
  static getDerivedStateFromError(e: unknown) {
    return { error: (e as Error)?.message || "Unknown error" };
  }
  override componentDidCatch(e: unknown) {
    console.error(`[${this.props.label}] crashed:`, e);
  }
  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="rounded border border-border bg-card p-6 text-center">
        <p className="font-bold">The {this.props.label} hit a problem.</p>
        <p className="mt-1 text-sm text-muted-foreground">{this.state.error}</p>
        <button
          type="button"
          className="mt-4 rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
          onClick={() => window.location.reload()}
        >
          Reload
        </button>
      </div>
    );
  }
}
