// One error boundary for every pane and live container: a subscription that throws (a server error, a
// validator mismatch) is caught where it happens, so the rest of the window keeps working. The error is
// logged once with the part's name (Convex errors carry the query's name in their message); `retry`
// clears it, which remounts the children and so subscribes again. Plain TS (no JSX) so it can be tested
// without a DOM.
import { Component, type ReactNode } from "react";

export type BoundaryProps = {
  /** What this part is, for the log: "Today", "the project list", "TARS's desk". */
  name: string;
  children: ReactNode;
  fallback(retry: () => void, error: Error): ReactNode;
};

export class Boundary extends Component<BoundaryProps, { error: Error | null }> {
  override state = { error: null as Error | null };
  static getDerivedStateFromError(err: unknown) {
    return { error: err instanceof Error ? err : new Error(String(err)) };
  }
  override componentDidCatch(err: unknown) {
    console.error(`TARS: ${this.props.name} could not load.`, err);
  }
  retry = () => this.setState({ error: null });
  override render() {
    return this.state.error ? this.props.fallback(this.retry, this.state.error) : this.props.children;
  }
}
