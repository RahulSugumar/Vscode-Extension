import { beforeEach, describe, expect, it, vi } from "vitest";
import { logEntry, session } from "../test/fixtures";

const mocks = vi.hoisted(() => ({
  listSessions: vi.fn(),
  createSession: vi.fn(),
  renameSession: vi.fn(),
  deleteSession: vi.fn(),
  fetchLogs: vi.fn(),
  onPush: vi.fn(),
}));

vi.mock("../services/sessionService", () => ({
  listSessions: mocks.listSessions,
  createSession: mocks.createSession,
  renameSession: mocks.renameSession,
  deleteSession: mocks.deleteSession,
}));
vi.mock("../services/logService", () => ({ fetchLogs: mocks.fetchLogs }));
vi.mock("../services/host", () => ({ onPush: mocks.onPush }));

import { useLogStore, useSessionStore } from "./miscStores";

const initialSessionState = useSessionStore.getState();
const initialLogState = useLogStore.getState();

beforeEach(() => {
  Object.values(mocks).forEach((mock) => mock.mockReset());
  useSessionStore.setState({
    ...initialSessionState,
    sessions: [],
    status: "idle",
    error: null,
  });
  useLogStore.setState({
    ...initialLogState,
    logs: [],
    status: "idle",
    error: null,
  });
});

describe("session store", () => {
  it("loads, creates, renames, and removes sessions", async () => {
    const second = { ...session, id: "session-2", name: "Second" };
    const renamed = { ...session, name: "Renamed" };
    mocks.listSessions.mockResolvedValue([session]);
    mocks.createSession.mockResolvedValue(second);
    mocks.renameSession.mockResolvedValue(renamed);
    mocks.deleteSession.mockResolvedValue(undefined);

    await useSessionStore.getState().load();
    await useSessionStore.getState().create("Second");
    expect(useSessionStore.getState().sessions).toEqual([second, session]);
    await useSessionStore.getState().rename(session.id, "Renamed");
    expect(useSessionStore.getState().sessions[1]).toEqual(renamed);
    await useSessionStore.getState().remove(second.id);
    expect(useSessionStore.getState().sessions).toEqual([renamed]);
  });

  it.each([
    ["load", "listSessions", "Failed to load sessions"],
    ["create", "createSession", "Failed to create session"],
    ["rename", "renameSession", "Failed to rename session"],
    ["remove", "deleteSession", "Failed to delete session"],
  ] as const)("uses the fallback for non-Error %s failures", async (action, service, message) => {
    mocks[service].mockRejectedValue("bad");
    if (action === "load") await useSessionStore.getState().load();
    if (action === "create") await useSessionStore.getState().create("New");
    if (action === "rename") await useSessionStore.getState().rename("id", "New");
    if (action === "remove") await useSessionStore.getState().remove("id");
    expect(useSessionStore.getState().error).toBe(message);
  });

  it("keeps Error messages from session operations", async () => {
    mocks.createSession.mockRejectedValue(new Error("duplicate"));
    await useSessionStore.getState().create("New");
    expect(useSessionStore.getState().error).toBe("duplicate");
  });
});

describe("log store", () => {
  it("loads and prepends logs", async () => {
    mocks.fetchLogs.mockResolvedValue([logEntry]);
    await useLogStore.getState().load();
    const next = { ...logEntry, id: "log-2" };
    useLogStore.getState().addLog(next);
    expect(useLogStore.getState()).toMatchObject({
      logs: [next, logEntry],
      status: "idle",
      error: null,
    });
  });

  it.each([
    [new Error("logs broke"), "logs broke"],
    ["bad", "Failed to load logs"],
  ])("records log loading failures", async (failure, error) => {
    mocks.fetchLogs.mockRejectedValue(failure);
    await useLogStore.getState().load();
    expect(useLogStore.getState()).toMatchObject({ status: "error", error });
  });

  it("subscribes to pushed logs and returns the host unsubscribe", () => {
    let listener: ((message: { log: typeof logEntry }) => void) | undefined;
    const unsubscribe = vi.fn();
    mocks.onPush.mockImplementation((_command, callback) => {
      listener = callback;
      return unsubscribe;
    });

    expect(useLogStore.getState().subscribeToPush()).toBe(unsubscribe);
    listener?.({ log: logEntry });
    expect(useLogStore.getState().logs).toEqual([logEntry]);
  });
});
