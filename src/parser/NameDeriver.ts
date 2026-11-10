import { SyntaxNode } from "web-tree-sitter";

export interface DerivedName {
  name: string;
  isAnonymous: boolean;
  /** How the name was inferred — useful for debugging and graph properties. */
  origin:
    | "declared"
    | "variable-assignment"
    | "object-property"
    | "this-assignment"
    | "export-default"
    | "callback-argument"
    | "returned"
    | "decorator-context"
    | "jsx-handler"
    | "iife"
    | "fallback-line";
}

/**
 * Derives a meaningful name for any function/class/method node.
 * Covers: declarations, arrow functions, function expressions, IIFEs,
 * callbacks, methods, anonymous classes, default exports.
 */
export class NameDeriver {
  public derive(astNode: SyntaxNode): DerivedName {
    // ---------- 1. Direct name via Tree-sitter's `name` field ----------
    const named = astNode.childForFieldName("name");
    if (named && named.text) {
      return { name: named.text, isAnonymous: false, origin: "declared" };
    }

    // ---------- 2. First identifier child (some grammars) ----------
    const ident = astNode.children.find((c) => c.type === "identifier");
    if (ident && ident.text && !this.isKeyword(ident.text)) {
      return { name: ident.text, isAnonymous: false, origin: "declared" };
    }

    // ---------- 3. Walk up the parent chain for context ----------
    const parent = astNode.parent;
    if (!parent) return this.fallback(astNode);

    // const foo = () => {}    OR    let foo = function() {}
    if (parent.type === "variable_declarator") {
      const varName = parent.childForFieldName("name");
      if (varName?.text) {
        return {
          name: varName.text,
          isAnonymous: false,
          origin: "variable-assignment",
        };
      }
    }

    // { handleClick: () => {} }   OR   { handleClick() {} }
    if (parent.type === "pair" || parent.type === "property_assignment") {
      const key = parent.childForFieldName("key");
      if (key?.text) {
        return {
          name: this.stripQuotes(key.text),
          isAnonymous: false,
          origin: "object-property",
        };
      }
    }

    // this.foo = () => {}    OR    obj.foo = function() {}
    if (parent.type === "assignment_expression") {
      const left = parent.childForFieldName("left");
      if (left) {
        const prop = left.childForFieldName("property");
        const name = (prop ?? left).text;
        if (name) {
          return {
            name: name.replace(/^this\./, ""),
            isAnonymous: false,
            origin: "this-assignment",
          };
        }
      }
    }

    // export default function() {}    OR    export default () => {}
    if (
      parent.type === "export_statement" ||
      parent.type === "export_default_declaration"
    ) {
      const filePath = this.getRootFilePath(astNode);
      const fileBase = filePath ? this.basename(filePath) : "module";
      return {
        name: `default<${fileBase}>`,
        isAnonymous: false,
        origin: "export-default",
      };
    }

    // Callback inside a call: subscribe(users => ...) → "subscribe$cb0"
    if (parent.type === "arguments") {
      const callExpr = parent.parent;
      if (callExpr && callExpr.type === "call_expression") {
        const fn = callExpr.childForFieldName("function");
        const methodName = this.extractCallableName(fn);
        if (methodName) {
          const argIndex = this.indexOfArgument(parent, astNode);
          return {
            name: `${methodName}$cb${argIndex}`,
            isAnonymous: false,
            origin: "callback-argument",
          };
        }
      }
    }

    // function foo() { return () => {} } → "foo$returned"
    if (parent.type === "return_statement") {
      const enclosing = this.findEnclosingNamedScope(parent);
      if (enclosing) {
        return {
          name: `${enclosing}$returned`,
          isAnonymous: false,
          origin: "returned",
        };
      }
    }

    // JSX event handler: onClick={() => {}} → "onClick$handler"
    if (parent.type === "jsx_expression" || parent.type === "jsx_attribute") {
      const attr =
        parent.type === "jsx_attribute"
          ? parent
          : parent.parent?.type === "jsx_attribute"
            ? parent.parent
            : null;
      if (attr) {
        const attrName =
          attr.childForFieldName("name")?.text ??
          attr.children.find((c) => c.type === "property_identifier")?.text;
        if (attrName) {
          return {
            name: `${attrName}$handler`,
            isAnonymous: false,
            origin: "jsx-handler",
          };
        }
      }
    }

    // Decorator argument: @Component({ ... }) → look for selector/name
    if (this.isInsideDecorator(astNode)) {
      const decoratorName = this.findEnclosingDecorator(astNode);
      if (decoratorName) {
        return {
          name: `${decoratorName}$config`,
          isAnonymous: false,
          origin: "decorator-context",
        };
      }
    }

    // IIFE: (function() {})() or (() => {})()
    if (
      parent.type === "parenthesized_expression" &&
      parent.parent?.type === "call_expression"
    ) {
      return {
        name: `iife@L${astNode.startPosition.row + 1}`,
        isAnonymous: false,
        origin: "iife",
      };
    }

    return this.fallback(astNode);
  }

  // ---------- helpers ----------
  private fallback(astNode: SyntaxNode): DerivedName {
    return {
      name: `<anonymous@L${astNode.startPosition.row + 1}>`,
      isAnonymous: true,
      origin: "fallback-line",
    };
  }

  private extractCallableName(fn: SyntaxNode | null): string | null {
    if (!fn) return null;
    if (fn.type === "member_expression") {
      return fn.childForFieldName("property")?.text ?? null;
    }
    if (fn.type === "identifier") return fn.text;
    return fn.text?.split(".").pop() ?? null;
  }

  private indexOfArgument(argsNode: SyntaxNode, target: SyntaxNode): number {
    const realArgs = argsNode.children.filter(
      (c) => c.type !== "," && c.type !== "(" && c.type !== ")",
    );
    const idx = realArgs.indexOf(target);
    return idx >= 0 ? idx : 0;
  }

  private findEnclosingNamedScope(start: SyntaxNode): string | null {
    let cur: SyntaxNode | null = start.parent;
    while (cur) {
      const name = cur.childForFieldName?.("name");
      if (name?.text) return name.text;
      cur = cur.parent;
    }
    return null;
  }

  private isInsideDecorator(node: SyntaxNode): boolean {
    let cur: SyntaxNode | null = node.parent;
    while (cur) {
      if (cur.type === "decorator") return true;
      cur = cur.parent;
    }
    return false;
  }

  private findEnclosingDecorator(node: SyntaxNode): string | null {
    let cur: SyntaxNode | null = node.parent;
    while (cur) {
      if (cur.type === "decorator") {
        const call = cur.children.find((c) => c.type === "call_expression");
        const fn = call?.childForFieldName("function");
        return fn?.text ?? null;
      }
      cur = cur.parent;
    }
    return null;
  }

  private getRootFilePath(node: SyntaxNode): string | null {
    let cur: SyntaxNode = node;
    while (cur.parent) cur = cur.parent;
    return null; // file path is injected separately by the analyzer
  }

  private basename(p: string): string {
    return (
      p
        .replace(/\\/g, "/")
        .split("/")
        .pop()
        ?.replace(/\.[^.]+$/, "") ?? p
    );
  }

  private stripQuotes(s: string): string {
    return s.replace(/^['"`]|['"`]$/g, "");
  }

  private isKeyword(s: string): boolean {
    return ["function", "class", "async", "await", "static"].includes(s);
  }
}
