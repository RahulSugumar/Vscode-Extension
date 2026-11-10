import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { getNonce } from "./utils/nonce";
import { HostMessageRouter } from "./host/messageRouter";
import { GraphPanel } from "./viewer/GraphPanel";
import {
  BackendProcessManager,
  BackendHandle,
  BackendProgressReporter,
  BackendStartupProgress,
} from "./host/BackendProcess";
import {
  getBackendEnv,
  getRuntimeConfigState,
} from "./host/runtimeConfig";

let router: HostMessageRouter;
let backendHandle: BackendHandle | undefined;
let backendStartPromise: Promise<BackendHandle | undefined> | undefined;
let backendStartInFlight = false;
let backendWorkspaceRoot: string | undefined;
type NavigationTarget = "ask" | "graph" | "improve";
const assistantWebviews = new Set<vscode.Webview>();
const backendProgressReporters = new Set<BackendProgressReporter>();

export async function activate(context: vscode.ExtensionContext) {
  BackendProcessManager.configureLogging(
    context.extensionMode === vscode.ExtensionMode.Development,
  );
  context.subscriptions.push({
    dispose: () => BackendProcessManager.configureLogging(false),
  });

  router = new HostMessageRouter(
    context,
    (onProgress) => ensureManagedBackendStarted(context, onProgress),
    () => {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      return backendHandle && backendWorkspaceRoot === workspaceRoot
        ? backendHandle
        : undefined;
    },
  );

  // Ensure the router's incremental watcher is disposed on deactivation.
  context.subscriptions.push(router);

  // "Open Graph Viewer" — opens the Cytoscape panel and loads the saved JSON.
  const startCommand = vscode.commands.registerCommand(
    "selfEvolvingAgent.start",
    async () => {
      const panel = GraphPanel.createOrShow(context.extensionPath);
      await panel.loadFromWorkspace();
    },
  );

  const askNavCommand = vscode.commands.registerCommand(
    "selfEvolvingAgent.nav.ask",
    () => navigateAssistant("ask"),
  );

  const graphNavCommand = vscode.commands.registerCommand(
    "selfEvolvingAgent.nav.graph",
    () => navigateAssistant("graph"),
  );

  const improveNavCommand = vscode.commands.registerCommand(
    "selfEvolvingAgent.nav.improve",
    () => navigateAssistant("improve"),
  );

  // "Open Agent Platform in Editor" — opens the sidebar React UI as a full editor tab.
  const fullEditorCommand = vscode.commands.registerCommand(
    "selfEvolvingAgent.openFullEditor",
    () => SelfEvolvingAgentPanel.createOrShow(context),
  );

  // "Generate Knowledge Graph" — programmatic trigger (also invoked by the webview).
  const generateGraphCommand = vscode.commands.registerCommand(
    "selfEvolvingAgent.generateGraph",
    () => router.generateGraphFromCommand(),
  );

  const debugResetCommand = vscode.commands.registerCommand(
    "selfEvolvingAgent.debugReset",
    async () => {
      await context.workspaceState.update("hasGraph", undefined);
      await context.workspaceState.update("sessions", undefined);
      vscode.window.showInformationMessage(
        "Self-Evolving Agent: workspace state cleared. Reload window to see effect.",
      );
    },
  );

  context.subscriptions.push(
    startCommand,
    askNavCommand,
    graphNavCommand,
    improveNavCommand,
    fullEditorCommand,
    generateGraphCommand,
    debugResetCommand,
  );

  const provider = new SelfEvolvingAgentSidebarProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      "selfEvolvingAgent.mainView",
      provider,
      {
        webviewOptions: { retainContextWhenHidden: true },
      },
    ),
  );

  context.subscriptions.push({
    dispose: () => {
      void backendStartPromise?.finally(() => backendHandle?.dispose());
    },
  });
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      if (backendHandle && !backendStartInFlight) {
        const handle = backendHandle;
        backendHandle = undefined;
        backendWorkspaceRoot = undefined;
        backendStartPromise = handle.dispose().then(() => undefined);
      }
    }),
  );

}

async function startManagedBackend(
  context: vscode.ExtensionContext,
): Promise<BackendHandle | undefined> {
  backendStartInFlight = true;
  try {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      return undefined;
    }

    const runtimeConfig = await getRuntimeConfigState(context);
    if (!runtimeConfig.isConfigured) {
      throw new Error(
        `Complete backend setup first: ${runtimeConfig.missing.join(", ")}`,
      );
    }

    const backendEnv = await getBackendEnv(context);
    const backendMgr = new BackendProcessManager(
      context.extensionPath,
      workspaceRoot,
      context.globalStorageUri.fsPath,
    );
    backendHandle = await backendMgr.start(8000, backendEnv, (progress) => {
      for (const reporter of backendProgressReporters) reporter(progress);
    });
    backendWorkspaceRoot = workspaceRoot;
    vscode.window.setStatusBarMessage(
      `$(check) Agent backend ready at ${backendHandle.baseUrl}`,
      5000,
    );
    return backendHandle;
  } catch (e) {
    throw e;
  } finally {
    backendStartInFlight = false;
  }
}

