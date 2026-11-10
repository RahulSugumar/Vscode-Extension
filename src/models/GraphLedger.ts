import type { SourceRange } from "./Graph";

export type LedgerSymbolKind =
  | "Class"
  | "Function"
  | "Method"
  | "Interface"
  | "Enum"
  | "Type"
  | "Variable"
  | "Default"
  | "class"
  | "function"
  | "method"
  | "interface"
  | "enum"
  | "type"
  | "variable"
  | "default"
  | "other";

/**
 * A symbol declared by a file. Exported symbols drive dependent-file
 * invalidation during incremental graph updates.
 */
export interface LedgerEntrySymbol {
  name: string;
  nodeId: string;
  symbolId?: string;
  definitionOccurrenceId?: string;
  kind: LedgerSymbolKind;
  isExported: boolean;
  signatureHash: string;
  lineNumber?: number;
  sourceRange?: SourceRange;
}

/** One entry per source file that participated in the graph. */
export interface LedgerEntry {
  filePath: string;
  contentHash: string;
  lastModified: number;
  nodeIds: string[];
  edgeIds: string[];
  exportedSymbols: LedgerEntrySymbol[];
  importedFiles: string[];
  dependents: string[];
}

export interface GraphLedger {
  version: number;
  updatedAt: number;
  entries: Record<string, LedgerEntry>;
}

export const LEDGER_SCHEMA_VERSION = 2;

export function createEmptyLedger(): GraphLedger {
  return {
    version: LEDGER_SCHEMA_VERSION,
    updatedAt: Date.now(),
    entries: {},
  };
}

export function isGraphLedger(value: unknown): value is GraphLedger {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<GraphLedger>;
  if (typeof v.version !== "number") return false;
  if (typeof v.updatedAt !== "number") return false;
  if (!v.entries || typeof v.entries !== "object") return false;
  return true;
}