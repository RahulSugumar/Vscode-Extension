import { OpenAiModelOption, RuntimeConfigPayload, RuntimeConfigSavePayload } from '../types';
import { request } from './host';

export async function getRuntimeConfig(): Promise<RuntimeConfigPayload> {
  const res = await request<{ command: 'config.state'; requestId: string; config: RuntimeConfigPayload }>(
    { command: 'config.get' }
  );
  return res.config;
}

export async function saveRuntimeConfig(
  config: RuntimeConfigSavePayload,
  options: { deferBackendStart?: boolean } = {}
): Promise<{
  config: RuntimeConfigPayload;
  backendStarted: boolean;
  runtimeConfigApplied?: boolean;
  startError?: string;
}> {
  const res = await request<{
    command: 'config.saved';
    requestId: string;
    config: RuntimeConfigPayload;
    backendStarted: boolean;
    runtimeConfigApplied?: boolean;
    startError?: string;
  }>({
    command: 'config.save',
    config,
    ...(options.deferBackendStart !== undefined
      ? { deferBackendStart: options.deferBackendStart }
      : {})
  });
  return {
    config: res.config,
    backendStarted: res.backendStarted,
    runtimeConfigApplied: res.runtimeConfigApplied,
    startError: res.startError
  };
}

export async function listOpenAiModels(apiKey?: string): Promise<OpenAiModelOption[]> {
  const cleanedApiKey = apiKey?.trim() || undefined;
  const res = await request<{
    command: 'config.models';
    requestId: string;
    models: OpenAiModelOption[];
  }>({ command: 'config.listModels', apiKey: cleanedApiKey });
  return res.models;
}
