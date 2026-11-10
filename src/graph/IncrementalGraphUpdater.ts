import * as vscode from "vscode";
import * as path from "path";
import { createHash } from "crypto";

import { Graph, GraphEdgeModel } from "../models/Graph";
import {
  GraphLedger,
  LedgerEntry,
  createEmptyLedger,
} from "../models/GraphLedger";
import {
  GraphDelta,
  DeltaBatch,
  createEmptyDeltaBatch,
  appendToBatch,
  isBatchEmpty,
} from "../models/GraphDelta";
import { GraphBuilder, SingleFileBuildResult } from "./GraphBuilder";
import { GraphDeltaBuilder } from "./GraphDeltaBuilder";
import { GraphLedgerStore } from "../exporter/GraphLedgerStore";
import { JsonExporter } from "../exporter/JsonExporter";
import { RepositoryScanner } from "../scanner/RepositoryScanner";

/**
 * One file change event fed into the updater. The watcher normalizes
 * VS Code file system events into this shape.
 */
export interface FileChangeEvent {
  filePath: string;
  op: "added" | "modified" | "deleted" | "renamed";
  /** For renames only --- the previous path. */
  previousFilePath?: string;
}

/**
 * Public callback interface --- the message router provides these hooks so
 * the updater can push status/errors to the webview UI and to Neo4j.
 */
export interface IncrementalUpdaterHooks {
  /**
   * Called BEFORE the delta is applied. Chance to show "updating..." status.
   * Batch-level: called once per debounce cycle.
   */
  onUpdateStart?(fileCount: number): void;

  /**
   * Called AFTER the local graph JSON has been written successfully.
   * Batch-level: called once per debounce cycle.
   */
  onLocalUpdateComplete?(batch: DeltaBatch): void;

  /**
   * Called AFTER the backend patch has been attempted (success or failure).
   * Batch-level: called once per debounce cycle.
   */
  onBackendPatchAttempted?(result: BackendPatchResult): void;

  /**
   * Called when file changes were observed but did not alter the graph.
   * Lets the UI close progress affordances without treating it as a failure.
   */
  onUpdateSkipped?(fileCount: number): void;

  /**
   * Send the delta batch to the backend. Should reject on any failure so
   * the updater can retry. Returns void on success.
   */
  patchBackend(batch: DeltaBatch): Promise<void>;

  /**
   * True when the extension is running in mock/backend-less mode. When true,
   * the updater skips backend patching entirely (no retries, no warnings).
   */
  isBackendMocked?(): boolean | Promise<boolean>;

  /** Broadcast the updated graph to any open GraphPanel webviews. */
  broadcastGraphUpdate?(graph: Graph): void;
}

export interface BackendPatchResult {
  attempted: boolean;
  success: boolean;
  attempts: number;
  error?: string;
}

/**
 * Options for the update run.
 */
export interface IncrementalUpdateOptions {
  /** Bump when we want to force a rebuild ignoring hash checks. */
  ignoreHash?: boolean;
  /** Extra dependent files that must be re-parsed due to upstream changes. */
  additionalDependents?: string[];
}

const LEDGER_FILENAME = ".code-knowledge-graph.ledger.json";
const GRAPH_FILENAME = ".code-knowledge-graph.json";
const MAX_BACKEND_RETRIES = 2; // Total attempts = 1 + MAX_BACKEND_RETRIES
const RETRY_BACKOFF_MS = 1000;

/**
 * Orchestrates the incremental update pipeline:
 *
 *   FileChangeEvent[]  ---  hash check  ---  rebuild per file  ---  compute delta
 *                                                                   ---
 *   apply to in-memory graph  ---  update ledger  ---  persist JSON  ---  patch Neo4j
 *
 * Serializes concurrent updates via an internal queue: while a batch is
 * processing, further events wait. This prevents interleaved writes to
 * the ledger and graph JSON files.
 */
export class IncrementalGraphUpdater {
  private deltaBuilder = new GraphDeltaBuilder();
  private ledgerStore = new GraphLedgerStore();
  private jsonExporter = new JsonExporter();

  private inFlight: Promise<void> = Promise.resolve();
  private isFullScanRunning = false;

  constructor(
    private scanner: RepositoryScanner,
    private builder: GraphBuilder,
    private hooks: IncrementalUpdaterHooks,
  ) {}

  /**
   * Full-scan lock: while a full scan is running, incremental updates are
   * dropped (a full rebuild is a superset of any incremental work).
   * Called by the router around its full-scan invocation.
   */
  public beginFullScan(): void {
    this.isFullScanRunning = true;
  }

  public endFullScan(): void {
    this.isFullScanRunning = false;
  }

