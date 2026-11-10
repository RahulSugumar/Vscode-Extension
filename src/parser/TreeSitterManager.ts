import * as path from "path";
import Parser from "web-tree-sitter";
import * as vscode from "vscode";

export class TreeSitterManager {
  private isInitialized = false;
  private parsers: Map<string, Parser> = new Map();

  constructor(private readonly extensionPath: string) {}

  public async initialize(): Promise<void> {
    if (this.isInitialized) return;
    try {
      await Parser.init({
        locateFile: (scriptName: string) =>
          scriptName === "tree-sitter.wasm"
            ? path.join(this.extensionPath, "dist", scriptName)
            : scriptName,
      });
      this.isInitialized = true;
    } catch (error: unknown) {
      throw error;
    }
  }

  public async getParser(filePath: string): Promise<Parser | undefined> {
    await this.initialize();
    const ext = path.extname(filePath).toLowerCase();

    if (this.parsers.has(ext)) return this.parsers.get(ext);

    let wasmFile = "";
    switch (ext) {
      case ".py":
        wasmFile = "tree-sitter-python.wasm";
        break;
      case ".js":
      case ".jsx":
        wasmFile = "tree-sitter-javascript.wasm";
        break;
      case ".ts":
        wasmFile = "tree-sitter-typescript.wasm";
        break;
      case ".tsx":
        wasmFile = "tree-sitter-tsx.wasm";
        break;
      case ".java":
        wasmFile = "tree-sitter-java.wasm";
        break;
      case ".cs":
        wasmFile = "tree-sitter-c_sharp.wasm";
        break;
      case ".c":
      case ".h":
        wasmFile = "tree-sitter-c.wasm";
        break;
      case ".cpp":
      case ".cc":
      case ".cxx":
      case ".hpp":
      case ".hh":
      case ".hxx":
        wasmFile = "tree-sitter-cpp.wasm";
        break;
      case ".rs":
        wasmFile = "tree-sitter-rust.wasm";
        break;
      case ".go":
        wasmFile = "tree-sitter-go.wasm";
        break;
      default:
        return undefined;
    }

    try {
      const wasmPath = path.join(this.extensionPath, "dist", wasmFile);
      const language = await Parser.Language.load(wasmPath);
      const parser = new Parser();
      parser.setLanguage(language);
      this.parsers.set(ext, parser);
      return parser;
    } catch {
      return undefined;
    }
  }
}
