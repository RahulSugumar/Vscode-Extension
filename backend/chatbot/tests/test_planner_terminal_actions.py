import os
from chatbot.agent.composer import ComposerClient
from chatbot.agent.critic import CriticClient
from chatbot.agent.executor import ExecutorClient
from chatbot.agent.planner import (
    codegraph_query_for_request,
    ensure_codegraph_for_code_request,
    parse_plan_json,
    report_type_for_request,
    requires_codegraph,
    retrieval_profile_for_request,
)
from chatbot.agent.state import AgentState, LayeredWindow, Plan, PlanStep, StepArtifact, Turn
from chatbot.agent.tools.codegraph import CodeGraphTool, CodeGraphToolResult
from chatbot.config.settings import Settings
from graphrag_agent.services.retrieval_profiles import expand_relationship_dependencies


class FallbackComposerLLM:
    def stream(self, prompt_name: str, user_content: str, **kwargs):
        yield "I processed this through the cognition path using the available "
        yield "layered window and execution artifacts. CodeGraph evidence may be incomplete."


async def _failing_report_callback(**params: object) -> dict[str, object]:
    raise TypeError("report adapter broke")


class FallbackRecordingCodeGraph(CodeGraphTool):
    def __init__(self) -> None:
        super().__init__(settings=Settings(codegraph_enabled=True))
        self.retrieve_calls: list[dict[str, object]] = []

    def retrieve(
        self,
        query: str,
        top_k: int | None = None,
        max_neighbors: int | None = None,
        database: str | None = None,
        profile: str | None = None,
        candidate_k: int | None = None,
        final_k: int | None = None,
        node_types: str | None = None,
        relationship_types: str | None = None,
    ) -> CodeGraphToolResult:
        self.retrieve_calls.append(
            {
                "query": query,
                "database": database,
                "profile": profile,
                "candidate_k": candidate_k,
                "final_k": final_k,
                "max_neighbors": max_neighbors,
            }
        )
        return CodeGraphToolResult(
            output="fallback retrieval evidence for order_router",
            available=True,
            status="ok",
            metadata={"tool": "codegraph", "available": True},
        )


def test_codegraph_report_falls_back_to_retrieve_on_report_error() -> None:
    tool = FallbackRecordingCodeGraph()

    result = tool._graph_report_query(
        tool="codegraph_workflow_report",
        title="CodeGraph workflow report",
        callback=_failing_report_callback,
        params={
            "query": "order_router",
            "database": "neo4j",
            "seed_k": 20,
            "max_depth": 4,
            "limit": 80,
        },
    )

    assert result.available is True
    assert result.status == "fallback"
    assert "fallback retrieval evidence for order_router" in result.output
    assert result.metadata["tool"] == "codegraph_workflow_report_fallback"
    assert result.metadata["original_tool"] == "codegraph_workflow_report"
    assert result.metadata["fallback_tool"] == "codegraph"
    assert result.metadata["report_type"] == "workflow_relationship_report"
    assert result.metadata["exception_type"] == "TypeError"
    assert tool.retrieve_calls == [
        {
            "query": "order_router",
            "database": "neo4j",
            "profile": "workflow",
            "candidate_k": 20,
            "final_k": 80,
            "max_neighbors": 4,
        }
    ]


def test_composer_stream_replaces_generic_fallback_with_codegraph_artifact() -> None:
    os.environ.setdefault("ABKB_WORKFLOW_ID", "test-workflow")
    state = AgentState(
        user_id="u1",
        session_id="s1",
        user_text="Explain login flow relationships",
        triage_class="task",
        path="full",
        plan=Plan(
            steps=[
                PlanStep(
                    id="step-1",
                    action="query_codegraph",
                    instruction="Explain login flow relationships",
                )
            ]
        ),
        scratchpad=[
            StepArtifact(
                step_id="step-1",
                action="query_codegraph",
                output="CodeGraph workflow report:\nAll files involved:\n- auth_router.py",
                metadata={
                    "tool": "codegraph_workflow_report",
                    "available": True,
                    "report_type": "workflow_relationship_report",
                },
            )
        ],
    )

    answer = "".join(ComposerClient(llm=FallbackComposerLLM()).stream(state))

    assert "I processed this through the cognition path" not in answer
    assert "The final answer LLM timed out" in answer
    assert "CodeGraph workflow report" in answer
    assert "auth_router.py" in answer

def test_parse_plan_accepts_llm_unrelated_rejection_action() -> None:
    plan = parse_plan_json(
        """
        {
          "steps": [
            {
              "id": "step-1",
              "action": "reject_unrelated",
              "instruction": "I can only help with this codebase or project.",
              "depends_on": []
            }
          ]
        }
        """
    )

    assert plan.steps[0].action == "reject_unrelated"


