import unittest

from chatbot.agent.service import _fast_path_turn_telemetry, _full_path_turn_telemetry
from chatbot.agent.state import AgentState, Plan, PlanStep, StepArtifact, TriageDecision
from chatbot.config.settings import Settings


class ServiceTelemetryTests(unittest.TestCase):
    def test_full_path_telemetry_exposes_graph_and_tool_digest(self) -> None:
        state = AgentState(
            user_id="u1",
            session_id="s1",
            user_text="explain me the remove_all function",
            triage_class="task",
            path="full",
            plan=Plan(
                steps=[
                    PlanStep(
                        id="step-codegraph",
                        action="query_codegraph",
                        instruction="explain me the remove_all function",
                        metadata={"retrieval_profile": "focused"},
                    ),
                    PlanStep(
                        id="step-reason",
                        action="reason",
                        instruction="Explain the function from retrieved evidence.",
                        depends_on=["step-codegraph"],
                    ),
                ],
                metadata={"parse_outcome": "ok", "codegraph_guard_applied": True},
            ),
            scratchpad=[
                StepArtifact(
                    step_id="step-codegraph",
                    action="query_codegraph",
                    output="remove_all deletes all items from the collection.",
                    metadata={"tool": "codegraph", "available": True, "status": "ok"},
                )
            ],
            response_md="`remove_all` removes every tracked item.",
            done=True,
            critique_complete=True,
            critique_confidence=0.91,
            telemetry_events=[
                {
                    "kind": "graph_node",
                    "node_id": "planner",
                    "component": "planner",
                    "message": "Planner produced executable steps.",
                    "outcome": "ok",
                },
                {
                    "kind": "subagent_call",
                    "node_id": "planner",
                    "subagent_id": "planner",
                    "message": "Planner LLM call completed.",
                    "status": "success",
                    "token_count": 17,
                },
                {
                    "kind": "tool_call",
                    "node_id": "executor",
                    "tool_id": "codegraph",
                    "message": "CodeGraph tool call completed.",
                    "input_preview": "remove_all",
                    "output_preview": "remove_all definition",
                    "status": "ok",
                    "available": True,
                },
            ],
        )
        decision = TriageDecision(triage_class="task", path="full", reason="default")

        telemetry = _full_path_turn_telemetry(state, decision, settings=Settings())

        self.assertEqual(telemetry["extra"]["graph_mode"], "langgraph")
        self.assertEqual(telemetry["extra"]["tool_calls_count"], 1)
        self.assertEqual(telemetry["extra"]["tool_call_names"], ["codegraph"])
        self.assertEqual(telemetry["extra"]["subagent_call_names"], ["planner"])
        self.assertEqual(telemetry["extra"]["component_definitions"][0]["component_id"], "orchestrator")
        self.assertEqual(telemetry["quality_signals"]["tool_calls_count"], 1)
        self.assertEqual(telemetry["quality_signals"]["subagent_calls_count"], 1)
        self.assertEqual(telemetry["observability"]["graph_trace"][0]["node"], "planner")
        self.assertEqual(telemetry["observability"]["decision_events"][0]["type"], "triage")
        self.assertIs(telemetry["quality_signals"]["used_codegraph"], True)
        self.assertIs(telemetry["quality_signals"]["requires_codegraph"], True)
        self.assertEqual(telemetry["turn_metrics"]["task_completion_rate"]["score"], 0.85)

    def test_fast_path_telemetry_is_still_judge_readable(self) -> None:
        decision = TriageDecision(triage_class="meta", path="fast", reason="smalltalk_or_meta")

        telemetry = _fast_path_turn_telemetry(
            "what can you do",
            "I can answer questions about this codebase.",
            decision,
            settings=Settings(),
        )

        self.assertEqual(telemetry["extra"]["graph_mode"], "fast_path")
        self.assertEqual(telemetry["extra"]["component_route"], ["fast_path", "final-answer"])
        self.assertEqual(telemetry["extra"]["subagent_calls_count"], 1)
        self.assertEqual(telemetry["observability"]["decision_events"][0]["decision"], "fast")
        self.assertEqual(telemetry["quality_signals"]["triage_class"], "meta")
        self.assertEqual(telemetry["quality_signals"]["subagent_call_names"], ["fast_path"])
        self.assertEqual(telemetry["quality_signals"]["tool_calls_count"], 0)
        self.assertIs(telemetry["quality_signals"]["has_final_output"], True)


if __name__ == "__main__":
    unittest.main()
