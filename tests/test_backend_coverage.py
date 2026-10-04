import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "web"))
import app as harness


class BackendCoverage(unittest.TestCase):
    """Deterministic coverage of backend behavior and failure paths.

    Ollama, the real workspace, and the owner's saved sessions are never used.
    """

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
            "model": harness.MODEL,
            "context": harness.context_length,
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
        harness.context_length = 3000
        harness.last_prompt_tokens = 0
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
        harness.MODEL = self.saved["model"]
        harness.context_length = self.saved["context"]
        harness.last_prompt_tokens = self.saved["tokens"]
        harness.pending_approvals.clear()
        harness.stop_requested.clear()
        if harness.turn_lock.locked():
            harness.turn_lock.release()
        self.temp.cleanup()

    def write(self, path, text):
        target = harness.workspace / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)
        return target

    def chat(self, **changes):
        return {
            "message": "hello", "use_memory": True, "tools": [],
            "ask_approval": False, "agent": "", "prompt": "",
            **changes,
        }

    @staticmethod
    def events(response):
        return [json.loads(line) for line in response.data.splitlines()]

    @staticmethod
    def complete(content="ok", **extra):
        yield json.dumps({"message": {"role": "assistant", "content": content},
                          "done": True, "prompt_eval_count": 10, "eval_count": 2, **extra})

    def test_session_validation_titles_and_persistence_failures(self):
        data = harness.default_session("name")
        self.assertEqual(harness.validate_session(data), data)
        for bad in (None, {}, {**data, "version": 2}, {**data, "name": 7},
                    {**data, "model": 7}, {**data, "context_length": "x"}):
            with self.assertRaises(ValueError):
                harness.validate_session(bad)
        self.assertEqual(harness.session_title(" a\n  b "), "a b")
        self.assertEqual(harness.session_title("x" * 61), "x" * 60 + "…")
        data["events"] = []
        data["memory"] = [{"role": "user", "content": "from memory"}]
        self.assertEqual(harness.session_title_from_history(data), "from memory")
        data["events"] = [{"type": "chat_user", "content": "from event"}]
        self.assertEqual(harness.session_title_from_history(data), "from event")
        harness.save_active_session()
        harness.new_session("saved")
        saved = harness.session_path(harness.active_session_id)
        self.assertTrue(saved.exists())
        self.assertFalse(saved.with_suffix(".tmp").exists())
        event = {"type": "request", "nested": {"value": 1}}
        harness.record_event(event)
        event["nested"]["value"] = 2
        self.assertEqual(harness.active_session["events"][-1]["nested"]["value"], 1)

    def test_session_listing_restore_and_duplicate_file_handling(self):
        self.assertEqual(harness.list_sessions(), [])
        first = harness.new_session("same")
        second = harness.new_session("other")
        first_data = json.loads(harness.session_path(first["id"]).read_text())
        first_data["updated_at"] = "9999-01-01T00:00:00+00:00"
        harness.session_path(first["id"]).write_text(json.dumps(first_data))
        (harness.SESSIONS_DIR / "broken.json").write_text("not json")
        self.assertEqual(harness.list_sessions()[0]["id"], first["id"])
        self.assertEqual(harness.unique_session_name("same"), "same (2)")
        self.assertEqual(harness.unique_session_name("same", first["id"]), "same")
        harness.restore_latest_session()
        self.assertEqual(harness.active_session_id, first["id"])
        harness.SESSIONS_DIR = self.root / "empty-sessions"
        harness.restore_latest_session()
        self.assertTrue(harness.active_session_id)
        self.assertNotEqual(harness.active_session_id, second["id"])

    def test_session_recovery_and_workspace_loading_failures(self):
        data = harness.default_session()
        self.assertEqual(harness.session_title_from_history(data), "")
        with patch.object(harness, "list_sessions", return_value=[{"id": "missing"}]):
            harness.restore_latest_session()
        self.assertTrue(harness.active_session_id)
        harness.load_saved_workspace()

        fresh = self.root / "fresh"
        harness.SESSIONS_DIR = fresh
        self.assertEqual(harness.unique_session_name("plain"), "plain")
        harness.SESSIONS_DIR.mkdir()
        first = harness.default_session("plain")
        second = harness.default_session("plain (2)")
        harness.session_path(first["id"]).write_text(json.dumps(first))
        harness.session_path(second["id"]).write_text(json.dumps(second))
        self.assertEqual(harness.unique_session_name("plain"), "plain (3)")
        self.assertEqual(harness.session_title_from_history({"events": [{"type": "other"}], "memory": [{"role": "assistant"}]}), "")
        harness.SETTINGS_FILE.write_text(json.dumps({"project": str(harness.workspace)}))
        harness.load_saved_workspace()
        harness.SETTINGS_FILE.write_text(json.dumps({"project": str(self.root / "gone")}))
        harness.load_saved_workspace()

    def test_activation_refreshes_snapshots_and_repairs_only_missing_tools(self):
        self.write("AGENTS.md", "new rule")
        data = harness.default_session()
        data["settings"].update({"hide_thinking": True, "draft": "no"})
        data["snapshots"] = {"prompt": {"name": "", "text": ""}}
        data["project_instructions"] = ("AGENTS.md", "old rule")
        data["memory"] = [
            {"role": "assistant", "content": "", "tool_calls": [
                {"function": {"name": "done", "arguments": {}}},
                {"function": {"name": "missing", "arguments": {}}},
            ]},
            {"role": "tool", "tool_name": "done", "content": "ok"},
            {"role": "user", "content": "next"},
        ]
        harness.activate_session(data)
        self.assertNotIn("hide_thinking", harness.active_session["settings"])
        self.assertEqual(harness.messages[1]["tool_name"], "done")
        self.assertEqual(harness.messages[2]["tool_name"], "missing")
        self.assertIn("new rule", harness.active_session["project_instructions"][1])
        self.assertTrue(any(e["type"] == "stopped" for e in harness.active_session["events"]))
        missing = self.root / "gone"
        data = harness.default_session()
        data["workspace"] = str(missing)
        harness.activate_session(data)
        self.assertEqual(harness.workspace, missing)

    def test_activation_unchanged_instructions_does_not_record_refresh(self):
        self.write("AGENTS.md", "stable")
        data = harness.default_session()
        data["snapshots"] = {"prompt": {"name": "", "text": ""}}
        data["project_instructions"] = harness.load_project_instructions()
        harness.activate_session(data)
        self.assertFalse(any(event["type"] == "project_instructions" for event in harness.active_session["events"]))

    def test_workspace_and_file_tools_all_outcomes(self):
        self.assertIn("T", harness.get_current_time())
        self.assertEqual(harness.list_files(), "(empty folder)")
        self.write("dir/file.txt", "alpha\nbeta")
        self.assertEqual(harness.list_files(), "dir/")
        absolute = str((harness.workspace / "dir/file.txt").resolve())
        self.assertEqual(harness.workspace_path(absolute).name, "file.txt")
        with self.assertRaises(ValueError):
            harness.workspace_path("../../outside")
        self.assertEqual(harness.read_file("dir/file.txt", 9), "[file has 2 lines; start_line is past the end]")
        self.write("empty", "")
        self.assertEqual(harness.read_file("empty"), "(empty file)")
        with self.assertRaises(ValueError):
            list(harness.project_files("nope"))
        (harness.workspace / ".git").mkdir()
        self.assertEqual(list(harness.project_files(".git")), [])
        self.assertEqual([p.name for p in harness.project_files("dir/file.txt")], ["file.txt"])
        self.assertEqual(harness.find_files("nothing*"), "(no files found)")
        with self.assertRaises(ValueError):
            harness.search("")
        self.write("long.txt", "needle " + "x" * 600)
        self.assertIn("[line truncated]", harness.search("needle"))

    def test_write_edit_command_skill_and_tool_errors(self):
        (harness.workspace / "folder").mkdir()
        with self.assertRaises(ValueError):
            harness.write_file("folder", "x")
        target, content, note = harness.write_file("new.txt", "a\\nb\\t\\\"")
        self.assertEqual(target.name, "new.txt")
        self.assertEqual(content, "a\nb\t\"")
        self.assertEqual(note, harness.ESCAPE_NOTE)
        self.write("edit.txt", "one\none")
        with self.assertRaises(ValueError):
            harness.edit_file("edit.txt", "", "x")
        with self.assertRaises(ValueError):
            harness.edit_file("edit.txt", "missing", "x")
        with self.assertRaises(ValueError):
            harness.edit_file("edit.txt", "one", "x")
        self.write("edit.txt", "one\ntwo")
        _, changed, note = harness.edit_file("edit.txt", "one\\ntwo", "three\\nfour")
        self.assertEqual(changed, "three\nfour")
        self.assertEqual(note, harness.ESCAPE_NOTE)
        with self.assertRaises(ValueError):
            harness.run_command("  ")
        self.assertEqual(harness.run_command("echo ok"), {"command": "echo ok"})
        with self.assertRaises(ValueError):
            harness.use_skill("missing")
        with patch.object(harness, "effective_skills", return_value={"x": {"body": "do this"}}):
            self.assertIn("do this", harness.use_skill("x"))
        self.assertIn("unknown tool", harness.run_tool("nope", {}, []))
        self.assertIn("bad arguments", harness.run_tool("pwd", {"bad": 1}, ["pwd"]))
        with patch.dict(harness.TOOL_FUNCTIONS, {"bad": lambda: (_ for _ in ()).throw(OSError(2, "nope"))}, clear=False):
            self.assertIn("nope", harness.run_tool("bad", {}, ["bad"]))
        with patch.dict(harness.TOOL_FUNCTIONS, {"bad": lambda: (_ for _ in ()).throw(ValueError("nope"))}, clear=False):
            self.assertIn("nope", harness.run_tool("bad", {}, ["bad"]))

    def test_low_level_file_and_catalog_edge_cases(self):
        self.assertEqual(harness.unescape("a\\r\\nb\\n\\t\\\""), "a\nb\n\t\"")
        self.write("plain-agent.md", "just prompt")
        self.assertEqual(harness.load_agent_file(harness.workspace / "plain-agent.md", "x")["tools"], [])
        self.write("header-agent.md", "note: ignored\n---\nprompt")
        self.assertEqual(harness.load_agent_file(harness.workspace / "header-agent.md", "x")["tools"], [])
        self.write("plain-skill.md", "body")
        self.assertEqual(harness.load_skill_file(harness.workspace / "plain-skill.md", "x")["name"], "workspace")
        self.write("bad-skill.md", "---\nname: only\nbody")
        self.assertEqual(harness.load_skill_file(harness.workspace / "bad-skill.md", "x")["body"], "---\nname: only\nbody")
        no_prompt = harness.selected_prompt("")
        self.assertIsInstance(no_prompt, str)
        self.assertEqual(harness.system_messages({"agent": "", "prompt": ""}, False), [])
        self.write("AGENTS.md", "r" * (harness.MAX_FILE_CHARS + 1))
        self.assertIn("truncated", harness.load_project_instructions()[1])
        empty_workspace = harness.workspace
        harness.workspace = self.root / "missing"
        self.assertIsNone(harness.load_project_instructions())
        harness.workspace = empty_workspace

    def test_settings_snapshots_and_system_messages(self):
        session = harness.new_session()
        self.write("AGENTS.md", "project")
        with patch.object(harness, "load_prompts", return_value={"p": "prompt"}), \
             patch.object(harness, "load_agents", return_value={"a": {"prompt": "agent", "tools": [], "source": "x"}}), \
             patch.object(harness, "load_skills", return_value={"s": {"name": "s", "description": "d", "body": "b", "source": "x"}}):
            harness.snapshot_instructions({"prompt": "p", "agent": "a"})
            harness.snapshot_instructions({"prompt": "other", "agent": ""})
            self.assertEqual(harness.selected_prompt("p"), "prompt")
            self.assertEqual(harness.selected_agent("a")["prompt"], "agent")
            self.assertIn("s", harness.effective_skills())
            system = harness.system_messages({"prompt": "p", "agent": "a"}, True)[0]["content"]
            self.assertIn("prompt", system)
            self.assertIn("agent", system)
            self.assertIn("project", system)
        self.assertEqual(session["id"], harness.active_session_id)

    def test_compaction_success_stop_and_not_smaller(self):
        harness.new_session()
        history = [{"role": "user", "content": "old " * 500} for _ in range(5)]
        with patch.object(harness.requests, "post") as post:
            reply = MagicMock()
            reply.json.return_value = {"message": {"content": "short"}}
            post.return_value = reply
            events = list(harness.compact_context(history))
        self.assertEqual(events[-1]["action"], "compact")
        self.assertEqual(harness.active_session["last_prompt_tokens"], 0)
        history = [{"role": "user", "content": "old " * 500} for _ in range(5)]
        with patch.object(harness.requests, "post") as post, patch.object(harness, "estimate_tokens", side_effect=[1, 1, 1, 999, 1]):
            reply = MagicMock()
            reply.json.return_value = {"message": {"content": "long"}}
            post.return_value = reply
            self.assertIn("did not reduce", list(harness.compact_context(history))[-1]["reason"])
        history = [{"role": "user", "content": "old " * 500} for _ in range(5)]
        harness.stop_requested.set()
        with patch.object(harness.requests, "post") as post:
            reply = MagicMock()
            reply.json.return_value = {"message": {"content": "short"}}
            post.return_value = reply
            self.assertIn("stopped by the user", list(harness.compact_context(history))[-1]["reason"])
        harness.stop_requested.clear()

    def test_catalog_loading_prompt_rendering_and_skill_context(self):
        self.write("agents/custom.md", "tools: pwd, made_up\n---\ncustom agent")
        self.write("skills/custom/SKILL.md", "---\nname: custom\ndescription: description\n---\nline one\nline two")
        agents = harness.load_agents()
        self.assertEqual(agents["custom"]["tools"], ["pwd"])
        self.assertEqual(agents["custom"]["prompt"], "custom agent")
        skills = harness.load_skills()
        self.assertEqual(skills["custom"]["source"], "project")
        self.assertIn("custom", harness.skills_section())
        context = [{"role": "system", "content": harness.skills_section()},
                   {"role": "tool", "tool_name": "read_file", "content": "   1: line one\n   2: line two"}]
        self.assertTrue(harness.skill_context(context)["custom"]["listed"])
        self.assertEqual(harness.skill_context(context)["custom"]["loaded_lines"], [0, 1])
        self.assertEqual(harness.selected_prompt("nope"), "")
        self.assertIsNone(harness.selected_agent("nope"))
        rendered = harness.render_qwen_prompt(
            [{"role": "system", "content": "s"}, {"role": "user", "content": "u"},
             {"role": "assistant", "content": "", "tool_calls": [{"function": {"name": "x", "arguments": {"b": 1}}}]},
             {"role": "tool", "content": "r"}], harness.TOOLS[:1])
        self.assertIn("<tool_call>", rendered)
        self.assertIn("tool_response", rendered)
        self.assertGreater(harness.estimate_tokens([], [{"role": "user", "content": "x"}], []), 0)

    def test_model_adapters_and_compaction_errors(self):
        tags = MagicMock()
        tags.json.return_value = {"models": [{"name": "other", "details": {}}, {"name": "m", "details": {"context_length": 42}}]}
        with patch.object(harness.requests, "get", return_value=tags):
            self.assertEqual(harness.get_context_length("m"), 42)
            with self.assertRaises(ValueError):
                harness.get_context_length("absent")
        response = MagicMock()
        response.iter_lines.return_value = [b"", b'{"x": 1}']
        with patch.object(harness.requests, "post") as post:
            post.return_value.__enter__.return_value = response
            self.assertEqual(list(harness.stream_chat({})), ['{"x": 1}'])
        self.assertEqual([e["action"] for e in harness.compact_context([])], ["error"])
        history = [{"role": "user", "content": "x" * 2000}] * 5
        with patch.object(harness, "estimate_tokens", return_value=3000):
            self.assertIn("too large", list(harness.compact_context(history))[0]["reason"])
        history = [{"role": "user", "content": "old"}] * 5
        with patch.object(harness.requests, "post") as post:
            reply = MagicMock()
            reply.json.return_value = {"message": {"content": 4}}
            post.return_value = reply
            self.assertIn("invalid summary text", list(harness.compact_context(history))[-1]["reason"])

    def test_routes_and_session_errors(self):
        self.assertEqual(self.client.post("/project", json={"path": "C:\\x"}).status_code, 400)
        self.assertEqual(self.client.post("/project", json={"path": str(self.root / "no")}).status_code, 400)
        file = self.root / "file"
        file.write_text("x")
        self.assertEqual(self.client.post("/project", json={"path": str(file)}).status_code, 400)
        project = self.root / "project"
        project.mkdir()
        harness.new_session()
        self.assertEqual(self.client.post("/project", json={"path": str(project)}).status_code, 200)
        self.assertEqual(self.client.get("/browse", query_string={"path": str(file)}).status_code, 400)
        (project / ".hidden").mkdir()
        (project / "visible").mkdir()
        self.assertEqual(self.client.get("/browse", query_string={"path": str(project)}).json["folders"], ["visible"])
        self.assertEqual(self.client.get("/sessions/nope").status_code, 404)
        self.assertEqual(self.client.patch("/sessions/nope", json={"name": "x"}).status_code, 409)
        self.assertEqual(self.client.post("/sessions/nope/activate").status_code, 404)
        self.assertEqual(self.client.get("/sessions/nope/export").status_code, 404)
        self.assertEqual(self.client.post("/sessions/import", data="not json", content_type="application/json").status_code, 400)
        self.assertEqual(self.client.post("/compact", json={"session_id": "nope"}).status_code, 409)
        self.assertEqual(self.client.post("/compact", json={"use_memory": False}).status_code, 400)
        harness.pending_approvals["a"] = {"event": MagicMock(), "approved": False}
        self.assertEqual(self.client.post("/approve", json={"id": "a", "approved": 1}).status_code, 200)
        self.assertTrue(harness.pending_approvals["a"]["approved"])
        self.assertEqual(self.client.post("/approve", json={"id": "missing"}).status_code, 404)
        self.assertEqual(self.client.post("/stop").json, {"ok": True})
        self.assertTrue(harness.stop_requested.is_set())

    def test_routes_success_index_reset_and_session_management(self):
        created = self.client.post("/sessions", json={"name": "  named  "})
        self.assertEqual(created.status_code, 200)
        session_id = created.json["session"]["id"]
        self.assertEqual(self.client.get("/sessions").json["active_id"], session_id)
        self.assertEqual(self.client.get(f"/sessions/{session_id}").json["id"], session_id)
        updated = self.client.patch(f"/sessions/{session_id}", json={"name": "renamed", "settings": {"use_memory": False, "evil": 1}})
        self.assertEqual(updated.json["name"], "renamed")
        self.assertNotIn("evil", updated.json["settings"])
        page = self.client.get("/")
        self.assertEqual(page.status_code, 200)
        self.assertIn(b"Chat", page.data)
        self.assertNotIn(b"{{", page.data)
        bootstrap = self.client.get("/bootstrap").json
        self.assertEqual(bootstrap["project"], str(harness.workspace))
        self.assertIn("tools", bootstrap)
        with patch.object(harness, "UI_ORIGIN", "https://ui.example"):
            allowed = self.client.get("/bootstrap", headers={"Origin": "https://ui.example"})
            denied = self.client.get("/bootstrap", headers={"Origin": "https://other.example"})
        self.assertEqual(allowed.headers["Access-Control-Allow-Origin"], "https://ui.example")
        self.assertNotIn("Access-Control-Allow-Origin", denied.headers)
        harness.messages.append({"role": "user", "content": "x"})
        self.client.post("/reset")
        self.assertEqual(harness.messages, [])
        self.assertEqual(harness.active_session["snapshots"], {})
        harness.turn_lock.acquire()
        try:
            self.assertEqual(self.client.post("/sessions", json={}).status_code, 409)
            self.assertEqual(self.client.post(f"/sessions/{session_id}/activate").status_code, 409)
        finally:
            harness.turn_lock.release()

    def test_route_remaining_edges_and_explorer_locked_state(self):
        # Project selection also works before any persistent session exists.
        project = self.root / "project"
        project.mkdir()
        self.assertEqual(self.client.post("/project", json={"path": str(project)}).status_code, 200)
        data = harness.default_session()
        missing = self.root / "missing"
        data["workspace"] = str(missing)
        harness.SESSIONS_DIR.mkdir(exist_ok=True)
        harness.session_path(data["id"]).write_text(json.dumps(data))
        activated = self.client.post(f'/sessions/{data["id"]}/activate')
        self.assertTrue(activated.json["missing_workspace"])
        harness.workspace = project
        harness.active_session.pop("missing_workspace", None)
        harness.messages[:] = [{"role": "user", "content": "kept"}]
        harness.conversation_setup = {"agent": "", "prompt": ""}
        with patch.object(harness.requests, "post") as post:
            post.return_value.json.return_value = {"template": "t", "parameters": "p"}
            explored = self.client.post("/explore", json={"use_memory": True, "tools": [], "agent": "wrong", "prompt": "wrong"})
        self.assertEqual(explored.status_code, 200)
        self.assertEqual(explored.json["agent_name"], "")
        with patch.object(Path, "iterdir", side_effect=OSError(13, "denied")):
            self.assertEqual(self.client.get("/browse", query_string={"path": str(project)}).status_code, 400)

    def test_prompt_and_trim_edge_cases(self):
        with patch.object(harness, "effective_skills", return_value={}):
            self.assertEqual(harness.skills_section(), "")
        prompt = harness.render_qwen_prompt([
            {"role": "assistant", "content": "answer"},
            {"role": "assistant", "content": ""},
        ], [])
        self.assertIn("answer<|im_end|>", prompt)
        prompt = harness.render_qwen_prompt([
            {"role": "assistant", "content": ""},
            {"role": "tool", "content": "result"},
            {"role": "user", "content": "last"},
        ], [])
        self.assertIn("tool_response", prompt)
        self.assertIn("assistant", harness.render_qwen_prompt([{"role": "user", "content": "only"}], []))
        self.assertIn("assistant", harness.render_qwen_prompt([{"role": "other", "content": "ignored"}], []))
        conversation = [
            {"role": "user", "content": "before"},
            {"role": "tool", "tool_name": "x", "content": "x" * 1000},
            {"role": "user", "content": "1"}, {"role": "assistant", "content": "2"},
            {"role": "user", "content": "3"}, {"role": "assistant", "content": "4"},
        ]
        harness.context_length = 100
        self.assertEqual(harness.trim_context([], conversation, [])["action"], "trim")
        conversation[1]["content"] = "tiny"
        with patch.object(harness, "estimate_tokens", return_value=100):
            self.assertIsNone(harness.trim_context([], conversation, []))

        unmatched = [
            {"role": "assistant", "content": "", "tool_calls": [{"function": {"name": "other", "arguments": {}}}]},
            {"role": "tool", "tool_name": "x", "content": "x" * 1000},
            {"role": "user", "content": "1"}, {"role": "assistant", "content": "2"},
            {"role": "user", "content": "3"}, {"role": "assistant", "content": "4"},
        ]
        with patch.object(harness, "estimate_tokens", return_value=100):
            self.assertEqual(harness.trim_context([], unmatched, [])["action"], "trim")

    def test_chat_no_change_and_stopped_approval_command(self):
        harness.new_session()
        self.write("same.txt", "same")
        no_change = {"function": {"name": "write_file", "arguments": {"path": "same.txt", "content": "same"}}}
        def turn(calls):
            yield json.dumps({"message": {"role": "assistant", "content": "", "tool_calls": calls},
                              "done": True, "prompt_eval_count": 1, "eval_count": 1})
        with patch.object(harness, "stream_chat", side_effect=[turn([no_change]), self.complete()]):
            events = self.events(self.client.post("/chat", json=self.chat(tools=["write_file"])))
        self.assertTrue(any(e["type"] == "tool" and "no change" in e["result"] for e in events))

        harness.messages.clear()
        call = {"function": {"name": "run_command", "arguments": {"command": "never"}}}
        class StopDuringWait:
            def wait(self, timeout):
                harness.stop_requested.set()
            def set(self):
                pass
        with patch.object(harness.threading, "Event", StopDuringWait), \
             patch.object(harness, "stream_chat", side_effect=[turn([call]), self.complete()]):
            events = self.events(self.client.post("/chat", json=self.chat(tools=["run_command"], ask_approval=True)))
        self.assertTrue(any(e["type"] == "command" and not e["approved"] for e in events))
        harness.stop_requested.clear()

        harness.messages.clear()
        write = {"function": {"name": "write_file", "arguments": {"path": "stopped.txt", "content": "x"}}}
        class StopWrite:
            def wait(self, timeout):
                harness.stop_requested.set()
            def set(self):
                pass
        with patch.object(harness.threading, "Event", StopWrite), \
             patch.object(harness, "stream_chat", side_effect=[turn([write]), self.complete()]):
            events = self.events(self.client.post("/chat", json=self.chat(tools=["write_file"], ask_approval=True)))
        self.assertFalse((harness.workspace / "stopped.txt").exists())
        self.assertTrue(any(e["type"] == "change" and not e["approved"] for e in events))
        harness.stop_requested.clear()

    def test_remaining_chat_stop_branches_and_session_patch_edges(self):
        session = harness.new_session()
        response = self.client.patch(f'/sessions/{session["id"]}', json={"name": 5, "settings": {}})
        self.assertEqual(response.status_code, 200)

        harness.messages[:] = [{"role": "tool", "tool_name": "x", "content": "old" * 1000}] * 5
        harness.last_prompt_tokens = 2999
        def stop_during_trim(*args):
            harness.stop_requested.set()
            return None
        with patch.object(harness, "trim_context", side_effect=stop_during_trim):
            events = self.events(self.client.post("/chat", json=self.chat()))
        self.assertEqual(events[-1]["type"], "stopped")
        harness.stop_requested.clear()

        harness.messages.clear()
        def empty_interrupted(_):
            yield json.dumps({"message": {"role": "assistant", "content": ""}, "done": False})
            harness.stop_requested.set()
            yield json.dumps({"message": {"role": "assistant", "content": ""}, "done": True})
        with patch.object(harness, "stream_chat", side_effect=empty_interrupted):
            self.events(self.client.post("/chat", json=self.chat()))
        harness.stop_requested.clear()

    def test_chat_rejects_missing_workspace_and_unknown_manual_skill(self):
        harness.new_session()
        harness.active_session["missing_workspace"] = True
        self.assertEqual(self.client.post("/chat", json=self.chat()).status_code, 409)
        harness.active_session.pop("missing_workspace")
        seen = []
        def model(payload):
            seen.append(payload)
            yield from self.complete()
        with patch.object(harness, "stream_chat", side_effect=model):
            events = self.events(self.client.post("/chat", json=self.chat(message="/not-a-skill hello")))
        self.assertFalse(any(e["type"] == "skill" for e in events))
        self.assertIn("/not-a-skill hello", seen[0]["messages"][-1]["content"])

    def test_chat_denied_and_approved_file_changes_and_denied_command(self):
        harness.new_session()
        write_call = {"function": {"name": "write_file", "arguments": {"path": "denied.txt", "content": "x"}}}
        command_call = {"function": {"name": "run_command", "arguments": {"command": "printf never"}}}
        def tool_turn(calls):
            yield json.dumps({"message": {"role": "assistant", "content": "", "tool_calls": calls},
                              "done": True, "prompt_eval_count": 1, "eval_count": 1})
        class Decline:
            def wait(self, timeout):
                return False
            def set(self):
                pass
        with patch.object(harness.threading, "Event", Decline), \
             patch.object(harness, "stream_chat", side_effect=[tool_turn([write_call, command_call]), self.complete()]):
            events = self.events(self.client.post("/chat", json=self.chat(tools=["write_file", "run_command"], ask_approval=True)))
        self.assertFalse((harness.workspace / "denied.txt").exists())
        self.assertEqual([e["type"] for e in events].count("approval"), 2)
        self.assertTrue(any(e["type"] == "change" and not e["approved"] for e in events))
        self.assertTrue(any(e["type"] == "command" and not e["approved"] for e in events))

        harness.messages.clear()
        approved_call = {"function": {"name": "write_file", "arguments": {"path": "approved.txt", "content": "yes"}}}
        class Approve:
            def wait(self, timeout):
                harness.pending_approvals["approval"]["approved"] = True
                return True
            def set(self):
                pass
        identifier = MagicMock()
        identifier.hex = "approval"
        with patch.object(harness.threading, "Event", Approve), patch.object(harness.uuid, "uuid4", return_value=identifier), \
             patch.object(harness, "stream_chat", side_effect=[tool_turn([approved_call]), self.complete()]):
            self.events(self.client.post("/chat", json=self.chat(tools=["write_file"], ask_approval=True)))
        self.assertEqual((harness.workspace / "approved.txt").read_text(), "yes")

    def test_chat_stops_during_stream_and_after_tool_batch(self):
        harness.new_session()
        def interrupted(_):
            yield json.dumps({"message": {"role": "assistant", "content": "partial"}, "done": False})
            harness.stop_requested.set()
            yield json.dumps({"message": {"role": "assistant", "content": "ignored"}, "done": True})
        with patch.object(harness, "stream_chat", side_effect=interrupted):
            events = self.events(self.client.post("/chat", json=self.chat()))
        self.assertEqual(events[-1]["type"], "stopped")
        self.assertIn("partial", harness.messages[-1]["content"])
        harness.stop_requested.clear()

        harness.messages.clear()
        def stopped_tool(_):
            yield json.dumps({"message": {"role": "assistant", "content": "", "tool_calls": [
                {"function": {"name": "pwd", "arguments": {}}}
            ]}, "done": True, "prompt_eval_count": 1, "eval_count": 1})
        # The harness must add a stopped result rather than execute remaining calls.
        with patch.object(harness, "run_tool", side_effect=lambda *args: harness.STOPPED_RESULT):
            harness.stop_requested.set()
            with patch.object(harness, "stream_chat", side_effect=stopped_tool):
                events = self.events(self.client.post("/chat", json=self.chat(tools=["pwd"])))
        self.assertEqual(events[-1]["type"], "stopped")
        harness.stop_requested.clear()

    def test_stop_closes_generator_or_plain_iterator(self):
        """The transport-free core must also stop an adapter iterator without close()."""
        def stopped_iterator(_):
            harness.stop_requested.set()
            return iter(["ignored"])
        with patch.object(harness, "stream_chat", side_effect=stopped_iterator):
            events = self.events(self.client.post("/chat", json=self.chat()))
        self.assertEqual(events[-1]["type"], "stopped")
        harness.stop_requested.clear()

    def test_command_timeout_output_limit_and_process_lookup_race(self):
        harness.new_session()
        call = {"function": {"name": "run_command", "arguments": {"command": "fake"}}}
        def tool_turn(_):
            yield json.dumps({"message": {"role": "assistant", "content": "", "tool_calls": [call]},
                              "done": True, "prompt_eval_count": 1, "eval_count": 1})
        process = MagicMock()
        process.pid = 123
        process.returncode = -9
        process.communicate.side_effect = [harness.subprocess.TimeoutExpired("fake", 0.3),
                                           ("x" * (harness.MAX_FILE_CHARS + 5), None)]
        with patch.object(harness.subprocess, "Popen", return_value=process), \
             patch.object(harness.time, "time", side_effect=[0, harness.COMMAND_TIMEOUT + 1]), \
             patch.object(harness.os, "killpg", side_effect=ProcessLookupError), \
             patch.object(harness, "stream_chat", side_effect=[tool_turn({}), self.complete()]):
            events = self.events(self.client.post("/chat", json=self.chat(tools=["run_command"])))
        command = next(e for e in events if e["type"] == "command")
        self.assertIn("timed out", command["status"])
        self.assertIn("characters cut", command["output"])

    def test_command_retries_after_a_nonterminal_timeout(self):
        harness.new_session()
        call = {"function": {"name": "run_command", "arguments": {"command": "fake"}}}
        def tool_turn(_):
            yield json.dumps({"message": {"role": "assistant", "content": "", "tool_calls": [call]},
                              "done": True, "prompt_eval_count": 1, "eval_count": 1})
        process = MagicMock()
        process.pid = 123
        process.returncode = 0
        process.communicate.side_effect = [harness.subprocess.TimeoutExpired("fake", 0.3), ("ok", None)]
        with patch.object(harness.subprocess, "Popen", return_value=process), \
             patch.object(harness.time, "time", side_effect=[0, 1]), \
             patch.object(harness, "stream_chat", side_effect=[tool_turn({}), self.complete()]):
            events = self.events(self.client.post("/chat", json=self.chat(tools=["run_command"])))
        self.assertEqual(next(e for e in events if e["type"] == "command")["status"], "exit code 0")

    def test_stop_before_tool_execution_and_direct_launcher_paths(self):
        harness.new_session()
        call = {"function": {"name": "pwd", "arguments": {}}}
        class StopFunction(dict):
            def get(self, key, default=None):
                if key == "arguments":
                    harness.stop_requested.set()
                return super().get(key, default)
        decoded = {"message": {"role": "assistant", "content": "", "tool_calls": [
            {"function": StopFunction({"name": "pwd", "arguments": {}})}
        ]}, "done": True, "prompt_eval_count": 1, "eval_count": 1}
        original_loads = json.loads
        try:
            with patch.object(harness, "stream_chat", return_value=iter(["ignored"])), \
                 patch.object(harness.json, "loads", side_effect=lambda value, *args, **kwargs: decoded if value == "ignored" else original_loads(value, *args, **kwargs)):
                events = self.events(self.client.post("/chat", json=self.chat(tools=["pwd"])))
        finally:
            harness.stop_requested.clear()
        self.assertTrue(any(e["type"] == "tool" and e["result"] == harness.STOPPED_RESULT for e in events))
        self.assertEqual(events[-1]["type"], "stopped")

        source = (Path(__file__).resolve().parents[1] / "web" / "app.py").read_text()
        filename = str(Path(__file__).resolve().parents[1] / "web" / "app.py")
        tags = MagicMock()
        tags.json.return_value = {"models": [{"name": "qwen3:8b", "details": {"context_length": 99}}]}
        namespace = {"__name__": "__main__", "__file__": str(self.root / "web" / "app.py")}
        with patch.object(harness.requests, "get", return_value=tags), patch.object(harness.Flask, "run") as run:
            exec(compile(source, filename, "exec"), namespace)
        run.assert_called_once_with(port=5000, debug=True, use_reloader=False)
        namespace = {"__name__": "__main__", "__file__": str(self.root / "error-web" / "app.py")}
        with patch.object(harness.requests, "get", side_effect=harness.requests.ConnectionError), \
             patch.object(sys, "exit", side_effect=SystemExit(1)):
            with self.assertRaises(SystemExit):
                exec(compile(source, filename, "exec"), namespace)

    def test_chat_manual_skill_thinking_tool_file_change_command_and_stop(self):
        harness.new_session()
        tool_response = {
            "message": {"role": "assistant", "content": "", "tool_calls": [
                {"function": {"name": "write_file", "arguments": {"path": "made.txt", "content": "made"}}},
                {"function": {"name": "run_command", "arguments": {"command": "printf done"}}},
            ]}, "done": True, "prompt_eval_count": 12, "eval_count": 1,
        }
        def first(_):
            yield json.dumps({"message": {"role": "assistant", "content": "partial", "thinking": "reason"}, "done": False})
            yield json.dumps(tool_response)
        with patch.object(harness, "stream_chat", side_effect=[first({}), self.complete("finished")]):
            events = self.events(self.client.post("/chat", json=self.chat(message="/run-python-tests", tools=["write_file", "run_command"], ask_approval=False)))
        self.assertEqual((harness.workspace / "made.txt").read_text(), "made")
        self.assertTrue(any(e["type"] == "thinking" for e in events))
        self.assertTrue(any(e["type"] == "skill" for e in events))
        self.assertTrue(any(e["type"] == "change" and e["approved"] for e in events))
        self.assertTrue(any(e["type"] == "command" and "done" in e["output"] for e in events))
        self.assertEqual(events[-1]["type"], "response")


if __name__ == "__main__":
    unittest.main()
