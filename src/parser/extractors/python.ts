import { SyntaxNode } from "web-tree-sitter";
import {
  addContainment,
  addFrameworkRoleNode,
  addFrameworkRoute,
  addRichEdge,
  addRichNode,
  addTypedAnnotation,
  compactLabel,
  firstDescendantOfType,
  firstStringLiteralValue,
  frameworkRoleFromNameOrPath,
  firstNamedChildOfType,
  isUppercaseName,
  RichExtractionContext,
  unquote,
} from "./common";

const NAME_TYPES = ["identifier", "dotted_name", "attribute"] as const;

export function extractPythonRichNodes(ctx: RichExtractionContext): void {
  const node = ctx.astNode;

  switch (node.type) {
    case "function_definition":
      extractFunctionDetails(ctx, node);
      break;
    case "class_definition":
      extractClassFrameworkDetails(ctx, node);
      break;
    case "import_statement":
    case "import_from_statement":
      extractImport(ctx, node);
      break;
    case "assignment":
    case "augmented_assignment":
      extractAssignment(ctx, node);
      break;
  }
}

function extractFunctionDetails(
  ctx: RichExtractionContext,
  node: SyntaxNode,
): void {
  const ownerId = ctx.currentScopeId;
  extractParameters(ctx, ownerId, node);
  addTypedAnnotation(ctx, ownerId, returnAnnotation(node), "RETURNS", "return");
  extractDecorators(ctx, ownerId, node);
  extractDocString(ctx, ownerId, node);
  extractFastApiRoutes(ctx, ownerId, node);
  extractGenericFrameworkRole(ctx, ownerId, node);
}


function extractClassFrameworkDetails(
  ctx: RichExtractionContext,
  node: SyntaxNode,
): void {
  const ownerId = ctx.currentScopeId;
  extractGenericFrameworkRole(ctx, ownerId, node);

  const owner = ctx.nodes.find((candidate) => candidate.id === ownerId);
  const label = owner?.label ?? className(node) ?? "model";
  if (/\b(BaseModel|SQLModel)\b/.test(node.text)) {
    addFrameworkRoleNode(ctx, {
      type: "ORMModel",
      label,
      ownerId,
      astNode: node,
      rangeNode: node.childForFieldName("name") ?? node,
      framework: node.text.includes("SQLModel") ? "SQLModel" : "Pydantic",
      role: "ORMModel",
      properties: { detectedBy: "base-class" },
    });
  }
}

function extractFastApiRoutes(
  ctx: RichExtractionContext,
  ownerId: string,
  node: SyntaxNode,
): void {
  const decorators = decoratorNodes(node);
  decorators.forEach((decorator) => {
    const route = parseFastApiRouteDecorator(decorator.text);
    if (!route) return;
    const owner = ctx.nodes.find((candidate) => candidate.id === ownerId);
    addFrameworkRoute(ctx, {
      framework: "FastAPI",
      httpMethod: route.method,
      path: route.path,
      routerName: route.routerName,
      handlerId: ownerId,
      handlerLabel: owner?.label,
      astNode: decorator,
      properties: { detectedBy: "decorator" },
    });
  });
}

function extractGenericFrameworkRole(
  ctx: RichExtractionContext,
  ownerId: string,
  node: SyntaxNode,
): void {
  const owner = ctx.nodes.find((candidate) => candidate.id === ownerId);
  const label = owner?.label ?? className(node) ?? functionName(node) ?? "handler";
  const role = frameworkRoleFromNameOrPath(label, ctx.uri.fsPath);
  if (!role) return;
  addFrameworkRoleNode(ctx, {
    type: role,
    label,
    ownerId,
    astNode: node,
    rangeNode: node.childForFieldName("name") ?? node,
    framework: "Generic",
    role,
    confidence: "convention",
    properties: { detectedBy: "name-or-path" },
  });
}

function decoratorNodes(node: SyntaxNode): SyntaxNode[] {
  const parent = node.parent;
  return parent?.type === "decorated_definition"
    ? parent.children.filter((child) => child.type === "decorator")
    : [];
}

function parseFastApiRouteDecorator(
  text: string,
): { routerName: string; method: string; path: string } | undefined {
  const match = text.match(/^@\s*([A-Za-z_][\w.]*)\.(get|post|put|patch|delete|options|head|trace|websocket|api_route|route)\s*\(/i);
  if (!match) return undefined;
  const path = firstStringLiteralValue(text);
  if (!path) return undefined;
  const rawMethod = match[2].toLowerCase();
  const methodsMatch = text.match(/methods\s*=\s*\[([^\]]+)\]/i);
  const methodFromList = methodsMatch ? firstStringLiteralValue(methodsMatch[1]) : undefined;
  const method = rawMethod === "api_route" || rawMethod === "route"
    ? methodFromList ?? "ANY"
    : rawMethod;
  return {
    routerName: match[1],
    method,
    path,
  };
}

