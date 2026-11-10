import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as net from "net";
import { createHash, randomBytes } from "crypto";
import { ChildProcess, spawn } from "child_process";

const HEALTH_POLL_INTERVAL_MS = 300;
const HEALTH_REQUEST_TIMEOUT_MS = 2000;
const HEALTH_WAIT_LOG_INTERVAL_MS = 30000;
const HEALTH_UI_UPDATE_INTERVAL_MS = 5000;
const MAX_CAPTURED_OUTPUT_CHARS = 12000;
const PORT_SCAN_RANGE = 20; // try 8000..8019
const IPC_PREFIX = "__PROJECT_ASSISTANT_IPC__";

export interface BackendHandle {
  readonly baseUrl: string;
  readonly pid: number | undefined;
  readonly authToken: string;
  updateRuntimeConfig(env: Record<string, string>): Promise<void>;
  dispose(): Promise<void>;
}

export interface BackendStartupProgress {
  readonly message: string;
  readonly percent: number;
}

export type BackendProgressReporter = (
  progress: BackendStartupProgress,
) => void;

export class BackendProcessManager {
  private static loggingEnabled = false;
  private static output: vscode.OutputChannel | undefined;

  public static configureLogging(enabled: boolean): void {
    BackendProcessManager.loggingEnabled = enabled;
    if (enabled) {
      BackendProcessManager.output ??=
        vscode.window.createOutputChannel("Project Assistant Backend");
      return;
    }
    BackendProcessManager.output?.dispose();
    BackendProcessManager.output = undefined;
  }

  public static appendDiagnostic(message: string): void {
    BackendProcessManager.appendLine(
      `[extension ${new Date().toISOString()}] ${message}`,
    );
  }

  public static showOutput(): void {
    if (!BackendProcessManager.loggingEnabled) return;
    BackendProcessManager.output?.show(true);
  }

  private static append(value: string): void {
    if (!BackendProcessManager.loggingEnabled) return;
    BackendProcessManager.output?.append(value);
  }

  private static appendLine(value: string): void {
    if (!BackendProcessManager.loggingEnabled) return;
    BackendProcessManager.output?.appendLine(value);
  }

  private static clearOutput(): void {
    if (!BackendProcessManager.loggingEnabled) return;
    BackendProcessManager.output?.clear();
  }

  private child?: ChildProcess;
  private startupOutput = "";
  private stdoutBuffer = "";
  private readonly pendingIpc = new Map<
    string,
    { resolve: () => void; reject: (error: Error) => void; timeout: NodeJS.Timeout }
  >();
  private lastExit:
    | {
        code: number | null;
        signal: string | null;
      }
    | undefined;

  constructor(
    private readonly extensionPath: string,
    private readonly workspaceRoot: string,
    private readonly storageRoot: string,
  ) {}

