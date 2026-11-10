import React from "react";
import { Loader2, AlertTriangle } from "lucide-react";
import "./AsyncBoundary.css";

export type AsyncStatus =
  | "idle"
  | "loading"
  | "sending"
  | "hydrating"
  | "error";

interface Props {
  status: AsyncStatus;
  error: string | null;
  isEmpty?: boolean;
  emptyMessage?: string;
  onRetry?: () => void;
  children: React.ReactNode;
}

export default function AsyncBoundary({
  status,
  error,
  isEmpty,
  emptyMessage = "No data yet.",
  onRetry,
  children,
}: Props) {
  // Treat 'loading', 'sending', and 'hydrating' as the same visual state.
  if (status === "loading" || status === "sending" || status === "hydrating") {
    return (
      <div className="async-state">
        <Loader2 className="spinner" size={32} />
        <p>
          {status === "hydrating"
            ? "Getting things ready..."
            : "Loading the latest information..."}
        </p>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="async-state error">
        <AlertTriangle size={32} />
        <p>{error || "Something went wrong."}</p>
        {onRetry && (
          <button className="primary-btn" onClick={onRetry}>
            Retry
          </button>
        )}
      </div>
    );
  }

  if (isEmpty) {
    return (
      <div className="async-state">
        <p>{emptyMessage}</p>
      </div>
    );
  }

  return <>{children}</>;
}
