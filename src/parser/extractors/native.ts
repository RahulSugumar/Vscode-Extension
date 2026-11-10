import * as path from "path";
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
  ownerType,
  RichExtractionContext,
  unquote,
} from "./common";

const NATIVE_EXTENSIONS = new Set([
  ".java",
  ".cs",
  ".c",
  ".h",
  ".cpp",
  ".cc",
  ".cxx",
  ".hpp",
  ".hh",
  ".hxx",
  ".rs",
  ".go",
]);

const CALLABLE_TYPES = new Set([
  "function_definition",
  "function_declaration",
  "function_item",
  "method_declaration",
  "method_definition",
  "constructor_declaration",
  "function_signature",
]);

const PARAMETER_CONTAINER_TYPES = [
  "formal_parameters",
  "parameter_list",
  "parameters",
] as const;

const PARAMETER_TYPES = [
  "formal_parameter",
  "parameter",
  "parameter_declaration",
  "optional_parameter_declaration",
  "variadic_parameter_declaration",
  "self_parameter",
] as const;

const FIELD_TYPES = new Set([
  "field_declaration",
  "property_declaration",
  "property_signature",
]);

const VARIABLE_DECLARATION_TYPES = new Set([
  "local_variable_declaration",
  "variable_declaration",
  "declaration",
  "let_declaration",
  "short_var_declaration",
  "var_spec",
  "const_spec",
  "const_item",
  "static_item",
]);

const IMPORT_TYPES = new Set([
  "import_declaration",
  "import_spec",
  "using_directive",
  "use_declaration",
  "preproc_include",
]);

const NAMESPACE_TYPES = new Set([
  "package_declaration",
  "package_clause",
  "namespace_declaration",
  "file_scoped_namespace_declaration",
  "namespace_definition",
  "mod_item",
]);

const TYPE_ALIAS_TYPES = new Set([
  "type_alias_declaration",
  "type_definition",
  "type_item",
  "type_spec",
  "using_alias_directive",
]);

const ENUM_TYPES = new Set([
  "enum_declaration",
  "enum_specifier",
  "enum_item",
]);

const ENUM_MEMBER_TYPES = [
  "enum_constant",
  "enum_member",
  "enum_member_declaration",
  "enum_variant",
  "enumerator",
] as const;

const NAME_TYPES = [
  "identifier",
  "field_identifier",
  "property_identifier",
  "shorthand_field_identifier",
  "package_identifier",
] as const;

const QUALIFIED_NAME_TYPES = [
  "identifier",
  "type_identifier",
  "field_identifier",
  "property_identifier",
  "scoped_identifier",
  "qualified_name",
  "dotted_name",
  "package_identifier",
  "namespace_identifier",
] as const;

const STRING_SOURCE_TYPES = [
  "string_literal",
  "interpreted_string_literal",
  "raw_string_literal",
  "system_lib_string",
] as const;

const ANNOTATION_TYPES = new Set([
  "annotation",
  "marker_annotation",
  "attribute",
  "attribute_item",
  "attribute_list",
  "attribute_declaration",
]);


const TYPE_DECLARATION_TYPES = new Set([
  "class_declaration",
  "record_declaration",
  "interface_declaration",
  "struct_declaration",
]);

const CALL_EXPRESSION_TYPES = new Set([
  "invocation_expression",
  "call_expression",
  "method_invocation",
]);
const TYPE_HINT_TYPES = new Set([
  "type_identifier",
  "primitive_type",
  "integral_type",
  "floating_point_type",
  "boolean_type",
  "void_type",
  "generic_type",
  "scoped_type_identifier",
  "qualified_type",
  "pointer_type",
  "reference_type",
  "array_type",
  "tuple_type",
  "function_type",
  "struct_type",
  "interface_type",
  "union_type",
]);

