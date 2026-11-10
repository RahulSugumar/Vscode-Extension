import * as vscode from "vscode";
import { SourceRange } from "../models/Graph";
import { sourceRangeFromZeroBasedRange } from "./SourceRange";

export interface ResolvedLocation {
  targetUri: string;
  targetLine: number;
  targetCharacter: number;
  targetRange?: SourceRange;
}

export class LspResolver {
  private readonly DOCUMENT_SYMBOL_ATTEMPT_MS = 1500;
  private readonly DEFINITION_ATTEMPT_MS = 2500;

  public async waitForLanguageServer(
    sampleUri: vscode.Uri,
    timeoutMs = 15000,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const symbols = await this.executeCommandWithTimeout<
        vscode.DocumentSymbol[]
      >(
        "vscode.executeDocumentSymbolProvider",
        Math.min(this.DOCUMENT_SYMBOL_ATTEMPT_MS, remaining),
        sampleUri,
      );
      if (Array.isArray(symbols)) {
        return true;
      }

      const pauseMs = Math.min(500, Math.max(0, deadline - Date.now()));
      if (pauseMs > 0) await this.delay(pauseMs);
    }
    return false;
  }

  /**
   * Quick, non-blocking check whether the language server is already warm for
   * the given file. Uses a short timeout so incremental updates can fall back
   * to structural-only work without blocking a save event.
   */
  public async isLanguageServerWarm(
    sampleUri: vscode.Uri,
    timeoutMs = 800,
  ): Promise<boolean> {
    const result = await this.executeCommandWithTimeout<
      vscode.DocumentSymbol[]
    >("vscode.executeDocumentSymbolProvider", timeoutMs, sampleUri);
    return Array.isArray(result);
  }

  /** Fire-and-forget warmup for a sample file. Any error is swallowed. */
  public warmupInBackground(sampleUri: vscode.Uri, timeoutMs = 15000): void {
    void this.waitForLanguageServer(sampleUri, timeoutMs).catch(
      () => undefined,
    );
  }

  public async resolveDefinition(
    uri: vscode.Uri,
    line: number,
    character: number,
  ): Promise<ResolvedLocation | null> {
    try {
      const locations = await this.executeCommandWithTimeout<
        (vscode.Location | vscode.LocationLink)[]
      >(
        "vscode.executeDefinitionProvider",
        this.DEFINITION_ATTEMPT_MS,
        uri,
        new vscode.Position(line, character),
      );

      if (!locations || locations.length === 0) return null;

      const first = locations[0];
      if ("targetUri" in first) {
        const range = first.targetSelectionRange ?? first.targetRange;
        return {
          targetUri: first.targetUri.toString(),
          targetLine: range.start.line,
          targetCharacter: range.start.character,
          targetRange: sourceRangeFromZeroBasedRange(range),
        };
      }

      return {
        targetUri: first.uri.toString(),
        targetLine: first.range.start.line,
        targetCharacter: first.range.start.character,
        targetRange: sourceRangeFromZeroBasedRange(first.range),
      };
    } catch {
      return null;
    }
  }

  public async resolveBatch<
    T extends { sourceUri: string; refLine: number; refCharacter: number },
  >(
    requests: T[],
    onProgress: (done: number, total: number) => void,
    concurrency = 8,
  ): Promise<Map<T, ResolvedLocation | null>> {
    const results = new Map<T, ResolvedLocation | null>();
    let cursor = 0;
    let completed = 0;

    const workers = Array.from({ length: concurrency }, async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= requests.length) break;
        const req = requests[idx];
        const resolved = await this.resolveDefinition(
          vscode.Uri.parse(req.sourceUri),
          req.refLine,
          req.refCharacter,
        );
        results.set(req, resolved);
        completed++;
        if (completed % 25 === 0 || completed === requests.length) {
          onProgress(completed, requests.length);
        }
      }
    });

    await Promise.all(workers);
    return results;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  private executeCommandWithTimeout<T>(
    command: string,
    timeoutMs: number,
    ...args: unknown[]
  ): Promise<T | undefined> {
    let timer: NodeJS.Timeout | undefined;
    const commandPromise = Promise.resolve(
      vscode.commands.executeCommand<T>(command, ...args),
    ).catch(() => undefined);
    const timeoutPromise = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), Math.max(1, timeoutMs));
    });

    return Promise.race([commandPromise, timeoutPromise]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }
}