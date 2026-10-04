"""Run portable harness scenarios through the current HTTP/NDJSON contract.

The JSON files deliberately contain no Python function names or mock details so
the future TypeScript host can execute the same cases.
"""

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tests" / "python_reference"))
import app as harness


class DenyImmediately:
    def wait(self, timeout):
        return False

    def set(self):
        pass


class ContractScenarios(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.saved = {
            "workspace": harness.workspace,
            "sessions": harness.SESSIONS_DIR,
            "settings": harness.SETTINGS_FILE,
            "active": harness.active_session,
            "active_id": harness.active_session_id,
            "messages": harness.messages,
            "setup": harness.conversation_setup,
            "tokens": harness.last_prompt_tokens,
        }
        harness.workspace = self.root / "workspace"
        harness.workspace.mkdir()
        harness.SESSIONS_DIR = self.root / "sessions"
        harness.SETTINGS_FILE = self.root / "settings.json"
        harness.active_session = {}
        harness.active_session_id = ""
        harness.messages = []
        harness.conversation_setup = {"agent": "", "prompt": ""}
        harness.last_prompt_tokens = 0
        harness.context_length = 3000
        harness.pending_approvals.clear()
        harness.stop_requested.clear()
        self.client = harness.app.test_client()

    def tearDown(self):
        harness.workspace = self.saved["workspace"]
        harness.SESSIONS_DIR = self.saved["sessions"]
        harness.SETTINGS_FILE = self.saved["settings"]
        harness.active_session = self.saved["active"]
        harness.active_session_id = self.saved["active_id"]
        harness.messages = self.saved["messages"]
        harness.conversation_setup = self.saved["setup"]
        harness.last_prompt_tokens = self.saved["tokens"]
        harness.pending_approvals.clear()
        harness.stop_requested.clear()
        self.temp.cleanup()

    def test_scenarios(self):
        scenario_dir = Path(__file__).with_name("scenarios")
        for file in sorted(scenario_dir.glob("*.json")):
            with self.subTest(file=file.name):
                harness.workspace = self.root / file.stem
                harness.workspace.mkdir()
                self.run_scenario(json.loads(file.read_text()))

    def run_scenario(self, scenario):
        harness.messages.clear()
        harness.conversation_setup = {"agent": "", "prompt": ""}
        harness.last_prompt_tokens = 0
        harness.stop_requested.clear()
        turns = iter(scenario["model_turns"])

        def stream_chat(_payload):
            for chunk in next(turns):
                yield json.dumps(chunk)

        approval = scenario.get("approval")
        for name, content in scenario.get('files', {}).items():
            target = harness.workspace / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content)
        class Answer:
            def wait(self, timeout):
                for pending in harness.pending_approvals.values():
                    pending['approved'] = approval == 'approve'
                if approval == 'stop':
                    harness.stop_requested.set()
            def set(self):
                pass
        patches = [patch.object(harness, "stream_chat", side_effect=stream_chat)]
        if approval:
            patches.append(patch.object(harness.threading, "Event", Answer))
        with patches[0]:
            if len(patches) == 2:
                with patches[1]:
                    response = self.client.post("/chat", json=scenario["request"])
                    body = response.data
            else:
                response = self.client.post("/chat", json=scenario["request"])
                body = response.data
        self.assertEqual(response.status_code, 200)
        events = [json.loads(line) for line in body.splitlines()]
        expected = scenario["expect"]
        self.assertEqual([event["type"] for event in events], expected["event_types"])
        self.assertEqual([message["role"] for message in harness.messages], expected["memory_roles"])
        if "last_content" in expected:
            self.assertEqual(harness.messages[-1]["content"] if harness.messages else scenario["request"]["message"], expected["last_content"])
        for relative in expected.get("absent_files", []):
            self.assertFalse((harness.workspace / relative).exists())
        for relative, content in expected.get('files', {}).items():
            self.assertEqual((harness.workspace / relative).read_text(), content)


if __name__ == "__main__":
    unittest.main()
