import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe("getVscodeApi", () => {
  it("returns undefined outside VS Code", async () => {
    vi.stubGlobal("acquireVsCodeApi", undefined);
    const { getVscodeApi } = await import("./vscodeAPI");
    expect(getVscodeApi()).toBeUndefined();
  });

  it("acquires once and returns the cached API", async () => {
    const api = {
      postMessage: vi.fn(),
      getState: vi.fn(),
      setState: vi.fn(),
    };
    const acquire = vi.fn(() => api);
    vi.stubGlobal("acquireVsCodeApi", acquire);

    const { getVscodeApi } = await import("./vscodeAPI");
    expect(getVscodeApi()).toBe(api);
    expect(getVscodeApi()).toBe(api);
    expect(acquire).toHaveBeenCalledTimes(1);
  });

  it("fails safely when VS Code acquisition throws", async () => {
    vi.stubGlobal(
      "acquireVsCodeApi",
      vi.fn(() => {
        throw new Error("not a webview");
      }),
    );

    const { getVscodeApi } = await import("./vscodeAPI");
    expect(getVscodeApi()).toBeUndefined();
  });
});
