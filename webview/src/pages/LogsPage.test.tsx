import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { logEntry } from "../test/fixtures";

const storeMock = vi.hoisted(() => ({ useLogStore: vi.fn() }));
vi.mock("../state/miscStores", () => storeMock);

import LogsPage from "./LogsPage";

const load = vi.fn();
const unsubscribe = vi.fn();
const subscribeToPush = vi.fn(() => unsubscribe);
let state: any;

beforeEach(() => {
  load.mockReset();
  unsubscribe.mockReset();
  subscribeToPush.mockClear();
  state = {
    logs: [],
    status: "idle",
    error: null,
    load,
    subscribeToPush,
  };
  storeMock.useLogStore.mockImplementation(() => state);
});

describe("LogsPage", () => {
  it("loads, subscribes, and unsubscribes over its lifecycle", () => {
    const view = render(<LogsPage />);
    expect(load).toHaveBeenCalledOnce();
    expect(subscribeToPush).toHaveBeenCalledOnce();
    view.unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("renders logs and filters by severity", async () => {
    const user = userEvent.setup();
    state.logs = [
      logEntry,
      { ...logEntry, id: "success", type: "Success", message: "Completed" },
      { ...logEntry, id: "error", type: "Error", message: "Failed" },
    ];
    render(<LogsPage />);
    expect(screen.getByText("Started")).toBeInTheDocument();
    expect(screen.getByText("Completed")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Error" }));
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.queryByText("Started")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "All" }));
    expect(screen.getByText("Started")).toBeInTheDocument();
  });

  it("shows the empty state and retries failures", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<LogsPage />);
    expect(screen.getByText("No logs available.")).toBeInTheDocument();

    state.status = "error";
    state.error = "Could not load";
    rerender(<LogsPage />);
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(load).toHaveBeenCalledTimes(2);
  });
});
