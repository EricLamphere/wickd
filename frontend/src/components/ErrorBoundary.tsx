// Keeps one part of the page failing to draw from blanking the whole app: it shows `fallback`
// instead (with the error), and tries again when `resetKey` changes.
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  /** a change (another query, another item) clears the error and draws the children again */
  resetKey: string;
  fallback: (error: Error) => ReactNode;
  /** for the console message */
  name: string;
  children: ReactNode;
}

export class ErrorBoundary extends Component<Props, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidUpdate(prev: Props) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`${this.props.name} failed to render`, error, info.componentStack);
  }

  render() {
    return this.state.error ? this.props.fallback(this.state.error) : this.props.children;
  }
}
