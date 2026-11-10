import { AgentConfig } from "./config";

export type BackendSseEvent = {
  event: string;
  data: Record<string, unknown>;
};

export type BackendStreamOptions = {
  /** Abort when the backend sends no bytes for this long. */
  inactivityTimeoutMs?: number;
};

/**
 * Single seam between the extension and the future Agent Improvement Plane backend.
 * When `useMockBackend` is true (default), `call` throws and the router falls back
 * to its built-in mocks. When the backend is ready, flip the setting and this client
 * will issue real HTTP requests.
 */
export class BackendClient {
  private baseUrl: string;
  private authToken = "";

  constructor(private config: AgentConfig) {
    this.baseUrl = config.baseUrl;
  }

  public updateConfig(config: AgentConfig): void {
    this.config = config;
    if (!this.authToken) this.baseUrl = config.baseUrl;
  }

  public connect(baseUrl: string, authToken: string): void {
    this.baseUrl = baseUrl;
    this.authToken = authToken;
  }

  public isMock(): boolean {
    return this.config.useMockBackend;
  }

  public async call<TResp>(path: string, body: unknown): Promise<TResp> {
    if (this.config.useMockBackend) {
      throw new Error("MOCK_MODE");
    }
    const url = `${this.baseUrl.replace(/\/$/, "")}${path}`;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.authToken
          ? { Authorization: `Bearer ${this.authToken}` }
          : {}),
      },
      body: JSON.stringify(body ?? {}),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Backend ${res.status}: ${text || res.statusText}`);
    }
    return (await res.json()) as TResp;
  }

  public async streamEvents(
    path: string,
    body: unknown,
    onEvent: (event: BackendSseEvent) => void,
    options: BackendStreamOptions = {},
  ): Promise<void> {
    if (this.config.useMockBackend) {
      throw new Error("MOCK_MODE");
    }

    const url = `${this.baseUrl.replace(/\/$/, "")}${path}`;
    const controller = new AbortController();
    const inactivityTimeoutMs = options.inactivityTimeoutMs;
    let inactivityTimer: NodeJS.Timeout | undefined;
    let timedOut = false;
    const armInactivityTimer = () => {
      if (!inactivityTimeoutMs || inactivityTimeoutMs <= 0) return;
      if (inactivityTimer) clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, inactivityTimeoutMs);
    };

    armInactivityTimer();
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Accept: "text/event-stream",
          "Content-Type": "application/json",
          ...(this.authToken
            ? { Authorization: `Bearer ${this.authToken}` }
            : {}),
        },
        body: JSON.stringify(body ?? {}),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Backend ${res.status}: ${text || res.statusText}`);
      }
      if (!res.body) {
        throw new Error("Backend stream response did not include a body.");
      }

      armInactivityTimer();
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        armInactivityTimer();
        buffer = (buffer + decoder.decode(value, { stream: true })).replace(
          /\r\n/g,
          "\n",
        );
        buffer = this.drainSseBuffer(buffer, onEvent);
      }

      buffer = (buffer + decoder.decode()).replace(/\r\n/g, "\n");
      const finalFrame = buffer.trim();
      if (finalFrame) {
        const event = this.parseSseFrame(finalFrame);
        if (event) onEvent(event);
      }
    } catch (error) {
      if (timedOut && inactivityTimeoutMs) {
        throw new Error(
          `The agent stopped responding for ${Math.round(inactivityTimeoutMs / 1000)} seconds. Check the Project Assistant Backend output for the last completed stage.`,
        );
      }
      throw error;
    } finally {
      if (inactivityTimer) clearTimeout(inactivityTimer);
    }
  }

  public async uploadJsonFile<TResp>(
    path: string,
    fileName: string,
    data: unknown,
    fields: Record<string, string | number | boolean> = {},
  ): Promise<TResp> {
    if (this.config.useMockBackend) {
      throw new Error("MOCK_MODE");
    }

    const url = `${this.baseUrl.replace(/\/$/, "")}${path}`;
    const form = new FormData();
    const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
    form.append("file", blob, fileName);
    for (const [key, value] of Object.entries(fields)) {
      form.append(key, String(value));
    }

    const res = await fetch(url, {
      method: "POST",
      headers: {
        ...(this.authToken
          ? { Authorization: `Bearer ${this.authToken}` }
          : {}),
      },
      body: form,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Backend ${res.status}: ${text || res.statusText}`);
    }
    return (await res.json()) as TResp;
  }

  public async uploadJsonFileEvents(
    path: string,
    fileName: string,
    data: unknown,
    fields: Record<string, string | number | boolean>,
    onEvent: (event: BackendSseEvent) => void,
  ): Promise<void> {
    if (this.config.useMockBackend) {
      throw new Error("MOCK_MODE");
    }

    const url = `${this.baseUrl.replace(/\/$/, "")}${path}`;
    const form = new FormData();
    const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
    form.append("file", blob, fileName);
    for (const [key, value] of Object.entries(fields)) {
      form.append(key, String(value));
    }

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "text/event-stream",
        ...(this.authToken
          ? { Authorization: `Bearer ${this.authToken}` }
          : {}),
      },
      body: form,
    });
    if (!res.ok) {
      const responseText = await res.text();
      throw new Error(
        `Backend ${res.status}: ${responseText || res.statusText}`,
      );
    }
    if (!res.body) {
      throw new Error("Backend upload stream did not include a body.");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(
        /\r\n/g,
        "\n",
      );
      buffer = this.drainSseBuffer(buffer, onEvent);
    }

    buffer = (buffer + decoder.decode()).replace(/\r\n/g, "\n");
    const finalFrame = buffer.trim();
    if (finalFrame) {
      const event = this.parseSseFrame(finalFrame);
      if (event) onEvent(event);
    }
  }

  private drainSseBuffer(
    buffer: string,
    onEvent: (event: BackendSseEvent) => void,
  ): string {
    let remaining = buffer;
    let boundary = remaining.indexOf("\n\n");
    while (boundary !== -1) {
      const rawFrame = remaining.slice(0, boundary);
      remaining = remaining.slice(boundary + 2);
      const event = this.parseSseFrame(rawFrame);
      if (event) onEvent(event);
      boundary = remaining.indexOf("\n\n");
    }
    return remaining;
  }

  private parseSseFrame(frame: string): BackendSseEvent | undefined {
    let event = "message";
    const dataLines: string[] = [];

    for (const rawLine of frame.split("\n")) {
      const line = rawLine.trimEnd();
      if (!line || line.startsWith(":")) continue;

      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);

      if (field === "event") {
        event = value;
      } else if (field === "data") {
        dataLines.push(value);
      }
    }

    const rawData = dataLines.join("\n");
    if (!rawData && event === "message") return undefined;

    try {
      const parsed = rawData ? JSON.parse(rawData) : {};
      return {
        event,
        data: this.toRecord(parsed),
      };
    } catch {
      return {
        event,
        data: { text: rawData },
      };
    }
  }

  private toRecord(value: unknown): Record<string, unknown> {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return { value };
  }
}
