import {
  HostRequest,
  HostResponse,
  RequestWithoutId,
} from "../types/messaging";
import { getVscodeApi } from "../vscodeAPI";

type Pending = {
  resolve: (value: HostResponse) => void;
  reject: (reason: Error) => void;
};

const pending = new Map<string, Pending>();

// Single global listener for all correlated responses.
window.addEventListener("message", (event: MessageEvent<HostResponse>) => {
  const msg = event.data;
  if (!msg || typeof msg !== "object") return;

  const requestId = (msg as { requestId?: string }).requestId;
  if (!requestId) return; // push messages handled by feature-specific listeners
  const entry = pending.get(requestId);
  if (!entry) return;

  pending.delete(requestId);

  if (msg.command === "error") {
    entry.reject(new Error(`[${msg.code}] ${msg.message}`));
  } else {
    entry.resolve(msg);
  }
});

function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Fire-and-forget post (for UI commands like `ui.openGraphPanel`).
 */
export function postRequest(req: HostRequest): void {
  const vscode = getVscodeApi();
  if (!vscode) {
    return;
  }
  vscode.postMessage(req);
}

/**
 * Round-trip request with correlation id.
 *
 * Uses `RequestWithoutId` (a distributive Omit) so each command's specific
 * fields remain type-checked at the call site.
 */
export function request<TResponse extends HostResponse>(
  req: RequestWithoutId,
): Promise<TResponse> {
  const vscode = getVscodeApi();
  const requestId = generateRequestId();
  const fullReq = { ...req, requestId } as HostRequest;

  return new Promise<TResponse>((resolve, reject) => {
    if (!vscode) {
      reject(new Error("VS Code API unavailable."));
      return;
    }

    pending.set(requestId, {
      resolve: (v) => resolve(v as TResponse),
      reject,
    });

    vscode.postMessage(fullReq);
  });
}

/**
 * Subscribe to host push messages (no requestId), e.g. streaming tokens.
 */
export function onPush<T extends HostResponse>(
  command: T["command"],
  handler: (msg: T) => void,
): () => void {
  const listener = (event: MessageEvent<HostResponse>) => {
    const msg = event.data;
    if (
      msg &&
      msg.command === command &&
      !(msg as { requestId?: string }).requestId
    ) {
      handler(msg as T);
    }
  };
  window.addEventListener("message", listener);
  return () => window.removeEventListener("message", listener);
}