export function supportsNativeRichNodes(filePath: string): boolean {
  return NATIVE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export function extractNativeRichNodes(ctx: RichExtractionContext): void {
  const node = ctx.astNode;

  if (CALLABLE_TYPES.has(node.type)) {
    extractCallableDetails(ctx, node);
    return;
  }

  if (TYPE_DECLARATION_TYPES.has(node.type)) {
    extractTypeFrameworkDetails(ctx, node);
    return;
  }

  if (CALL_EXPRESSION_TYPES.has(node.type)) {
    extractNativeCallFrameworkDetails(ctx, node);
    return;
  }

  if (FIELD_TYPES.has(node.type)) {
    extractFieldOrProperty(ctx, node);
    return;
  }

  if (IMPORT_TYPES.has(node.type)) {
    extractImport(ctx, node);
    return;
  }

  if (NAMESPACE_TYPES.has(node.type)) {
    extractNamespace(ctx, node);
    return;
  }

  if (ENUM_TYPES.has(node.type)) {
    extractEnum(ctx, node);
    return;
  }

  if (TYPE_ALIAS_TYPES.has(node.type) && !isEnumLikeTypeSpec(node)) {
    extractTypeAlias(ctx, node);
    return;
  }

  if (VARIABLE_DECLARATION_TYPES.has(node.type)) {
    extractVariableDeclaration(ctx, node);
  }
}

function extractCallableDetails(
  ctx: RichExtractionContext,
  node: SyntaxNode,
): void {
  const ownerId = ctx.currentScopeId || ctx.fileNodeId;
  extractParameters(ctx, ownerId, node);
  addTypedAnnotation(ctx, ownerId, returnAnnotation(node), "RETURNS", "return");
  extractAnnotations(ctx, ownerId, node);
  extractCallableFrameworkDetails(ctx, ownerId, node);
  extractGenericFrameworkRole(ctx, ownerId, node);
}


function extractTypeFrameworkDetails(
  ctx: RichExtractionContext,
  node: SyntaxNode,
): void {
  const ownerId = ctx.currentScopeId;
  const owner = ctx.nodes.find((candidate) => candidate.id === ownerId);
  const label = owner?.label ?? typeName(node) ?? "type";
  const annotationText = annotationNodes(node).map((annotation) => annotation.text).join("\n");

  extractGenericFrameworkRole(ctx, ownerId, node);

  if (/\b(RestController|Controller)\b/.test(annotationText)) {
    addFrameworkRoleNode(ctx, {
      type: "Controller",
      label,
      ownerId,
      astNode: node,
      rangeNode: node.childForFieldName("name") ?? node,
      framework: "Spring Boot",
      role: "Controller",
      properties: { detectedBy: "annotation" },
    });
  }
  if (/\bService\b/.test(annotationText)) {
    addFrameworkRoleNode(ctx, {
      type: "Service",
      label,
      ownerId,
      astNode: node,
      rangeNode: node.childForFieldName("name") ?? node,
      framework: "Spring Boot",
      role: "Service",
      properties: { detectedBy: "annotation" },
    });
  }
  if (/\bRepository\b/.test(annotationText)) {
    addFrameworkRoleNode(ctx, {
      type: "Repository",
      label,
      ownerId,
      astNode: node,
      rangeNode: node.childForFieldName("name") ?? node,
      framework: "Spring Boot",
      role: "Repository",
      properties: { detectedBy: "annotation" },
    });
  }
  if (/\bEntity\b/.test(annotationText)) {
    addFrameworkRoleNode(ctx, {
      type: "ORMModel",
      label,
      ownerId,
      astNode: node,
      rangeNode: node.childForFieldName("name") ?? node,
      framework: "Spring Boot",
      role: "Entity",
      properties: { detectedBy: "annotation" },
    });
    addDatabaseTableFromAnnotation(ctx, ownerId, node, annotationText, "Spring Boot");
  }

  if (/\b(ApiController|Controller)\b/.test(annotationText) || /:\s*Controller(Base)?\b/.test(node.text)) {
    addFrameworkRoleNode(ctx, {
      type: "Controller",
      label,
      ownerId,
      astNode: node,
      rangeNode: node.childForFieldName("name") ?? node,
      framework: "ASP.NET Core",
      role: "Controller",
      properties: { detectedBy: "attribute" },
    });
  }
  if (/\bTable\s*\(/.test(annotationText)) {
    addFrameworkRoleNode(ctx, {
      type: "ORMModel",
      label,
      ownerId,
      astNode: node,
      rangeNode: node.childForFieldName("name") ?? node,
      framework: "ASP.NET Core",
      role: "Entity",
      properties: { detectedBy: "attribute" },
    });
    addDatabaseTableFromAnnotation(ctx, ownerId, node, annotationText, "ASP.NET Core");
  }
}

function extractCallableFrameworkDetails(
  ctx: RichExtractionContext,
  ownerId: string,
  node: SyntaxNode,
): void {
  extractSpringRoute(ctx, ownerId, node);
  extractAspNetRoute(ctx, ownerId, node);
}

function extractNativeCallFrameworkDetails(ctx: RichExtractionContext, node: SyntaxNode): void {
  extractAspNetMinimalRoute(ctx, node);
}

function extractSpringRoute(
  ctx: RichExtractionContext,
  ownerId: string,
  node: SyntaxNode,
): void {
  const annotation = annotationNodes(node).find((candidate) =>
    /\b(GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping|RequestMapping)\b/.test(candidate.text),
  );
  if (!annotation) return;
  const route = parseSpringRoute(annotation.text);
  if (!route) return;
  const owner = ctx.nodes.find((candidate) => candidate.id === ownerId);
  const prefix = enclosingRoutePrefix(node, "Spring Boot");
  addFrameworkRoute(ctx, {
    framework: "Spring Boot",
    httpMethod: route.method,
    path: joinRoutePaths(prefix, route.path),
    handlerId: ownerId,
    handlerLabel: owner?.label,
    astNode: annotation,
    properties: { detectedBy: "annotation" },
  });
}

function extractAspNetRoute(
  ctx: RichExtractionContext,
  ownerId: string,
  node: SyntaxNode,
): void {
  const annotation = annotationNodes(node).find((candidate) =>
    /\b(HttpGet|HttpPost|HttpPut|HttpPatch|HttpDelete|Route)\b/.test(candidate.text),
  );
  if (!annotation) return;
  const route = parseAspNetRoute(annotation.text);
  if (!route) return;
  const owner = ctx.nodes.find((candidate) => candidate.id === ownerId);
  const prefix = enclosingRoutePrefix(node, "ASP.NET Core");
  addFrameworkRoute(ctx, {
    framework: "ASP.NET Core",
    httpMethod: route.method,
    path: joinRoutePaths(prefix, route.path),
    handlerId: ownerId,
    handlerLabel: owner?.label,
    astNode: annotation,
    properties: { detectedBy: "attribute" },
  });
}

function extractAspNetMinimalRoute(ctx: RichExtractionContext, node: SyntaxNode): void {
  const callText = node.text;
  const match = callText.match(/\bMap(Get|Post|Put|Patch|Delete|Methods|Group)\s*\(/);
  if (!match) return;
  const path = firstStringLiteralValue(callText);
  if (!path) return;
  const owner = ctx.nodes.find((candidate) => candidate.id === ctx.currentScopeId);
  addFrameworkRoute(ctx, {
    framework: "ASP.NET Core",
    httpMethod: match[1] === "Methods" || match[1] === "Group" ? "ANY" : match[1],
    path,
    handlerId: ctx.currentScopeId,
    handlerLabel: owner?.label,
    astNode: node,
    properties: { detectedBy: "minimal-api" },
  });
}

function extractGenericFrameworkRole(
  ctx: RichExtractionContext,
  ownerId: string,
  node: SyntaxNode,
): void {
  const owner = ctx.nodes.find((candidate) => candidate.id === ownerId);
  const label = owner?.label ?? typeName(node) ?? callableName(node) ?? "code";
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

function parseSpringRoute(text: string): { method: string; path: string } | undefined {
  const name = text.match(/\b(GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping|RequestMapping)\b/)?.[1];
  if (!name) return undefined;
  const explicitMethod = text.match(/RequestMethod\.([A-Z]+)/)?.[1];
  const method = (explicitMethod ?? name.replace("Mapping", "").replace("Request", "ANY")) || "ANY";
  return { method, path: firstStringLiteralValue(text) ?? "/" };
}

function parseAspNetRoute(text: string): { method: string; path: string } | undefined {
  const name = text.match(/\b(HttpGet|HttpPost|HttpPut|HttpPatch|HttpDelete|Route)\b/)?.[1];
  if (!name) return undefined;
  return {
    method: name === "Route" ? "ANY" : name.replace(/^Http/, ""),
    path: firstStringLiteralValue(text) ?? "/",
  };
}

function enclosingRoutePrefix(node: SyntaxNode, framework: "Spring Boot" | "ASP.NET Core"): string | undefined {
  let current = node.parent;
  while (current) {
    if (TYPE_DECLARATION_TYPES.has(current.type)) {
      const annotations = annotationNodes(current).map((annotation) => annotation.text).join("\n");
      const parsed = framework === "Spring Boot"
        ? parseSpringRoute(annotations)
        : parseAspNetRoute(annotations);
      return parsed?.path;
    }
    current = current.parent;
  }
  return undefined;
}

function joinRoutePaths(prefix: string | undefined, routePath: string): string {
  const cleanPrefix = (prefix ?? "").trim();
  const cleanPath = (routePath || "/").trim();
  if (!cleanPrefix || cleanPrefix === "/") return cleanPath.startsWith("/") ? cleanPath : `/${cleanPath}`;
  if (cleanPath === "/") return cleanPrefix.startsWith("/") ? cleanPrefix : `/${cleanPrefix}`;
  return `${cleanPrefix.startsWith("/") ? cleanPrefix : `/${cleanPrefix}`}/${cleanPath.replace(/^\//, "")}`;
}

function addDatabaseTableFromAnnotation(
  ctx: RichExtractionContext,
  ownerId: string,
  node: SyntaxNode,
  annotationText: string,
  framework: string,
): void {
  const tableName = annotationText.match(/\bTable\s*\([^)]*name\s*=\s*(["'`])([^"'`]*)\1/)?.[2]
    ?? annotationText.match(/\bTable\s*\(\s*(["'`])([^"'`]*)\1/)?.[2];
  if (!tableName) return;
  const table = addRichNode(ctx, {
    type: "DatabaseTable",
    label: tableName,
    astNode: node,
    ownerId,
    properties: { framework, tableName, inventoryVisible: true },
  });
  addRichEdge(ctx, {
    source: ownerId,
    target: table.id,
    relationshipType: "USES_MODEL",
    astNode: node,
    properties: { framework, tableName },
  });
}

function typeName(node: SyntaxNode): string | undefined {
  return node.childForFieldName("name")?.text ?? firstNamedChildOfType(node, QUALIFIED_NAME_TYPES)?.text;
}

function callableName(node: SyntaxNode): string | undefined {
  return node.childForFieldName("name")?.text ?? firstNamedChildOfType(node, QUALIFIED_NAME_TYPES)?.text;
}

function extractParameters(
  ctx: RichExtractionContext,
  ownerId: string,
  node: SyntaxNode,
): void {
  const containers = parameterContainers(node);
  let index = 0;

  containers.forEach((container) => {
    parameterNodes(container).forEach((param) => {
      const names = parameterNameNodes(param);
      const labels = names.length > 0 ? names : [param];

      labels.forEach((nameNode) => {
        const label = parameterLabel(nameNode, param, index);
        if (!label) return;

        const parameter = addRichNode(ctx, {
          type: "Parameter",
          label,
          astNode: param,
          rangeNode: nameNode,
          ownerId,
          properties: {
            index,
            optional: isOptional(param),
            variadic: isVariadic(param),
          },
        });

        addRichEdge(ctx, {
          source: ownerId,
          target: parameter.id,
          relationshipType: "HAS_PARAM",
          astNode: param,
          properties: { index },
        });

        addTypedAnnotation(ctx, parameter.id, typeAnnotation(param, nameNode), "TYPE_OF", "parameter");
        index += 1;
      });
    });
  });
}

function extractFieldOrProperty(
  ctx: RichExtractionContext,
  node: SyntaxNode,
): void {
  const ownerId = ctx.currentScopeId || ctx.fileNodeId;
  const isProperty = node.type.includes("property");
  const detailType = isProperty ? "Property" : "Field";
  const relationshipType = isProperty ? "HAS_PROPERTY" : "HAS_FIELD";
  const targets = declarationTargetNodes(node);

  targets.forEach((target) => {
    const label = compactLabel(target.text, 80);
    if (!label) return;

    const detailNode = addRichNode(ctx, {
      type: detailType,
      label,
      astNode: node,
      rangeNode: target,
      ownerId,
      properties: declarationProperties(node),
    });

    addRichEdge(ctx, {
      source: ownerId,
      target: detailNode.id,
      relationshipType,
      astNode: node,
    });

    addTypedAnnotation(ctx, detailNode.id, typeAnnotation(node, target), "TYPE_OF", detailType);
    extractAnnotations(ctx, detailNode.id, node);
  });
}

function extractVariableDeclaration(
  ctx: RichExtractionContext,
  node: SyntaxNode,
): void {
  if (hasChildDeclarationSpec(node)) return;

  const ownerId = ctx.currentScopeId || ctx.fileNodeId;
  const currentOwnerType = ownerType(ctx);
  const targets = declarationTargetNodes(node);
  if (targets.length === 0) return;

  targets.forEach((target) => {
    const label = compactLabel(target.text, 80);
    if (!label) return;

    const detailType = variableNodeType(node, label, ownerId, ctx.fileNodeId, currentOwnerType);
    const detailNode = addRichNode(ctx, {
      type: detailType,
      label,
      astNode: node,
      rangeNode: target,
      ownerId,
      properties: declarationProperties(node),
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

    addTypedAnnotation(ctx, detailNode.id, typeAnnotation(node, target), "TYPE_OF", detailType);
  });
}

function extractImport(ctx: RichExtractionContext, node: SyntaxNode): void {
  if (node.type === "import_declaration" && node.namedChildren.some((child) => child.type === "import_spec")) {
    return;
  }

  const sourceNode = importSourceNode(node);
  const label = sourceNode
    ? normalizeImportLabel(sourceNode.text)
    : compactLabel(node.text, 120);
  if (!label) return;

  const importNode = addRichNode(ctx, {
    type: "Import",
    label,
    astNode: node,
    rangeNode: sourceNode ?? node,
    ownerId: ctx.fileNodeId,
    properties: {
      importSource: label,
      importText: compactLabel(node.text, 180),
    },
  });

  addRichEdge(ctx, {
    source: ctx.fileNodeId,
    target: importNode.id,
    relationshipType: "IMPORTS",
    astNode: node,
  });
}

function extractNamespace(ctx: RichExtractionContext, node: SyntaxNode): void {
  const nameNode =
    node.childForFieldName("name") ??
    node.childForFieldName("path") ??
    firstDescendantOfType(node, QUALIFIED_NAME_TYPES);
  const label = nameNode ? compactLabel(nameNode.text, 100) : compactLabel(node.text, 100);
  if (!label) return;

  const type = node.type === "package_declaration" || node.type === "package_clause"
    ? "Package"
    : node.type === "mod_item"
      ? "Module"
      : "Namespace";
  const namespace = addRichNode(ctx, {
    type,
    label,
    astNode: node,
    rangeNode: nameNode ?? node,
    ownerId: ctx.fileNodeId,
  });

  addContainment(ctx, ctx.fileNodeId, namespace.id, node);
}

function extractTypeAlias(ctx: RichExtractionContext, node: SyntaxNode): void {
  const nameNode = aliasNameNode(node);
  if (!nameNode) return;

  const ownerId = ctx.currentScopeId || ctx.fileNodeId;
  const alias = addRichNode(ctx, {
    type: "TypeAlias",
    label: compactLabel(nameNode.text, 100),
    astNode: node,
    rangeNode: nameNode,
    ownerId,
    properties: declarationProperties(node),
  });
  addContainment(ctx, ownerId, alias.id, node);

  const target = aliasTargetNode(node, nameNode);
  const annotation = addTypedAnnotation(ctx, alias.id, target, "TYPE_OF", "type_alias");
  if (annotation) {
    addRichEdge(ctx, {
      source: alias.id,
      target: annotation.id,
      relationshipType: "ALIASES",
      astNode: target,
    });
  }
}

function extractEnum(ctx: RichExtractionContext, node: SyntaxNode): void {
  const nameNode =
    node.childForFieldName("name") ??
    firstNamedChildOfType(node, QUALIFIED_NAME_TYPES);
  const label = nameNode ? compactLabel(nameNode.text, 100) : compactLabel(node.text, 100);
  if (!label) return;

  const ownerId = ctx.currentScopeId || ctx.fileNodeId;
  const enumNode = addRichNode(ctx, {
    type: "Enum",
    label,
    astNode: node,
    rangeNode: nameNode ?? node,
    ownerId,
    properties: declarationProperties(node),
  });
  addContainment(ctx, ownerId, enumNode.id, node);

  enumMemberNodes(node).forEach((member, index) => {
    const memberName =
      member.childForFieldName("name") ??
      firstDescendantOfType(member, QUALIFIED_NAME_TYPES) ??
      member;
    const memberLabel = compactLabel(memberName.text, 80);
    if (!memberLabel || memberLabel === label) return;

    const enumMember = addRichNode(ctx, {
      type: "EnumMember",
      label: memberLabel,
      astNode: member,
      rangeNode: memberName,
      ownerId: enumNode.id,
      properties: { index },
    });
    addContainment(ctx, enumNode.id, enumMember.id, member);
  });
}

function extractAnnotations(
  ctx: RichExtractionContext,
  ownerId: string,
  node: SyntaxNode,
): void {
  annotationNodes(node).forEach((annotation) => {
    const label = compactLabel(cleanAnnotationText(annotation.text), 100);
    if (!label) return;

    const decoratorNode = addRichNode(ctx, {
      type: "Decorator",
      label,
      astNode: annotation,
      ownerId,
    });
    addRichEdge(ctx, {
      source: ownerId,
      target: decoratorNode.id,
      relationshipType: "ANNOTATED_BY",
      astNode: annotation,
    });
  });
}

function parameterContainers(node: SyntaxNode): SyntaxNode[] {
  const containers = new Set<SyntaxNode>();
  const field = node.childForFieldName("parameters");
  if (field) containers.add(field);
  node.namedChildren
    .filter((child) => PARAMETER_CONTAINER_TYPES.includes(child.type as never))
    .forEach((child) => containers.add(child));
  return Array.from(containers);
}

function parameterNodes(container: SyntaxNode): SyntaxNode[] {
  const direct = container.namedChildren.filter((child) =>
    PARAMETER_TYPES.includes(child.type as never),
  );
  if (direct.length > 0) return direct;
  return container.namedChildren.filter((child) => child.type !== "comment");
}

function parameterNameNodes(param: SyntaxNode): SyntaxNode[] {
  if (param.type === "self_parameter") return [param];
  return uniqueNodes(collectNameNodes(nameCarrier(param)));
}

function parameterLabel(nameNode: SyntaxNode, param: SyntaxNode, index: number): string {
  if (param.type === "self_parameter") return "self";
  const label = compactLabel(nameNode.text, 80);
  return label || `param${index}`;
}

function declarationTargetNodes(node: SyntaxNode): SyntaxNode[] {
  const explicit = node.childForFieldName("name");
  if (explicit) return uniqueNodes(collectNameNodes(explicit));

  const declarator = node.childForFieldName("declarator");
  if (declarator) return uniqueNodes(collectNameNodes(declarator));

  const left = node.childForFieldName("left");
  if (left) return uniqueNodes(collectNameNodes(left));

  const declarators = node.namedChildren.filter((child) =>
    child.type.includes("declarator") ||
    child.type === "field_identifier" ||
    child.type === "property_identifier",
  );
  if (declarators.length > 0) {
    return uniqueNodes(declarators.flatMap((child) => collectNameNodes(child)));
  }

  const specs = node.namedChildren.filter((child) =>
    ["var_spec", "const_spec", "field_declaration"].includes(child.type),
  );
  if (specs.length > 0) {
    return uniqueNodes(specs.flatMap((child) => declarationTargetNodes(child)));
  }

  return uniqueNodes(
    node.namedChildren.filter((child) => NAME_TYPES.includes(child.type as never)),
  );
}

function collectNameNodes(node: SyntaxNode | undefined | null): SyntaxNode[] {
  if (!node) return [];
  if (NAME_TYPES.includes(node.type as never)) return [node];

  const fieldName = node.childForFieldName("name");
  if (fieldName && fieldName !== node) return collectNameNodes(fieldName);

  const declarator = node.childForFieldName("declarator");
  if (declarator && declarator !== node) return collectNameNodes(declarator);

  const direct = node.namedChildren.filter((child) => NAME_TYPES.includes(child.type as never));
  if (direct.length > 0) return direct;

  return node.descendantsOfType(Array.from(NAME_TYPES));
}

function nameCarrier(node: SyntaxNode): SyntaxNode {
  return (
    node.childForFieldName("name") ??
    node.childForFieldName("pattern") ??
    node.childForFieldName("declarator") ??
    node
  );
}

function returnAnnotation(node: SyntaxNode): SyntaxNode | undefined {
  if (node.type === "constructor_declaration") return undefined;
  const params = parameterContainers(node)[0];
  const direct =
    node.childForFieldName("return_type") ??
    node.childForFieldName("result") ??
    node.childForFieldName("type");
  if (direct && (!params || direct.startIndex >= params.endIndex || direct.endIndex <= params.startIndex)) {
    return direct;
  }

  return node.namedChildren.find((child) =>
    isTypeLike(child) && (!params || child.startIndex > params.endIndex),
  );
}

function typeAnnotation(node: SyntaxNode, nameNode?: SyntaxNode): SyntaxNode | undefined {
  const direct = node.childForFieldName("type") ?? node.childForFieldName("value_type");
  if (direct && direct !== nameNode) return direct;

  return node.namedChildren.find((child) =>
    child !== nameNode &&
    isTypeLike(child) &&
    (!nameNode || child.startIndex < nameNode.startIndex || child.startIndex > nameNode.endIndex),
  );
}

function aliasNameNode(node: SyntaxNode): SyntaxNode | undefined {
  return (
    node.childForFieldName("name") ??
    firstNamedChildOfType(node, QUALIFIED_NAME_TYPES) ??
    declarationTargetNodes(node)[0]
  );
}

function aliasTargetNode(node: SyntaxNode, nameNode: SyntaxNode): SyntaxNode | undefined {
  const direct =
    node.childForFieldName("value") ??
    node.childForFieldName("type") ??
    node.childForFieldName("underlying_type");
  if (direct && direct !== nameNode) return direct;

  return node.namedChildren.find((child) =>
    child !== nameNode && isTypeLike(child) && child.startIndex > nameNode.endIndex,
  );
}

function importSourceNode(node: SyntaxNode): SyntaxNode | undefined {
  return (
    node.childForFieldName("source") ??
    node.childForFieldName("path") ??
    node.childForFieldName("name") ??
    firstDescendantOfType(node, STRING_SOURCE_TYPES) ??
    firstDescendantOfType(node, QUALIFIED_NAME_TYPES)
  );
}

function enumMemberNodes(node: SyntaxNode): SyntaxNode[] {
  return uniqueNodes(node.descendantsOfType(Array.from(ENUM_MEMBER_TYPES)));
}

function annotationNodes(node: SyntaxNode): SyntaxNode[] {
  const own = node.children.filter((child) => ANNOTATION_TYPES.has(child.type));
  const parent = node.parent;
  if (!parent) return own;

  const siblings = parent.children;
  const index = siblings.indexOf(node);
  if (index <= 0) return own;

  const preceding = siblings
    .slice(Math.max(0, index - 4), index)
    .filter((sibling) => ANNOTATION_TYPES.has(sibling.type));
  return uniqueNodes([...preceding, ...own]);
}

function isTypeLike(node: SyntaxNode): boolean {
  return TYPE_HINT_TYPES.has(node.type) ||
    node.type.endsWith("_type") ||
    node.type.includes("type_identifier");
}

function variableNodeType(
  node: SyntaxNode,
  label: string,
  ownerId: string,
  fileNodeId: string,
  currentOwnerType: string | undefined,
): "Variable" | "Local" | "Constant" | "Field" {
  if (currentOwnerType === "Class" || currentOwnerType === "Interface") return "Field";
  if (isConstantDeclaration(node) || isUppercaseName(label)) return "Constant";
  return ownerId === fileNodeId ? "Variable" : "Local";
}

function isConstantDeclaration(node: SyntaxNode): boolean {
  return node.type.includes("const") || /\b(const|constexpr|static final)\b/.test(node.text);
}

function declarationProperties(node: SyntaxNode): Record<string, unknown> {
  return {
    declarationKind: node.type,
    exported: hasExportVisibility(node),
    static: /\bstatic\b/.test(node.text),
    readonly: /\b(readonly|final|const)\b/.test(node.text),
    visibility: visibility(node),
  };
}

function visibility(node: SyntaxNode): string | undefined {
  const text = node.text;
  if (/\bpublic\b/.test(text)) return "public";
  if (/\bprivate\b/.test(text)) return "private";
  if (/\bprotected\b/.test(text)) return "protected";
  if (/\bpub\b/.test(text)) return "public";
  return undefined;
}

function hasExportVisibility(node: SyntaxNode): boolean {
  return /\b(public|export|pub)\b/.test(node.text) ||
    hasAncestorType(node, ["export_statement", "export_default_declaration"], 4);
}

function hasChildDeclarationSpec(node: SyntaxNode): boolean {
  return node.namedChildren.some((child) =>
    ["var_spec", "const_spec"].includes(child.type),
  );
}

function isEnumLikeTypeSpec(node: SyntaxNode): boolean {
  return node.namedChildren.some((child) => ENUM_TYPES.has(child.type));
}

function isOptional(node: SyntaxNode): boolean {
  return /\?|=/.test(node.text);
}

function isVariadic(node: SyntaxNode): boolean {
  return node.type.includes("variadic") || /(^|\s)(\.\.\.|\*)/.test(node.text);
}

function normalizeImportLabel(value: string): string {
  return compactLabel(unquote(value).replace(/^</, "").replace(/>$/, ""), 140);
}

function cleanAnnotationText(value: string): string {
  return cleanTypeText(
    value
      .replace(/^@/, "")
      .replace(/^#\[/, "")
      .replace(/\]$/, ""),
  );
}

function uniqueNodes(nodes: SyntaxNode[]): SyntaxNode[] {
  const seen = new Set<string>();
  const result: SyntaxNode[] = [];
  nodes.forEach((node) => {
    const key = `${node.type}:${node.startIndex}:${node.endIndex}`;
    if (seen.has(key)) return;
    seen.add(key);
    result.push(node);
  });
  return result;
}