def test_leetcode_does_not_match_code_retrieval_hint() -> None:
    assert requires_codegraph("explain any leetcode question") is False


def test_codegraph_guard_preserves_single_unrelated_rejection() -> None:
    plan = ensure_codegraph_for_code_request(
        Plan(
            steps=[
                PlanStep(
                    id="step-1",
                    action="reject_unrelated",
                    instruction=(
                        "I can't help with that. If you have questions about your "
                        "codebase or need help related to this project, let me know."
                    ),
                )
            ]
        ),
        "explain any leetcode question",
    )

    assert [step.action for step in plan.steps] == ["reject_unrelated"]
    assert plan.metadata["terminal_rejection_preserved"] is True


def test_executor_uses_planner_instruction_for_terminal_actions() -> None:
    state = AgentState(
        user_id="u1",
        session_id="s1",
        user_text="What is the weather of Delhi today?",
        triage_class="task",
        path="full",
        plan=Plan(
            steps=[
                PlanStep(
                    id="step-1",
                    action="reject_unrelated",
                    instruction="I cannot answer weather questions in this codebase assistant.",
                )
            ]
        ),
    )

    result = ExecutorClient().execute(state)

    assert result.done is True
    assert result.response_md == "I cannot answer weather questions in this codebase assistant."
    assert result.scratchpad[0].output == result.response_md


def test_implementation_question_without_project_word_uses_codegraph() -> None:
    plan = ensure_codegraph_for_code_request(
        Plan(
            steps=[
                PlanStep(
                    id="step-1",
                    action="reason",
                    instruction="Answer from available context.",
                )
            ]
        ),
        "Tell me How Leaderboard is created",
    )

    assert plan.steps[0].action == "query_codegraph"
    assert plan.steps[0].instruction == "Tell me How Leaderboard is created"
    assert plan.steps[1].depends_on == ["step-codegraph"]


def test_codebase_overview_replaces_mistaken_rejection_with_inventory() -> None:
    plan = ensure_codegraph_for_code_request(
        Plan(
            steps=[
                PlanStep(
                    id="step-1",
                    action="reject_unrelated",
                    instruction="I can only assist with specific questions related to the codebase.",
                )
            ]
        ),
        "Give me full explanation of codebase",
    )

    assert [step.action for step in plan.steps] == ["query_project_inventory", "summarize"]
    assert "Give me full explanation of codebase" in plan.steps[0].instruction
    assert plan.steps[1].depends_on == [plan.steps[0].id]


def test_follow_up_question_inherits_previous_codebase_topic() -> None:
    window = LayeredWindow(
        verbatim=[
            Turn(
                role="user",
                content="Tell me how leaderboard is created in this project",
            ),
            Turn(
                role="assistant",
                content="The leaderboard is created by ranking challenge users.",
            ),
            Turn(role="user", content="What things are needed to create it"),
        ]
    )

    query = codegraph_query_for_request(
        "What things are needed to create it",
        window=window,
    )
    plan = ensure_codegraph_for_code_request(
        Plan(
            steps=[
                PlanStep(
                    id="step-1",
                    action="ask_clarification",
                    instruction="What file, symbol, workflow, or behavior should I focus on?",
                )
            ]
        ),
        "What things are needed to create it",
        window=window,
    )

    assert query is not None
    assert "leaderboard is created in this project" in query
    assert plan.steps[0].action == "query_codegraph"
    assert plan.steps[0].instruction == query
    assert plan.steps[1].action == "reason"


def test_vague_follow_up_without_history_does_not_force_codegraph() -> None:
    query = codegraph_query_for_request("What things are needed to create it")

    assert query is None

