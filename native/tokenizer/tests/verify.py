#!/usr/bin/env python3
"""Check the tokenizer helper: every line of its own code, its protocol, and pinned llama.cpp goldens.

Usage: python3 native/tokenizer/tests/verify.py --llama-source PATH --helper PATH
Requires g++, gcov and a built real helper. No inference model or Ollama is used, and nothing
outside a temporary folder is written: start at login is exercised against a scratch home folder.
"""
import argparse
import http.client
import http.server
import json
import os
import pathlib
import signal
import socket
import subprocess
import tempfile
import threading
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--llama-source', type=pathlib.Path, required=True)
parser.add_argument('--helper', type=pathlib.Path, required=True)
args = parser.parse_args()
args.llama_source = args.llama_source.resolve()
args.helper = args.helper.resolve()
source = pathlib.Path(__file__).resolve().parents[1]
ORIGIN = 'https://harness.test'


class Helper:
    """A running helper and plain HTTP requests to it, with full control of Host and Origin."""

    def __init__(self, program, arguments=(), env=None, logs=None):
        self.process = subprocess.Popen([str(program), '--port', '0', *arguments], env={**os.environ, **(env or {})},
                                        stdout=subprocess.PIPE, stderr=logs or subprocess.DEVNULL)
        self.banner = [self.process.stdout.readline().decode().strip() for _ in range(3)]
        self.port = int(self.banner[0].rsplit(':', 1)[1])

    def request(self, route, body=None, origin=ORIGIN, host=None, method='POST', raw=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=60)
        data = raw if raw is not None else json.dumps({} if body is None else body).encode()
        connection.putrequest(method, route, skip_host=True)
        connection.putheader('Host', host or f'127.0.0.1:{self.port}')
        if origin:
            connection.putheader('Origin', origin)
        connection.putheader('Content-Type', 'application/json')
        connection.putheader('Content-Length', str(len(data)))
        connection.endheaders()
        try:
            connection.send(data)
        except (BrokenPipeError, ConnectionResetError):
            pass  # The helper may answer and close before an oversized body is fully sent.
        response = connection.getresponse()
        text = response.read().decode()
        headers = {name.lower(): value for name, value in response.getheaders()}
        connection.close()
        return response.status, (json.loads(text) if text else None), headers

    def tokenize(self, model, content):
        return self.request('/v1/tokenize', {'model': model, 'content': content})

    def stop(self):
        self.process.send_signal(signal.SIGTERM)
        assert self.process.wait(timeout=10) == 0, 'the helper must stop cleanly'


class Ollama(http.server.BaseHTTPRequestHandler):
    """Stands in for Ollama's /api/show, the one request the helper makes to find a model file."""
    answers = {}

    def do_POST(self):
        model = json.loads(self.rfile.read(int(self.headers['Content-Length'])))['model']
        answer = Ollama.answers.get(model)
        body = answer if isinstance(answer, bytes) else json.dumps(answer).encode()
        self.send_response(404 if answer is None else 200)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_):
        pass


def start_ollama():
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Ollama)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


