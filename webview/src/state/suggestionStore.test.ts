import { beforeEach, describe, expect, it, vi } from "vitest";
import { policy, reviewResolution } from "../test/fixtures";
import type { PolicyReviewResolution } from "../types";

const mocks = vi.hoisted(() => {
  const values = {
    fetchSuggestions: vi.fn(),
    acceptPolicy: vi.fn(),
    addCustomPolicy: vi.fn(),
    discardPolicy: vi.fn(),
    pushHandler: undefined as ((message: any) => void) | undefined,
    onPush: vi.fn(),
  };
  values.onPush.mockImplementation((_command, handler) => {
    values.pushHandler = handler;
    return vi.fn();
  });
  return values;
});

vi.mock("../services/judgeService", () => ({
  fetchSuggestions: mocks.fetchSuggestions,
}));
vi.mock("../services/abkbService", () => ({
  acceptPolicy: mocks.acceptPolicy,
  addCustomPolicy: mocks.addCustomPolicy,
  discardPolicy: mocks.discardPolicy,
}));
vi.mock("../services/host", () => ({ onPush: mocks.onPush }));

import { useSuggestionStore } from "./suggestionStore";

const initialState = useSuggestionStore.getState();

beforeEach(() => {
  mocks.fetchSuggestions.mockReset();
  mocks.acceptPolicy.mockReset();
  mocks.addCustomPolicy.mockReset();
  mocks.discardPolicy.mockReset();
  useSuggestionStore.setState({
    ...initialState,
    suggestions: [],
    selectedId: null,
    reviewResolution: null,
    status: "idle",
    error: null,
    notice: null,
    noticePolicy: null,
  });
});

