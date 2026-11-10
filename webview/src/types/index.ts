export type Message = {
  id: string;
  sender: "user" | "agent";
  text: string;
  timestamp: number;
};

export type PolicyScope = "global" | "agent" | "tool" | "node";

/**
 * Matches backend PolicyPayload shape one-to-one.
 * - `id` here is the *suggestion id* (for judge-provided policies) or the
 *   stored policy id (for user-custom ones), so it stays optional at write time.
 * - `scope_id` can be a single id (agent/tool) or a list (multi-tool policies).
 * - `metadata` is a free-form map for ownership, priority, tags, etc.
 */
export type PolicyPayload = {
  id: string;
  workflow_id?: string;
  policy: string;
  scope_type: PolicyScope;
  scope_id?: string | string[];
  metadata?: Record<string, unknown>;
  origin?: "judge" | "user";
  status?: "draft" | "pending" | "active";
};

export type PolicyFinding = {
  policy_id: number;
  relationship: "duplicate" | "overlap" | "conflict" | string;
  severity: "low" | "medium" | "high" | string;
  reason: string;
  policy?: string;
};

export type PolicyReview = {
  candidate?: PolicyPayload | null;
  findings: PolicyFinding[];
  related_policy_ids: number[];
  recommendation: string;
  rationale: string;
};

export type PolicyReviewResolution = {
  candidate: PolicyPayload;
  review: PolicyReview;
  conflictingPolicies: PolicyPayload[];
};

export type Session = {
  id: string;
  name: string;
  date: string;
  messageCount: number;
};

export type LogEntry = {
  id: string;
  timestamp: string;
  type: "Success" | "Error" | "Warning" | "Info";
  agent: string;
  message: string;
};

export type SourceRange = {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  startByte?: number;
  endByte?: number;
};

export type GraphNode = {
  id: string;
  label?: string;
  type?: string;
  filePath?: string;
  lineNumber?: number;
  sourceRange?: SourceRange;
  position?: { x: number; y: number };
  data?: { label?: string; [key: string]: unknown };
  properties?: Record<string, unknown>;
};

export type GraphEdge = {
  id: string;
  source: string;
  target: string;
  relationshipType?: string;
  sourceRange?: SourceRange;
  label?: string;
  data?: { relationshipType?: string; label?: string; [key: string]: unknown };
  properties?: Record<string, unknown>;
};

export type RuntimeConfigValues = {
  neo4jUri: string;
  neo4jUser: string;
  neo4jDatabase: string;
  llmProvider: string;
  llmModel: string;
};

export type OpenAiModelOption = {
  id: string;
  ownedBy?: string;
  created?: number;
};

export type RuntimeConfigPayload = {
  isConfigured: boolean;
  isChatConfigured: boolean;
  isNeo4jConfigured: boolean;
  missing: string[];
  chatMissing: string[];
  values: RuntimeConfigValues;
  hasOpenAiApiKey: boolean;
  hasNeo4jPassword: boolean;
};

export type RuntimeConfigSavePayload = RuntimeConfigValues & {
  openAiApiKey?: string;
  neo4jPassword?: string;
  clearOpenAiApiKey?: boolean;
  clearNeo4jPassword?: boolean;
};
