import { create } from 'zustand';
import { OpenAiModelOption, RuntimeConfigPayload, RuntimeConfigSavePayload } from '../types';
import { getRuntimeConfig, listOpenAiModels, saveRuntimeConfig } from '../services/configService';
import { ensureBackendStarted } from '../services/graphService';

type ConfigStatus = 'loading' | 'missing' | 'configured' | 'saving' | 'starting' | 'ready' | 'error';
type ModelsStatus = 'idle' | 'loading' | 'ready' | 'error';

interface ConfigState {
  status: ConfigStatus;
  config: RuntimeConfigPayload | null;
  error: string | null;
  models: OpenAiModelOption[];
  modelsStatus: ModelsStatus;
  modelsError: string | null;
  hydrate: () => Promise<void>;
  save: (
    config: RuntimeConfigSavePayload,
    options?: { deferBackendStart?: boolean }
  ) => Promise<boolean>;
  startBackend: () => Promise<void>;
  markBackendReady: () => void;
  loadModels: (apiKey?: string) => Promise<void>;
}

export const useConfigStore = create<ConfigState>((set, get) => ({
  status: 'loading',
  config: null,
  error: null,
  models: [],
  modelsStatus: 'idle',
  modelsError: null,

  hydrate: async () => {
    if (get().config && get().status !== 'error') return;
    set({ status: 'loading', error: null });
    try {
      const config = await getRuntimeConfig();
      set({
        config,
        status: config.isConfigured ? 'configured' : 'missing',
        error: null
      });
    } catch (e) {
      set({
        status: 'error',
        error: friendlyConfigError(e, 'Failed to load setup'),
      });
    }
  },

  save: async (input, options) => {
    set({ status: 'saving', error: null });
    try {
      const result = options
        ? await saveRuntimeConfig(input, options)
        : await saveRuntimeConfig(input);
      if (!result.config.isConfigured) {
        set({
          config: result.config,
          status: 'missing',
          error: result.config.missing.length
            ? `Missing: ${result.config.missing.join(', ')}`
            : null
        });
        return false;
      }

      set({ config: result.config, status: 'configured', error: null });
      return true;
    } catch (e) {
      set({
        status: 'error',
        error: friendlyConfigError(e, 'Failed to save setup')
      });
      return false;
    }
  },

  startBackend: async () => {
    const state = get();
    if (state.status === 'ready' || state.status === 'starting') return;
    if (!state.config?.isConfigured) {
      set({ status: 'missing' });
      return;
    }

    set({ status: 'starting', error: null });
    try {
      await ensureBackendStarted();
      set({ status: 'ready', error: null });
    } catch (e) {
      set({
        status: 'error',
        error: friendlyConfigError(e, 'Backend did not start.')
      });
    }
  },

  markBackendReady: () => {
    const state = get();
    if (!state.config?.isConfigured) return;
    set({ status: 'ready', error: null });
  },

  loadModels: async (apiKey) => {
    set({ modelsStatus: 'loading', modelsError: null });
    try {
      const models = await listOpenAiModels(apiKey);
      set({ models, modelsStatus: 'ready', modelsError: null });
    } catch (e) {
      set({
        modelsStatus: 'error',
        modelsError: friendlyConfigError(e, 'Failed to load OpenAI models')
      });
    }
  }
}));

function friendlyConfigError(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : String(error || '');
  const withoutCode = raw.replace(/^\[[A-Z0-9_]+\]\s*/i, '').trim();
  if (!withoutCode) return fallback;

  const lower = withoutCode.toLowerCase();
  if (lower.includes('incorrect api') || lower.includes('api key')) {
    return 'Incorrect API key.';
  }
  if (lower.includes('neo4j') && (lower.includes('auth') || lower.includes('username') || lower.includes('password'))) {
    return 'Incorrect Neo4j username or password.';
  }
  if (lower.includes('could not connect to neo4j') || lower.includes('neo4j is running')) {
    return 'Could not connect to Neo4j. Check the URI and make sure Neo4j is running.';
  }
  if (lower.includes('database was not found')) {
    return 'Neo4j database was not found.';
  }

  return withoutCode;
}
