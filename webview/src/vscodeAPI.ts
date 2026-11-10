interface VsCodeApi {
  postMessage: (message: unknown) => void;
  getState: <T = unknown>() => T | undefined;
  setState: <T>(state: T) => void;
}

declare function acquireVsCodeApi(): VsCodeApi;

let cachedApi: VsCodeApi | undefined;

try {
  cachedApi =
    typeof acquireVsCodeApi !== "undefined" ? acquireVsCodeApi() : undefined;
} catch {
  cachedApi = undefined;
}

export function getVscodeApi(): VsCodeApi | undefined {
  return cachedApi;
}
