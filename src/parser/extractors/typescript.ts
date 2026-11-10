import { SyntaxNode } from "web-tree-sitter";
import {
  addContainment,
  addFrameworkRoleNode,
  addFrameworkRoute,
  addRichEdge,
  addRichNode,
  addTypedAnnotation,
  cleanTypeText,
  compactLabel,
  firstDescendantOfType,
  firstNamedChildOfType,
  firstStringLiteralValue,
  frameworkRoleFromNameOrPath,
  hasAncestorType,
  isUppercaseName,
  RichExtractionContext,
  unquote,
} from "./common";

const FUNCTION_TYPES = new Set([
  "function_declaration",
  "function_expression",
  "generator_function_declaration",
  "generator_function",
  "arrow_function",
  "method_definition",
  "method_declaration",
  "method_signature",
  "function_signature",
  "constructor_declaration",
]);

const FIELD_TYPES = new Set([
  "field_definition",
  "public_field_definition",
  "property_declaration",
  "property_signature",
  "abstract_property_signature",
]);

const VARIABLE_DECLARATION_TYPES = new Set([
  "lexical_declaration",
  "variable_declaration",
]);

const TYPE_NAME_TYPES = [
  "identifier",
  "type_identifier",
  "property_identifier",
  "private_property_identifier",
] as const;

export function extractTypeScriptRichNodes(ctx: RichExtractionContext): void {
  const node = ctx.astNode;

  if (FUNCTION_TYPES.has(node.type)) {
    extractFunctionDetails(ctx, node);
    return;
  }

  if (node.type === "class_declaration" || node.type === "class_expression") {
    extractClassFrameworkDetails(ctx, node);
    return;
  }

  if (FIELD_TYPES.has(node.type)) {
    extractFieldOrProperty(ctx, node);
    return;
  }

  if (VARIABLE_DECLARATION_TYPES.has(node.type)) {
    extractVariables(ctx, node);
    return;
  }

  switch (node.type) {
    case "import_statement":
    case "import_declaration":
      extractImport(ctx, node);
      break;
    case "export_statement":
    case "export_default_declaration":
      extractExport(ctx, node);
      break;
    case "type_alias_declaration":
      extractTypeAlias(ctx, node);
      break;
    case "enum_declaration":
      extractEnum(ctx, node);
      break;
    case "internal_module":
    case "module_declaration":
    case "namespace_declaration":
      extractNamespace(ctx, node);
      break;
    case "call_expression":
      extractCallFrameworkDetails(ctx, node);
      break;
    case "jsx_attribute":
      extractJsxEventHandler(ctx, node);
      break;
  }
}

function extractFunctionDetails(
  ctx: RichExtractionContext,
  node: SyntaxNode,
): void {
  const ownerId = ctx.currentScopeId;
  extractParameters(ctx, ownerId, node);
  extractReturnAnnotation(ctx, ownerId, node);
  extractDecorators(ctx, ownerId, node);
  extractLeadingDoc(ctx, ownerId, node);
  extractReactComponent(ctx, ownerId, node);
  extractGenericFrameworkRole(ctx, ownerId, node);
}


function extractClassFrameworkDetails(
  ctx: RichExtractionContext,
  node: SyntaxNode,
): void {
  const ownerId = ctx.currentScopeId;
  const owner = ctx.nodes.find((candidate) => candidate.id === ownerId);
  const label = owner?.label ?? className(node) ?? "class";
  extractGenericFrameworkRole(ctx, ownerId, node);

  const decorators = decoratorNodes(node);
  decorators.forEach((decorator) => {
    const name = decoratorName(decorator.text);
    if (name === "Component") {
      const component = addFrameworkRoleNode(ctx, {
        type: "AngularComponent",
        label,
        ownerId,
        astNode: decorator,
        framework: "Angular",
        role: "Component",
        properties: angularComponentProperties(decorator.text),
      });
      addAngularTemplate(ctx, component.id, decorator, label);
      return;
    }
    if (name === "Injectable") {
      addFrameworkRoleNode(ctx, {
        type: "AngularService",
        label,
        ownerId,
        astNode: decorator,
        framework: "Angular",
        role: "Service",
      });
      return;
    }
    if (name === "NgModule") {
      addFrameworkRoleNode(ctx, {
        type: "FrameworkModule",
        label,
        ownerId,
        astNode: decorator,
        framework: "Angular",
        role: "Module",
        properties: { moduleKind: "NgModule" },
      });
    }
  });

  if (/extends\s+React\.Component|extends\s+Component/.test(node.text)) {
    addFrameworkRoleNode(ctx, {
      type: "ReactComponent",
      label,
      ownerId,
      astNode: node,
      rangeNode: node.childForFieldName("name") ?? node,
      framework: "React",
      role: "Component",
      properties: { detectedBy: "react-class" },
    });
  }
}

