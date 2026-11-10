import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { createHash } from "crypto";
import neo4j from "neo4j-driver";
import { BackendClient } from "./backendClient";
import {
  BackendHandle,
  BackendProcessManager,
  BackendProgressReporter,
} from "./BackendProcess";
import { readConfig, onConfigChange } from "./config";
import {
  getBackendEnv,
  getRuntimeConfigState,
  getStoredNeo4jPassword,
  getStoredOpenAiApiKey,
  RuntimeConfigInput,
  RuntimeConfigState,
  saveRuntimeConfig,
} from "./runtimeConfig";
import { RepositoryScanner } from "../scanner/RepositoryScanner";
import { TreeSitterManager } from "../parser/TreeSitterManager";
import { CodeAnalyzer } from "../parser/CodeAnalyzer";
import { GraphBuilder } from "../graph/GraphBuilder";
import { JsonExporter } from "../exporter/JsonExporter";
import { GraphPanel } from "../viewer/GraphPanel";
import { Graph, ResolutionRequest } from "../models/Graph";
import { LspPreflight, LspProfile } from "../parser/LspPreflight";

// --- Incremental update wiring (Batch 5) ---
import {
  IncrementalGraphUpdater,
  INCREMENTAL_FILE_NAMES,
  FileChangeEvent,
} from "../graph/IncrementalGraphUpdater";
import { GraphChangeWatcher } from "./GraphChangeWatcher";
import { GraphLedgerStore } from "../exporter/GraphLedgerStore";
import {
  GraphLedger,
  LedgerEntry,
  createEmptyLedger,
} from "../models/GraphLedger";
import { DeltaBatch } from "../models/GraphDelta";

type AnyMessage = { command: string; requestId?: string; [k: string]: unknown };

const CHAT_STREAM_INACTIVITY_TIMEOUT_MS = 120_000;
const GRAPH_PROGRESS_STEP = 2;
const GRAPH_PROGRESS_INTERVAL_MS = 80;
const SMOOTH_GRAPH_PROGRESS_PHASES = new Set([
  "structural_analysis",
  "lsp_check",
  "lsp_installing",
  "lsp_installed",
  "semantic_analysis",
  "complete",
]);

interface MockSession {
  id: string;
  name: string;
  date: string;
  messageCount: number;
}

interface OpenAiModelOption {
  id: string;
  ownedBy?: string;
  created?: number;
}

interface OpenAiModelRecord {
  id?: unknown;
  owned_by?: unknown;
  created?: unknown;
}

interface OpenAiModelsResponse {
  data?: OpenAiModelRecord[];
}

interface BackendSuggestion {
  id: string;
  title: string;
  description: string;
  steps: string[];
  policy_payload: {
    workflow_id: string;
    policy: string;
    scope_type: "global" | "agent" | "tool" | "node";
    scope_id?: string | string[] | null;
    metadata?: Record<string, unknown> | null;
  };
}

export class HostMessageRouter {
  private readonly SESSIONS_KEY = "sessions";

  private client: BackendClient;
  private configDisposable: vscode.Disposable;
  private assistantWebview?: vscode.Webview;

  // Tree-sitter pipeline - lazily initialized on first graph request.
  private treeSitter?: TreeSitterManager;
  private analyzer?: CodeAnalyzer;
  private scanner?: RepositoryScanner;
  private builder?: GraphBuilder;
  private exporter = new JsonExporter();

  // --- Incremental update pipeline (Batch 5) ---
  private ledgerStore = new GraphLedgerStore();
  private incrementalUpdater?: IncrementalGraphUpdater;
  private graphChangeWatcher?: GraphChangeWatcher;
  private cachedGraph?: Graph;
  private graphProgressStatus?: vscode.Disposable;
  private graphProgressTimer?: NodeJS.Timeout;
  private graphProgressDisplayedPercent = 0;
  private graphProgressTarget?: {
    webview: vscode.Webview | undefined;
    phase: string;
    message: string;
    percent: number;
    complete: boolean;
  };
  private graphProgressCurrentPhase = "structural_analysis";
  private graphProgressCurrentMessage = "Preparing project scan...";
  private graphProgressCompletionWaiters: Array<() => void> = [];
  private lastGraphProgress?: {
    phase: string;
    message: string;
    percent: number;
    complete: boolean;
  };
  private runtimeConfigApplyTimer?: NodeJS.Timeout;
  private pendingRuntimeConfigGraphSeed = false;
  private savingRuntimeConfig = false;
  private readonly developmentLogging: boolean;
  private incrementalUpdatesSuspended = false;
  private neo4jBaselineReady = false;

