import { request } from "./host";
import { PolicyPayload } from "../types";

export async function fetchSuggestions(
  sessionId?: string,
): Promise<{ policies: PolicyPayload[]; selectedId: string | null }> {
  const res = await request<{
    command: "judge.suggestions";
    requestId: string;
    policies: PolicyPayload[];
    selectedId: string | null;
  }>({ command: "judge.getSuggestions", sessionId });
  return { policies: res.policies, selectedId: res.selectedId };
}
