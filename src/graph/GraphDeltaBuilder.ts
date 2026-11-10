import { Graph, GraphNodeModel, GraphEdgeModel } from "../models/Graph";
import { LedgerEntry } from "../models/GraphLedger";
import { GraphDelta, FileChangeOp } from "../models/GraphDelta";
import { SingleFileBuildResult } from "./GraphBuilder";

/**
 * Computes GraphDelta objects — the minimal set of graph mutations needed to
 * bring the graph from its current state (as recorded in the ledger) to a
 * new state (as produced by a single-file rebuild or a delete event).
 *
 * All methods are pure and side-effect-free. This class holds no state so
 * it can be safely constructed once and reused for many deltas.
 */
export class GraphDeltaBuilder {
  /**
   * Delta for a file that was added or modified. Compares the fresh build
   * result against the previous ledger entry (may be undefined for new files).
   *
   * Rules:
   *  - Any node ID present in the fresh build but not in the previous entry → add
   *  - Any node ID present in the previous entry but not in the fresh build → remove
   *  - Any node ID present in both → keep (no change; Neo4j MERGE will refresh props)
   *  - Same logic applies to edges, using a stable edge fingerprint
   *  - We also emit an "add" for every fresh edge that survived, because our
   *    Neo4j patch uses MERGE and needs to see the current edge set
   *
   * Rationale for re-emitting stable edges: Neo4j MERGE is idempotent, so
   * re-adding an existing edge is a no-op. This is much simpler than trying
   * to compute a precise edge diff, and eliminates a whole class of bugs
   * where edge properties (line numbers, refText) get out of sync.
   */
  public buildForModified(
    filePath: string,
    op: "added" | "modified",
    freshBuild: SingleFileBuildResult,
    previousEntry: LedgerEntry | undefined,
    oldHash: string | undefined,
    newHash: string,
  ): GraphDelta {
    const previousNodeIds = new Set(previousEntry?.nodeIds ?? []);
    const previousEdgeIds = new Set(previousEntry?.edgeIds ?? []);

    const freshNodeIds = new Set(freshBuild.nodes.map((n) => n.id));
    const freshEdgeIds = new Set(freshBuild.edges.map((e) => e.id));

    // Nodes to remove: were in previous entry, no longer present.
    const nodesToRemove: string[] = [];
    for (const id of previousNodeIds) {
      if (!freshNodeIds.has(id)) nodesToRemove.push(id);
    }

    // Edges to remove: were in previous entry, no longer present.
    const edgesToRemove: string[] = [];
    for (const id of previousEdgeIds) {
      if (!freshEdgeIds.has(id)) edgesToRemove.push(id);
    }

    return {
      filePath,
      op,
      oldHash,
      newHash,
      nodesToAdd: freshBuild.nodes, // MERGE-based → safe to re-emit all
      nodesToRemove,
      edgesToAdd: freshBuild.edges, // MERGE-based → safe to re-emit all
      edgesToRemove,
    };
  }

  /**
   * Delta for a deleted file. Removes the file node itself, all nodes it
   * contributed, and all edges originating from it. Edges TO these nodes
   * from other files are cleaned up by the Neo4j DETACH DELETE clause on
   * the backend (Cypher: `DETACH DELETE n` removes incident relationships).
   */
  public buildForDeleted(
    filePath: string,
    previousEntry: LedgerEntry,
    oldHash: string,
  ): GraphDelta {
    return {
      filePath,
      op: "deleted",
      oldHash,
      newHash: undefined,
      nodesToAdd: [],
      nodesToRemove: [...previousEntry.nodeIds, filePath],
      edgesToAdd: [],
      edgesToRemove: [...previousEntry.edgeIds],
    };
  }

  /**
   * Delta for a file renamed/moved within the workspace. Two-phase:
   *  1. Remove everything under the old path
   *  2. Add everything under the new path (from the fresh build)
   *
   * Node/edge IDs are path-derived (see CodeAnalyzer), so a rename always
   * produces a full remove+add. This is correct and keeps Neo4j clean.
   */
  public buildForRenamed(
    oldFilePath: string,
    newFilePath: string,
    freshBuild: SingleFileBuildResult,
    previousEntry: LedgerEntry,
    oldHash: string,
    newHash: string,
  ): GraphDelta {
    return {
      filePath: newFilePath,
      op: "renamed",
      previousFilePath: oldFilePath,
      oldHash,
      newHash,
      nodesToAdd: freshBuild.nodes,
      nodesToRemove: [...previousEntry.nodeIds, oldFilePath],
      edgesToAdd: freshBuild.edges,
      edgesToRemove: [...previousEntry.edgeIds],
    };
  }

  /**
   * True if a delta is a no-op (nothing to add, nothing to remove).
   * Used by the updater to skip trivial changes (e.g. whitespace-only edits
   * where the content hash changed but the parse tree didn't).
   */
  public isNoOp(delta: GraphDelta): boolean {
    return (
      delta.nodesToAdd.length === 0 &&
      delta.nodesToRemove.length === 0 &&
      delta.edgesToAdd.length === 0 &&
      delta.edgesToRemove.length === 0
    );
  }

  /**
   * Apply a delta to an in-memory Graph. Mutates `graph` in place.
   *
   * Order matters:
   *  1. Remove edges first (so we don't have dangling references)
   *  2. Remove nodes
   *  3. Add new nodes
   *  4. Add new edges (dedupe against existing edges to be safe)
   */
  public applyToGraph(graph: Graph, delta: GraphDelta): void {
    // 1. Remove edges by ID
    if (delta.edgesToRemove.length > 0) {
      const removeSet = new Set(delta.edgesToRemove);
      graph.edges = graph.edges.filter((e) => !removeSet.has(e.id));
    }

    // 2. Remove nodes by ID, AND cascade-remove any edges touching them
    if (delta.nodesToRemove.length > 0) {
      const removeSet = new Set(delta.nodesToRemove);
      graph.nodes = graph.nodes.filter((n) => !removeSet.has(n.id));
      graph.edges = graph.edges.filter(
        (e) => !removeSet.has(e.source) && !removeSet.has(e.target),
      );
    }

    // 3. Add new nodes (dedupe by ID — later wins for property updates)
    if (delta.nodesToAdd.length > 0) {
      const existing = new Map(graph.nodes.map((n) => [n.id, n]));
      for (const node of delta.nodesToAdd) {
        existing.set(node.id, node);
      }
      graph.nodes = Array.from(existing.values());
    }

    // 4. Add new edges (dedupe by ID)
    if (delta.edgesToAdd.length > 0) {
      const existing = new Map<string, GraphEdgeModel>(
        graph.edges.map((e) => [e.id, e]),
      );
      for (const edge of delta.edgesToAdd) {
        existing.set(edge.id, edge);
      }
      graph.edges = Array.from(existing.values());
    }
  }

  /**
   * Convenience: apply many deltas in order. Used when a debounce window
   * batched multiple file changes together.
   */
  public applyBatch(graph: Graph, deltas: GraphDelta[]): void {
    for (const delta of deltas) {
      this.applyToGraph(graph, delta);
    }
  }
}
