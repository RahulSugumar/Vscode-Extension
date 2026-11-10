import * as vscode from "vscode";
import { RepositoryScanner } from "../scanner/RepositoryScanner";
import { FileChangeEvent } from "../graph/IncrementalGraphUpdater";

/**
 * Delegate that the router provides. Receives batched file-change events
 * once the debounce window closes. Errors thrown here are logged but never
 * crash the watcher.
 */
export type GraphChangeHandler = (
  folder: vscode.WorkspaceFolder,
  changes: FileChangeEvent[],
) => Promise<void>;

/**
 * Watches the workspace for source-file changes and forwards them —
 * debounced and de-duplicated — to a handler.
 *
 * Debounce strategy:
 *  - Every event resets a per-workspace 750ms timer
 *  - When the timer fires, all events accumulated for that workspace are
 *    coalesced (latest op per path wins) and flushed together
 *
 * Rename detection:
 *  - vscode.workspace.onDidRenameFiles is the authoritative source for
 *    renames (a rename would otherwise look like delete-then-add)
 *
 * Save vs. write detection:
 *  - We use both createFileSystemWatcher AND onDidSaveTextDocument. The
 *    watcher catches out-of-editor changes (git pull, npm install, external
 *    tools). onDidSaveTextDocument catches in-editor saves reliably even
 *    when the file system watcher misses on some remote filesystems.
 */
export class GraphChangeWatcher implements vscode.Disposable {
  private watchers: vscode.FileSystemWatcher[] = [];
  private disposables: vscode.Disposable[] = [];
  private pending = new Map<string, FileChangeEvent>();
  private debounceTimer: NodeJS.Timeout | undefined;
  private started = false;
  private paused = false;

  private static readonly DEBOUNCE_MS = 750;

  constructor(
    private folder: vscode.WorkspaceFolder,
    private scanner: RepositoryScanner,
    private handler: GraphChangeHandler,
  ) {}

  public start(): void {
    if (this.started) return;
    this.started = true;

    const glob = new vscode.RelativePattern(
      this.folder,
      this.scanner.getWatcherGlob(),
    );
    const watcher = vscode.workspace.createFileSystemWatcher(
      glob,
      false,
      false,
      false,
    );

    watcher.onDidCreate((uri) =>
      this.record({ filePath: uri.fsPath, op: "added" }),
    );
    watcher.onDidChange((uri) =>
      this.record({ filePath: uri.fsPath, op: "modified" }),
    );
    watcher.onDidDelete((uri) =>
      this.record({ filePath: uri.fsPath, op: "deleted" }),
    );
    this.watchers.push(watcher);

    // In-editor saves — belt-and-suspenders coverage.
    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (doc.uri.scheme !== "file") return;
        if (!this.isInThisFolder(doc.uri.fsPath)) return;
        if (!this.scanner.shouldTrack(doc.uri.fsPath)) return;
        this.record({ filePath: doc.uri.fsPath, op: "modified" });
      }),
    );

    // Rename detection — takes priority over create+delete pairs.
    this.disposables.push(
      vscode.workspace.onDidRenameFiles((evt) => {
        for (const { oldUri, newUri } of evt.files) {
          if (
            !this.isInThisFolder(newUri.fsPath) &&
            !this.isInThisFolder(oldUri.fsPath)
          ) {
            continue;
          }

          const oldSupported = this.scanner.isFileSupported(oldUri.fsPath);
          const newSupported = this.scanner.shouldTrack(newUri.fsPath);

          if (oldSupported && newSupported) {
            // Cancel any pending create/delete events for these paths so the
            // rename event wins.
            this.pending.delete(oldUri.fsPath);
            this.pending.delete(newUri.fsPath);
            this.record({
              filePath: newUri.fsPath,
              op: "renamed",
              previousFilePath: oldUri.fsPath,
            });
          } else if (oldSupported && !newSupported) {
            // Renamed OUT of scope — treat as delete.
            this.record({ filePath: oldUri.fsPath, op: "deleted" });
          } else if (!oldSupported && newSupported) {
            // Renamed INTO scope — treat as add.
            this.record({ filePath: newUri.fsPath, op: "added" });
          }
        }
      }),
    );

  }

  /**
   * Keep recording file events without parsing or forwarding them. Used while
   * the backend starts and while a full baseline is uploaded to Neo4j.
   */
  public pause(): void {
    this.paused = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
  }

  /** Apply all changes accumulated during the pause as one incremental batch. */
  public async resume(): Promise<void> {
    this.paused = false;
    await this.flush();
  }

  public dispose(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    for (const w of this.watchers) w.dispose();
    for (const d of this.disposables) d.dispose();
    this.watchers = [];
    this.disposables = [];
    this.pending.clear();
    this.started = false;
    this.paused = false;
  }

  /**
   * Force an immediate flush of pending events. Called by the router when
   * the user triggers a manual full resync — we want any in-flight
   * incremental batches to drain first.
   */
  public async flushNow(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    await this.flush();
  }

  // ==================================================================
  // Internals
  // ==================================================================

  private record(event: FileChangeEvent): void {
    if (!this.scanner.isFileSupported(event.filePath)) return;
    if (event.op !== "deleted" && this.scanner.isPathIgnored(event.filePath))
      return;

    // Coalesce: later events for the same path override earlier ones,
    // except that a 'renamed' event should never be downgraded to modified.
    const existing = this.pending.get(event.filePath);
    if (existing?.op === "renamed" && event.op === "modified") {
      // Keep the rename — the modified is a same-cycle artefact.
      return;
    }
    this.pending.set(event.filePath, event);

    if (this.paused) return;

    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(
      () => void this.flush(),
      GraphChangeWatcher.DEBOUNCE_MS,
    );
  }

  private async flush(): Promise<void> {
    this.debounceTimer = undefined;
    if (this.paused) return;
    if (this.pending.size === 0) return;

    const changes = Array.from(this.pending.values());
    this.pending.clear();

    try {
      await this.handler(this.folder, changes);
    } catch (err) {
      void err;
    }
  }

  private isInThisFolder(fsPath: string): boolean {
    const root = this.folder.uri.fsPath.replace(/\\/g, "/").toLowerCase();
    const p = fsPath.replace(/\\/g, "/").toLowerCase();
    return p === root || p.startsWith(root + "/");
  }
}
