import type {
  GraphEdge,
  GraphNode,
  LogEntry,
  PolicyPayload,
  PolicyReviewResolution,
  RuntimeConfigPayload,
  Session,
} from "../types";

export const graphNode: GraphNode = {
  id: "node-1",
  label: "Widget",
  type: "Class",
  filePath: "src/widget.ts",
  lineNumber: 12,
};

export const graphEdge: GraphEdge = {
  id: "edge-1",
  source: "node-1",
  target: "node-2",
  relationshipType: "CALLS",
};

export const session: Session = {
  id: "session-1",
  name: "First session",
  date: "2026-07-21",
  messageCount: 3,
};

export const logEntry: LogEntry = {
  id: "log-1",
  timestamp: "2026-07-21T12:30:00.000Z",
  type: "Info",
  agent: "planner",
  message: "Started",
};

export const policy: PolicyPayload = {
  id: "policy-1",
  policy: "Always validate input.",
  scope_type: "global",
  origin: "judge",
};

export const reviewResolution: PolicyReviewResolution = {
  candidate: { ...policy, id: "candidate-1" },
  review: {
    findings: [
      {
        policy_id: 7,
        relationship: "conflict",
        severity: "high",
        reason: "The rules disagree.",
        policy: "Skip validation.",
      },
    ],
    related_policy_ids: [7],
    recommendation: "replace_existing",
    rationale: "A conflicting policy is already active.",
  },
  conflictingPolicies: [
    {
      id: "7",
      policy: "Skip validation.",
      scope_type: "global",
    },
  ],
};

export const configuredRuntime: RuntimeConfigPayload = {
  isConfigured: true,
  isChatConfigured: true,
  isNeo4jConfigured: true,
  missing: [],
  chatMissing: [],
  values: {
    neo4jUri: "bolt://localhost:7687",
    neo4jUser: "neo4j",
    neo4jDatabase: "neo4j",
    llmProvider: "openai",
    llmModel: "gpt-4o-mini",
  },
  hasOpenAiApiKey: true,
  hasNeo4jPassword: true,
};

export const unconfiguredRuntime: RuntimeConfigPayload = {
  ...configuredRuntime,
  isConfigured: false,
  isChatConfigured: false,
  isNeo4jConfigured: false,
  missing: ["LLM provider"],
  chatMissing: ["LLM provider", "Neo4j password", "OpenAI API key"],
  hasOpenAiApiKey: false,
  hasNeo4jPassword: false,
};