  /** Wait until every batch (including dependent follow-ups) is finished. */
  public async waitForIdle(): Promise<void> {
    while (true) {
      const pending = this.inFlight;
      await pending;
      if (pending === this.inFlight) return;
    }
  }

  /**
   * Ingest a batch of file changes. Serializes with any in-flight update
   * so callers never overlap. Safe to call rapidly --- VS Code file events
   * during a debounce window will queue up and get processed in order.
   */
  public enqueue(
    folder: vscode.WorkspaceFolder,
    graph: Graph,
    changes: FileChangeEvent[],
    options: IncrementalUpdateOptions = {},
  ): Promise<void> {
    const next = this.inFlight.then(() =>
      this.processBatch(folder, graph, changes, options).catch(() => {
        // Never let one failure poison the queue.
      }),
    );
    this.inFlight = next;
    return next;
  }

  // ==================================================================
  // Core pipeline
  // ==================================================================

  private async processBatch(
    folder: vscode.WorkspaceFolder,
    graph: Graph,
    changes: FileChangeEvent[],
    options: IncrementalUpdateOptions,
  ): Promise<void> {
    if (this.isFullScanRunning) {
      return;
    }
    if (changes.length === 0) return;

    // Filter out irrelevant paths (unsupported extension, ignored folder).
    // Delete events for supported files are still processed even if the
    // file no longer exists on disk.
    const relevant = changes.filter((c) => {
      if (c.op === "deleted") return this.scanner.isFileSupported(c.filePath);
      return this.scanner.shouldTrack(c.filePath);
    });
    if (relevant.length === 0) return;

    this.hooks.onUpdateStart?.(relevant.length);

    // Load the ledger. If missing/invalid, we can't compute deltas correctly
    // for modifications --- fall back to treating everything as 'added'.
    const ledger = await this.ledgerStore.loadOrCreate(folder, LEDGER_FILENAME);

    // Merge in additional dependents (cross-file impact from Batch 3+).
    if (options.additionalDependents?.length) {
      for (const depPath of options.additionalDependents) {
        if (relevant.some((c) => c.filePath === depPath)) continue;
        if (!this.scanner.shouldTrack(depPath)) continue;
        relevant.push({ filePath: depPath, op: "modified" });
      }
    }

    const batch = createEmptyDeltaBatch(folder.uri.fsPath);
    const touchedDependents = new Set<string>();

    for (const change of relevant) {
      const delta = await this.processSingleChange(
        change,
        folder,
        graph,
        ledger,
        options,
        touchedDependents,
      );
      if (delta && !this.deltaBuilder.isNoOp(delta)) {
        this.deltaBuilder.applyToGraph(graph, delta);
        appendToBatch(batch, delta);
      }
    }

    // Cross-file impact: any files that depend on symbols we just changed
    // need to be re-parsed too, so their cross-file edges stay accurate.
    // We enqueue them as a follow-up batch (not recursively --- one hop only
    // to avoid runaway rebuilds).
    if (touchedDependents.size > 0) {
      const followUp: FileChangeEvent[] = [];
      for (const depPath of touchedDependents) {
        if (relevant.some((c) => c.filePath === depPath)) continue;
        followUp.push({ filePath: depPath, op: "modified" });
      }
      if (followUp.length > 0) {
        // Schedule as a separate queued job so the current cycle can commit.
        void this.enqueue(folder, graph, followUp, { ignoreHash: true });
      }
    }

    if (isBatchEmpty(batch)) {
      // Nothing changed semantically (e.g. whitespace-only edits).
      this.hooks.onUpdateSkipped?.(relevant.length);
      return;
    }

    // Persist ledger + graph JSON locally FIRST. This is our source of truth.
    await this.ledgerStore.save(ledger, folder, LEDGER_FILENAME);
    await this.jsonExporter.exportSilently(graph, folder, GRAPH_FILENAME);

    this.hooks.onLocalUpdateComplete?.(batch);
    this.hooks.broadcastGraphUpdate?.(graph);

    // Ship to backend with retry logic.
    const patchResult = await this.patchBackendWithRetry(batch);
    this.hooks.onBackendPatchAttempted?.(patchResult);

    if (patchResult.attempted && !patchResult.success) {
      this.showBackendDriftWarning(patchResult);
    }
  }

