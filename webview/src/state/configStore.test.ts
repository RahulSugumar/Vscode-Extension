import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  configuredRuntime,
  unconfiguredRuntime,
} from "../test/fixtures";

const serviceMocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(),
  listOpenAiModels: vi.fn(),
  saveRuntimeConfig: vi.fn(),
  ensureBackendStarted: vi.fn(),
}));

vi.mock("../services/configService", () => ({
  getRuntimeConfig: serviceMocks.getRuntimeConfig,
  listOpenAiModels: serviceMocks.listOpenAiModels,
  saveRuntimeConfig: serviceMocks.saveRuntimeConfig,
}));
vi.mock("../services/graphService", () => ({
  ensureBackendStarted: serviceMocks.ensureBackendStarted,
}));

import { useConfigStore } from "./configStore";

const initialState = useConfigStore.getState();
const saveInput = {
  ...configuredRuntime.values,
  openAiApiKey: "sk-test",
  neo4jPassword: "password",
};

beforeEach(() => {
  Object.values(serviceMocks).forEach((mock) => mock.mockReset());
  useConfigStore.setState({
    ...initialState,
    status: "loading",
    config: null,
    error: null,
    models: [],
    modelsStatus: "idle",
    modelsError: null,
  });
});

describe("configStore", () => {
  it.each([
    [configuredRuntime, "configured"],
    [unconfiguredRuntime, "missing"],
  ] as const)("hydrates configured and missing states", async (config, status) => {
    serviceMocks.getRuntimeConfig.mockResolvedValue(config);
    await useConfigStore.getState().hydrate();
    expect(useConfigStore.getState()).toMatchObject({ config, status, error: null });
  });

  it("does not hydrate again when usable configuration is already loaded", async () => {
    useConfigStore.setState({ config: configuredRuntime, status: "configured" });
    await useConfigStore.getState().hydrate();
    expect(serviceMocks.getRuntimeConfig).not.toHaveBeenCalled();
  });

  it.each([
    [new Error("[AUTH] incorrect api key"), "Incorrect API key."],
    [new Error("Neo4j authentication failed"), "Incorrect Neo4j username or password."],
    [new Error("Could not connect to Neo4j; make sure Neo4j is running"), "Could not connect to Neo4j. Check the URI and make sure Neo4j is running."],
    [new Error("Database was not found"), "Neo4j database was not found."],
    [new Error("[OTHER] Useful detail"), "Useful detail"],
    [null, "Failed to load setup"],
  ])("turns backend failures into friendly hydrate errors", async (failure, message) => {
    serviceMocks.getRuntimeConfig.mockRejectedValue(failure);
    await useConfigStore.getState().hydrate();
    expect(useConfigStore.getState()).toMatchObject({ status: "error", error: message });
  });

  it("saves valid configuration and reports success", async () => {
    serviceMocks.saveRuntimeConfig.mockResolvedValue({
      config: configuredRuntime,
      backendStarted: false,
    });
    await expect(useConfigStore.getState().save(saveInput)).resolves.toBe(true);
    expect(serviceMocks.saveRuntimeConfig).toHaveBeenCalledWith(saveInput);
    expect(useConfigStore.getState()).toMatchObject({
      config: configuredRuntime,
      status: "configured",
      error: null,
    });
  });

  it("forwards deferred backend startup during initial setup", async () => {
    serviceMocks.saveRuntimeConfig.mockResolvedValue({
      config: configuredRuntime,
      backendStarted: false,
    });

    await expect(
      useConfigStore.getState().save(saveInput, { deferBackendStart: true }),
    ).resolves.toBe(true);
    expect(serviceMocks.saveRuntimeConfig).toHaveBeenCalledWith(saveInput, {
      deferBackendStart: true,
    });
  });

  it("keeps invalid saved configuration in the missing state", async () => {
    serviceMocks.saveRuntimeConfig.mockResolvedValue({
      config: unconfiguredRuntime,
      backendStarted: false,
    });
    await expect(useConfigStore.getState().save(saveInput)).resolves.toBe(false);
    expect(useConfigStore.getState()).toMatchObject({
      status: "missing",
      error: "Missing: LLM provider",
    });

    serviceMocks.saveRuntimeConfig.mockResolvedValue({
      config: { ...unconfiguredRuntime, missing: [] },
      backendStarted: false,
    });
    await useConfigStore.getState().save(saveInput);
    expect(useConfigStore.getState().error).toBeNull();
  });

  it("returns false and stores friendly save errors", async () => {
    serviceMocks.saveRuntimeConfig.mockRejectedValue(new Error("api key invalid"));
    await expect(useConfigStore.getState().save(saveInput)).resolves.toBe(false);
    expect(useConfigStore.getState()).toMatchObject({
      status: "error",
      error: "Incorrect API key.",
    });
  });

  it("starts only a configured, non-running backend", async () => {
    await useConfigStore.getState().startBackend();
    expect(useConfigStore.getState().status).toBe("missing");
    expect(serviceMocks.ensureBackendStarted).not.toHaveBeenCalled();

    const localGraphOnlyRuntime = {
      ...configuredRuntime,
      isChatConfigured: false,
      isNeo4jConfigured: false,
      chatMissing: ["Neo4j password", "OpenAI API key"],
      hasOpenAiApiKey: false,
      hasNeo4jPassword: false,
    };
    useConfigStore.setState({
      config: localGraphOnlyRuntime,
      status: "configured",
    });
    serviceMocks.ensureBackendStarted.mockResolvedValue(undefined);
    await useConfigStore.getState().startBackend();
    expect(useConfigStore.getState().status).toBe("ready");

    await useConfigStore.getState().startBackend();
    expect(serviceMocks.ensureBackendStarted).toHaveBeenCalledOnce();
    useConfigStore.setState({ status: "starting" });
    await useConfigStore.getState().startBackend();
    expect(serviceMocks.ensureBackendStarted).toHaveBeenCalledOnce();
  });

  it("records backend startup failures", async () => {
    useConfigStore.setState({ config: configuredRuntime, status: "configured" });
    serviceMocks.ensureBackendStarted.mockRejectedValue(new Error("Neo4j password rejected"));
    await useConfigStore.getState().startBackend();
    expect(useConfigStore.getState()).toMatchObject({
      status: "error",
      error: "Incorrect Neo4j username or password.",
    });
  });

  it("marks only configured backends ready", () => {
    useConfigStore.setState({ config: unconfiguredRuntime, status: "configured" });
    useConfigStore.getState().markBackendReady();
    expect(useConfigStore.getState().status).toBe("configured");

    useConfigStore.setState({ config: configuredRuntime, error: "old" });
    useConfigStore.getState().markBackendReady();
    expect(useConfigStore.getState()).toMatchObject({ status: "ready", error: null });
  });

  it("loads model choices and records failures independently", async () => {
    const models = [{ id: "gpt-test" }];
    serviceMocks.listOpenAiModels.mockResolvedValueOnce(models);
    await useConfigStore.getState().loadModels("key");
    expect(serviceMocks.listOpenAiModels).toHaveBeenCalledWith("key");
    expect(useConfigStore.getState()).toMatchObject({
      models,
      modelsStatus: "ready",
      modelsError: null,
    });

    serviceMocks.listOpenAiModels.mockRejectedValueOnce(new Error("No models"));
    await useConfigStore.getState().loadModels();
    expect(useConfigStore.getState()).toMatchObject({
      modelsStatus: "error",
      modelsError: "No models",
    });
  });
});
