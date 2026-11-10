import * as vscode from "vscode";
import * as path from "path";

/**
 * Allowlist of publishers we trust for LSP installs. An extension that
 * matches one of our profile IDs but is published by anyone *not* in this
 * list is treated as untrusted and ignored (defends against typosquatting).
 */
const TRUSTED_PUBLISHERS: ReadonlySet<string> = new Set([
  "vscode", // built-ins
  "ms-python", // Microsoft Python team (Pylance, Python extension)
  "ms-vscode", // Microsoft C/C++ tools
  "ms-dotnettools", // Microsoft .NET team
  "redhat", // Red Hat (Java LSP)
  "golang", // Go team at Google
  "rust-lang", // Rust analyzer team
  "Angular", // Angular team
]);

export interface LspProfile {
  /** Internal identifier used in the graph metadata. */
  id: string;
  /** User-facing name shown in prompts. */
  displayName: string;
  /**
   * Marketplace extension ID. We deliberately pick the language-server
   * variant of each ecosystem (not the full "extension pack") to minimize
   * install size and attack surface.
   */
  extensionId: string;
  /** Expected publisher; verified against the marketplace metadata at runtime. */
  publisher: string;
  /** Approximate on-disk size (MB) after install, including required dependencies. */
  sizeMb: number;
  /** File extensions that trigger this profile. */
  triggers: string[];
  /** Optional manifest-based detection (e.g., Angular requires package.json check). */
  manifestDetect?: (folder: vscode.WorkspaceFolder) => Promise<boolean>;
  /** Is this LSP already built into VS Code? */
  builtIn: boolean;
  /**
   * True when this extension is a pure language-server contribution
   * (no debugger, test runner, or scaffolding bundled). Informational —
   * also used to skip extensions flagged as heavyweight by future updates.
   */
  onlyLspFeatures: boolean;
  /** Short note shown in the UI explaining why this variant was chosen. */
  rationale: string;
}

const PROFILES: LspProfile[] = [
  {
    id: "typescript",
    displayName: "TypeScript / JavaScript",
    extensionId: "vscode.typescript-language-features",
    publisher: "vscode",
    sizeMb: 0,
    triggers: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
    builtIn: true,
    onlyLspFeatures: true,
    rationale: "Built into VS Code; no install needed.",
  },
  {
    id: "python",
    // Pylance is Microsoft's official Python language server, built on top
    // of Pyright. It has an extension dependency on `ms-python.python`,
    // so installing Pylance also pulls in the base Python extension.
    displayName: "Python (Pylance)",
    extensionId: "ms-python.vscode-pylance",
    publisher: "ms-python",
    sizeMb: 85, // ~5 MB Pylance + ~80 MB required ms-python.python dependency
    triggers: [".py"],
    builtIn: false,
    onlyLspFeatures: false,
    rationale:
      "Official Microsoft Python LSP; pulls ms-python.python as a dependency.",
  },
  {
    id: "angular",
    displayName: "Angular Language Service",
    extensionId: "Angular.ng-template",
    publisher: "Angular",
    sizeMb: 15,
    triggers: [".ts", ".html"],
    builtIn: false,
    onlyLspFeatures: true,
    rationale: "Official Angular team LSP; ships as language service only.",
    manifestDetect: async (folder) => {
      try {
        const pkgUri = vscode.Uri.file(
          path.join(folder.uri.fsPath, "package.json"),
        );
        const bytes = await vscode.workspace.fs.readFile(pkgUri);
        const pkg = JSON.parse(Buffer.from(bytes).toString("utf8"));
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        return Object.keys(deps).some((d) => d.startsWith("@angular/"));
      } catch {
        return false;
      }
    },
  },
  {
    id: "java",
    // `redhat.java` is the Eclipse JDT language server wrapper. The bloated
    // variant is `vscjava.vscode-java-pack`, which we deliberately do NOT use.
    displayName: "Java (Red Hat LSP)",
    extensionId: "redhat.java",
    publisher: "redhat",
    sizeMb: 50,
    triggers: [".java"],
    builtIn: false,
    onlyLspFeatures: true,
    rationale: "Language server only; excludes the Extension Pack for Java.",
  },
  {
    id: "csharp",
    // Base C# extension — now Roslyn-LSP-based. We avoid `ms-dotnettools.csdevkit`
    // (C# Dev Kit), which adds solution explorer, test runner, and telemetry.
    displayName: "C# (Roslyn LSP)",
    extensionId: "ms-dotnettools.csharp",
    publisher: "ms-dotnettools",
    sizeMb: 55,
    triggers: [".cs"],
    builtIn: false,
    onlyLspFeatures: true,
    rationale: "Roslyn-based language server only; not the heavier C# Dev Kit.",
  },
  {
    id: "cpp",
    displayName: "C/C++",
    extensionId: "ms-vscode.cpptools",
    publisher: "ms-vscode",
    sizeMb: 95,
    triggers: [".c", ".h", ".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx"],
    builtIn: false,
    onlyLspFeatures: false,
    rationale:
      "Official Microsoft C/C++ language tooling; enables definition resolution.",
  },
  {
    id: "rust",
    displayName: "Rust Analyzer",
    extensionId: "rust-lang.rust-analyzer",
    publisher: "rust-lang",
    sizeMb: 45,
    triggers: [".rs"],
    builtIn: false,
    onlyLspFeatures: true,
    rationale: "Official Rust Analyzer extension for semantic navigation.",
  },
  {
    id: "go",
    displayName: "Go (gopls)",
    extensionId: "golang.go",
    publisher: "golang",
    sizeMb: 10,
    triggers: [".go"],
    builtIn: false,
    onlyLspFeatures: true,
    rationale: "Thin wrapper around gopls; published by the Go team.",
  },
];

