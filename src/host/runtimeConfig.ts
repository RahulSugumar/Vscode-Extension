import * as vscode from 'vscode';
import { createHash } from 'crypto';
import * as path from 'path';

const DEFAULT_NEO4J_URI = 'bolt://localhost:7687';
const DEFAULT_NEO4J_USER = 'neo4j';
const DEFAULT_NEO4J_DATABASE = 'neo4j';
const DEFAULT_LLM_PROVIDER = 'openai';
const DEFAULT_LLM_MODEL = 'gpt-4o-mini';
const DEFAULT_ABKB_DB_TYPE = 'sqlite';
const DEFAULT_ABKB_WORKFLOW_ID = 'vscode-codegraph-chatbot';
const DEFAULT_ABKB_TELEMETRY_FETCH_TYPE = 'jsonl';
const DEFAULT_JUDGE_MODEL_ROUTING = 'small_then_big';
const DEFAULT_JUDGE_SMALL_OPENAI_MODEL = DEFAULT_LLM_MODEL;
const DEFAULT_JUDGE_BIG_OPENAI_MODEL = 'gpt-5';
const DEFAULT_JUDGE_OPENAI_MODEL = DEFAULT_JUDGE_BIG_OPENAI_MODEL;
const DEFAULT_ABKB_INTEGRATOR_MODEL = 'gpt-4o-mini';
const DEFAULT_ABKB_INTEGRATOR_TIMEOUT_SECONDS = '10';
const DEFAULT_ABKB_INTEGRATOR_MAX_RETRIES = '0';
const DEFAULT_LLM_TIMEOUT_SECONDS = '45';
const DEFAULT_EXECUTOR_STEP_TIMEOUT_SECONDS = '45';
const DEFAULT_JUDGE_CONTEXT_MODE = 'compact';
const DEFAULT_MAX_JUDGE_USER_CHARS = '1200';
const DEFAULT_MAX_JUDGE_OUTPUT_CHARS = '1600';
const DEFAULT_MAX_JUDGE_TECHNIQUE_CARDS = '4';
const DEFAULT_ABKB_JUDGE_POLL_SECONDS = '2';
const DEFAULT_ABKB_JUDGE_WEIGHT_TELEMETRY_EVIDENCE = '0.25';
const DEFAULT_ABKB_JUDGE_WEIGHT_FAILURE_CLASS_FIT = '0.20';
const DEFAULT_ABKB_JUDGE_WEIGHT_TECHNIQUE_FIT = '0.20';
const DEFAULT_ABKB_JUDGE_WEIGHT_METRIC_IMPACT = '0.15';
const DEFAULT_ABKB_JUDGE_WEIGHT_POLICY_QUALITY = '0.15';
const DEFAULT_ABKB_JUDGE_WEIGHT_LLM_CONFIDENCE = '0.05';

export interface RuntimeConfigValues {
  neo4jUri: string;
  neo4jUser: string;
  neo4jDatabase: string;
  llmProvider: string;
  llmModel: string;
}

export interface RuntimeConfigState {
  isConfigured: boolean;
  isChatConfigured: boolean;
  isNeo4jConfigured: boolean;
  missing: string[];
  chatMissing: string[];
  values: RuntimeConfigValues;
  hasOpenAiApiKey: boolean;
  hasNeo4jPassword: boolean;
}

export interface RuntimeConfigInput extends Partial<RuntimeConfigValues> {
  openAiApiKey?: string;
  neo4jPassword?: string;
  clearOpenAiApiKey?: boolean;
  clearNeo4jPassword?: boolean;
}

