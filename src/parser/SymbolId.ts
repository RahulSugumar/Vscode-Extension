import { createHash } from "crypto";

export interface SymbolIdInput {
  filePath: string;
  kind: string;
  name: string;
  scopePath: readonly string[];
  isAnonymous?: boolean;
  fallbackKey?: string;
}

export function createSymbolId(input: SymbolIdInput): string {
  const scope = input.scopePath.filter(Boolean).join(".");
  const identity = input.isAnonymous
    ? `${input.filePath}|${input.kind}|anonymous|${input.fallbackKey ?? input.name}`
    : `${input.filePath}|${input.kind}|${scope}|${input.name}`;
  return `symbol:${hash(identity, 20)}`;
}

export function createDefinitionOccurrenceId(
  symbolId: string,
  startByte: number | undefined,
  endByte: number | undefined,
): string {
  return `occ:def:${hash(`${symbolId}|${startByte ?? ""}|${endByte ?? ""}`, 20)}`;
}

export function createReferenceOccurrenceId(input: {
  filePath: string;
  kind: string;
  refText: string;
  startByte?: number;
  endByte?: number;
  line: number;
  character: number;
}): string {
  return `occ:ref:${hash(
    `${input.filePath}|${input.kind}|${input.refText}|${input.startByte ?? ""}|${input.endByte ?? ""}|${input.line}|${input.character}`,
    20,
  )}`;
}

export function createExternalSymbolId(input: {
  targetUri: string;
  refText: string;
  line: number;
  character: number;
}): string {
  return `external:${hash(`${input.targetUri}|${input.refText}|${input.line}|${input.character}`, 20)}`;
}

export function qualifiedName(scopePath: readonly string[], name: string): string {
  return [...scopePath.filter(Boolean), name].join(".") || name;
}

function hash(value: string, length: number): string {
  return createHash("sha1").update(value).digest("hex").slice(0, length);
}