import { create } from "zustand";
import { Session, LogEntry } from "../types";
import {
  listSessions,
  createSession,
  renameSession,
  deleteSession,
} from "../services/sessionService";
import { fetchLogs } from "../services/logService";
import { onPush } from "../services/host";

type Status = "idle" | "loading" | "error";

interface SessionState {
  sessions: Session[];
  status: Status;
  error: string | null;
  load: () => Promise<void>;
  create: (name: string) => Promise<void>;
  rename: (id: string, name: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

export const useSessionStore = create<SessionState>((set) => ({
  sessions: [],
  status: "idle",
  error: null,

  load: async () => {
    set({ status: "loading", error: null });
    try {
      const sessions = await listSessions();
      set({ sessions, status: "idle" });
    } catch (e) {
      set({
        status: "error",
        error: e instanceof Error ? e.message : "Failed to load sessions",
      });
    }
  },

  create: async (name: string) => {
    try {
      const session = await createSession(name);
      set((state) => ({ sessions: [session, ...state.sessions] }));
    } catch (e) {
      set({
        error: e instanceof Error ? e.message : "Failed to create session",
      });
    }
  },

  rename: async (id: string, name: string) => {
    try {
      const updated = await renameSession(id, name);
      set((state) => ({
        sessions: state.sessions.map((s) => (s.id === id ? updated : s)),
      }));
    } catch (e) {
      set({
        error: e instanceof Error ? e.message : "Failed to rename session",
      });
    }
  },

  remove: async (id: string) => {
    try {
      await deleteSession(id);
      set((state) => ({ sessions: state.sessions.filter((s) => s.id !== id) }));
    } catch (e) {
      set({
        error: e instanceof Error ? e.message : "Failed to delete session",
      });
    }
  },
}));

interface LogState {
  logs: LogEntry[];
  status: Status;
  error: string | null;
  load: () => Promise<void>;
  addLog: (l: LogEntry) => void;
  subscribeToPush: () => () => void;
}

export const useLogStore = create<LogState>((set, get) => ({
  logs: [],
  status: "idle",
  error: null,

  load: async () => {
    set({ status: "loading", error: null });
    try {
      const logs = await fetchLogs();
      set({ logs, status: "idle" });
    } catch (e) {
      set({
        status: "error",
        error: e instanceof Error ? e.message : "Failed to load logs",
      });
    }
  },

  addLog: (l) => set((state) => ({ logs: [l, ...state.logs] })),

  subscribeToPush: () => {
    return onPush<{ command: "logs.append"; log: LogEntry }>(
      "logs.append",
      (msg) => {
        get().addLog(msg.log);
      },
    );
  },
}));