class RecordingCodeGraph:
    def __init__(self) -> None:
        self.retrieve_calls = []
        self.report_calls = []
        self.inventory_calls = 0

    def query(self, query_text: str) -> CodeGraphToolResult:
        return self.retrieve(query_text)

    def retrieve(
        self,
        query: str,
        top_k: int | None = None,
        max_neighbors: int | None = None,
        database: str | None = None,
        profile: str | None = None,
        candidate_k: int | None = None,
        final_k: int | None = None,
        node_types: str | None = None,
        relationship_types: str | None = None,
    ) -> CodeGraphToolResult:
        self.retrieve_calls.append(
            {
                "query": query,
                "top_k": top_k,
                "max_neighbors": max_neighbors,
                "database": database,
                "profile": profile,
                "candidate_k": candidate_k,
                "final_k": final_k,
                "node_types": node_types,
                "relationship_types": relationship_types,
            }
        )
        return CodeGraphToolResult(
            output="recorded codegraph result",
            available=True,
            status="ok",
            metadata={"tool": "recording_codegraph", "available": True},
        )

    def workflow_report(
        self,
        query: str,
        database: str | None = None,
        seed_k: int | None = None,
        max_depth: int = 4,
        limit: int = 160,
    ) -> CodeGraphToolResult:
        self.report_calls.append(
            {
                "report_type": "workflow_relationship_report",
                "query": query,
                "database": database,
                "seed_k": seed_k,
                "max_depth": max_depth,
                "limit": limit,
            }
        )
        return CodeGraphToolResult(
            output="recorded workflow report",
            available=True,
            status="ok",
            metadata={
                "tool": "codegraph_workflow_report",
                "available": True,
                "report_type": "workflow_relationship_report",
            },
        )

    def architecture_report(
        self,
        query: str = "",
        database: str | None = None,
        max_files: int = 400,
        max_symbols: int = 3000,
        max_relationship_samples: int = 300,
    ) -> CodeGraphToolResult:
        self.report_calls.append(
            {
                "report_type": "architecture_report",
                "query": query,
                "database": database,
                "max_files": max_files,
                "max_symbols": max_symbols,
                "max_relationship_samples": max_relationship_samples,
            }
        )
        return CodeGraphToolResult(
            output="recorded architecture report",
            available=True,
            status="ok",
            metadata={
                "tool": "codegraph_architecture_report",
                "available": True,
                "report_type": "architecture_report",
            },
        )

    def focused_report(
        self,
        query: str,
        database: str | None = None,
        seed_k: int | None = None,
        limit: int = 120,
    ) -> CodeGraphToolResult:
        self.report_calls.append({"report_type": "focused_symbol_report", "query": query})
        return CodeGraphToolResult(
            output="recorded focused report",
            available=True,
            status="ok",
            metadata={"tool": "codegraph_focused_report", "available": True, "report_type": "focused_symbol_report"},
        )

    def compare_report(
        self,
        query: str,
        database: str | None = None,
        seed_k: int | None = None,
        max_depth: int = 3,
        limit: int = 120,
    ) -> CodeGraphToolResult:
        self.report_calls.append({"report_type": "compare_report", "query": query})
        return CodeGraphToolResult(
            output="recorded compare report",
            available=True,
            status="ok",
            metadata={"tool": "codegraph_compare_report", "available": True, "report_type": "compare_report"},
        )
    def project_inventory(self) -> CodeGraphToolResult:
        self.inventory_calls += 1
        return CodeGraphToolResult(
            output="recorded project inventory",
            available=True,
            status="ok",
            metadata={"tool": "codegraph_project_inventory", "available": True},
        )


def test_project_typo_overview_uses_inventory() -> None:
    plan = ensure_codegraph_for_code_request(
        Plan(
            steps=[
                PlanStep(
                    id="step-1",
                    action="reason",
                    instruction="Answer from available context.",
                )
            ]
        ),
        "Can you tell me what I have done in my projetc",
    )

    assert plan.steps[0].action == "query_project_inventory"
    assert plan.steps[1].action == "reason"
    assert plan.steps[1].depends_on == ["step-project-inventory"]


def test_focused_implementation_question_gets_workflow_profile() -> None:
    plan = ensure_codegraph_for_code_request(
        Plan(
            steps=[
                PlanStep(
                    id="step-1",
                    action="reason",
                    instruction="Answer from available context.",
                )
            ]
        ),
        "How is product creation implemented?",
    )

    assert plan.steps[0].action == "query_codegraph"
    assert plan.steps[0].metadata["retrieval_profile"] == "workflow"
    assert retrieval_profile_for_request("Compare ProductService and UserService") == "compare"


def test_project_relationship_question_prioritizes_current_graph() -> None:
    plan = ensure_codegraph_for_code_request(
        Plan(
            steps=[
                PlanStep(
                    id="step-1",
                    action="reason",
                    instruction="Answer from chat history.",
                )
            ]
        ),
        "Where is AuthService used by other services?",
    )

    assert plan.steps[0].action == "query_codegraph"
    assert plan.steps[0].metadata["source_priority"] == "current_graph"
    assert plan.steps[0].metadata["history_usage"] == "context_only"
    assert plan.steps[1].depends_on == ["step-codegraph"]
    assert plan.steps[1].metadata["source_priority"] == "current_graph"
    assert plan.metadata["source_priority"] == "current_graph"


def test_existing_graph_step_is_moved_before_reasoning_step() -> None:
    plan = ensure_codegraph_for_code_request(
        Plan(
            steps=[
                PlanStep(
                    id="step-1",
                    action="reason",
                    instruction="Answer from cached context.",
                ),
                PlanStep(
                    id="step-2",
                    action="query_codegraph",
                    instruction="Fetch project relationships.",
                ),
            ]
        ),
        "Where are AuthService dependencies used?",
    )

    assert [step.action for step in plan.steps] == ["query_codegraph", "reason"]
    assert plan.steps[0].id == "step-2"
    assert plan.steps[1].depends_on == ["step-2"]
    assert plan.steps[1].metadata["history_usage"] == "context_only"