export async function getRuntimeConfigState(
  context: vscode.ExtensionContext
): Promise<RuntimeConfigState> {
  const values = readRuntimeConfigValues();
  const saved = readRuntimeConfigSavedFlags();
  const openAiApiKey = await getStoredOpenAiApiKey(context);
  const neo4jPassword = await getStoredNeo4jPassword(context);

  const missing: string[] = [];
  if (!saved.llmProvider || !values.llmProvider) missing.push('LLM provider');
  if (!saved.llmModel || !values.llmModel) missing.push('LLM model');

  const neo4jMissing: string[] = [];
  if (!saved.neo4jUri || !values.neo4jUri) neo4jMissing.push('Neo4j URI');
  if (!saved.neo4jUser || !values.neo4jUser) neo4jMissing.push('Neo4j user');
  if (!saved.neo4jDatabase || !values.neo4jDatabase) neo4jMissing.push('Neo4j database');
  if (!neo4jPassword) neo4jMissing.push('Neo4j password');

  const chatMissing: string[] = [...missing, ...neo4jMissing];
  if (values.llmProvider.toLowerCase() === 'openai' && !openAiApiKey) {
    chatMissing.push('OpenAI API key');
  }

  return {
    isConfigured: missing.length === 0,
    isChatConfigured: chatMissing.length === 0,
    isNeo4jConfigured: neo4jMissing.length === 0,
    missing,
    chatMissing,
    values,
    hasOpenAiApiKey: Boolean(openAiApiKey),
    hasNeo4jPassword: Boolean(neo4jPassword)
  };
}

export async function saveRuntimeConfig(
  context: vscode.ExtensionContext,
  input: RuntimeConfigInput
): Promise<RuntimeConfigState> {
  const target = vscode.workspace.workspaceFolders?.length
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
  const cfg = vscode.workspace.getConfiguration('selfEvolvingAgent');

  await cfg.update('neo4j.uri', clean(input.neo4jUri, DEFAULT_NEO4J_URI), target);
  await cfg.update('neo4j.user', clean(input.neo4jUser, DEFAULT_NEO4J_USER), target);
  await cfg.update('neo4j.database', clean(input.neo4jDatabase, DEFAULT_NEO4J_DATABASE), target);
  await cfg.update('llm.provider', clean(input.llmProvider, DEFAULT_LLM_PROVIDER), target);
  await cfg.update('llm.model', clean(input.llmModel, DEFAULT_LLM_MODEL), target);
  await cfg.update('llm.judgeModel', undefined, target);

  if (input.clearOpenAiApiKey) {
    await context.secrets.delete(secretKey('openaiApiKey'));
  } else {
    const openAiApiKey = cleanOptionalSecret(input.openAiApiKey);
    if (openAiApiKey) {
      await context.secrets.store(secretKey('openaiApiKey'), openAiApiKey);
    }
  }

  if (input.clearNeo4jPassword) {
    await context.secrets.delete(secretKey('neo4jPassword'));
  } else {
    const neo4jPassword = cleanOptionalSecret(input.neo4jPassword);
    if (neo4jPassword) {
      await context.secrets.store(secretKey('neo4jPassword'), neo4jPassword);
    }
  }

  return getRuntimeConfigState(context);
}

export async function getStoredOpenAiApiKey(
  context: vscode.ExtensionContext
): Promise<string | undefined> {
  return cleanOptionalSecret(await context.secrets.get(secretKey('openaiApiKey')));
}

export async function clearStoredOpenAiApiKey(
  context: vscode.ExtensionContext
): Promise<void> {
  await context.secrets.delete(secretKey('openaiApiKey'));
}

