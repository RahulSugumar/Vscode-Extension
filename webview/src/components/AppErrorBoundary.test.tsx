import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AppErrorBoundary from "./AppErrorBoundary";

function Broken({ message = "Render failed" }: { message?: string }): never {
  throw new Error(message);
}

describe("AppErrorBoundary", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("passes healthy children through", () => {
    render(
      <AppErrorBoundary>
        <span>Healthy</span>
      </AppErrorBoundary>,
    );
    expect(screen.getByText("Healthy")).toBeInTheDocument();
  });

  it("renders a useful fallback for child errors", () => {
    render(
      <AppErrorBoundary>
        <Broken />
      </AppErrorBoundary>,
    );
    expect(screen.getByRole("heading", { name: "Project Assistant could not render" })).toBeInTheDocument();
    expect(screen.getByText("Render failed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
  });

  it("uses the generic fallback for an error with no message", () => {
    render(
      <AppErrorBoundary>
        <Broken message="" />
      </AppErrorBoundary>,
    );
    expect(screen.getByText("An unexpected webview error occurred.")).toBeInTheDocument();
  });
});