function className(node: SyntaxNode): string | undefined {
  return node.childForFieldName("name")?.text;
}

function functionName(node: SyntaxNode): string | undefined {
  return node.childForFieldName("name")?.text;
}

function extractParameters(
  ctx: RichExtractionContext,
  ownerId: string,
  node: SyntaxNode,
): void {
  const params =
    node.childForFieldName("parameters") ??
    node.namedChildren.find((child) => child.type === "parameters");
  if (!params) return;

  const items = params.namedChildren.filter(
    (child) =>
      ![
        "comment",
        "keyword_separator",
        "positional_separator",
        "dictionary_splat_pattern",
      ].includes(child.type),
  );

  items.forEach((param, index) => {
    const nameNode = parameterNameNode(param);
    const label = nameNode ? nameNode.text : compactLabel(param.text, 60);
    if (!label || label === ",") return;

    const parameter = addRichNode(ctx, {
      type: "Parameter",
      label,
      astNode: param,
      rangeNode: nameNode ?? param,
      ownerId,
      properties: {
        index,
        optional: param.type === "default_parameter" || /=/.test(param.text),
        variadic:
          param.type.includes("splat") ||
          param.text.trim().startsWith("*") ||
          param.text.trim().startsWith("**"),
      },
    });

    addRichEdge(ctx, {
      source: ownerId,
      target: parameter.id,
      relationshipType: "HAS_PARAM",
      astNode: param,
      properties: { index },
    });

    addTypedAnnotation(ctx, parameter.id, parameterAnnotation(param), "TYPE_OF", "parameter");
  });
}

function extractImport(ctx: RichExtractionContext, node: SyntaxNode): void {
  const moduleNode = importModuleNode(node);
  const moduleName = moduleNode ? unquote(moduleNode.text) : compactLabel(node.text, 100);
  if (!moduleName) return;

  const importNode = addRichNode(ctx, {
    type: "Import",
    label: moduleName,
    astNode: node,
    rangeNode: moduleNode ?? node,
    ownerId: ctx.fileNodeId,
    properties: {
      importSource: moduleName,
      importedNames: importedNames(node),
      importText: compactLabel(node.text, 160),
    },
  });

  addRichEdge(ctx, {
    source: ctx.fileNodeId,
    target: importNode.id,
    relationshipType: "IMPORTS",
    astNode: node,
  });

  extractImportAliases(ctx, node, importNode.id);
}

function extractAssignment(ctx: RichExtractionContext, node: SyntaxNode): void {
  const left =
    node.childForFieldName("left") ??
    node.namedChildren.find((child) =>
      ["identifier", "pattern_list", "attribute", "subscript"].includes(child.type),
    );
  if (!left) return;

  const names = assignmentTargets(left);
  if (names.length === 0) return;

  const ownerId = ctx.currentScopeId || ctx.fileNodeId;
  const owner = ctx.nodes.find((candidate) => candidate.id === ownerId);
  const ownerType = owner?.type;
  const ownerIsFile = ownerId === ctx.fileNodeId;
  const annotation = assignmentAnnotation(node);

  names.forEach((nameNode) => {
    const label = compactLabel(nameNode.text, 80);
    if (!label) return;

    const detailType =
      ownerType === "Class"
        ? "Field"
        : isUppercaseName(label)
          ? "Constant"
          : ownerIsFile
            ? "Variable"
            : "Local";

    const detailNode = addRichNode(ctx, {
      type: detailType,
      label,
      astNode: node,
      rangeNode: nameNode,
      ownerId,
      properties: {
        assignmentKind: node.type,
      },
    });

    if (detailType === "Field") {
      addRichEdge(ctx, {
        source: ownerId,
        target: detailNode.id,
        relationshipType: "HAS_FIELD",
        astNode: node,
      });
    } else {
      addContainment(ctx, ownerId, detailNode.id, node);
    }

    addTypedAnnotation(ctx, detailNode.id, annotation, "TYPE_OF", detailType);
  });
}

