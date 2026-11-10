"""Profile-aware CodeGraph retrieval configuration and helpers."""

from __future__ import annotations

from typing import Any


DEFAULT_PROFILE = "focused"
VALID_PROFILES = {"focused", "workflow", "architecture", "compare"}

PROFILE_LIMITS = {
    "focused": {
        "candidate_percent": 0.01,
        "candidate_min": 40,
        "candidate_max": 200,
        "final_percent": 0.002,
        "final_min": 5,
        "final_max": 20,
        "max_neighbors": 8,
    },
    "workflow": {
        "candidate_percent": 0.02,
        "candidate_min": 80,
        "candidate_max": 400,
        "final_percent": 0.005,
        "final_min": 15,
        "final_max": 80,
        "max_neighbors": 12,
    },
    "architecture": {
        "candidate_percent": 0.05,
        "candidate_min": 150,
        "candidate_max": 800,
        "final_percent": 0.02,
        "final_min": 30,
        "final_max": 150,
        "max_neighbors": 10,
    },
    "compare": {
        "candidate_percent": 0.02,
        "candidate_min": 80,
        "candidate_max": 400,
        "final_percent": 0.005,
        "final_min": 12,
        "final_max": 60,
        "max_neighbors": 10,
    },
}

PROFILE_NODE_FILTERS = {
    "focused": [
        "Function",
        "Method",
        "Class",
        "Interface",
        "File",
        "Symbol",
        "Definition",
        "Declaration",
        "Reference",
        "Route",
        "Endpoint",
    ],
    "workflow": [
        "Endpoint",
        "Route",
        "Controller",
        "Service",
        "Repository",
        "Function",
        "Method",
        "Class",
        "CallExpression",
        "ReactComponent",
        "AngularComponent",
        "AngularService",
        "EventHandler",
        "ORMModel",
        "DatabaseTable",
        "MessageTopic",
    ],
    "architecture": [
        "Folder",
        "File",
        "Package",
        "Module",
        "Namespace",
        "Dependency",
        "ConfigFile",
        "Controller",
        "Service",
        "Repository",
        "ReactComponent",
        "AngularComponent",
        "AngularService",
        "FrameworkModule",
        "Endpoint",
        "Route",
        "ORMModel",
        "DatabaseTable",
        "MessageTopic",
    ],
    "compare": [
        "Function",
        "Method",
        "Class",
        "Interface",
        "File",
        "Route",
        "Endpoint",
        "Controller",
        "Service",
        "Repository",
        "ReactComponent",
        "AngularComponent",
    ],
}