  private pendingGraphContext?: {
    graph: Graph;
    requests: ResolutionRequest[];
    files: vscode.Uri[];
    folder: vscode.WorkspaceFolder;
  };
  private existingGraphLoadPromise?: Promise<boolean>;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly ensureBackendStarted?: (
      onProgress?: BackendProgressReporter,
    ) => Promise<BackendHandle | undefined>,
    private readonly getRunningBackend?: () => BackendHandle | undefined,
  ) {
    this.developmentLogging =
      context.extensionMode === vscode.ExtensionMode.Development;
    this.client = new BackendClient(readConfig());
    this.logDevelopment("Development diagnostics enabled.");
    this.configDisposable = onConfigChange((cfg) => {
      this.client.updateConfig(cfg);
    });
    context.subscriptions.push(this.configDisposable);
    context.subscriptions.push(
      GraphPanel.onDidChangeSelection((node) => {
        void this.assistantWebview?.postMessage({
          command: "ui.graphSelectionChanged",
          node,
        });
      }),
    );
    context.subscriptions.push(
      GraphPanel.onDidChangeRelationshipFilters((enabledRelationships) => {
        void this.assistantWebview?.postMessage({
          command: "ui.graphRelationshipFiltersChanged",
          enabledRelationships,
        });
      }),
    );

    // React to `selfEvolvingAgent.graph.incrementalUpdates` toggle at runtime.
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration(async (evt) => {
        if (
          !evt.affectsConfiguration(
            "selfEvolvingAgent.graph.incrementalUpdates",
          )
        )
          return;

        if (!this.isIncrementalEnabled()) {
          this.disposeIncrementalPipeline();
          return;
        }

        const folders = vscode.workspace.workspaceFolders;
        if (!folders?.length || !this.cachedGraph) return;
        await this.rebuildLedgerAndStartWatcher(folders[0], this.cachedGraph);
      }),
    );
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((evt) => {
        if (this.savingRuntimeConfig) return;
        if (!this.affectsBackendRuntimeConfig(evt)) return;
        this.scheduleRuntimeConfigApply({
          seedGraph: this.affectsNeo4jRuntimeConfig(evt),
        });
      }),
    );

    if (!this.context.workspaceState.get<MockSession[]>(this.SESSIONS_KEY)) {
      this.context.workspaceState.update(this.SESSIONS_KEY, [
        {
          id: "1",
          name: "Refactor Auth Module",
          date: "2023-10-24",
          messageCount: 14,
        },
        {
          id: "2",
          name: "Generate Graph Demo",
          date: "2023-10-25",
          messageCount: 5,
        },
      ]);
    }
  }

  // ---------- Public entry used by command palette ----------
  public async generateGraphFromCommand(): Promise<void> {
    vscode.commands.executeCommand("selfEvolvingAgent.openFullEditor");
  }

  public async loadExistingWorkspaceGraph(
    webview?: vscode.Webview,
  ): Promise<void> {
    if (this.existingGraphLoadPromise) {
      if (webview) {
        const activeProgress = this.lastGraphProgress;
        this.pushGraphProgress(
          webview,
          "startup_seed",
          "Checking whether a local Project Graph already exists...",
          24,
        );
        if (
          activeProgress &&
          activeProgress.percent < 100 &&
          activeProgress.message !==
            "Checking whether a local Project Graph already exists..."
        ) {
          this.pushGraphProgress(
            webview,
            activeProgress.phase,
            activeProgress.message,
            activeProgress.percent,
          );
        } else {
          this.pushGraphProgress(
            webview,
            "startup_seed",
            "Startup Project Graph sync is already running...",
            32,
          );
        }
        const loaded = await this.existingGraphLoadPromise;
        this.pushGraphProgress(
          webview,
          loaded ? "local_graph" : "startup_seed",
          loaded
            ? "Saved Project Graph loaded locally."
            : "No saved Project Graph found; preparing a fresh scan.",
          loaded ? 100 : 34,
        );
        return;
      }
      await this.existingGraphLoadPromise;
      return;
    }

    this.existingGraphLoadPromise = this.loadExistingWorkspaceGraphOnce(
      webview ?? this.assistantWebview,
    ).finally(() => {
      this.existingGraphLoadPromise = undefined;
    });

    await this.existingGraphLoadPromise;
  }

  // ---------- Webview message dispatcher ----------
  public async handle(msg: AnyMessage, webview: vscode.Webview): Promise<void> {
    this.assistantWebview = webview;

    try {
      switch (msg.command) {
        case "config.get": {
          const config = await getRuntimeConfigState(this.context);
          this.reply(webview, msg, { command: "config.state", config });
          return;
        }
        case "config.save": {
          const input = (msg.config ?? {}) as RuntimeConfigInput;
          const deferBackendStart = msg.deferBackendStart === true;
          await this.validateRuntimeConfigInput(input, {
            validateConnections: !deferBackendStart,
          });
          this.savingRuntimeConfig = true;
          let config: RuntimeConfigState;
          try {
            config = await saveRuntimeConfig(this.context, input);
          } finally {
            this.savingRuntimeConfig = false;
          }
          this.cancelRuntimeConfigApplyTimer();
          const runtimeConfigApplied = deferBackendStart
            ? false
            : await this.applyRuntimeConfigIfBackendReady();
          this.reply(webview, msg, {
            command: "config.saved",
            config,
            backendStarted: false,
            runtimeConfigApplied,
          });
          return;
        }
        case "config.listModels": {
          await this.handleConfigListModels(webview, msg);
          return;
        }
        case "backend.ensureStarted": {
          await this.suspendIncrementalUpdates();
          let keepSuspendedForInitialUpload = false;
          try {
            this.pushGraphProgress(
              webview,
              "backend_starting",
              "Preparing the local assistant...",
              0,
              false,
            );
            await this.ensureBackendConnection((progress) => {
              this.pushGraphProgress(
                webview,
                "backend_starting",
                progress.message,
                progress.percent,
                false,
              );
            });
            keepSuspendedForInitialUpload = (
              await getRuntimeConfigState(this.context)
            ).isChatConfigured;
            this.pushGraphProgress(
              webview,
              "backend_starting",
              "Project Assistant is ready.",
              100,
              !keepSuspendedForInitialUpload,
            );
          } catch (error) {
            this.pushGraphProgress(
              webview,
              "backend_starting",
              "Project Assistant could not start.",
              100,
              true,
            );
            throw error;
          } finally {
            if (!keepSuspendedForInitialUpload) {
              await this.resumeIncrementalUpdates();
            }
          }
          this.reply(webview, msg, { command: "backend.ready" });
          return;
        }
        case "ui.openGraphPanel": {
          if (!(await this.hasWorkspaceGraph())) return;
          const panel = GraphPanel.createOrShow(this.context.extensionPath);
          await panel.loadFromWorkspace();
          return;
        }
        case "ui.toggleGraphPanel": {
          if (GraphPanel.isOpen()) {
            GraphPanel.closeCurrent();
            this.reply(webview, msg, {
              command: "ui.graphPanelState",
              isOpen: false,
            });
            return;
          }
          if (!(await this.hasWorkspaceGraph())) {
            this.reply(webview, msg, {
              command: "ui.graphPanelState",
              isOpen: false,
            });
            return;
          }
          const panel = GraphPanel.createOrShow(this.context.extensionPath);
          await panel.loadFromWorkspace();
          this.reply(webview, msg, {
            command: "ui.graphPanelState",
            isOpen: true,
          });
          return;
        }
        case "ui.toggleGraphSidebar": {
          if (!(await this.hasWorkspaceGraph())) {
            this.reply(webview, msg, {
              command: "ui.graphSidebarState",
              isCollapsed: true,
            });
            return;
          }
          const wasOpen = GraphPanel.isOpen();
          const panel = GraphPanel.createOrShow(this.context.extensionPath);
          const isCollapsed = panel.toggleSidebar();
          if (!wasOpen) await panel.loadFromWorkspace();
          this.reply(webview, msg, {
            command: "ui.graphSidebarState",
            isCollapsed,
          });
          return;
        }
        case "ui.setGraphRelationshipFilters": {
          const enabledRelationships = Array.isArray(msg.enabledRelationships)
            ? msg.enabledRelationships.filter(
                (item): item is string => typeof item === "string",
              )
            : [];
          GraphPanel.setRelationshipFilters(enabledRelationships);
          return;
        }
        case "ui.openFullEditor":
          vscode.commands.executeCommand("selfEvolvingAgent.openFullEditor");
          return;
        case "ui.alert":
          return;
        case "ui.info":
          vscode.window.showInformationMessage(String(msg.text ?? ""));
          return;
        case "state.hydrate":
          await this.loadExistingWorkspaceGraph(webview);
          this.reply(webview, msg, {
            command: "state.hydrated",
            hasGraph: await this.hasWorkspaceGraph(),
          });
          return;
        case "graph.get":
          await this.handleGraphGet(webview, msg);
          return;
        case "graph.regenerate":
          await this.handleGraphRegenerate(webview, msg);
          return;
        case "graph.syncForChat":
          await this.seedCurrentGraphForNeo4jSettings(webview);
          return;
        case "lsp.install":
          await this.handleLspInstall(webview, msg);
          return;
        case "graph.proceedWithLsp":
          await this.handleGraphProceed(webview, msg);
          return;
        case "chat.send":
          await this.handleChatSend(webview, msg);
          return;
        case "judge.getSuggestions":
          await this.handleJudgeSuggestions(webview, msg);
          return;
        case "abkb.acceptPolicy":
        case "abkb.addCustomPolicy":
        case "abkb.discardPolicy":
          await this.handleAbkbUpdate(webview, msg);
          return;
        case "sessions.list":
          this.handleSessionsList(webview, msg);
          return;
        case "sessions.create":
          await this.handleSessionsCreate(webview, msg);
          return;
        case "sessions.rename":
          await this.handleSessionsRename(webview, msg);
          return;
        case "sessions.delete":
          await this.handleSessionsDelete(webview, msg);
          return;
        case "logs.list":
          await this.handleLogsList(webview, msg);
          return;
        default:
          if (msg.requestId) {
            this.replyError(
              webview,
              msg,
              "UNKNOWN_COMMAND",
              `Unknown command: ${msg.command}`,
            );
          }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (msg.requestId)
        this.replyError(webview, msg, "INTERNAL_ERROR", message);
      else {
        return;
      }
    }
  }

  // ---------- Config handlers ----------

  private async validateRuntimeConfigInput(
    input: RuntimeConfigInput,
    options: { validateConnections?: boolean } = {},
  ): Promise<void> {
    const provider = this.requiredConfigText(
      input.llmProvider,
      "LLM provider",
    ).toLowerCase();
    this.requiredConfigText(input.llmModel, "Agent model");
    if (options.validateConnections === false) return;

    const typedOpenAiApiKey = this.cleanSecret(input.openAiApiKey);
    const availableOpenAiApiKey = input.clearOpenAiApiKey
      ? undefined
      : typedOpenAiApiKey ?? (await getStoredOpenAiApiKey(this.context));
    const neo4jUri = this.cleanSecret(input.neo4jUri);
    const neo4jUser = this.cleanSecret(input.neo4jUser);
    const neo4jDatabase = this.cleanSecret(input.neo4jDatabase);
    const typedNeo4jPassword = this.cleanSecret(input.neo4jPassword);
    const neo4jPassword =
      input.clearNeo4jPassword
        ? undefined
        : typedNeo4jPassword ?? (await getStoredNeo4jPassword(this.context));

    const shouldValidateNeo4j = Boolean(
      neo4jPassword &&
        (typedNeo4jPassword || provider !== "openai" || availableOpenAiApiKey),
    );
    if (shouldValidateNeo4j && neo4jPassword) {
      await this.validateNeo4jConnection({
        uri: this.requiredConfigText(neo4jUri, "Neo4j URI"),
        user: this.requiredConfigText(neo4jUser, "Neo4j user"),
        password: neo4jPassword,
        database: this.requiredConfigText(neo4jDatabase, "Neo4j database"),
      });
    }

    if (provider === "openai" && typedOpenAiApiKey) {
      try {
        await this.fetchOpenAiModels(typedOpenAiApiKey);
      } catch {
        throw new Error("Incorrect API key.");
      }
    }
  }

  private async validateNeo4jConnection({
    uri,
    user,
    password,
    database,
  }: {
    uri: string;
    user: string;
    password: string;
    database: string;
  }): Promise<void> {
    const driver = neo4j.driver(uri, neo4j.auth.basic(user, password), {
      connectionTimeout: 5000,
      maxConnectionPoolSize: 1,
    });
    const session = driver.session({ database });
    try {
      await session.run("RETURN 1 AS ok");
    } catch (e) {
      throw new Error(this.summarizeNeo4jError(e));
    } finally {
      await session.close().catch(() => undefined);
      await driver.close().catch(() => undefined);
    }
  }

  private requiredConfigText(value: unknown, label: string): string {
    const text = typeof value === "string" ? value.trim() : "";
    if (!text) throw new Error(`Enter ${label}.`);
    return text;
  }

  private cleanSecret(value: unknown): string | undefined {
    const text = typeof value === "string" ? value.trim() : "";
    return text || undefined;
  }

  private async handleConfigListModels(
    webview: vscode.Webview,
    msg: AnyMessage,
  ): Promise<void> {
    const typedKey = typeof msg.apiKey === "string" ? msg.apiKey.trim() : "";
    const apiKey = typedKey || (await getStoredOpenAiApiKey(this.context));

    if (!apiKey) {
      this.replyError(
        webview,
        msg,
        "NO_OPENAI_API_KEY",
        "Enter or save an OpenAI API key first.",
      );
      return;
    }

    try {
      const models = await this.fetchOpenAiModels(apiKey);
      this.reply(webview, msg, { command: "config.models", models });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.replyError(webview, msg, "OPENAI_MODELS_ERROR", message);
    }
  }

  private async applyRuntimeConfigIfBackendReady(
    backend: BackendHandle | undefined = this.getRunningBackend?.(),
  ): Promise<boolean> {
    if (this.client.isMock()) return false;

    try {
      if (!backend) return false;
      this.client.connect(backend.baseUrl, backend.authToken);
      const env = await getBackendEnv(this.context);
      await backend.updateRuntimeConfig(env);
      return true;
    } catch {
      return false;
    }
  }

  private scheduleRuntimeConfigApply(
    options: { seedGraph?: boolean } = {},
  ): void {
    if (options.seedGraph) {
      this.pendingRuntimeConfigGraphSeed = true;
      this.neo4jBaselineReady = false;
    }
    this.cancelRuntimeConfigApplyTimer({ keepPendingSeed: true });
    this.runtimeConfigApplyTimer = setTimeout(() => {
      this.runtimeConfigApplyTimer = undefined;
      const seedGraph = this.pendingRuntimeConfigGraphSeed;
      this.pendingRuntimeConfigGraphSeed = false;
      void this.applyRuntimeConfigIfBackendReady().then(() => {
        if (seedGraph) {
          void this.seedCurrentGraphForNeo4jSettings(this.assistantWebview);
        }
      });
    }, 500);
  }

  private cancelRuntimeConfigApplyTimer(
    options: { keepPendingSeed?: boolean } = {},
  ): void {
    if (this.runtimeConfigApplyTimer) {
      clearTimeout(this.runtimeConfigApplyTimer);
      this.runtimeConfigApplyTimer = undefined;
    }
    if (!options.keepPendingSeed) {
      this.pendingRuntimeConfigGraphSeed = false;
    }
  }

  private affectsBackendRuntimeConfig(
    evt: vscode.ConfigurationChangeEvent,
  ): boolean {
    return [
      "selfEvolvingAgent.neo4j.uri",
      "selfEvolvingAgent.neo4j.user",
      "selfEvolvingAgent.neo4j.database",
      "selfEvolvingAgent.llm.provider",
      "selfEvolvingAgent.llm.model",
      "selfEvolvingAgent.telemetry.enabled",
      "selfEvolvingAgent.telemetry.externalJudgeEnabled",
    ].some((key) => evt.affectsConfiguration(key));
  }

  private affectsNeo4jRuntimeConfig(
    evt: vscode.ConfigurationChangeEvent,
  ): boolean {
    return [
      "selfEvolvingAgent.neo4j.uri",
      "selfEvolvingAgent.neo4j.user",
      "selfEvolvingAgent.neo4j.database",
    ].some((key) => evt.affectsConfiguration(key));
  }

  private async fetchOpenAiModels(
    apiKey: string,
  ): Promise<OpenAiModelOption[]> {
    const response = await fetch("https://api.openai.com/v1/models", {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const raw = await response.text();

    if (!response.ok) {
      throw new Error(
        this.summarizeOpenAiError(raw, response.statusText, response.status),
      );
    }

    let parsed: OpenAiModelsResponse;
    try {
      parsed = JSON.parse(raw) as OpenAiModelsResponse;
    } catch {
      throw new Error("OpenAI returned an unreadable models response.");
    }

    const seen = new Set<string>();
    const models = (Array.isArray(parsed.data) ? parsed.data : [])
      .map((item): OpenAiModelOption | null => {
        const id = typeof item.id === "string" ? item.id.trim() : "";
        if (!id || seen.has(id)) return null;
        seen.add(id);
        return {
          id,
          ownedBy:
            typeof item.owned_by === "string" ? item.owned_by : undefined,
          created: typeof item.created === "number" ? item.created : undefined,
        };
      })
      .filter((item): item is OpenAiModelOption => item !== null)
      .sort((a, b) => this.compareOpenAiModels(a, b));

    if (models.length === 0)
      throw new Error("OpenAI returned no models for this API key.");
    return models;
  }

  private compareOpenAiModels(
    a: OpenAiModelOption,
    b: OpenAiModelOption,
  ): number {
    const rankDifference =
      this.openAiModelRank(a.id) - this.openAiModelRank(b.id);
    if (rankDifference !== 0) return rankDifference;
    return a.id.localeCompare(b.id);
  }

  private openAiModelRank(id: string): number {
    const lower = id.toLowerCase();
    if (lower.startsWith("gpt-") || lower.startsWith("o")) return 0;
    if (lower.includes("chat") || lower.includes("responses")) return 1;
    if (lower.includes("realtime")) return 2;
    if (lower.includes("embedding")) return 4;
    if (
      lower.includes("whisper") ||
      lower.includes("tts") ||
      lower.includes("transcribe") ||
      lower.includes("image")
    )
      return 5;
    return 3;
  }

  private summarizeOpenAiError(
    raw: string,
    fallback: string,
    status?: number,
  ): string {
    if (status === 401 || status === 403) return "Incorrect API key.";
    if (status === 429) return "OpenAI rate limit reached. Try again later.";
    if (status && status >= 500)
      return "OpenAI is temporarily unavailable. Try again later.";
    const trimmed = raw.trim();
    if (!trimmed) return fallback || "Could not validate OpenAI API key.";

    try {
      const parsed = JSON.parse(trimmed) as { error?: { message?: unknown } };
      if (
        typeof parsed.error?.message === "string" &&
        parsed.error.message.trim()
      ) {
        return this.sanitizeExternalError(
          parsed.error.message.trim(),
          "Could not validate OpenAI API key.",
        );
      }
    } catch {
      /* fall through */
    }

    return this.sanitizeExternalError(
      trimmed,
      "Could not validate OpenAI API key.",
    );
  }

  private summarizeNeo4jError(error: unknown): string {
    const record = error as { code?: unknown; message?: unknown };
    const code = typeof record.code === "string" ? record.code : "";
    const message =
      typeof record.message === "string" ? record.message : String(error);
    const lower = `${code} ${message}`.toLowerCase();

    if (lower.includes("unauthorized") || lower.includes("authentication"))
      return "Incorrect Neo4j username or password.";
    if (lower.includes("database") && lower.includes("not found"))
      return "Neo4j database was not found.";
    if (
      lower.includes("serviceunavailable") ||
      lower.includes("connection") ||
      lower.includes("econnrefused")
    ) {
      return "Could not connect to Neo4j. Check the URI and make sure Neo4j is running.";
    }
    return this.sanitizeExternalError(
      message,
      "Could not validate Neo4j settings.",
    );
  }

  private sanitizeExternalError(message: string, fallback: string): string {
    const sanitized = message
      .replace(/https?:\/\/\S+/g, "")
      .replace(/\s+/g, " ")
      .trim();
    return sanitized ? sanitized.slice(0, 220) : fallback;
  }

  // ---------- Graph handlers (REAL pipeline) ----------

  private ensurePipeline(): void {
    if (!this.treeSitter) {
      this.treeSitter = new TreeSitterManager(this.context.extensionPath);
      this.analyzer = new CodeAnalyzer(this.treeSitter);
      this.scanner = new RepositoryScanner();
      this.builder = new GraphBuilder(this.scanner, this.analyzer);
    }
  }

  private async hasWorkspaceGraph(): Promise<boolean> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      await this.context.workspaceState.update("hasGraph", false);
      return false;
    }
    const fileName = vscode.workspace
      .getConfiguration("selfEvolvingAgent")
      .get<string>("graph.jsonFileName", ".code-knowledge-graph.json");
    const graph = await this.exporter.tryLoad(folders[0], fileName);
    const hasGraph = Boolean(graph && graph.nodes.length > 0);
    await this.context.workspaceState.update("hasGraph", hasGraph);
    return hasGraph;
  }

  private async handleGraphGet(webview: vscode.Webview, msg: AnyMessage) {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      this.reply(webview, msg, { command: "graph.data", nodes: [], edges: [] });
      return;
    }
    const fileName = vscode.workspace
      .getConfiguration("selfEvolvingAgent")
      .get<string>("graph.jsonFileName", ".code-knowledge-graph.json");
    const graph = await this.exporter.tryLoad(folders[0], fileName);
    await this.context.workspaceState.update(
      "hasGraph",
      Boolean(graph && graph.nodes.length > 0),
    );
    this.reply(webview, msg, {
      command: "graph.data",
      nodes: graph?.nodes ?? [],
      edges: graph?.edges ?? [],
    });
  }

  private async handleGraphRegenerate(
    webview: vscode.Webview,
    msg: AnyMessage,
  ) {
    try {
      const folders = vscode.workspace.workspaceFolders;
      if (!folders || folders.length === 0)
        throw new Error("Open a workspace folder first.");
      const folder = folders[0];
      this.ensurePipeline();

      this.pendingGraphContext = undefined;
      this.pushGraphProgress(
        webview,
        "structural_analysis",
        "Preparing project scan...",
        0,
      );

      const { graph, requests, files } = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Scanning project files",
          cancellable: false,
        },
        async (progress) =>
          this.builder!.buildStructuralGraph(
            folder,
            this.createGraphProgress(
              webview,
              progress,
              "structural_analysis",
              4,
              58,
              100,
            ),
          ),
      );

      this.pendingGraphContext = { graph, requests, files, folder };

      this.pushGraphProgress(
        webview,
        "lsp_check",
        "Checking project language support...",
        60,
      );
      const preflight = new LspPreflight();
      const preflightResult = await preflight.check(files, folder);

      if (preflightResult.missing.length > 0) {
        this.reply(webview, msg, {
          command: "graph.lspCheckRequired",
          missing: preflightResult.missing,
        });
      } else {
        this.reply(webview, msg, { command: "graph.lspCheckPassed" });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.replyError(webview, msg, "INTERNAL_ERROR", message);
    }
  }

  private async handleLspInstall(webview: vscode.Webview, msg: AnyMessage) {
    const missing = msg.missing as LspProfile[];
    if (!missing || missing.length === 0) return;

    try {
      const total = Math.max(missing.length, 1);
      for (let i = 0; i < missing.length; i++) {
        const m = missing[i];
        this.pushGraphProgress(
          webview,
          "lsp_installing",
          `Installing project support: ${m.displayName ?? m.extensionId}`,
          62 + Math.round((i / total) * 10),
        );
        await vscode.commands.executeCommand(
          "workbench.extensions.installExtension",
          m.extensionId,
        );
      }

      let allInstalled = true;
      for (const m of missing) {
        const ext = await this.waitForExtension(m.extensionId);
        if (!ext) {
          allInstalled = false;
          continue;
        }
        if (!ext.isActive) {
          try {
            await ext.activate();
          } catch {
          }
        }
      }

      if (allInstalled) {
        this.pushGraphProgress(
          webview,
          "lsp_installed",
          "Project support installed.",
          74,
        );
        this.reply(webview, msg, { command: "lsp.installSuccess" });
      } else {
        this.replyError(
          webview,
          msg,
          "INSTALL_FAILED",
          "Some extensions failed to install.",
        );
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.replyError(webview, msg, "INSTALL_ERROR", message);
    }
  }

  private async handleGraphProceed(webview: vscode.Webview, msg: AnyMessage) {
    if (!this.pendingGraphContext) {
      this.replyError(
        webview,
        msg,
        "NO_CONTEXT",
        "No pending graph context found.",
      );
      return;
    }

    try {
      const { graph, requests, files, folder } = this.pendingGraphContext;
      const fileName = vscode.workspace
        .getConfiguration("selfEvolvingAgent")
        .get<string>("graph.jsonFileName", ".code-knowledge-graph.json");

      this.pushGraphProgress(
        webview,
        "semantic_analysis",
        "Resolving project relationships...",
        76,
      );
      const finalGraph = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Finding project connections",
          cancellable: false,
        },
        async (progress) =>
          this.builder!.buildSemanticGraph(
            graph,
            requests,
            files,
            this.createGraphProgress(
              webview,
              progress,
              "semantic_analysis",
              76,
              98,
              100,
            ),
          ),
      );

      const uri = await this.exporter.exportSilently(
        finalGraph,
        folder,
        fileName,
      );
      await this.context.workspaceState.update("hasGraph", true);

      if (GraphPanel.currentPanel) {
        GraphPanel.currentPanel.updateGraph(finalGraph);
      }

      this.cachedGraph = finalGraph;
      this.neo4jBaselineReady = false;
      vscode.window.showInformationMessage(
        `Project scan complete: ${vscode.workspace.asRelativePath(uri)} (${finalGraph.nodes.length} items)`,
      );
      // Cache and (re)start the incremental pipeline.
      await this.rebuildLedgerAndStartWatcher(folder, finalGraph);

      this.pushGraphProgress(
        webview,
        "complete",
        "Project Graph is ready.",
        100,
      );
      await this.waitForVisibleGraphCompletion();

      this.reply(webview, msg, {
        command: "graph.data",
        nodes: finalGraph.nodes,
        edges: finalGraph.edges,
      });

      this.pendingGraphContext = undefined;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.replyError(webview, msg, "INTERNAL_ERROR", message);
    }
  }

  private createGraphProgress(
    webview: vscode.Webview,
    nativeProgress: vscode.Progress<{ message?: string; increment?: number }>,
    phase: string,
    startPercent: number,
    endPercent: number,
    expectedIncrementTotal: number,
  ): vscode.Progress<{ message?: string; increment?: number }> {
    let percent = startPercent;
    const span = Math.max(endPercent - startPercent, 0);
    return {
      report: (update) => {
        nativeProgress.report(update);
        if (
          typeof update.increment === "number" &&
          expectedIncrementTotal > 0
        ) {
          percent = Math.min(
            endPercent,
            percent + update.increment * (span / expectedIncrementTotal),
          );
        }
        this.pushGraphProgress(
          webview,
          phase,
          update.message ?? "Working on the Project Graph...",
          percent,
        );
      },
    };
  }

  private pushGraphProgress(
    webview: vscode.Webview | undefined,
    phase: string,
    message: string,
    percent: number,
    complete: boolean = percent >= 100,
  ): void {
    const normalizedPercent = Math.max(0, Math.min(100, Math.round(percent)));
    if (SMOOTH_GRAPH_PROGRESS_PHASES.has(phase)) {
      this.queueSmoothGraphProgress(
        webview,
        phase,
        message,
        normalizedPercent,
        complete,
      );
      return;
    }
    this.emitGraphProgress(
      webview,
      phase,
      message,
      normalizedPercent,
      complete,
    );
  }

  private queueSmoothGraphProgress(
    webview: vscode.Webview | undefined,
    phase: string,
    message: string,
    percent: number,
    complete: boolean,
  ): void {
    if (phase === "structural_analysis" && percent === 0) {
      this.clearGraphProgressTimer();
      this.resolveGraphProgressCompletionWaiters();
      this.graphProgressDisplayedPercent = 0;
      this.graphProgressCurrentPhase = phase;
      this.graphProgressCurrentMessage = message;
      this.graphProgressTarget = undefined;
      this.emitGraphProgress(webview, phase, message, 0, false);
      return;
    }

    if (!complete) {
      this.graphProgressCurrentPhase = phase;
      this.graphProgressCurrentMessage = message;
    }
    this.graphProgressTarget = {
      webview,
      phase,
      message,
      percent: Math.max(percent, this.graphProgressDisplayedPercent),
      complete,
    };

    if (percent <= this.graphProgressDisplayedPercent) {
      this.emitGraphProgress(webview, phase, message, percent, complete);
      if (complete && percent >= 100) {
        this.resolveGraphProgressCompletionWaiters();
      }
      return;
    }

    if (!this.graphProgressTimer) {
      this.graphProgressTimer = setInterval(
        () => this.advanceSmoothGraphProgress(),
        GRAPH_PROGRESS_INTERVAL_MS,
      );
    }
  }

  private advanceSmoothGraphProgress(): void {
    const target = this.graphProgressTarget;
    if (!target) {
      this.clearGraphProgressTimer();
      return;
    }

    const nextPercent = Math.min(
      target.percent,
      this.graphProgressDisplayedPercent + GRAPH_PROGRESS_STEP,
    );
    this.graphProgressDisplayedPercent = nextPercent;
    const reachedCompleteTarget =
      target.complete && nextPercent >= target.percent && nextPercent >= 100;
    const phase = reachedCompleteTarget
      ? target.phase
      : target.complete
        ? this.graphProgressCurrentPhase
        : target.phase;
    const message = reachedCompleteTarget
      ? target.message
      : target.complete
        ? this.graphProgressCurrentMessage
        : target.message;
    this.emitGraphProgress(
      target.webview,
      phase,
      message,
      nextPercent,
      reachedCompleteTarget,
    );

    if (nextPercent < target.percent) return;
    this.clearGraphProgressTimer();
    if (reachedCompleteTarget) {
      this.resolveGraphProgressCompletionWaiters();
    }
  }

  private waitForVisibleGraphCompletion(): Promise<void> {
    if (this.graphProgressDisplayedPercent >= 100) return Promise.resolve();
    return new Promise((resolve) => {
      this.graphProgressCompletionWaiters.push(resolve);
    });
  }

  private resolveGraphProgressCompletionWaiters(): void {
    const waiters = this.graphProgressCompletionWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  private clearGraphProgressTimer(): void {
    if (!this.graphProgressTimer) return;
    clearInterval(this.graphProgressTimer);
    this.graphProgressTimer = undefined;
  }

  private emitGraphProgress(
    webview: vscode.Webview | undefined,
    phase: string,
    message: string,
    normalizedPercent: number,
    complete: boolean,
  ): void {
    this.lastGraphProgress = {
      phase,
      message,
      percent: normalizedPercent,
      complete,
    };
    const targetWebview = webview ?? this.assistantWebview;
    void targetWebview?.postMessage({
      command: "graph.progress",
      phase,
      message,
      percent: normalizedPercent,
      complete,
    });
    this.updateGraphStatusBar(message, normalizedPercent);
  }

  private updateGraphStatusBar(message: string, percent: number): void {
    this.graphProgressStatus?.dispose();
    this.graphProgressStatus = undefined;

    if (percent >= 100) {
      const icon = /fail|failed|attention|error/i.test(message)
        ? "$(warning)"
        : "$(check)";
      vscode.window.setStatusBarMessage(`${icon} ${message}`, 5000);
      return;
    }

    this.graphProgressStatus = vscode.window.setStatusBarMessage(
      `$(sync~spin) ${message}`,
    );
  }

  // ---------- Chat handler ----------

  private async handleChatSend(webview: vscode.Webview, msg: AnyMessage) {
    const sessionId = String(msg.sessionId);
    const text = String(msg.text ?? "");
    const body = { user_id: "local-user", session_id: sessionId, text };
    const traceId = createHash("sha256")
      .update(`${msg.requestId ?? "chat"}:${sessionId}`)
      .digest("hex")
      .slice(0, 10);
    const startedAt = Date.now();

    if (this.client.isMock()) {
      this.logDevelopment("chat.mock.start", {
        traceId,
        inputChars: text.length,
      });
      await this.streamMockChat(webview, msg, sessionId, text);
      this.logDevelopment("chat.mock.complete", {
        traceId,
        elapsedMs: Date.now() - startedAt,
      });
      return;
    }

    try {
      const runtimeConfig = await getRuntimeConfigState(this.context);
      if (!runtimeConfig.isChatConfigured) {
        throw new Error("Configure an OpenAI API key in Settings to enable chat.");
      }

      this.logDevelopment("chat.request.start", {
        traceId,
        inputChars: text.length,
        provider: runtimeConfig.values.llmProvider,
        model: runtimeConfig.values.llmModel,
      });

      const answerParts: string[] = [];
      let completed = false;
      let chunkCount = 0;
      let outputChars = 0;

      const backend = await this.ensureBackendConnection();
      this.logDevelopment("chat.backend.ready", {
        traceId,
        pid: backend?.pid,
        elapsedMs: Date.now() - startedAt,
      });
      await this.applyRuntimeConfigIfBackendReady(backend);
      this.logDevelopment("chat.runtime_config.applied", {
        traceId,
        elapsedMs: Date.now() - startedAt,
      });
      await this.client.streamEvents(
        "/chatbot/chat/stream",
        body,
        (event) => {
          if (event.event === "chunk") {
            const chunk =
              typeof event.data.text === "string" ? event.data.text : "";
            if (!chunk) return;
            chunkCount += 1;
            outputChars += chunk.length;
            if (chunkCount === 1) {
              this.logDevelopment("chat.first_token", {
                traceId,
                elapsedMs: Date.now() - startedAt,
              });
            }
            answerParts.push(chunk);
            void webview.postMessage({
              command: "chat.token",
              sessionId,
              text: chunk,
            });
            return;
          }
          if (event.event === "start" || event.event === "status") {
            this.logDevelopment(`chat.stream.${event.event}`, {
              traceId,
              path:
                typeof event.data.path === "string"
                  ? event.data.path
                  : undefined,
              triageClass:
                typeof event.data.triage_class === "string"
                  ? event.data.triage_class
                  : undefined,
              elapsedMs: Date.now() - startedAt,
            });
            return;
          }
          if (event.event === "done") {
            completed = true;
            return;
          }
          if (event.event === "error") {
            const message =
              typeof event.data.error === "string"
                ? event.data.error
                : "Chat streaming failed before completion.";
            throw new Error(message);
          }
        },
        { inactivityTimeoutMs: CHAT_STREAM_INACTIVITY_TIMEOUT_MS },
      );

      if (!completed) throw new Error("Chat stream ended before completion.");

      const answer = answerParts.join("");
      this.logDevelopment("chat.request.complete", {
        traceId,
        elapsedMs: Date.now() - startedAt,
        chunks: chunkCount,
        outputChars,
      });
      this.reply(webview, msg, {
        command: "chat.response",
        sessionId,
        text: answer.trim() ? answer : "No response generated.",
      });
    } catch (error) {
      this.logDevelopment("chat.request.failed", {
        traceId,
        elapsedMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      if (this.developmentLogging) BackendProcessManager.showOutput();
      throw error;
    }
  }

  private async streamMockChat(
    webview: vscode.Webview,
    msg: AnyMessage,
    sessionId: string,
    text: string,
  ): Promise<void> {
    const answer = `Mock agent reply to: "${text}"`;
    for (const chunk of this.chunkText(answer, 24)) {
      await this.delay(35);
      void webview.postMessage({
        command: "chat.token",
        sessionId,
        text: chunk,
      });
    }
    this.reply(webview, msg, {
      command: "chat.response",
      sessionId,
      text: answer,
    });
  }

  private chunkText(text: string, size: number): string[] {
    const safeSize = Math.max(1, size);
    const chunks: string[] = [];
    for (let index = 0; index < text.length; index += safeSize) {
      chunks.push(text.slice(index, index + safeSize));
    }
    return chunks;
  }

  private async getDb() {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return null;
    const dbPath = path.join(folders[0].uri.fsPath, "policies.db");
    const initSqlJs = require("sql.js/dist/sql-asm.js");
    const SQL = await initSqlJs();

    let db;
    if (fs.existsSync(dbPath)) {
      const filebuffer = fs.readFileSync(dbPath);
      db = new SQL.Database(filebuffer);
      try {
        db.run("ALTER TABLE policies ADD COLUMN origin TEXT");
      } catch {
        /* column exists */
      }
    } else {
      db = new SQL.Database();
      db.run(`
        CREATE TABLE IF NOT EXISTS policies (
          id TEXT PRIMARY KEY,
          workflow_id TEXT,
          policy TEXT NOT NULL,
          scope_type TEXT NOT NULL,
          scope_id TEXT,
          origin TEXT
        );
      `);
      const data = db.export();
      fs.writeFileSync(dbPath, Buffer.from(data));
    }
    return { db, dbPath };
  }

  private saveDb(db: any, dbPath: string) {
    const data = db.export();
    fs.writeFileSync(dbPath, Buffer.from(data));
  }

  private async handleJudgeSuggestions(
    webview: vscode.Webview,
    msg: AnyMessage,
  ) {
    const mockSuggestions = async (): Promise<{
      suggestions: BackendSuggestion[];
    }> => {
      return { suggestions: [] };
    };

    const data = this.client.isMock()
      ? await mockSuggestions()
      : await this.streamJudgeSuggestions(webview, msg);

    const policies = data.suggestions.map((s) => ({
      id: s.id,
      workflow_id: s.policy_payload.workflow_id,
      policy: s.policy_payload.policy,
      scope_type: s.policy_payload.scope_type,
      scope_id: s.policy_payload.scope_id ?? undefined,
      metadata: s.policy_payload.metadata ?? undefined,
      origin: "judge" as const,
    }));

    this.reply(webview, msg, {
      command: "judge.suggestions",
      policies,
      selectedId: null,
    });
  }

  private async streamJudgeSuggestions(
    webview: vscode.Webview,
    msg: AnyMessage,
  ): Promise<{ suggestions: BackendSuggestion[] }> {
    const suggestions: BackendSuggestion[] = [];
    await this.ensureBackendConnection();
    await this.client.streamEvents(
      "/admin/judge/suggestions/stream",
      {
        sessionId: msg.sessionId ?? null,
        workflow_id: "vscode-codegraph-chatbot",
        run_judge: true,
      },
      (event) => {
        if (event.event === "suggestion") {
          const suggestion = event.data.suggestion as
            | BackendSuggestion
            | undefined;
          if (!suggestion) return;
          suggestions.push(suggestion);
          void webview.postMessage({
            command: "judge.suggestion",
            policy: this.backendSuggestionToPolicy(suggestion),
          });
          return;
        }
        if (event.event === "done") {
          const finalSuggestions = event.data.suggestions;
          if (Array.isArray(finalSuggestions)) {
            suggestions.splice(
              0,
              suggestions.length,
              ...(finalSuggestions as BackendSuggestion[]),
            );
          }
          return;
        }
        if (event.event === "error") {
          const message =
            typeof event.data.error === "string"
              ? event.data.error
              : "ABKB judge stream failed.";
          throw new Error(message);
        }
      },
    );
    return { suggestions };
  }

  private backendSuggestionToPolicy(s: {
    id: string;
    policy_payload: {
      workflow_id: string;
      policy: string;
      scope_type: "global" | "agent" | "tool" | "node";
      scope_id?: string | string[] | null;
      metadata?: Record<string, unknown> | null;
    };
  }) {
    return {
      id: s.id,
      workflow_id: s.policy_payload.workflow_id,
      policy: s.policy_payload.policy,
      scope_type: s.policy_payload.scope_type,
      scope_id: s.policy_payload.scope_id ?? undefined,
      metadata: s.policy_payload.metadata ?? undefined,
      origin: "judge" as const,
    };
  }

  private async handleAbkbUpdate(webview: vscode.Webview, msg: AnyMessage) {
    const isAccept = msg.command === "abkb.acceptPolicy";
    const isDiscard = msg.command === "abkb.discardPolicy";
    const path = isDiscard
      ? "/admin/abkb/discard"
      : isAccept
        ? "/admin/abkb/accept"
        : "/admin/abkb/custom";

    let body: unknown;

    if (isDiscard) {
      body = { policyId: String(msg.policyId ?? "") };
    } else if (isAccept) {
      const policy = msg.policy as { id?: string } | undefined;
      body = {
        policyId: String(policy?.id ?? ""),
        delete_policy_ids: Array.isArray(msg.deletePolicyIds)
          ? msg.deletePolicyIds
          : [],
        force_replace: Boolean(msg.forceReplace),
      };
    } else {
      const p = (msg.policy ?? {}) as {
        workflow_id?: string;
        policy?: string;
        scope_type?: "global" | "agent" | "tool" | "node";
        scope_id?: string | string[];
        metadata?: Record<string, unknown>;
      };

      const backendScope: "global" | "agent" | "tool" | "node" =
        p.scope_type ?? "global";

      body = {
        payload: {
          workflow_id: p.workflow_id ?? "vscode-codegraph-chatbot",
          policy: String(p.policy ?? "")
            .replace(/\n/g, " ")
            .trim(),
          scope_type: backendScope,
          scope_id: backendScope === "global" ? null : (p.scope_id ?? null),
          metadata: p.metadata ?? null,
        },
        delete_policy_ids: Array.isArray(msg.deletePolicyIds)
          ? msg.deletePolicyIds
          : [],
        force_replace: Boolean(msg.forceReplace),
      };
    }

    type AbkbUpdateResult = {
      ok: boolean;
      policy?: { id?: string } | null;
      needs_review?: boolean;
      review?: unknown;
      conflicting_policies?: unknown[];
      activated?: boolean;
      discarded_id?: string;
    };

    const mockResult = async (): Promise<AbkbUpdateResult> => {
      await this.delay(200);
      return { ok: true, policy: { id: `mock_${Date.now()}` } };
    };
    const result = this.client.isMock()
      ? await mockResult()
      : await this.callBackendRequired<AbkbUpdateResult>(path, body);

    this.reply(webview, msg, {
      command: "abkb.updated",
      ok: result.ok,
      id: result.policy?.id,
      needsReview: result.needs_review,
      policy: result.policy ?? undefined,
      review: result.review,
      conflictingPolicies: result.conflicting_policies,
      activated: result.activated,
      discardedId: result.discarded_id,
    });
  }

  private handleSessionsList(webview: vscode.Webview, msg: AnyMessage) {
    const sessions = this.context.workspaceState.get<MockSession[]>(
      this.SESSIONS_KEY,
      [],
    );
    this.reply(webview, msg, { command: "sessions.data", sessions });
  }

  private async handleSessionsCreate(webview: vscode.Webview, msg: AnyMessage) {
    const sessions = this.context.workspaceState.get<MockSession[]>(
      this.SESSIONS_KEY,
      [],
    );
    const session: MockSession = {
      id: Date.now().toString(),
      name: String(msg.name ?? "Untitled Session"),
      date: new Date().toISOString().slice(0, 10),
      messageCount: 0,
    };
    await this.context.workspaceState.update(this.SESSIONS_KEY, [
      session,
      ...sessions,
    ]);
    this.reply(webview, msg, { command: "sessions.created", session });
  }

  private async handleSessionsRename(webview: vscode.Webview, msg: AnyMessage) {
    const sessions = this.context.workspaceState.get<MockSession[]>(
      this.SESSIONS_KEY,
      [],
    );
    const id = String(msg.id);
    const updated = sessions.map((s) =>
      s.id === id ? { ...s, name: String(msg.name ?? s.name) } : s,
    );
    await this.context.workspaceState.update(this.SESSIONS_KEY, updated);
    const session = updated.find((s) => s.id === id);
    if (!session) {
      this.replyError(webview, msg, "NOT_FOUND", `Session ${id} not found`);
      return;
    }
    this.reply(webview, msg, { command: "sessions.renamed", session });
  }

  private async handleSessionsDelete(webview: vscode.Webview, msg: AnyMessage) {
    const sessions = this.context.workspaceState.get<MockSession[]>(
      this.SESSIONS_KEY,
      [],
    );
    const id = String(msg.id);
    const filtered = sessions.filter((s) => s.id !== id);
    await this.context.workspaceState.update(this.SESSIONS_KEY, filtered);
    this.reply(webview, msg, { command: "sessions.deleted", id });
  }

  private async handleLogsList(webview: vscode.Webview, msg: AnyMessage) {
    const data = await this.tryBackend<{ logs: unknown[] }>(
      "/logs",
      {},
      async () => ({
        logs: [
          {
            id: "1",
            timestamp: new Date().toISOString(),
            type: "Info",
            agent: "System",
            message: "Initialized mock OTEL pipeline",
          },
          {
            id: "2",
            timestamp: new Date().toISOString(),
            type: "Success",
            agent: "GraphEngine",
            message: "Graph successfully generated.",
          },
        ],
      }),
    );
    this.reply(webview, msg, { command: "logs.data", logs: data.logs });
  }

  private async loadExistingWorkspaceGraphOnce(
    webview?: vscode.Webview,
  ): Promise<boolean> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return false;

    if (webview) {
      this.pushGraphProgress(
        webview,
        "startup_seed",
        "Checking whether a local Project Graph already exists...",
        24,
      );
    }

    const fileName = vscode.workspace
      .getConfiguration("selfEvolvingAgent")
      .get<string>("graph.jsonFileName", ".code-knowledge-graph.json");
    const graph = await this.exporter.tryLoad(folders[0], fileName);
    if (!graph || graph.nodes.length === 0) {
      await this.context.workspaceState.update("hasGraph", false);
      if (webview) {
        this.pushGraphProgress(
          webview,
          "startup_seed",
          "No saved Project Graph found; preparing a fresh scan.",
          34,
        );
      }
      return false;
    }

    if (webview) {
      this.pushGraphProgress(
        webview,
        "startup_seed",
        "Saved Project Graph found. Loading it locally...",
        70,
      );
    }
    await this.context.workspaceState.update("hasGraph", true);
    this.cachedGraph = graph;
    if (webview) {
      this.pushGraphProgress(
        webview,
        "local_graph",
        "Saved Project Graph loaded locally.",
        100,
      );
    }

    // Start (or refresh) the incremental watcher for the loaded graph.
    await this.rebuildLedgerAndStartWatcher(folders[0], graph);
    return true;
  }

  private async seedGraph(
    graph: Graph,
    options: {
      fileName?: string;
      source?: "scan" | "activation" | "hydrate" | "settings";
      notifyOnFailure?: boolean;
      webview?: vscode.Webview;
      progressEndPercent?: number;
    } = {},
  ): Promise<void> {
    const source = options.source ?? "scan";
    const fileName = options.fileName ?? ".code-knowledge-graph.json";
    const notifyOnFailure = options.notifyOnFailure ?? true;
    const progressEnd = options.progressEndPercent ?? 100;
    const runtimeConfig = await getRuntimeConfigState(this.context);

    if (!runtimeConfig.isChatConfigured) {
      this.pushGraphProgress(
        options.webview,
        "local_graph",
        "Project Graph is ready locally. Complete OpenAI and Neo4j settings to enable chat sync.",
        progressEnd,
      );
      await this.resumeIncrementalUpdates();
      return;
    }

    if (this.client.isMock()) {
      this.pushGraphProgress(
        options.webview,
        "neo4j_export",
        "Project Graph sync is unavailable in preview mode.",
        progressEnd,
      );
      await this.resumeIncrementalUpdates();
      return;
    }

    const status = vscode.window.setStatusBarMessage(
      source === "scan"
        ? "$(sync~spin) Seeding code graph for chat..."
        : source === "settings"
          ? "$(sync~spin) Syncing Project Graph to Neo4j..."
          : "$(sync~spin) Loading saved code graph into Neo4j...",
    );

    // Freeze file processing before taking the full-upload baseline. The
    // watcher continues collecting edits and flushes them as deltas only
    // after Neo4j has received this complete baseline.
    await this.suspendIncrementalUpdates();
    this.neo4jBaselineReady = false;
    this.incrementalUpdater?.beginFullScan();

    let activePhase = "backend_starting";
    try {
      if (this.getRunningBackend?.()) {
        await this.ensureBackendConnection();
      } else {
        this.pushGraphProgress(
          options.webview,
          "backend_starting",
          "Preparing the local assistant...",
          0,
          false,
        );
        await this.ensureBackendConnection((progress) => {
          this.pushGraphProgress(
            options.webview,
            "backend_starting",
            progress.message,
            progress.percent,
            false,
          );
        });
        this.pushGraphProgress(
          options.webview,
          "backend_starting",
          "Project Assistant is ready.",
          100,
          false,
        );
      }
      if (source === "activation" || source === "hydrate") {
        this.pushGraphProgress(
          options.webview,
          "startup_seed",
          "Checking saved Project Graph for code changes...",
          100,
          false,
        );
      }
      activePhase = "neo4j_export";
      this.pushGraphProgress(
        options.webview,
        "neo4j_export",
        `Preparing to upload ${graph.nodes.length} nodes and ${graph.edges.length} relationships to Neo4j...`,
        0,
        false,
      );
      type SeedResult = {
        message?: string;
        nodes_upserted?: number;
        edges_upserted?: number;
        database?: string;
      };
      let result: SeedResult | undefined;
      let uploadError: Error | undefined;
      await this.client.uploadJsonFileEvents(
        "/graphrag/api/seed/stream",
        fileName,
        graph,
        {
          database: runtimeConfig.values.neo4jDatabase,
          wipe: true,
        },
        (event) => {
          if (event.event === "progress") {
            const percent =
              typeof event.data.percent === "number"
                ? event.data.percent
                : 0;
            const message =
              typeof event.data.message === "string"
                ? event.data.message
                : "Uploading Project Graph to Neo4j...";
            this.pushGraphProgress(
              options.webview,
              "neo4j_export",
              message,
              percent,
              false,
            );
          } else if (event.event === "done") {
            result = event.data as SeedResult;
          } else if (event.event === "error") {
            uploadError = new Error(
              typeof event.data.message === "string"
                ? event.data.message
                : "Neo4j upload failed.",
            );
          }
        },
      );
      if (uploadError) throw uploadError;
      if (!result) {
        throw new Error("Neo4j upload ended without a completion result.");
      }
      this.pushGraphProgress(
        options.webview,
        "neo4j_export",
        "Project Graph upload to Neo4j is complete.",
        progressEnd,
        true,
      );
      this.neo4jBaselineReady = true;
      vscode.window.setStatusBarMessage(
        `$(database) Code graph seeded for chat (${result.nodes_upserted ?? graph.nodes.length} nodes)`,
        5000,
      );
    } catch (e) {
      this.pushGraphProgress(
        options.webview,
        activePhase,
        activePhase === "backend_starting"
          ? "Project Assistant could not start."
          : "Project Graph upload to Neo4j failed.",
        100,
        true,
      );
      const message = e instanceof Error ? e.message : String(e);
      if (notifyOnFailure) {
        void message;
      }
    } finally {
      status.dispose();
      this.incrementalUpdater?.endFullScan();
      await this.resumeIncrementalUpdates();
    }
  }

  private async seedCurrentGraphForNeo4jSettings(
    webview?: vscode.Webview,
  ): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      await this.resumeIncrementalUpdates();
      return;
    }

    const runtimeConfig = await getRuntimeConfigState(this.context);
    if (!runtimeConfig.isChatConfigured) {
      await this.resumeIncrementalUpdates();
      return;
    }

    const fileName = vscode.workspace
      .getConfiguration("selfEvolvingAgent")
      .get<string>("graph.jsonFileName", ".code-knowledge-graph.json");
    const graph =
      this.cachedGraph ?? (await this.exporter.tryLoad(folders[0], fileName));
    if (!graph || graph.nodes.length === 0) {
      await this.resumeIncrementalUpdates();
      return;
    }

    this.cachedGraph = graph;
    await this.seedGraph(graph, {
      fileName,
      source: "settings",
      notifyOnFailure: true,
      webview,
      progressEndPercent: 100,
    });
  }

  // ==================================================================
  // Incremental update wiring (Batch 5)
  // ==================================================================

  /**
   * True if the user has opted into (or hasn't opted out of) incremental
   * graph updates. Default is enabled.
   */
  private isIncrementalEnabled(): boolean {
    return vscode.workspace
      .getConfiguration("selfEvolvingAgent")
      .get<boolean>("graph.incrementalUpdates", true);
  }

  /**
   * (Re)start the incremental pipeline for a freshly-seeded or freshly-
   * loaded graph. Reuses an on-disk ledger if it's consistent, else
   * rebuilds one from the graph. Safe to call repeatedly.
   */
  private async rebuildLedgerAndStartWatcher(
    folder: vscode.WorkspaceFolder,
    graph: Graph,
  ): Promise<void> {
    if (!this.isIncrementalEnabled()) {
      this.disposeIncrementalPipeline();
      return;
    }

    try {
      this.ensurePipeline();

      const existingLedger = await this.ledgerStore.tryLoad(
        folder,
        INCREMENTAL_FILE_NAMES.ledger,
      );
      const ledger =
        existingLedger && this.ledgerLooksConsistent(existingLedger, graph)
          ? existingLedger
          : await this.buildLedgerFromGraph(graph);
      await this.ledgerStore.save(
        ledger,
        folder,
        INCREMENTAL_FILE_NAMES.ledger,
      );

      this.incrementalUpdater = new IncrementalGraphUpdater(
        this.scanner!,
        this.builder!,
        {
          patchBackend: async (batch: DeltaBatch) => {
            const runtimeConfig = await getRuntimeConfigState(this.context);
            this.pushGraphProgress(
              this.assistantWebview,
              "incremental_sync",
              `Sending ${batch.totals.nodesAdded + batch.totals.nodesRemoved} node changes and ${batch.totals.edgesAdded + batch.totals.edgesRemoved} relationship changes to Neo4j...`,
              72,
            );
            await this.ensureBackendConnection();
            await this.client.call("/graphrag/api/patch", {
              ...batch,
              database: runtimeConfig.values.neo4jDatabase,
            });
          },
          isBackendMocked: async () =>
            this.client.isMock() ||
            !this.neo4jBaselineReady ||
            !(await getRuntimeConfigState(this.context)).isChatConfigured,
          onUpdateStart: (n) => {
            this.pushGraphProgress(
              this.assistantWebview,
              "incremental_update",
              `Updating Project Graph from ${n} changed file${n === 1 ? "" : "s"}...`,
              18,
            );
          },
          onLocalUpdateComplete: () => {
            this.pushGraphProgress(
              this.assistantWebview,
              "incremental_update",
              "Project Graph updated locally. Preparing Neo4j sync...",
              58,
            );
          },
          onBackendPatchAttempted: (r) => {
            if (!r.attempted) {
              this.pushGraphProgress(
                this.assistantWebview,
                "incremental_update",
                "Project Graph updated locally.",
                100,
              );
              return;
            }
            if (r.attempted && !r.success) {
              this.pushGraphProgress(
                this.assistantWebview,
                "incremental_sync",
                "Project Graph updated locally, but Neo4j sync needs attention.",
                100,
              );
              return;
            }
            if (r.attempted) {
              this.pushGraphProgress(
                this.assistantWebview,
                "incremental_sync",
                "Project Graph changes synced to Neo4j.",
                100,
              );
            }
          },
          onUpdateSkipped: (n) => {
            this.pushGraphProgress(
              this.assistantWebview,
              "incremental_update",
              `Checked ${n} changed file${n === 1 ? "" : "s"}; Project Graph is already current.`,
              100,
            );
          },
          broadcastGraphUpdate: (g) => {
            this.cachedGraph = g;
            if (GraphPanel.currentPanel) {
              GraphPanel.currentPanel.updateGraph(g);
            }
            void this.assistantWebview?.postMessage({
              command: "graph.data",
              nodes: g.nodes,
              edges: g.edges,
            });
          },
        },
      );

      this.disposeWatcherOnly();
      this.graphChangeWatcher = new GraphChangeWatcher(
        folder,
        this.scanner!,
        async (wsFolder, changes: FileChangeEvent[]) => {
          if (!this.cachedGraph) return;
          await this.incrementalUpdater!.enqueue(
            wsFolder,
            this.cachedGraph,
            changes,
          );
        },
      );
      this.graphChangeWatcher.start();
      if (this.incrementalUpdatesSuspended) {
        this.graphChangeWatcher.pause();
      }
      this.context.subscriptions.push(this.graphChangeWatcher);
    } catch {
    }
  }

  private ledgerLooksConsistent(ledger: GraphLedger, graph: Graph): boolean {
    const filePathsInGraph = new Set<string>();
    for (const n of graph.nodes) {
      const filePath = (n as any).filePath as string | undefined;
      if (filePath) filePathsInGraph.add(filePath);
    }
    const ledgerFiles = Object.keys(ledger.entries);
    if (ledgerFiles.length === 0) return false;

    let matches = 0;
    for (const f of ledgerFiles) if (filePathsInGraph.has(f)) matches++;
    return matches / ledgerFiles.length >= 0.6;
  }

  private async buildLedgerFromGraph(graph: Graph): Promise<GraphLedger> {
    const ledger = createEmptyLedger();

    const nodesByFile = new Map<string, string[]>();
    for (const n of graph.nodes) {
      const filePath = (n as any).filePath as string | undefined;
      if (!filePath) continue;
      const arr = nodesByFile.get(filePath) ?? [];
      arr.push(n.id);
      nodesByFile.set(filePath, arr);
    }

    const nodeIdToFile = new Map<string, string>();
    for (const n of graph.nodes) {
      const filePath = (n as any).filePath as string | undefined;
      if (filePath) nodeIdToFile.set(n.id, filePath);
    }

    const edgesByFile = new Map<string, string[]>();
    for (const e of graph.edges) {
      const owner = nodeIdToFile.get(e.source);
      if (!owner) continue;
      const arr = edgesByFile.get(owner) ?? [];
      arr.push(e.id);
      edgesByFile.set(owner, arr);
    }

    for (const [filePath, nodeIds] of nodesByFile) {
      const hash = await this.hashFileSafe(filePath);
      const entry: LedgerEntry = {
        filePath,
        contentHash: hash ?? "",
        lastModified: Date.now(),
        nodeIds,
        edgeIds: edgesByFile.get(filePath) ?? [],
        exportedSymbols: [],
        importedFiles: [],
        dependents: [],
      };
      ledger.entries[filePath] = entry;
    }

    return ledger;
  }

  private async hashFileSafe(fsPath: string): Promise<string | undefined> {
    try {
      const uri = vscode.Uri.file(fsPath);
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(bytes).toString("utf8").replace(/\r\n/g, "\n");
      return createHash("sha256").update(text).digest("hex");
    } catch {
      return undefined;
    }
  }

  private disposeWatcherOnly(): void {
    if (this.graphChangeWatcher) {
      this.graphChangeWatcher.dispose();
      this.graphChangeWatcher = undefined;
    }
  }

  private disposeIncrementalPipeline(): void {
    this.disposeWatcherOnly();
    this.incrementalUpdater = undefined;
  }

  private async suspendIncrementalUpdates(): Promise<void> {
    this.incrementalUpdatesSuspended = true;
    this.graphChangeWatcher?.pause();
    await this.incrementalUpdater?.waitForIdle();
  }

  private async resumeIncrementalUpdates(): Promise<void> {
    if (!this.incrementalUpdatesSuspended) return;
    this.incrementalUpdatesSuspended = false;
    await this.graphChangeWatcher?.resume();
  }

  /**
   * Public disposal hook. Wired via `context.subscriptions.push(router)`
   * in extension.ts so VS Code tears the watcher down on deactivation.
   */
  public dispose(): void {
    this.cancelRuntimeConfigApplyTimer();
    this.clearGraphProgressTimer();
    this.resolveGraphProgressCompletionWaiters();
    this.disposeIncrementalPipeline();
    this.graphProgressStatus?.dispose();
    this.graphProgressStatus = undefined;
    this.configDisposable.dispose();
  }

  // ---------- Helpers ----------

  private async ensureBackendConnection(
    onProgress?: BackendProgressReporter,
  ): Promise<BackendHandle | undefined> {
    const backend = await this.ensureBackendStarted?.(onProgress);
    if (backend) this.client.connect(backend.baseUrl, backend.authToken);
    return backend;
  }

  private async tryBackend<T>(
    path: string,
    body: unknown,
    mock: () => Promise<T>,
  ): Promise<T> {
    if (this.client.isMock()) return mock();
    try {
      await this.ensureBackendConnection();
      return await this.client.call<T>(path, body);
    } catch (e) {
      if (e instanceof Error && e.message === "MOCK_MODE") return mock();
      return mock();
    }
  }

  private async callBackendRequired<T>(path: string, body: unknown): Promise<T> {
    await this.ensureBackendConnection();
    return await this.client.call<T>(path, body);
  }

  private async waitForExtension(
    extensionId: string,
  ): Promise<vscode.Extension<unknown> | undefined> {
    for (let attempt = 0; attempt < 20; attempt++) {
      const ext = vscode.extensions.getExtension(extensionId);
      if (ext) return ext;
      await this.delay(250);
    }
    return undefined;
  }

  private reply(
    webview: vscode.Webview,
    original: AnyMessage,
    payload: Record<string, unknown>,
  ) {
    webview.postMessage({ ...payload, requestId: original.requestId });
  }

  private replyError(
    webview: vscode.Webview,
    original: AnyMessage,
    code: string,
    message: string,
  ) {
    webview.postMessage({
      command: "error",
      requestId: original.requestId,
      code,
      message,
    });
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private logDevelopment(
    event: string,
    details: Record<string, unknown> = {},
  ): void {
    if (!this.developmentLogging) return;
    const safeDetails = Object.fromEntries(
      Object.entries(details).filter(([, value]) => value !== undefined),
    );
    const suffix = Object.keys(safeDetails).length
      ? ` ${JSON.stringify(safeDetails)}`
      : "";
    BackendProcessManager.appendDiagnostic(`${event}${suffix}`);
  }
}