async function ensureManagedBackendStarted(
  context: vscode.ExtensionContext,
  onProgress?: (progress: BackendStartupProgress) => void,
): Promise<BackendHandle | undefined> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (backendHandle && backendWorkspaceRoot === workspaceRoot) {
    onProgress?.({ message: "Project Assistant is ready.", percent: 100 });
    return backendHandle;
  }

  if (onProgress) backendProgressReporters.add(onProgress);

  try {
    if (backendHandle) {
      await backendHandle.dispose();
      backendHandle = undefined;
      backendWorkspaceRoot = undefined;
    }

    if (!backendStartInFlight) {
      backendStartPromise = startManagedBackend(context);
    }
    return await backendStartPromise;
  } finally {
    if (onProgress) backendProgressReporters.delete(onProgress);
  }
}

function navigateAssistant(target: NavigationTarget): void {
  for (const webview of assistantWebviews) {
    void webview.postMessage({ command: "ui.navigate", target });
  }
}

function getWebviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
): string {
  const manifestPath = path.join(
    extensionUri.fsPath,
    "webview",
    "dist",
    ".vite",
    "manifest.json",
  );
  let scriptUri = "";
  let styleUri = "";

  try {
    const manifestFile = fs.readFileSync(manifestPath, "utf-8");
    const manifest = JSON.parse(manifestFile);
    const entry = manifest["index.html"];
    scriptUri = webview
      .asWebviewUri(
        vscode.Uri.joinPath(extensionUri, "webview", "dist", entry.file),
      )
      .toString();
    if (entry.css && entry.css.length > 0) {
      styleUri = webview
        .asWebviewUri(
          vscode.Uri.joinPath(extensionUri, "webview", "dist", entry.css[0]),
        )
        .toString();
    }
  } catch {
    return `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:20px;color:#eee;background:#0B0F13;">
      <h2>Webview not built</h2>
      <p>Run <code>npm run build:webview</code> in the project root, then reload this window.</p>
    </body></html>`;
  }

  const nonce = getNonce();
  const cspSource = webview.cspSource;
  const csp = [
    `default-src 'none'`,
    `style-src ${cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `img-src ${cspSource} data:`,
    `font-src ${cspSource}`,
    `connect-src 'none'`,
  ].join("; ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Project Assistant</title>
  ${styleUri ? `<link href="${styleUri}" rel="stylesheet">` : ""}
  <script nonce="${nonce}">
    window.INITIAL_VIEW = "sidebar";
  </script>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
}

class SelfEvolvingAgentSidebarProvider implements vscode.WebviewViewProvider {
  constructor(private readonly context: vscode.ExtensionContext) {}

  public resolveWebviewView(webviewView: vscode.WebviewView) {
    webviewView.title = "Project Assistant";
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "webview", "dist"),
      ],
    };
    webviewView.webview.html = getWebviewHtml(
      webviewView.webview,
      this.context.extensionUri,
    );
    assistantWebviews.add(webviewView.webview);

    const disposable = webviewView.webview.onDidReceiveMessage((msg) =>
      router.handle(msg, webviewView.webview),
    );
    webviewView.onDidDispose(() => {
      assistantWebviews.delete(webviewView.webview);
      disposable.dispose();
    });
  }
}

class SelfEvolvingAgentPanel {
  public static currentPanel: SelfEvolvingAgentPanel | undefined;
  public static readonly viewType = "selfEvolvingAgent";

  private readonly _panel: vscode.WebviewPanel;
  private readonly _context: vscode.ExtensionContext;
  private _disposables: vscode.Disposable[] = [];

  public static createOrShow(context: vscode.ExtensionContext) {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (SelfEvolvingAgentPanel.currentPanel) {
      SelfEvolvingAgentPanel.currentPanel._panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      SelfEvolvingAgentPanel.viewType,
      "Project Assistant",
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, "webview", "dist"),
        ],
        retainContextWhenHidden: true,
      },
    );

    SelfEvolvingAgentPanel.currentPanel = new SelfEvolvingAgentPanel(
      panel,
      context,
    );
  }

  private constructor(
    panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
  ) {
    this._panel = panel;
    this._context = context;

    this._panel.webview.html = getWebviewHtml(
      this._panel.webview,
      this._context.extensionUri,
    );
    assistantWebviews.add(this._panel.webview);

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    this._panel.webview.onDidReceiveMessage(
      (msg) => router.handle(msg, this._panel.webview),
      null,
      this._disposables,
    );
  }

  public dispose() {
    SelfEvolvingAgentPanel.currentPanel = undefined;
    assistantWebviews.delete(this._panel.webview);
    this._panel.dispose();
    while (this._disposables.length) this._disposables.pop()?.dispose();
  }
}

export async function deactivate(): Promise<void> {
  await backendStartPromise?.catch(() => undefined);
  if (backendHandle) {
    await backendHandle.dispose();
    backendHandle = undefined;
    backendWorkspaceRoot = undefined;
  }
}