PROFILE_RELATIONSHIP_FILTERS = {
    "focused": [
        "CONTAINS",
        "DEFINES",
        "DECLARES",
        "HAS_OCCURRENCE",
        "REFERS_TO",
        "RESOLVES_TO",
        "REF_CALL",
        "CALLS",
        "IMPORTS_FROM",
        "HAS_PARAM",
        "HAS_FIELD",
        "HAS_PROPERTY",
        "TYPE_OF",
        "RETURNS",
        "DOCUMENTS",
        "ANNOTATED_BY",
    ],
    "workflow": [
        "ROUTES_TO",
        "HANDLES",
        "CALLS",
        "REF_CALL",
        "CALL_SITE_OF",
        "HAS_ARGUMENT",
        "ARGUMENT_FLOWS_TO_PARAMETER",
        "RECEIVER_OF",
        "RETURN_FLOWS_TO_CALLER",
        "CALLS_SERVICE",
        "QUERIES_TABLE",
        "USES_MODEL",
        "EMITS_EVENT",
        "SUBSCRIBES_TO",
        "RENDERS",
        "USES_HOOK",
        "UPDATES_STATE",
        "BINDS_TEMPLATE",
        "CFG_NEXT",
        "BRANCH_TRUE",
        "BRANCH_FALSE",
        "LOOP_BACK",
        "EXCEPTION_FLOW",
        "RETURNS_TO",
        "READS",
        "WRITES",
        "ASSIGNS",
        "USES_VALUE",
        "DEFINES_VALUE",
        "REACHING_DEF",
        "FLOWS_TO",
        "FIELD_READ",
        "FIELD_WRITE",
    ],
    "architecture": [
        "CONTAINS",
        "IMPORTS_FROM",
        "IMPORTS",
        "EXPORTS",
        "REEXPORTS",
        "DEPENDS_ON",
        "USED_BY",
        "EXTENDS",
        "IMPLEMENTS",
        "INSTANTIATES",
        "ROUTES_TO",
        "HANDLES",
        "CALLS_SERVICE",
        "QUERIES_TABLE",
        "USES_MODEL",
        "AFFECTS",
        "IMPACT_PATH",
        "CHANGES_PUBLIC_API",
        "RENDERS",
        "BINDS_TEMPLATE",
    ],
    "compare": [
        "CONTAINS",
        "CALLS",
        "IMPORTS_FROM",
        "EXTENDS",
        "IMPLEMENTS",
        "OVERRIDES",
        "CALLS_OVERRIDE",
        "HAS_PARAM",
        "HAS_FIELD",
        "HAS_PROPERTY",
        "TYPE_OF",
        "RETURNS",
        "DOCUMENTS",
        "ANNOTATED_BY",
        "ROUTES_TO",
        "HANDLES",
        "CALLS_SERVICE",
        "QUERIES_TABLE",
    ],
}

RELATIONSHIP_DEPENDENCIES = {
    "DEFINES": ["HAS_OCCURRENCE"],
    "DECLARES": ["HAS_OCCURRENCE"],
    "REFERS_TO": ["HAS_OCCURRENCE", "RESOLVES_TO"],
    "REF_CALL": ["REFERS_TO", "RESOLVES_TO", "HAS_OCCURRENCE"],
    "CALL_SITE_OF": ["CALLS", "REF_CALL"],
    "HAS_ARGUMENT": ["CALL_SITE_OF"],
    "ARGUMENT_FLOWS_TO_PARAMETER": ["CALL_SITE_OF", "HAS_ARGUMENT"],
    "RETURN_FLOWS_TO_CALLER": ["CALL_SITE_OF"],
    "RECEIVER_OF": ["CALL_SITE_OF"],
    "CFG_NEXT": ["CONTAINS"],
    "BRANCH_TRUE": ["CONTAINS", "CFG_NEXT"],
    "BRANCH_FALSE": ["CONTAINS", "CFG_NEXT"],
    "LOOP_BACK": ["CONTAINS", "CFG_NEXT"],
    "EXCEPTION_FLOW": ["CONTAINS", "CFG_NEXT"],
    "READS": ["CONTAINS"],
    "WRITES": ["CONTAINS"],
    "ASSIGNS": ["WRITES"],
    "FLOWS_TO": ["READS", "WRITES", "REACHING_DEF"],
    "REACHING_DEF": ["READS", "WRITES"],
    "ROUTES_TO": ["CONTAINS", "HANDLES"],
    "HANDLES": ["CONTAINS"],
    "CALLS_SERVICE": ["CALLS"],
    "QUERIES_TABLE": ["USES_MODEL"],
}

NOISY_SEED_NODE_TYPES = {
    "Argument",
    "Receiver",
    "ReturnValue",
    "BasicBlock",
    "Value",
    "Assignment",
    "Expression",
}


def normalize_profile(value: Any) -> str:
    profile = str(value or DEFAULT_PROFILE).strip().lower()
    return profile if profile in VALID_PROFILES else DEFAULT_PROFILE


def profile_node_types(profile: str) -> list[str]:
    return list(PROFILE_NODE_FILTERS[normalize_profile(profile)])


def profile_relationship_types(profile: str) -> list[str]:
    return list(PROFILE_RELATIONSHIP_FILTERS[normalize_profile(profile)])


