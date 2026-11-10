import React, { FormEvent, useEffect, useRef, useState } from 'react';
import { KeyRound, Loader2, RefreshCw, Save } from 'lucide-react';
import { RuntimeConfigSavePayload } from '../types';
import { useConfigStore } from '../state/configStore';
import './ConfigPage.css';

const DEFAULTS: RuntimeConfigSavePayload = {
  neo4jUri: 'bolt://localhost:7687',
  neo4jUser: 'neo4j',
  neo4jDatabase: 'neo4j',
  llmProvider: 'openai',
  llmModel: 'gpt-4o-mini',
  openAiApiKey: '',
  neo4jPassword: ''
};

type ConfigPageProps = {
  mode?: 'setup' | 'settings';
  onSaved?: (details: { neo4jConfigChanged: boolean }) => void;
};

export default function ConfigPage({ mode = 'setup', onSaved }: ConfigPageProps) {
  const {
    config,
    status,
    error,
    save,
    models,
    modelsStatus,
    modelsError,
    loadModels
  } = useConfigStore();
  const [form, setForm] = useState<RuntimeConfigSavePayload>(DEFAULTS);
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const pageRef = useRef<HTMLDivElement>(null);
  const feedbackRef = useRef<HTMLDivElement>(null);
  const isSettings = mode === 'settings';

  useEffect(() => {
    if (!config) return;
    setForm((current) => ({
      ...current,
      ...config.values,
      openAiApiKey: '',
      neo4jPassword: '',
      clearOpenAiApiKey: false,
      clearNeo4jPassword: false
    }));
  }, [config]);

  const isBusy = status === 'loading' || status === 'saving' || status === 'starting';
  const isOpenAi = form.llmProvider.trim().toLowerCase() === 'openai';
  const hasTypedOpenAiKey = Boolean(form.openAiApiKey?.trim());
  const hasOpenAiKey = hasTypedOpenAiKey || (Boolean(config?.hasOpenAiApiKey) && !form.clearOpenAiApiKey);
  const missingFields = [
    !form.llmProvider.trim() ? 'LLM provider' : '',
    !form.llmModel.trim() ? 'Agent model' : ''
  ].filter(Boolean);
  const canSubmit = !isBusy && missingFields.length === 0;
  const canAttemptSubmit = !isBusy;
  const canLoadModels = isOpenAi && !isBusy && hasOpenAiKey;
  const isLoadingModels = modelsStatus === 'loading';
  const showMissingFields = submitAttempted && missingFields.length > 0;
  const showSaveError = submitAttempted && missingFields.length === 0 && Boolean(error);
  const showModelsError = isSettings && Boolean(modelsError) && isOpenAi;

  useEffect(() => {
    if (!isSettings || !isOpenAi || !config?.hasOpenAiApiKey || form.clearOpenAiApiKey || models.length > 0 || modelsStatus !== 'idle') return;
    void loadModels();
  }, [config?.hasOpenAiApiKey, form.clearOpenAiApiKey, isOpenAi, isSettings, loadModels, models.length, modelsStatus]);

  useEffect(() => {
    if (!showSaveError && !showMissingFields && !showModelsError) return;
    feedbackRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [showMissingFields, showModelsError, showSaveError]);

  const update = (key: keyof RuntimeConfigSavePayload, value: string) => {
    setForm((current) => ({
      ...current,
      [key]: value,
      ...(key === 'openAiApiKey' ? { clearOpenAiApiKey: false } : {}),
      ...(key === 'neo4jPassword' ? { clearNeo4jPassword: false } : {})
    }));
  };

  const handleProviderChange = (value: string) => {
    setForm((current) => ({
      ...current,
      llmProvider: value,
      llmModel: value === 'local'
        ? 'local-deterministic'
        : current.llmModel === 'local-deterministic'
          ? DEFAULTS.llmModel
          : current.llmModel
    }));
  };

  const handleLoadModels = () => {
    if (!canLoadModels || isLoadingModels) return;
    void loadModels(form.openAiApiKey?.trim() || undefined);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitAttempted(true);
    if (missingFields.length > 0) return;

    const neo4jConfigChanged = isSettings && Boolean(
      form.neo4jUri.trim() !== config?.values.neo4jUri ||
      form.neo4jUser.trim() !== config?.values.neo4jUser ||
      form.neo4jDatabase.trim() !== config?.values.neo4jDatabase ||
      form.neo4jPassword?.trim() ||
      form.clearNeo4jPassword
    );

    const ok = await save(form, { deferBackendStart: !isSettings });
    if (ok) {
      setSubmitAttempted(false);
      onSaved?.({ neo4jConfigChanged });
    }
  };

  const submitText = status === 'loading'
    ? 'Loading...'
    : isBusy
      ? isSettings
        ? 'Saving...'
        : 'Starting...'
      : isSettings
        ? 'Save'
        : 'Start Creating Graph';

  return (
    <div ref={pageRef} className={`config-page ${isSettings ? 'embedded' : 'setup'}`}>
      <form className="config-panel" onSubmit={handleSubmit} noValidate>
        {!isSettings && (
          <div className="config-title-row">
            <div>
              <h2>Project Assistant</h2>
              <p>Visualize your codebase as an interactive graph and chat with Project Assistant.</p>
            </div>
          </div>
        )}

        {isSettings && (
          <>
            <div className="config-grid">
          <label className="config-field">
            <span>Neo4j URI</span>
            <input
              className="text-input"
              value={form.neo4jUri}
              onChange={(e) => update('neo4jUri', e.target.value)}
              disabled={isBusy}
            />
          </label>

          <label className="config-field">
            <span>Neo4j User</span>
            <input
              className="text-input"
              value={form.neo4jUser}
              onChange={(e) => update('neo4jUser', e.target.value)}
              disabled={isBusy}
            />
          </label>

          <label className="config-field">
            <span>Neo4j Password</span>
            <input
              className="text-input"
              type="password"
              value={form.neo4jPassword ?? ''}
              onChange={(e) => update('neo4jPassword', e.target.value)}
              placeholder={config?.hasNeo4jPassword && !form.clearNeo4jPassword ? '••••••••' : undefined}
              disabled={isBusy}
            />
            {isSettings && config?.hasNeo4jPassword && !form.clearNeo4jPassword && (
              <button
                type="button"
                className="secondary-btn"
                disabled={isBusy}
                onClick={() => setForm((current) => ({
                  ...current,
                  neo4jPassword: '',
                  clearNeo4jPassword: true
                }))}
              >
                Remove Neo4j password
              </button>
            )}
          </label>

          <label className="config-field">
            <span>Neo4j Database</span>
            <input
              className="text-input"
              value={form.neo4jDatabase}
              onChange={(e) => update('neo4jDatabase', e.target.value)}
              disabled={isBusy}
            />
          </label>

          <label className="config-field">
            <span>LLM Provider</span>
            <select
              className="text-input"
              value={form.llmProvider}
              onChange={(e) => handleProviderChange(e.target.value)}
              disabled={isBusy}
              required
            >
              <option value="openai">OpenAI</option>
              <option value="local">Local fallback</option>
            </select>
          </label>

          <label className="config-field">
            <span>Agent Model</span>
            <div className="config-model-row">
              <input
                className="text-input"
                list={isOpenAi ? 'openai-model-options' : undefined}
                value={form.llmModel}
                onChange={(e) => update('llmModel', e.target.value)}
                disabled={isBusy || !isOpenAi}
                required
              />
              <button
                className="config-icon-btn"
                type="button"
                onClick={handleLoadModels}
                disabled={!canLoadModels || isLoadingModels}
                aria-label="Refresh OpenAI models"
                title="Refresh OpenAI models"
              >
                {isLoadingModels ? <Loader2 className="spinner-inline" size={15} /> : <RefreshCw size={15} />}
              </button>
            </div>
            <datalist id="openai-model-options">
              {models.map((model) => (
                <option key={model.id} value={model.id} />
              ))}
            </datalist>
          </label>
            </div>

            <label className="config-field config-secret-field">
          <span><KeyRound size={14} /> OpenAI API Key</span>
          <input
            className="text-input"
            type="password"
            value={form.openAiApiKey ?? ''}
            onChange={(e) => update('openAiApiKey', e.target.value)}
            placeholder={config?.hasOpenAiApiKey && !form.clearOpenAiApiKey ? '••••••••' : undefined}
            disabled={isBusy || !isOpenAi}
          />
          {isSettings && config?.hasOpenAiApiKey && !form.clearOpenAiApiKey && (
            <button
              type="button"
              className="secondary-btn"
              disabled={isBusy}
              onClick={() => setForm((current) => ({
                ...current,
                openAiApiKey: '',
                clearOpenAiApiKey: true
              }))}
            >
              Remove API key
            </button>
          )}
            </label>
          </>
        )}

        <div ref={feedbackRef} className="config-feedback">
          {showSaveError && <div className="config-error">{error}</div>}
          {showMissingFields ? (
            <div className="config-missing">Missing: {missingFields.join(', ')}</div>
          ) : null}
          {showModelsError ? <div className="config-error">{modelsError}</div> : null}
        </div>

        <button className={`primary-btn config-save ${canSubmit ? 'ready' : ''}`} type="submit" disabled={!canAttemptSubmit}>
          {isBusy ? <Loader2 className="spinner-inline" size={16} /> : isSettings ? <Save size={16} /> : null}
          <span>{submitText}</span>
        </button>
      </form>
    </div>
  );
}
