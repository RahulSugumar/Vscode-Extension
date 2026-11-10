import * as path from "path";
import { RichExtractionContext } from "./common";
import { extractNativeRichNodes, supportsNativeRichNodes } from "./native";
import { extractPythonRichNodes } from "./python";
import { extractTypeScriptRichNodes } from "./typescript";

export function extractRichCodeNodes(ctx: RichExtractionContext): void {
  const ext = path.extname(ctx.uri.fsPath).toLowerCase();
  if ([".ts", ".tsx", ".js", ".jsx"].includes(ext)) {
    extractTypeScriptRichNodes(ctx);
    return;
  }
  if (ext === ".py") {
    extractPythonRichNodes(ctx);
    return;
  }
  if (supportsNativeRichNodes(ctx.uri.fsPath)) {
    extractNativeRichNodes(ctx);
  }
}