import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve('dist/browser'), port = Number(process.env.MYHARNESS_PORT ?? '5001');
const types = { '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json', '.map': 'application/json', '.txt': 'text/plain' };
const server = createServer(async (request, response) => {
  try {
    if (request.method !== 'GET') { response.writeHead(404); response.end('This server serves static files only.'); return; }
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const file = path.resolve(root, '.' + decodeURIComponent(pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(root + path.sep)) throw new Error('Not found');
    const content = await readFile(file); response.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' }); response.end(content);
  } catch { response.writeHead(404); response.end('Not found'); }
});
server.listen(port, '127.0.0.1', () => console.log(`Browser harness on http://localhost:${server.address().port} (static files only)`));
