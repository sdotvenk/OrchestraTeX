"use client";

import { WarningCircle } from "@phosphor-icons/react";
import { Component, type ErrorInfo, type ReactNode } from "react";

interface AgentErrorBoundaryProps {
  children: ReactNode;
  onReset?: () => void;
}

interface AgentErrorBoundaryState {
  hasError: boolean;
  message: string;
}

export class AgentErrorBoundary extends Component<
  AgentErrorBoundaryProps,
  AgentErrorBoundaryState
> {
  constructor(props: AgentErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, message: "" };
  }

  static getDerivedStateFromError(error: Error): AgentErrorBoundaryState {
    return {
      hasError: true,
      message: error.message || "Unexpected error in Agent panel",
    };
  }

  override componentDidCatch(_error: Error, _errorInfo: ErrorInfo) {
    // Error captured cleanly by UI state
  }

  override render() {
    if (this.state.hasError) {
      return (
        <div className="h-full w-full flex flex-col items-center justify-center p-4 bg-background text-center space-y-3">
          <WarningCircle className="size-7 text-error" aria-hidden="true" />
          <div className="space-y-1">
            <div className="text-xs font-mono uppercase tracking-wider font-semibold">
              Agent Panel Crashed
            </div>
            <p className="text-xs text-muted max-w-xs break-words">{this.state.message}</p>
          </div>
          <button
            type="button"
            onClick={() => {
              this.setState({ hasError: false, message: "" });
              this.props.onReset?.();
            }}
            className="btn btn-primary btn-sm"
          >
            Recover Panel
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
