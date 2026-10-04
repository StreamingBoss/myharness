"""Isolated Python HTTP host used by the TypeScript parity suite."""
import json
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'web'))
import app as harness

def run(scenario):
    with tempfile.TemporaryDirectory() as folder:
        root = Path(folder)
        harness.workspace = root
        harness.SESSIONS_DIR = root / 'sessions'
        harness.SETTINGS_FILE = root / 'settings.json'
        harness.AGENTS_DIR = root / 'agents'
        harness.PROMPTS_DIR = root / 'prompts'
        harness.SKILLS_DIR = root / 'skills'
        harness.active_session = {}
        harness.active_session_id = ''
        harness.messages = []
        harness.conversation_setup = {'agent': '', 'prompt': ''}
        harness.MODEL = 'qwen3:8b'
        harness.context_length = 3000
        harness.stop_requested.clear()
        for name, content in scenario.get('files', {}).items():
            file = root / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text(content)
        turns = iter(scenario['model_turns'])
        requests = []
        def stream(payload):
            requests.append(json.loads(json.dumps(payload)))
            for chunk in next(turns):
                yield json.dumps(chunk)
        class Approval:
            def wait(self, timeout):
                for pending in harness.pending_approvals.values():
                    pending['approved'] = scenario.get('approval') == 'approve'
                if scenario.get('approval') == 'stop':
                    harness.stop_requested.set()
            def set(self):
                pass
        with patch.object(harness, 'stream_chat', side_effect=stream), patch.object(harness.threading, 'Event', Approval):
            response = harness.app.test_client().post('/chat', json=scenario['request'])
            events = [json.loads(line) for line in response.data.splitlines()]
        return {'events': events, 'requests': requests, 'memory': harness.messages, 'root': str(root),
                'files': {str(file.relative_to(root)): file.read_text() for file in root.rglob('*') if file.is_file()}}

if __name__ == '__main__':
    print(json.dumps(run(json.load(sys.stdin)), ensure_ascii=False))
