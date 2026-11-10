import { SyntaxNode } from "web-tree-sitter";
import { SourceRange } from "../models/Graph";

export function sourceRangeFromSyntaxNode(node: SyntaxNode): SourceRange {
  return {
    startLine: node.startPosition.row + 1,
    startColumn: node.startPosition.column,
    endLine: node.endPosition.row + 1,
    endColumn: node.endPosition.column,
    startByte: node.startIndex,
    endByte: node.endIndex,
  };
}

export function sourceRangeFromZeroBasedRange(range: {
  start: { line: number; character: number };
  end: { line: number; character: number };
}): SourceRange {
  return {
    startLine: range.start.line + 1,
    startColumn: range.start.character,
    endLine: range.end.line + 1,
    endColumn: range.end.character,
  };
}

export function containsZeroBasedPosition(
  range: SourceRange | undefined,
  line: number,
  character: number,
): boolean {
  if (!range) return false;
  const targetLine = line + 1;
  if (targetLine < range.startLine || targetLine > range.endLine) return false;
  if (targetLine === range.startLine && character < range.startColumn) return false;
  if (targetLine === range.endLine && character > range.endColumn) return false;
  return true;
}

export function rangeSize(range: SourceRange | undefined): number {
  if (!range) return Number.MAX_SAFE_INTEGER;
  const lineSpan = Math.max(0, range.endLine - range.startLine);
  const columnSpan = Math.max(0, range.endColumn - range.startColumn);
  return lineSpan * 100000 + columnSpan;
}