import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getVscodeApi = vi.fn();

async function loadHost() {
  vi.doMock("../vscodeAPI", () => ({ getVscodeApi }));
  return import("./host");
}

beforeEach(() => {
  vi.resetModules();
  getVscodeApi.mockReset();
});

afterEach(() => {
  vi.doUnmock("../vscodeAPI");
});

describe("host bridge", () => {
  it("silently drops fire-and-forget messages without a VS Code API", async () => {
    getVscodeApi.mockReturnValue(undefined);
    const { postRequest } = await loadHost();
    expect(() => postRequest({ command: "ui.openGraphPanel" })).not.toThrow();
  });

  it("posts fire-and-forget messages unchanged", async () => {
    const postMessage = vi.fn();
    getVscodeApi.mockReturnValue({ postMessage });
    const { postRequest } = await loadHost();
    const message = { command: "ui.alert", text: "Hello" } as const;

    postRequest(message);
    expect(postMessage).toHaveBeenCalledWith(message);
  });

  it("rejects round trips when the VS Code API is unavailable", async () => {
    getVscodeApi.mockReturnValue(undefined);
    const { request } = await loadHost();
    await expect(request({ command: "graph.get" })).rejects.toThrow(
      "VS Code API unavailable.",
    );
  });

  it("adds a correlation id and resolves the matching response", async () => {
    const postMessage = vi.fn();
    getVscodeApi.mockReturnValue({ postMessage });
    vi.spyOn(Date, "now").mockReturnValue(1234);
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const { request } = await loadHost();

    const result = request<{ command: "graph.data"; requestId?: string; nodes: []; edges: [] }>({
      command: "graph.get",
    });
    const sent = postMessage.mock.calls[0][0];
    expect(sent).toMatchObject({ command: "graph.get" });
    expect(sent.requestId).toMatch(/^req_1234_/);

    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          command: "graph.data",
          requestId: sent.requestId,
          nodes: [],
          edges: [],
        },
      }),
    );
    await expect(result).resolves.toMatchObject({ command: "graph.data" });
  });

  it("rejects a correlated host error and ignores malformed messages", async () => {
    const postMessage = vi.fn();
    getVscodeApi.mockReturnValue({ postMessage });
    const { request } = await loadHost();
    const result = request({ command: "graph.get" });
    const requestId = postMessage.mock.calls[0][0].requestId;

    window.dispatchEvent(new MessageEvent("message", { data: null }));
    window.dispatchEvent(new MessageEvent("message", { data: { command: "graph.data" } }));
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { command: "graph.data", requestId: "unknown", nodes: [], edges: [] },
      }),
    );
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { command: "error", requestId, code: "BROKEN", message: "No graph" },
      }),
    );

    await expect(result).rejects.toThrow("[BROKEN] No graph");
  });

  it("subscribes only to uncorrelated pushes and unsubscribes", async () => {
    getVscodeApi.mockReturnValue({ postMessage: vi.fn() });
    const { onPush } = await loadHost();
    const handler = vi.fn();
    const unsubscribe = onPush<{
      command: "chat.token";
      sessionId: string;
      text: string;
    }>("chat.token", handler);

    window.dispatchEvent(
      new MessageEvent("message", {
        data: { command: "chat.token", sessionId: "s", text: "one" },
      }),
    );
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { command: "chat.token", requestId: "r", sessionId: "s", text: "two" },
      }),
    );
    window.dispatchEvent(
      new MessageEvent("message", { data: { command: "logs.append", log: {} } }),
    );
    expect(handler).toHaveBeenCalledOnce();

    unsubscribe();
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { command: "chat.token", sessionId: "s", text: "three" },
      }),
    );
    expect(handler).toHaveBeenCalledOnce();
  });
});