function extractCallFrameworkDetails(
  ctx: RichExtractionContext,
  node: SyntaxNode,
): void {
  extractExpressRoute(ctx, node);
  extractReactHook(ctx, node);
  extractAngularRoutes(ctx, node);
}

function extractReactComponent(
  ctx: RichExtractionContext,
  ownerId: string,
  node: SyntaxNode,
): void {
  const owner = ctx.nodes.find((candidate) => candidate.id === ownerId);
  const label = owner?.label ?? functionName(node) ?? "component";
  if (!isPascalCase(label)) return;
  if (!looksLikeReactComponent(node.text)) return;

  const component = addFrameworkRoleNode(ctx, {
    type: "ReactComponent",
    label,
    ownerId,
    astNode: node,
    rangeNode: node.childForFieldName("name") ?? node,
    framework: "React",
    role: "Component",
    properties: { detectedBy: "jsx-return" },
  });

  const jsxNode = firstDescendantOfType(node, ["jsx_element", "jsx_self_closing_element", "jsx_fragment"]);
  if (!jsxNode) return;
  const template = addRichNode(ctx, {
    type: "Template",
    label: `${label} JSX`,
    astNode: jsxNode,
    ownerId: component.id,
    properties: {
      framework: "React",
      templateKind: jsxNode.type,
      inventoryVisible: true,
    },
  });
  addRichEdge(ctx, {
    source: component.id,
    target: template.id,
    relationshipType: "RENDERS",
    astNode: jsxNode,
    properties: { framework: "React" },
  });
}

function extractReactHook(ctx: RichExtractionContext, node: SyntaxNode): void {
  const fn = node.childForFieldName("function") ?? node.namedChildren[0];
  const name = fn ? callableTail(fn.text) : undefined;
  if (!name || !/^use[A-Z0-9_]/.test(name)) return;

  const hook = addRichNode(ctx, {
    type: "Hook",
    label: name,
    astNode: node,
    rangeNode: fn ?? node,
    ownerId: ctx.currentScopeId,
    properties: {
      framework: "React",
      hookName: name,
      inventoryVisible: true,
    },
  });
  addRichEdge(ctx, {
    source: ctx.currentScopeId,
    target: hook.id,
    relationshipType: "USES_HOOK",
    astNode: node,
    properties: { framework: "React", hookName: name },
  });
}

