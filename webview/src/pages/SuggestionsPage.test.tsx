import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { policy, reviewResolution } from "../test/fixtures";

const storeMock = vi.hoisted(() => ({ useSuggestionStore: vi.fn() }));
vi.mock("../state/suggestionStore", () => storeMock);

import SuggestionsPage from "./SuggestionsPage";

const actions = {
  load: vi.fn(),
  accept: vi.fn(),
  addCustom: vi.fn(),
  discardReviewCandidate: vi.fn(),
  replaceWithReviewCandidate: vi.fn(),
  clearReview: vi.fn(),
  clearNotice: vi.fn(),
};
let state: any;
let postActionState: any;

beforeEach(() => {
  vi.useRealTimers();
  Object.values(actions).forEach((mock) => {
    mock.mockReset();
    mock.mockResolvedValue?.(undefined);
  });
  state = {
    suggestions: [],
    selectedId: null,
    reviewResolution: null,
    status: "idle",
    error: null,
    notice: null,
    noticePolicy: null,
    ...actions,
  };
  postActionState = { reviewResolution: null, error: null };
  storeMock.useSuggestionStore.mockImplementation(() => state);
  (storeMock.useSuggestionStore as any).getState = vi.fn(() => postActionState);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SuggestionsPage", () => {
  it("renders a disabled background without loading suggestions", () => {
    render(<SuggestionsPage disabled />);

    expect(actions.load).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Custom policy input")).toBeDisabled();
  });

  it("loads on mount and renders the empty state", () => {
    render(<SuggestionsPage />);
    expect(actions.load).toHaveBeenCalledOnce();
    expect(screen.getByText("No suggested policies.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review Custom Policy" })).toBeDisabled();
  });

  it("selects a suggestion with click or keyboard and reviews it", async () => {
    const user = userEvent.setup();
    state.suggestions = [policy];
    const { rerender } = render(<SuggestionsPage />);
    const card = screen.getByRole("button", { name: /Always validate input/ });
    await user.click(card);
    await user.click(screen.getByRole("button", { name: "Review Selected Policy" }));
    expect(actions.accept).toHaveBeenCalledWith(policy.id);

    rerender(<SuggestionsPage />);
    fireEvent.keyDown(screen.getByRole("button", { name: /Always validate input/ }), {
      key: "Enter",
    });
    expect(screen.getByRole("button", { name: "Review Selected Policy" })).toBeEnabled();
  });

  it("creates global and multi-tool custom policy payloads", async () => {
    const user = userEvent.setup();
    const view = render(<SuggestionsPage />);
    const textarea = screen.getByRole("textbox", { name: "Custom policy input" });
    await user.type(textarea, "  Global rule  ");
    await user.click(screen.getByRole("button", { name: "Review Custom Policy" }));
    expect(actions.addCustom).toHaveBeenCalledWith({
      policy: "Global rule",
      scope_type: "global",
      scope_id: undefined,
    });

    actions.addCustom.mockClear();
    const select = view.container.querySelector("select")!;
    await user.selectOptions(select, "tool");
    await user.type(screen.getByPlaceholderText("tool id"), " shell, git,  ");
    await user.type(textarea, "Tool rule");
    await user.click(screen.getByRole("button", { name: "Review Custom Policy" }));
    expect(actions.addCustom).toHaveBeenCalledWith({
      policy: "Tool rule",
      scope_type: "tool",
      scope_id: ["shell", "git"],
    });
  });

  it("requires a scope id and clears it when returning to global", async () => {
    const user = userEvent.setup();
    const view = render(<SuggestionsPage />);
    const select = view.container.querySelector("select")!;
    await user.selectOptions(select, "agent");
    await user.type(screen.getByRole("textbox", { name: "Custom policy input" }), "Rule");
    expect(screen.getByRole("button", { name: "Review Custom Policy" })).toBeDisabled();
    await user.type(screen.getByPlaceholderText("agent id"), "agent-1");
    expect(screen.getByRole("button", { name: "Review Custom Policy" })).toBeEnabled();
    await user.selectOptions(select, "global");
    expect(screen.queryByPlaceholderText("agent id")).not.toBeInTheDocument();
  });

  it("typing a custom policy switches away from a selected suggestion", async () => {
    const user = userEvent.setup();
    state.suggestions = [policy];
    render(<SuggestionsPage />);
    await user.click(screen.getByRole("button", { name: /Always validate input/ }));
    expect(screen.getByRole("button", { name: "Review Selected Policy" })).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "Custom policy input" }), "Custom");
    expect(screen.getByRole("button", { name: "Review Custom Policy" })).toBeInTheDocument();
  });

  it("renders conflict details and dispatches each review action", async () => {
    const user = userEvent.setup();
    state.reviewResolution = reviewResolution;
    render(<SuggestionsPage />);
    expect(screen.getByText("Review needed")).toBeInTheDocument();
    expect(screen.getByText("Replace Existing")).toBeInTheDocument();
    expect(screen.getByText("A conflicting policy is already active.")).toBeInTheDocument();
    expect(screen.getByText("The rules disagree.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Keep Reviewing" }));
    expect(actions.clearReview).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Discard New Policy" }));
    expect(actions.discardReviewCandidate).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Delete Old And Add New Policy" }));
    expect(actions.replaceWithReviewCandidate).toHaveBeenCalledOnce();
  });

  it("renders a clean report with fallback rationale and an Add Policy action", () => {
    state.reviewResolution = {
      candidate: {
        ...policy,
        scope_type: "tool",
        scope_id: ["shell", "git"],
      },
      review: {
        findings: [],
        related_policy_ids: [],
        recommendation: "add_policy",
        rationale: "",
      },
      conflictingPolicies: [],
    };
    render(<SuggestionsPage />);
    expect(screen.getByText("All good")).toBeInTheDocument();
    expect(screen.getByText("No duplicate, overlap, or conflict was found.")).toBeInTheDocument();
    expect(screen.getByTitle("tool: shell, git")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add Policy" })).toBeInTheDocument();
  });

  it("restores a custom draft when keeping a review open for editing", async () => {
    const user = userEvent.setup();
    const initial = render(<SuggestionsPage />);
    await user.type(screen.getByRole("textbox", { name: "Custom policy input" }), "Draft rule");
    postActionState.reviewResolution = reviewResolution;
    await user.click(screen.getByRole("button", { name: "Review Custom Policy" }));

    state.reviewResolution = reviewResolution;
    initial.rerender(<SuggestionsPage />);
    await user.click(screen.getByRole("button", { name: "Keep Reviewing" }));
    state.reviewResolution = null;
    initial.rerender(<SuggestionsPage />);
    expect(screen.getByRole("textbox", { name: "Custom policy input" })).toHaveValue("Draft rule");
  });

  it("shows notices, supports dismissal, and auto-clears them", () => {
    vi.useFakeTimers();
    state.notice = "Policy accepted.";
    state.noticePolicy = policy;
    render(<SuggestionsPage />);
    expect(screen.getByRole("status")).toHaveTextContent("Policy accepted.");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
    expect(actions.clearNotice).toHaveBeenCalledOnce();
    actions.clearNotice.mockClear();
    act(() => vi.advanceTimersByTime(5000));
    expect(actions.clearNotice).toHaveBeenCalledOnce();
  });

  it("shows load errors through the shared async boundary", async () => {
    const user = userEvent.setup();
    state.status = "error";
    state.error = "Could not load suggestions";
    render(<SuggestionsPage />);
    expect(screen.getByText("Could not load suggestions")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(actions.load).toHaveBeenCalledTimes(2);
  });
});
