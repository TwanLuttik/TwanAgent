import { Component, type ErrorInfo, type ReactNode } from "react";
import { AppError } from "./AppError";

type Props = { children: ReactNode };
type State = { failed: boolean };

/** Catches a render error and offers a reload. The Rust process is left running. */
export class AppBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error, info.componentStack);
  }

  render() {
    if (this.state.failed) {
      return <AppError onReload={() => window.location.reload()} />;
    }
    return this.props.children;
  }
}
