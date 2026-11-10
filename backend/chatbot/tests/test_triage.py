from chatbot.agent.state import LayeredWindow
from chatbot.agent.triage import TriageEngine
from chatbot.history.protocol import HistoryHealth


class EmptyHistory:
    def get_window(self, user_id: str, session_id: str) -> LayeredWindow:
        return LayeredWindow()

    def append_turn(self, user_id, session_id, role, content, metadata=None) -> None:
        return None

    def find_cache_hit(self, user_id, session_id, normalized_user_text):
        return None

    def update_summary(self, user_id, session_id, summary, metadata=None) -> None:
        return None

    def pin_fact(self, user_id, session_id, fact, metadata=None) -> None:
        return None

    def delete_session(self, user_id, session_id) -> None:
        return None

    def health(self) -> HistoryHealth:
        return HistoryHealth(backend="empty")


class CachedHistory(EmptyHistory):
    def find_cache_hit(self, user_id, session_id, normalized_user_text):
        return "old cached answer"


def test_explicit_smalltalk_still_uses_fast_path() -> None:
    decision = TriageEngine(EmptyHistory()).decide("u1", "s1", "hi")

    assert decision.triage_class == "smalltalk"
    assert decision.path == "fast"


def test_short_non_smalltalk_defaults_to_full_path() -> None:
    decision = TriageEngine(EmptyHistory()).decide("u1", "s1", "auth flow")

    assert decision.triage_class == "task"
    assert decision.path == "full"
    assert decision.reason == "task cue"


def test_project_question_bypasses_cache_for_current_graph() -> None:
    decision = TriageEngine(CachedHistory()).decide(
        "u1",
        "s1",
        "Where is AuthService used in this project?",
    )

    assert decision.triage_class == "task"
    assert decision.path == "full"
    assert decision.cached_answer is None
    assert decision.reason == "task cue"


def test_non_project_repeat_can_still_use_cache() -> None:
    decision = TriageEngine(CachedHistory()).decide("u1", "s1", "hello again")

    assert decision.triage_class == "cache_hit"
    assert decision.path == "fast"
    assert decision.cached_answer == "old cached answer"