  public async start(
    preferredPort: number = 8000,
    backendEnv: Record<string, string> = {},
    onProgress?: BackendProgressReporter,
  ): Promise<BackendHandle> {
    const backendDir = path.join(this.extensionPath, "backend");
    const mainPy = path.join(backendDir, "main.py");

    if (!fs.existsSync(mainPy)) {
      throw new Error(`Backend entry point missing: ${mainPy}`);
    }
    onProgress?.({
      message: "Preparing the local assistant...",
      percent: 2,
    });

    const developmentLogging =
      backendEnv.PROJECT_ASSISTANT_DEV_LOGGING === "true";
    if (developmentLogging) {
      BackendProcessManager.appendLine("");
      BackendProcessManager.appendLine("[backend] --- new backend run ---");
    } else {
      BackendProcessManager.clearOutput();
    }
    BackendProcessManager.appendLine(
      "[backend setup] Verifying Python and all requirements before startup...",
    );

    let pythonPath: string;
    try {
      pythonPath = await this.resolvePython(backendDir, onProgress);
      BackendProcessManager.appendLine(
        "[backend setup] All backend requirements, including abkb[judge], are installed and loadable.",
      );
    } catch (error) {
      BackendProcessManager.appendLine(
        `[backend setup] Dependency preparation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      BackendProcessManager.showOutput();
      throw error;
    }

    // Find a free port so we don't collide with zombies / other apps.
    onProgress?.({ message: "Preparing the local service...", percent: 72 });
    const port = await this.findFreePort(preferredPort);
    const authToken = randomBytes(32).toString("base64url");
    this.startupOutput = "";
    this.lastExit = undefined;

    BackendProcessManager.appendLine("[backend] Starting local backend server...");
    onProgress?.({ message: "Starting the local assistant...", percent: 80 });
    BackendProcessManager.appendLine(`[backend] Python: ${pythonPath}`);
    BackendProcessManager.appendLine(`[backend] Workdir: ${backendDir}`);
    BackendProcessManager.appendLine(`[backend] URL: http://127.0.0.1:${port}`);
    if (developmentLogging) {
      BackendProcessManager.appendLine(
        "[backend] Development diagnostics enabled (prompts and secrets are not logged).",
      );
    }

    this.child = spawn(pythonPath, [mainPy], {
      cwd: backendDir,
      env: {
        ...process.env,
        ...backendEnv,
        ABKB_PROJECT_ROOT: this.workspaceRoot,
        BACKEND_AUTH_TOKEN: authToken,
        BACKEND_PORT: String(port),
        BACKEND_QUIET: developmentLogging ? "0" : "1",
        UVICORN_LOG_LEVEL: developmentLogging ? "debug" : "info",
        PYTHONUNBUFFERED: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    const expectedPid = this.child.pid;

    this.child.stdout?.on("data", (chunk) => {
      const text = chunk.toString();
      this.appendStartupOutput(text);
      this.handleStdout(text);
    });
    this.child.stderr?.on("data", (chunk) => {
      const text = chunk.toString();
      this.appendStartupOutput(text);
      BackendProcessManager.append(text);
    });
    this.child.on("exit", (code, signal) => {
      this.lastExit = {
        code,
        signal: signal ? String(signal) : null,
      };
      this.child = undefined;
      this.rejectPendingIpc(new Error("Backend process exited during runtime update."));
    });
    this.child.on("error", (error) => {
      this.appendStartupOutput(String(error));
    });

    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      await this.waitForHealth(baseUrl, authToken, expectedPid, onProgress);
    } catch (error) {
      BackendProcessManager.showOutput();
      await this.stop().catch(() => undefined);
      throw error;
    }

    // Persist the chosen URL so the rest of the extension can find it.
    const target = vscode.workspace.workspaceFolders?.length
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
    await vscode.workspace
      .getConfiguration("selfEvolvingAgent")
      .update("backend.baseUrl", baseUrl, target);
    onProgress?.({ message: "Project Assistant is ready.", percent: 100 });

    return {
      baseUrl,
      pid: expectedPid,
      authToken,
      updateRuntimeConfig: (env) => this.updateRuntimeConfig(env),
      dispose: () => this.stop(),
    };
  }

  public async stop(): Promise<void> {
    if (!this.child) return;
    const pid = this.child.pid;

    return new Promise<void>((resolve) => {
      if (!this.child) return resolve();

      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      this.child.once("exit", done);

      if (process.platform === "win32" && pid !== undefined) {
        const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
          windowsHide: true,
        });
        killer.on("exit", () => setTimeout(done, 500));
      } else {
        this.child.kill("SIGTERM");
        setTimeout(() => {
          if (!settled) this.child?.kill("SIGKILL");
        }, 3000);
      }

      setTimeout(done, 5000);
    });
  }

  private async resolvePython(
    backendDir: string,
    onProgress?: BackendProgressReporter,
  ): Promise<string> {
    const requirementsPath = path.join(backendDir, "requirements.txt");
    const override = vscode.workspace
      .getConfiguration("selfEvolvingAgent")
      .get<string>("backend.pythonPath", "");
    const venvWin = path.join(backendDir, ".venv", "Scripts", "python.exe");
    const venvNix = path.join(backendDir, ".venv", "bin", "python");
    let pythonPath: string;

    if (override && fs.existsSync(override)) {
      pythonPath = override;
    } else if (fs.existsSync(venvWin)) {
      pythonPath = venvWin;
    } else if (fs.existsSync(venvNix)) {
      pythonPath = venvNix;
    } else {
      const managedVenv = path.join(this.storageRoot, "backend-python");
      pythonPath = this.getVenvPython(managedVenv);
      if (!fs.existsSync(pythonPath)) {
        onProgress?.({
          message: "Creating the Python environment...",
          percent: 10,
        });
        await fs.promises.mkdir(this.storageRoot, { recursive: true });
        const systemPython = process.platform === "win32" ? "python" : "python3";
        await this.runProcess(
          systemPython,
          ["-m", "venv", managedVenv],
          backendDir,
        );
      }
    }

    onProgress?.({
      message: "Checking Python packages...",
      percent: 18,
    });

    // Every interpreter path goes through the same complete dependency check.
    // This guarantees setup finishes before the backend process is spawned,
    // rather than deferring package installation until the first chat request.
    await this.prepareManagedDependencies(
      pythonPath,
      requirementsPath,
      backendDir,
      onProgress,
    );
    return pythonPath;
  }

  private getVenvPython(venvDir: string): string {
    return process.platform === "win32"
      ? path.join(venvDir, "Scripts", "python.exe")
      : path.join(venvDir, "bin", "python");
  }

  private async prepareManagedDependencies(
    pythonPath: string,
    requirementsPath: string,
    cwd: string,
    onProgress?: BackendProgressReporter,
  ): Promise<void> {
    if (!fs.existsSync(requirementsPath)) {
      throw new Error(`Backend requirements file missing: ${requirementsPath}`);
    }
    const markerDirectory = path.join(this.storageRoot, "dependency-markers");
    const interpreterHash = createHash("sha256")
      .update(path.resolve(pythonPath))
      .digest("hex")
      .slice(0, 16);
    const markerPath = path.join(
      markerDirectory,
      `${interpreterHash}.requirements.sha256`,
    );
    const requirementsHash = createHash("sha256")
      .update(await fs.promises.readFile(requirementsPath))
      .digest("hex");

    onProgress?.({
      message: "Checking required Python libraries...",
      percent: 24,
    });
    const importsAvailable = await this.backendImportsAvailable(pythonPath, cwd);
    onProgress?.({
      message: "Checking Python package compatibility...",
      percent: 34,
    });
    const environmentConsistent = await this.pythonEnvironmentIsConsistent(
      pythonPath,
      cwd,
    );
    const installedHash = await fs.promises
      .readFile(markerPath, "utf8")
      .then((value) => value.trim())
      .catch(() => "");
    if (
      importsAvailable &&
      environmentConsistent &&
      installedHash === requirementsHash
    ) {
      onProgress?.({
        message: "Required Python libraries are ready.",
        percent: 68,
      });
      return;
    }

    onProgress?.({
      message: "Installing required Python libraries...",
      percent: 40,
    });
    await this.runProcess(
      pythonPath,
      [
        "-m",
        "pip",
        "install",
        "--disable-pip-version-check",
        "--no-input",
        "-r",
        requirementsPath,
      ],
      cwd,
    );
    onProgress?.({
      message: "Checking the installed Python libraries...",
      percent: 60,
    });
    if (!(await this.backendImportsAvailable(pythonPath, cwd))) {
      throw new Error("Backend dependencies are still incomplete after installation.");
    }
    if (!(await this.pythonEnvironmentIsConsistent(pythonPath, cwd))) {
      throw new Error("Backend dependencies contain incompatible package versions after installation.");
    }
    await fs.promises.mkdir(markerDirectory, { recursive: true });
    await fs.promises.writeFile(markerPath, requirementsHash, "utf8");
    onProgress?.({
      message: "Required Python libraries are ready.",
      percent: 68,
    });
  }

  private async pythonEnvironmentIsConsistent(
    pythonPath: string,
    cwd: string,
  ): Promise<boolean> {
    try {
      await this.runProcess(pythonPath, ["-m", "pip", "check"], cwd);
      return true;
    } catch {
      return false;
    }
  }

  private async backendImportsAvailable(
    pythonPath: string,
    cwd: string,
  ): Promise<boolean> {
    try {
      await this.runProcess(
        pythonPath,
        [
          "-c",
          [
            "import importlib",
            "import importlib.metadata as metadata",
            "import importlib.util as u",
            'mods = ["fastapi", "uvicorn", "pydantic", "python_multipart", "dotenv", "streamlit", "requests", "langchain", "langchain_openai", "langgraph", "deepagents", "langfuse", "rich", "anthropic", "neo4j", "neo4j_graphrag", "sentence_transformers", "openai", "abkb"]',
            "missing = [m for m in mods if u.find_spec(m) is None]",
            'if missing: raise SystemExit("Missing backend modules: " + ", ".join(missing))',
            'judge_modules = ["abkb", "deepagents", "langgraph", "langchain_openai", "langfuse", "dotenv"]',
            "loaded = {name: importlib.import_module(name) for name in judge_modules}",
            'missing_judge_api = [name for name in ["Judge", "Integrator"] if not hasattr(loaded["abkb"], name)]',
            'if missing_judge_api: raise SystemExit("ABKB judge API is unavailable: " + ", ".join(missing_judge_api))',
            'provided_extras = set(metadata.distribution("abkb").metadata.get_all("Provides-Extra") or [])',
            'if "judge" not in provided_extras: raise SystemExit("Installed ABKB distribution does not provide the judge extra")',
          ].join("\n"),
        ],
        cwd,
      );
      return true;
    } catch {
      return false;
    }
  }

  private runProcess(
    command: string,
    args: string[],
    cwd: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      BackendProcessManager.appendLine(`[backend setup] ${command} ${args.join(" ")}`);
      const proc = spawn(command, args, {
        cwd,
        env: {
          ...process.env,
          BACKEND_QUIET: BackendProcessManager.loggingEnabled ? "0" : "1",
          PYTHONUNBUFFERED: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });

      let stderr = "";
      proc.stdout?.on("data", (chunk) => {
        const text = chunk.toString();
        stderr += text;
        BackendProcessManager.append(text);
      });
      proc.stderr?.on("data", (chunk) => {
        const text = chunk.toString();
        stderr += text;
        BackendProcessManager.append(text);
      });
      proc.on("error", reject);
      proc.on("exit", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(
            new Error(
              `${command} ${args.join(" ")} failed with code ${code}: ${stderr}`,
            ),
          );
        }
      });
    });
  }

  private isPortFree(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const tester = net.createServer();
      tester.once("error", () => resolve(false));
      tester.once("listening", () => {
        tester.close(() => resolve(true));
      });
      tester.listen(port, "127.0.0.1");
    });
  }

  private async findFreePort(start: number): Promise<number> {
    for (let p = start; p < start + PORT_SCAN_RANGE; p++) {
      if (await this.isPortFree(p)) return p;
    }
    throw new Error(
      `No free port available in range ${start}..${start + PORT_SCAN_RANGE - 1}`,
    );
  }

  private async waitForHealth(
    baseUrl: string,
    authToken: string,
    expectedPid?: number,
    onProgress?: BackendProgressReporter,
  ): Promise<void> {
    let lastError = "";
    const startedAt = Date.now();
    let lastProgressLogAt = 0;
    let lastUiUpdateAt = 0;

    BackendProcessManager.appendLine(
      "[backend] Waiting for health check... 0s elapsed (no startup timeout)",
    );
    onProgress?.({
      message: "Waiting for the local assistant to become ready...",
      percent: 90,
    });

    while (true) {
      if (!this.child) {
        throw new Error(
          `Backend process exited before becoming healthy. ${this.describeStartupFailure(lastError)} ` +
            "Restart the extension host and try again.",
        );
      }

      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        HEALTH_REQUEST_TIMEOUT_MS,
      );

      try {
        const res = await fetch(`${baseUrl}/health`, {
          method: "GET",
          headers: { Authorization: `Bearer ${authToken}` },
          signal: controller.signal,
        });
        if (res.ok) {
          try {
            const body = (await res.json()) as { pid?: number };
            if (
              body.pid !== undefined &&
              expectedPid !== undefined &&
              body.pid !== expectedPid
            ) {
            }
          } catch {
            // /health does not need to return JSON; HTTP 200 is enough.
          }
          onProgress?.({
            message: "The local assistant is responding.",
            percent: 96,
          });
          return;
        }
        lastError = "server is loading";
      } catch (error) {
        lastError =
          error instanceof Error && error.name === "AbortError"
            ? `health check timed out after ${HEALTH_REQUEST_TIMEOUT_MS}ms`
            : "server is loading";
      } finally {
        clearTimeout(timeout);
      }

      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs - lastUiUpdateAt >= HEALTH_UI_UPDATE_INTERVAL_MS) {
        lastUiUpdateAt = elapsedMs;
        onProgress?.({
          message: `Waiting for the local assistant (${Math.round(
            elapsedMs / 1000,
          )}s elapsed)...`,
          percent: 90,
        });
      }
      if (elapsedMs - lastProgressLogAt >= HEALTH_WAIT_LOG_INTERVAL_MS) {
        lastProgressLogAt = elapsedMs;
        BackendProcessManager.appendLine(
          `[backend] Waiting for health check... ${Math.round(
            elapsedMs / 1000,
          )}s elapsed. Last check: ${lastError || "unknown"}`,
        );
      }

      await new Promise((r) => setTimeout(r, HEALTH_POLL_INTERVAL_MS));
    }
  }

  private appendStartupOutput(text: string): void {
    this.startupOutput = (this.startupOutput + text).slice(
      -MAX_CAPTURED_OUTPUT_CHARS,
    );
  }

  private handleStdout(text: string): void {
    this.stdoutBuffer += text;
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith(IPC_PREFIX)) {
        BackendProcessManager.appendLine(line);
        continue;
      }
      try {
        const message = JSON.parse(line.slice(IPC_PREFIX.length)) as {
          requestId?: string;
          ok?: boolean;
          error?: string;
        };
        const pending = message.requestId
          ? this.pendingIpc.get(message.requestId)
          : undefined;
        if (!pending || !message.requestId) continue;
        clearTimeout(pending.timeout);
        this.pendingIpc.delete(message.requestId);
        if (message.ok) pending.resolve();
        else pending.reject(new Error(message.error || "Backend runtime update failed."));
      } catch {
        BackendProcessManager.appendLine("[backend] Invalid IPC acknowledgement ignored.");
      }
    }
  }

  private updateRuntimeConfig(env: Record<string, string>): Promise<void> {
    if (!this.child?.stdin || !this.child.stdin.writable) {
      return Promise.reject(new Error("Backend runtime channel is unavailable."));
    }
    const requestId = randomBytes(12).toString("hex");
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingIpc.delete(requestId);
        reject(new Error("Backend runtime update timed out."));
      }, 5000);
      this.pendingIpc.set(requestId, { resolve, reject, timeout });
      this.child!.stdin!.write(
        `${JSON.stringify({ type: "runtimeConfig.update", requestId, env })}\n`,
        (error) => {
          if (!error) return;
          clearTimeout(timeout);
          this.pendingIpc.delete(requestId);
          reject(error);
        },
      );
    });
  }

  private rejectPendingIpc(error: Error): void {
    for (const pending of this.pendingIpc.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingIpc.clear();
  }

  private describeStartupFailure(lastError: string): string {
    const parts: string[] = [];
    if (this.lastExit) {
      parts.push(
        `Process exit: code ${this.lastExit.code ?? "unknown"}${
          this.lastExit.signal ? `, signal ${this.lastExit.signal}` : ""
        }.`,
      );
    }
    parts.push(`Last health check: ${lastError || "unknown"}.`);

    const output = this.startupOutput.replace(/\s+/g, " ").trim();
    if (output) {
      parts.push(`Backend output: ${output.slice(-1200)}`);
    }

    return parts.join(" ");
  }
}