with tempfile.TemporaryDirectory(prefix='myharness-native-check-') as folder:
    root = pathlib.Path(folder)
    stub = root / 'token-helper'
    vendor = str(args.llama_source / 'vendor')
    # Only the helper's own file is measured; the HTTP library is compiled separately without coverage.
    subprocess.run(['g++', '-std=c++17', '-O1', '-w', '-c', '-I' + vendor, str(args.llama_source / 'vendor/cpp-httplib/httplib.cpp'),
                    '-o', str(root / 'httplib.o')], check=True)
    subprocess.run(['g++', '-std=c++17', '--coverage', '-O0', '-I' + str(source / 'tests'), '-I' + vendor, str(source / 'main.cpp'),
                    str(root / 'httplib.o'), '-pthread', '-o', str(stub)], check=True, cwd=root)

    home = root / 'home'
    home.mkdir()
    clean = {'HOME': str(home), 'OLLAMA_URL': '', 'MYHARNESS_TOKENIZER_MODELS': '', 'MYHARNESS_WSL_MOUNT_ROOT': ''}

    def run(arguments, env=None):
        return subprocess.run([str(stub), *arguments], env={**os.environ, **clean, **(env or {})}, capture_output=True, timeout=30, text=True)

    # ---- how it is started ------------------------------------------------------------------
    assert run(['--help']).stdout.startswith('token-helper [--origin https://harnessarium.com]')
    for bad in [['--bogus'], ['--origin'], ['--port'], ['--origin', 'harnessarium.com'], ['--origin', 'https://x.test/'], ['--origin', 'https://x.test/path'],
                ['--origin', 'ftp://x.test'], ['--port', 'abc'], ['--port', ''], ['--port', '65536'], ['--port', '123456'], ['--install', '--uninstall'],
                ['--print-install', '--install'], ['--install', '--print-install'], ['--print-install', 'solaris']]:
        result = run(bad)
        assert result.returncode == 1 and result.stderr.strip(), bad
    for name, value in [('OLLAMA_URL', 'not a url'), ('OLLAMA_URL', 'http://u:p@localhost'), ('OLLAMA_URL', 'http://localhost/path'),
                        ('MYHARNESS_TOKENIZER_MODELS', '{'), ('MYHARNESS_TOKENIZER_MODELS', '[]'), ('MYHARNESS_TOKENIZER_MODELS', '{"m":3}'),
                        ('MYHARNESS_TOKENIZER_MODELS', '{"m":"relative.gguf"}')]:
        result = run(['--print-install'], {name: value})
        assert result.returncode == 1 and name in result.stderr, (name, value)

    # ---- start at login: the exact entry for each system, and applying it on this one ---------
    program = str(stub.resolve())
    settings = {'OLLAMA_URL': 'http://localhost:11434/', 'MYHARNESS_TOKENIZER_MODELS': '{"q":"/models/50% $HOME \\\\x.gguf"}'}
    unit = run(['--print-install', 'linux', '--origin', 'http://localhost:5001', '--origin', 'https://harnessarium.com', '--port', '5003'], settings).stdout
    assert unit == f'''[Unit]
Description=MyHarness tokenizer helper

[Service]
ExecStart="{program}" "--origin" "http://localhost:5001" "--origin" "https://harnessarium.com" "--port" "5003"
Environment="MYHARNESS_TOKENIZER_MODELS={{\\"q\\":\\"/models/50%% $$HOME \\\\\\\\x.gguf\\"}}"
Environment="OLLAMA_URL=http://localhost:11434/"
Restart=on-failure

[Install]
WantedBy=default.target
''', unit
    # With no arguments the entry is the bare program, which serves harnessarium.com on the default port.
    assert f'ExecStart="{program}"\nRestart' in run(['--print-install']).stdout
    agent = run(['--print-install', 'macos', '--origin', 'http://localhost:5001'], {'MYHARNESS_WSL_MOUNT_ROOT': '/a&b<c>'}).stdout
    assert f'<array>\n    <string>{program}</string>\n    <string>--origin</string>\n    <string>http://localhost:5001</string>\n  </array>' in agent
    assert '<key>EnvironmentVariables</key>\n  <dict>\n    <key>MYHARNESS_WSL_MOUNT_ROOT</key>\n    <string>/a&amp;b&lt;c&gt;</string>\n  </dict>' in agent
    assert '<key>RunAtLoad</key>\n  <true/>' in agent and 'EnvironmentVariables' not in run(['--print-install', 'macos']).stdout
    spaced = root / 'My Helper'
    spaced.mkdir()
    (spaced / 'token-helper').write_bytes(stub.read_bytes())
    (spaced / 'token-helper').chmod(0o755)
    line = subprocess.run([str(spaced / 'token-helper'), '--print-install', 'windows', '--port', '5003'], env={**os.environ, **clean}, capture_output=True, text=True, cwd=root)
    assert line.stdout == f'"{(spaced / "token-helper").resolve()}" --port 5003\n', line.stdout
    quoted = root / 'a"b'
    quoted.mkdir()
    (quoted / 'token-helper').write_bytes(stub.read_bytes())
    (quoted / 'token-helper').chmod(0o755)
    assert 'double quotes' in subprocess.run([str(quoted / 'token-helper'), '--print-install', 'windows'], env={**os.environ, **clean}, capture_output=True, text=True, cwd=root).stderr
    assert 'cannot carry environment settings' in run(['--print-install', 'windows'], {'OLLAMA_URL': 'http://localhost:11434'}).stderr
    assert 'line breaks' in run(['--print-install'], {'MYHARNESS_WSL_MOUNT_ROOT': '/a\nb'}).stderr
    broken = root / 'a\nb'
    broken.mkdir()
    (broken / 'token-helper').write_bytes(stub.read_bytes())
    (broken / 'token-helper').chmod(0o755)
    assert 'line breaks' in subprocess.run([str(broken / 'token-helper'), '--print-install'], env={**os.environ, **clean}, capture_output=True, text=True, cwd=root).stderr

    # A stand-in systemctl records what the helper asks of it; nothing touches the real system.
    tools = root / 'tools'
    tools.mkdir()
    (tools / 'systemctl').write_text('#!/bin/sh\necho "$@" >> "$SYSTEMCTL_LOG"\nexit "${SYSTEMCTL_STATUS:-0}"\n')
    (tools / 'systemctl').chmod(0o755)
    log = root / 'systemctl.log'
    entry = home / '.config/systemd/user/myharness-token-helper.service'
    scripted = {'PATH': str(tools), 'SYSTEMCTL_LOG': str(log)}
    result = run(['--install', '--origin', 'http://localhost:5001'], {**scripted, 'OLLAMA_URL': 'http://localhost:11434'})
    assert result.returncode == 0 and 'now starts at every login' in result.stdout and 'It serves: http://localhost:5001' in result.stdout and 'running now' in result.stdout, result
    assert 'ExecStart="' + program + '" "--origin" "http://localhost:5001"\nEnvironment="OLLAMA_URL=http://localhost:11434"' in entry.read_text()
    assert log.read_text().splitlines() == ['--user daemon-reload', '--user enable --now myharness-token-helper.service']
    result = run(['--uninstall'], scripted)
    assert result.returncode == 0 and 'no longer starts at login' in result.stdout and not entry.exists()
    assert log.read_text().splitlines()[-1] == '--user disable --now myharness-token-helper.service'
    # A system that cannot enable the entry: the entry is not left behind, and nothing is claimed.
    for unavailable in [{**scripted, 'SYSTEMCTL_STATUS': '1'}, {'PATH': str(root / 'no-tools')}]:
        result = run(['--install'], unavailable)
        assert result.returncode == 1 and 'Could not enable start at login' in result.stderr and not entry.exists(), result
    assert run(['--uninstall'], {'PATH': str(root / 'no-tools')}).returncode == 0

    # ---- serving ------------------------------------------------------------------------------
    ollama = start_ollama()
    models = root / 'models'
    (models / 'd/Users/me').mkdir(parents=True)
    for name in ['good.gguf', 'other.gguf', 'unloadable.gguf', 'quoted name.gguf', 'd/Users/me/drive.gguf']:
        (models / name).write_bytes(b'GGUF fixture')
    (models / 'not-gguf.bin').write_bytes(b'ELF!')
    (models / 'short.gguf').write_bytes(b'GG')
    Ollama.answers = {
        'reported': {'modelfile': f'# comment\nFROM {models / "good.gguf"}\nTEMPLATE x\n'},
        'quoted': {'modelfile': f'from "{models / "quoted name.gguf"}"  \r\nPARAMETER x'},
        'drive': {'modelfile': 'FROM D:\\Users\\me\\drive.gguf'},
        'adapter': {'modelfile': f'FROM {models / "good.gguf"}\nADAPTER /x'},
        'nofrom': {'modelfile': 'TEMPLATE x'}, 'nomodelfile': {}, 'wrongtype': {'modelfile': 3}, 'notobject': [], 'notjson': b'{',
        'gone': {'modelfile': f'FROM {models / "missing.gguf"}'}, 'folder': {'modelfile': f'FROM {models}'},
        'notgguf': {'modelfile': f'FROM {models / "not-gguf.bin"}'}, 'short': {'modelfile': f'FROM {models / "short.gguf"}'},
        'relative': {'modelfile': 'FROM relative.gguf'},
    }
    environment = {**clean, 'OLLAMA_URL': f'http://127.0.0.1:{ollama.server_port}', 'MYHARNESS_WSL_MOUNT_ROOT': str(models),
                   'MYHARNESS_TOKENIZER_MODELS': json.dumps({'mapped': str(models / 'other.gguf'), 'broken': str(models / 'unloadable.gguf')})}
    helper = Helper(stub, ['--origin', ORIGIN, '--origin', 'http://localhost:5001'], environment)
    assert helper.banner == [f'Tokenizer helper on http://127.0.0.1:{helper.port}', f'Allowed websites: {ORIGIN}, http://localhost:5001',
                             'It only reads tokenizer vocabularies. Stop it with Ctrl+C.'], helper.banner
    # Another website, no website and a foreign Host are refused before anything else, with no CORS grant.
    for refused in [{'origin': 'https://evil.test'}, {'origin': None}, {'host': 'evil.test'}, {'host': f'localhost:{helper.port}'}]:
        status, body, headers = helper.request('/v1/info', **refused)
        assert status == 403 and 'not allowed' in body['error'] and 'access-control-allow-origin' not in headers, refused
    status, body, headers = helper.request('/v1/tokenize', method='OPTIONS')
    assert status == 204 and headers['access-control-allow-origin'] == ORIGIN and headers['access-control-allow-private-network'] == 'true'
    for allowed in [ORIGIN, 'http://localhost:5001']:
        status, body, headers = helper.request('/v1/info', origin=allowed)
        assert status == 200 and headers['access-control-allow-origin'] == allowed and headers['cache-control'] == 'no-store'
        assert body == {'value': {'protocol': 2, 'ollamaUrl': f'http://127.0.0.1:{ollama.server_port}', 'models': ['broken', 'mapped'], 'automatic': True}}, body
    # Only the two requests exist: nothing of the former bridge, no pairing.
    for route in ['/v1/pair', '/v1/connect', '/v1/call', '/', '/v1/info/x']:
        status, body, _ = helper.request(route)
        assert status == 404 and body == {'error': 'Tokenizer helper route not found'}, route
    assert helper.request('/v1/info', method='GET')[0] == 404
    for invalid in [b'{', b'[]', b'{"model":"m"}', b'{"content":"x"}', b'{"model":3,"content":"x"}', b'{"model":"m","content":3}']:
        status, body, _ = helper.request('/v1/tokenize', raw=invalid)
        assert status == 400 and 'needs a model' in body['error'], invalid
    status, body, _ = helper.request('/v1/tokenize', raw=b'{"model":"mapped","content":"' + b'x' * (8 * 1024 * 1024 + 128 * 1024) + b'"}')
    assert status == 413 and body == {'error': 'Tokenizer helper request is too large'}, (status, body)

    # Finding the model file: an operator mapping, or what the helper's own Ollama reports.
    status, body, _ = helper.tokenize('mapped', 'normal')
    assert status == 200 and body['value'] == {'identity': 'operator-configured GGUF for mapped', 'tokens': [{'id': 1, 'bytes': [0, 255, 255]}, {'id': 1, 'bytes': [0, 255, 255]}]}, body
    for model, name in [('reported', 'good.gguf'), ('quoted', 'quoted name.gguf'), ('drive', 'drive.gguf'), ('reported', 'good.gguf')]:
        status, body, _ = helper.tokenize(model, 'normal')
        assert status == 200 and body['value']['identity'] == 'Ollama-reported GGUF ' + name, (model, body)
    for model, reason in [('bad id!', 'valid exact Ollama model ID'), ('', 'valid exact Ollama model ID'), ('unknown', 'could not ask Ollama'), ('notjson', 'could not ask Ollama'),
                          ('notobject', 'could not ask Ollama'), ('adapter', 'usable model file'), ('nofrom', 'usable model file'), ('nomodelfile', 'usable model file'),
                          ('wrongtype', 'usable model file'), ('gone', 'missing, unreadable or not a GGUF'), ('folder', 'missing, unreadable or not a GGUF'),
                          ('notgguf', 'missing, unreadable or not a GGUF'), ('short', 'missing, unreadable or not a GGUF'), ('relative', 'missing, unreadable or not a GGUF'),
                          ('broken', 'could not be read as a tokenizer vocabulary')]:
        status, body, _ = helper.tokenize(model, 'normal')
        assert status == 422 and reason in body['error'], (model, body)
        assert str(models) not in body['error'], 'explanations never name a path'
    # A changed file is loaded again; the same file is reused.
    os.utime(models / 'other.gguf', (1, 1))
    assert helper.tokenize('mapped', 'normal')[0] == 200

    # Every tokenizer limit and error is reported as a plain explanation, never a crash.
    status, body, _ = helper.tokenize('mapped', '')
    assert status == 200 and body['value']['tokens'] == []
    assert helper.tokenize('mapped', 'positive')[1]['value']['tokens'][0]['bytes'] == [0, 255, 255]
    assert len(helper.tokenize('mapped', 'long')[1]['value']['tokens'][0]['bytes']) == 100
    for text in ['overflow', 'bad-count', 'extra-count', 'piece-overflow', 'piece-limit', 'bad-piece', 'extra-piece', 'retry-piece', 'output']:
        status, body, _ = helper.tokenize('mapped', text)
        assert status == 422 and "exceed the tokenizer helper's limits" in body['error'], (text, body)
    assert helper.tokenize('mapped', 'normal')[0] == 200
    helper.stop()

    # Ollama elsewhere, over TLS or unreachable: the helper says what to configure and still starts.
    for url, reason in [('http://ollama.example:11434', 'not a plain local address'), ('https://localhost', 'not a plain local address'),
                        ('http://[::1]:9', 'could not ask Ollama'), ('http://localhost', 'could not ask Ollama')]:
        remote = Helper(stub, ['--origin', ORIGIN], {**clean, 'OLLAMA_URL': url})
        status, body, _ = remote.tokenize('any', 'x')
        assert status == 422 and reason in body['error'], (url, body)
        remote.stop()
    # The default website is served when none is named; a busy port is explained.
    default = Helper(stub, [], clean)
    assert default.banner[1] == 'Allowed websites: https://harnessarium.com' and default.request('/v1/info', origin='https://harnessarium.com')[0] == 200
    busy = run(['--port', str(default.port)])
    assert busy.returncode == 1 and 'already in use' in busy.stderr, busy
    default.process.send_signal(signal.SIGINT)
    assert default.process.wait(timeout=10) == 0
    ollama.shutdown()

    subprocess.run(['gcov', '-o', str(root), str(root / 'token-helper-main.gcno')], cwd=root, check=True, stdout=subprocess.DEVNULL)
    coverage = (root / 'main.cpp.gcov').read_text()
    missed = [line for line in coverage.splitlines() if line.lstrip().startswith('#####')]
    assert not missed, 'Uncovered helper lines:\n' + '\n'.join(missed)
    print('Tokenizer helper: 100% executable line coverage on this system; protocol, refusals, model lookup, limits and start at login exercised.')

