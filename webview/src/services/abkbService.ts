import { request } from "./host";
import { PolicyPayload, PolicyReview, PolicyReviewResolution } from "../types";

type AbkbUpdateResponse = {
  command: "abkb.updated";
  requestId: string;
  ok: boolean;
  id?: string;
  needsReview?: boolean;
  policy?: PolicyPayload | null;
  review?: PolicyReview;
  conflictingPolicies?: PolicyPayload[];
  activated?: boolean;
  discardedId?: string;
};

export type PolicyUpdateResult =
  | { status: "activated"; id: string; policy?: PolicyPayload | null }
  | PolicyReviewResolution;

export async function acceptPolicy(
  policy: PolicyPayload,
  options: { deletePolicyIds?: number[]; forceReplace?: boolean } = {},
): Promise<PolicyUpdateResult> {
  const res = await request<AbkbUpdateResponse>({
    command: "abkb.acceptPolicy",
    policy,
    deletePolicyIds: options.deletePolicyIds,
    forceReplace: options.forceReplace,
  });
  return normalizeUpdateResult(res, policy);
}

export async function addCustomPolicy(
  policy: Omit<PolicyPayload, "id">,
  options: { deletePolicyIds?: number[]; forceReplace?: boolean } = {},
): Promise<PolicyUpdateResult> {
  const res = await request<AbkbUpdateResponse>({
    command: "abkb.addCustomPolicy",
    policy,
    deletePolicyIds: options.deletePolicyIds,
    forceReplace: options.forceReplace,
  });
  return normalizeUpdateResult(res, { id: res.id ?? "", ...policy });
}

export async function discardPolicy(policyId: string): Promise<void> {
  await request<AbkbUpdateResponse>({
    command: "abkb.discardPolicy",
    policyId,
  });
}

function normalizeUpdateResult(
  res: AbkbUpdateResponse,
  fallbackPolicy: PolicyPayload,
): PolicyUpdateResult {
  if (res.needsReview && res.policy && res.review) {
    return {
      candidate: res.policy,
      review: res.review,
      conflictingPolicies: res.conflictingPolicies ?? [],
    };
  }

  return {
    status: "activated",
    id: res.id ?? res.policy?.id ?? fallbackPolicy.id,
    policy: res.policy ?? fallbackPolicy,
  };
}
