import {
  GraphNode,
  GraphEdge,
  Session,
  LogEntry,
  PolicyPayload,
  RuntimeConfigPayload,
  RuntimeConfigSavePayload,
  OpenAiModelOption,
  PolicyReview,
  SourceRange,
} from './index';

/**
 * Webview -> Host requests.
 * Every request that expects a response carries a `requestId`.
 */
export type HostRequest =
  | { command: 'config.get'; requestId: string }
  | { command: 'config.save'; requestId: string; config: RuntimeConfigSavePayload; deferBackendStart?: boolean }
  | { command: 'config.listModels'; requestId: string; apiKey?: string }
  | { command: 'backend.ensureStarted'; requestId: string }
  | { command: 'graph.get'; requestId: string }
  | { command: 'graph.regenerate'; requestId: string }
  | { command: 'graph.syncForChat' }
  | { command: 'lsp.install'; requestId: string; missing: any[] }
  | { command: 'graph.proceedWithLsp'; requestId: string }
  | { command: 'chat.send'; requestId: string; sessionId: string; text: string }
  | { command: 'judge.getSuggestions'; requestId: string; sessionId?: string }
  | { command: 'abkb.acceptPolicy'; requestId: string; policy: PolicyPayload; deletePolicyIds?: number[]; forceReplace?: boolean }
  | { command: 'abkb.discardPolicy'; requestId: string; policyId: string }
  | { command: 'abkb.addCustomPolicy'; requestId: string; policy: Omit<PolicyPayload, 'id'>; deletePolicyIds?: number[]; forceReplace?: boolean }
  | { command: 'sessions.list'; requestId: string }
  | { command: 'sessions.create'; requestId: string; name: string }
  | { command: 'sessions.rename'; requestId: string; id: string; name: string }
  | { command: 'sessions.delete'; requestId: string; id: string }
  | { command: 'logs.list'; requestId: string }
  | { command: 'state.hydrate'; requestId: string }
  | { command: 'ui.toggleGraphPanel'; requestId: string }
  | { command: 'ui.toggleGraphSidebar'; requestId: string }
  | { command: 'ui.setGraphRelationshipFilters'; enabledRelationships: string[] }
  | { command: 'ui.openGraphPanel' }
  | { command: 'ui.openFullEditor' }
  | { command: 'ui.alert'; text: string }
  | { command: 'ui.info'; text: string };

export type GraphSelectionPayload = {
  id: string;
  label?: string;
  type?: string;
  filePath?: string;
  lineNumber?: number;
  sourceRange?: SourceRange;
} | null;

export type NavigationTarget = 'ask' | 'graph' | 'improve';

/**
 * Host -> Webview responses.
 * `requestId` echoes back the original to correlate.
 * Push messages (e.g. streamed tokens) have no requestId.
 */
export type HostResponse =
  | { command: 'config.state'; requestId: string; config: RuntimeConfigPayload }
  | {
      command: 'config.saved';
      requestId: string;
      config: RuntimeConfigPayload;
      backendStarted: boolean;
      runtimeConfigApplied?: boolean;
      startError?: string;
    }
  | { command: 'config.models'; requestId: string; models: OpenAiModelOption[] }
  | { command: 'backend.ready'; requestId: string }
  | { command: 'graph.data'; requestId?: string; nodes: GraphNode[]; edges: GraphEdge[] }
  | { command: 'graph.lspCheckRequired'; requestId: string; missing: any[] }
  | { command: 'graph.lspCheckPassed'; requestId: string }
  | { command: 'graph.progress'; phase: string; message: string; percent: number; complete?: boolean }
  | { command: 'lsp.installSuccess'; requestId: string }
  | { command: 'chat.response'; requestId: string; sessionId: string; text: string }
  | { command: 'chat.token'; sessionId: string; text: string }
  | { command: 'judge.suggestions'; requestId: string; policies: PolicyPayload[]; selectedId: string | null }
  | { command: 'judge.suggestion'; policy: PolicyPayload }
  | {
      command: 'abkb.updated';
      requestId: string;
      ok: boolean;
      id?: string;
      needsReview?: boolean;
      policy?: PolicyPayload | null;
      review?: PolicyReview;
      conflictingPolicies?: PolicyPayload[];
      activated?: boolean;
      discardedId?: string;
    }
  | { command: 'sessions.data'; requestId: string; sessions: Session[] }
  | { command: 'sessions.created'; requestId: string; session: Session }
  | { command: 'sessions.renamed'; requestId: string; session: Session }
  | { command: 'sessions.deleted'; requestId: string; id: string }
  | { command: 'logs.data'; requestId: string; logs: LogEntry[] }
  | { command: 'logs.append'; log: LogEntry }
  | { command: 'state.hydrated'; requestId: string; hasGraph: boolean }
  | { command: 'ui.graphPanelState'; requestId: string; isOpen: boolean }
  | { command: 'ui.graphSidebarState'; requestId: string; isCollapsed: boolean }
  | { command: 'ui.graphSelectionChanged'; node: GraphSelectionPayload }
  | { command: 'ui.graphRelationshipFiltersChanged'; enabledRelationships: string[]; requestedRelationships?: string[] }
  | { command: 'ui.navigate'; target: NavigationTarget }
  | { command: 'agentResponse'; text: string }
  | { command: 'error'; requestId?: string; code: string; message: string };

/**
 * Distributive variants - these distribute over each member of the union,
 * which is required to keep per-command fields visible to the type checker.
 */
export type RequestWithId = Extract<HostRequest, { requestId: string }>;

export type RequestWithoutId<T extends RequestWithId = RequestWithId> =
  T extends RequestWithId ? Omit<T, 'requestId'> : never;

export type ResponseWithId<T extends HostResponse = HostResponse> =
  T extends { requestId: string } ? T : never;
