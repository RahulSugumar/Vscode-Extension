import * as vscode from "vscode";

export interface AgentConfig {
  baseUrl: string;
  neo4jUri: string;
  telemetryEnabled: boolean;
  externalJudgeEnabled: boolean;
  autoRefreshOnSave: boolean;
  useMockBackend: boolean;
  pythonPath: string;
}

export function readConfig(): AgentConfig {
  const cfg = vscode.workspace.getConfiguration("selfEvolvingAgent");
  return {
    baseUrl: cfg.get<string>("backend.baseUrl", "http://localhost:8000"),
    neo4jUri: cfg.get<string>("neo4j.uri", "bolt://localhost:7687"),
    telemetryEnabled: cfg.get<boolean>("telemetry.enabled", true),
    externalJudgeEnabled: cfg.get<boolean>(
      "telemetry.externalJudgeEnabled",
      false,
    ),
    autoRefreshOnSave: cfg.get<boolean>("graph.autoRefreshOnSave", false),
    useMockBackend: cfg.get<boolean>("useMockBackend", false),
    pythonPath: cfg.get<string>("backend.pythonPath", ""),
  };
}

export function onConfigChange(
  handler: (cfg: AgentConfig) => void,
): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("selfEvolvingAgent")) {
      handler(readConfig());
    }
  });
}