function extractDecorators(
  ctx: RichExtractionContext,
  ownerId: string,
  node: SyntaxNode,
): void {
  const parent = node.parent;
  const decorators = parent?.type === "decorated_definition"
    ? parent.children.filter((child) => child.type === "decorator")
    : [];

  decorators.forEach((decorator) => {
    const decoratorNode = addRichNode(ctx, {
      type: "Decorator",
      label: compactLabel(decorator.text, 80),
      astNode: decorator,
      ownerId,
    });
    addRichEdge(ctx, {
      source: ownerId,
      target: decoratorNode.id,
      relationshipType: "ANNOTATED_BY",
      astNode: decorator,
    });
  });
}

function extractDocString(
  ctx: RichExtractionContext,
  ownerId: string,
  node: SyntaxNode,
): void {
  const body = node.childForFieldName("body") ?? node.namedChildren.find((child) => child.type === "block");
  if (!body) return;
  const firstStatement = body.namedChildren[0];
  if (!firstStatement || firstStatement.type !== "expression_statement") return;
  const stringNode = firstStatement.namedChildren.find((child) =>
    ["string", "string_start", "string_content"].includes(child.type),
  );
  if (!stringNode && !/^\s*([rubfRUBF]*['"]{3}|[rubfRUBF]*['"])/.test(firstStatement.text)) {
    return;
  }

  const doc = addRichNode(ctx, {
    type: "DocBlock",
    label: compactLabel(stripPythonString(firstStatement.text), 100),
    astNode: firstStatement,
    ownerId,
    properties: { documentation: true },
  });
  addRichEdge(ctx, {
    source: doc.id,
    target: ownerId,
    relationshipType: "DOCUMENTS",
    astNode: firstStatement,
  });
}

function parameterNameNode(param: SyntaxNode): SyntaxNode | undefined {
  if (param.type === "identifier") return param;
  return (
    param.childForFieldName("name") ??
    param.childForFieldName("left") ??
    firstDescendantOfType(param, ["identifier"])
  );
}

function parameterAnnotation(param: SyntaxNode): SyntaxNode | undefined {
  const explicit =
    param.childForFieldName("type") ??
    param.namedChildren.find((child) => child.type === "type");
  if (explicit) return explicit;
  if (!param.text.includes(":")) return undefined;
  const nameNode = parameterNameNode(param);
  return param.namedChildren.find(
    (child) =>
      child.id !== nameNode?.id &&
      !["identifier", "integer", "float", "string", "true", "false", "none"].includes(child.type),
  );
}

function returnAnnotation(node: SyntaxNode): SyntaxNode | undefined {
  return (
    node.childForFieldName("return_type") ??
    node.childForFieldName("type") ??
    node.namedChildren.find((child) => child.type === "type")
  );
}

function importModuleNode(node: SyntaxNode): SyntaxNode | undefined {
  return (
    node.childForFieldName("module_name") ??
    node.childForFieldName("name") ??
    firstNamedChildOfType(node, NAME_TYPES)
  );
}

function importedNames(node: SyntaxNode): string[] {
  return node
    .descendantsOfType("identifier")
    .map((identifier) => compactLabel(identifier.text, 80));
}

function extractImportAliases(
  ctx: RichExtractionContext,
  node: SyntaxNode,
  importNodeId: string,
): void {
  const aliases = node.descendantsOfType("aliased_import");
  aliases.forEach((alias) => {
    const aliasName = alias.childForFieldName("alias") ?? alias.namedChildren[alias.namedChildren.length - 1];
    if (!aliasName) return;
    const aliasNode = addRichNode(ctx, {
      type: "Import",
      label: aliasName.text,
      astNode: alias,
      rangeNode: aliasName,
      ownerId: importNodeId,
      properties: { aliasFor: compactLabel(alias.text, 120) },
    });
    addRichEdge(ctx, {
      source: importNodeId,
      target: aliasNode.id,
      relationshipType: "ALIASES",
      astNode: alias,
    });
  });
}

function assignmentTargets(left: SyntaxNode): SyntaxNode[] {
  if (left.type === "identifier" || left.type === "attribute") return [left];
  return left.descendantsOfType("identifier");
}

function assignmentAnnotation(node: SyntaxNode): SyntaxNode | undefined {
  return node.childForFieldName("type") ?? node.namedChildren.find((child) => child.type === "type");
}

function stripPythonString(value: string): string {
  return compactLabel(
    value
      .replace(/^\s*[rubfRUBF]*('''|"""|'|")/, "")
      .replace(/('''|"""|'|")\s*$/, "")
      .trim(),
    100,
  );
}