def test_planner_marks_architecture_report_for_architecture_request() -> None:
    plan = ensure_codegraph_for_code_request(
        Plan(
            steps=[
                PlanStep(
                    id="step-1",
                    action="reason",
                    instruction="Answer from available context.",
                )
            ]
        ),
        "Give me the full project architecture",
    )

    assert plan.steps[0].action == "query_codegraph"
    assert plan.steps[0].metadata["retrieval_profile"] == "architecture"
    assert plan.steps[0].metadata["report_type"] == "architecture_report"
    assert report_type_for_request("Explain login flow relationships") == "workflow_relationship_report"


def test_executor_dispatches_workflow_report() -> None:
    codegraph = RecordingCodeGraph()
    state = AgentState(
        user_id="u1",
        session_id="s1",
        user_text="Explain login flow relationships",
        triage_class="task",
        path="full",
        plan=Plan(
            steps=[
                PlanStep(
                    id="step-1",
                    action="query_codegraph",
                    instruction="Explain login flow relationships",
                    metadata={
                        "retrieval_profile": "workflow",
                        "report_type": "workflow_relationship_report",
                        "report_limit": 90,
                    },
                )
            ]
        ),
    )

    result = ExecutorClient(codegraph=codegraph).execute(state)

    assert codegraph.retrieve_calls == []
    assert codegraph.report_calls[0]["report_type"] == "workflow_relationship_report"
    assert codegraph.report_calls[0]["limit"] == 90
    assert result.scratchpad[0].metadata["report_type"] == "workflow_relationship_report"
    assert result.scratchpad[0].metadata["tool"] == "codegraph_workflow_report"

def test_executor_builds_profile_aware_retrieval_request() -> None:
    codegraph = RecordingCodeGraph()
    state = AgentState(
        user_id="u1",
        session_id="s1",
        user_text="Explain module architecture",
        triage_class="task",
        path="full",
        plan=Plan(
            steps=[
                PlanStep(
                    id="step-1",
                    action="query_codegraph",
                    instruction="Explain module architecture",
                    metadata={
                        "retrieval_profile": "architecture",
                        "requested_top_k": 100,
                        "requested_max_neighbors": 1,
                    },
                )
            ]
        ),
    )

    result = ExecutorClient(codegraph=codegraph).execute(state)

    assert result.scratchpad[0].metadata["retrieval_profile"] == "architecture"
    assert result.scratchpad[0].metadata["top_k"] == 100
    assert result.scratchpad[0].metadata["candidate_k"] == 150
    assert result.scratchpad[0].metadata["max_neighbors"] == 1
    assert codegraph.retrieve_calls[0]["profile"] == "architecture"
    assert codegraph.retrieve_calls[0]["final_k"] == 100
    assert "Folder" in codegraph.retrieve_calls[0]["node_types"]
    assert "DEPENDS_ON" in codegraph.retrieve_calls[0]["relationship_types"]


def test_relationship_dependencies_expand_recursively() -> None:
    expanded = expand_relationship_dependencies(["FLOWS_TO"])

    assert "FLOWS_TO" in expanded
    assert "READS" in expanded
    assert "WRITES" in expanded
    assert "REACHING_DEF" in expanded
    assert "CONTAINS" in expanded


def test_executor_dispatches_project_inventory() -> None:
    codegraph = RecordingCodeGraph()
    state = AgentState(
        user_id="u1",
        session_id="s1",
        user_text="Give me full project overview",
        triage_class="task",
        path="full",
        plan=Plan(
            steps=[
                PlanStep(
                    id="step-1",
                    action="query_project_inventory",
                    instruction="Retrieve inventory.",
                )
            ]
        ),
    )

    result = ExecutorClient(codegraph=codegraph).execute(state)

    assert codegraph.inventory_calls == 1
    assert result.scratchpad[0].action == "query_project_inventory"
    assert result.scratchpad[0].metadata["tool"] == "codegraph_project_inventory"


def test_critic_requests_inventory_when_overview_only_has_semantic_evidence() -> None:
    state = AgentState(
        user_id="u1",
        session_id="s1",
        user_text="Give me full project overview",
        triage_class="task",
        path="full",
        plan=Plan(
            steps=[
                PlanStep(
                    id="step-1",
                    action="query_codegraph",
                    instruction="Give me full project overview",
                )
            ]
        ),
        scratchpad=[
            StepArtifact(
                step_id="step-1",
                action="query_codegraph",
                output="Only a few semantic matches.",
                metadata={"tool": "codegraph"},
            )
        ],
    )

    result = CriticClient().critique(state)

    assert result.critique_complete is False
    assert result.plan is not None
    assert result.plan.steps[-1].action == "query_project_inventory"