describe("suggestionStore", () => {
  it("loads suggestions and clears an old review", async () => {
    useSuggestionStore.setState({ reviewResolution });
    mocks.fetchSuggestions.mockResolvedValue({ policies: [policy], selectedId: policy.id });
    await useSuggestionStore.getState().load();
    expect(useSuggestionStore.getState()).toMatchObject({
      suggestions: [policy],
      selectedId: policy.id,
      reviewResolution: null,
      status: "idle",
    });
  });

  it.each([
    [new Error("judge broke"), "judge broke"],
    ["bad", "Failed to load suggestions"],
  ])("records suggestion loading errors", async (failure, error) => {
    mocks.fetchSuggestions.mockRejectedValue(failure);
    await useSuggestionStore.getState().load();
    expect(useSuggestionStore.getState()).toMatchObject({ status: "error", error });
  });

  it("appends a pushed or locally added suggestion", () => {
    useSuggestionStore.getState().addSuggestion(policy);
    expect(useSuggestionStore.getState().suggestions).toEqual([policy]);

    const pushed = { ...policy, id: "pushed" };
    mocks.pushHandler?.({ command: "judge.suggestion", policy: pushed });
    mocks.pushHandler?.({ command: "judge.suggestion", policy: pushed });
    expect(useSuggestionStore.getState().suggestions).toEqual([policy, pushed]);
  });

  it("accepts a suggestion and exposes a success notice", async () => {
    const activated = { ...policy, id: "stored" };
    useSuggestionStore.setState({ suggestions: [policy], error: "old", notice: "old" });
    mocks.acceptPolicy.mockResolvedValue({
      status: "activated",
      id: "stored",
      policy: activated,
    });

    await useSuggestionStore.getState().accept(policy.id);
    expect(mocks.acceptPolicy).toHaveBeenCalledWith(policy);
    expect(useSuggestionStore.getState()).toMatchObject({
      suggestions: [],
      selectedId: "stored",
      reviewResolution: null,
      notice: "Policy accepted.",
      noticePolicy: activated,
      error: null,
    });
  });

  it("uses the original policy if activation omits one", async () => {
    useSuggestionStore.setState({ suggestions: [policy] });
    mocks.acceptPolicy.mockResolvedValue({ status: "activated", id: "stored" });
    await useSuggestionStore.getState().accept(policy.id);
    expect(useSuggestionStore.getState().noticePolicy).toBe(policy);
  });

  it("merges a review candidate into suggestions", async () => {
    const oldCandidate = { ...reviewResolution.candidate, policy: "Old text" };
    useSuggestionStore.setState({ suggestions: [policy, oldCandidate] });
    mocks.acceptPolicy.mockResolvedValue(reviewResolution);
    await useSuggestionStore.getState().accept(policy.id);
    expect(useSuggestionStore.getState()).toMatchObject({
      selectedId: null,
      reviewResolution,
    });
    expect(useSuggestionStore.getState().suggestions).toEqual([
      policy,
      reviewResolution.candidate,
    ]);
  });

  it.each([
    ["missing", undefined, "Policy not found"],
    [policy.id, new Error("accept broke"), "accept broke"],
    [policy.id, "bad", "Failed to accept policy"],
  ])("records invalid and failed accepts", async (id, failure, error) => {
    useSuggestionStore.setState({ suggestions: [policy] });
    if (failure !== undefined) mocks.acceptPolicy.mockRejectedValue(failure);
    await useSuggestionStore.getState().accept(id);
    expect(useSuggestionStore.getState().error).toBe(error);
  });

  it("adds a custom policy with a local fallback object", async () => {
    const custom = { policy: "Custom", scope_type: "tool" as const, scope_id: "shell" };
    mocks.addCustomPolicy.mockResolvedValue({ status: "activated", id: "custom-1" });
    await useSuggestionStore.getState().addCustom(custom);
    expect(mocks.addCustomPolicy).toHaveBeenCalledWith(custom);
    expect(useSuggestionStore.getState()).toMatchObject({
      selectedId: "custom-1",
      suggestions: [],
      notice: "Policy accepted.",
      noticePolicy: { id: "custom-1", ...custom, origin: "user" },
    });
  });

  it("opens a review for custom policy conflicts", async () => {
    mocks.addCustomPolicy.mockResolvedValue(reviewResolution);
    await useSuggestionStore.getState().addCustom({
      policy: "Custom",
      scope_type: "global",
    });
    expect(useSuggestionStore.getState()).toMatchObject({
      reviewResolution,
      selectedId: null,
    });
    expect(useSuggestionStore.getState().suggestions[0]).toEqual(reviewResolution.candidate);
  });

  it.each([
    [new Error("save broke"), "save broke"],
    ["bad", "Failed to save custom policy"],
  ])("records custom policy failures", async (failure, error) => {
    mocks.addCustomPolicy.mockRejectedValue(failure);
    await useSuggestionStore.getState().addCustom({
      policy: "Custom",
      scope_type: "global",
    });
    expect(useSuggestionStore.getState().error).toBe(error);
  });

  it("discards a review candidate and leaves unrelated suggestions", async () => {
    const other = { ...policy, id: "other" };
    useSuggestionStore.setState({
      reviewResolution,
      suggestions: [reviewResolution.candidate, other],
    });
    mocks.discardPolicy.mockResolvedValue(undefined);
    await useSuggestionStore.getState().discardReviewCandidate();
    expect(mocks.discardPolicy).toHaveBeenCalledWith(reviewResolution.candidate.id);
    expect(useSuggestionStore.getState()).toMatchObject({
      suggestions: [other],
      reviewResolution: null,
      selectedId: null,
      notice: "New policy discarded.",
      noticePolicy: null,
    });
  });

  it("does nothing without a review and records discard errors", async () => {
    await useSuggestionStore.getState().discardReviewCandidate();
    expect(mocks.discardPolicy).not.toHaveBeenCalled();

    useSuggestionStore.setState({ reviewResolution });
    mocks.discardPolicy.mockRejectedValue("bad");
    await useSuggestionStore.getState().discardReviewCandidate();
    expect(useSuggestionStore.getState().error).toBe("Failed to discard policy");
  });

  it("force-replaces a draft using custom-policy creation", async () => {
    const draftResolution: PolicyReviewResolution = {
      ...reviewResolution,
      candidate: {
        ...reviewResolution.candidate,
        id: "draft",
        workflow_id: "flow",
        metadata: { owner: "user" },
      },
    };
    useSuggestionStore.setState({ reviewResolution: draftResolution });
    mocks.addCustomPolicy.mockResolvedValue({
      status: "activated",
      id: "stored-draft",
      policy: { ...draftResolution.candidate, id: "stored-draft" },
    });

    await useSuggestionStore.getState().replaceWithReviewCandidate();
    expect(mocks.addCustomPolicy).toHaveBeenCalledWith(
      {
        workflow_id: "flow",
        policy: draftResolution.candidate.policy,
        scope_type: draftResolution.candidate.scope_type,
        scope_id: draftResolution.candidate.scope_id,
        metadata: { owner: "user" },
      },
      { deletePolicyIds: [7], forceReplace: true },
    );
    expect(useSuggestionStore.getState()).toMatchObject({
      selectedId: "stored-draft",
      reviewResolution: null,
      suggestions: [],
      notice: "Policy accepted.",
    });
  });

  it("force-replaces an existing candidate and can receive another review", async () => {
    useSuggestionStore.setState({ reviewResolution });
    const nextReview = {
      ...reviewResolution,
      review: { ...reviewResolution.review, rationale: "Still conflicting" },
    };
    mocks.acceptPolicy.mockResolvedValue(nextReview);
    await useSuggestionStore.getState().replaceWithReviewCandidate();
    expect(mocks.acceptPolicy).toHaveBeenCalledWith(reviewResolution.candidate, {
      deletePolicyIds: [7],
      forceReplace: true,
    });
    expect(useSuggestionStore.getState().reviewResolution).toEqual(nextReview);
  });

  it("does nothing without a replacement review and records replacement errors", async () => {
    await useSuggestionStore.getState().replaceWithReviewCandidate();
    expect(mocks.acceptPolicy).not.toHaveBeenCalled();

    useSuggestionStore.setState({ reviewResolution });
    mocks.acceptPolicy.mockRejectedValue(new Error("replace broke"));
    await useSuggestionStore.getState().replaceWithReviewCandidate();
    expect(useSuggestionStore.getState().error).toBe("replace broke");
  });

  it("clears reviews and notices independently", () => {
    useSuggestionStore.setState({
      reviewResolution,
      notice: "Done",
      noticePolicy: policy,
    });
    useSuggestionStore.getState().clearReview();
    expect(useSuggestionStore.getState().reviewResolution).toBeNull();
    expect(useSuggestionStore.getState().notice).toBe("Done");
    useSuggestionStore.getState().clearNotice();
    expect(useSuggestionStore.getState()).toMatchObject({ notice: null, noticePolicy: null });
  });
});
