import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  configuredRuntime,
  graphEdge,
  graphNode,
  logEntry,
  policy,
  reviewResolution,
  session,
} from "../test/fixtures";
import type { PolicyPayload } from "../types";

const hostMocks = vi.hoisted(() => ({
  request: vi.fn(),
  onPush: vi.fn(),
}));

vi.mock("./host", () => hostMocks);

import { acceptPolicy, addCustomPolicy, discardPolicy } from "./abkbService";
import { sendChatPrompt, subscribeToChatTokens } from "./chatService";
import {
  getRuntimeConfig,
  listOpenAiModels,
  saveRuntimeConfig,
} from "./configService";
import {
  ensureBackendStarted,
  getGraph,
  installLsp,
  proceedWithLsp,
  regenerateGraph,
} from "./graphService";
import { fetchSuggestions } from "./judgeService";
import { fetchLogs } from "./logService";
import {
  createSession,
  deleteSession,
  listSessions,
  renameSession,
} from "./sessionService";

beforeEach(() => {
  hostMocks.request.mockReset();
  hostMocks.onPush.mockReset();
});

describe("chatService", () => {
  it("sends a chat prompt and returns only the response text", async () => {
    hostMocks.request.mockResolvedValue({ text: "Answer" });

    await expect(sendChatPrompt("s1", "Question")).resolves.toBe("Answer");
    expect(hostMocks.request).toHaveBeenCalledWith({
      command: "chat.send",
      sessionId: "s1",
      text: "Question",
    });
  });

  it("forwards tokens only for the subscribed session and returns unsubscribe", () => {
    const unsubscribe = vi.fn();
    let listener: ((message: { sessionId: string; text: string }) => void) | undefined;
    hostMocks.onPush.mockImplementation((_command, callback) => {
      listener = callback;
      return unsubscribe;
    });
    const onToken = vi.fn();

    expect(subscribeToChatTokens("wanted", onToken)).toBe(unsubscribe);
    expect(hostMocks.onPush).toHaveBeenCalledWith("chat.token", expect.any(Function));

    listener?.({ sessionId: "other", text: "ignored" });
    listener?.({ sessionId: "wanted", text: "kept" });
    expect(onToken).toHaveBeenCalledTimes(1);
    expect(onToken).toHaveBeenCalledWith("kept");
  });
});

describe("configService", () => {
  it("gets and saves runtime configuration", async () => {
    hostMocks.request
      .mockResolvedValueOnce({ config: configuredRuntime })
      .mockResolvedValueOnce({
        config: configuredRuntime,
        backendStarted: true,
        runtimeConfigApplied: true,
        startError: undefined,
      });

    await expect(getRuntimeConfig()).resolves.toBe(configuredRuntime);
    expect(hostMocks.request).toHaveBeenNthCalledWith(1, { command: "config.get" });

    const input = { ...configuredRuntime.values, openAiApiKey: "secret" };
    await expect(
      saveRuntimeConfig(input, { deferBackendStart: true }),
    ).resolves.toEqual({
      config: configuredRuntime,
      backendStarted: true,
      runtimeConfigApplied: true,
      startError: undefined,
    });
    expect(hostMocks.request).toHaveBeenNthCalledWith(2, {
      command: "config.save",
      config: input,
      deferBackendStart: true,
    });
  });

  it.each([
    ["  sk-test  ", "sk-test"],
    ["   ", undefined],
    [undefined, undefined],
  ])("normalizes an API key before listing models", async (input, expected) => {
    const models = [{ id: "gpt-test" }];
    hostMocks.request.mockResolvedValue({ models });

    await expect(listOpenAiModels(input)).resolves.toEqual(models);
    expect(hostMocks.request).toHaveBeenCalledWith({
      command: "config.listModels",
      apiKey: expected,
    });
  });
});

describe("graphService", () => {
  it("starts the backend and maps graph payloads", async () => {
    hostMocks.request
      .mockResolvedValueOnce({ command: "backend.ready" })
      .mockResolvedValueOnce({ nodes: [graphNode], edges: [graphEdge] })
      .mockResolvedValueOnce({ nodes: [graphNode], edges: [graphEdge] });

    await expect(ensureBackendStarted()).resolves.toBeUndefined();
    await expect(getGraph()).resolves.toEqual({ nodes: [graphNode], edges: [graphEdge] });
    await expect(proceedWithLsp()).resolves.toEqual({ nodes: [graphNode], edges: [graphEdge] });
    expect(hostMocks.request.mock.calls).toEqual([
      [{ command: "backend.ensureStarted" }],
      [{ command: "graph.get" }],
      [{ command: "graph.proceedWithLsp" }],
    ]);
  });

  it.each([
    [
      { command: "graph.data", nodes: [graphNode], edges: [graphEdge] },
      { type: "data", nodes: [graphNode], edges: [graphEdge] },
    ],
    [
      { command: "graph.lspCheckRequired", missing: [{ id: "python" }] },
      { type: "lspCheckRequired", missing: [{ id: "python" }] },
    ],
    [
      { command: "graph.lspCheckPassed" },
      { type: "lspCheckPassed" },
    ],
  ])("normalizes every regenerate result", async (response, expected) => {
    hostMocks.request.mockResolvedValue(response);
    await expect(regenerateGraph()).resolves.toEqual(expected);
    expect(hostMocks.request).toHaveBeenCalledWith({ command: "graph.regenerate" });
  });

  it("passes missing language servers to the host and reports success", async () => {
    const missing = [{ extensionId: "ms-python.python" }];
    hostMocks.request.mockResolvedValue({ command: "lsp.installSuccess" });

    await expect(installLsp(missing)).resolves.toBe(true);
    expect(hostMocks.request).toHaveBeenCalledWith({ command: "lsp.install", missing });
  });
});

