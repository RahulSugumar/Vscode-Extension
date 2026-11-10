import * as vscode from "vscode";
import * as path from "path";

export class RepositoryScanner {
  private readonly IGNORE_PATTERNS = [
    "**/node_modules/**",
    "**/dist/**",
    "**/build/**",
    "**/.git/**",
    "**/*.min.js",
    "**/*.bundle.js",
    "**/out/**",
    "**/venv/**",
    "**/.venv/**",
    "**/env/**",
  ];

  private readonly SUPPORTED_EXTENSIONS = [
    ".py",
    ".js",
    ".jsx",
    ".ts",
    ".tsx",
    ".java",
    ".cs",
    ".c",
    ".h",
    ".cpp",
    ".cc",
    ".cxx",
    ".hpp",
    ".hh",
    ".hxx",
    ".rs",
    ".go",
  ];

  // ------------------------------------------------------------------
  // Full workspace scan with early directory pruning
  // ------------------------------------------------------------------
  public async scan(folder: vscode.WorkspaceFolder): Promise<vscode.Uri[]> {
    const files: vscode.Uri[] = [];
    const pending: vscode.Uri[] = [folder.uri];

    while (pending.length > 0) {
      const dir = pending.pop()!;
      let entries: [string, vscode.FileType][];

      try {
        entries = await vscode.workspace.fs.readDirectory(dir);
      } catch {
        continue;
      }

      entries.sort(([a], [b]) => a.localeCompare(b));

      for (const [name, type] of entries) {
        const uri = vscode.Uri.joinPath(dir, name);
        const isSymbolicLink = Boolean(type & vscode.FileType.SymbolicLink);
        const isDirectory = Boolean(type & vscode.FileType.Directory);
        const isFile = Boolean(type & vscode.FileType.File);

        if (isDirectory) {
          if (!isSymbolicLink && !this.isPathIgnored(uri.fsPath)) {
            pending.push(uri);
          }
          continue;
        }

        if (isFile && this.shouldTrack(uri.fsPath)) {
          files.push(uri);
        }
      }
    }

    return files;
  }

  // ------------------------------------------------------------------
  // NEW: reusable filters — used by the incremental file watcher so
  // that "which files count?" logic never drifts between the full
  // scanner and the change watcher.
  // ------------------------------------------------------------------

  /** Absolute fsPath → true if the file has a Tree-sitter-supported extension. */
  public isFileSupported(fsPath: string): boolean {
    const ext = path.extname(fsPath).toLowerCase();
    return this.SUPPORTED_EXTENSIONS.includes(ext);
  }

  /**
   * Absolute fsPath → true if the file lives under any ignored folder
   * or matches an ignored filename pattern (e.g. *.min.js).
   *
   * Uses a lightweight glob translation good enough for our fixed
   * patterns (**\/x/**, **\/*.suffix). We don't need a full minimatch
   * dependency here — every pattern we ship is one of these two shapes.
   */
  public isPathIgnored(fsPath: string): boolean {
    const normalized = fsPath.replace(/\\/g, "/").toLowerCase();

    for (const pattern of this.IGNORE_PATTERNS) {
      const p = pattern.toLowerCase();

      // Folder-style:  **\/folder-name/**
      const folderMatch = p.match(/^\*\*\/([^*]+)\/\*\*$/);
      if (folderMatch) {
        const segment = `/${folderMatch[1]}/`;
        if (normalized.includes(segment)) return true;
        continue;
      }

      // Filename-style:  **\/*.suffix
      const suffixMatch = p.match(/^\*\*\/\*(\.[a-z0-9.]+)$/i);
      if (suffixMatch) {
        if (normalized.endsWith(suffixMatch[1].toLowerCase())) return true;
        continue;
      }

      // Any pattern we don't recognize is treated as non-matching so we
      // fail-open rather than accidentally silencing real changes.
    }
    return false;
  }

  /**
   * Combined helper: should the incremental watcher care about this path?
   * Returns true only for supported, non-ignored files.
   */
  public shouldTrack(fsPath: string): boolean {
    return this.isFileSupported(fsPath) && !this.isPathIgnored(fsPath);
  }

  /**
   * Glob pattern for VS Code's createFileSystemWatcher that captures
   * every supported file extension in one watcher. Example:
   *   **\/*.{ts,tsx,py,java,...}
   */
  public getWatcherGlob(): string {
    const exts = this.SUPPORTED_EXTENSIONS.map((e) =>
      e.replace(/^\./, ""),
    ).join(",");
    return `**/*.{${exts}}`;
  }

  /** Read-only access for callers that need the raw lists (e.g. debug UI). */
  public getIgnorePatterns(): readonly string[] {
    return this.IGNORE_PATTERNS;
  }

  public getSupportedExtensions(): readonly string[] {
    return this.SUPPORTED_EXTENSIONS;
  }
}
