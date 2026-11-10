import { create } from "zustand";
import { PolicyPayload, PolicyReviewResolution } from "../types";
import { fetchSuggestions } from "../services/judgeService";
import {
  acceptPolicy,
  addCustomPolicy,
  discardPolicy,
} from "../services/abkbService";
import { onPush } from "../services/host";
import { HostResponse } from "../types/messaging";

type Status = "idle" | "loading" | "error";

interface SuggestionState {
  suggestions: PolicyPayload[];
  selectedId: string | null;
  reviewResolution: PolicyReviewResolution | null;
  status: Status;
  error: string | null;
  notice: string | null;
  noticePolicy: PolicyPayload | null;
  load: () => Promise<void>;
  addSuggestion: (s: PolicyPayload) => void;
  accept: (id: string) => Promise<void>;
  addCustom: (policy: Omit<PolicyPayload, "id">) => Promise<void>;
  discardReviewCandidate: () => Promise<void>;
  replaceWithReviewCandidate: () => Promise<void>;
  clearReview: () => void;
  clearNotice: () => void;
}

export const useSuggestionStore = create<SuggestionState>((set, get) => ({
  suggestions: [],
  selectedId: null,
  reviewResolution: null,
  status: "idle",
  error: null,
  notice: null,
  noticePolicy: null,

  load: async () => {
    set({ status: "loading", error: null });
    try {
      const data = await fetchSuggestions();
      set({
        suggestions: data.policies,
        selectedId: data.selectedId,
        reviewResolution: null,
        status: "idle",
      });
    } catch (e) {
      set({
        status: "error",
        error: e instanceof Error ? e.message : "Failed to load suggestions",
      });
    }
  },

  addSuggestion: (s) =>
    set((state) => ({ suggestions: [...state.suggestions, s] })),

  accept: async (id: string) => {
    try {
      set({ error: null, notice: null, noticePolicy: null });
      const policy = get().suggestions.find((s) => s.id === id);
      if (!policy) throw new Error("Policy not found");
      const result = await acceptPolicy(policy);
      if ("review" in result) {
        set({
          reviewResolution: result,
          suggestions: mergePolicy(get().suggestions, result.candidate),
          selectedId: null,
        });
        return;
      }
      const activated = result.policy ?? policy;
      set({
        selectedId: result.id,
        suggestions: [],
        reviewResolution: null,
        notice: "Policy accepted.",
        noticePolicy: activated,
      });
    } catch (e) {
      set({
        error: e instanceof Error ? e.message : "Failed to accept policy",
      });
    }
  },

  addCustom: async (policy: Omit<PolicyPayload, "id">) => {
    try {
      set({ error: null, notice: null, noticePolicy: null });
      const result = await addCustomPolicy(policy);
      if ("review" in result) {
        set({
          reviewResolution: result,
          suggestions: mergePolicy(get().suggestions, result.candidate),
          selectedId: null,
        });
        return;
      }
      const local: PolicyPayload = result.policy ?? {
        id: result.id,
        ...policy,
        origin: "user",
      };
      set({
        selectedId: result.id,
        suggestions: [],
        reviewResolution: null,
        notice: "Policy accepted.",
        noticePolicy: local,
      });
    } catch (e) {
      set({
        error: e instanceof Error ? e.message : "Failed to save custom policy",
      });
    }
  },

  discardReviewCandidate: async () => {
    const resolution = get().reviewResolution;
    if (!resolution) return;
    try {
      set({ error: null, notice: null, noticePolicy: null });
      await discardPolicy(resolution.candidate.id);
      set((state) => ({
        suggestions: state.suggestions.filter(
          (policy) => policy.id !== resolution.candidate.id,
        ),
        reviewResolution: null,
        selectedId: null,
        notice: "New policy discarded.",
        noticePolicy: null,
      }));
    } catch (e) {
      set({
        error: e instanceof Error ? e.message : "Failed to discard policy",
      });
    }
  },

  replaceWithReviewCandidate: async () => {
    const resolution = get().reviewResolution;
    if (!resolution) return;
    try {
      set({ error: null, notice: null, noticePolicy: null });
      const deletePolicyIds = resolution.review.related_policy_ids;
      const result =
        resolution.candidate.id === "draft"
          ? await addCustomPolicy(
              {
                workflow_id: resolution.candidate.workflow_id,
                policy: resolution.candidate.policy,
                scope_type: resolution.candidate.scope_type,
                scope_id: resolution.candidate.scope_id,
                metadata: resolution.candidate.metadata,
              },
              {
                deletePolicyIds,
                forceReplace: true,
              },
            )
          : await acceptPolicy(resolution.candidate, {
              deletePolicyIds,
              forceReplace: true,
            });
      if ("review" in result) {
        set({ reviewResolution: result });
        return;
      }
      const activated = result.policy ?? resolution.candidate;
      set({
        selectedId: result.id,
        suggestions: [],
        reviewResolution: null,
        notice: "Policy accepted.",
        noticePolicy: activated,
      });
    } catch (e) {
      set({
        error: e instanceof Error ? e.message : "Failed to replace policy",
      });
    }
  },

  clearReview: () => set({ reviewResolution: null }),
  clearNotice: () => set({ notice: null, noticePolicy: null }),
}));

function mergePolicy(
  policies: PolicyPayload[],
  next: PolicyPayload,
): PolicyPayload[] {
  if (policies.some((policy) => policy.id === next.id)) {
    return policies.map((policy) => (policy.id === next.id ? next : policy));
  }
  return [next, ...policies];
}

type JudgeSuggestionPush = Extract<
  HostResponse,
  { command: "judge.suggestion" }
>;

onPush<JudgeSuggestionPush>("judge.suggestion", (msg) => {
  useSuggestionStore.setState((state) => {
    if (state.suggestions.some((policy) => policy.id === msg.policy.id)) {
      return state;
    }
    return {
      ...state,
      suggestions: [...state.suggestions, msg.policy],
    };
  });
});
