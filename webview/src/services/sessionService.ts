import { request } from "./host";
import { Session } from "../types";

export async function listSessions(): Promise<Session[]> {
  const res = await request<{
    command: "sessions.data";
    requestId: string;
    sessions: Session[];
  }>({ command: "sessions.list" });
  return res.sessions;
}

export async function createSession(name: string): Promise<Session> {
  const res = await request<{
    command: "sessions.created";
    requestId: string;
    session: Session;
  }>({ command: "sessions.create", name });
  return res.session;
}

export async function renameSession(
  id: string,
  name: string,
): Promise<Session> {
  const res = await request<{
    command: "sessions.renamed";
    requestId: string;
    session: Session;
  }>({ command: "sessions.rename", id, name });
  return res.session;
}

export async function deleteSession(id: string): Promise<void> {
  await request<{ command: "sessions.deleted"; requestId: string; id: string }>(
    { command: "sessions.delete", id },
  );
}