# The pinned upstream corpora are independent expected token IDs, not generated by this helper.
# Avoid their literal control-token examples: upstream goldens use parse_special=false;
# production inspection deliberately uses parse_special=true.
families = ['qwen2', 'gpt-2', 'llama-spm']
files = {family: args.llama_source / 'models' / ('ggml-vocab-' + family + '.gguf') for family in families}
with tempfile.TemporaryFile() as logs:
    started = time.perf_counter()
    real = Helper(args.helper, ['--origin', ORIGIN], {'OLLAMA_URL': '', 'MYHARNESS_TOKENIZER_MODELS': json.dumps({family: str(file) for family, file in files.items()})}, logs)
    startup_ms = (time.perf_counter() - started) * 1000
    for family in families:
        samples = pathlib.Path(str(files[family]) + '.inp').read_text().split('\n__ggml_vocab_test__\n')
        expected = pathlib.Path(str(files[family]) + '.out').read_text().splitlines()
        if samples[-1] == '' and len(samples) == len(expected) + 1:
            samples.pop()
        assert len(samples) == len(expected)
        checked = 0
        for text, golden in zip(samples, expected):
            if '<|' in text or '<s>' in text or '</s>' in text:
                continue
            status, body, _ = real.tokenize(family, text)
            assert status == 200 and [token['id'] for token in body['value']['tokens']] == [int(x) for x in golden.split()], (family, text)
            assert all(all(0 <= byte <= 255 for byte in token['bytes']) for token in body['value']['tokens'])
            checked += 1
        # Round trip arbitrary bytes via raw token pieces on byte-level BPE.
        if family != 'llama-spm':
            text = 'é\n\t\0😀<|im_start|>user\nBonjour!\n'
            tokens = real.tokenize(family, text)[1]['value']['tokens']
            assert bytes(byte for token in tokens for byte in token['bytes']) == text.encode()
        print(f'{family}: {checked} upstream golden cases passed over HTTP.')
    real.stop()
    logs.seek(0)
    assert b'vocab only - skipping tensors' in logs.read()
    print(f'Real helper: started in {startup_ms:.1f} ms; three vocabularies loaded in turn; model weights skipped.')