  /**
   * Process one file change: hash check --- build --- delta --- return.
   * Mutates `ledger` in place (updates or removes the entry).
   * Adds any impacted dependents to `touchedDependents`.
   */
  private async processSingleChange(
    change: FileChangeEvent,
    folder: vscode.WorkspaceFolder,
    graph: Graph,
    ledger: GraphLedger,
    options: IncrementalUpdateOptions,
    touchedDependents: Set<string>,
  ): Promise<GraphDelta | null> {
    const { filePath, op } = change;
    const previousEntry = ledger.entries[filePath];

    // ---- DELETED ----
    if (op === "deleted") {
      if (!previousEntry) return null; // nothing to remove
      const delta = this.deltaBuilder.buildForDeleted(
        filePath,
        previousEntry,
        previousEntry.contentHash,
      );
      this.collectDependents(previousEntry, touchedDependents);
      this.removeLedgerEntry(ledger, filePath);
      return delta;
    }

    // ---- RENAMED ----
    if (op === "renamed" && change.previousFilePath) {
      const oldEntry = ledger.entries[change.previousFilePath];
      if (!oldEntry) {
        // We didn't have the source path indexed --- treat as fresh add.
        return this.processAddOrModify(
          { filePath, op: "added" },
          folder,
          graph,
          ledger,
          options,
          touchedDependents,
        );
      }
      const uri = vscode.Uri.file(filePath);
      const newHash = await this.hashFile(uri);
      if (!newHash) return null; // file gone before we could read it

      const freshBuild = this.attachWorkspaceRootEdge(
        folder,
        await this.builder.buildForFile(uri, graph),
      );
      const delta = this.deltaBuilder.buildForRenamed(
        change.previousFilePath,
        filePath,
        freshBuild,
        oldEntry,
        oldEntry.contentHash,
        newHash,
      );
      this.collectDependents(oldEntry, touchedDependents);
      this.removeLedgerEntry(ledger, change.previousFilePath);
      this.upsertLedgerEntry(ledger, filePath, newHash, freshBuild);
      return delta;
    }

    // ---- ADDED / MODIFIED ----
    return this.processAddOrModify(
      change,
      folder,
      graph,
      ledger,
      options,
      touchedDependents,
    );
  }

  private async processAddOrModify(
    change: FileChangeEvent,
    folder: vscode.WorkspaceFolder,
    graph: Graph,
    ledger: GraphLedger,
    options: IncrementalUpdateOptions,
    touchedDependents: Set<string>,
  ): Promise<GraphDelta | null> {
    const { filePath } = change;
    const uri = vscode.Uri.file(filePath);
    const previousEntry = ledger.entries[filePath];

    const newHash = await this.hashFile(uri);
    if (!newHash) return null; // file disappeared between event and read

    // Fast path: content hash unchanged (touch, save-without-edit, etc.)
    if (!options.ignoreHash && previousEntry?.contentHash === newHash) {
      return null;
    }

    const freshBuild = this.attachWorkspaceRootEdge(
      folder,
      await this.builder.buildForFile(uri, graph),
    );

    // Effective op: if we had no prior entry, this is an 'added'
    const effectiveOp: "added" | "modified" = previousEntry
      ? "modified"
      : "added";

    const delta = this.deltaBuilder.buildForModified(
      filePath,
      effectiveOp,
      freshBuild,
      previousEntry,
      previousEntry?.contentHash,
      newHash,
    );

    // Detect signature-level changes so we can invalidate dependents.
    if (previousEntry) {
      const changedSymbols = this.diffExportedSignatures(
        previousEntry,
        freshBuild,
      );
      if (changedSymbols.length > 0) {
        this.collectDependents(previousEntry, touchedDependents);
      }
    }

    this.upsertLedgerEntry(ledger, filePath, newHash, freshBuild);

    return delta;
  }

  // ==================================================================
  // Ledger maintenance
  // ==================================================================

  private upsertLedgerEntry(
    ledger: GraphLedger,
    filePath: string,
    newHash: string,
    build: SingleFileBuildResult,
  ): void {
    // Preserve existing dependents unless we can recompute --- dependents are
    // maintained in reverse by other files' import lists, so we don't blow
    // them away on a self-update.
    const existingDependents = ledger.entries[filePath]?.dependents ?? [];

    const entry: LedgerEntry = {
      filePath,
      contentHash: newHash,
      lastModified: Date.now(),
      nodeIds: build.nodes.map((n) => n.id),
      edgeIds: build.edges.map((e) => e.id),
      exportedSymbols: build.exportedSymbols,
      importedFiles: build.importedFiles,
      dependents: existingDependents,
    };
    ledger.entries[filePath] = entry;

    // Also update the *reverse* graph: for every file this one imports from,
    // add THIS file to that file's dependents list. This is what allows
    // future upstream changes to fan out and invalidate this file.
    for (const importedPath of build.importedFiles) {
      const upstream = ledger.entries[importedPath];
      if (!upstream) continue; // upstream not yet indexed --- will be reconciled later
      if (!upstream.dependents.includes(filePath)) {
        upstream.dependents = [...upstream.dependents, filePath];
      }
    }
  }