export interface PreflightResult {
  active: LspProfile[];
  missing: LspProfile[];
  /** Extensions that matched an ID but failed publisher verification. */
  untrusted: { profile: LspProfile; actualPublisher: string }[];
  totalDownloadMb: number;
}

export type PreflightDecision = "install" | "continue" | "cancel";

export class LspPreflight {
  /**
   * Inspects the workspace, determines which LSPs are relevant, and reports
   * what's active vs. what would need to be installed. Each candidate is
   * publisher-verified before activation.
   */
  public async check(
    files: vscode.Uri[],
    folder: vscode.WorkspaceFolder,
  ): Promise<PreflightResult> {
    const presentExtensions = new Set(
      files.map((f) => path.extname(f.fsPath).toLowerCase()),
    );

    const active: LspProfile[] = [];
    const missing: LspProfile[] = [];
    const untrusted: { profile: LspProfile; actualPublisher: string }[] = [];

    for (const profile of PROFILES) {
      const triggered = profile.triggers.some((ext) =>
        presentExtensions.has(ext),
      );
      if (!triggered) continue;

      if (profile.manifestDetect) {
        const detected = await profile.manifestDetect(folder);
        if (!detected) continue;
      }

      if (profile.builtIn) {
        active.push(profile);
        continue;
      }

      const ext = vscode.extensions.getExtension(profile.extensionId);
      if (!ext) {
        missing.push(profile);
        continue;
      }

      if (!this.verifyPublisher(ext, profile)) {
        const actual = this.readPublisher(ext);
        untrusted.push({ profile, actualPublisher: actual });
        continue;
      }

      if (!ext.isActive) {
        try {
          await ext.activate();
        } catch {
          /* activation failure is non-fatal; profile still counts as present */
        }
      }
      active.push(profile);
    }

    const totalDownloadMb = missing.reduce((sum, p) => sum + p.sizeMb, 0);
    return { active, missing, untrusted, totalDownloadMb };
  }

  /**
   * Confirms the installed extension's publisher matches the profile's
   * declared publisher AND that the publisher is in the trusted allowlist.
   */
  private verifyPublisher(
    ext: vscode.Extension<unknown>,
    profile: LspProfile,
  ): boolean {
    const actual = this.readPublisher(ext);
    if (!actual) return false;
    if (actual.toLowerCase() !== profile.publisher.toLowerCase()) return false;
    return TRUSTED_PUBLISHERS.has(actual);
  }

  private readPublisher(ext: vscode.Extension<unknown>): string {
    const pkg = ext.packageJSON as { publisher?: string } | undefined;
    return pkg?.publisher ?? "";
  }
}
