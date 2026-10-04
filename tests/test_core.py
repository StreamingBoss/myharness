"""The agent loop is usable without importing Flask or mounting HTTP routes."""

import importlib
import json
import sys
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tests" / "python_reference"))
import core


class FakeHost:
    max_steps = 2

    def __init__(self):
        self.events = []
        self.memory = []

    def stopped(self): return False
    def model(self): return "fake"
    def context_length(self): return 100
    def last_prompt_tokens(self): return 0
    def set_last_prompt_tokens(self, value): self.tokens = value
    def memory_text(self): return str(self.memory)
    def system_messages(self, setup, with_skills): return [{"role": "system", "content": setup["prompt"]}]
    def estimate_tokens(self, system, conversation, tools): return 1
    def trim_context(self, system, conversation, tools): return None
    def compact_context(self, conversation): return iter(())
    def stream_chat(self, payload):
        yield json.dumps({"message": {"role": "assistant", "content": "done"}, "done": True,
                          "prompt_eval_count": 3, "eval_count": 2})
    def split_json(self, shown, highlighted): return [json.dumps(shown), json.dumps(highlighted), ""]
    def skill_context(self, context): return {}
    def run_tool(self, name, arguments, enabled): raise AssertionError("no tool call expected")
    def apply_change(self, name, result): raise AssertionError("no change expected")
    def execute_command(self, command): raise AssertionError("no command expected")
    def record_event(self, event): self.events.append(event)


class CoreWithoutFlask(unittest.TestCase):
    def test_import_and_complete_turn_without_flask(self):
        sys.modules.pop("flask", None)
        reloaded = importlib.reload(core)
        self.assertNotIn("flask", sys.modules)
        host = FakeHost()
        message = {"role": "user", "content": "hello"}
        host.memory.append(message)
        events = list(reloaded.HarnessCore(host).run_turn(reloaded.Turn(
            user_message=message, conversation=host.memory, setup={"agent": "", "prompt": "rules"},
            enabled_tools=[], selected_tools=[], use_memory=True,
        )))
        self.assertEqual([event["type"] for event in events], ["request", "response"])
        self.assertEqual(host.tokens, 3)
        self.assertEqual(host.memory[-1]["content"], "done")


if __name__ == "__main__":
    unittest.main()