function extractReactStateVariable(
  ctx: RichExtractionContext,
  declarator: SyntaxNode,
  nameNode: SyntaxNode,
): void {
  if (!/\buseState\s*\(/.test(declarator.text)) return;
  const stateNames = stateVariableNames(nameNode.text);
  if (stateNames.length === 0) return;

  const hook = addRichNode(ctx, {
    type: "Hook",
    label: "useState",
    astNode: declarator,
    ownerId: ctx.currentScopeId,
    properties: {
      framework: "React",
      hookName: "useState",
      inventoryVisible: true,
    },
  });
  addRichEdge(ctx, {
    source: ctx.currentScopeId,
    target: hook.id,
    relationshipType: "USES_HOOK",
    astNode: declarator,
    properties: { framework: "React", hookName: "useState" },
  });

  stateNames.forEach((stateName, index) => {
    const stateNode = addRichNode(ctx, {
      type: "StateVariable",
      label: stateName,
      astNode: declarator,
      rangeNode: nameNode,
      ownerId: ctx.currentScopeId,
      properties: {
        framework: "React",
        index,
        inventoryVisible: true,
      },
    });
    addRichEdge(ctx, {
      source: hook.id,
      target: stateNode.id,
      relationshipType: "UPDATES_STATE",
      astNode: declarator,
      properties: { framework: "React", index },
    });
  });
}

function extractJsxEventHandler(ctx: RichExtractionContext, node: SyntaxNode): void {
  const nameNode = node.childForFieldName("name") ?? node.children.find((child) => child.type === "property_identifier");
  const name = nameNode?.text;
  if (!name || !/^on[A-Z]/.test(name)) return;
  const handler = addRichNode(ctx, {
    type: "EventHandler",
    label: name,
    astNode: node,
    rangeNode: nameNode,
    ownerId: ctx.currentScopeId,
    properties: {
      framework: "React",
      eventName: name,
      inventoryVisible: true,
    },
  });
  addRichEdge(ctx, {
    source: ctx.currentScopeId,
    target: handler.id,
    relationshipType: "HANDLES",
    astNode: node,
    properties: { framework: "React", eventName: name },
  });
}

function extractExpressRoute(ctx: RichExtractionContext, node: SyntaxNode): void {
  const fn = node.childForFieldName("function") ?? node.namedChildren[0];
  if (!fn) return;
  const match = fn.text.match(/^([A-Za-z_$][\w$]*)\.(get|post|put|patch|delete|options|head|all|use)$/i);
  if (!match) return;
  const path = firstStringLiteralValue(node.text);
  if (!path || !path.startsWith("/")) return;
  const handlerReference = expressHandlerReference(node.text, path);
  const owner = ctx.nodes.find((candidate) => candidate.id === ctx.currentScopeId);
  addFrameworkRoute(ctx, {
    framework: "Express",
    httpMethod: match[2],
    path,
    routerName: match[1],
    handlerId: ctx.currentScopeId,
    handlerLabel: owner?.label,
    astNode: node,
    properties: {
      detectedBy: "route-registration",
      handlerReference,
    },
  });
}

function extractAngularRoutes(ctx: RichExtractionContext, node: SyntaxNode): void {
  const fn = node.childForFieldName("function") ?? node.namedChildren[0];
  if (!fn || !/RouterModule\.(forRoot|forChild)$/.test(fn.text)) return;
  const pathMatches = Array.from(node.text.matchAll(/\bpath\s*:\s*(["'`])([^"'`]*)\1/g));
  pathMatches.forEach((match) => {
    const owner = ctx.nodes.find((candidate) => candidate.id === ctx.currentScopeId);
    addFrameworkRoute(ctx, {
      framework: "Angular",
      httpMethod: "ROUTE",
      path: match[2] || "/",
      routerName: fn.text,
      handlerId: ctx.currentScopeId,
      handlerLabel: owner?.label,
      astNode: node,
      properties: { detectedBy: "RouterModule" },
    });
  });
}

function extractGenericFrameworkRole(
  ctx: RichExtractionContext,
  ownerId: string,
  node: SyntaxNode,
): void {
  const owner = ctx.nodes.find((candidate) => candidate.id === ownerId);
  const label = owner?.label ?? className(node) ?? functionName(node) ?? "code";
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
  return node.children.filter((child) => child.type === "decorator");
}

function decoratorName(text: string): string | undefined {
  return text.match(/^@\s*([A-Za-z_$][\w$]*)/)?.[1];
}

function angularComponentProperties(text: string): Record<string, unknown> {
  return {
    selector: text.match(/\bselector\s*:\s*(["'`])([^"'`]*)\1/)?.[2],
    templateUrl: text.match(/\btemplateUrl\s*:\s*(["'`])([^"'`]*)\1/)?.[2],
  };
}

function addAngularTemplate(
  ctx: RichExtractionContext,
  componentId: string,
  decorator: SyntaxNode,
  ownerLabel: string,
): void {
  const props = angularComponentProperties(decorator.text);
  const templateText = firstStringLiteralValue(
    decorator.text.match(/\btemplate\s*:\s*(["'`])([^"'`]*)\1/)?.[0] ?? "",
  );
  const templateUrl = typeof props.templateUrl === "string" ? props.templateUrl : undefined;
  if (!templateText && !templateUrl) return;
  const template = addRichNode(ctx, {
    type: "Template",
    label: templateUrl ?? `${ownerLabel} template`,
    astNode: decorator,
    ownerId: componentId,
    properties: {
      framework: "Angular",
      templateKind: templateUrl ? "templateUrl" : "inline",
      templateUrl,
      inventoryVisible: true,
    },
  });
  addRichEdge(ctx, {
    source: componentId,
    target: template.id,
    relationshipType: "BINDS_TEMPLATE",
    astNode: decorator,
    properties: { framework: "Angular", templateUrl },
  });
}

function className(node: SyntaxNode): string | undefined {
  return node.childForFieldName("name")?.text;
}

function functionName(node: SyntaxNode): string | undefined {
  return node.childForFieldName("name")?.text;
}

function isPascalCase(value: string): boolean {
  return /^[A-Z][A-Za-z0-9]*$/.test(value);
}

function looksLikeReactComponent(text: string): boolean {
  return /<\s*[A-Za-z][^>]*>/.test(text) || /React\.createElement\s*\(/.test(text);
}

function callableTail(value: string): string {
  return value.split(".").pop() ?? value;
}

function stateVariableNames(value: string): string[] {
  const clean = value.replace(/[\[\]{}]/g, " ").trim();
  return clean
    .split(/\s*,\s*/)
    .map((part) => part.trim())
    .filter((part, index) => index === 0 && /^[A-Za-z_$][\w$]*$/.test(part));
}

function expressHandlerReference(text: string, path: string): string | undefined {
  const afterPath = text.slice(text.indexOf(path) + path.length);
  const identifiers = afterPath.match(/\b[A-Za-z_$][\w$]*\b/g) ?? [];
  return identifiers.find((identifier) => !["req", "res", "next"].includes(identifier));
}

function extractParameters(
  ctx: RichExtractionContext,
  ownerId: string,
  node: SyntaxNode,
): void {
  const params = parameterList(node);
  if (!params) return;

  const items = params.namedChildren.filter(
    (child) => !["comment", "type_annotation"].includes(child.type),
  );

  items.forEach((param, index) => {
    const nameNode = parameterNameNode(param);
    const label = nameNode ? nameNode.text : parameterFallbackLabel(param, index);
    if (!label || label === ",") return;

    const parameter = addRichNode(ctx, {
      type: "Parameter",
      label,
      astNode: param,
      rangeNode: nameNode ?? param,
      ownerId,
      properties: {
        index,
        optional: isOptionalParameter(param),
        variadic: isVariadicParameter(param),
      },
    });

    addRichEdge(ctx, {
      source: ownerId,
      target: parameter.id,
      relationshipType: "HAS_PARAM",
      astNode: param,
      properties: { index },
    });

    const annotation = parameterTypeAnnotation(param);
    addTypedAnnotation(ctx, parameter.id, annotation, "TYPE_OF", "parameter");
  });
}

function extractReturnAnnotation(
  ctx: RichExtractionContext,
  ownerId: string,
  node: SyntaxNode,
): void {
  const params = parameterList(node);
  const direct =
    node.childForFieldName("return_type") ??
    node.childForFieldName("type") ??
    node.children.find(
      (child) =>
        child.type === "type_annotation" &&
        (!params || child.startIndex >= params.endIndex),
    );
  addTypedAnnotation(ctx, ownerId, direct, "RETURNS", "return");
}

function extractFieldOrProperty(
  ctx: RichExtractionContext,
  node: SyntaxNode,
): void {
  const nameNode = fieldNameNode(node);
  if (!nameNode) return;

  const type = node.type.includes("property") ? "Property" : "Field";
  const relationshipType = type === "Property" ? "HAS_PROPERTY" : "HAS_FIELD";
  const ownerId = ctx.currentScopeId || ctx.fileNodeId;

  const field = addRichNode(ctx, {
    type,
    label: nameNode.text,
    astNode: node,
    rangeNode: nameNode,
    ownerId,
    properties: {
      optional: /\?/.test(node.text),
      readonly: /\breadonly\b/.test(node.text),
      static: /\bstatic\b/.test(node.text),
      visibility: visibilityModifier(node),
    },
  });

  addRichEdge(ctx, {
    source: ownerId,
    target: field.id,
    relationshipType,
    astNode: node,
  });

  addTypedAnnotation(ctx, field.id, fieldTypeAnnotation(node), "TYPE_OF", type);
  extractDecorators(ctx, field.id, node);
  extractLeadingDoc(ctx, field.id, node);
}

function extractVariables(
  ctx: RichExtractionContext,
  node: SyntaxNode,
): void {
  const declarators = node.namedChildren.filter(
    (child) => child.type === "variable_declarator",
  );
  if (declarators.length === 0) return;

  const keyword = declarationKeyword(node);
  const ownerId = ctx.currentScopeId || ctx.fileNodeId;
  const ownerIsFile = ownerId === ctx.fileNodeId;

  declarators.forEach((declarator) => {
    const nameNode = declarator.childForFieldName("name") ?? variableNameNode(declarator);
    if (!nameNode) return;
    const label = compactLabel(nameNode.text, 80);
    if (!label) return;

    const nodeType =
      keyword === "const" || isUppercaseName(label)
        ? "Constant"
        : ownerIsFile
          ? "Variable"
          : "Local";

    const variable = addRichNode(ctx, {
      type: nodeType,
      label,
      astNode: declarator,
      rangeNode: nameNode,
      ownerId,
      properties: {
        declarationKind: keyword,
        exported: hasAncestorType(node, ["export_statement", "export_default_declaration"]),
      },
    });

    addContainment(ctx, ownerId, variable.id, declarator);
    addTypedAnnotation(ctx, variable.id, variableTypeAnnotation(declarator), "TYPE_OF", nodeType);
    extractReactStateVariable(ctx, declarator, nameNode);
  });
}

function extractImport(ctx: RichExtractionContext, node: SyntaxNode): void {
  const sourceNode = importSourceNode(node);
  const source = sourceNode ? unquote(sourceNode.text) : compactLabel(node.text, 100);
  if (!source) return;

  const importedNames = importSpecifierLabels(node);
  const importNode = addRichNode(ctx, {
    type: "Import",
    label: source,
    astNode: node,
    rangeNode: sourceNode ?? node,
    ownerId: ctx.fileNodeId,
    properties: {
      importSource: source,
      importedNames,
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

function extractExport(ctx: RichExtractionContext, node: SyntaxNode): void {
  const sourceNode = importSourceNode(node);
  const label = exportLabel(node, sourceNode);
  const exportNode = addRichNode(ctx, {
    type: "Export",
    label,
    astNode: node,
    rangeNode: sourceNode ?? node,
    ownerId: ctx.fileNodeId,
    properties: {
      exportSource: sourceNode ? unquote(sourceNode.text) : undefined,
      exportText: compactLabel(node.text, 160),
      default: node.type === "export_default_declaration" || /\bdefault\b/.test(node.text),
    },
  });

  addRichEdge(ctx, {
    source: ctx.fileNodeId,
    target: exportNode.id,
    relationshipType: "EXPORTS",
    astNode: node,
  });

  if (sourceNode) {
    const reexportSource = addRichNode(ctx, {
      type: "Import",
      label: unquote(sourceNode.text),
      astNode: node,
      rangeNode: sourceNode,
      ownerId: exportNode.id,
      properties: { importSource: unquote(sourceNode.text), reexport: true },
    });
    addRichEdge(ctx, {
      source: exportNode.id,
      target: reexportSource.id,
      relationshipType: "REEXPORTS",
      astNode: node,
    });
  }
}

function extractTypeAlias(ctx: RichExtractionContext, node: SyntaxNode): void {
  const nameNode = node.childForFieldName("name") ?? firstNamedChildOfType(node, TYPE_NAME_TYPES);
  if (!nameNode) return;
  const ownerId = ctx.currentScopeId || ctx.fileNodeId;
  const alias = addRichNode(ctx, {
    type: "TypeAlias",
    label: nameNode.text,
    astNode: node,
    rangeNode: nameNode,
    ownerId,
    properties: {
      exported: hasAncestorType(node, ["export_statement", "export_default_declaration"]),
    },
  });
  addContainment(ctx, ownerId, alias.id, node);

  const targetType =
    node.childForFieldName("value") ??
    node.childForFieldName("type") ??
    node.namedChildren.find((child) => child.startIndex > nameNode.endIndex && child.type !== "type_identifier");
  const annotation = addTypedAnnotation(ctx, alias.id, targetType, "TYPE_OF", "type_alias");
  if (annotation) {
    addRichEdge(ctx, {
      source: alias.id,
      target: annotation.id,
      relationshipType: "ALIASES",
      astNode: targetType,
    });
  }

  maybeAddExportEdge(ctx, alias.id, node);
  extractLeadingDoc(ctx, alias.id, node);
}

function extractEnum(ctx: RichExtractionContext, node: SyntaxNode): void {
  const nameNode = node.childForFieldName("name") ?? firstNamedChildOfType(node, TYPE_NAME_TYPES);
  if (!nameNode) return;
  const ownerId = ctx.currentScopeId || ctx.fileNodeId;
  const enumNode = addRichNode(ctx, {
    type: "Enum",
    label: nameNode.text,
    astNode: node,
    rangeNode: nameNode,
    ownerId,
    properties: {
      exported: hasAncestorType(node, ["export_statement", "export_default_declaration"]),
    },
  });
  addContainment(ctx, ownerId, enumNode.id, node);
  maybeAddExportEdge(ctx, enumNode.id, node);
  extractLeadingDoc(ctx, enumNode.id, node);

  const body = node.namedChildren.find((child) => child.type === "enum_body");
  const members = body?.namedChildren ?? [];
  members.forEach((member, index) => {
    const memberName = firstDescendantOfType(member, TYPE_NAME_TYPES) ?? member;
    const label = compactLabel(memberName.text, 80);
    if (!label || label === ",") return;
    const enumMember = addRichNode(ctx, {
      type: "EnumMember",
      label,
      astNode: member,
      rangeNode: memberName,
      ownerId: enumNode.id,
      properties: { index },
    });
    addContainment(ctx, enumNode.id, enumMember.id, member);
  });
}

function extractNamespace(ctx: RichExtractionContext, node: SyntaxNode): void {
  const nameNode = node.childForFieldName("name") ?? firstNamedChildOfType(node, TYPE_NAME_TYPES);
  if (!nameNode) return;
  const ownerId = ctx.currentScopeId || ctx.fileNodeId;
  const namespace = addRichNode(ctx, {
    type: "Namespace",
    label: nameNode.text,
    astNode: node,
    rangeNode: nameNode,
    ownerId,
  });
  addContainment(ctx, ownerId, namespace.id, node);
}

function extractDecorators(
  ctx: RichExtractionContext,
  ownerId: string,
  node: SyntaxNode,
): void {
  const decorators = node.children.filter((child) => child.type === "decorator");
  decorators.forEach((decorator) => {
    const label = compactLabel(decorator.text, 80);
    const decoratorNode = addRichNode(ctx, {
      type: "Decorator",
      label,
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

function extractLeadingDoc(
  ctx: RichExtractionContext,
  ownerId: string,
  node: SyntaxNode,
): void {
  const comment = leadingDocComment(node);
  if (!comment) return;
  const doc = addRichNode(ctx, {
    type: comment.text.trim().startsWith("/**") ? "DocBlock" : "Comment",
    label: compactLabel(comment.text.replace(/^\/\*\*?/, "").replace(/\*\/$/, ""), 100),
    astNode: comment,
    ownerId,
    properties: { documentation: true },
  });
  addRichEdge(ctx, {
    source: doc.id,
    target: ownerId,
    relationshipType: "DOCUMENTS",
    astNode: comment,
  });
}

function maybeAddExportEdge(
  ctx: RichExtractionContext,
  targetId: string,
  node: SyntaxNode,
): void {
  if (!hasAncestorType(node, ["export_statement", "export_default_declaration"])) return;
  addRichEdge(ctx, {
    source: ctx.fileNodeId,
    target: targetId,
    relationshipType: "EXPORTS",
    astNode: node,
  });
}

function parameterList(node: SyntaxNode): SyntaxNode | undefined {
  return (
    node.childForFieldName("parameters") ??
    node.namedChildren.find((child) => child.type === "formal_parameters")
  );
}

function parameterNameNode(param: SyntaxNode): SyntaxNode | undefined {
  if (TYPE_NAME_TYPES.includes(param.type as typeof TYPE_NAME_TYPES[number])) return param;
  return (
    param.childForFieldName("pattern") ??
    param.childForFieldName("name") ??
    firstDescendantOfType(param, TYPE_NAME_TYPES)
  );
}

function parameterFallbackLabel(param: SyntaxNode, index: number): string {
  const text = compactLabel(param.text, 60);
  return text && text !== "," ? text : `param${index + 1}`;
}

function isOptionalParameter(param: SyntaxNode): boolean {
  return param.type.includes("optional") || /\?\s*:/.test(param.text);
}

function isVariadicParameter(param: SyntaxNode): boolean {
  return param.type.includes("rest") || param.text.trim().startsWith("...");
}

function parameterTypeAnnotation(param: SyntaxNode): SyntaxNode | undefined {
  return (
    param.childForFieldName("type") ??
    param.namedChildren.find((child) => child.type === "type_annotation")
  );
}

function fieldNameNode(node: SyntaxNode): SyntaxNode | undefined {
  return node.childForFieldName("name") ?? firstNamedChildOfType(node, TYPE_NAME_TYPES);
}

function fieldTypeAnnotation(node: SyntaxNode): SyntaxNode | undefined {
  return (
    node.childForFieldName("type") ??
    node.namedChildren.find((child) => child.type === "type_annotation")
  );
}

function variableNameNode(node: SyntaxNode): SyntaxNode | undefined {
  return firstDescendantOfType(node, TYPE_NAME_TYPES);
}

function variableTypeAnnotation(node: SyntaxNode): SyntaxNode | undefined {
  return (
    node.childForFieldName("type") ??
    node.namedChildren.find((child) => child.type === "type_annotation")
  );
}

function declarationKeyword(node: SyntaxNode): string {
  const first = node.children.find((child) => ["const", "let", "var"].includes(child.type));
  if (first) return first.type;
  const match = node.text.match(/^\s*(const|let|var)\b/);
  return match?.[1] ?? "var";
}

function visibilityModifier(node: SyntaxNode): string | undefined {
  const match = node.text.match(/\b(public|private|protected)\b/);
  return match?.[1];
}

function importSourceNode(node: SyntaxNode): SyntaxNode | undefined {
  return (
    node.childForFieldName("source") ??
    node.namedChildren.find((child) =>
      ["string", "string_literal", "template_string"].includes(child.type),
    )
  );
}

function importSpecifierLabels(node: SyntaxNode): string[] {
  const specs = node.descendantsOfType("import_specifier");
  if (specs.length > 0) return specs.map((spec) => compactLabel(spec.text, 80));
  return node
    .descendantsOfType("identifier")
    .map((identifier) => compactLabel(identifier.text, 80));
}

function extractImportAliases(
  ctx: RichExtractionContext,
  node: SyntaxNode,
  importNodeId: string,
): void {
  const specifiers = node.descendantsOfType("import_specifier");
  specifiers.forEach((specifier) => {
    const alias = specifier.childForFieldName("alias");
    if (!alias) return;
    const aliasNode = addRichNode(ctx, {
      type: "Import",
      label: alias.text,
      astNode: specifier,
      rangeNode: alias,
      ownerId: importNodeId,
      properties: {
        aliasFor: compactLabel(specifier.text, 120),
      },
    });
    addRichEdge(ctx, {
      source: importNodeId,
      target: aliasNode.id,
      relationshipType: "ALIASES",
      astNode: specifier,
    });
  });
}

function exportLabel(node: SyntaxNode, sourceNode: SyntaxNode | undefined): string {
  if (node.type === "export_default_declaration") return "default";
  if (sourceNode) return `from ${unquote(sourceNode.text)}`;
  const identifiers = node.descendantsOfType("identifier").slice(0, 4);
  if (identifiers.length > 0) {
    return identifiers.map((identifier) => identifier.text).join(", ");
  }
  return compactLabel(node.text.replace(/^\s*export\s*/, ""), 80) || "export";
}

function leadingDocComment(node: SyntaxNode): SyntaxNode | undefined {
  const parent = node.parent;
  if (!parent) return undefined;
  const siblings = parent.children;
  const index = siblings.findIndex((child) => child.id === node.id);
  if (index <= 0) return undefined;

  for (let i = index - 1; i >= 0; i--) {
    const sibling = siblings[i];
    if (sibling.type !== "comment") return undefined;
    const text = sibling.text.trim();
    const closeEnough = node.startPosition.row - sibling.endPosition.row <= 1;
    if (closeEnough && (text.startsWith("/**") || text.startsWith("///"))) {
      return sibling;
    }
  }
  return undefined;
}
