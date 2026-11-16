import { build } from 'esbuild';
import { mkdir, readFile, writeFile, readdir, cp, rm } from 'node:fs/promises';
import path from 'node:path';

const output = path.resolve('dist/browser');
// Start clean so pages retired from the distribution are never shipped from an older build.
await rm(output, { recursive: true, force: true }); await mkdir(output, { recursive: true });
await build({ entryPoints: { 'backend-worker': 'typescript/src/browser/worker-entry.ts', 'browser-backend': 'typescript/src/browser/index.ts', 'browser-ui': 'typescript/ui/browser.ts' }, outdir: output, bundle: true, platform: 'browser', format: 'esm', target: 'es2022', sourcemap: true, metafile: true, inject: ['scripts/buffer-shim.mjs'] }).then(result => writeFile(path.join(output, 'build-manifest.json'), JSON.stringify(result.metafile, null, 2)));
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
const replaceOnce = (text, search, replacement) => {
  if (!text.includes(search)) throw new Error(`Browser build anchor not found in index.html: ${search.slice(0, 60)}`);
  return text.replace(search, replacement);
};
html = replaceOnce(html, '<head>', '<head>\n<link rel="icon" href="data:,">');
if (!html.includes('src="/static/') || !html.includes('href="/static/')) throw new Error('Browser build anchor not found in index.html: /static/ references');
html = html.replaceAll('src="/static/', 'src="./static/').replaceAll('href="/static/', 'href="./static/');
html = replaceOnce(html, 'src="/error-messages.js"', 'src="./error-messages.js"');
html = replaceOnce(html, '<script src="./static/app.js" defer></script>', '<script type="module">\nimport { mountBrowser } from "./browser-ui.js";\nwindow.MYHARNESS_READY = mountBrowser().catch(error => { document.body.prepend(Object.assign(document.createElement("p"), { textContent: "Browser backend unavailable: " + MyHarnessErrors.failureText(error, error.message) })); throw error; });\n</script>\n<script src="./static/app.js" defer></script>');
await writeFile(path.join(output, 'index.html'), html);
await writeFile(path.join(output, 'headless.html'), '<!doctype html><meta charset="utf-8"><title>Headless browser backend</title><script type="module">import { WorkerClient } from "./browser-backend.js"; const url = new URL("backend-worker.js", location.href); url.search = location.search; window.harness = new WorkerClient(new Worker(url, {type:"module"}));</script>');
await cp('web/static', path.join(output, 'static'), { recursive: true });
await writeFile(path.join(output, 'README.txt'), 'myharness browser edition\n\nServe this folder through HTTP(S), for example: python3 -m http.server 8000\nOpen index.html. The server serves static files only. The full harness runs in a browser Worker.\n\nThe page starts with a card to connect a model: paste an API key for Gemini, OpenAI or Anthropic, or use Ollama on this computer. Ollama needs this page origin allowed in OLLAMA_ORIGINS; the card shows the command. API keys stay in Worker memory and are never saved. Local-folder mode requires browser support and user-granted access. Approved edits write to that folder. Folder copies and sessions are stored in IndexedDB. A web page cannot run shell commands or web search, so those tools are reported as unavailable and are not offered; use the Node edition for them. Git tools work in local-folder mode.\n\nThe public SDK is browser-backend.js. Use WorkerClient with backend-worker.js, or BrowserHarness directly without the UI.\n');
console.log('Static browser distribution built in dist/browser');