export async function getBackendEnv(
  context: vscode.ExtensionContext
): Promise<Record<string, string>> {
  const state = await getRuntimeConfigState(context);
  if (!state.isConfigured) {
    throw new Error(`Complete backend setup first: ${state.missing.join(', ')}`);
  }

  const openAiApiKey = await getStoredOpenAiApiKey(context);
  const neo4jPassword = await getStoredNeo4jPassword(context);

  const workspaceRoot = workspaceRootPath();
  const abkbDir = path.join(workspaceRoot, '.abkb');
  const abkbTelemetryDir = path.join(abkbDir, 'telemetry');
  const judgeContextPath = path.join(
    context.extensionPath,
    'backend',
    'chatbot',
    'judge_contexts',
    'project_assistant_chatbot.json'
  );

  return {
    ABKB_PROJECT_ROOT: workspaceRoot,
    ABKB_HOME: abkbDir,
    ABKB_DB_TYPE: DEFAULT_ABKB_DB_TYPE,
    ABKB_WORKFLOW_ID: DEFAULT_ABKB_WORKFLOW_ID,
    ABKB_TELEMETRY_FETCH_TYPE: DEFAULT_ABKB_TELEMETRY_FETCH_TYPE,
    ABKB_DB_PATH: path.join(abkbDir, 'abkb.db'),
    ABKB_TELEMETRY_PATH: path.join(abkbTelemetryDir, 'agent_turns.jsonl'),
    ABKB_JUDGE_STATE_PATH: path.join(abkbTelemetryDir, 'judge_state.json'),
    ABKB_JUDGE_TRACE_PATH: path.join(abkbTelemetryDir, 'judge_trace.jsonl'),
    ABKB_JUDGE_WORKFLOW_CONTEXT_PATH: judgeContextPath,
    ABKB_JUDGE_WEIGHT_TELEMETRY_EVIDENCE:
      DEFAULT_ABKB_JUDGE_WEIGHT_TELEMETRY_EVIDENCE,
    ABKB_JUDGE_WEIGHT_FAILURE_CLASS_FIT:
      DEFAULT_ABKB_JUDGE_WEIGHT_FAILURE_CLASS_FIT,
    ABKB_JUDGE_WEIGHT_TECHNIQUE_FIT:
      DEFAULT_ABKB_JUDGE_WEIGHT_TECHNIQUE_FIT,
    ABKB_JUDGE_WEIGHT_METRIC_IMPACT:
      DEFAULT_ABKB_JUDGE_WEIGHT_METRIC_IMPACT,
    ABKB_JUDGE_WEIGHT_POLICY_QUALITY:
      DEFAULT_ABKB_JUDGE_WEIGHT_POLICY_QUALITY,
    ABKB_JUDGE_WEIGHT_LLM_CONFIDENCE:
      DEFAULT_ABKB_JUDGE_WEIGHT_LLM_CONFIDENCE,
    JUDGE_MODEL_ROUTING: DEFAULT_JUDGE_MODEL_ROUTING,
    JUDGE_CONTEXT_MODE: DEFAULT_JUDGE_CONTEXT_MODE,
    MAX_JUDGE_USER_CHARS: DEFAULT_MAX_JUDGE_USER_CHARS,
    MAX_JUDGE_OUTPUT_CHARS: DEFAULT_MAX_JUDGE_OUTPUT_CHARS,
    MAX_JUDGE_TECHNIQUE_CARDS: DEFAULT_MAX_JUDGE_TECHNIQUE_CARDS,
    ABKB_JUDGE_POLL_SECONDS: DEFAULT_ABKB_JUDGE_POLL_SECONDS,
    ABKB_TELEMETRY_ENABLED: String(
      vscode.workspace
        .getConfiguration('selfEvolvingAgent')
        .get<boolean>('telemetry.enabled', true)
    ),
    ABKB_BACKGROUND_JUDGE_ENABLED: String(
      vscode.workspace
        .getConfiguration('selfEvolvingAgent')
        .get<boolean>('telemetry.externalJudgeEnabled', false)
    ),
    ABKB_INTEGRATOR_MODEL: DEFAULT_ABKB_INTEGRATOR_MODEL,
    ABKB_INTEGRATOR_TIMEOUT_SECONDS: DEFAULT_ABKB_INTEGRATOR_TIMEOUT_SECONDS,
    ABKB_INTEGRATOR_MAX_RETRIES: DEFAULT_ABKB_INTEGRATOR_MAX_RETRIES,
    NEO4J_URI: state.values.neo4jUri,
    NEO4J_USER: state.values.neo4jUser,
    NEO4J_PASSWORD: neo4jPassword ?? '',
    NEO4J_DATABASE: state.values.neo4jDatabase,
    CODEGRAPH_DATABASE: state.values.neo4jDatabase,
    LLM_PROVIDER: state.values.llmProvider,
    LLM_MODEL: state.values.llmModel,
    LLM_TIMEOUT_SECONDS: DEFAULT_LLM_TIMEOUT_SECONDS,
    EXECUTOR_STEP_TIMEOUT_SECONDS: DEFAULT_EXECUTOR_STEP_TIMEOUT_SECONDS,
    OPENAI_MODEL: state.values.llmModel,
    JUDGE_SMALL_OPENAI_MODEL: DEFAULT_JUDGE_SMALL_OPENAI_MODEL,
    JUDGE_BIG_OPENAI_MODEL: DEFAULT_JUDGE_BIG_OPENAI_MODEL,
    JUDGE_OPENAI_MODEL: DEFAULT_JUDGE_OPENAI_MODEL,
    OPENAI_API_KEY: openAiApiKey ?? '',
    PROJECT_ASSISTANT_DEV_LOGGING: String(
      context.extensionMode === vscode.ExtensionMode.Development
    )
  };
}

