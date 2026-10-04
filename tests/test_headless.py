import json
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tests" / "python_reference"))
import headless


class HeadlessClient(unittest.TestCase):
    def bootstrap(self, session=None):
        response = MagicMock()
        response.json.return_value = {"session": session or {}}
        return response

    def test_streams_turn_and_answers_approval(self):
        boot = self.bootstrap({"id": "s", "settings": {"tools": ["pwd"]}, "setup": {"agent": "a", "prompt": "p"}})
        chat = MagicMock()
        chat.iter_lines.return_value = ["", json.dumps({"type": "approval", "id": "approval"}), json.dumps({"type": "response"})]
        approved = MagicMock()
        with patch.object(sys, "argv", ["headless.py", "hello", "--approve"]), \
             patch.object(headless.requests, "get", return_value=boot), \
             patch.object(headless.requests, "post", side_effect=[chat, approved]) as post, \
             patch("builtins.print") as output:
            self.assertEqual(headless.main(), 0)
        self.assertEqual(post.call_args_list[0].kwargs["json"]["tools"], ["pwd"])
        self.assertTrue(post.call_args_list[1].kwargs["json"]["approved"])
        self.assertEqual(output.call_count, 2)

    def test_reset_argument_and_explicit_tools(self):
        boot = self.bootstrap()
        reset = MagicMock()
        reset.json.return_value = {"memory": "[]"}
        with patch.object(sys, "argv", ["headless.py", "--reset"]), \
             patch.object(headless.requests, "get", return_value=boot), \
             patch.object(headless.requests, "post", return_value=reset), \
             patch("builtins.print") as output:
            self.assertEqual(headless.main(), 0)
        output.assert_called_once_with("[]")
        with patch.object(sys, "argv", ["headless.py", "hello", "--tools", "pwd, search", "--no-memory"]), \
             patch.object(headless.requests, "get", return_value=boot), \
             patch.object(headless.requests, "post", return_value=MagicMock(iter_lines=lambda **_: [])):
            self.assertEqual(headless.main(), 0)

    def test_errors_interrupt_and_missing_message(self):
        with patch.object(sys, "argv", ["headless.py"]), patch.object(headless.requests, "get", return_value=self.bootstrap()):
            with self.assertRaises(SystemExit):
                headless.main()
        with patch.object(sys, "argv", ["headless.py", "hello"]), \
             patch.object(headless.requests, "get", side_effect=headless.requests.ConnectionError("offline")), \
             patch("builtins.print") as output:
            self.assertEqual(headless.main(), 1)
        self.assertIn("offline", output.call_args.args[0])
        with patch.object(sys, "argv", ["headless.py", "hello"]), \
             patch.object(headless.requests, "get", side_effect=KeyboardInterrupt), \
             patch.object(headless.requests, "post") as stop:
            self.assertEqual(headless.main(), 130)
        self.assertTrue(stop.called)

    def test_direct_launcher(self):
        source_file = Path(headless.__file__)
        source = source_file.read_text()
        boot = self.bootstrap()
        chat = MagicMock()
        chat.iter_lines.return_value = []
        namespace = {"__name__": "__main__", "__file__": str(source_file)}
        with patch.object(sys, "argv", ["headless.py", "hello"]), \
             patch.object(headless.requests, "get", return_value=boot), \
             patch.object(headless.requests, "post", return_value=chat):
            with self.assertRaises(SystemExit) as exit_result:
                exec(compile(source, str(source_file), "exec"), namespace)
        self.assertEqual(exit_result.exception.code, 0)


if __name__ == "__main__":
    unittest.main()
