import { build } from 'esbuild';
import { mkdir, readFile, writeFile, readdir, cp } from 'node:fs/promises';
import path from 'node:path';

const output = path.resolve('dist/browser'); await mkdir(output, { recursive: true });
await build({ entryPoints: { 'backend-worker': 'typescript/src/browser/worker-entry.ts', 'browser-backend': 'typescript/src/browser/index.ts', 'browser-ui': 'typescript/ui/browser.ts', 'guide-ui': 'typescript/ui/guide-entry.ts', 'managed-worker': 'typescript/ui/managed-worker.ts' }, outdir: output, bundle: true, platform: 'browser', format: 'esm', target: 'es2022', sourcemap: true, metafile: true, inject: ['scripts/buffer-shim.mjs'] }).then(result => writeFile(path.join(output, 'build-manifest.json'), JSON.stringify(result.metafile, null, 2)));
await build({ entryPoints: ['typescript/src/failure.ts'], outfile: path.join(output, 'error-messages.js'), bundle: true, platform: 'browser', format: 'iife', globalName: 'MyHarnessErrors', target: 'es2022', sourcemap: true });
const library = { agents: {}, prompts: {}, skills: {}, workspace: {
  'AGENTS.md': 'This is a learning project. Explain the files you inspect and the effect of each proposed edit. Ask before changing files.',
  'README.md': '# Example project\n\nExplore how the harness reads files, remembers messages and asks before edits.\nTry “Read src/greeting.py” or “Write note.txt: hello”.\n',
  'src/greeting.py': 'def greet(name):\n    return f"Hello, {name}!"\n',
} };
for (const [folder, key] of [['agents', 'agents'], ['prompts', 'prompts']]) for (const file of (await readdir(folder)).filter(file => file.endsWith('.md')).sort()) library[key][file.slice(0, -3)] = await readFile(path.join(folder, file), 'utf8');
for (const folder of (await readdir('skills')).sort()) library.skills[folder] = await readFile(path.join('skills', folder, 'SKILL.md'), 'utf8');
await writeFile(path.join(output, 'library.json'), JSON.stringify(library));
let html = await readFile('web/templates/index.html', 'utf8');
html = html.replace('<head>', '<head>\n<link rel="icon" href="data:,">');
html = html.replaceAll('src="/static/', 'src="./static/');
html = html.replace('src="/error-messages.js"', 'src="./error-messages.js"');
html = html.replace('<script>\nconst messagesEl', '<script type="module">\nimport { mountBrowser } from "./browser-ui.js";\ntry { await mountBrowser(); } catch (error) { document.body.prepend(Object.assign(document.createElement("p"), { textContent: "Browser backend unavailable: " + MyHarnessErrors.failureText(error, error.message) })); throw error; }\nconst messagesEl');
html = html.replace('</style>', '#browser-runtime { padding: 12px; border-bottom: 1px solid #444; font: 13px system-ui; } #browser-runtime button, #browser-runtime input, #browser-runtime select { margin: 4px; } #browser-runtime-status { color: #ffb86c; margin-left: 8px; } .browser-import input { max-width: 160px; }\n</style>');
await writeFile(path.join(output, 'index.html'), html);
await writeFile(path.join(output, 'headless.html'), '<!doctype html><meta charset="utf-8"><title>Headless browser backend</title><script type="module">import { WorkerClient } from "./browser-backend.js"; const url = new URL("backend-worker.js", location.href); url.search = location.search; window.harness = new WorkerClient(new Worker(url, {type:"module"}));</script>');
await cp('web/guide.html', path.join(output, 'guide.html'));
await cp('web/static', path.join(output, 'static'), { recursive: true });
await writeFile(path.join(output, 'README.txt'), 'myharness browser edition\n\nServe this folder through HTTP(S), for example: python3 -m http.server 8000\nOpen http://localhost:8000/guide.html for guided setup, shared-computer mode and encrypted credential controls, or index.html for standalone use. The server serves static files only. The full harness runs in a browser Worker.\n\nSelect a real model provider in the toolbar. Local Ollama is selected by default and needs this page origin allowed in OLLAMA_ORIGINS. Local-folder mode requires browser support and user-granted access. Approved edits write to that folder. Folder copies and sessions are stored in IndexedDB. Bash and web search require an explicitly paired native bridge; without one they are unavailable and are not offered. Git tools also work in local-folder mode. Start a bridge from the source checkout using npm run bridge:ts with a workspace, exact website origin, unused port and explicit local grants. Keep the guide open for managed experiments.\n\nThe public SDK is browser-backend.js. Use WorkerClient with backend-worker.js, or BrowserHarness directly without the UI.\n');
console.log('Static browser distribution built in dist/browser');