def parse_csv_filter(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, (list, tuple, set)):
        raw_values = value
    else:
        raw_values = str(value).split(",")
    cleaned = []
    seen = set()
    for item in raw_values:
        text = str(item or "").strip()
        if not text or text in seen:
            continue
        cleaned.append(text)
        seen.add(text)
    return cleaned


def expand_relationship_dependencies(relationships: list[str]) -> list[str]:
    expanded: list[str] = []
    seen: set[str] = set()
    stack = list(reversed(relationships))
    while stack:
        relationship = stack.pop()
        if relationship in seen:
            continue
        seen.add(relationship)
        expanded.append(relationship)
        for dependency in reversed(RELATIONSHIP_DEPENDENCIES.get(relationship, [])):
            if dependency not in seen:
                stack.append(dependency)
    return expanded


def csv_filter(values: list[str] | tuple[str, ...] | None) -> str | None:
    if not values:
        return None
    return ",".join(str(value) for value in values if str(value).strip())


def calculate_profile_limits(
    profile: str,
    total_nodes: int | None = None,
    *,
    requested_candidate_k: Any = None,
    requested_final_k: Any = None,
    requested_top_k: Any = None,
    requested_max_neighbors: Any = None,
) -> dict[str, int]:
    normalized = normalize_profile(profile)
    limits = PROFILE_LIMITS[normalized]
    total = max(0, int(total_nodes or 0))

    default_candidate = _percent_limit(
        total,
        float(limits["candidate_percent"]),
        int(limits["candidate_min"]),
        int(limits["candidate_max"]),
    )
    default_final = _percent_limit(
        total,
        float(limits["final_percent"]),
        int(limits["final_min"]),
        int(limits["final_max"]),
    )
    final_source = requested_final_k if requested_final_k is not None else requested_top_k
    final_k = _bounded_int(
        final_source,
        default_final,
        int(limits["final_min"]),
        int(limits["final_max"]),
    )
    candidate_k = _bounded_int(
        requested_candidate_k,
        max(default_candidate, final_k),
        max(final_k, int(limits["candidate_min"])),
        int(limits["candidate_max"]),
    )
    max_neighbors = _bounded_int(
        requested_max_neighbors,
        int(limits["max_neighbors"]),
        1,
        50,
    )
    return {
        "candidate_k": max(candidate_k, final_k),
        "final_k": final_k,
        "max_neighbors": max_neighbors,
    }


def build_profile_request(
    profile: str,
    *,
    total_nodes: int | None = None,
    requested_candidate_k: Any = None,
    requested_final_k: Any = None,
    requested_top_k: Any = None,
    requested_max_neighbors: Any = None,
    node_types: Any = None,
    relationship_types: Any = None,
) -> dict[str, Any]:
    normalized = normalize_profile(profile)
    limits = calculate_profile_limits(
        normalized,
        total_nodes,
        requested_candidate_k=requested_candidate_k,
        requested_final_k=requested_final_k,
        requested_top_k=requested_top_k,
        requested_max_neighbors=requested_max_neighbors,
    )
    selected_node_types = parse_csv_filter(node_types) or profile_node_types(normalized)
    selected_relationship_types = (
        parse_csv_filter(relationship_types) or profile_relationship_types(normalized)
    )
    expanded_relationship_types = expand_relationship_dependencies(
        selected_relationship_types
    )
    return {
        "profile": normalized,
        **limits,
        "node_types": selected_node_types,
        "relationship_types": selected_relationship_types,
        "expanded_relationship_types": expanded_relationship_types,
    }


def _percent_limit(
    total_nodes: int,
    percent: float,
    minimum: int,
    maximum: int,
) -> int:
    if total_nodes <= 0:
        return minimum
    return max(minimum, min(int(round(total_nodes * percent)), maximum))


def _bounded_int(value: Any, default: int, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = default
    return max(minimum, min(parsed, maximum))
