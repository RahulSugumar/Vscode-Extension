import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import AsyncBoundary from "./AsyncBoundary";

describe("AsyncBoundary", () => {
  it.each([
    ["loading", "Loading the latest information..."],
    ["sending", "Loading the latest information..."],
    ["hydrating", "Getting things ready..."],
  ] as const)("renders the %s state", (status, message) => {
    render(
      <AsyncBoundary status={status} error={null}>
        <span>content</span>
      </AsyncBoundary>,
    );
    expect(screen.getByText(message)).toBeInTheDocument();
    expect(screen.queryByText("content")).not.toBeInTheDocument();
  });

  it("renders an error, supports retry, and falls back to a default message", () => {
    const retry = vi.fn();
    const { rerender } = render(
      <AsyncBoundary status="error" error="Failed" onRetry={retry}>
        content
      </AsyncBoundary>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledOnce();
    expect(screen.getByText("Failed")).toBeInTheDocument();

    rerender(
      <AsyncBoundary status="error" error={null}>
        content
      </AsyncBoundary>,
    );
    expect(screen.getByText("Something went wrong.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("renders custom and default empty states", () => {
    const { rerender } = render(
      <AsyncBoundary status="idle" error={null} isEmpty emptyMessage="Nothing here">
        content
      </AsyncBoundary>,
    );
    expect(screen.getByText("Nothing here")).toBeInTheDocument();

    rerender(
      <AsyncBoundary status="idle" error={null} isEmpty>
        content
      </AsyncBoundary>,
    );
    expect(screen.getByText("No data yet.")).toBeInTheDocument();
  });

  it("renders children in an idle non-empty state", () => {
    render(
      <AsyncBoundary status="idle" error={null}>
        <span>Ready content</span>
      </AsyncBoundary>,
    );
    expect(screen.getByText("Ready content")).toBeInTheDocument();
  });
});
