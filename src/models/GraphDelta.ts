import type { GraphNodeModel, GraphEdgeModel } from "./Graph";

/** Reason a file entered the delta pipeline. */
export type FileChangeOp = "added" | "modified" | "deleted" | "renamed";

/** Alias kept for older call sites that used the previous name. */
export type FileChangeKind = FileChangeOp;

/**
 * A single file-level graph mutation. This shape intentionally matches the
 * backend patch schema, so the extension can POST DeltaBatch directly to
 * /graphrag/api/patch without translation.
 */
export interface GraphDelta {
  filePath: string;
  op: FileChangeOp;
  previousFilePath?: string;
  oldHash?: string;
  newHash?: string;
  nodesToAdd: GraphNodeModel[];
  nodesToRemove: string[];
  edgesToAdd: GraphEdgeModel[];
  edgesToRemove: string[];
}

/** Alias kept for code that still refers to file deltas. */
export type FileDelta = GraphDelta;

export interface DeltaBatchTotals {
  filesProcessed: number;
  nodesAdded: number;
  nodesRemoved: number;
  edgesAdded: number;
  edgesRemoved: number;
}

/** Wire format for POST /graphrag/api/patch. */
export interface DeltaBatch {
  schemaVersion: number;
  batchId: string;
  createdAt: number;
  workspaceRoot: string;
  database?: string;
  deltas: GraphDelta[];
  totals: DeltaBatchTotals;
}

export const DELTA_SCHEMA_VERSION = 1;

export function createEmptyDeltaBatch(workspaceRoot = ""): DeltaBatch {
  return {
    schemaVersion: DELTA_SCHEMA_VERSION,
    batchId: `batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: Date.now(),
    workspaceRoot,
    deltas: [],
    totals: {
      filesProcessed: 0,
      nodesAdded: 0,
      nodesRemoved: 0,
      edgesAdded: 0,
      edgesRemoved: 0,
    },
  };
}

export const createEmptyBatch = createEmptyDeltaBatch;

export function appendToBatch(batch: DeltaBatch, delta: GraphDelta): void {
  const anyChange =
    delta.nodesToAdd.length > 0 ||
    delta.nodesToRemove.length > 0 ||
    delta.edgesToAdd.length > 0 ||
    delta.edgesToRemove.length > 0 ||
    delta.op === "deleted" ||
    delta.op === "renamed";
  if (!anyChange) return;

  batch.deltas.push(delta);
  recomputeTotals(batch);
}

export function recomputeTotals(batch: DeltaBatch): void {
  const totals = batch.totals;
  totals.filesProcessed = batch.deltas.length;
  totals.nodesAdded = 0;
  totals.nodesRemoved = 0;
  totals.edgesAdded = 0;
  totals.edgesRemoved = 0;

  for (const delta of batch.deltas) {
    totals.nodesAdded += delta.nodesToAdd.length;
    totals.nodesRemoved += delta.nodesToRemove.length;
    totals.edgesAdded += delta.edgesToAdd.length;
    totals.edgesRemoved += delta.edgesToRemove.length;
  }
}

export function isBatchEmpty(batch: DeltaBatch): boolean {
  const totals = batch.totals;
  return (
    totals.nodesAdded === 0 &&
    totals.nodesRemoved === 0 &&
    totals.edgesAdded === 0 &&
    totals.edgesRemoved === 0
  );
}
