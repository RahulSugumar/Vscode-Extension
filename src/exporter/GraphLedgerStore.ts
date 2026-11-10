import * as vscode from "vscode";
import * as path from "path";
import {
  GraphLedger,
  LEDGER_SCHEMA_VERSION,
  createEmptyLedger,
  isGraphLedger,
} from "../models/GraphLedger";

/**
 * Persistence layer for the graph ledger. Reads and writes a single JSON
 * file at the workspace root (default filename `.code-knowledge-graph.ledger.json`).
 *
 * Design choices:
 *   - Atomic writes: we write to `<name>.tmp` then rename over the target,
 *     so a crash mid-write leaves the previous ledger intact.
 *   - Silent tryLoad: returns undefined for any read/parse failure rather
 *     than throwing - the caller decides whether to rebuild.
 *   - Version-aware: rejects ledgers with a newer schema than we know about.
 */
export class GraphLedgerStore {
  /**
   * Load the ledger from disk. Returns `undefined` if the file is missing,
   * unreadable, malformed, or from a newer schema version. Never throws.
   */
  public async tryLoad(
    folder: vscode.WorkspaceFolder,
    fileName: string,
  ): Promise<GraphLedger | undefined> {
    const uri = this.resolveUri(folder, fileName);

    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(uri);
    } catch {
      return undefined; // File does not exist yet - expected on first run.
    }

    let parsed: unknown;
    try {
      const text = Buffer.from(bytes).toString("utf8");
      parsed = JSON.parse(text);
    } catch {
      return undefined;
    }

    if (!isGraphLedger(parsed)) {
      return undefined;
    }

    if (parsed.version > LEDGER_SCHEMA_VERSION) {
      return undefined;
    }

    return parsed;
  }

  /**
   * Persist the ledger to disk atomically. Bumps `updatedAt` before writing.
   */
  public async save(
    ledger: GraphLedger,
    folder: vscode.WorkspaceFolder,
    fileName: string,
  ): Promise<vscode.Uri> {
    const target = this.resolveUri(folder, fileName);
    const tmp = this.resolveUri(folder, `${fileName}.tmp`);

    ledger.updatedAt = Date.now();
    if (ledger.version !== LEDGER_SCHEMA_VERSION) {
      ledger.version = LEDGER_SCHEMA_VERSION;
    }

    const payload = Buffer.from(JSON.stringify(ledger, null, 2), "utf8");

    try {
      await vscode.workspace.fs.writeFile(tmp, payload);
      await vscode.workspace.fs.rename(tmp, target, { overwrite: true });
    } catch (err) {
      try {
        await vscode.workspace.fs.delete(tmp);
      } catch {
        /* ignore */
      }
      throw err;
    }

    return target;
  }

  /**
   * Load if present, otherwise write and return a fresh empty ledger.
   * Named to match the call site in IncrementalGraphUpdater.ts.
   */
  public async loadOrCreate(
    folder: vscode.WorkspaceFolder,
    fileName: string,
  ): Promise<GraphLedger> {
    const existing = await this.tryLoad(folder, fileName);
    if (existing) return existing;

    const fresh = createEmptyLedger();
    await this.save(fresh, folder, fileName);
    return fresh;
  }

  /**
   * Deprecated alias for `loadOrCreate` - kept so any older call site
   * that used the previous name continues to compile.
   */
  public async loadOrInit(
    folder: vscode.WorkspaceFolder,
    fileName: string,
  ): Promise<GraphLedger> {
    return this.loadOrCreate(folder, fileName);
  }

  /**
   * Delete the ledger file. No-op if the file does not exist. Used by
   * "full re-scan" flows that want to guarantee a clean slate.
   */
  public async clear(
    folder: vscode.WorkspaceFolder,
    fileName: string,
  ): Promise<void> {
    const uri = this.resolveUri(folder, fileName);
    try {
      await vscode.workspace.fs.delete(uri);
    } catch {
      // Missing file is fine - that's the desired end state anyway.
    }
  }

  private resolveUri(
    folder: vscode.WorkspaceFolder,
    fileName: string,
  ): vscode.Uri {
    const abs = path.isAbsolute(fileName)
      ? fileName
      : path.join(folder.uri.fsPath, fileName);
    return vscode.Uri.file(abs);
  }
}
