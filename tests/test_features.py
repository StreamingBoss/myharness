import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'web'))
import app as harness


class Features(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.old_workspace = harness.workspace
        harness.workspace = Path(self.temp.name)
        harness.messages.clear()
        harness.context_length = 3000
        harness.last_prompt_tokens = 0
        harness.stop_requested.clear()
        self.client = harness.app.test_client()

    def tearDown(self):
        harness.workspace = self.old_workspace
        self.temp.cleanup()
        harness.messages.clear()

    def write(self, name, content):
        file = harness.workspace / name
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(content)
        return file

    def test_ranges_and_continuation(self):
        self.write('file.txt', '\n'.join(f'line {i}' for i in range(1, 901)))
        self.assertEqual(harness.read_file('file.txt', 12, 13),
                         '  12: line 12\n  13: line 13\n[lines 12-13 of 900; call again with start_line=14]')
        self.write('large.txt', ('x' * 80 + '\n') * 900)
        result = harness.read_file('large.txt')
        self.assertIn('call again with start_line=', result)
        self.assertLess(len(result), harness.MAX_FILE_CHARS + 100)
        with self.assertRaises(ValueError):
            harness.read_file('file.txt', 0)
        self.write('long.txt', 'x' * 20000 + '\nlast')
        self.assertIn('start_line=2', harness.read_file('long.txt'))

    def test_search_and_find(self):
        self.write('src/a.py', 'hello\nneedle here\nNeedle')
        self.write('b.txt', 'needle')
        self.write('.git/secret.py', 'needle')
        self.write('.mypy_cache/cache.py', 'needle')
        self.write('binary.py', 'needle\0')
        (harness.workspace / 'invalid.py').write_bytes(b'needle\xff')
        self.assertEqual(harness.search('needle', glob='*.py'), 'src/a.py:2: needle here')
        self.assertEqual(harness.search('needle', path='src/a.py'), 'src/a.py:2: needle here')
        self.assertEqual(harness.find_files('src/*'), 'src/a.py')
        self.assertNotIn('.git', harness.find_files('*'))
        for tool, args in [(harness.read_file, ('../outside',)),
                           (harness.search, ('x', '../outside'))]:
            with self.assertRaises(ValueError):
                tool(*args)
        outside = Path(self.temp.name).parent / 'external-search-file'
        outside.write_text('needle')
        try:
            (harness.workspace / 'link.py').symlink_to(outside)
            self.assertNotIn('link.py', harness.find_files('*'))
        finally:
            outside.unlink()

    def test_caps(self):
        for i in range(205):
            self.write(f'{i:03}.txt', 'needle')
        self.assertTrue(harness.find_files('*.txt').endswith('[5 more not shown]'))
        result = harness.search('needle')
        self.assertEqual(len(result.splitlines()), 101)
        self.assertIn('more matches not shown', result)

    def test_project_instructions(self):
        setup = {'agent': 'coder', 'prompt': ''}
        self.write('CLAUDE.md', 'ignore this fallback')
        self.assertIsNone(harness.load_project_instructions())
        file = self.write('AGENTS.md', 'project rule')
        system = harness.system_messages(setup, True)[0]['content']
        self.assertLess(system.index('coding assistant'), system.index('# Project instructions'))
        self.assertLess(system.index('# Project instructions'), system.index('# Skills'))
        file.write_text('updated rule')
        self.assertIn('updated rule', harness.system_messages(setup, True)[0]['content'])
        with patch.object(harness.requests, 'post') as post:
            post.return_value.json.return_value = {}
            response = self.client.post('/explore', json={'agent': 'coder', 'prompt': '', 'tools': ['use_skill'], 'use_memory': True})
        self.assertIn('# Project instructions (AGENTS.md)\n\nupdated rule', response.json['final'])
        self.assertEqual(response.json['project_instructions'], ['AGENTS.md', 'updated rule'])

    def test_project_instructions_refresh_between_tools(self):
        file = self.write('AGENTS.md', 'first rule')
        sent = []

        def stream(payload):
            sent.append(payload)
            if len(sent) == 1:
                file.write_text('second rule')
                yield json.dumps({'message': {'role': 'assistant', 'content': '',
                    'tool_calls': [{'function': {'name': 'pwd', 'arguments': {}}}]},
                    'done': True, 'prompt_eval_count': 100})
            else:
                yield from self.fake_stream(payload)

        with patch.object(harness, 'stream_chat', side_effect=stream):
            self.client.post('/chat', json=self.chat_data(tools=['pwd'])).data
        self.assertIn('first rule', sent[0]['messages'][0]['content'])
        self.assertIn('second rule', sent[1]['messages'][0]['content'])

    def test_numbered_skill_read_preserves_highlighting(self):
        skill = {'name': 'example', 'description': 'example skill', 'body': 'First instruction\nSecond instruction'}
        self.write('SKILL.md', skill['body'])
        context = [{'role': 'tool', 'tool_name': 'read_file', 'content': harness.read_file('SKILL.md')}]
        with patch.object(harness, 'load_skills', return_value={'example': skill}):
            self.assertTrue(harness.skill_context(context)['example']['body_loaded'])

    def history(self):
        return [
            {"role": "user", "content": "Goal: inspect alpha.py"},
            {"role": "assistant", "content": "", "tool_calls": [{"function": {"name": "read_file", "arguments": {"path": "alpha.py"}}}]},
            {"role": "tool", "tool_name": "read_file", "content": "old code " * 350},
            {"role": "assistant", "content": "alpha.py implements sum_values"},
            {"role": "user", "content": "What remains?"},
            {"role": "assistant", "content": "Check beta.py"},
            {"role": "user", "content": "Continue"},
            {"role": "assistant", "content": "Ready"},
        ]

    def chat_data(self, **overrides):
        return {"message": "continue", "use_memory": True, "tools": [],
                "ask_approval": True, "agent": "", "prompt": "", **overrides}

    def fake_stream(self, payload):
        yield json.dumps({"message": {"role": "assistant", "content": "ok"}, "done": False})
        yield json.dumps({"message": {"role": "assistant", "content": ""}, "done": True,
                          "prompt_eval_count": 1234, "eval_count": 2})

    def test_trim_preserves_tail_and_call_metadata(self):
        history = self.history()
        tail = json.loads(json.dumps(history[-4:]))
        event = harness.trim_context([], history, [])
        # Increase history to force trimming above the 60% target.
        history[2]["content"] = "old code " * 1000
        event = harness.trim_context([], history, [])
        self.assertEqual(event['action'], 'trim')
        self.assertIn('read_file', history[2]['content'])
        self.assertIn('alpha.py', history[2]['content'])
        self.assertEqual(history[-4:], tail)

    def test_trim_metadata_for_repeated_tool_calls(self):
        history = self.history()
        history[1]['tool_calls'].append({'function': {'name': 'read_file', 'arguments': {'path': 'beta.py'}}})
        history[2]['content'] = 'alpha contents ' * 1000
        history.insert(3, {'role': 'tool', 'tool_name': 'read_file', 'content': 'beta contents ' * 1000})
        harness.trim_context([], history, [])
        self.assertIn('alpha.py', history[2]['content'])
        self.assertIn('beta.py', history[3]['content'])

    def test_compact_success_and_failure(self):
        harness.messages.extend(self.history())
        tail = json.loads(json.dumps(harness.messages[-4:]))
        with patch.object(harness.requests, 'post') as post:
            post.return_value.json.return_value = {"message": {"content": "Goal: inspect alpha.py; sum_values adds values. Next check beta.py."}}
            events = [json.loads(line) for line in self.client.post('/compact', json={}).data.splitlines()]
        self.assertEqual(events[-1]['action'], 'compact')
        self.assertEqual(harness.messages[1:], tail)
        self.assertTrue(harness.messages[0]['content'].startswith('[Summary'))
        self.assertFalse(post.call_args.kwargs['json']['think'])
        harness.messages[:] = self.history()
        before = json.loads(json.dumps(harness.messages))
        with patch.object(harness.requests, 'post', side_effect=harness.requests.ConnectionError('offline')):
            events = list(harness.compact_context(harness.messages))
        self.assertEqual(events[-1]['action'], 'error')
        self.assertEqual(harness.messages, before)
        with patch.object(harness.requests, 'post') as post:
            post.return_value.json.return_value = None
            events = list(harness.compact_context(harness.messages))
        self.assertEqual(events[-1]['action'], 'error')
        self.assertEqual(harness.messages, before)
        with patch.object(harness.requests, 'post') as post:
            post.return_value.json.return_value = {"message": {"content": ""}}
            list(harness.compact_context(harness.messages))
        self.assertEqual(harness.messages, before)

    def test_tool_batch_boundary(self):
        history = self.history()
        history[4:4] = [
            {"role": "assistant", "content": "", "tool_calls": [{"function": {"name": "pwd", "arguments": {}}}]},
            {"role": "tool", "tool_name": "pwd", "content": "project"},
        ]
        history.pop()  # Last four now begin inside that batch.
        boundary = harness.retained_boundary(history)
        self.assertEqual(history[boundary]['role'], 'assistant')
        self.assertIn('tool_calls', history[boundary])

    def test_auto_trim_compact_meter_and_memory_off(self):
        harness.messages[:] = self.history()
        harness.messages[2]['content'] = 'old code ' * 1500
        harness.last_prompt_tokens = 2900
        with patch.object(harness, 'stream_chat', side_effect=self.fake_stream), patch.object(harness.requests, 'post') as post:
            post.return_value.json.return_value = {"message": {"content": "alpha.py adds values; check beta.py next."}}
            events = [json.loads(line) for line in self.client.post('/chat', json=self.chat_data()).data.splitlines()]
        self.assertTrue(any(e.get('action') == 'trim' for e in events))
        self.assertTrue(any(e.get('action') == 'compact' for e in events))
        response = next(e for e in events if e['type'] == 'response')
        self.assertEqual(response['tokens_in'], 1234)
        self.assertEqual(response['context_length'], 3000)
        self.assertEqual(harness.last_prompt_tokens, 1234)
        before = json.loads(json.dumps(harness.messages))
        harness.last_prompt_tokens = 2900
        with patch.object(harness, 'stream_chat', side_effect=self.fake_stream), patch.object(harness.requests, 'post') as post:
            events = [json.loads(line) for line in self.client.post('/chat', json=self.chat_data(use_memory=False)).data.splitlines()]
        self.assertFalse(any(e['type'] == 'context' for e in events))
        self.assertEqual(harness.messages, before)
        post.assert_not_called()

    def test_overflow_never_sent(self):
        harness.messages[:] = [{"role": "user", "content": "huge " * 5000}]
        with patch.object(harness, 'stream_chat') as stream, patch.object(harness.requests, 'post') as post:
            events = [json.loads(line) for line in self.client.post('/chat', json=self.chat_data()).data.splitlines()]
        self.assertEqual(events[-1]['type'], 'stopped')
        self.assertIn('context full', events[-1]['reason'])
        stream.assert_not_called()
        post.assert_not_called()
        self.assertFalse(harness.turn_lock.locked())

    def test_busy_compaction_and_reset(self):
        harness.turn_lock.acquire()
        try:
            self.assertEqual(self.client.post('/compact', json={}).status_code, 409)
            self.assertEqual(self.client.post('/chat', json=self.chat_data()).status_code, 409)
        finally:
            harness.turn_lock.release()
        harness.last_prompt_tokens = 1234
        self.client.post('/reset')
        self.assertEqual(harness.last_prompt_tokens, 0)


if __name__ == '__main__':
    unittest.main()