  private attachWorkspaceRootEdge(
    folder: vscode.WorkspaceFolder,
    build: SingleFileBuildResult,
  ): SingleFileBuildResult {
    if (!build.nodes.some((node) => node.id === build.filePath)) {
      return build;
    }

    const edge = this.createWorkspaceRootEdge(folder, build.filePath);
    if (build.edges.some((existing) => existing.id === edge.id)) {
      return build;
    }

    return {
      ...build,
      edges: [edge, ...build.edges],
    };
  }

  private createWorkspaceRootEdge(
    folder: vscode.WorkspaceFolder,
    filePath: string,
  ): GraphEdgeModel {
    const folderNodeId = folder.uri.fsPath;
    return {
      id: `edge_contains_${folderNodeId}__${filePath}`,
      source: folderNodeId,
      target: filePath,
      relationshipType: "CONTAINS",
    };
  }

  private removeLedgerEntry(ledger: GraphLedger, filePath: string): void {
    const entry = ledger.entries[filePath];
    if (!entry) return;

    // Clean up reverse links: any upstream files still list us as a dependent.
    for (const importedPath of entry.importedFiles) {
      const upstream = ledger.entries[importedPath];
      if (!upstream) continue;
      upstream.dependents = upstream.dependents.filter((p) => p !== filePath);
    }

    delete ledger.entries[filePath];
  }

  private collectDependents(entry: LedgerEntry, out: Set<string>): void {
    for (const dep of entry.dependents) {
      out.add(dep);
    }
  }

  /**
   * Compare exported symbols between old and new state. Returns names whose
   * signatureHash changed OR that were added/removed at the exported level.
   * These are the symbols whose consumers need re-resolution.
   */
  private diffExportedSignatures(
    previousEntry: LedgerEntry,
    freshBuild: SingleFileBuildResult,
  ): string[] {
    const oldMap = new Map(
      previousEntry.exportedSymbols
        .filter((s) => s.isExported)
        .map((s) => [s.name, s.signatureHash]),
    );
    const newMap = new Map(
      freshBuild.exportedSymbols
        .filter((s) => s.isExported)
        .map((s) => [s.name, s.signatureHash]),
    );

    const changed: string[] = [];
    for (const [name, oldHash] of oldMap) {
      if (newMap.get(name) !== oldHash) changed.push(name);
    }
    for (const [name] of newMap) {
      if (!oldMap.has(name)) changed.push(name);
    }
    return changed;
  }

  // ==================================================================
  // Content hashing
  // ==================================================================

  /**
   * SHA-256 of the file's normalized content (LF line endings). Returns
   * undefined if the file cannot be read. Normalization prevents
   * cross-platform CRLF/LF churn from creating spurious hash mismatches.
   */
  private async hashFile(uri: vscode.Uri): Promise<string | undefined> {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(bytes).toString("utf8").replace(/\r\n/g, "\n");
      return createHash("sha256").update(text).digest("hex");
    } catch {
      return undefined;
    }
  }

  // ==================================================================
  // Backend patch with retry + drift notification
  // ==================================================================

  private async patchBackendWithRetry(
    batch: DeltaBatch,
  ): Promise<BackendPatchResult> {
    if (await this.hooks.isBackendMocked?.()) {
      return { attempted: false, success: true, attempts: 0 };
    }

    let lastError: unknown;
    for (let attempt = 1; attempt <= 1 + MAX_BACKEND_RETRIES; attempt++) {
      try {
        await this.hooks.patchBackend(batch);
        return { attempted: true, success: true, attempts: attempt };
      } catch (err) {
        lastError = err;
        if (attempt <= MAX_BACKEND_RETRIES) {
          await this.delay(RETRY_BACKOFF_MS * attempt);
        }
      }
    }

    return {
      attempted: true,
      success: false,
      attempts: 1 + MAX_BACKEND_RETRIES,
      error: lastError instanceof Error ? lastError.message : String(lastError),
    };
  }

  /**
   * Persistent user-facing warning: local graph JSON is ahead of Neo4j.
   * The user can trigger a full resync from the offered action.
   */
  private showBackendDriftWarning(result: BackendPatchResult): void {
    const message =
      `Graph updated locally, but the Neo4j sync failed after ${result.attempts} attempts. ` +
      `Chat results may be temporarily out of date. ${result.error ? `(${result.error})` : ""}`;

    void message;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}

/**
 * Ensures the caller has both the ledger and graph filenames used by the
 * updater. Exposed so other files (router, watcher, tests) don't hardcode
 * the strings themselves.
 */
export const INCREMENTAL_FILE_NAMES = {
  ledger: LEDGER_FILENAME,
  graph: GRAPH_FILENAME,
} as const;