function workspaceRootPath(): string {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    throw new Error('Open a workspace folder before starting the backend.');
  }
  return root;
}

function readRuntimeConfigValues(): RuntimeConfigValues {
  const cfg = vscode.workspace.getConfiguration('selfEvolvingAgent');
  return {
    neo4jUri: clean(cfg.get<string>('neo4j.uri'), DEFAULT_NEO4J_URI),
    neo4jUser: clean(cfg.get<string>('neo4j.user'), DEFAULT_NEO4J_USER),
    neo4jDatabase: clean(cfg.get<string>('neo4j.database'), DEFAULT_NEO4J_DATABASE),
    llmProvider: clean(cfg.get<string>('llm.provider'), DEFAULT_LLM_PROVIDER),
    llmModel: clean(cfg.get<string>('llm.model'), DEFAULT_LLM_MODEL)
  };
}

function readRuntimeConfigSavedFlags(): Record<keyof RuntimeConfigValues, boolean> {
  const cfg = vscode.workspace.getConfiguration('selfEvolvingAgent');
  return {
    neo4jUri: hasSavedConfigValue(cfg, 'neo4j.uri'),
    neo4jUser: hasSavedConfigValue(cfg, 'neo4j.user'),
    neo4jDatabase: hasSavedConfigValue(cfg, 'neo4j.database'),
    llmProvider: hasSavedConfigValue(cfg, 'llm.provider'),
    llmModel: hasSavedConfigValue(cfg, 'llm.model')
  };
}

function hasSavedConfigValue(cfg: vscode.WorkspaceConfiguration, key: string): boolean {
  const inspected = cfg.inspect<string>(key);
  return Boolean(
    cleanOptionalSecret(inspected?.workspaceFolderValue) ??
    cleanOptionalSecret(inspected?.workspaceValue) ??
    cleanOptionalSecret(inspected?.globalValue)
  );
}

export async function getStoredNeo4jPassword(
  context: vscode.ExtensionContext
): Promise<string | undefined> {
  return cleanOptionalSecret(await context.secrets.get(secretKey('neo4jPassword')));
}

function clean(value: unknown, fallback: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || fallback;
}

function cleanOptionalSecret(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || undefined;
}

function secretKey(name: string): string {
  const workspaceId = vscode.workspace.workspaceFolders?.[0]?.uri.toString() ?? 'global';
  const digest = createHash('sha256').update(workspaceId).digest('hex').slice(0, 16);
  return `selfEvolvingAgent.${digest}.${name}`;
}