describe("policy services", () => {
  it("activates accepted policies using response, response-policy, and fallback ids", async () => {
    hostMocks.request
      .mockResolvedValueOnce({ id: "stored", policy: { ...policy, id: "stored" } })
      .mockResolvedValueOnce({ policy: { ...policy, id: "from-policy" } })
      .mockResolvedValueOnce({});

    await expect(
      acceptPolicy(policy, { deletePolicyIds: [2], forceReplace: true }),
    ).resolves.toMatchObject({ status: "activated", id: "stored" });
    await expect(acceptPolicy(policy)).resolves.toMatchObject({
      status: "activated",
      id: "from-policy",
    });
    await expect(acceptPolicy(policy)).resolves.toEqual({
      status: "activated",
      id: policy.id,
      policy,
    });
    expect(hostMocks.request).toHaveBeenNthCalledWith(1, {
      command: "abkb.acceptPolicy",
      policy,
      deletePolicyIds: [2],
      forceReplace: true,
    });
  });

  it("returns a review resolution and defaults missing conflicts", async () => {
    hostMocks.request.mockResolvedValue({
      needsReview: true,
      policy: reviewResolution.candidate,
      review: reviewResolution.review,
    });

    await expect(acceptPolicy(policy)).resolves.toEqual({
      ...reviewResolution,
      conflictingPolicies: [],
    });
  });

  it("adds custom policies and discards policies", async () => {
    const custom: Omit<PolicyPayload, "id"> = {
      policy: "Custom",
      scope_type: "tool",
      scope_id: "terminal",
    };
    hostMocks.request
      .mockResolvedValueOnce({ id: "custom-1" })
      .mockResolvedValueOnce({ discardedId: "custom-1" });

    await expect(addCustomPolicy(custom)).resolves.toEqual({
      status: "activated",
      id: "custom-1",
      policy: { id: "custom-1", ...custom },
    });
    await expect(discardPolicy("custom-1")).resolves.toBeUndefined();
    expect(hostMocks.request).toHaveBeenNthCalledWith(1, {
      command: "abkb.addCustomPolicy",
      policy: custom,
      deletePolicyIds: undefined,
      forceReplace: undefined,
    });
    expect(hostMocks.request).toHaveBeenNthCalledWith(2, {
      command: "abkb.discardPolicy",
      policyId: "custom-1",
    });
  });
});

describe("judge, log, and session services", () => {
  it("maps suggestion and log responses", async () => {
    hostMocks.request
      .mockResolvedValueOnce({ policies: [policy], selectedId: policy.id })
      .mockResolvedValueOnce({ logs: [logEntry] });

    await expect(fetchSuggestions("session-1")).resolves.toEqual({
      policies: [policy],
      selectedId: policy.id,
    });
    await expect(fetchLogs()).resolves.toEqual([logEntry]);
    expect(hostMocks.request.mock.calls).toEqual([
      [{ command: "judge.getSuggestions", sessionId: "session-1" }],
      [{ command: "logs.list" }],
    ]);
  });

  it("supports the complete session lifecycle", async () => {
    const renamed = { ...session, name: "Renamed" };
    hostMocks.request
      .mockResolvedValueOnce({ sessions: [session] })
      .mockResolvedValueOnce({ session })
      .mockResolvedValueOnce({ session: renamed })
      .mockResolvedValueOnce({ id: session.id });

    await expect(listSessions()).resolves.toEqual([session]);
    await expect(createSession("First session")).resolves.toEqual(session);
    await expect(renameSession(session.id, "Renamed")).resolves.toEqual(renamed);
    await expect(deleteSession(session.id)).resolves.toBeUndefined();
    expect(hostMocks.request.mock.calls).toEqual([
      [{ command: "sessions.list" }],
      [{ command: "sessions.create", name: "First session" }],
      [{ command: "sessions.rename", id: session.id, name: "Renamed" }],
      [{ command: "sessions.delete", id: session.id }],
    ]);
  });
});
