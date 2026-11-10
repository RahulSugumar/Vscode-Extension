import { request } from "./host";
import { LogEntry } from "../types";

export async function fetchLogs(): Promise<LogEntry[]> {
  const res = await request<{
    command: "logs.data";
    requestId: string;
    logs: LogEntry[];
  }>({ command: "logs.list" });
  return res.logs;
}
