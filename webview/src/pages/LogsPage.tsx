import React, { useEffect, useState } from "react";
import { useLogStore } from "../state/miscStores";
import AsyncBoundary from "../components/AsyncBoundary";
import "./LogsPage.css";

export default function LogsPage() {
  const { logs, status, error, load, subscribeToPush } = useLogStore();
  const [filter, setFilter] = useState<string>("All");

  useEffect(() => {
    load();
    const unsub = subscribeToPush();
    return unsub;
  }, [load, subscribeToPush]);

  const filteredLogs =
    filter === "All" ? logs : logs.filter((l) => l.type === filter);

  return (
    <div className="logs-page">
      <div className="logs-header">
        <h2>Telemetry & Execution Logs</h2>
        <div className="filters">
          {["All", "Info", "Success", "Warning", "Error"].map((f) => (
            <button
              key={f}
              className={`filter-btn ${filter === f ? "active" : ""}`}
              onClick={() => setFilter(f)}
            >
              {f}
            </button>
          ))}
        </div>
      </div>
      <AsyncBoundary
        status={status}
        error={error}
        isEmpty={filteredLogs.length === 0}
        emptyMessage="No logs available."
        onRetry={load}
      >
        <div className="logs-table-container card">
          <table className="logs-table">
            <thead>
              <tr>
                <th>Timestamp</th>
                <th>Type</th>
                <th>Agent</th>
                <th>Message</th>
              </tr>
            </thead>
            <tbody>
              {filteredLogs.map((log) => (
                <tr
                  key={log.id}
                  className={`log-row ${log.type.toLowerCase()}`}
                >
                  <td className="timestamp-col">
                    {new Date(log.timestamp).toLocaleTimeString()}
                  </td>
                  <td>
                    <span className={`status-pill ${log.type.toLowerCase()}`}>
                      {log.type}
                    </span>
                  </td>
                  <td>{log.agent}</td>
                  <td>{log.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </AsyncBoundary>
    </div>
  );
}
