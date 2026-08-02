import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Shown above the technical message; phrase it as coaching, not stack trace. */
  hint?: string;
}

interface State {
  error: Error | null;
}

/**
 * Catches render-time failures so a bad clip never leaves the coach staring at
 * a blank tablet mid-training (§7.3).
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Stays on the device; nothing is reported anywhere (§5).
    console.error("SpikePhysics render error", error, info.componentStack);
  }

  private reset = () => this.setState({ error: null });

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="panel max-w-lg text-center">
          <h2 className="mb-2 text-xl font-bold text-signal-danger">
            Something went wrong
          </h2>
          <p className="mb-4 text-slate-300">
            {this.props.hint ??
              "The analysis stopped unexpectedly. Your footage is still on this tablet and nothing was uploaded."}
          </p>
          <p className="mb-6 break-words font-mono text-xs text-slate-500">
            {error.message}
          </p>
          <button className="btn-primary" onClick={this.reset}>
            Start over
          </button>
        </div>
      </div>
    );
  }
}
